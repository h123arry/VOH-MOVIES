import { PostgresCatalogRepository } from './catalog/postgres.repository.js'
import { createApiApp } from './app.js'
import { readServerConfig } from './config.js'

async function main() {
  const config = readServerConfig()
  const repository = new PostgresCatalogRepository(config)
  try {
    await repository.checkReady()
    const app = createApiApp({ repository, config })
    await app.listen({ host: config.host, port: config.port })
    app.log.info({ host: config.host, port: config.port }, 'VOH catalog API is listening')
  } catch (error) {
    await repository.close()
    throw error
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'VOH catalog API failed to start.')
  process.exitCode = 1
})