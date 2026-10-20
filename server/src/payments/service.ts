import { createHash, randomUUID } from 'node:crypto'
import type { CatalogApiRepository } from '../catalog/repository.js'
import { resolveAccountEntitlements, type AccountEntitlements } from '../monetization/entitlements.js'
import { isPlanPurchasable, type MonetizationConfig, type PlanCode } from '../monetization/plans.js'
import type { BillingRepository, NewPayment, PaymentRecord } from './repository.js'
import type { PaymentProvider, VerifiedProviderPayment } from './provider.js'
import { PaymentConfigurationError, PaymentProviderError } from './provider.js'

export type CheckoutResult =
  | { status: 'ready'; authorizationUrl: string; reference: string; reused: boolean }
  | { status: 'pending'; reference: string }

export class BillingRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
    this.name = 'BillingRequestError'
  }
}

export class BillingService {
  constructor(
    private readonly config: MonetizationConfig,
    private readonly provider: PaymentProvider | undefined,
    private readonly repository: BillingRepository,
    private readonly catalog: CatalogApiRepository,
    private readonly accountAuthenticationConfigured = false,
  ) {}

  listPlans() {
    return {
      plans: this.config.plans.map((plan) => ({
        ...plan,
        purchasable: isPlanPurchasable(plan) && Boolean(this.provider?.configured && this.config.publicAppUrl && this.accountAuthenticationConfigured),
      })),
      rentalsAvailable: this.config.rentalPriceMinor !== null &&
        this.config.rentalCurrency !== null &&
        this.config.rentalAccessHours !== null &&
        Boolean(this.provider?.configured && this.config.publicAppUrl && this.accountAuthenticationConfigured),
    }
  }

  async startSubscriptionCheckout(accountId: string, email: string | undefined, planCode: PlanCode, idempotencyKey: string): Promise<CheckoutResult> {
    const plan = this.config.plans.find((candidate) => candidate.code === planCode)
    if (!plan || plan.code === 'FREE') throw new BillingRequestError(400, 'invalid_plan', 'Choose a paid subscription plan.')
    if (!isPlanPurchasable(plan)) throw new BillingRequestError(503, 'plan_not_configured', 'Pricing and billing interval are not configured for this plan.')
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BillingRequestError(403, 'verified_email_required', 'A verified email address from the trusted identity provider is required.')
    }
    if ((await this.getEntitlements(accountId)).active) {
      throw new BillingRequestError(409, 'subscription_already_active', 'An active subscription is already associated with this account.')
    }
    return this.startCheckout(accountId, email, {
      purpose: 'subscription',
      amountMinor: plan.priceMinor!,
      currency: plan.currency!,
      planCode: plan.code,
      billingInterval: plan.billingInterval!,
      entitlementsSnapshot: {
        features: [...plan.features],
        qualities: [...plan.qualities],
        maxConcurrentStreams: plan.maxConcurrentStreams,
        maxWatchlistEntries: plan.maxWatchlistEntries,
      },
    }, idempotencyKey)
  }

  async startRentalCheckout(accountId: string, email: string | undefined, catalogEntryId: string, idempotencyKey: string): Promise<CheckoutResult> {
    if (this.config.rentalPriceMinor === null || this.config.rentalCurrency === null || this.config.rentalAccessHours === null) {
      throw new BillingRequestError(503, 'rentals_not_configured', 'Movie rentals are not configured.')
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BillingRequestError(403, 'verified_email_required', 'A verified email address from the trusted identity provider is required.')
    }
    const entry = await this.catalog.getPublic(catalogEntryId)
    if (!entry || entry.kind !== 'film') {
      throw new BillingRequestError(404, 'rental_unavailable', 'This film is not currently available for rental.')
    }
    return this.startCheckout(accountId, email, {
      purpose: 'rental',
      amountMinor: this.config.rentalPriceMinor,
      currency: this.config.rentalCurrency,
      catalogEntryId,
      rentalAccessHours: this.config.rentalAccessHours,
    }, idempotencyKey)
  }

  async verifyForAccount(accountId: string, reference: string): Promise<{ status: 'pending' | 'failed' | 'succeeded'; entitlementGranted: boolean }> {
    if (!this.provider?.configured) throw new PaymentConfigurationError('Payment provider is not configured.')
    if (!validReference(reference)) throw new BillingRequestError(400, 'invalid_reference', 'Payment reference is invalid.')
    const payment = await this.repository.findPayment(reference, accountId)
    if (!payment) throw new BillingRequestError(404, 'payment_not_found', 'Payment was not found.')
    let verified: VerifiedProviderPayment
    try {
      verified = await this.provider.verify(reference)
    } catch (error) {
      await this.repository.recordReconciliation(payment.id, 'provider_unavailable', 'provider_verification_failed')
      throw error
    }
    return this.applyVerifiedResult(payment, verified)
  }

  async processWebhook(rawBody: Buffer, signature: string | undefined): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (!this.provider?.configured) throw new PaymentConfigurationError('Payment provider is not configured.')
    if (!this.provider.verifyWebhookSignature(rawBody, signature)) {
      throw new BillingRequestError(401, 'invalid_webhook_signature', 'Payment provider signature is invalid.')
    }
    const event = this.provider.parseWebhook(rawBody)
    if (!event) throw new BillingRequestError(400, 'invalid_webhook', 'Payment provider event is invalid.')
    const bodyDigest = createHash('sha256').update(rawBody).digest('hex')
    const eventKey = bodyDigest
    const accepted = await this.repository.recordWebhook(this.provider.code, eventKey, event.event, event.reference, bodyDigest)
    if (!accepted) return 'duplicate'

    if (event.event !== 'charge.success') {
      await this.repository.finishWebhook(this.provider.code, eventKey, 'ignored')
      return 'ignored'
    }

    try {
      const payment = await this.repository.findPayment(event.reference)
      if (!payment || payment.provider !== this.provider.code) {
        await this.repository.finishWebhook(this.provider.code, eventKey, 'failed', 'payment_not_found')
        return 'ignored'
      }
      const verified = await this.provider.verify(event.reference)
      await this.applyVerifiedResult(payment, verified)
      await this.repository.finishWebhook(this.provider.code, eventKey, 'processed')
      return 'processed'
    } catch (error) {
      await this.repository.finishWebhook(this.provider.code, eventKey, 'failed', error instanceof BillingRequestError ? error.code : 'verification_failed')
      throw error
    }
  }

  async getEntitlements(accountId: string, now = new Date()): Promise<AccountEntitlements> {
    const state = await this.repository.getAccountBillingState(accountId, now)
    return resolveAccountEntitlements(state.subscription, state.rentals, this.config.plans, this.config.adEligiblePlans, now)
  }

  async cancelSubscription(accountId: string): Promise<{ status: 'cancelled' }> {
    const changed = await this.repository.scheduleSubscriptionCancellation(accountId)
    if (!changed) throw new BillingRequestError(404, 'active_subscription_not_found', 'No active subscription is available to cancel.')
    return { status: 'cancelled' }
  }

  async close(): Promise<void> {
    await this.repository.close?.()
  }

  private async startCheckout(
    accountId: string,
    email: string,
    pricing: Pick<NewPayment, 'purpose' | 'amountMinor' | 'currency' | 'planCode' | 'billingInterval' | 'catalogEntryId' | 'rentalAccessHours' | 'entitlementsSnapshot'>,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    if (!this.provider?.configured) throw new PaymentConfigurationError('Payment provider is not configured.')
    if (!this.config.publicAppUrl) throw new PaymentConfigurationError('PUBLIC_APP_URL is required for hosted payment checkout.')
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new BillingRequestError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8 to 128 safe characters.')
    }
    const payment: NewPayment = {
      id: randomUUID(),
      accountId,
      provider: this.provider.code,
      reference: `voh_${randomUUID().replaceAll('-', '')}`,
      idempotencyKey,
      ...pricing,
    }
    const result = await this.repository.createPendingPayment(payment)
    if (!result.created) {
      if (
        result.payment.purpose !== payment.purpose ||
        result.payment.amountMinor !== payment.amountMinor ||
        result.payment.currency !== payment.currency ||
        result.payment.planCode !== payment.planCode ||
        result.payment.billingInterval !== payment.billingInterval ||
        result.payment.catalogEntryId !== payment.catalogEntryId ||
        result.payment.rentalAccessHours !== payment.rentalAccessHours ||
        JSON.stringify(result.payment.entitlementsSnapshot) !== JSON.stringify(payment.entitlementsSnapshot ?? {})
      ) {
        throw new BillingRequestError(409, 'idempotency_key_reused', 'This idempotency key was already used for a different checkout.')
      }
      if (result.payment.status === 'checkout_ready' && result.payment.authorizationUrl) {
        return { status: 'ready', authorizationUrl: result.payment.authorizationUrl, reference: result.payment.reference, reused: true }
      }
      if (result.payment.status === 'pending') return { status: 'pending', reference: result.payment.reference }
      throw new BillingRequestError(409, 'idempotency_key_used', 'This idempotency key is already associated with a completed or failed checkout.')
    }

    try {
      const checkout = await this.provider.initialize({
        email,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        reference: payment.reference,
        callbackUrl: `${this.config.publicAppUrl}/plans?payment=return`,
        metadata: { payment_id: payment.id, purpose: payment.purpose },
      })
      if (checkout.reference !== payment.reference || !isProviderCheckoutUrl(checkout.authorizationUrl)) {
        throw new PaymentProviderError('Payment provider returned an unexpected checkout response.')
      }
      await this.repository.markCheckoutReady(payment.id, checkout.authorizationUrl)
      return { status: 'ready', authorizationUrl: checkout.authorizationUrl, reference: payment.reference, reused: false }
    } catch (error) {
      await this.repository.markInitializationFailed(payment.id)
      if (error instanceof PaymentProviderError || error instanceof PaymentConfigurationError) {
        throw new BillingRequestError(502, 'provider_unavailable', error.message)
      }
      throw error
    }
  }

  private async applyVerifiedResult(payment: PaymentRecord, verified: VerifiedProviderPayment): Promise<{ status: 'pending' | 'failed' | 'succeeded'; entitlementGranted: boolean }> {
    if (
      verified.reference !== payment.reference ||
      verified.amountMinor !== payment.amountMinor ||
      verified.currency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      await this.repository.recordReconciliation(payment.id, 'mismatch', 'provider_payment_mismatch')
      throw new BillingRequestError(409, 'payment_mismatch', 'Verified payment does not match the recorded amount, currency, or reference.')
    }
    if (verified.status === 'pending') return { status: 'pending', entitlementGranted: false }
    const settlement = await this.repository.settlePayment(payment, verified)
    if (settlement.status === 'failed') return { status: 'failed', entitlementGranted: false }
    return {
      status: 'succeeded',
      entitlementGranted: settlement.fulfillmentStatus === 'granted',
    }
  }
}

function validReference(reference: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(reference)
}

function isProviderCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.paystack.com'
  } catch {
    return false
  }
}
