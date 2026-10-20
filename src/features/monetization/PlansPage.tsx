import { useEffect, useState } from 'react'
import { ArrowRight, Check, Shield } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { catalogConfig } from '../catalog/catalog.config'

interface PlanView {
  code: 'FREE' | 'MEDIUM' | 'PRO'
  name: string
  priceMinor: number | null
  currency: string | null
  billingInterval: 'monthly' | 'annual' | null
  features: string[]
  qualities: string[]
  maxConcurrentStreams: number | null
  maxWatchlistEntries: number | null
  purchasable: boolean
}

interface PlansResponse {
  plans: PlanView[]
  rentalsAvailable: boolean
}

interface EntitlementsResponse {
  entitlements: {
    planCode: string
    subscriptionStatus: string
    active: boolean
    startsAt: string | null
    endsAt: string | null
    renewalRequired: boolean
    qualities: string[]
    features: string[]
    rentalCatalogEntryIds: string[]
    advertisingEligible: boolean
  }
}

type PageState = { status: 'loading' } | { status: 'ready'; data: PlansResponse } | { status: 'error'; message: string }
type PaymentState = { status: 'idle' } | { status: 'pending'; message: string } | { status: 'error'; message: string } | { status: 'verified'; message: string }

export function PlansPage() {
  const [searchParams] = useSearchParams()
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const [payment, setPayment] = useState<PaymentState>({ status: 'idle' })
  const [checkoutBusy, setCheckoutBusy] = useState(false)

  useEffect(() => {
    const apiBaseUrl = catalogConfig.apiBaseUrl
    if (!apiBaseUrl) {
      setPage({ status: 'error', message: 'Configure VITE_API_BASE_URL to view server-controlled plan availability.' })
      return
    }
    const controller = new AbortController()
    void fetch(`${apiBaseUrl}/billing/plans`, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response))
        const data = await response.json() as PlansResponse
        if (!Array.isArray(data.plans)) throw new Error('The plan service returned an invalid response.')
        setPage({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPage({ status: 'error', message: error instanceof Error ? error.message : 'Plan information is unavailable.' })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (searchParams.get('payment') !== 'return') return
    const reference = searchParams.get('reference') ?? searchParams.get('trxref')
    if (!reference) {
      setPayment({ status: 'error', message: 'The payment provider returned without a transaction reference. No payment is considered verified.' })
      return
    }
    const apiBaseUrl = catalogConfig.apiBaseUrl
    if (!apiBaseUrl) {
      setPayment({ status: 'error', message: 'The payment cannot be verified because the VOH API is not configured.' })
      return
    }
    const controller = new AbortController()
    setPayment({ status: 'pending', message: 'Confirming the transaction with the VOH API and payment provider…' })
    void fetch(`${apiBaseUrl}/billing/payments/${encodeURIComponent(reference)}/verify`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseMessage(response))
      const result = await response.json() as { status?: string; entitlementGranted?: boolean }
      if (result.status === 'succeeded' && result.entitlementGranted === true) {
        setPayment({ status: 'verified', message: 'Payment and entitlement were verified by the server.' })
      } else if (result.status === 'succeeded') {
        setPayment({ status: 'error', message: 'Payment was verified, but access was not granted. Contact VOH support before retrying.' })
      } else {
        setPayment({ status: 'pending', message: 'Payment is not verified as complete yet. You can retry verification later.' })
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPayment({ status: 'error', message: error instanceof Error ? error.message : 'Payment verification is unavailable.' })
    })
    return () => controller.abort()
  }, [searchParams])

  const startCheckout = async (planCode: PlanView['code']) => {
    if (!catalogConfig.apiBaseUrl) return
    setCheckoutBusy(true)
    setPayment({ status: 'pending', message: 'Creating a verified checkout session…' })
    try {
      const response = await fetch(`${catalogConfig.apiBaseUrl}/billing/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify({ planCode }),
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      const result = await response.json() as { status?: string; authorizationUrl?: string }
      if (result.status !== 'ready' || !isPaystackCheckoutUrl(result.authorizationUrl)) {
        setPayment({ status: 'pending', message: 'Checkout is still being prepared. No payment has been confirmed.' })
        return
      }
      globalThis.location.assign(result.authorizationUrl)
    } catch (error) {
      setPayment({ status: 'error', message: error instanceof Error ? error.message : 'Checkout could not be started.' })
    } finally {
      setCheckoutBusy(false)
    }
  }

  const cancelSubscription = async () => {
    if (!catalogConfig.apiBaseUrl) return
    setCheckoutBusy(true)
    try {
      const response = await fetch(`${catalogConfig.apiBaseUrl}/billing/subscription/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      setPayment({ status: 'pending', message: 'Cancellation is scheduled for the current subscription period end.' })
    } catch (error) {
      setPayment({ status: 'error', message: error instanceof Error ? error.message : 'The subscription could not be cancelled.' })
    } finally {
      setCheckoutBusy(false)
    }
  }

  return (
    <main className="admin-page page-container plans-page">
      <Link className="back-link" to="/">← Back to VOH MOVIES</Link>
      <section className="admin-intro">
        <div className="admin-title-row"><div className="admin-shield"><Shield size={18} /></div><p className="eyebrow">VOH / MEMBERSHIP</p></div>
        <h1>Choose your <em>way in.</em></h1>
        <p className="admin-lede">Plan benefits, prices, and viewing quality are supplied by the VOH server. Availability depends on configured terms, media, bandwidth, and distribution rights.</p>
      </section>

      {payment.status !== 'idle' && <p className={payment.status === 'verified' ? 'studio-success' : payment.status === 'error' ? 'studio-error' : 'admin-notice'} role={payment.status === 'error' ? 'alert' : 'status'}>{payment.message}</p>}
      {page.status === 'loading' && <p className="studio-state" role="status">Loading plan configuration…</p>}
      {page.status === 'error' && <div className="studio-error" role="alert"><p>{page.message}</p></div>}
      {page.status === 'ready' && (
        <>
          <section className="plan-grid" aria-label="Available subscription plans">
            {page.data.plans.map((plan) => (
              <article className="plan-card" key={plan.code}>
                <p className="eyebrow">{plan.code === 'PRO' ? 'PRO / PREMIUM' : plan.code}</p>
                <h2>{plan.name}</h2>
                <p className="plan-price">
                  {plan.code === 'FREE' ? 'Free' : plan.priceMinor !== null && plan.currency
                    ? formatPrice(plan.priceMinor, plan.currency)
                    : 'Pricing not configured'}
                  {plan.billingInterval && <span> / {plan.billingInterval}</span>}
                </p>
                {plan.features.length > 0 || plan.qualities.length > 0 || plan.maxConcurrentStreams !== null || plan.maxWatchlistEntries !== null ? (
                  <ul className="plan-benefits">
                    {plan.features.map((feature) => <li key={feature}><Check size={14} /> {feature}</li>)}
                    {plan.qualities.map((quality) => <li key={quality}><Check size={14} /> {quality} viewing, when available</li>)}
                    {plan.maxConcurrentStreams !== null && <li><Check size={14} /> {plan.maxConcurrentStreams} concurrent streams</li>}
                    {plan.maxWatchlistEntries !== null && <li><Check size={14} /> Watchlist limit: {plan.maxWatchlistEntries}</li>}
                  </ul>
                ) : <p className="studio-state">Plan benefits are not configured.</p>}
                {plan.code === 'FREE'
                  ? <span className="plan-note">No subscription payment required.</span>
                  : <button className="primary-button plan-action" disabled={!plan.purchasable || checkoutBusy} onClick={() => void startCheckout(plan.code)}>
                    {plan.purchasable ? 'Continue to secure checkout' : 'Checkout unavailable'} <ArrowRight size={15} />
                  </button>}
              </article>
            ))}
          </section>

          <AccountStatus onCancel={cancelSubscription} checkoutBusy={checkoutBusy} />
          <p className="admin-footnote">
            {page.data.rentalsAvailable
              ? 'Individual film rentals are configured by the server; the rental checkout requires a signed-in account and current distribution rights.'
              : 'Individual movie rentals are not configured.'}
            {' '}A return from checkout is not proof of payment; the server verifies each transaction before granting access.
          </p>
        </>
      )}
    </main>
  )
}

function AccountStatus({ onCancel, checkoutBusy }: { onCancel: () => void; checkoutBusy: boolean }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: EntitlementsResponse } | { status: 'error'; message: string }>({ status: 'loading' })

  useEffect(() => {
    if (!catalogConfig.apiBaseUrl) {
      setState({ status: 'error', message: 'Account status requires the configured VOH API and a verified sign-in session.' })
      return
    }
    const controller = new AbortController()
    void fetch(`${catalogConfig.apiBaseUrl}/billing/me`, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response))
        const data = await response.json() as EntitlementsResponse
        setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : 'Account status is unavailable.' })
      })
    return () => controller.abort()
  }, [])

  if (state.status === 'loading') return <p className="studio-state" role="status">Checking account status…</p>
  if (state.status === 'error') return <div className="admin-notice" role="status"><p>{state.message}</p></div>
  const entitlements = state.data.entitlements
  return (
    <section className="account-status" aria-labelledby="account-status-title">
      <h2 id="account-status-title">Your access</h2>
      <p>{entitlements.planCode} · {entitlements.subscriptionStatus}{entitlements.endsAt ? ` · through ${new Date(entitlements.endsAt).toLocaleDateString()}` : ''}</p>
      {entitlements.renewalRequired && <p className="studio-state">Renewal or follow-up is required to retain paid access.</p>}
      <p>Viewing qualities: {entitlements.qualities.length ? entitlements.qualities.join(', ') : 'none configured'}</p>
      <p>{entitlements.advertisingEligible ? 'Advertising may be eligible under current server rules; no ad network is connected.' : 'Advertising is not configured for this plan.'}</p>
      {entitlements.rentalCatalogEntryIds.length > 0 && <p>Active film rental entitlements: {entitlements.rentalCatalogEntryIds.length}</p>}
      {entitlements.active && <button className="studio-small-button" disabled={checkoutBusy} onClick={onCancel}>Cancel at period end</button>}
    </section>
  )
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json()
    if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') return value.message
  } catch {
    return `Request failed (${response.status}).`
  }
  return `Request failed (${response.status}).`
}

function isPaystackCheckoutUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.paystack.com'
  } catch {
    return false
  }
}

function formatPrice(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency })
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  return formatter.format(amountMinor / 10 ** digits)
}
