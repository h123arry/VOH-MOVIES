import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type { CatalogEntry, Movie } from '../../../src/features/catalog/catalog.models.js'
import { PostgresCatalogRepository } from './postgres.repository.js'

function draft(): Movie {
  return {
    id: 'parameterized-film',
    kind: 'film',
    publicationStatus: 'draft',
    title: "A title'; DROP TABLE catalog_entries; --",
    synopsis: 'A parameterization test record.',
    durationMinutes: 90,
    genres: [],
    actors: [],
    characters: [],
    distributionRights: [],
  }
}

function fakePool(onQuery?: (text: string, values?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values })
    const result = onQuery?.(text, values)
    return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? 0 } as never
  }
  const client = {
    query,
    release() {},
  }
  const pool = {
    query,
    connect: async () => client,
    end: async () => {},
  } as unknown as Pool
  return { pool, calls, client: client as unknown as PoolClient }
}

describe('PostgresCatalogRepository', () => {
  it('applies publication, active web-streaming, worldwide-territory, and collection-member filters to public queries', async () => {
    const { pool, calls } = fakePool()
    const repository = new PostgresCatalogRepository({ databaseUrl: 'postgresql://unused', databaseSslMode: 'disable' }, pool)
    await repository.listPublic()
    await repository.getPublic('public-id')

    expect(calls[0].text).toContain("entry.publication_status = 'published'")
    expect(calls[0].text).toContain("platform.platform = 'web'")
    expect(calls[0].text).toContain("territory.territory_code = 'WORLDWIDE'")
    expect(calls[0].text).toContain('rights.starts_at <= now()')
    expect(calls[0].text).toContain('rights.ends_at > now()')
    expect(calls[0].text).toContain("entry.kind = 'collection'")
    expect(calls[0].text).toContain("member.publication_status = 'published'")
    expect(calls[1].values).toEqual(['public-id'])
    expect(calls[1].text).toContain('entry.id = $1')
  })

  it('removes unavailable title IDs from public collection payloads and collection retrievals', async () => {
    const publishedFilm: Movie = {
      ...draft(),
      id: 'public-film',
      publicationStatus: 'published',
      distributionRights: [{
        id: 'worldwide-web',
        territoryCodes: ['WORLDWIDE'],
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        platforms: ['web'],
        streamingAllowed: true,
        downloadAllowed: false,
      }],
    }
    const collection: CatalogEntry = {
      id: 'collection-1',
      kind: 'collection',
      publicationStatus: 'published',
      title: 'Public collection',
      synopsis: 'A collection with one public and one private reference.',
      genres: [],
      itemIds: ['public-film', 'draft-film'],
    }
    const { pool } = fakePool((text) => {
      if (!text.includes('SELECT entry.payload')) return {}
      if (text.includes('entry.id = $1')) return { rows: [{ payload: collection }] }
      return { rows: [{ payload: collection }, { payload: publishedFilm }] }
    })
    const repository = new PostgresCatalogRepository({ databaseUrl: 'postgresql://unused', databaseSslMode: 'disable' }, pool)

    const listed = await repository.listPublic()
    expect(listed.find((entry) => entry.kind === 'collection')).toMatchObject({ itemIds: ['public-film'] })
    const fetched = await repository.getPublic(collection.id)
    expect(fetched).toMatchObject({ kind: 'collection', itemIds: ['public-film'] })
  })

  it('creates, updates, and deletes using parameter values and commits writes only after all relational rows succeed', async () => {
    const { pool, calls } = fakePool((text) => ({ rowCount: text.startsWith('UPDATE catalog_entries') || text.startsWith('DELETE FROM catalog_entries') ? 1 : 0 }))
    const repository = new PostgresCatalogRepository({ databaseUrl: 'postgresql://unused', databaseSslMode: 'disable' }, pool)
    const entry = draft()

    expect(await repository.create(entry)).toEqual(entry)
    expect(await repository.update(entry.id, { ...entry, title: 'Updated safely' })).toMatchObject({ title: 'Updated safely' })
    expect(await repository.delete(entry.id)).toBe(true)

    const insert = calls.find((call) => call.text.includes('INSERT INTO catalog_entries'))
    const update = calls.find((call) => call.text.startsWith('UPDATE catalog_entries'))
    const deletion = calls.find((call) => call.text.startsWith('DELETE FROM catalog_entries'))
    expect(insert?.text).toContain('$1')
    expect(insert?.values?.[3]).toBe(entry.title)
    expect(insert?.text).not.toContain(entry.title)
    expect(update?.values?.[0]).toBe(entry.id)
    expect(update?.values?.[3]).toBe('Updated safely')
    expect(deletion?.values).toEqual([entry.id])
    expect(calls.filter((call) => call.text === 'COMMIT')).toHaveLength(2)
  })

  it('rolls back a failed create and propagates the database error', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('INSERT INTO catalog_entries')) throw new Error('database write failed')
      return {}
    })
    const repository = new PostgresCatalogRepository({ databaseUrl: 'postgresql://unused', databaseSslMode: 'disable' }, pool)
    await expect(repository.create(draft())).rejects.toThrow('database write failed')
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(true)
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false)
  })

  it('refuses API startup when required migration tables are missing', async () => {
    const { pool } = fakePool((text) => text.includes('unnest(ARRAY[')
      ? { rows: [{ missing_table: 'catalog_right_platforms' }] }
      : {})
    const repository = new PostgresCatalogRepository({ databaseUrl: 'postgresql://unused', databaseSslMode: 'disable' }, pool)
    await expect(repository.checkReady()).rejects.toThrow(/missing tables: catalog_right_platforms/)
  })
})
