import type { CatalogEntry } from '../../../src/features/catalog/catalog.models.js'

export interface CatalogApiRepository {
  listPublic(): Promise<CatalogEntry[]>
  getPublic(id: string): Promise<CatalogEntry | null>
  listAdmin(): Promise<CatalogEntry[]>
  getAdmin(id: string): Promise<CatalogEntry | null>
  create(entry: CatalogEntry): Promise<CatalogEntry>
  update(id: string, entry: CatalogEntry): Promise<CatalogEntry | null>
  delete(id: string): Promise<boolean>
  close(): Promise<void>
}

export class CatalogConflictError extends Error {
  constructor(message = 'A catalog record with this identity already exists.') {
    super(message)
    this.name = 'CatalogConflictError'
  }
}