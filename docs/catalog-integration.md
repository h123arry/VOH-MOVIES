# Catalog API and database setup

VOH MOVIES has a real Fastify catalog API and PostgreSQL repository. The browser uses `HttpCatalogRepository` when `VITE_API_BASE_URL` is set; when it is blank, the existing `LocalCatalogRepository` remains available as a device-only development fallback. Device storage is per-browser, can be cleared, and is not shared, backed up, or protected by server authorization.

The frontend never connects directly to PostgreSQL. All browser-visible `VITE_` variables are public and must not contain credentials or signing keys.

## Start the frontend with the API

Set the API base URL in the frontend environment:

```sh
VITE_API_BASE_URL=http://127.0.0.1:8080
```

Copy the public frontend settings from `.env.example` to `.env`, then run `npm run dev`. The frontend makes catalog reads against `GET /catalog` and `GET /catalog/:id`; the studio reads and writes through `/admin/catalog` routes. Browser requests include credentials. A blank API URL deliberately selects local browser storage; a configured but unreachable API reports an error and does not silently fall back to device data.

## PostgreSQL and migrations

Requirements: Node.js 20.19+ or 22.12+, npm, and a PostgreSQL instance that you administer or have been given access to. No database, database account, or credentials are provisioned by this repository.

1. Create or select a PostgreSQL database using your own infrastructure and credentials.
2. Set server-only variables in the environment of the migration/API process. At minimum set `DATABASE_URL` to the PostgreSQL connection URL for that database. `DATABASE_SSL_MODE` defaults to `require`; set it to `disable` only for a trusted local PostgreSQL connection, or `verify-full` when the database certificate is configured for verification.
3. Apply the versioned, additive migrations from the repository root:

   ```sh
   npm run db:migrate
   ```

   The migrator tracks checksums in `schema_migrations`, serializes concurrent runs with a PostgreSQL advisory lock, and refuses to run a modified migration a second time. Do not edit an applied migration; add a new numbered migration instead.
4. Build and start the API with the same server environment:

   ```sh
   npm run api:build
   npm run api:start
   ```

   For development, use `npm run api:dev`. The API checks connectivity and migration state on startup and exits with an error if required tables are missing. The migrator and API read process environment variables; `.env.server.example` is a template only and is not automatically loaded.

Required server variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL; required by API and migration commands |
| `DATABASE_SSL_MODE` | `require` by default; `disable` or `verify-full` are also supported |
| `API_HOST` | Listen address; defaults to `127.0.0.1` |
| `API_PORT` | Listen port; defaults to `8080` |
| `CATALOG_ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins allowed by CORS and admin-origin checks |

Use deployment secrets for database credentials. Never put `DATABASE_URL`, private keys, or admin credentials into a Vite variable or browser bundle.

## Administrator authentication

Every `/admin/*` route uses the same server-side authorization hook, including season, episode, actor, and character routes. With no authorizer configured, it returns `503 authorization_not_configured`; invalid or expired credentials return `401`; valid credentials lacking the needed permission return `403`. A write also requires an `Origin` that exactly matches `CATALOG_ALLOWED_ORIGINS`, which prevents cross-origin cookie-authenticated writes.

The API can verify externally issued RS256 JWTs without trusting client-supplied role headers or user IDs. To enable it, configure all of the following on the API process:

| Variable | Purpose |
|---|---|
| `ADMIN_JWT_ISSUER` | Exact `iss` claim expected from the trusted identity provider |
| `ADMIN_JWT_AUDIENCE` | Expected `aud` claim for this API |
| `ADMIN_JWT_PUBLIC_KEY` | RSA public key (at least 2048 bits) used to verify RS256 signatures |
| `ADMIN_JWT_COOKIE_NAME` | Optional cookie name; defaults to `voh_admin_session` |

The JWT must have a valid signature, expected issuer and audience, unexpired `exp`, a non-empty `sub`, and a space-delimited `scope` claim. The API maps only the signed `catalog:read` and `catalog:write` scopes to permissions. Grant both scopes to catalog editors because the existing catalog service reads the admin catalog before writes. API clients may send the signed JWT in the HTTP `Authorization` header; the browser may use the configured cookie. A browser cookie must be issued by the trusted authentication layer as `HttpOnly`, `Secure` in production, and appropriately `SameSite`; this repository does not provide an identity-provider login, session issuer, or cookie endpoint. One public key is configured directly; key rotation must be coordinated with the API deployment because automatic key discovery and rotation are not implemented. For cross-site frontend/API deployments, cookie policy and CORS must be configured deliberately over HTTPS.

If the JWT settings are absent, admin endpoints stay disabled while public catalog reads remain available. Partial JWT settings are a startup configuration error. No API or frontend secret is generated or supplied by this project.

## API behavior and public rights

- `GET /catalog` and `GET /catalog/:id` return only published films/series with a current right permitting web streaming. Since this API has no visitor geolocation, public queries conservatively require a `WORLDWIDE` territory right; regional-only titles are not exposed globally. Rights are checked in SQL on every public query, including start and end timestamps.
- A published collection appears only if at least one referenced film/series is itself publicly available under those same rights rules.
- Draft and unpublished records are available only through authenticated admin reads. The database repository validates catalog schemas before every write, persists the catalog payload and normalized relational tables in a transaction, and translates uniqueness violations to `409`.
- Admin create/update/delete and nested edits are persisted in PostgreSQL. Database failures do not produce a success response. API errors use `400` for invalid data, `401`/`403` for authentication/permission failures, `404` for missing records, `409` for identity conflicts, `503` for unavailable storage/auth configuration, and `500` for unexpected write errors.
- The migrations preserve existing rows and define relational constraints and indexes. Publishing is validated in the API and repository; public visibility is independently enforced by SQL.

The current studio UI is a JSON record editor and does not implement login. To use it with an API that has admin authorization enabled, deploy the frontend behind the trusted authentication setup that supplies the configured HttpOnly JWT cookie. Without that external identity/session setup, admin API access correctly remains closed; local browser mode is not a secure admin system.

## Monetization foundation

The server now contains provider-independent payment interfaces, a Paystack hosted-checkout adapter, plan configuration, server-authoritative subscription/rental entitlement decisions, a PostgreSQL billing repository, and API routes for plan display, account entitlements, checkout, cancellation-at-period-end, transaction verification, and Paystack webhooks. The `/plans` page displays only server-returned plan settings and never treats a provider redirect as payment proof. A JWT verified by the configured account authorizer supplies the account subject; request bodies cannot choose the beneficiary. Checkout also requires a verified email claim from that identity provider.

This is an integration foundation, not an operating billing service. No Paystack secret, merchant account, database, customer login flow, production provider configuration, or paid price is included. Paid tiers and rentals are unavailable until amounts, currencies, intervals, public URL, payment provider secret, database, and trusted account authentication are configured. The FREE plan has zero price and no feature or quality grants by default. All plan features, limits, and quality lists are centrally controlled by server environment. Supported quality labels are `180p`, `240p`, `360p`, `480p`, `760p`, `1080p`, `HD`, and `4K`; configuring a label does not mean the media exists, is licensed, or can play at that quality.

Paid subscription checkout currently charges a single configured billing interval and creates a bounded access period after provider verification. It does not use Paystack's recurring plan/subscription API or automatically charge renewals; customers would need a separately implemented renewal flow after the paid period expires. Prices are expressed as provider-required currency minor-unit integers and displayed using the currency's standard decimal precision.

### Payment setup configuration

The API reads these server-only variables (see `.env.server.example`):

| Variable | Purpose |
|---|---|
| `PAYSTACK_SECRET_KEY` | Privileged server-to-server Paystack requests and webhook HMAC verification; never expose to Vite |
| `PUBLIC_APP_URL` | Public frontend origin used as the hosted checkout return URL |
| `ADMIN_JWT_ISSUER`, `ADMIN_JWT_AUDIENCE`, `ADMIN_JWT_PUBLIC_KEY` | Trusted signed account identity; billing uses the JWT `sub` and requires `email_verified: true` plus a valid `email` for checkout |
| `PLAN_MEDIUM_PRICE_MINOR`, `PLAN_MEDIUM_CURRENCY`, `PLAN_MEDIUM_BILLING_INTERVAL` | Complete Medium plan price tuple; amount is an integer in currency minor units |
| `PLAN_PRO_PRICE_MINOR`, `PLAN_PRO_CURRENCY`, `PLAN_PRO_BILLING_INTERVAL` | Complete Pro/Premium price tuple |
| `PLAN_<FREE\|MEDIUM\|PRO>_FEATURES` | Comma-separated configured feature identifiers |
| `PLAN_<FREE\|MEDIUM\|PRO>_VIDEO_QUALITIES` | Comma-separated allowed quality labels |
| `PLAN_<FREE\|MEDIUM\|PRO>_MAX_CONCURRENT_STREAMS` | Optional configured stream limit |
| `PLAN_<FREE\|MEDIUM\|PRO>_MAX_WATCHLIST_ENTRIES` | Optional configured watchlist limit |
| `AD_SUPPORTED_PLAN_CODES` | Configured plan codes eligible for future ads; defaults to `FREE` |
| `RENTAL_PRICE_MINOR`, `RENTAL_CURRENCY`, `RENTAL_ACCESS_HOURS` | All three are required to enable film rental checkout |

No monetary value is assumed. Leave paid-plan and rental values blank to keep those checkouts disabled. `PAYSTACK_PUBLIC_KEY` is not required because this implementation creates hosted checkouts server-side and redirects to Paystack's returned authorization URL. The provider's merchant settlement account remains configured in the verified Paystack merchant dashboard; the application has no settlement-account field or automated merchant setup.

`PUBLIC_APP_URL` must use HTTPS except for localhost development. Checkout initiation serializes per-account subscription attempts and prevents a second open subscription checkout; abandoned pending records require reconciliation before another checkout can be created.

After setting the same database environment used by the API, apply the additive migration and restart the API so it synchronizes configured plan metadata:

```sh
npm run db:migrate
npm run api:build
npm run api:start
```

`POST /billing/checkout` and `POST /billing/rentals/:id/checkout` require a verified account session, verified email, an exact allowed `Origin`, and an `Idempotency-Key`. The amount, currency, interval, account ID, and internal provider reference are chosen server-side. Checkout returns the provider-hosted URL; it does not grant access. The return handler calls `POST /billing/payments/:reference/verify`, which retrieves the transaction from the provider and matches its reference, amount, currency, and success status against the pending database record before committing entitlements. `POST /billing/subscription/cancel` schedules access to end at the already-paid period boundary; it does not request a provider-side recurring cancellation because recurring provider plans are not enabled.

Configure the Paystack dashboard webhook URL as `https://<api-origin>/billing/webhooks/paystack`. The API captures the raw JSON bytes, checks `x-paystack-signature` using HMAC-SHA512 and the server secret, records a body digest idempotency key, then independently verifies `charge.success` with Paystack before settlement. Replayed event bodies do not grant a second entitlement. Failed processing can be retried; database records retain webhook and reconciliation outcomes. Other events are recorded as ignored. Refund/dispute events do not currently revoke entitlements automatically and require manual reconciliation.

Public movie rental checkout checks that the film is currently published and has active worldwide web-streaming rights. The database checks those rights again inside the payment settlement transaction before creating a rental window. Existing subscription or rental payment cannot override unavailable/expired distribution rights. Rental entitlements expire independently of subscriptions. Account access remains metadata-only: there is no playback or media server that consumes these entitlements yet.

### Provider documentation and sandbox status

The adapter follows Paystack's documented server-side transaction initialization (`POST /transaction/initialize`), transaction verification (`GET /transaction/verify/:reference`), hosted authorization URL, and webhook signature header contract:

- [Paystack transaction API](https://paystack.com/docs/api/transaction/)
- [Paystack webhooks and signature validation](https://paystack.com/docs/payments/webhooks/)

Those official pages returned HTTP 403 in the implementation environment, so their current contents could not be independently re-read during this task. The adapter's transaction and signature behavior is covered by mocked automated tests, not live Paystack tests. Before configuring sandbox keys, the operator must re-check current Paystack documentation/dashboard requirements, configure a test-mode secret, register the webhook in a reachable HTTPS test environment, and execute a provider sandbox transaction. No real charges are initiated by this repository or its tests.

### Current monetization boundaries

- **Implemented and tested:** server-controlled tier/benefit/quality configuration; fail-closed account verification; provider initialization/verification adapter; callback verification; webhook HMAC verification and replay idempotency; parameterized payment/plan/subscription/rental/event/reconciliation schema; atomic payment settlement and server-computed entitlement reads; cancellation at period end; honest plan and payment-state UI.
- **Requires operator configuration:** PostgreSQL and migration 0003, trusted identity provider/session issuer with verified email claims, Paystack test/live credentials, server-side public app URL, plan pricing/benefits, rental terms, dashboard webhook URL, secure HTTPS/CORS/cookie configuration.
- **Not implemented:** payment customer accounts/login issuance, Paystack recurring billing/subscription plan API, automated renewal, refund/dispute processing, scheduled reconciliation worker or operator dashboard, settlement automation, ad network serving, ad measurement/tracking, player/media delivery, or content playback enforcement. `advertisingEligible` is only a server policy decision; no ads or tracking are connected.

## Current limits

The repository does not include user accounts, an identity provider, login/logout screens, an upload pipeline, media storage, adaptive playback, downloads, account-synced watchlists, or VOH AUTOPILOT. Movie details truthfully indicate that playback is not connected. The hero artwork is remote concept art, not a featured title.
