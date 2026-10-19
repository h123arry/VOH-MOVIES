const storageKey = 'voh-movies.watchlist.v1'

export function readWatchlist(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
  } catch {
    return []
  }
}

export function writeWatchlist(ids: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(ids))
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}