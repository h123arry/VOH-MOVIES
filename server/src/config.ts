import { readMonetizationConfig, type MonetizationConfig } from './monetization/plans.js'

export interface ServerConfig {
  databaseUrl: string
  databaseSslMode: 'disable' | 'require' | 'verify-full'
  host: string
  port: number
  allowedOrigins: string[]
  adminJwt?: {
    issuer: string
    audience: string
    publicKey: string
    cookieName: string
  }
  paystackSecretKey?: string
  monetization: MonetizationConfig
}

export function readServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required; the API will not start without database configuration.')

  let parsedUrl: URL
  try {
    parsedUrl = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.')
  }
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// protocol.')
  }

  const port = Number(environment.API_PORT ?? '8080')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be an integer between 1 and 65535.')

  const databaseSslMode = environment.DATABASE_SSL_MODE ?? 'require'
  if (!['disable', 'require', 'verify-full'].includes(databaseSslMode)) {
    throw new Error('DATABASE_SSL_MODE must be disable, require, or verify-full.')
  }

  const allowedOrigins = (environment.CATALOG_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
  for (const origin of allowedOrigins) {
    let parsedOrigin: URL
    try {
      parsedOrigin = new URL(origin)
    } catch {
      throw new Error(`CATALOG_ALLOWED_ORIGINS contains an invalid origin: ${origin}`)
    }
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      throw new Error(`CATALOG_ALLOWED_ORIGINS entries must be exact HTTP(S) origins without paths: ${origin}`)
    }
  }

  const adminJwtValues = [
    environment.ADMIN_JWT_ISSUER?.trim(),
    environment.ADMIN_JWT_AUDIENCE?.trim(),
    environment.ADMIN_JWT_PUBLIC_KEY?.trim(),
  ]
  const configuredJwtValues = adminJwtValues.filter(Boolean).length
  if (configuredJwtValues > 0 && configuredJwtValues !== adminJwtValues.length) {
    throw new Error('ADMIN_JWT_ISSUER, ADMIN_JWT_AUDIENCE, and ADMIN_JWT_PUBLIC_KEY must be configured together.')
  }
  const adminCookieName = environment.ADMIN_JWT_COOKIE_NAME?.trim() || 'voh_admin_session'
  if (!/^[A-Za-z0-9_-]+$/.test(adminCookieName)) throw new Error('ADMIN_JWT_COOKIE_NAME contains invalid characters.')
  const paystackSecretKey = environment.PAYSTACK_SECRET_KEY?.trim()

  return {
    databaseUrl,
    databaseSslMode: databaseSslMode as ServerConfig['databaseSslMode'],
    host: environment.API_HOST ?? '127.0.0.1',
    port,
    allowedOrigins,
    ...(paystackSecretKey ? { paystackSecretKey } : {}),
    monetization: readMonetizationConfig(environment),
    ...(configuredJwtValues === 3 ? {
      adminJwt: {
        issuer: adminJwtValues[0]!,
        audience: adminJwtValues[1]!,
        publicKey: adminJwtValues[2]!.replace(/\\n/g, '\n'),
        cookieName: adminCookieName,
      },
    } : {}),
  }
}