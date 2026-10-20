import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { CatalogEntrySchema, type CatalogEntry } from '../../../src/features/catalog/catalog.models.js'
import { normalizeCatalogText } from '../../../src/features/catalog/catalog.search.js'
import { CatalogValidationError, isAvailableByRights } from '../../../src/features/catalog/catalog.validation.js'
import type { ServerConfig } from '../config.js'
import { CatalogConflictError, type CatalogApiRepository } from './repository.js'

const publicVisibilitySql = `
  entry.publication_status = 'published'
  AND (
    (
      entry.kind <> 'collection'
      AND EXISTS (
        SELECT 1
        FROM catalog_distribution_rights AS rights
        JOIN catalog_right_platforms AS platform
          ON platform.entry_id = rights.entry_id AND platform.right_id = rights.right_id
        JOIN catalog_right_territories AS territory
          ON territory.entry_id = rights.entry_id AND territory.right_id = rights.right_id
        WHERE rights.entry_id = entry.id
          AND rights.streaming_allowed = true
          AND platform.platform = 'web'
          AND territory.territory_code = 'WORLDWIDE'
          AND rights.starts_at <= now()
          AND (rights.ends_at IS NULL OR rights.ends_at > now())
      )
    )
    OR (
      entry.kind = 'collection'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(entry.payload->'itemIds') = 'array' THEN entry.payload->'itemIds'
            ELSE '[]'::jsonb
          END
        ) AS collection_member(item_id)
        JOIN catalog_entries AS member ON member.id = collection_member.item_id
        WHERE member.kind <> 'collection'
          AND member.publication_status = 'published'
          AND EXISTS (
            SELECT 1
            FROM catalog_distribution_rights AS rights
            JOIN catalog_right_platforms AS platform
              ON platform.entry_id = rights.entry_id AND platform.right_id = rights.right_id
            JOIN catalog_right_territories AS territory
              ON territory.entry_id = rights.entry_id AND territory.right_id = rights.right_id
            WHERE rights.entry_id = member.id
              AND rights.streaming_allowed = true
              AND platform.platform = 'web'
              AND territory.territory_code = 'WORLDWIDE'
              AND rights.starts_at <= now()
              AND (rights.ends_at IS NULL OR rights.ends_at > now())
          )
      )
    )
  )
`

export class PostgresCatalogRepository implements CatalogApiRepository {
  readonly pool: Pool

  constructor(config: Pick<ServerConfig, 'databaseUrl' | 'databaseSslMode'>, pool?: Pool) {
    this.pool = pool ?? new Pool({
        connectionString: config.databaseUrl,
        ssl: config.databaseSslMode === 'disable' ? false : { rejectUnauthorized: config.databaseSslMode === 'verify-full' },
        max: 12,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      })
  }

  async listPublic(): Promise<CatalogEntry[]> {
    const result = await this.pool.query<{ payload: unknown }>(`
      SELECT entry.payload
      FROM catalog_entries AS entry
      WHERE ${publicVisibilitySql}
      ORDER BY entry.normalized_title ASC, entry.id ASC
    `)
    return sanitizePublicCollections(result.rows.map((row) => parseStoredEntry(row.payload)))
  }

  async getPublic(id: string): Promise<CatalogEntry | null> {
    const result = await this.pool.query<{ payload: unknown }>(`
      SELECT entry.payload
      FROM catalog_entries AS entry
      WHERE entry.id = $1
        AND (${publicVisibilitySql})
      LIMIT 1
    `, [id])
    if (!result.rows[0]) return null
    const entry = parseStoredEntry(result.rows[0].payload)
    if (entry.kind !== 'collection') return entry
    return (await this.listPublic()).find((publicEntry) => publicEntry.id === id) ?? null
  }

  async listAdmin(): Promise<CatalogEntry[]> {
    const result = await this.pool.query<{ payload: unknown }>('SELECT payload FROM catalog_entries ORDER BY updated_at DESC, id ASC')
    return result.rows.map((row) => parseStoredEntry(row.payload))
  }

  async getAdmin(id: string): Promise<CatalogEntry | null> {
    const result = await this.pool.query<{ payload: unknown }>('SELECT payload FROM catalog_entries WHERE id = $1', [id])
    return result.rows[0] ? parseStoredEntry(result.rows[0].payload) : null
  }

  async create(value: CatalogEntry): Promise<CatalogEntry> {
    const entry = parseEntry(value)
    assertPublishable(entry)
    return this.transaction(async (client) => {
      await this.insertEntry(client, entry)
      await this.syncRelationships(client, entry)
      return entry
    })
  }

  async update(id: string, value: CatalogEntry): Promise<CatalogEntry | null> {
    const entry = parseEntry(value)
    if (entry.id !== id) throw new CatalogValidationError('Record ID cannot change during an update.')
    assertPublishable(entry)
    return this.transaction(async (client) => {
      const result = await client.query('UPDATE catalog_entries SET kind = $2, publication_status = $3, title = $4, normalized_title = $5, synopsis = $6, release_year = $7, release_date = $8, duration_minutes = $9, imdb_id = $10, tmdb_id = $11, content_fingerprint = $12, payload = $13::jsonb, updated_at = now() WHERE id = $1 RETURNING id', valuesFor(entry))
      if (result.rowCount === 0) return null
      await this.syncRelationships(client, entry)
      return entry
    })
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM catalog_entries WHERE id = $1', [id])
    return result.rowCount === 1
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async checkReady(): Promise<void> {
    await this.pool.query('SELECT 1')
    const result = await this.pool.query<{ missing_table: string }>(`
      SELECT required.name AS missing_table
      FROM unnest(ARRAY[
        'schema_migrations',
        'catalog_entries',
        'catalog_genres',
        'catalog_entry_genres',
        'catalog_actors',
        'catalog_characters',
        'catalog_character_actors',
        'catalog_entry_cast',
        'catalog_seasons',
        'catalog_episodes',
        'catalog_episode_cast',
        'catalog_episode_characters',
        'catalog_distribution_rights',
        'catalog_right_territories',
        'catalog_right_platforms',
        'monetization_plans',
        'payment_transactions',
        'subscriptions',
        'rental_entitlements',
        'payment_webhook_events',
        'payment_reconciliation'
      ]) AS required(name)
      WHERE to_regclass(required.name) IS NULL
    `)
    if (result.rows.length > 0) {
      throw new Error(`Catalog migrations are incomplete; missing tables: ${result.rows.map((row) => row.missing_table).join(', ')}. Run npm run db:migrate before starting the API.`)
    }
  }

  private async insertEntry(client: PoolClient, entry: CatalogEntry): Promise<void> {
    try {
      await client.query(`
        INSERT INTO catalog_entries
          (id, kind, publication_status, title, normalized_title, synopsis, release_year, release_date, duration_minutes, imdb_id, tmdb_id, content_fingerprint, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      `, valuesFor(entry))
    } catch (error) {
      if (isUniqueViolation(error)) throw new CatalogConflictError('A record with this stable ID, external ID, or exact content identity already exists.')
      throw error
    }
  }

  private async syncRelationships(client: PoolClient, entry: CatalogEntry): Promise<void> {
    await client.query('DELETE FROM catalog_entry_genres WHERE entry_id = $1', [entry.id])
    await client.query('DELETE FROM catalog_distribution_rights WHERE entry_id = $1', [entry.id])
    await client.query('DELETE FROM catalog_seasons WHERE entry_id = $1', [entry.id])
    await client.query('DELETE FROM catalog_entry_cast WHERE entry_id = $1', [entry.id])
    await client.query('DELETE FROM catalog_characters WHERE entry_id = $1', [entry.id])
    await client.query('DELETE FROM catalog_actors WHERE entry_id = $1', [entry.id])

    for (const genre of entry.genres) {
      await client.query(`INSERT INTO catalog_genres (id, slug, name, description) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, description = EXCLUDED.description`, [genre.id, genre.slug, genre.name, genre.description ?? null])
      await client.query('INSERT INTO catalog_entry_genres (entry_id, genre_id) VALUES ($1,$2)', [entry.id, genre.id])
    }

    if (entry.kind !== 'collection') {
      const actors = collectActors(entry)
      const characters = collectCharacters(entry)
      for (const actor of actors.values()) {
        await client.query(`INSERT INTO catalog_actors (entry_id, actor_id, name, biography, image_url) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (entry_id, actor_id) DO UPDATE SET name = EXCLUDED.name, biography = EXCLUDED.biography, image_url = EXCLUDED.image_url`, [entry.id, actor.id, actor.name, actor.biography ?? null, actor.imageUrl ?? null])
      }
      for (const character of characters.values()) {
        await client.query('INSERT INTO catalog_characters (entry_id, character_id, name, description) VALUES ($1,$2,$3,$4)', [entry.id, character.id, character.name, character.description ?? null])
        for (const actorId of character.actorIds) {
          await client.query('INSERT INTO catalog_character_actors (entry_id, character_id, actor_id) VALUES ($1,$2,$3)', [entry.id, character.id, actorId])
        }
      }
      for (const actor of entry.actors) await client.query('INSERT INTO catalog_entry_cast (entry_id, actor_id) VALUES ($1,$2)', [entry.id, actor.id])
      if (entry.kind === 'series') await this.syncSeasons(client, entry)
    }

    for (const right of entry.kind === 'collection' ? [] : entry.distributionRights) {
      await client.query('INSERT INTO catalog_distribution_rights (entry_id, right_id, starts_at, ends_at, streaming_allowed, download_allowed) VALUES ($1,$2,$3,$4,$5,$6)', [entry.id, right.id, right.startsAt, right.endsAt ?? null, right.streamingAllowed, right.downloadAllowed])
      for (const territory of right.territoryCodes) await client.query('INSERT INTO catalog_right_territories (entry_id, right_id, territory_code) VALUES ($1,$2,$3)', [entry.id, right.id, territory])
      for (const platform of right.platforms) await client.query('INSERT INTO catalog_right_platforms (entry_id, right_id, platform) VALUES ($1,$2,$3)', [entry.id, right.id, platform])
    }
  }

  private async syncSeasons(client: PoolClient, entry: Extract<CatalogEntry, { kind: 'series' }>): Promise<void> {
    for (const season of entry.seasons) {
      await client.query('INSERT INTO catalog_seasons (entry_id, season_id, season_number, title) VALUES ($1,$2,$3,$4)', [entry.id, season.id, season.seasonNumber, season.title ?? null])
      for (const episode of season.episodes) {
        await client.query('INSERT INTO catalog_episodes (entry_id, season_id, episode_id, episode_number, title, synopsis, duration_minutes, release_year, release_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [entry.id, season.id, episode.id, episode.episodeNumber, episode.title, episode.synopsis, episode.durationMinutes, episode.releaseYear ?? null, episode.releaseDate ?? null])
        for (const actor of episode.actors) await client.query('INSERT INTO catalog_episode_cast (entry_id, episode_id, actor_id) VALUES ($1,$2,$3)', [entry.id, episode.id, actor.id])
        for (const character of episode.characters) await client.query('INSERT INTO catalog_episode_characters (entry_id, episode_id, character_id) VALUES ($1,$2,$3)', [entry.id, episode.id, character.id])
      }
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await work(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      if (isUniqueViolation(error)) throw new CatalogConflictError('A record with this stable ID, external ID, or exact content identity already exists.')
      throw error
    } finally {
      client.release()
    }
  }
}

function parseEntry(value: unknown): CatalogEntry {
  const result = CatalogEntrySchema.safeParse(value)
  if (!result.success) throw new CatalogValidationError(result.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; '), result.error.issues)
  return result.data
}

function assertPublishable(entry: CatalogEntry): void {
  if (entry.kind !== 'collection' && entry.publicationStatus === 'published' && !isAvailableByRights(entry)) {
    throw new CatalogValidationError('Published records require a currently active web streaming right.')
  }
}

function parseStoredEntry(value: unknown): CatalogEntry {
  return parseEntry(typeof value === 'string' ? JSON.parse(value) : value)
}

function sanitizePublicCollections(entries: CatalogEntry[]): CatalogEntry[] {
  const publicTitleIds = new Set(entries.filter((entry) => entry.kind !== 'collection').map((entry) => entry.id))
  return entries.map((entry) => entry.kind === 'collection'
    ? { ...entry, itemIds: entry.itemIds.filter((id) => publicTitleIds.has(id)) }
    : entry)
}

function valuesFor(entry: CatalogEntry): unknown[] {
  const externalIds = 'externalIds' in entry ? entry.externalIds : undefined
  const synopsis = normalizeCatalogText(entry.synopsis)
  const fingerprint = createHash('sha256').update(`${entry.kind}\0${normalizeCatalogText(entry.title)}\0${entry.releaseYear ?? ''}\0${synopsis}\0${entry.kind === 'film' ? entry.durationMinutes : ''}`).digest('hex')
  return [entry.id, entry.kind, entry.publicationStatus, entry.title, normalizeCatalogText(entry.title), entry.synopsis, entry.releaseYear ?? null, entry.releaseDate ?? null, entry.kind === 'film' ? entry.durationMinutes : null, externalIds?.imdb ?? null, externalIds?.tmdb ?? null, fingerprint, JSON.stringify(entry)]
}

function collectActors(entry: Extract<CatalogEntry, { kind: 'film' | 'series' }>) {
  const actors = new Map(entry.actors.map((actor) => [actor.id, actor]))
  if (entry.kind === 'series') {
    for (const episode of entry.seasons.flatMap((season) => season.episodes)) {
      for (const actor of episode.actors) {
        const existing = actors.get(actor.id)
        if (existing && existing.name !== actor.name) throw new CatalogValidationError(`Actor ID ${actor.id} has conflicting names within the record.`)
        actors.set(actor.id, actor)
      }
    }
  }
  return actors
}

function collectCharacters(entry: Extract<CatalogEntry, { kind: 'film' | 'series' }>) {
  const characters = new Map(entry.characters.map((character) => [character.id, character]))
  if (entry.kind === 'series') {
    for (const episode of entry.seasons.flatMap((season) => season.episodes)) {
      for (const character of episode.characters) {
        const existing = characters.get(character.id)
        if (existing && (existing.name !== character.name || existing.actorIds.join('|') !== character.actorIds.join('|'))) {
          throw new CatalogValidationError(`Character ID ${character.id} has conflicting metadata within the record.`)
        }
        characters.set(character.id, character)
      }
    }
  }
  return characters
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}