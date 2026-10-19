export interface ServerConfig {
  databaseUrl: string
  databaseSslMode: 'disable' | 'require' | 'verify-full'
  host: string
  port: number
  allowedOrigins: string[]
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

  return {
    databaseUrl,
    databaseSslMode: databaseSslMode as ServerConfig['databaseSslMode'],
    host: environment.API_HOST ?? '127.0.0.1',
    port,
    allowedOrigins: (environment.CATALOG_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  }
}