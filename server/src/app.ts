import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify'
import {
  ActorSchema,
  CatalogEntrySchema,
  CharacterSchema,
  EpisodeSchema,
  SeasonSchema,
  type CatalogEntry,
  type Character,
  type Episode,
  type Season,
} from '../../src/features/catalog/catalog.models.js'
import { CatalogValidationError } from '../../src/features/catalog/catalog.validation.js'
import { DenyAllAdminAuthorizer, type AdminAuthorizer } from './catalog/authorization.js'
import { CatalogConflictError, type CatalogApiRepository } from './catalog/repository.js'
import type { ServerConfig } from './config.js'

interface ApiOptions {
  repository: CatalogApiRepository
  config: Pick<ServerConfig, 'allowedOrigins'>
  authorizer?: AdminAuthorizer
}

export function createApiApp({ repository, config, authorizer = new DenyAllAdminAuthorizer() }: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  void app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true)
      callback(new Error('Origin is not allowed.'), false)
    },
    credentials: true,
  })

  app.addHook('onClose', async () => repository.close())
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CatalogConflictError) return reply.code(409).send({ error: 'duplicate', message: error.message })
    if (error instanceof CatalogValidationError) return reply.code(400).send({ error: 'invalid_record', message: error.message, issues: error.issues })
    if (error instanceof SyntaxError) return reply.code(400).send({ error: 'invalid_json', message: 'Request body must be valid JSON.' })
    return reply.code(500).send({ error: 'internal_error', message: 'The catalogue operation failed.' })
  })

  const requireAdmin = (permission: 'catalog:read' | 'catalog:write'): preHandlerHookHandler => async (request, reply) => {
    if (!authorizer.configured) {
      await reply.code(503).send({ error: 'authorization_not_configured', message: 'Admin API is disabled until server-side authentication is configured.' })
      return
    }
    try {
      const principal = await authorizer.authorize(request)
      if (!principal) {
        await reply.code(401).send({ error: 'unauthorized', message: 'Authentication is required.' })
        return
      }
      if (!principal.permissions.includes(permission)) {
        await reply.code(403).send({ error: 'forbidden', message: 'This account is not authorized for this catalog operation.' })
      }
    } catch {
      await reply.code(503).send({ error: 'authorization_unavailable', message: 'Authorization could not be verified.' })
    }
  }

  app.get('/healthz', async (_request, reply) => {
    try {
      await repository.listPublic()
      return { status: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'unavailable' })
    }
  })

  app.get('/catalog', async (_request, reply) => {
    try { return { items: await repository.listPublic() } } catch { return reply.code(503).send({ error: 'catalog_unavailable' }) }
  })
  app.get<{ Params: { id: string } }>('/catalog/:id', async (request, reply) => {
    try {
      const item = await repository.getPublic(request.params.id)
      return item ? { item } : reply.code(404).send({ error: 'not_found' })
    } catch { return reply.code(503).send({ error: 'catalog_unavailable' }) }
  })

  app.get('/admin/catalog', { preHandler: requireAdmin('catalog:read') }, async (_request, reply) => {
    try { return { items: await repository.listAdmin() } } catch { return reply.code(503).send({ error: 'catalog_unavailable' }) }
  })
  app.get<{ Params: { id: string } }>('/admin/catalog/:id', { preHandler: requireAdmin('catalog:read') }, async (request, reply) => {
    try {
      const item = await repository.getAdmin(request.params.id)
      return item ? { item } : reply.code(404).send({ error: 'not_found' })
    } catch { return reply.code(503).send({ error: 'catalog_unavailable' }) }
  })
  app.post('/admin/catalog', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = CatalogEntrySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    try { return reply.code(201).send({ item: await repository.create(parsed.data) }) } catch (error) { return sendMutationError(error, reply) }
  })
  app.put<{ Params: { id: string } }>('/admin/catalog/:id', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = CatalogEntrySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    if (parsed.data.id !== request.params.id) return reply.code(400).send({ error: 'id_mismatch', message: 'Record ID cannot change during an update.' })
    try {
      const item = await repository.update(request.params.id, parsed.data)
      return item ? { item } : reply.code(404).send({ error: 'not_found' })
    } catch (error) { return sendMutationError(error, reply) }
  })
  app.delete<{ Params: { id: string } }>('/admin/catalog/:id', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    try {
      return await repository.delete(request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' })
    } catch (error) { return sendMutationError(error, reply) }
  })

  registerNestedCrud(app, repository, requireAdmin)
  return app
}

function registerNestedCrud(app: FastifyInstance, repository: CatalogApiRepository, requireAdmin: (permission: 'catalog:read' | 'catalog:write') => preHandlerHookHandler) {
  app.post<{ Params: { id: string } }>('/admin/catalog/:id/seasons', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = SeasonSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    return mutateSeries(repository, request.params.id, reply, (series) => {
      if (series.seasons.some((season) => season.id === parsed.data.id || season.seasonNumber === parsed.data.seasonNumber)) throw new CatalogConflictError('Season ID or number already exists.')
      return { ...series, seasons: [...series.seasons, parsed.data] }
    })
  })
  app.put<{ Params: { id: string; seasonId: string } }>('/admin/catalog/:id/seasons/:seasonId', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = SeasonSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    if (parsed.data.id !== request.params.seasonId) return reply.code(400).send({ error: 'id_mismatch' })
    return mutateSeries(repository, request.params.id, reply, (series) => {
      if (!series.seasons.some((season) => season.id === request.params.seasonId)) throw new Error('Season was not found.')
      if (series.seasons.some((season) => season.id !== parsed.data.id && season.seasonNumber === parsed.data.seasonNumber)) throw new CatalogConflictError('Season number already exists.')
      return { ...series, seasons: series.seasons.map((season) => season.id === parsed.data.id ? parsed.data : season) }
    })
  })
  app.delete<{ Params: { id: string; seasonId: string } }>('/admin/catalog/:id/seasons/:seasonId', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => mutateSeries(repository, request.params.id, reply, (series) => {
    if (!series.seasons.some((season) => season.id === request.params.seasonId)) throw new Error('Season was not found.')
    return { ...series, seasons: series.seasons.filter((season) => season.id !== request.params.seasonId) }
  }))

  app.post<{ Params: { id: string; seasonId: string } }>('/admin/catalog/:id/seasons/:seasonId/episodes', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = EpisodeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    return mutateSeries(repository, request.params.id, reply, (series) => updateSeason(series, request.params.seasonId, (season) => {
      if (season.episodes.some((episode) => episode.id === parsed.data.id || episode.episodeNumber === parsed.data.episodeNumber)) throw new CatalogConflictError('Episode ID or number already exists in this season.')
      return { ...season, episodes: [...season.episodes, parsed.data] }
    }))
  })
  app.put<{ Params: { id: string; seasonId: string; episodeId: string } }>('/admin/catalog/:id/seasons/:seasonId/episodes/:episodeId', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = EpisodeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    if (parsed.data.id !== request.params.episodeId) return reply.code(400).send({ error: 'id_mismatch' })
    return mutateSeries(repository, request.params.id, reply, (series) => updateSeason(series, request.params.seasonId, (season) => {
      if (!season.episodes.some((episode) => episode.id === request.params.episodeId)) throw new Error('Episode was not found.')
      if (season.episodes.some((episode) => episode.id !== parsed.data.id && episode.episodeNumber === parsed.data.episodeNumber)) throw new CatalogConflictError('Episode number already exists in this season.')
      return { ...season, episodes: season.episodes.map((episode) => episode.id === parsed.data.id ? parsed.data : episode) }
    }))
  })
  app.delete<{ Params: { id: string; seasonId: string; episodeId: string } }>('/admin/catalog/:id/seasons/:seasonId/episodes/:episodeId', { preHandler: requireAdmin('catalog:write') }, async (request, reply) => mutateSeries(repository, request.params.id, reply, (series) => updateSeason(series, request.params.seasonId, (season) => {
    if (!season.episodes.some((episode) => episode.id === request.params.episodeId)) throw new Error('Episode was not found.')
    return { ...season, episodes: season.episodes.filter((episode) => episode.id !== request.params.episodeId) }
  })))

  registerCastCrud(app, repository, requireAdmin, 'actors', ActorSchema, 'actors')
  registerCastCrud(app, repository, requireAdmin, 'characters', CharacterSchema, 'characters')
}

function registerCastCrud<T extends { id: string }>(app: FastifyInstance, repository: CatalogApiRepository, requireAdmin: (permission: 'catalog:read' | 'catalog:write') => preHandlerHookHandler, path: 'actors' | 'characters', schema: typeof ActorSchema | typeof CharacterSchema, field: 'actors' | 'characters') {
  app.post<{ Params: { id: string } }>(`/admin/catalog/:id/${path}`, { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    return mutateCast(repository, request.params.id, reply, (entry) => {
      if (entry.kind === 'collection') throw new Error('Cast can only be added to a film or series.')
      const records = entry[field] as unknown as T[]
      if (records.some((record) => record.id === parsed.data.id)) throw new CatalogConflictError(`${path} ID already exists.`)
      return { ...entry, [field]: [...records, parsed.data] }
    })
  })
  app.put<{ Params: { id: string; childId: string } }>(`/admin/catalog/:id/${path}/:childId`, { preHandler: requireAdmin('catalog:write') }, async (request, reply) => {
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_record', issues: parsed.error.issues })
    if (parsed.data.id !== request.params.childId) return reply.code(400).send({ error: 'id_mismatch' })
    return mutateCast(repository, request.params.id, reply, (entry) => {
      if (entry.kind === 'collection') throw new Error('Cast can only be updated on a film or series.')
      const records = entry[field] as unknown as T[]
      if (!records.some((record) => record.id === request.params.childId)) throw new Error(`${path} record was not found.`)
      return { ...entry, [field]: records.map((record) => record.id === parsed.data.id ? parsed.data : record) }
    })
  })
  app.delete<{ Params: { id: string; childId: string } }>(`/admin/catalog/:id/${path}/:childId`, { preHandler: requireAdmin('catalog:write') }, async (request, reply) => mutateCast(repository, request.params.id, reply, (entry) => {
    if (entry.kind === 'collection') throw new Error('Cast can only be deleted from a film or series.')
    const records = entry[field] as unknown as T[]
    if (!records.some((record) => record.id === request.params.childId)) throw new Error(`${path} record was not found.`)
    return { ...entry, [field]: records.filter((record) => record.id !== request.params.childId) }
  }))
}

async function mutateSeries(repository: CatalogApiRepository, id: string, reply: { code: (status: number) => { send: (body?: unknown) => unknown } }, transform: (series: Extract<CatalogEntry, { kind: 'series' }>) => unknown) {
  try {
    const existing = await repository.getAdmin(id)
    if (!existing) return reply.code(404).send({ error: 'not_found' })
    if (existing.kind !== 'series') return reply.code(400).send({ error: 'wrong_record_type', message: 'This operation requires a series record.' })
    const updated = CatalogEntrySchema.parse(transform(existing))
    const result = await repository.update(id, updated)
    return result ? { item: result } : reply.code(404).send({ error: 'not_found' })
  } catch (error) { return sendMutationError(error, reply) }
}

async function mutateCast(repository: CatalogApiRepository, id: string, reply: { code: (status: number) => { send: (body?: unknown) => unknown } }, transform: (entry: CatalogEntry) => unknown) {
  try {
    const existing = await repository.getAdmin(id)
    if (!existing) return reply.code(404).send({ error: 'not_found' })
    const updated = CatalogEntrySchema.parse(transform(existing))
    const result = await repository.update(id, updated)
    return result ? { item: result } : reply.code(404).send({ error: 'not_found' })
  } catch (error) { return sendMutationError(error, reply) }
}

function updateSeason(series: Extract<CatalogEntry, { kind: 'series' }>, seasonId: string, transform: (season: Season) => Season): CatalogEntry {
  if (!series.seasons.some((season) => season.id === seasonId)) throw new Error('Season was not found.')
  return { ...series, seasons: series.seasons.map((season) => season.id === seasonId ? transform(season) : season) }
}

function sendMutationError(error: unknown, reply: { code: (status: number) => { send: (body?: unknown) => unknown } }) {
  if (error instanceof CatalogConflictError) return reply.code(409).send({ error: 'duplicate', message: error.message })
  if (error instanceof CatalogValidationError) return reply.code(400).send({ error: 'invalid_record', message: error.message, issues: error.issues })
  if (error instanceof Error && error.message.endsWith('was not found.')) return reply.code(404).send({ error: 'not_found', message: error.message })
  return reply.code(500).send({ error: 'catalog_write_failed', message: 'The catalog mutation failed.' })
}