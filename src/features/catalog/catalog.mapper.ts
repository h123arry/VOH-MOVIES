import type { CatalogEntry, CatalogItem } from './catalog.models'

export function toCatalogItem(entry: CatalogEntry): CatalogItem {
  const common = {
    id: entry.id,
    title: entry.title,
    synopsis: entry.synopsis,
    kind: entry.kind,
    publicationStatus: entry.publicationStatus,
    genres: entry.genres.map((genre) => genre.name),
    year: entry.releaseYear,
    releaseDate: entry.releaseDate,
    posterUrl: entry.posterUrl,
    backdropUrl: entry.backdropUrl,
    actors: 'actors' in entry ? entry.actors : [],
    characters: 'characters' in entry ? entry.characters : [],
    distributionRights: 'distributionRights' in entry ? entry.distributionRights : [],
  }

  if (entry.kind === 'film') return { ...common, duration: `${entry.durationMinutes} min` }
  if (entry.kind === 'series') return { ...common, seasons: entry.seasons }
  return { ...common, itemIds: entry.itemIds }
}