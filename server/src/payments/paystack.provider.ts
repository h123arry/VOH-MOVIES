import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { InitializePaymentInput, PaymentProvider, ProviderCheckout, ProviderWebhookEvent, VerifiedProviderPayment } from './provider.js'
import { PaymentConfigurationError, PaymentProviderError } from './provider.js'

const InitializeResponseSchema = z.object({
  status: z.literal(true),
  data: z.object({
    authorization_url: z.string().url(),
    reference: z.string().min(1),
  }),
})

const VerifyResponseSchema = z.object({
  status: z.literal(true),
  data: z.object({
    status: z.string(),
    reference: z.string().min(1),
    amount: z.number().int().nonnegative(),
    currency: z.string().length(3),
    id: z.union([z.number().int(), z.string()]),
    paid_at: z.string().datetime({ offset: true }).nullable().optional(),
  }),
})

const WebhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    reference: z.string().min(1),
  }),
})

export interface PaystackProviderOptions {
  secretKey?: string
  apiBaseUrl?: string
  fetcher?: typeof fetch
}

export class PaystackProvider implements PaymentProvider {
  readonly code = 'paystack'
  private readonly apiBaseUrl: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: PaystackProviderOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.paystack.co').replace(/\/+$/, '')
    this.fetcher = options.fetcher ?? fetch
  }

  get configured(): boolean {
    return Boolean(this.options.secretKey?.trim())
  }

  async initialize(input: InitializePaymentInput): Promise<ProviderCheckout> {
    const response = await this.request('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    })
    const parsed = InitializeResponseSchema.safeParse(response)
    if (!parsed.success || parsed.data.data.reference !== input.reference) {
      throw new PaymentProviderError('Paystack returned an invalid checkout initialization response.')
    }
    return { authorizationUrl: parsed.data.data.authorization_url, reference: parsed.data.data.reference }
  }

  async verify(reference: string): Promise<VerifiedProviderPayment> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(reference)) throw new PaymentProviderError('Payment reference is invalid.')
    const response = await this.request(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' })
    const parsed = VerifyResponseSchema.safeParse(response)
    if (!parsed.success) throw new PaymentProviderError('Paystack returned an invalid transaction verification response.')
    const transaction = parsed.data.data
    return {
      reference: transaction.reference,
      status: transaction.status === 'success' ? 'success' : transaction.status === 'failed' ? 'failed' : 'pending',
      amountMinor: transaction.amount,
      currency: transaction.currency.toUpperCase(),
      providerTransactionId: String(transaction.id),
      paidAt: transaction.paid_at ?? null,
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !/^[a-fA-F0-9]{128}$/.test(signature) || !this.options.secretKey) return false
    const expected = createHmac('sha512', this.options.secretKey).update(rawBody).digest()
    const supplied = Buffer.from(signature, 'hex')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  parseWebhook(rawBody: Buffer): ProviderWebhookEvent | null {
    try {
      const parsed = WebhookSchema.safeParse(JSON.parse(rawBody.toString('utf8')))
      if (!parsed.success) return null
      return { event: parsed.data.event, reference: parsed.data.data.reference }
    } catch {
      return null
    }
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    if (!this.options.secretKey?.trim()) throw new PaymentConfigurationError('Paystack is not configured on the server.')
    let response: Response
    try {
      response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new PaymentProviderError('Paystack could not be reached.')
    }
    if (!response.ok) throw new PaymentProviderError(`Paystack request failed (${response.status}).`)
    try {
      return await response.json()
    } catch {
      throw new PaymentProviderError('Paystack returned invalid JSON.')
    }
  }
}
