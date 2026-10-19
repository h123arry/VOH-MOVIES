import type { CatalogEntry } from './catalog.models.js'

export function normalizeCatalogText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function matchesCatalogSearch(entry: CatalogEntry, query: string): boolean {
  const normalizedQuery = normalizeCatalogText(query)
  if (!normalizedQuery) return true

  const externalIds = 'externalIds' in entry ? Object.values(entry.externalIds ?? {}).join(' ') : ''
  const relatedMetadata = [
    ...entry.genres.flatMap((genre) => [genre.name, genre.slug, genre.description ?? '']),
    ...('actors' in entry ? entry.actors.flatMap((actor) => [actor.name, actor.biography ?? '']) : []),
    ...('characters' in entry ? entry.characters.flatMap((character) => [character.name, character.description ?? '']) : []),
    ...(entry.kind === 'series' ? entry.seasons.flatMap((season) => [season.title ?? '', ...season.episodes.flatMap((episode) => [episode.title, episode.synopsis, ...episode.actors.map((actor) => actor.name), ...episode.characters.map((character) => character.name)])]) : []),
  ]
  const normalizedRecord = normalizeCatalogText([
    entry.id,
    entry.title,
    entry.synopsis,
    entry.releaseYear ?? '',
    entry.releaseDate ?? '',
    externalIds,
    ...relatedMetadata,
  ].join(' '))

  return normalizedRecord.includes(normalizedQuery)
}