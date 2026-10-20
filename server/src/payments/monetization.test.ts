import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogEntry, Movie } from '../../../src/features/catalog/catalog.models.js'
import type { CatalogApiRepository } from '../catalog/repository.js'
import { resolveAccountEntitlements } from '../monetization/entitlements.js'
import { isPlanPurchasable, readMonetizationConfig, VIDEO_QUALITIES } from '../monetization/plans.js'
import type { BillingRepository, NewPayment, PaymentRecord, SettlementResult } from './repository.js'
import { BillingRequestError, BillingService } from './service.js'
import type { InitializePaymentInput, PaymentProvider, ProviderCheckout, ProviderWebhookEvent, VerifiedProviderPayment } from './provider.js'
import { PaymentConfigurationError, PaymentProviderError } from './provider.js'
import { PaystackProvider } from './paystack.provider.js'

const current = new Date('2026-01-01T00:00:00.000Z')

function configuredPlans() {
  return readMonetizationConfig({
    PLAN_MEDIUM_PRICE_MINOR: '2500',
    PLAN_MEDIUM_CURRENCY: 'NGN',
    PLAN_MEDIUM_BILLING_INTERVAL: 'monthly',
    PLAN_MEDIUM_VIDEO_QUALITIES: VIDEO_QUALITIES.join(','),
    PLAN_PRO_PRICE_MINOR: '7500',
    PLAN_PRO_CURRENCY: 'NGN',
    PLAN_PRO_BILLING_INTERVAL: 'annual',
    PLAN_PRO_VIDEO_QUALITIES: '1080P,HD,4K',
    PAYSTACK_SECRET_KEY: 'test_secret_only_for_unit_tests',
    PUBLIC_APP_URL: 'https://movies.example.test',
  })
}

function configuredRentalPlans() {
  return readMonetizationConfig({
    PLAN_MEDIUM_PRICE_MINOR: '2500',
    PLAN_MEDIUM_CURRENCY: 'NGN',
    PLAN_MEDIUM_BILLING_INTERVAL: 'monthly',
    PLAN_PRO_PRICE_MINOR: '7500',
    PLAN_PRO_CURRENCY: 'NGN',
    PLAN_PRO_BILLING_INTERVAL: 'annual',
    PUBLIC_APP_URL: 'https://movies.example.test',
    RENTAL_PRICE_MINOR: '500',
    RENTAL_CURRENCY: 'NGN',
    RENTAL_ACCESS_HOURS: '48',
  })
}

function movie(): Movie {
  return {
    id: 'rentable-film',
    kind: 'film',
    publicationStatus: 'published',
    title: 'Rental test film',
    synopsis: 'A test film with current worldwide rights.',
    durationMinutes: 90,
    genres: [],
    actors: [],
    characters: [],
    distributionRights: [{
      id: 'right-1',
      territoryCodes: ['WORLDWIDE'],
      startsAt: '2025-01-01T00:00:00.000Z',
      platforms: ['web'],
      streamingAllowed: true,
      downloadAllowed: false,
    }],
  }
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1',
    accountId: 'verified-subject',
    provider: 'paystack',
    reference: 'voh_payment_1234',
    idempotencyKey: 'checkout-key-1234',
    purpose: 'subscription',
    amountMinor: 2500,
    currency: 'NGN',
    planCode: 'MEDIUM',
    billingInterval: 'monthly',
    status: 'checkout_ready',
    fulfillmentStatus: 'pending',
    entitlementsSnapshot: { features: [], qualities: [], maxConcurrentStreams: null, maxWatchlistEntries: null },
    authorizationUrl: 'https://checkout.paystack.com/access-code',
    providerTransactionId: null,
    ...overrides,
  }
}

function verified(overrides: Partial<VerifiedProviderPayment> = {}): VerifiedProviderPayment {
  return {
    reference: 'voh_payment_1234',
    status: 'success',
    amountMinor: 2500,
    currency: 'NGN',
    providerTransactionId: 'provider-transaction-1',
    paidAt: current.toISOString(),
    ...overrides,
  }
}

class FakeBillingRepository implements BillingRepository {
  readonly payments = new Map<string, PaymentRecord>()
  readonly webhookEvents = new Set<string>()
  readonly reconciliations: Array<{ outcome: string; detailsCode: string }> = []
  readonly settlePayment = vi.fn(async (record: PaymentRecord, result: VerifiedProviderPayment): Promise<SettlementResult> => {
    const existing = this.payments.get(record.reference) ?? record
    if (existing.status === 'succeeded') {
      return { duplicate: true, status: existing.status, fulfillmentStatus: existing.fulfillmentStatus }
    }
    if (result.status === 'failed') {
      const failed = { ...existing, status: 'failed' as const, fulfillmentStatus: 'not_applicable' as const }
      this.payments.set(record.reference, failed)
      return { duplicate: false, status: failed.status, fulfillmentStatus: failed.fulfillmentStatus }
    }
    const succeeded = { ...existing, status: 'succeeded' as const, fulfillmentStatus: 'granted' as const }
    this.payments.set(record.reference, succeeded)
    return { duplicate: false, status: succeeded.status, fulfillmentStatus: succeeded.fulfillmentStatus }
  })
  readonly createPendingPayment = vi.fn(async (newPayment: NewPayment) => {
    const record = payment({
      ...newPayment,
      status: 'pending',
      authorizationUrl: null,
      providerTransactionId: null,
      fulfillmentStatus: 'pending',
    })
    this.payments.set(record.reference, record)
    return { payment: record, created: true }
  })
  readonly markCheckoutReady = vi.fn(async () => {})
  readonly markInitializationFailed = vi.fn(async () => {})
  readonly findPayment = vi.fn(async (reference: string, accountId?: string) => {
    const found = this.payments.get(reference) ?? (reference === 'voh_payment_1234' ? payment() : null)
    return found && (!accountId || found.accountId === accountId) ? found : null
  })
  readonly recordWebhook = vi.fn(async (_provider: string, eventKey: string) => {
    if (this.webhookEvents.has(eventKey)) return false
    this.webhookEvents.add(eventKey)
    return true
  })
  readonly finishWebhook = vi.fn(async () => {})
  readonly getAccountBillingState = vi.fn(async () => ({ subscription: null, rentals: [] }))
  readonly scheduleSubscriptionCancellation = vi.fn(async () => true)
  readonly recordReconciliation = vi.fn(async (_paymentId, outcome, detailsCode) => {
    this.reconciliations.push({ outcome, detailsCode })
  })

  async markCheckoutReadyForTest(reference: string, authorizationUrl: string) {
    const existing = this.payments.get(reference)
    if (existing) this.payments.set(reference, { ...existing, status: 'checkout_ready', authorizationUrl })
  }
}

class FakePaymentProvider implements PaymentProvider {
  readonly code = 'paystack'
  configured = true
  initializeResult: ProviderCheckout = { authorizationUrl: 'https://checkout.paystack.com/access-code', reference: 'voh_payment_1234' }
  verifyResult = verified()
  webhookValid = true
  webhook: ProviderWebhookEvent | null = { event: 'charge.success', reference: 'voh_payment_1234' }
  readonly initialize = vi.fn(async (_input: InitializePaymentInput) => this.initializeResult)
  readonly verify = vi.fn(async (_reference: string) => this.verifyResult)
  readonly verifyWebhookSignature = vi.fn((_rawBody: Buffer, _signature: string | undefined) => this.webhookValid)
  readonly parseWebhook = vi.fn((_rawBody: Buffer) => this.webhook)
}

const catalog = {
  listPublic: vi.fn(async () => []),
  getPublic: vi.fn(async (id: string) => id === 'rentable-film' ? movie() as CatalogEntry : null),
  listAdmin: vi.fn(async () => []),
  getAdmin: vi.fn(async () => null),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  close: vi.fn(async () => {}),
} satisfies CatalogApiRepository

function service(
  repository = new FakeBillingRepository(),
  provider: PaymentProvider | undefined = new FakePaymentProvider(),
  config = configuredPlans(),
) {
  return { billing: new BillingService(config, provider, repository, catalog, true), repository, provider }
}

describe('centralized monetization plan configuration', () => {
  it('keeps paid prices disabled until pricing and billing interval are all configured', () => {
    const config = readMonetizationConfig({})
    expect(config.plans.map((plan) => plan.code)).toEqual(['FREE', 'MEDIUM', 'PRO'])
    expect(config.plans[0]).toMatchObject({ priceMinor: 0, currency: null, billingInterval: null })
    expect(isPlanPurchasable(config.plans[0])).toBe(false)
    expect(isPlanPurchasable(config.plans[1])).toBe(false)
    expect(() => readMonetizationConfig({ PLAN_MEDIUM_PRICE_MINOR: '1234' })).toThrow(/must be configured together/)
  })

  it('supports the configured quality options without hard-coding plan access', () => {
    const config = configuredPlans()
    expect(config.plans.find((plan) => plan.code === 'MEDIUM')?.qualities).toEqual([...VIDEO_QUALITIES])
    expect(config.plans.find((plan) => plan.code === 'PRO')?.qualities).toEqual(['1080p', 'HD', '4K'])
    expect(() => readMonetizationConfig({ PLAN_FREE_VIDEO_QUALITIES: '8K' })).toThrow(/may contain only/)
  })

  it('requires HTTPS for public payment callbacks and bounds database integer settings', () => {
    expect(() => readMonetizationConfig({ PUBLIC_APP_URL: 'http://movies.example.test' })).toThrow(/must use HTTPS/)
    expect(readMonetizationConfig({ PUBLIC_APP_URL: 'http://localhost:5173' }).publicAppUrl).toBe('http://localhost:5173')
    expect(() => readMonetizationConfig({ PLAN_MEDIUM_MAX_CONCURRENT_STREAMS: '2147483648' })).toThrow(/between/)
    expect(() => readMonetizationConfig({ RENTAL_PRICE_MINOR: '500', RENTAL_CURRENCY: 'NGN', RENTAL_ACCESS_HOURS: '8761' })).toThrow(/between/)
  })
})

describe('server-authoritative entitlements', () => {
  it('uses FREE for expired, pending, suspended, or refunded subscriptions', () => {
    const plans = configuredPlans()
    for (const status of ['pending', 'suspended', 'refunded'] as const) {
      expect(resolveAccountEntitlements({
        planCode: 'PRO',
        status,
        startsAt: '2025-01-01T00:00:00.000Z',
        endsAt: '2027-01-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      }, [], plans.plans, plans.adEligiblePlans, current)).toMatchObject({ planCode: 'FREE', active: false })
    }
    expect(resolveAccountEntitlements({
      planCode: 'PRO',
      status: 'active',
      startsAt: '2025-01-01T00:00:00.000Z',
      endsAt: '2025-12-31T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    }, [], plans.plans, plans.adEligiblePlans, current)).toMatchObject({ planCode: 'FREE', active: false, subscriptionStatus: 'expired', renewalRequired: true })
  })

  it('keeps cancelled subscriptions active only through their paid period and expires rentals independently', () => {
    const plans = configuredPlans()
    const result = resolveAccountEntitlements({
      planCode: 'MEDIUM',
      status: 'cancelled',
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2026-02-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    }, [
      { catalogEntryId: 'active-rental', status: 'active', startsAt: '2025-12-31T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' },
      { catalogEntryId: 'expired-rental', status: 'active', startsAt: '2025-12-01T00:00:00.000Z', endsAt: '2025-12-31T00:00:00.000Z' },
      { catalogEntryId: 'revoked-rental', status: 'revoked', startsAt: '2025-12-31T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' },
    ], plans.plans, plans.adEligiblePlans, current)
    expect(result).toMatchObject({
      planCode: 'MEDIUM',
      subscriptionStatus: 'cancelled',
      active: true,
      renewalRequired: true,
      rentalCatalogEntryIds: ['active-rental'],
    })
  })
})

describe('Paystack provider adapter', () => {
  it('initializes hosted checkout with server amount, currency, reference, callback, and metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: true,
      data: { authorization_url: 'https://checkout.paystack.com/hosted-code', reference: 'ref-12345678' },
    }), { status: 200 }))
    const provider = new PaystackProvider({ secretKey: 'sk_test_only_for_test', fetcher })
    await expect(provider.initialize({
      email: 'verified@example.test',
      amountMinor: 2500,
      currency: 'NGN',
      reference: 'ref-12345678',
      callbackUrl: 'https://movies.example.test/plans?payment=return',
      metadata: { payment_id: 'payment-id', purpose: 'subscription' },
    })).resolves.toEqual({ authorizationUrl: 'https://checkout.paystack.com/hosted-code', reference: 'ref-12345678' })
    expect(fetcher).toHaveBeenCalledWith('https://api.paystack.co/transaction/initialize', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk_test_only_for_test' }),
    }))
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ amount: 2500, currency: 'NGN', reference: 'ref-12345678' })
  })

  it('verifies amount, currency, reference, and payment status from the provider response', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: true,
      data: {
        status: 'success',
        reference: 'ref-12345678',
        amount: 2500,
        currency: 'NGN',
        id: 77,
        paid_at: '2026-01-01T00:00:00.000Z',
      },
    }), { status: 200 }))
    const provider = new PaystackProvider({ secretKey: 'sk_test_only_for_test', fetcher })
    await expect(provider.verify('ref-12345678')).resolves.toMatchObject({
      reference: 'ref-12345678',
      status: 'success',
      amountMinor: 2500,
      currency: 'NGN',
      providerTransactionId: '77',
    })
    await expect(provider.verify('invalid/reference')).rejects.toThrow(/reference is invalid/)
  })

  it('rejects missing secrets, failed provider calls, and invalid webhook signatures', async () => {
    const unconfigured = new PaystackProvider()
    expect(unconfigured.configured).toBe(false)
    await expect(unconfigured.verify('ref-12345678')).rejects.toBeInstanceOf(PaymentConfigurationError)

    const failing = new PaystackProvider({ secretKey: 'test', fetcher: vi.fn(async () => new Response('', { status: 503 })) })
    await expect(failing.verify('ref-12345678')).rejects.toBeInstanceOf(PaymentProviderError)

    const provider = new PaystackProvider({ secretKey: 'webhook-test-secret' })
    const raw = Buffer.from('{"event":"charge.success","data":{"reference":"ref-12345678"}}')
    const signature = createHmac('sha512', 'webhook-test-secret').update(raw).digest('hex')
    expect(provider.verifyWebhookSignature(raw, signature)).toBe(true)
    expect(provider.verifyWebhookSignature(raw, `${signature.slice(0, -1)}0`)).toBe(false)
  })
})

describe('billing service payment validation and idempotence', () => {
  it('does not start checkout without provider configuration or trusted verified email', async () => {
    const unconfiguredProvider = new FakePaymentProvider()
    unconfiguredProvider.configured = false
    const noProvider = service(new FakeBillingRepository(), unconfiguredProvider)
    await expect(noProvider.billing.startSubscriptionCheckout('subject', 'user@example.test', 'MEDIUM', 'key-12345678')).rejects.toBeInstanceOf(PaymentConfigurationError)
    expect(noProvider.repository.createPendingPayment).not.toHaveBeenCalled()

    const { billing, repository } = service()
    await expect(billing.startSubscriptionCheckout('subject', undefined, 'MEDIUM', 'key-12345678')).rejects.toMatchObject({
      statusCode: 403,
      code: 'verified_email_required',
    })
    expect(repository.createPendingPayment).not.toHaveBeenCalled()
  })

  it('initializes a checkout using only the server-selected plan terms', async () => {
    const repository = new FakeBillingRepository()
    const provider = new FakePaymentProvider()
    provider.initialize.mockImplementation(async (input) => ({
      authorizationUrl: 'https://checkout.paystack.com/provider-checkout',
      reference: input.reference,
    }))
    const { billing } = service(repository, provider)
    const result = await billing.startSubscriptionCheckout('verified-subject', 'verified@example.test', 'MEDIUM', 'checkout-key-1234')
    expect(result).toMatchObject({ status: 'ready', authorizationUrl: 'https://checkout.paystack.com/provider-checkout', reused: false })
    expect(repository.createPendingPayment).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'verified-subject',
      amountMinor: 2500,
      currency: 'NGN',
      planCode: 'MEDIUM',
      billingInterval: 'monthly',
    }))
    expect(provider.initialize).toHaveBeenCalledWith(expect.objectContaining({
      email: 'verified@example.test',
      amountMinor: 2500,
      currency: 'NGN',
      callbackUrl: 'https://movies.example.test/plans?payment=return',
    }))
  })

  it('keeps a failed checkout initialization from producing a successful payment result', async () => {
    const repository = new FakeBillingRepository()
    const provider = new FakePaymentProvider()
    provider.initialize.mockRejectedValueOnce(new PaymentProviderError('Provider unavailable'))
    const { billing } = service(repository, provider)
    await expect(billing.startSubscriptionCheckout('verified-subject', 'verified@example.test', 'MEDIUM', 'checkout-key-1234')).rejects.toMatchObject({
      statusCode: 502,
      code: 'provider_unavailable',
    })
    expect(repository.markInitializationFailed).toHaveBeenCalledOnce()
  })

  it('rejects invalid references and prevents incorrect amount or currency from creating entitlements', async () => {
    const { billing, repository, provider } = service()
    await expect(billing.verifyForAccount('verified-subject', '../bad')).rejects.toMatchObject({ statusCode: 400 })
    for (const mismatch of [
      { amountMinor: 1 },
      { currency: 'USD' },
      { reference: 'other-reference' },
    ]) {
      (provider as FakePaymentProvider).verifyResult = verified(mismatch)
      await expect(billing.verifyForAccount('verified-subject', 'voh_payment_1234')).rejects.toMatchObject({
        statusCode: 409,
        code: 'payment_mismatch',
      })
    }
    expect(repository.settlePayment).not.toHaveBeenCalled()
    expect(repository.recordReconciliation).toHaveBeenCalledTimes(3)
  })

  it('does not trust provider return or webhook body status, and settles each verified payment once', async () => {
    const { billing, repository, provider } = service()
    const first = await billing.verifyForAccount('verified-subject', 'voh_payment_1234')
    const second = await billing.verifyForAccount('verified-subject', 'voh_payment_1234')
    expect(first).toMatchObject({ status: 'succeeded', entitlementGranted: true })
    expect(second).toMatchObject({ status: 'succeeded', entitlementGranted: true })
    expect(repository.settlePayment).toHaveBeenCalledTimes(2)

    const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"voh_payment_1234","status":"success"}}')
    ;(provider as FakePaymentProvider).webhookValid = false
    await expect(billing.processWebhook(rawBody, 'invalid')).rejects.toMatchObject({ code: 'invalid_webhook_signature' })
    expect(provider.verify).toHaveBeenCalledTimes(2)
  })

  it('verifies signed webhook transactions with Paystack and records duplicate events only once', async () => {
    const { billing, repository, provider } = service()
    const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"voh_payment_1234","status":"success"}}')
    const first = await billing.processWebhook(rawBody, 'test-signature')
    const duplicate = await billing.processWebhook(rawBody, 'test-signature')
    expect(first).toBe('processed')
    expect(duplicate).toBe('duplicate')
    expect(provider.verify).toHaveBeenCalledTimes(1)
    expect(repository.finishWebhook).toHaveBeenCalledWith('paystack', expect.any(String), 'processed')
  })

  it('does not allow rental checkout for unpublished or unavailable catalog entries', async () => {
    const { billing } = service()
    const unavailableCatalog = { ...catalog, getPublic: vi.fn(async () => null) } satisfies CatalogApiRepository
    const serviceWithoutRights = new BillingService(configuredRentalPlans(), new FakePaymentProvider(), new FakeBillingRepository(), unavailableCatalog, true)
    await expect(serviceWithoutRights.startRentalCheckout('subject', 'user@example.test', 'draft-film', 'rental-key-12345')).rejects.toMatchObject({
      statusCode: 404,
      code: 'rental_unavailable',
    })
    await expect(billing.startRentalCheckout('subject', 'user@example.test', 'rentable-film', 'rental-key-12345')).rejects.toMatchObject({
      statusCode: 503,
    })
  })
})
