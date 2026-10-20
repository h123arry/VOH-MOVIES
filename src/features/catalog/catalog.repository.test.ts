import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogRepositoryError, HttpCatalogRepository } from './catalog.repository'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpCatalogRepository', () => {
  it('uses the public catalog API with browser credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new HttpCatalogRepository('https://api.example.test/')

    await expect(repository.list()).resolves.toEqual({ items: [] })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/catalog', expect.objectContaining({
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }))
  })

  it.each([
    [400, 'http', 'The catalog record is invalid.'],
    [401, 'unauthorized', 'Authentication is required.'],
    [403, 'forbidden', 'This account is not authorized.'],
    [503, 'unavailable', 'The catalog is temporarily unavailable.'],
  ] as const)('surfaces API status %s with its server message', async (status, code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code, message }), { status })))
    const repository = new HttpCatalogRepository('https://api.example.test')

    await expect(repository.listAdmin()).rejects.toMatchObject({
      code,
      message,
    } satisfies Partial<CatalogRepositoryError>)
  })

  it('surfaces network errors instead of returning a success-shaped response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const repository = new HttpCatalogRepository('https://api.example.test')

    await expect(repository.list()).rejects.toMatchObject({ code: 'network' })
  })
})
