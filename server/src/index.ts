import { PostgresCatalogRepository } from './catalog/postgres.repository.js'
import { DenyAllAdminAuthorizer, JwtAdminAuthorizer } from './catalog/authorization.js'
import { createApiApp } from './app.js'
import { readServerConfig } from './config.js'
import { PostgresBillingRepository } from './payments/postgres.repository.js'
import { PaystackProvider } from './payments/paystack.provider.js'
import { BillingService } from './payments/service.js'

async function main() {
  const config = readServerConfig()
  const repository = new PostgresCatalogRepository(config)
  const billingRepository = new PostgresBillingRepository(config)
  try {
    await repository.checkReady()
    await billingRepository.syncPlans(config.monetization.plans)
    const authorizer = config.adminJwt ? new JwtAdminAuthorizer(config.adminJwt) : new DenyAllAdminAuthorizer()
    const paymentProvider = new PaystackProvider({ secretKey: config.paystackSecretKey })
    const billing = new BillingService(config.monetization, paymentProvider, billingRepository, repository, Boolean(config.adminJwt))
    const app = createApiApp({ repository, config, authorizer, billing })
    await app.listen({ host: config.host, port: config.port })
    app.log.info({ host: config.host, port: config.port }, 'VOH catalog API is listening')
  } catch (error) {
    await Promise.all([repository.close(), billingRepository.close()])
    throw error
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'VOH catalog API failed to start.')
  process.exitCode = 1
})