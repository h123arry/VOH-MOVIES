import { z } from 'zod'

const recordIdSchema = z.string().trim().min(1).max(128)
const uniqueBy = <T>(values: T[], keyOf: (value: T) => string) => new Set(values.map(keyOf)).size === values.length
const uniqueIdList = <T extends { id: string }>(schema: z.ZodType<T>) =>
  z.array(schema).superRefine((values, context) => {
    if (!uniqueBy(values, (value) => value.id)) {
      context.addIssue({ code: 'custom', message: 'IDs in this list must be unique.' })
    }
  })

export const GenreSchema = z.object({
  id: recordIdSchema,
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
})
export type Genre = z.infer<typeof GenreSchema>

export const ActorSchema = z.object({
  id: recordIdSchema,
  name: z.string().trim().min(1).max(160),
  biography: z.string().max(4000).optional(),
  imageUrl: z.string().url().optional(),
})
export type Actor = z.infer<typeof ActorSchema>

export const CharacterSchema = z.object({
  id: recordIdSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  actorIds: z.array(recordIdSchema),
})
export type Character = z.infer<typeof CharacterSchema>

export const DistributionRightSchema = z.object({
  id: recordIdSchema,
  territoryCodes: z.array(z.string().regex(/^([A-Z]{2}|WORLDWIDE)$/)).min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  platforms: z.array(z.enum(['web', 'ios', 'android', 'tv'])).min(1),
  streamingAllowed: z.boolean(),
  downloadAllowed: z.boolean(),
}).superRefine((right, context) => {
  if (right.endsAt && Date.parse(right.endsAt) <= Date.parse(right.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Distribution rights must end after they start.' })
  }
  if (!uniqueBy(right.territoryCodes, (territory) => territory)) {
    context.addIssue({ code: 'custom', path: ['territoryCodes'], message: 'Territories must be unique.' })
  }
  if (!uniqueBy(right.platforms, (platform) => platform)) {
    context.addIssue({ code: 'custom', path: ['platforms'], message: 'Platforms must be unique.' })
  }
})
export type DistributionRight = z.infer<typeof DistributionRightSchema>

const genreListSchema = uniqueIdList(GenreSchema)
const actorListSchema = uniqueIdList(ActorSchema)
const characterListSchema = uniqueIdList(CharacterSchema)
const rightsListSchema = uniqueIdList(DistributionRightSchema)

const catalogTitleSchema = z.object({
  id: recordIdSchema,
  externalIds: z.object({
    imdb: z.string().regex(/^tt\d{7,10}$/).optional(),
    tmdb: z.number().int().positive().optional(),
  }).optional(),
  title: z.string().trim().min(1).max(240),
  synopsis: z.string().trim().min(1).max(8000),
  releaseYear: z.number().int().min(1888).max(2200).optional(),
  releaseDate: z.string().date().optional(),
  publicationStatus: z.enum(['draft', 'published']).default('draft'),
  genres: genreListSchema,
  actors: actorListSchema,
  characters: characterListSchema,
  distributionRights: rightsListSchema,
  posterUrl: z.string().url().optional(),
  backdropUrl: z.string().url().optional(),
})

function validateCharacterActors(
  record: { actors: Actor[]; characters: Character[] },
  context: z.RefinementCtx,
) {
  const actorIds = new Set(record.actors.map((actor) => actor.id))
  record.characters.forEach((character, index) => {
    character.actorIds.forEach((actorId) => {
      if (!actorIds.has(actorId)) {
        context.addIssue({ code: 'custom', path: ['characters', index, 'actorIds'], message: `Unknown actor ID: ${actorId}` })
      }
    })
  })
}

export const MovieSchema = catalogTitleSchema.extend({
  kind: z.literal('film'),
  durationMinutes: z.number().int().min(1).max(1000),
}).superRefine(validateCharacterActors)
export type Movie = z.infer<typeof MovieSchema>

export const EpisodeSchema = z.object({
  id: recordIdSchema,
  episodeNumber: z.number().int().min(1),
  title: z.string().trim().min(1).max(240),
  synopsis: z.string().trim().min(1).max(8000),
  durationMinutes: z.number().int().min(1).max(1000),
  releaseYear: z.number().int().min(1888).max(2200).optional(),
  releaseDate: z.string().date().optional(),
  actors: actorListSchema,
  characters: characterListSchema,
  distributionRights: rightsListSchema,
}).superRefine((episode, context) => {
  if (episode.releaseDate && episode.releaseYear && Number(episode.releaseDate.slice(0, 4)) !== episode.releaseYear) {
    context.addIssue({ code: 'custom', path: ['releaseDate'], message: 'Episode release date year must match release year.' })
  }
  const actorIds = new Set(episode.actors.map((actor) => actor.id))
  episode.characters.forEach((character, index) => {
    character.actorIds.forEach((actorId) => {
      if (!actorIds.has(actorId)) {
        context.addIssue({ code: 'custom', path: ['characters', index, 'actorIds'], message: `Unknown actor ID: ${actorId}` })
      }
    })
  })
})
export type Episode = z.infer<typeof EpisodeSchema>

export const SeasonSchema = z.object({
  id: recordIdSchema,
  seasonNumber: z.number().int().min(1),
  title: z.string().trim().min(1).max(240).optional(),
  episodes: z.array(EpisodeSchema),
}).superRefine((season, context) => {
  if (!uniqueBy(season.episodes, (episode) => String(episode.episodeNumber))) {
    context.addIssue({ code: 'custom', path: ['episodes'], message: 'Episode numbers must be unique within a season.' })
  }
  if (!uniqueBy(season.episodes, (episode) => episode.id)) {
    context.addIssue({ code: 'custom', path: ['episodes'], message: 'Episode IDs must be unique within a season.' })
  }
})
export type Season = z.infer<typeof SeasonSchema>

export const SeriesSchema = catalogTitleSchema.extend({
  kind: z.literal('series'),
  seasons: z.array(SeasonSchema),
}).superRefine((series, context) => {
  if (!uniqueBy(series.seasons, (season) => String(season.seasonNumber))) {
    context.addIssue({ code: 'custom', path: ['seasons'], message: 'Season numbers must be unique.' })
  }
  if (!uniqueBy(series.seasons, (season) => season.id)) {
    context.addIssue({ code: 'custom', path: ['seasons'], message: 'Season IDs must be unique.' })
  }
  validateCharacterActors(series, context)
  const episodeIds = series.seasons.flatMap((season) => season.episodes.map((episode) => episode.id))
  if (!uniqueBy(episodeIds, (id) => id)) {
    context.addIssue({ code: 'custom', path: ['seasons'], message: 'Episode IDs must be unique across the series.' })
  }
})
export type Series = z.infer<typeof SeriesSchema>

export const CollectionSchema = z.object({
  id: recordIdSchema,
  kind: z.literal('collection'),
  publicationStatus: z.enum(['draft', 'published']).default('draft'),
  title: z.string().trim().min(1).max(240),
  synopsis: z.string().trim().min(1).max(8000),
  releaseYear: z.number().int().min(1888).max(2200).optional(),
  releaseDate: z.string().date().optional(),
  genres: genreListSchema,
  itemIds: z.array(recordIdSchema),
  posterUrl: z.string().url().optional(),
  backdropUrl: z.string().url().optional(),
}).superRefine((collection, context) => {
  if (!uniqueBy(collection.itemIds, (id) => id)) {
    context.addIssue({ code: 'custom', path: ['itemIds'], message: 'Collection item IDs must be unique.' })
  }
})
export type CatalogCollection = z.infer<typeof CollectionSchema>

export const CatalogEntrySchema = z.discriminatedUnion('kind', [MovieSchema, SeriesSchema, CollectionSchema]).superRefine((entry, context) => {
  if (entry.releaseDate && entry.releaseYear && Number(entry.releaseDate.slice(0, 4)) !== entry.releaseYear) {
    context.addIssue({ code: 'custom', path: ['releaseDate'], message: 'Release date year must match release year.' })
  }
  if (entry.kind !== 'collection' && entry.publicationStatus === 'published' && !entry.distributionRights.some((right) => right.streamingAllowed && right.platforms.includes('web'))) {
    context.addIssue({ code: 'custom', path: ['distributionRights'], message: 'A web streaming right is required before publication.' })
  }
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

export const CatalogListResponseSchema = z.object({ items: z.array(CatalogEntrySchema) })
export const CatalogCreateResponseSchema = z.object({ item: CatalogEntrySchema })

export interface CatalogItem {
  id: string
  title: string
  synopsis: string
  kind: 'film' | 'series' | 'collection'
  publicationStatus: 'draft' | 'published'
  genres: string[]
  year?: number
  releaseDate?: string
  duration?: string
  posterUrl?: string
  backdropUrl?: string
  actors: Actor[]
  characters: Character[]
  distributionRights: DistributionRight[]
  seasons?: Season[]
  itemIds?: string[]
}

export type CatalogLoadResult =
  | { status: 'ready'; items: CatalogEntry[]; storage: 'device' | 'api' }
  | { status: 'not-configured'; items: [] }
  | { status: 'error'; items: []; message: string }

export type CatalogGetResult =
  | { status: 'ready'; item: CatalogEntry; storage: 'device' | 'api' }
  | { status: 'not-found' | 'not-configured' | 'error'; message: string }

export type CatalogMutationResult =
  | { status: 'created'; item: CatalogEntry }
  | { status: 'saved'; item: CatalogEntry }
  | { status: 'duplicate'; message: string }
  | { status: 'not-found'; message: string }
  | { status: 'not-configured'; message: string }
  | { status: 'error'; message: string }

export type CatalogCreateResult = CatalogMutationResult
export type CatalogDeleteResult = { status: 'deleted' } | { status: 'not-found' | 'not-configured' | 'error'; message: string }