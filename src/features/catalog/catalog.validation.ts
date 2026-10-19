import { CatalogEntrySchema, CatalogListResponseSchema, type CatalogEntry } from './catalog.models.js'

export class CatalogValidationError extends Error {
  constructor(message: string, readonly issues: Array<{ path: PropertyKey[]; message: string }> = []) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

export function parseCatalogEntry(value: unknown): CatalogEntry {
  const result = CatalogEntrySchema.safeParse(value)
  if (!result.success) throw new CatalogValidationError(formatIssues(result.error.issues), result.error.issues)
  return result.data
}

export function parseCatalogList(value: unknown): CatalogEntry[] {
  const result = CatalogListResponseSchema.safeParse(value)
  if (!result.success) throw new CatalogValidationError(formatIssues(result.error.issues), result.error.issues)
  const duplicates = findCatalogDuplicates(result.data.items)
  if (duplicates.length > 0) {
    throw new CatalogValidationError(`Duplicate catalogue records found: ${duplicates.join(', ')}.`)
  }
  return result.data.items
}

export function findCatalogDuplicates(items: CatalogEntry[]): string[] {
  const seenIds = new Set<string>()
  const seenExternalIds = new Set<string>()
  const seenContentFingerprints = new Set<string>()
  const duplicates = new Set<string>()

  for (const item of items) {
    const normalizedTitle = normalizeText(item.title)
    const normalizedSynopsis = normalizeText(item.synopsis)
    const externalIds = 'externalIds' in item ? item.externalIds : undefined
    const externalKeys = [
      externalIds?.imdb ? `imdb:${externalIds.imdb.toLowerCase()}` : undefined,
      externalIds?.tmdb ? `tmdb:${externalIds.tmdb}` : undefined,
    ].filter((value): value is string => Boolean(value))
    const contentFingerprint = item.releaseYear && normalizedSynopsis
      ? [item.kind, normalizedTitle, item.releaseYear, normalizedSynopsis, item.kind === 'film' ? item.durationMinutes : ''].join(':')
      : undefined

    if (
      seenIds.has(item.id) ||
      externalKeys.some((key) => seenExternalIds.has(key)) ||
      (contentFingerprint !== undefined && seenContentFingerprints.has(contentFingerprint))
    ) duplicates.add(item.title)
    seenIds.add(item.id)
    externalKeys.forEach((key) => seenExternalIds.add(key))
    if (contentFingerprint) seenContentFingerprints.add(contentFingerprint)
  }

  return [...duplicates]
}

export function isAvailableByRights(item: CatalogEntry, now = new Date()): boolean {
  if (item.kind === 'collection' || item.publicationStatus !== 'published') return false
  return item.distributionRights.some((right) => {
    const startsAt = Date.parse(right.startsAt)
    const endsAt = right.endsAt ? Date.parse(right.endsAt) : Number.POSITIVE_INFINITY
    return right.streamingAllowed && right.platforms.includes('web') && startsAt <= now.getTime() && endsAt > now.getTime()
  })
}

function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; ')
}