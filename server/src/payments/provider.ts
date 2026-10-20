export interface InitializePaymentInput {
  email: string
  amountMinor: number
  currency: string
  reference: string
  callbackUrl: string
  metadata: Record<string, string>
}

export interface ProviderCheckout {
  authorizationUrl: string
  reference: string
}

export interface VerifiedProviderPayment {
  reference: string
  status: 'success' | 'failed' | 'pending'
  amountMinor: number
  currency: string
  providerTransactionId: string
  paidAt: string | null
}

export interface ProviderWebhookEvent {
  event: string
  reference: string
}

export interface PaymentProvider {
  readonly code: string
  readonly configured: boolean
  initialize(input: InitializePaymentInput): Promise<ProviderCheckout>
  verify(reference: string): Promise<VerifiedProviderPayment>
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean
  parseWebhook(rawBody: Buffer): ProviderWebhookEvent | null
}

export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentConfigurationError'
  }
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentProviderError'
  }
}
