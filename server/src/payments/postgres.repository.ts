import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { Pool as PostgresPool } from 'pg'
import type { MonetizationPlan, PlanCode, SubscriptionEntitlementsSnapshot } from '../monetization/plans.js'
import type { RentalRecord, SubscriptionRecord } from '../monetization/entitlements.js'
import type { AccountBillingState, BillingRepository, NewPayment, PaymentRecord, SettlementResult } from './repository.js'
import type { VerifiedProviderPayment } from './provider.js'

interface PaymentRow {
  id: string
  account_id: string
  provider: string
  provider_reference: string
  idempotency_key: string
  purpose: 'subscription' | 'rental'
  amount_minor: string | number
  currency: string
  entitlements_snapshot: SubscriptionEntitlementsSnapshot
  plan_code: PlanCode | null
  billing_interval: 'monthly' | 'annual' | null
  catalog_entry_id: string | null
  rental_access_hours: number | null
  status: PaymentRecord['status']
  fulfillment_status: PaymentRecord['fulfillmentStatus']
  authorization_url: string | null
  provider_transaction_id: string | null
}

export class PaymentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentConflictError'
  }
}

export class PostgresBillingRepository implements BillingRepository {
  readonly pool: Pool

  constructor(options: { databaseUrl: string; databaseSslMode: 'disable' | 'require' | 'verify-full' }, pool?: Pool) {
    this.pool = pool ?? new PostgresPool({
      connectionString: options.databaseUrl,
      ssl: options.databaseSslMode === 'disable' ? false : { rejectUnauthorized: options.databaseSslMode === 'verify-full' },
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  }

  async syncPlans(plans: MonetizationPlan[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const plan of plans) {
        await client.query(`
          INSERT INTO monetization_plans
            (code, display_name, price_minor, currency, billing_interval, features, video_qualities, max_concurrent_streams, max_watchlist_entries, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,now())
          ON CONFLICT (code) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            price_minor = EXCLUDED.price_minor,
            currency = EXCLUDED.currency,
            billing_interval = EXCLUDED.billing_interval,
            features = EXCLUDED.features,
            video_qualities = EXCLUDED.video_qualities,
            max_concurrent_streams = EXCLUDED.max_concurrent_streams,
            max_watchlist_entries = EXCLUDED.max_watchlist_entries,
            updated_at = now()
        `, [
          plan.code,
          plan.name,
          plan.priceMinor,
          plan.currency,
          plan.billingInterval,
          JSON.stringify(plan.features),
          JSON.stringify(plan.qualities),
          plan.maxConcurrentStreams,
          plan.maxWatchlistEntries,
        ])
      }
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async createPendingPayment(payment: NewPayment): Promise<{ payment: PaymentRecord; created: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [payment.accountId])
      if (payment.purpose === 'subscription') {
        const open = await client.query<PaymentRow>(`
          SELECT * FROM payment_transactions
          WHERE account_id = $1 AND purpose = 'subscription'
            AND status IN ('pending', 'checkout_ready', 'reconciliation_required')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `, [payment.accountId])
        if (open.rows[0]) {
          const existing = toPaymentRecord(open.rows[0])
          if (existing.idempotencyKey !== payment.idempotencyKey) {
            throw new PaymentConflictError('A subscription checkout is already pending for this account.')
          }
          await client.query('COMMIT')
          return { payment: existing, created: false }
        }
      }
      const result = await client.query<PaymentRow>(`
        INSERT INTO payment_transactions
          (id, account_id, provider, provider_reference, idempotency_key, purpose, plan_code, billing_interval, catalog_entry_id, amount_minor, currency, status, fulfillment_status, rental_access_hours, entitlements_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','pending',$12,$13::jsonb)
        ON CONFLICT (account_id, idempotency_key) DO NOTHING
        RETURNING *
      `, [
        payment.id,
        payment.accountId,
        payment.provider,
        payment.reference,
        payment.idempotencyKey,
        payment.purpose,
        payment.planCode ?? null,
        payment.billingInterval ?? null,
        payment.catalogEntryId ?? null,
        payment.amountMinor,
        payment.currency,
        payment.rentalAccessHours ?? null,
        JSON.stringify(payment.entitlementsSnapshot ?? {}),
      ])
      if (result.rows[0]) {
        await client.query('COMMIT')
        return { payment: toPaymentRecord(result.rows[0]), created: true }
      }

      const existing = await client.query<PaymentRow>(
        'SELECT * FROM payment_transactions WHERE account_id = $1 AND idempotency_key = $2',
        [payment.accountId, payment.idempotencyKey],
      )
      if (!existing.rows[0]) throw new Error('Payment idempotency record could not be read after conflict.')
      await client.query('COMMIT')
      return { payment: toPaymentRecord(existing.rows[0]), created: false }
    } catch (error) {
      await rollback(client)
      if (hasCode(error, '23505')) throw new PaymentConflictError('An equivalent checkout is already in progress.')
      throw error
    } finally {
      client.release()
    }
  }

  async findPayment(reference: string, accountId?: string): Promise<PaymentRecord | null> {
    const result = accountId
      ? await this.pool.query<PaymentRow>('SELECT * FROM payment_transactions WHERE provider_reference = $1 AND account_id = $2', [reference, accountId])
      : await this.pool.query<PaymentRow>('SELECT * FROM payment_transactions WHERE provider_reference = $1', [reference])
    return result.rows[0] ? toPaymentRecord(result.rows[0]) : null
  }

  async markCheckoutReady(paymentId: string, authorizationUrl: string): Promise<void> {
    await this.pool.query(`
      UPDATE payment_transactions
      SET authorization_url = $2, status = 'checkout_ready', updated_at = now()
      WHERE id = $1 AND status = 'pending'
    `, [paymentId, authorizationUrl])
  }

  async markInitializationFailed(paymentId: string): Promise<void> {
    await this.pool.query(`
      UPDATE payment_transactions SET status = 'failed', updated_at = now()
      WHERE id = $1 AND status = 'pending'
    `, [paymentId])
  }

  async settlePayment(payment: PaymentRecord, verified: VerifiedProviderPayment): Promise<SettlementResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const currentResult = await client.query<PaymentRow>('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [payment.id])
      const current = currentResult.rows[0]
      if (!current) throw new Error('Payment record disappeared during verification.')
      const currentPayment = toPaymentRecord(current)
      if (currentPayment.reference !== verified.reference) throw new PaymentConflictError('Provider reference does not match the payment.')
      if (currentPayment.status === 'succeeded') {
        await client.query('COMMIT')
        return { duplicate: true, status: currentPayment.status, fulfillmentStatus: currentPayment.fulfillmentStatus }
      }
      if (currentPayment.status === 'failed' || currentPayment.status === 'cancelled' || currentPayment.status === 'refunded') {
        await client.query('COMMIT')
        return { duplicate: true, status: currentPayment.status, fulfillmentStatus: currentPayment.fulfillmentStatus }
      }
      if (verified.status === 'pending') {
        await client.query('COMMIT')
        return { duplicate: false, status: currentPayment.status, fulfillmentStatus: currentPayment.fulfillmentStatus }
      }
      if (verified.status === 'failed') {
        await client.query(`
          UPDATE payment_transactions SET status = 'failed', fulfillment_status = 'not_applicable', provider_transaction_id = $2, verified_at = now(), updated_at = now()
          WHERE id = $1
        `, [payment.id, verified.providerTransactionId])
        await client.query('COMMIT')
        return { duplicate: false, status: 'failed', fulfillmentStatus: 'not_applicable' }
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [currentPayment.accountId])
      await client.query(`
        UPDATE payment_transactions SET status = 'succeeded', provider_transaction_id = $2, paid_at = $3, verified_at = now(), updated_at = now()
        WHERE id = $1
      `, [payment.id, verified.providerTransactionId, verified.paidAt])

      let fulfillmentStatus: PaymentRecord['fulfillmentStatus'] = 'granted'
      if (currentPayment.purpose === 'subscription') {
        const active = await client.query(`
          SELECT id FROM subscriptions
          WHERE account_id = $1 AND status IN ('active','past_due','suspended','cancelled') AND ends_at > now()
          LIMIT 1 FOR UPDATE
        `, [currentPayment.accountId])
        if (active.rows.length > 0) {
          fulfillmentStatus = 'blocked_policy'
        } else {
          await client.query(`
            UPDATE subscriptions SET status = 'expired', updated_at = now()
            WHERE account_id = $1 AND status IN ('active','past_due') AND ends_at <= now()
          `, [currentPayment.accountId])
          const period = currentPayment.billingInterval === 'annual' ? '1 year' : '1 month'
          if (!currentPayment.entitlementsSnapshot) throw new Error('Subscription entitlement snapshot is missing.')
          const snapshot = JSON.stringify(currentPayment.entitlementsSnapshot)
          await client.query(`
            INSERT INTO subscriptions (id, account_id, plan_code, payment_id, status, starts_at, ends_at, entitlements_snapshot)
            VALUES ($1,$2,$3,$4,'active',now(),now() + $5::interval,$6::jsonb)
          `, [randomUUID(), currentPayment.accountId, currentPayment.planCode, payment.id, period, snapshot])
        }
      } else {
        const eligible = await client.query(`
          SELECT 1
          FROM catalog_entries AS entry
          WHERE entry.id = $1
            AND entry.kind = 'film'
            AND entry.publication_status = 'published'
            AND EXISTS (
              SELECT 1
              FROM catalog_distribution_rights AS rights
              JOIN catalog_right_platforms AS platform
                ON platform.entry_id = rights.entry_id AND platform.right_id = rights.right_id
              JOIN catalog_right_territories AS territory
                ON territory.entry_id = rights.entry_id AND territory.right_id = rights.right_id
              WHERE rights.entry_id = entry.id
                AND rights.streaming_allowed = true
                AND platform.platform = 'web'
                AND territory.territory_code = 'WORLDWIDE'
                AND rights.starts_at <= now()
                AND (rights.ends_at IS NULL OR rights.ends_at > now())
            )
          FOR UPDATE OF entry
        `, [currentPayment.catalogEntryId])
        if (eligible.rows.length === 0) {
          fulfillmentStatus = 'blocked_rights'
        } else {
          await client.query(`
            INSERT INTO rental_entitlements (id, account_id, catalog_entry_id, payment_id, status, starts_at, ends_at)
            VALUES ($1,$2,$3,$4,'active',now(),now() + ($5 * interval '1 hour'))
          `, [randomUUID(), currentPayment.accountId, currentPayment.catalogEntryId, payment.id, currentPayment.rentalAccessHours])
        }
      }
      await client.query('UPDATE payment_transactions SET fulfillment_status = $2 WHERE id = $1', [payment.id, fulfillmentStatus])
      if (fulfillmentStatus === 'blocked_rights' || fulfillmentStatus === 'blocked_policy') {
        await client.query(`
          INSERT INTO payment_reconciliation (payment_id, outcome, details_code)
          VALUES ($1,'entitlement_blocked',$2)
        `, [payment.id, fulfillmentStatus])
      } else {
        await client.query(`
          INSERT INTO payment_reconciliation (payment_id, outcome, details_code)
          VALUES ($1,'matched','verified_payment_fulfilled')
        `, [payment.id])
      }
      await client.query('COMMIT')
      return { duplicate: false, status: 'succeeded', fulfillmentStatus }
    } catch (error) {
      await rollback(client)
      if (hasCode(error, '23505')) throw new PaymentConflictError('This provider transaction has already been applied.')
      throw error
    } finally {
      client.release()
    }
  }

  async recordWebhook(provider: string, eventKey: string, eventName: string, reference: string, bodyDigest: string): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO payment_webhook_events (provider, event_key, event_name, provider_reference, body_sha256, status)
      VALUES ($1,$2,$3,$4,$5,'processing')
      ON CONFLICT (provider, event_key) DO UPDATE
        SET status = 'processing', error_code = NULL, received_at = now(), processed_at = NULL
      WHERE payment_webhook_events.status = 'failed'
        OR (payment_webhook_events.status = 'processing' AND payment_webhook_events.received_at < now() - interval '5 minutes')
      RETURNING event_key
    `, [provider, eventKey, eventName, reference, bodyDigest])
    return result.rowCount === 1
  }

  async finishWebhook(provider: string, eventKey: string, outcome: 'processed' | 'ignored' | 'failed', errorCode?: string): Promise<void> {
    await this.pool.query(`
      UPDATE payment_webhook_events
      SET status = $3, error_code = $4, processed_at = CASE WHEN $3 = 'processing' THEN NULL ELSE now() END
      WHERE provider = $1 AND event_key = $2
    `, [provider, eventKey, outcome, errorCode ?? null])
  }

  async getAccountBillingState(accountId: string, now: Date): Promise<AccountBillingState> {
    const subscriptionResult = await this.pool.query<{
      plan_code: PlanCode
      status: SubscriptionRecord['status']
      starts_at: Date
      ends_at: Date
      cancel_at_period_end: boolean
      entitlements_snapshot: SubscriptionEntitlementsSnapshot
    }>(`
      SELECT plan_code, status, starts_at, ends_at, cancel_at_period_end, entitlements_snapshot
      FROM subscriptions
      WHERE account_id = $1
      ORDER BY starts_at DESC, created_at DESC
      LIMIT 1
    `, [accountId])
    const rentalResult = await this.pool.query<{
      catalog_entry_id: string
      status: RentalRecord['status']
      starts_at: Date
      ends_at: Date
    }>(`
      SELECT rental.catalog_entry_id, rental.status, rental.starts_at, rental.ends_at
      FROM rental_entitlements AS rental
      JOIN catalog_entries AS entry ON entry.id = rental.catalog_entry_id
      WHERE rental.account_id = $1
        AND rental.status = 'active'
        AND rental.starts_at <= $2
        AND rental.ends_at > $2
        AND entry.kind = 'film'
        AND entry.publication_status = 'published'
        AND EXISTS (
          SELECT 1
          FROM catalog_distribution_rights AS rights
          JOIN catalog_right_platforms AS platform
            ON platform.entry_id = rights.entry_id AND platform.right_id = rights.right_id
          JOIN catalog_right_territories AS territory
            ON territory.entry_id = rights.entry_id AND territory.right_id = rights.right_id
          WHERE rights.entry_id = entry.id
            AND rights.streaming_allowed = true
            AND platform.platform = 'web'
            AND territory.territory_code = 'WORLDWIDE'
            AND rights.starts_at <= $2
            AND (rights.ends_at IS NULL OR rights.ends_at > $2)
        )
    `, [accountId, now])
    const subscription = subscriptionResult.rows[0]
    return {
      subscription: subscription ? {
        planCode: subscription.plan_code,
        status: subscription.status,
        startsAt: new Date(subscription.starts_at).toISOString(),
        endsAt: new Date(subscription.ends_at).toISOString(),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        entitlementsSnapshot: subscription.entitlements_snapshot,
      } : null,
      rentals: rentalResult.rows.map((rental) => ({
        catalogEntryId: rental.catalog_entry_id,
        status: rental.status,
        startsAt: new Date(rental.starts_at).toISOString(),
        endsAt: new Date(rental.ends_at).toISOString(),
      })),
    }
  }

  async scheduleSubscriptionCancellation(accountId: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE subscriptions
      SET status = 'cancelled', cancel_at_period_end = true, updated_at = now()
      WHERE id = (
        SELECT id FROM subscriptions
        WHERE account_id = $1 AND status = 'active' AND ends_at > now()
        ORDER BY starts_at DESC
        LIMIT 1
        FOR UPDATE
      )
      RETURNING id
    `, [accountId])
    return result.rowCount === 1
  }

  async recordReconciliation(paymentId: string, outcome: 'matched' | 'mismatch' | 'provider_unavailable' | 'entitlement_blocked', detailsCode: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO payment_reconciliation (payment_id, outcome, details_code) VALUES ($1,$2,$3)',
      [paymentId, outcome, detailsCode],
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    reference: row.provider_reference,
    idempotencyKey: row.idempotency_key,
    purpose: row.purpose,
    amountMinor: Number(row.amount_minor),
    currency: row.currency.trim(),
    ...(row.plan_code ? { planCode: row.plan_code } : {}),
    ...(row.billing_interval ? { billingInterval: row.billing_interval } : {}),
    ...(row.catalog_entry_id ? { catalogEntryId: row.catalog_entry_id } : {}),
    ...(row.rental_access_hours !== null ? { rentalAccessHours: row.rental_access_hours } : {}),
    status: row.status,
    fulfillmentStatus: row.fulfillment_status,
    entitlementsSnapshot: row.entitlements_snapshot ?? { features: [], qualities: [], maxConcurrentStreams: null, maxWatchlistEntries: null },
    authorizationUrl: row.authorization_url,
    providerTransactionId: row.provider_transaction_id,
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Preserve the original database failure.
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
