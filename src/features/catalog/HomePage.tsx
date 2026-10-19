import { ArrowDown, ArrowRight, Clapperboard, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ContentRail } from './ContentRail'
import { MovieDetailsDialog } from './MovieDetailsDialog'
import type { CatalogEntry } from './catalog.models'
import { matchesCatalogSearch, normalizeCatalogText } from './catalog.search'
import { toCatalogItem } from './catalog.mapper'
import type { CatalogItem, CatalogKind } from './catalog.types'
import { useCatalog } from './useCatalog'
import { readWatchlist, writeWatchlist } from './watchlist.storage'
import { isAvailableByRights } from './catalog.validation'

const kinds: Array<{ label: string; value: CatalogKind | 'all' }> = [
  { label: 'Everything', value: 'all' },
  { label: 'Films', value: 'film' },
  { label: 'Series', value: 'series' },
  { label: 'Collections', value: 'collection' },
]
type CatalogSort = 'title-asc' | 'release-newest' | 'release-oldest'

export function HomePage() {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CatalogKind | 'all'>('all')
  const [genre, setGenre] = useState('all')
  const [sort, setSort] = useState<CatalogSort>('title-asc')
  const [savedIds, setSavedIds] = useState<string[]>(readWatchlist)
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null)
  const catalog = useCatalog()
  const normalizedQuery = normalizeCatalogText(query)
  const storedEntries = catalog.status === 'ready' ? catalog.items : []
  const loadedEntries = catalog.status === 'ready' ? catalog.items : null
  const availableIds = new Set(storedEntries.filter((entry) => isAvailableByRights(entry)).map((entry) => entry.id))
  const displayEntries = storedEntries.filter((entry) =>
    entry.kind === 'collection'
      ? entry.publicationStatus === 'published' && entry.itemIds.some((id) => availableIds.has(id))
      : isAvailableByRights(entry),
  )
  const genreOptions = [...new Set(displayEntries.flatMap((entry) => entry.genres.map((item) => item.name)))].sort((left, right) => left.localeCompare(right))
  const filteredEntries = displayEntries.filter((entry) => {
    const matchesKind = kind === 'all' || entry.kind === kind
    const matchesGenre = genre === 'all' || entry.genres.some((item) => item.name === genre)
    return matchesKind && matchesGenre && matchesCatalogSearch(entry, query)
  }).sort((left, right) => sortEntries(left, right, sort))
  const filtered = filteredEntries.map(toCatalogItem)
  const catalogItems = displayEntries.map(toCatalogItem)
  const savedItems = catalogItems.filter((item) => savedIds.includes(item.id))

  useEffect(() => {
    if (!loadedEntries) return
    const validIds = new Set(loadedEntries.map((entry) => entry.id))
    setSavedIds((current) => {
      const next = current.filter((id) => validIds.has(id))
      if (next.length !== current.length) writeWatchlist(next)
      return next
    })
  }, [loadedEntries])

  const toggleSaved = (id: string) => {
    const updated = savedIds.includes(id) ? savedIds.filter((savedId) => savedId !== id) : [...savedIds, id]
    setSavedIds(updated)
    writeWatchlist(updated)
  }

  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-art" role="img" aria-label="Atmospheric mountain landscape under a night sky; concept image, not a film title." />
        <div className="hero-grain" />
        <div className="hero-content page-container">
          <p className="eyebrow hero-eyebrow"><span /> VOH / A NEW FRAME</p>
          <h1 id="hero-title">A new world<br />of <em>entertainment.</em></h1>
          <p className="hero-description">A more considered home for the stories that stay with you.</p>
          <a className="primary-button" href="#catalogue">Explore the catalogue <ArrowRight size={17} /></a>
          <span className="concept-caption">Concept image · no featured title</span>
        </div>
        <a className="hero-scroll" href="#catalogue" aria-label="Scroll to catalogue"><span>SCROLL TO DISCOVER</span><ArrowDown size={15} /></a>
        <span className="hero-index">VOH — 001</span>
      </section>

      <section className="manifesto page-container" aria-label="VOH MOVIES">
        <div className="manifesto-label"><Sparkles size={15} /><span>MADE FOR THE MOMENT</span></div>
        <p>Not more noise.<br /><span>A better way into the story.</span></p>
        <span className="manifesto-mark" aria-hidden="true">V.</span>
      </section>

      <section className="catalogue-section page-container" id="catalogue" aria-labelledby="catalogue-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE VOH LIBRARY</p>
            <h2 id="catalogue-title">Find your next <em>feeling.</em></h2>
          </div>
          <span className="catalogue-state"><i /> {catalog.status === 'ready' ? catalog.storage === 'device' ? 'Saved on this device' : 'Service connected' : catalog.status === 'loading' ? 'Connecting' : catalog.status === 'error' ? 'Connection issue' : 'Service not configured'}</span>
        </div>

        <div className="browse-tools">
          <div className="kind-tabs" role="group" aria-label="Filter catalogue by type">
            {kinds.map((option) => (
              <button key={option.value} className={kind === option.value ? 'kind-tab active' : 'kind-tab'} onClick={() => setKind(option.value)} aria-pressed={kind === option.value} disabled={catalog.status !== 'ready'}>
                {option.label}
              </button>
            ))}
          </div>
          <label className="catalogue-search">
            <Search size={17} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={catalog.status === 'ready' ? 'Search titles or genres' : 'Search unavailable until connected'} aria-label="Search titles or genres" disabled={catalog.status !== 'ready'} />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">Clear</button>}
          </label>
          <label className="browse-select"><span>Genre</span><select value={genre} onChange={(event) => setGenre(event.target.value)} disabled={catalog.status !== 'ready'}><option value="all">All genres</option>{genreOptions.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>
          <label className="browse-select"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)} disabled={catalog.status !== 'ready'}><option value="title-asc">Title A–Z</option><option value="release-newest">Newest release</option><option value="release-oldest">Oldest release</option></select></label>
        </div>

        {catalog.status === 'loading' ? <LoadingState /> : catalog.status === 'error' ? (
          <div className="catalogue-empty" role="alert">
            <div className="empty-orbit"><Clapperboard size={23} strokeWidth={1.4} /></div>
            <p className="eyebrow">CATALOGUE UNAVAILABLE</p>
            <h3>We couldn't load the VOH library.</h3>
            <p>{catalog.message}</p>
            <button className="catalogue-retry" onClick={() => void catalog.reload()}>Try again</button>
          </div>
        ) : catalog.status === 'not-configured' ? <EmptyState variant="not-configured" /> : (
          filtered.length > 0 ? (
            kind === 'all' ? kinds.slice(1).map((option) => (
              <ContentRail
                key={option.value}
                title={option.label}
                items={filtered.filter((item) => item.kind === option.value)}
                savedIds={savedIds}
                onSelect={setSelectedItem}
                onToggleSaved={toggleSaved}
              />
            )) : (
              <ContentRail title={`${kinds.find((option) => option.value === kind)?.label ?? 'Browse'} selection`} items={filtered} savedIds={savedIds} onSelect={setSelectedItem} onToggleSaved={toggleSaved} />
            )
          ) : <EmptyState variant={normalizedQuery ? 'searched' : 'empty'} />
        )}
      </section>

      <section className="watchlist-section" id="my-list">
        <div className="page-container watchlist-inner">
          <div>
            <p className="eyebrow">YOUR SPACE</p>
            <h2>Keep the stories<br /><em>close.</em></h2>
          </div>
          {savedItems.length > 0 ? (
            <ContentRail title="My list" items={savedItems} savedIds={savedIds} onSelect={setSelectedItem} onToggleSaved={toggleSaved} />
          ) : (
            <div className="watchlist-empty"><Clapperboard size={23} strokeWidth={1.4} /><p>Your list is ready when the catalogue arrives.</p><span>Saved titles stay on this device until account sync is available.</span></div>
          )}
        </div>
      </section>

      <section className="autopilot-band page-container">
        <div className="autopilot-symbol"><Sparkles size={19} /></div>
        <div><p className="eyebrow">ON THE HORIZON</p><h2>VOH AUTOPILOT</h2></div>
        <p className="autopilot-copy">Intelligent curation is planned. No recommendations or automated actions are active yet.</p>
        <span className="future-tag">PLANNED</span>
      </section>
      <MovieDetailsDialog item={selectedItem} saved={selectedItem ? savedIds.includes(selectedItem.id) : false} onClose={() => setSelectedItem(null)} onToggleSaved={toggleSaved} />
    </main>
  )
}

function sortEntries(left: CatalogEntry, right: CatalogEntry, sort: CatalogSort): number {
  if (sort === 'title-asc') return left.title.localeCompare(right.title)
  const leftDate = left.releaseDate ? Date.parse(left.releaseDate) : left.releaseYear ? Date.UTC(left.releaseYear, 0, 1) : Number.NEGATIVE_INFINITY
  const rightDate = right.releaseDate ? Date.parse(right.releaseDate) : right.releaseYear ? Date.UTC(right.releaseYear, 0, 1) : Number.NEGATIVE_INFINITY
  return sort === 'release-newest' ? rightDate - leftDate : leftDate - rightDate
}

function EmptyState({ variant }: { variant: 'not-configured' | 'empty' | 'searched' }) {
  const searched = variant === 'searched'
  return (
    <div className="catalogue-empty" aria-live="polite">
      <div className="empty-orbit"><Clapperboard size={23} strokeWidth={1.4} /></div>
      <p className="eyebrow">{searched ? 'NO MATCHES' : variant === 'empty' ? 'LIBRARY EMPTY' : 'COMING INTO FOCUS'}</p>
      <h3>{searched ? 'Nothing in the library matches yet.' : variant === 'empty' ? 'No titles have been published yet.' : 'The library is not connected yet.'}</h3>
      <p>{searched ? 'Try a different title or genre.' : variant === 'empty' ? 'The catalogue service is connected, but there are no published titles.' : 'No titles are shown until VOH connects a verified catalogue.'}</p>
      <span className="empty-divider" />
      <span className="empty-note">No sample titles · no playback service connected</span>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="catalogue-empty" role="status" aria-live="polite">
      <div className="empty-orbit loading-orbit"><Clapperboard size={23} strokeWidth={1.4} /></div>
      <p className="eyebrow">VOH / LIBRARY</p>
      <h3>Bringing the catalogue into focus.</h3>
      <p>Connecting to the VOH catalogue service.</p>
    </div>
  )
}