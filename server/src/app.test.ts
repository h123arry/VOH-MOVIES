import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { CatalogEntry, DistributionRight, Movie } from '../../src/features/catalog/catalog.models.js'
import type { BillingRepository } from './payments/repository.js'
import { BillingService } from './payments/service.js'
import { readMonetizationConfig } from './monetization/plans.js'
import type { CatalogApiRepository } from './catalog/repository.js'
import { HttpCatalogRepository } from '../../src/features/catalog/catalog.repository.js'
import { JwtAdminAuthorizer } from './catalog/authorization.js'
import { createApiApp } from './app.js'

const issuer = 'https://identity.example.test/'
const audience = 'voh-movies-api'
const allowedOrigin = 'https://movies.example.test'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

function token(scope = 'catalog:read catalog:write', overrides: Record<string, unknown> = {}): string {
  const header = encode({ alg: 'RS256', typ: 'JWT' })
  const claims = encode({
    iss: issuer,
    aud: audience,
    sub: 'admin-subject',
    exp: Math.floor(Date.now() / 1000) + 300,
    scope,
    ...overrides,
  })
  const unsigned = `${header}.${claims}`
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function activeRight(): DistributionRight {
  return {
    id: 'right-1',
    territoryCodes: ['WORLDWIDE'],
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    platforms: ['web'],
    streamingAllowed: true,
    downloadAllowed: false,
  }
}

function draft(overrides: Partial<Movie> = {}): Movie {
  return {
    id: 'film-1',
    kind: 'film',
    publicationStatus: 'draft',
    title: 'API integration record',
    synopsis: 'A record used only by API integration tests.',
    durationMinutes: 90,
    genres: [],
    actors: [],
    characters: [],
    distributionRights: [],
    ...overrides,
  }
}

class MemoryCatalogRepository implements CatalogApiRepository {
  readonly create = vi.fn(async (entry: CatalogEntry) => {
    this.items.set(entry.id, entry)
    return entry
  })
  readonly update = vi.fn(async (id: string, entry: CatalogEntry) => {
    if (!this.items.has(id)) return null
    this.items.set(id, entry)
    return entry
  })
  readonly delete = vi.fn(async (id: string) => this.items.delete(id))
  readonly items = new Map<string, CatalogEntry>()

  async listPublic() {
    return [...this.items.values()].filter((entry) =>
      entry.publicationStatus === 'published' &&
      entry.kind !== 'collection' &&
      entry.distributionRights.some((right) =>
        right.streamingAllowed &&
        right.platforms.includes('web') &&
        right.territoryCodes.includes('WORLDWIDE') &&
        Date.parse(right.startsAt) <= Date.now() &&
        (!right.endsAt || Date.parse(right.endsAt) > Date.now()),
      ),
    )
  }

  async getPublic(id: string) {
    return (await this.listPublic()).find((entry) => entry.id === id) ?? null
  }

  async listAdmin() {
    return [...this.items.values()]
  }

  async getAdmin(id: string) {
    return this.items.get(id) ?? null
  }

  async close() {}
}

const appInstances: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(appInstances.splice(0).map((app) => app.close()))
})

function createTestApp(repository = new MemoryCatalogRepository()): { app: FastifyInstance; repository: MemoryCatalogRepository } {
  const app = createApiApp({
    repository,
    config: { allowedOrigins: [allowedOrigin] },
    authorizer: new JwtAdminAuthorizer({
      issuer,
      audience,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      cookieName: 'voh_admin_session',
    }),
  })
  appInstances.push(app)
  return { app, repository }
}

function adminHeaders(scope?: string) {
  return {
    authorization: `Bearer ${token(scope)}`,
    origin: allowedOrigin,
  }
}

describe('catalog API authorization and CRUD', () => {
  it('keeps the admin API disabled when no authorizer is configured', async () => {
    const repository = new MemoryCatalogRepository()
    const app = createApiApp({ repository, config: { allowedOrigins: [allowedOrigin] } })
    appInstances.push(app)
    const response = await app.inject({ method: 'GET', url: '/admin/catalog', headers: { origin: allowedOrigin } })
    expect(response.statusCode).toBe(503)
    expect(repository.items.size).toBe(0)
  })

  it('rejects unauthenticated access to every admin route', async () => {
    const { app, repository } = createTestApp()
    const routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/admin/catalog' },
      { method: 'GET', url: '/admin/catalog/film-1' },
      { method: 'POST', url: '/admin/catalog' },
      { method: 'PUT', url: '/admin/catalog/film-1' },
      { method: 'DELETE', url: '/admin/catalog/film-1' },
      { method: 'POST', url: '/admin/catalog/series-1/seasons' },
      { method: 'PUT', url: '/admin/catalog/series-1/seasons/season-1' },
      { method: 'DELETE', url: '/admin/catalog/series-1/seasons/season-1' },
      { method: 'POST', url: '/admin/catalog/series-1/seasons/season-1/episodes' },
      { method: 'PUT', url: '/admin/catalog/series-1/seasons/season-1/episodes/episode-1' },
      { method: 'DELETE', url: '/admin/catalog/series-1/seasons/season-1/episodes/episode-1' },
      { method: 'POST', url: '/admin/catalog/film-1/actors' },
      { method: 'PUT', url: '/admin/catalog/film-1/actors/actor-1' },
      { method: 'DELETE', url: '/admin/catalog/film-1/actors/actor-1' },
      { method: 'POST', url: '/admin/catalog/film-1/characters' },
      { method: 'PUT', url: '/admin/catalog/film-1/characters/character-1' },
      { method: 'DELETE', url: '/admin/catalog/film-1/characters/character-1' },
    ]

    for (const route of routes) {
      const response = await app.inject({
        ...route,
        headers: { origin: allowedOrigin },
        payload: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      })
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
    const spoofedIdentity = await app.inject({
      method: 'GET',
      url: '/admin/catalog',
      headers: { origin: allowedOrigin, 'x-user-id': 'admin', 'x-role': 'catalog:write' },
    })
    expect(spoofedIdentity.statusCode).toBe(401)
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.update).not.toHaveBeenCalled()
    expect(repository.delete).not.toHaveBeenCalled()
  })

  it('does not run handlers when a verified user lacks the required scope', async () => {
    const { app, repository } = createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: adminHeaders('catalog:read'),
      payload: draft(),
    })
    expect(response.statusCode).toBe(403)
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a write without an allowed browser origin', async () => {
    const { app, repository } = createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: { authorization: `Bearer ${token()}` },
      payload: draft(),
    })
    expect(response.statusCode).toBe(403)
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('validates input and reports storage failures without success responses', async () => {
    const { app, repository } = createTestApp()
    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: adminHeaders(),
      payload: { id: 'bad', kind: 'film', title: '' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(repository.create).not.toHaveBeenCalled()

    const malformedJson = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      payload: '{broken',
    })
    expect(malformedJson.statusCode).toBe(400)
    expect(malformedJson.json()).toMatchObject({ error: 'invalid_json' })

    repository.create.mockRejectedValueOnce(new Error('database write failed'))
    const failed = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: adminHeaders(),
      payload: draft(),
    })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toMatchObject({ error: 'catalog_write_failed' })
    expect(failed.json()).not.toHaveProperty('item')
  })

  it('creates, edits, publishes, lists, retrieves, and deletes records', async () => {
    const { app } = createTestApp()
    const created = await app.inject({
      method: 'POST',
      url: '/admin/catalog',
      headers: adminHeaders(),
      payload: draft(),
    })
    expect(created.statusCode).toBe(201)

    const updated = await app.inject({
      method: 'PUT',
      url: '/admin/catalog/film-1',
      headers: adminHeaders(),
      payload: draft({ title: 'Edited API integration record' }),
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().item.title).toBe('Edited API integration record')

    const published = await app.inject({
      method: 'PUT',
      url: '/admin/catalog/film-1',
      headers: adminHeaders(),
      payload: draft({ title: 'Edited API integration record', publicationStatus: 'published', distributionRights: [activeRight()] }),
    })
    expect(published.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/catalog' })).json().items).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: '/catalog/film-1' })).statusCode).toBe(200)

    expect((await app.inject({
      method: 'DELETE',
      url: '/admin/catalog/film-1',
      headers: adminHeaders(),
    })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/catalog/film-1' })).statusCode).toBe(404)
  })

  it('does not return a success-shaped response when a public database read fails', async () => {
    const { app, repository } = createTestApp()
    vi.spyOn(repository, 'listPublic').mockRejectedValueOnce(new Error('database unavailable'))
    const response = await app.inject({ method: 'GET', url: '/catalog' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'catalog_unavailable' })
    expect(response.json()).not.toHaveProperty('items')
  })
})

describe('JWT administrator authorizer', () => {
  it('rejects tampered, expired, wrong-issuer, and wrong-audience tokens', async () => {
    const { app } = createTestApp()
    const cases = [
      `${token().slice(0, -2)}xx`,
      token('catalog:read catalog:write', { exp: Math.floor(Date.now() / 1000) - 1 }),
      token('catalog:read catalog:write', { iss: 'https://untrusted.example.test/' }),
      token('catalog:read catalog:write', { aud: 'another-service' }),
    ]
    for (const invalidToken of cases) {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/catalog',
        headers: { authorization: `Bearer ${invalidToken}`, origin: allowedOrigin },
      })
      expect(response.statusCode).toBe(401)
    }
  })

  it('accepts a valid signed token from the configured HTTP-only cookie', async () => {
    const { app } = createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/admin/catalog',
      headers: { cookie: `voh_admin_session=${token()}`, origin: allowedOrigin },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('account billing API', () => {
  it('derives the billing account from a signed subject and rejects client-selected beneficiaries', async () => {
    const billingRepository: BillingRepository = {
      createPendingPayment: vi.fn(),
      findPayment: vi.fn(),
      markCheckoutReady: vi.fn(),
      markInitializationFailed: vi.fn(),
      settlePayment: vi.fn(),
      recordWebhook: vi.fn(),
      finishWebhook: vi.fn(),
      getAccountBillingState: vi.fn(async (accountId) => {
        expect(accountId).toBe('trusted-account-subject')
        return { subscription: null, rentals: [] }
      }),
      scheduleSubscriptionCancellation: vi.fn(),
      recordReconciliation: vi.fn(),
    }
    const catalogRepository = new MemoryCatalogRepository()
    const config = readMonetizationConfig({})
    const billing = new BillingService(config, undefined, billingRepository, catalogRepository, true)
    const app = createApiApp({
      repository: catalogRepository,
      config: { allowedOrigins: [allowedOrigin] },
      authorizer: new JwtAdminAuthorizer({
        issuer,
        audience,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        cookieName: 'voh_admin_session',
      }),
      billing,
    })
    appInstances.push(app)

    const unauthorized = await app.inject({ method: 'GET', url: '/billing/me' })
    expect(unauthorized.statusCode).toBe(401)
    const account = await app.inject({
      method: 'GET',
      url: '/billing/me',
      headers: { authorization: `Bearer ${token('', { sub: 'trusted-account-subject' })}`, origin: allowedOrigin },
    })
    expect(account.statusCode).toBe(200)
    expect(account.json().entitlements).toMatchObject({ planCode: 'FREE', active: false })

    const spoofedAccount = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { ...adminHeaders(''), 'idempotency-key': 'checkout-key-1234' },
      payload: { planCode: 'MEDIUM', userId: 'attacker-selected-subject' },
    })
    expect(spoofedAccount.statusCode).toBe(400)
    expect(billingRepository.createPendingPayment).not.toHaveBeenCalled()
  })
})

describe('frontend HTTP repository integration', () => {
  it('loads the API response through HttpCatalogRepository', async () => {
    const { app } = createTestApp()
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    const repository = new HttpCatalogRepository(baseUrl)
    expect(repository.mode).toBe('api')
    expect(await repository.list()).toEqual({ items: [] })
  })
})
