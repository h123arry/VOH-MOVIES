import type { PlanCode, BillingInterval, SubscriptionEntitlementsSnapshot } from '../monetization/plans.js'
import type { RentalRecord, SubscriptionRecord } from '../monetization/entitlements.js'
import type { VerifiedProviderPayment } from './provider.js'

export type PaymentPurpose = 'subscription' | 'rental'
export type PaymentStatus = 'pending' | 'checkout_ready' | 'succeeded' | 'failed' | 'cancelled' | 'refunded' | 'reconciliation_required'

export interface NewPayment {
  id: string
  accountId: string
  provider: string
  reference: string
  idempotencyKey: string
  purpose: PaymentPurpose
  amountMinor: number
  currency: string
  planCode?: PlanCode
  billingInterval?: BillingInterval
  catalogEntryId?: string
  rentalAccessHours?: number
  entitlementsSnapshot?: SubscriptionEntitlementsSnapshot
}

export interface PaymentRecord extends NewPayment {
  status: PaymentStatus
  authorizationUrl: string | null
  providerTransactionId: string | null
  fulfillmentStatus: 'pending' | 'granted' | 'blocked_rights' | 'blocked_policy' | 'not_applicable'
  entitlementsSnapshot: SubscriptionEntitlementsSnapshot
}

export interface AccountBillingState {
  subscription: SubscriptionRecord | null
  rentals: RentalRecord[]
}

export interface SettlementResult {
  duplicate: boolean
  status: PaymentStatus
  fulfillmentStatus: PaymentRecord['fulfillmentStatus']
}

export interface BillingRepository {
  createPendingPayment(payment: NewPayment): Promise<{ payment: PaymentRecord; created: boolean }>
  findPayment(reference: string, accountId?: string): Promise<PaymentRecord | null>
  markCheckoutReady(paymentId: string, authorizationUrl: string): Promise<void>
  markInitializationFailed(paymentId: string): Promise<void>
  settlePayment(payment: PaymentRecord, verified: VerifiedProviderPayment): Promise<SettlementResult>
  recordWebhook(provider: string, eventKey: string, eventName: string, reference: string, bodyDigest: string): Promise<boolean>
  finishWebhook(provider: string, eventKey: string, outcome: 'processed' | 'ignored' | 'failed', errorCode?: string): Promise<void>
  getAccountBillingState(accountId: string, now: Date): Promise<AccountBillingState>
  scheduleSubscriptionCancellation(accountId: string): Promise<boolean>
  recordReconciliation(paymentId: string, outcome: 'matched' | 'mismatch' | 'provider_unavailable' | 'entitlement_blocked', detailsCode: string): Promise<void>
  close?(): Promise<void>
}
