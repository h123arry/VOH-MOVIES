import {
  ActorSchema,
  CatalogCreateResponseSchema,
  type CatalogCreateResult,
  CatalogEntrySchema,
  CharacterSchema,
  EpisodeSchema,
  SeasonSchema,
  type Actor,
  type CatalogDeleteResult,
  type CatalogEntry,
  type CatalogGetResult,
  type CatalogLoadResult,
  type CatalogMutationResult,
  type Character,
  type Episode,
  type Season,
  type Series,
} from './catalog.models'
import { CatalogRepositoryError, createCatalogRepository, type CatalogRepository } from './catalog.repository'
import { CatalogValidationError, findCatalogDuplicates, parseCatalogEntry, parseCatalogList } from './catalog.validation'

export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  async list(signal?: AbortSignal): Promise<CatalogLoadResult> {
    try {
      return { status: 'ready', items: parseCatalogList(await this.repository.list(signal)), storage: this.repository.mode }
    } catch (error) {
      if (error instanceof CatalogRepositoryError && error.code === 'not-configured') {
        return { status: 'not-configured', items: [] }
      }
      return { status: 'error', items: [], message: getErrorMessage(error) }
    }
  }

  async listAdmin(signal?: AbortSignal): Promise<CatalogLoadResult> {
    try {
      return { status: 'ready', items: parseCatalogList(await this.repository.listAdmin(signal)), storage: this.repository.mode }
    } catch (error) {
      if (error instanceof CatalogRepositoryError && error.code === 'not-configured') return { status: 'not-configured', items: [] }
      return { status: 'error', items: [], message: getErrorMessage(error) }
    }
  }

  async get(id: string, signal?: AbortSignal): Promise<CatalogGetResult> {
    return this.getFrom(id, signal, false)
  }

  async getAdmin(id: string, signal?: AbortSignal): Promise<CatalogGetResult> {
    return this.getFrom(id, signal, true)
  }

  private async getFrom(id: string, signal: AbortSignal | undefined, admin: boolean): Promise<CatalogGetResult> {
    try {
      const result = CatalogCreateResponseSchema.safeParse(await (admin ? this.repository.getAdmin(id, signal) : this.repository.get(id, signal)))
      if (!result.success) throw new CatalogValidationError('The catalogue returned an invalid record.')
      return { status: 'ready', item: result.data.item, storage: this.repository.mode }
    } catch (error) {
      if (error instanceof CatalogRepositoryError && error.code === 'not-found') return { status: 'not-found', message: error.message }
      if (error instanceof CatalogRepositoryError && error.code === 'not-configured') return { status: 'not-configured', message: error.message }
      return { status: 'error', message: getErrorMessage(error) }
    }
  }

  async create(value: unknown): Promise<CatalogCreateResult> {
    let entry: CatalogEntry
    try {
      entry = parseCatalogEntry(value)
    } catch (error) {
      return { status: 'error', message: getErrorMessage(error) }
    }

    const existing = await this.listAdmin()
    if (existing.status !== 'ready') return stateError(existing)
    if (findCatalogDuplicates([...existing.items, entry]).length > 0) {
      return { status: 'duplicate', message: `A ${entry.kind} with this title and release year already exists.` }
    }

    try {
      const created = await this.readMutationResponse(this.repository.create(entry))
      if (created.id !== entry.id || created.kind !== entry.kind) throw new CatalogValidationError('Create response changed the record identity.')
      return { status: 'created', item: created }
    } catch (error) {
      return mutationError(error)
    }
  }

  async update(id: string, value: unknown): Promise<CatalogMutationResult> {
    let entry: CatalogEntry
    try {
      entry = parseCatalogEntry(value)
    } catch (error) {
      return mutationError(error)
    }
    if (entry.id !== id) return { status: 'error', message: 'The record ID cannot be changed.' }

    const existing = await this.listAdmin()
    if (existing.status !== 'ready') return stateError(existing)
    if (!existing.items.some((item) => item.id === id)) return { status: 'not-found', message: 'The catalogue record no longer exists.' }
    if (findCatalogDuplicates([...existing.items.filter((item) => item.id !== id), entry]).length > 0) {
      return { status: 'duplicate', message: 'Another catalogue record has the same stable identity or content.' }
    }

    try {
      const saved = await this.readMutationResponse(this.repository.update(id, entry))
      if (saved.id !== id || saved.kind !== entry.kind) throw new CatalogValidationError('Update response changed the record identity.')
      return { status: 'saved', item: saved }
    } catch (error) {
      return mutationError(error)
    }
  }

  async delete(id: string): Promise<CatalogDeleteResult> {
    try {
      await this.repository.delete(id)
      return { status: 'deleted' }
    } catch (error) {
      if (error instanceof CatalogRepositoryError && error.code === 'not-found') return { status: 'not-found', message: error.message }
      if (error instanceof CatalogRepositoryError && error.code === 'not-configured') return { status: 'not-configured', message: error.message }
      return { status: 'error', message: getErrorMessage(error) }
    }
  }

  async saveActor(entryId: string, value: unknown): Promise<CatalogMutationResult> {
    const parsed = ActorSchema.safeParse(value)
    if (!parsed.success) return mutationError(new CatalogValidationError('Actor validation failed.', parsed.error.issues))
    return this.updateNested(entryId, (entry) => {
      if (entry.kind === 'collection') throw new Error('Actors can only be attached to a movie or series.')
      return { ...entry, actors: replaceById(entry.actors, parsed.data) }
    })
  }

  async deleteActor(entryId: string, actorId: string): Promise<CatalogMutationResult> {
    return this.updateNested(entryId, (entry) => {
      if (entry.kind === 'collection') throw new Error('Actors can only be attached to a movie or series.')
      if (!entry.actors.some((actor) => actor.id === actorId)) throw new Error('Actor was not found.')
      return { ...entry, actors: entry.actors.filter((actor) => actor.id !== actorId) }
    })
  }

  async saveCharacter(entryId: string, value: unknown): Promise<CatalogMutationResult> {
    const parsed = CharacterSchema.safeParse(value)
    if (!parsed.success) return mutationError(new CatalogValidationError('Character validation failed.', parsed.error.issues))
    return this.updateNested(entryId, (entry) => {
      if (entry.kind === 'collection') throw new Error('Characters can only be attached to a movie or series.')
      return { ...entry, characters: replaceById(entry.characters, parsed.data) }
    })
  }

  async deleteCharacter(entryId: string, characterId: string): Promise<CatalogMutationResult> {
    return this.updateNested(entryId, (entry) => {
      if (entry.kind === 'collection') throw new Error('Characters can only be attached to a movie or series.')
      if (!entry.characters.some((character) => character.id === characterId)) throw new Error('Character was not found.')
      return { ...entry, characters: entry.characters.filter((character) => character.id !== characterId) }
    })
  }

  async saveSeason(seriesId: string, value: unknown): Promise<CatalogMutationResult> {
    const parsed = SeasonSchema.safeParse(value)
    if (!parsed.success) return mutationError(new CatalogValidationError('Season validation failed.', parsed.error.issues))
    return this.updateNested(seriesId, (entry) => {
      if (entry.kind !== 'series') throw new Error('Seasons can only be attached to a series.')
      return { ...entry, seasons: replaceById(entry.seasons, parsed.data) }
    })
  }

  async deleteSeason(seriesId: string, seasonId: string): Promise<CatalogMutationResult> {
    return this.updateNested(seriesId, (entry) => {
      if (entry.kind !== 'series') throw new Error('Seasons can only be attached to a series.')
      if (!entry.seasons.some((season) => season.id === seasonId)) throw new Error('Season was not found.')
      return { ...entry, seasons: entry.seasons.filter((season) => season.id !== seasonId) }
    })
  }

  async saveEpisode(seriesId: string, seasonId: string, value: unknown): Promise<CatalogMutationResult> {
    const parsed = EpisodeSchema.safeParse(value)
    if (!parsed.success) return mutationError(new CatalogValidationError('Episode validation failed.', parsed.error.issues))
    return this.updateNested(seriesId, (entry) => {
      if (entry.kind !== 'series') throw new Error('Episodes can only be attached to a series.')
      const season = entry.seasons.find((record) => record.id === seasonId)
      if (!season) throw new Error('Season was not found.')
      return { ...entry, seasons: entry.seasons.map((record) => record.id === seasonId ? { ...record, episodes: replaceById(record.episodes, parsed.data) } : record) }
    })
  }

  async deleteEpisode(seriesId: string, seasonId: string, episodeId: string): Promise<CatalogMutationResult> {
    return this.updateNested(seriesId, (entry) => {
      if (entry.kind !== 'series') throw new Error('Episodes can only be attached to a series.')
      const season = entry.seasons.find((record) => record.id === seasonId)
      if (!season) throw new Error('Season was not found.')
      if (!season.episodes.some((record) => record.id === episodeId)) throw new Error('Episode was not found.')
      return { ...entry, seasons: entry.seasons.map((record) => record.id === seasonId ? { ...record, episodes: record.episodes.filter((episode) => episode.id !== episodeId) } : record) }
    })
  }

  private async updateNested(entryId: string, transform: (entry: CatalogEntry) => unknown): Promise<CatalogMutationResult> {
    const found = await this.getAdmin(entryId)
    if (found.status !== 'ready') return stateError(found)
    try {
      const updated = CatalogEntrySchema.parse(transform(found.item))
      return this.update(entryId, updated)
    } catch (error) {
      return mutationError(error)
    }
  }

  private async readMutationResponse(responsePromise: Promise<unknown>): Promise<CatalogEntry> {
    const response = CatalogCreateResponseSchema.safeParse(await responsePromise)
    if (!response.success) throw new CatalogValidationError('The catalogue service returned an invalid record.', response.error.issues)
    return response.data.item
  }
}

function replaceById<T extends { id: string }>(records: T[], value: T): T[] {
  const index = records.findIndex((record) => record.id === value.id)
  if (index < 0) return [...records, value]
  return records.map((record) => record.id === value.id ? value : record)
}

function stateError(result: CatalogLoadResult | CatalogGetResult): CatalogMutationResult {
  if (result.status === 'not-configured') return { status: 'not-configured', message: 'Catalogue storage is not configured.' }
  if (result.status === 'not-found') return { status: 'not-found', message: result.message }
  if (result.status === 'error') return { status: 'error', message: result.message }
  return { status: 'error', message: 'Catalogue operation could not be completed.' }
}

function mutationError(error: unknown): CatalogMutationResult {
  if (error instanceof CatalogRepositoryError && error.code === 'conflict') return { status: 'duplicate', message: error.message }
  if (error instanceof CatalogRepositoryError && error.code === 'not-found') return { status: 'not-found', message: error.message }
  return { status: 'error', message: getErrorMessage(error) }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected catalogue error occurred.'
}

export const catalogService = new CatalogService(createCatalogRepository())