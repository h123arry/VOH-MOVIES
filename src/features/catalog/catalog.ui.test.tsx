// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { CatalogStudioPage } from '../admin/CatalogStudioPage'
import { HomePage } from './HomePage'
import type { CatalogEntry, Movie, Series } from './catalog.models'

const catalogKey = 'voh-movies.catalog.v1'

function right() {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString()
  return {
    id: 'rights-1',
    territoryCodes: ['US'],
    startsAt: yesterday,
    endsAt: tomorrow,
    platforms: ['web' as const],
    streamingAllowed: true,
    downloadAllowed: false,
  }
}

function film(overrides: Partial<Movie> = {}): Movie {
  return {
    id: 'film-1',
    kind: 'film',
    publicationStatus: 'published',
    title: 'Café Transmission',
    synopsis: 'A record used only by catalogue interface tests.',
    releaseYear: 2022,
    releaseDate: '2022-06-14',
    durationMinutes: 104,
    genres: [{ id: 'genre-1', slug: 'noir', name: 'Noir' }],
    actors: [{ id: 'actor-1', name: 'Test Actor' }],
    characters: [{ id: 'character-1', name: 'The Listener', actorIds: ['actor-1'] }],
    distributionRights: [right()],
    ...overrides,
  }
}

function series(): Series {
  const episode = (id: string, episodeNumber: number, title: string) => ({
    id,
    episodeNumber,
    title,
    synopsis: `Synopsis for ${title}`,
    durationMinutes: 42,
    actors: [],
    characters: [],
    distributionRights: [right()],
  })
  return {
    id: 'series-1',
    kind: 'series',
    publicationStatus: 'published',
    title: 'Signal / Noise',
    synopsis: 'A series record used only in tests.',
    genres: [],
    actors: [],
    characters: [],
    distributionRights: [right()],
    seasons: [
      { id: 'season-2', seasonNumber: 2, episodes: [episode('episode-2-2', 2, 'Second episode'), episode('episode-2-1', 1, 'First episode')] },
      { id: 'season-1', seasonNumber: 1, episodes: [episode('episode-1-1', 1, 'Opening episode')] },
    ],
  }
}

function setCatalog(items: CatalogEntry[]) {
  localStorage.setItem(catalogKey, JSON.stringify({ items }))
}

function renderHome() {
  return render(<MemoryRouter><HomePage /></MemoryRouter>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('catalogue browsing UI', () => {
  it('shows an honest empty state with no catalog records', async () => {
    renderHome()
    expect(await screen.findByText('No titles have been published yet.')).toBeTruthy()
  })

  it('searches normalized titles and genres, then opens record-backed details', async () => {
    setCatalog([film()])
    renderHome()

    const search = await screen.findByRole('textbox', { name: 'Search titles or genres' })
    fireEvent.change(search, { target: { value: 'cafe' } })
    const titleButton = await screen.findByRole('button', { name: 'View details for Café Transmission' })
    fireEvent.click(titleButton)
    expect(screen.getByRole('dialog').textContent).toContain('The Listener')
    expect(screen.getByRole('dialog').textContent).toContain('Test Actor')
    expect(screen.getByRole('dialog').textContent).toContain('Noir')

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    fireEvent.change(search, { target: { value: 'noir' } })
    expect(await screen.findByRole('button', { name: 'View details for Café Transmission' })).toBeTruthy()
  })

  it('filters by actual genre records', async () => {
    setCatalog([film(), film({ id: 'film-2', title: 'Uncategorized title', genres: [] })])
    renderHome()

    const genre = await screen.findByRole('combobox', { name: 'Genre' })
    fireEvent.change(genre, { target: { value: 'Noir' } })
    expect(await screen.findByRole('button', { name: 'View details for Café Transmission' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View details for Uncategorized title' })).toBeNull()
  })

  it('sorts by title and release date from catalog fields', async () => {
    setCatalog([
      film({ id: 'film-z', title: 'Zulu', releaseYear: 2024, releaseDate: '2024-06-14' }),
      film({ id: 'film-a', title: 'Alpha', releaseYear: 2021, releaseDate: '2021-06-14' }),
      film({ id: 'film-m', title: 'Middle', releaseYear: 2022, releaseDate: '2022-06-14' }),
    ])
    const { container } = renderHome()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Films' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(await screen.findByRole('button', { name: 'Films' }))
    const sort = screen.getByRole('combobox', { name: 'Sort' })
    const titles = () => [...container.querySelectorAll('.movie-title-button')].map((button) => button.textContent)

    expect(titles()).toEqual(['Alpha', 'Middle', 'Zulu'])
    fireEvent.change(sort, { target: { value: 'release-newest' } })
    expect(titles()).toEqual(['Zulu', 'Middle', 'Alpha'])
  })

  it('orders series seasons and episodes numerically in details', async () => {
    setCatalog([series()])
    const { container } = renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Signal / Noise' }))

    const seasonHeadings = within(screen.getByRole('dialog')).getAllByRole('heading', { level: 3 })
    expect(seasonHeadings.map((heading) => heading.textContent)).toEqual(['Season 1', 'Season 2'])
    const seasonArticles = container.querySelectorAll('.details-season')
    expect(seasonArticles[1].textContent?.indexOf('2.01')).toBeLessThan(seasonArticles[1].textContent?.indexOf('2.02') ?? 0)
  })

  it('keeps drafts and expired-rights records out of public listings', async () => {
    setCatalog([
      film({ id: 'draft-1', title: 'Draft title', publicationStatus: 'draft' }),
      film({ id: 'expired-1', title: 'Expired title', distributionRights: [{ ...right(), endsAt: new Date(Date.now() - 1000).toISOString() }] }),
    ])
    renderHome()
    await waitFor(() => expect(screen.getByText('No titles have been published yet.')).toBeTruthy())
    expect(screen.queryByText('Draft title')).toBeNull()
    expect(screen.queryByText('Expired title')).toBeNull()
  })

  it('searches cast and episode metadata from real catalog records', async () => {
    setCatalog([film(), series()])
    renderHome()
    const search = await screen.findByRole('textbox', { name: 'Search titles or genres' })
    fireEvent.change(search, { target: { value: 'test actor' } })
    expect(await screen.findByRole('button', { name: 'View details for Café Transmission' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'opening episode' } })
    expect(await screen.findByRole('button', { name: 'View details for Signal / Noise' })).toBeTruthy()
  })

  it('keeps stable watchlist IDs that exist and removes deleted catalog IDs', async () => {
    setCatalog([film()])
    localStorage.setItem('voh-movies.watchlist.v1', JSON.stringify(['film-1', 'deleted-id']))
    renderHome()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'View details for Café Transmission' }).length).toBeGreaterThan(0))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('voh-movies.watchlist.v1') ?? '[]')).toEqual(['film-1']))
  })

  it('retries a failed catalog read and reflects repaired storage', async () => {
    localStorage.setItem(catalogKey, '{ broken json')
    renderHome()
    expect(await screen.findByRole('alert')).toBeTruthy()
    setCatalog([film()])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'View details for Café Transmission' })).toBeTruthy()
  })

  it('requires valid rights to publish and confirms deletion before removing a record', async () => {
    render(<MemoryRouter><CatalogStudioPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'New film' }))
    const editor = screen.getByRole('textbox', { name: 'Catalog record JSON' })
    const invalidForPublication = film({ id: 'studio-film', distributionRights: [] })
    fireEvent.change(editor, { target: { value: JSON.stringify(invalidForPublication, null, 2) } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect((await screen.findByRole('alert')).textContent).toContain('distributionRights')
    expect(localStorage.getItem(catalogKey)).toBeNull()

    fireEvent.change(editor, { target: { value: JSON.stringify(film({ id: 'studio-film', publicationStatus: 'draft' }), null, 2) } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText('Record published.')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(catalogKey) ?? '{"items":[]}').items[0].publicationStatus).toBe('published')

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    expect(JSON.parse(localStorage.getItem(catalogKey) ?? '{"items":[]}').items).toHaveLength(1)
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(catalogKey) ?? '{"items":[]}').items).toHaveLength(0))
    expect(screen.getByText('Catalogue record deleted.')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(catalogKey) ?? '{"items":[]}').items).toHaveLength(0)
  })

  it('retries the same save operation after a temporary storage failure', async () => {
    render(<MemoryRouter><CatalogStudioPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'New film' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Catalog record JSON' }), {
      target: { value: JSON.stringify(film({ id: 'retry-film', publicationStatus: 'draft' }), null, 2) },
    })

    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(function (this: Storage, key, value) {
      if (key === catalogKey) throw new Error('Temporary storage write failure')
      return originalSetItem.call(this, key, value)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText('The catalogue could not be saved in device storage.')).toBeTruthy()
    vi.restoreAllMocks()
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Draft saved.')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(catalogKey) ?? '{"items":[]}').items[0].id).toBe('retry-film')
  })
})