import { catalogConfig } from './catalog.config'
import type { CatalogEntry } from './catalog.models'
import { findCatalogDuplicates, parseCatalogEntry, parseCatalogList } from './catalog.validation'

export class CatalogRepositoryError extends Error {
  constructor(
    readonly code: 'not-configured' | 'network' | 'http' | 'conflict' | 'not-found' | 'storage',
    message: string,
  ) {
    super(message)
    this.name = 'CatalogRepositoryError'
  }
}

export interface CatalogRepository {
  readonly mode: 'device' | 'api'
  list(signal?: AbortSignal): Promise<unknown>
  listAdmin(signal?: AbortSignal): Promise<unknown>
  get(id: string, signal?: AbortSignal): Promise<unknown>
  getAdmin(id: string, signal?: AbortSignal): Promise<unknown>
  create(entry: CatalogEntry): Promise<unknown>
  update(id: string, entry: CatalogEntry): Promise<unknown>
  delete(id: string): Promise<void>
}

export class HttpCatalogRepository implements CatalogRepository {
  readonly mode = 'api' as const

  constructor(private readonly baseUrl = catalogConfig.apiBaseUrl) {}

  async list(signal?: AbortSignal): Promise<unknown> {
    return this.request('/catalog', { method: 'GET', signal })
  }

  async listAdmin(signal?: AbortSignal): Promise<unknown> {
    return this.request('/admin/catalog', { method: 'GET', signal })
  }

  async get(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/catalog/${encodeURIComponent(id)}`, { method: 'GET', signal })
  }

  async getAdmin(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/admin/catalog/${encodeURIComponent(id)}`, { method: 'GET', signal })
  }

  async create(entry: CatalogEntry): Promise<unknown> {
    return this.request('/admin/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  }

  async update(id: string, entry: CatalogEntry): Promise<unknown> {
    return this.request(`/admin/catalog/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  }

  async delete(id: string): Promise<void> {
    await this.request(`/admin/catalog/${encodeURIComponent(id)}`, { method: 'DELETE', expectJson: false })
  }

  private async request(path: string, init: RequestInit & { expectJson?: boolean }): Promise<unknown> {
    if (!this.baseUrl) {
      throw new CatalogRepositoryError('not-configured', 'The VOH catalogue API is not configured.')
    }

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers: { Accept: 'application/json', ...init.headers },
      })
    } catch {
      throw new CatalogRepositoryError('network', 'Could not reach the VOH catalogue service.')
    }

    if (response.status === 409) {
      throw new CatalogRepositoryError('conflict', 'The catalogue already contains a conflicting record.')
    }
    if (response.status === 404) {
      throw new CatalogRepositoryError('not-found', 'The catalogue record was not found.')
    }
    if (!response.ok) {
      throw new CatalogRepositoryError('http', `Catalogue request failed (${response.status}).`)
    }
    if (init.expectJson === false || response.status === 204) return undefined

    try {
      return await response.json()
    } catch {
      throw new CatalogRepositoryError('http', 'The catalogue service returned invalid JSON.')
    }
  }
}

export class LocalCatalogRepository implements CatalogRepository {
  readonly mode = 'device' as const

  constructor(
    private readonly getStorage: () => Storage | undefined = () => globalThis.localStorage,
    private readonly storageKey = 'voh-movies.catalog.v1',
  ) {}

  async list(): Promise<unknown> {
    return { items: this.readItems() }
  }

  async listAdmin(): Promise<unknown> {
    return this.list()
  }

  async get(id: string): Promise<unknown> {
    const item = this.readItems().find((record) => record.id === id)
    if (!item) throw new CatalogRepositoryError('not-found', 'The catalogue record was not found.')
    return { item }
  }

  async getAdmin(id: string): Promise<unknown> {
    return this.get(id)
  }

  async create(value: CatalogEntry): Promise<unknown> {
    const entry = parseCatalogEntry(value)
    const items = this.readItems()
    if (findCatalogDuplicates([...items, entry]).length > 0) {
      throw new CatalogRepositoryError('conflict', 'A catalogue record with this identity already exists.')
    }
    this.writeItems([...items, entry])
    return { item: entry }
  }

  async update(id: string, value: CatalogEntry): Promise<unknown> {
    const entry = parseCatalogEntry(value)
    if (entry.id !== id) throw new CatalogRepositoryError('http', 'Record ID cannot change during an update.')
    const items = this.readItems()
    const index = items.findIndex((record) => record.id === id)
    if (index < 0) throw new CatalogRepositoryError('not-found', 'The catalogue record was not found.')
    const next = [...items]
    next[index] = entry
    if (findCatalogDuplicates(next).length > 0) {
      throw new CatalogRepositoryError('conflict', 'A catalogue record with this identity already exists.')
    }
    this.writeItems(next)
    return { item: entry }
  }

  async delete(id: string): Promise<void> {
    const items = this.readItems()
    const next = items.filter((record) => record.id !== id)
    if (next.length === items.length) throw new CatalogRepositoryError('not-found', 'The catalogue record was not found.')
    this.writeItems(next)
  }

  private readItems(): CatalogEntry[] {
    const storage = this.getStorage()
    if (!storage) throw new CatalogRepositoryError('storage', 'Device storage is unavailable in this browser.')
    try {
      const stored = storage.getItem(this.storageKey)
      if (!stored) return []
      return parseCatalogList(JSON.parse(stored))
    } catch (error) {
      if (error instanceof CatalogRepositoryError) throw error
      throw new CatalogRepositoryError('storage', 'The saved device catalogue could not be read or is invalid.')
    }
  }

  private writeItems(items: CatalogEntry[]): void {
    const storage = this.getStorage()
    if (!storage) throw new CatalogRepositoryError('storage', 'Device storage is unavailable in this browser.')
    try {
      storage.setItem(this.storageKey, JSON.stringify({ items }))
    } catch {
      throw new CatalogRepositoryError('storage', 'The catalogue could not be saved in device storage.')
    }
  }
}

export function createCatalogRepository(): CatalogRepository {
  return catalogConfig.apiBaseUrl ? new HttpCatalogRepository() : new LocalCatalogRepository()
}