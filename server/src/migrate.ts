import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { readServerConfig } from './config.js'

const migrationDirectory = resolve(process.cwd(), 'server/migrations')
const migrationLockKey = 1_704_180_221

export async function runMigrations(pool: Pool, directory = migrationDirectory): Promise<string[]> {
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort()
  if (files.length === 0) throw new Error(`No SQL migrations found in ${directory}.`)

  const appliedNow: string[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLockKey])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await client.query('COMMIT')

    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const migrationClient = await pool.connect()
      try {
        await migrationClient.query('BEGIN')
        await migrationClient.query('SELECT pg_advisory_xact_lock($1)', [migrationLockKey])
        const existing = await migrationClient.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name])
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} was modified; add a new migration instead.`)
          await migrationClient.query('COMMIT')
          continue
        }
        await migrationClient.query(sql)
        await migrationClient.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum])
        await migrationClient.query('COMMIT')
        appliedNow.push(name)
      } catch (error) {
        await migrationClient.query('ROLLBACK')
        throw error
      } finally {
        migrationClient.release()
      }
    }
    return appliedNow
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction already ended */ }
    throw error
  } finally {
    client.release()
  }
}

async function main() {
  const config = readServerConfig()
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSslMode === 'disable' ? false : { rejectUnauthorized: config.databaseSslMode === 'verify-full' },
    connectionTimeoutMillis: 5_000,
  })
  try {
    const applied = await runMigrations(pool)
    console.info(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is already up to date.')
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Database migration failed.')
    process.exitCode = 1
  })
}