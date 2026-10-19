import { describe, expect, it, vi } from 'vitest'
import type { Movie } from './catalog.models'
import { CatalogEntrySchema, MovieSchema } from './catalog.models'
import { CatalogService } from './catalog.service'
import type { CatalogRepository } from './catalog.repository'
import { LocalCatalogRepository } from './catalog.repository'
import { findCatalogDuplicates, parseCatalogList } from './catalog.validation'

const film: Movie = {
  id: 'film-1',
  kind: 'film',
  publicationStatus: 'draft',
  title: 'Example test title',
  synopsis: 'A schema test record, not production catalogue data.',
  releaseYear: 2024,
  durationMinutes: 100,
  genres: [],
  actors: [],
  characters: [],
  distributionRights: [],
}

describe('catalogue validation', () => {
  it('accepts a valid movie record', () => {
    expect(MovieSchema.parse(film)).toEqual(film)
  })

  it('rejects a character that references an unknown actor', () => {
    const invalid = {
      ...film,
      characters: [{ id: 'character-1', name: 'Role', actorIds: ['missing-actor'] }],
    }

    expect(MovieSchema.safeParse(invalid).success).toBe(false)
  })

  it('detects duplicate IDs and normalized title/year pairs', () => {
    expect(findCatalogDuplicates([film, { ...film, id: 'film-2' }])).toEqual([film.title])
    expect(() => parseCatalogList({ items: [film, { ...film, id: 'film-2' }] })).toThrow(/Duplicate catalogue records/)
  })

  it('does not mark different years or catalog kinds as duplicates', () => {
    const releasedFilm = { ...film, releaseYear: 2024 }
    const earlierFilm = { ...film, id: 'film-2', releaseYear: 2023 }
    const series = { ...film, id: 'series-1', kind: 'series' as const, seasons: [] }

    expect(findCatalogDuplicates([releasedFilm, earlierFilm, series])).toEqual([])
  })

  it('does not collapse distinct movies that share a normalized title and year', () => {
    const differentFilm = { ...film, id: 'film-2', title: 'Example   Test TITLE', synopsis: 'A different record with a different story.' }
    expect(findCatalogDuplicates([film, differentFilm])).toEqual([])
  })

  it('detects reliable external identifiers even when titles and synopses differ', () => {
    const imported = { ...film, externalIds: { imdb: 'tt1234567' } }
    const duplicateImport = { ...film, id: 'film-2', title: 'Another title', synopsis: 'Different synopsis.', externalIds: { imdb: 'tt1234567' } }
    expect(findCatalogDuplicates([imported, duplicateImport])).toEqual([duplicateImport.title])
  })

  it('requires web-streaming rights before a movie can be published', () => {
    const publishedWithoutRights = { ...film, publicationStatus: 'published' as const, distributionRights: [] }
    expect(CatalogEntrySchema.safeParse(publishedWithoutRights).success).toBe(false)
  })
})

describe('CatalogService.create', () => {
  it('returns a duplicate result without issuing a create request', async () => {
    const create = vi.fn()
    const repository: CatalogRepository = {
      mode: 'device',
      list: vi.fn().mockResolvedValue({ items: [film] }),
      listAdmin: vi.fn().mockResolvedValue({ items: [film] }),
      get: vi.fn(),
      getAdmin: vi.fn(),
      create,
      update: vi.fn(),
      delete: vi.fn(),
    }

    const result = await new CatalogService(repository).create({ ...film, id: 'film-2' })

    expect(result.status).toBe('duplicate')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('local catalog repository and nested service CRUD', () => {
  it('creates, reads, updates, and deletes records without relying on display titles', async () => {
    const records = new Map<string, string>()
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
      clear: () => records.clear(),
      key: (index: number) => [...records.keys()][index] ?? null,
      get length() { return records.size },
    } as Storage
    const service = new CatalogService(new LocalCatalogRepository(() => storage, 'catalog-test'))

    expect((await service.create(film)).status).toBe('created')
    expect((await service.get(film.id)).status).toBe('ready')
    expect((await service.update(film.id, { ...film, title: 'Updated test title' })).status).toBe('saved')
    expect(await service.delete(film.id)).toEqual({ status: 'deleted' })
    expect((await service.get(film.id)).status).toBe('not-found')
  })

  it('validates nested seasons, episodes, actors, and characters on every write', async () => {
    const records = new Map<string, string>()
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
      clear: () => records.clear(),
      key: (index: number) => [...records.keys()][index] ?? null,
      get length() { return records.size },
    } as Storage
    const service = new CatalogService(new LocalCatalogRepository(() => storage, 'nested-test'))
    const series = { ...film, id: 'series-1', kind: 'series' as const, seasons: [] }
    expect((await service.create(series)).status).toBe('created')
    expect((await service.saveSeason(series.id, { id: 'season-1', seasonNumber: 1, episodes: [] })).status).toBe('saved')
    expect((await service.saveEpisode(series.id, 'season-1', {
      id: 'episode-1', episodeNumber: 1, title: 'Test episode', synopsis: 'Only a test.', durationMinutes: 20,
      actors: [], characters: [], distributionRights: [],
    })).status).toBe('saved')
    expect((await service.saveActor(series.id, { id: 'actor-1', name: 'Test actor' })).status).toBe('saved')
    expect((await service.saveCharacter(series.id, { id: 'character-1', name: 'Test character', actorIds: ['actor-1'] })).status).toBe('saved')
    expect((await service.deleteActor(series.id, 'actor-1')).status).toBe('error')
    expect((await service.deleteCharacter(series.id, 'character-1')).status).toBe('saved')
    expect((await service.deleteActor(series.id, 'actor-1')).status).toBe('saved')
    expect((await service.deleteEpisode(series.id, 'season-1', 'episode-1')).status).toBe('saved')
    expect((await service.deleteSeason(series.id, 'season-1')).status).toBe('saved')
  })
})