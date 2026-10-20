CREATE TABLE monetization_plans (
  code text PRIMARY KEY CHECK (code IN ('FREE', 'MEDIUM', 'PRO')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3),
  billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'annual')),
  features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array'),
  video_qualities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(video_qualities) = 'array'),
  max_concurrent_streams integer CHECK (max_concurrent_streams IS NULL OR max_concurrent_streams >= 1),
  max_watchlist_entries integer CHECK (max_watchlist_entries IS NULL OR max_watchlist_entries >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((code = 'FREE' AND price_minor = 0 AND currency IS NULL AND billing_interval IS NULL) OR
         (price_minor IS NULL AND currency IS NULL AND billing_interval IS NULL) OR
         (price_minor IS NOT NULL AND currency IS NOT NULL AND billing_interval IS NOT NULL)),
  CHECK (code <> 'FREE' OR price_minor = 0)
);

CREATE TABLE payment_transactions (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 255),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 128),
  provider_transaction_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  purpose text NOT NULL CHECK (purpose IN ('subscription', 'rental')),
  plan_code text REFERENCES monetization_plans(code) ON DELETE RESTRICT,
  billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'annual')),
  catalog_entry_id text REFERENCES catalog_entries(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  entitlements_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlements_snapshot) = 'object'),
  status text NOT NULL CHECK (status IN ('pending', 'checkout_ready', 'succeeded', 'failed', 'cancelled', 'refunded', 'reconciliation_required')),
  fulfillment_status text NOT NULL DEFAULT 'pending' CHECK (fulfillment_status IN ('pending', 'granted', 'blocked_rights', 'blocked_policy', 'not_applicable')),
  authorization_url text,
  rental_access_hours integer CHECK (rental_access_hours IS NULL OR rental_access_hours BETWEEN 1 AND 8760),
  paid_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (provider, provider_transaction_id),
  CHECK ((purpose = 'subscription' AND plan_code IS NOT NULL AND billing_interval IS NOT NULL AND catalog_entry_id IS NULL) OR
         (purpose = 'rental' AND plan_code IS NULL AND billing_interval IS NULL AND catalog_entry_id IS NOT NULL AND rental_access_hours IS NOT NULL))
);
CREATE INDEX payment_transactions_account_created_idx ON payment_transactions (account_id, created_at DESC);
CREATE INDEX payment_transactions_reconciliation_idx ON payment_transactions (updated_at)
  WHERE status IN ('pending', 'reconciliation_required');
CREATE UNIQUE INDEX payment_transactions_one_open_subscription_uq ON payment_transactions (account_id)
  WHERE purpose = 'subscription' AND status IN ('pending', 'checkout_ready', 'reconciliation_required');

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 255),
  plan_code text NOT NULL REFERENCES monetization_plans(code) ON DELETE RESTRICT,
  payment_id uuid NOT NULL UNIQUE REFERENCES payment_transactions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired', 'suspended', 'refunded')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  entitlements_snapshot jsonb NOT NULL CHECK (jsonb_typeof(entitlements_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX subscriptions_account_period_idx ON subscriptions (account_id, starts_at DESC, ends_at);
CREATE UNIQUE INDEX subscriptions_one_current_per_account_uq
  ON subscriptions (account_id)
  WHERE status IN ('active', 'past_due', 'suspended');

CREATE TABLE rental_entitlements (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 255),
  catalog_entry_id text NOT NULL REFERENCES catalog_entries(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL UNIQUE REFERENCES payment_transactions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'refunded', 'revoked')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX rental_entitlements_account_movie_idx ON rental_entitlements (account_id, catalog_entry_id, ends_at DESC);

CREATE TABLE payment_webhook_events (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  event_key text NOT NULL CHECK (length(event_key) = 64),
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 1 AND 120),
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 128),
  body_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'processed', 'ignored', 'failed')),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_key)
);
CREATE INDEX payment_webhook_events_reconciliation_idx ON payment_webhook_events (received_at)
  WHERE status IN ('processing', 'failed');

CREATE TABLE payment_reconciliation (
  id bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payment_transactions(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('matched', 'mismatch', 'provider_unavailable', 'entitlement_blocked')),
  details_code text NOT NULL CHECK (length(details_code) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_reconciliation_payment_idx ON payment_reconciliation (payment_id, created_at DESC);
