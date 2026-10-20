import type { MonetizationPlan, PlanCode, SubscriptionEntitlementsSnapshot, VideoQuality } from './plans.js'

export type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'suspended' | 'refunded'

export interface SubscriptionRecord {
  planCode: PlanCode
  status: SubscriptionStatus
  startsAt: string
  endsAt: string
  cancelAtPeriodEnd: boolean
  entitlementsSnapshot?: SubscriptionEntitlementsSnapshot
}

export interface RentalRecord {
  catalogEntryId: string
  status: 'active' | 'expired' | 'refunded' | 'revoked'
  startsAt: string
  endsAt: string
}

export interface AccountEntitlements {
  planCode: PlanCode
  subscriptionStatus: SubscriptionStatus | 'none'
  active: boolean
  startsAt: string | null
  endsAt: string | null
  renewalRequired: boolean
  features: string[]
  qualities: VideoQuality[]
  maxConcurrentStreams: number | null
  maxWatchlistEntries: number | null
  advertisingEligible: boolean
  rentalCatalogEntryIds: string[]
}

export function resolveAccountEntitlements(
  subscription: SubscriptionRecord | null,
  rentals: RentalRecord[],
  plans: MonetizationPlan[],
  adEligiblePlans: PlanCode[],
  now = new Date(),
): AccountEntitlements {
  const freePlan = plans.find((plan) => plan.code === 'FREE')
  if (!freePlan) throw new Error('FREE plan configuration is required.')

  const plan = subscription ? plans.find((candidate) => candidate.code === subscription.planCode) : undefined
  if (subscription && !plan) throw new Error(`The active subscription references unknown plan ${subscription.planCode}.`)
  const periodValid = subscription !== null &&
    Date.parse(subscription.startsAt) <= now.getTime() &&
    Date.parse(subscription.endsAt) > now.getTime()
  const active = Boolean(
    subscription &&
    periodValid &&
    (subscription.status === 'active' || subscription.status === 'cancelled'),
  )
  const selectedPlan = active && plan ? plan : freePlan
  const featureSnapshot = active ? subscription?.entitlementsSnapshot : undefined
  const renewalRequired = Boolean(
    subscription &&
    (subscription.status === 'past_due' ||
      (periodValid === false && subscription.status !== 'suspended' && subscription.status !== 'refunded') ||
      (active && (subscription.cancelAtPeriodEnd || Date.parse(subscription.endsAt) - now.getTime() <= 7 * 24 * 60 * 60 * 1000))),
  )
  const subscriptionStatus = subscription && periodValid === false &&
    subscription.status !== 'suspended' && subscription.status !== 'refunded'
    ? 'expired'
    : subscription?.status ?? 'none'

  return {
    planCode: selectedPlan.code,
    subscriptionStatus,
    active,
    startsAt: subscription?.startsAt ?? null,
    endsAt: subscription?.endsAt ?? null,
    renewalRequired,
    features: [...(featureSnapshot?.features ?? selectedPlan.features)],
    qualities: [...(featureSnapshot?.qualities ?? selectedPlan.qualities)],
    maxConcurrentStreams: featureSnapshot ? featureSnapshot.maxConcurrentStreams : selectedPlan.maxConcurrentStreams,
    maxWatchlistEntries: featureSnapshot ? featureSnapshot.maxWatchlistEntries : selectedPlan.maxWatchlistEntries,
    advertisingEligible: adEligiblePlans.includes(selectedPlan.code),
    rentalCatalogEntryIds: [...new Set(rentals
      .filter((rental) => rental.status === 'active' && Date.parse(rental.startsAt) <= now.getTime() && Date.parse(rental.endsAt) > now.getTime())
      .map((rental) => rental.catalogEntryId))],
  }
}
