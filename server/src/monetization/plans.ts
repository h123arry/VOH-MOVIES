export const VIDEO_QUALITIES = ['180p', '240p', '360p', '480p', '760p', '1080p', 'HD', '4K'] as const
export type VideoQuality = typeof VIDEO_QUALITIES[number]
export type PlanCode = 'FREE' | 'MEDIUM' | 'PRO'
export type BillingInterval = 'monthly' | 'annual'

export interface MonetizationPlan {
  code: PlanCode
  name: string
  priceMinor: number | null
  currency: string | null
  billingInterval: BillingInterval | null
  features: string[]
  qualities: VideoQuality[]
  maxConcurrentStreams: number | null
  maxWatchlistEntries: number | null
}

export interface SubscriptionEntitlementsSnapshot {
  features: string[]
  qualities: VideoQuality[]
  maxConcurrentStreams: number | null
  maxWatchlistEntries: number | null
}

export interface MonetizationConfig {
  plans: MonetizationPlan[]
  adEligiblePlans: PlanCode[]
  rentalPriceMinor: number | null
  rentalCurrency: string | null
  rentalAccessHours: number | null
  publicAppUrl?: string
}

export function readMonetizationConfig(environment: NodeJS.ProcessEnv = process.env): MonetizationConfig {
  const plans = (['FREE', 'MEDIUM', 'PRO'] as const).map((code) => readPlan(environment, code))
  const adEligiblePlans = listValue(environment.AD_SUPPORTED_PLAN_CODES ?? 'FREE', 'AD_SUPPORTED_PLAN_CODES', ['FREE', 'MEDIUM', 'PRO'])
  const rentalPriceMinor = optionalInteger(environment.RENTAL_PRICE_MINOR, 'RENTAL_PRICE_MINOR', 1)
  const rentalCurrency = optionalCurrency(environment.RENTAL_CURRENCY, 'RENTAL_CURRENCY')
  const rentalAccessHours = optionalInteger(environment.RENTAL_ACCESS_HOURS, 'RENTAL_ACCESS_HOURS', 1, 8760)
  if ([rentalPriceMinor, rentalCurrency, rentalAccessHours].some((value) => value !== null) &&
    [rentalPriceMinor, rentalCurrency, rentalAccessHours].some((value) => value === null)) {
    throw new Error('RENTAL_PRICE_MINOR, RENTAL_CURRENCY, and RENTAL_ACCESS_HOURS must be configured together.')
  }

  let publicAppUrl: string | undefined
  const configuredUrl = environment.PUBLIC_APP_URL?.trim()
  if (configuredUrl) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(configuredUrl)
    } catch {
      throw new Error('PUBLIC_APP_URL must be a valid HTTP(S) URL.')
    }
    const localDevelopmentHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      (parsedUrl.protocol !== 'https:' && !localDevelopmentHost) ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new Error('PUBLIC_APP_URL must use HTTPS (HTTP is allowed only for localhost) and must not contain embedded credentials.')
    }
    publicAppUrl = parsedUrl.origin
  }

  return { plans, adEligiblePlans, rentalPriceMinor, rentalCurrency, rentalAccessHours, publicAppUrl }
}

function readPlan(environment: NodeJS.ProcessEnv, code: PlanCode): MonetizationPlan {
  const prefix = `PLAN_${code}`
  const priceMinor = code === 'FREE' ? 0 : optionalInteger(environment[`${prefix}_PRICE_MINOR`], `${prefix}_PRICE_MINOR`, 1)
  const currency = code === 'FREE' ? null : optionalCurrency(environment[`${prefix}_CURRENCY`], `${prefix}_CURRENCY`)
  const intervalValue = code === 'FREE' ? undefined : environment[`${prefix}_BILLING_INTERVAL`]?.trim().toLowerCase()
  const billingInterval = intervalValue === 'monthly' || intervalValue === 'annual' ? intervalValue : null
  if (intervalValue && billingInterval === null) {
    throw new Error(`${prefix}_BILLING_INTERVAL must be monthly or annual.`)
  }
  if (code !== 'FREE' && [priceMinor, currency, billingInterval].some((value) => value !== null) &&
    [priceMinor, currency, billingInterval].some((value) => value === null)) {
    throw new Error(`${prefix}_PRICE_MINOR, ${prefix}_CURRENCY, and ${prefix}_BILLING_INTERVAL must be configured together.`)
  }
  if (code === 'FREE' && priceMinor !== 0) throw new Error('FREE plan price must be zero.')

  return {
    code,
    name: code === 'PRO' ? 'Pro / Premium' : code === 'MEDIUM' ? 'Medium' : 'Free',
    priceMinor,
    currency,
    billingInterval,
    features: listValue(environment[`${prefix}_FEATURES`] ?? '', `${prefix}_FEATURES`),
    qualities: qualityValues(environment[`${prefix}_VIDEO_QUALITIES`] ?? '', `${prefix}_VIDEO_QUALITIES`),
    maxConcurrentStreams: optionalInteger(environment[`${prefix}_MAX_CONCURRENT_STREAMS`], `${prefix}_MAX_CONCURRENT_STREAMS`, 1, 2_147_483_647),
    maxWatchlistEntries: optionalInteger(environment[`${prefix}_MAX_WATCHLIST_ENTRIES`], `${prefix}_MAX_WATCHLIST_ENTRIES`, 0, 2_147_483_647),
  }
}

function optionalInteger(value: string | undefined, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return number
}

function optionalCurrency(value: string | undefined, name: string): string | null {
  if (value === undefined || value.trim() === '') return null
  const currency = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${name} must be a three-letter currency code.`)
  return currency
}

function listValue<T extends string>(
  value: string,
  name: string,
  allowed?: readonly T[],
): T[] {
  const values = value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates.`)
  if (allowed && values.some((item) => !allowed.includes(item as T))) throw new Error(`${name} contains an unsupported value.`)
  return values as T[]
}

function qualityValues(value: string, name: string): VideoQuality[] {
  const rawValues = value.split(',').map((item) => item.trim()).filter(Boolean)
  const normalized = rawValues.map((item) => item.toLowerCase())
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must not contain duplicates.`)
  const values = rawValues.map((item) => VIDEO_QUALITIES.find((quality) => quality.toLowerCase() === item.toLowerCase()))
  if (values.some((item) => item === undefined)) {
    throw new Error(`${name} may contain only ${VIDEO_QUALITIES.join(', ')}.`)
  }
  return values.filter((item): item is VideoQuality => item !== undefined)
}

export function isPlanPurchasable(plan: MonetizationPlan): boolean {
  return plan.code !== 'FREE' &&
    plan.priceMinor !== null &&
    plan.currency !== null &&
    plan.billingInterval !== null
}
