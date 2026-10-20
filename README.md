# VOH MOVIES

VOH MOVIES is a responsive movie and series catalog experience built with React, TypeScript, Vite, Tailwind CSS, a Fastify API, and a PostgreSQL catalog repository. The browser and API share typed catalog models and validation. A provider-independent monetization foundation and Paystack hosted-checkout adapter are implemented, but actual billing needs external database, identity, and provider configuration. The project does not provide customer login, media playback, or uploads.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

With `VITE_API_BASE_URL` unset, the catalog uses localStorage in the current browser. To use the PostgreSQL API, configure the database and server environment, apply migrations, and start the API as described in the [catalog API and database guide](docs/catalog-integration.md). The browser switches to the API when `VITE_API_BASE_URL` is configured; API connectivity or authorization failures are reported and do not switch silently to local storage.

Vite prints the local frontend URL. Available checks and preview commands:

```sh
npm run typecheck
npm test
npm run build
npm run preview
npm run api:dev
npm run api:build
npm run api:start
npm run db:migrate
```

## Project layout

```text
src/
  app/                    Routing and shared application shell
  components/             Branding and navigation
  features/
    admin/                 Catalog studio and record editing
    catalog/               Typed domain, validation, repositories, service, UI
    monetization/           Server-fed plan and payment status page
  styles.css               VOH design tokens, responsive styles, motion
server/
  src/                     Fastify API, authorization, and PostgreSQL repository
  src/payments/             Payment provider and billing persistence
  src/monetization/         Plan configuration and entitlement decisions
  migrations/              Versioned PostgreSQL schema migrations
docs/
  catalog-integration.md   Database, API, and authentication setup
```

`CatalogService` validates data for both repositories and reports loading, ready, and error states. `HttpCatalogRepository` is selected when `VITE_API_BASE_URL` is configured; otherwise the device-only `LocalCatalogRepository` is used. The app contains no sample movies or fabricated activity. See the [catalog API and database guide](docs/catalog-integration.md) for setup, migration, authentication, and rights enforcement.

## Current behavior and boundaries

- Catalogue search covers normalized titles, synopsis, genres, cast, characters, release metadata, and series episodes. Type/genre filters and title/release-date sorting use actual catalog fields.
- Movie, series, season, episode, actor, character, genre, collection, and distribution-right records are runtime validated at the API boundary and before PostgreSQL writes.
- The `/admin` catalog studio creates, edits, publishes, and deletes records; database-backed operations use authenticated admin API routes, publication validates streaming rights, and deletion requires confirmation.
- Public API queries enforce published status and active web-streaming rights in PostgreSQL. Since visitor geolocation is not implemented, globally visible titles must have a `WORLDWIDE` right. A collection appears only when it contains at least one publicly available title. Series details order and display real seasons/episodes.
- Duplicate detection uses IDs/external IDs or matching normalized title, release year, and synopsis; distinct same-title records are retained.
- When `VITE_API_BASE_URL` is blank, catalog data lives in this browser's localStorage and is not shared, synchronized, or protected by server authorization. When configured, API/database errors are shown rather than falling back to browser storage.
- The PostgreSQL migrations are tracked by checksum and apply additive schema changes. API startup requires a database and an applied schema.
- The watchlist stores IDs in this browser only. It is not an account feature and does not sync between devices.
- Movie detail UI includes a truthful playback-not-connected notice. No stream or download is available.
- Admin API routes are fail-closed by default. A server can enable them by verifying RS256 JWTs from a trusted identity provider using server-only issuer, audience, and public-key configuration; role headers and client-provided identities are not trusted. The frontend has no login flow, so a trusted external authentication layer must supply its configured HttpOnly session cookie. Device-local `/admin` editing is only a local-development feature.
- `/plans` displays the server's FREE, MEDIUM, and PRO configuration. Pricing, billing interval, features, quality permissions, stream/watchlist limits, ad eligibility, and rental terms are centrally server-configured; paid pricing and rentals default to unavailable rather than using invented prices.
- A provider abstraction, Paystack server adapter, verified hosted checkout/callback path, signed-webhook handling, idempotency, reconciliation records, and account entitlement service are implemented and mocked in tests. Payment access uses only a verified JWT subject and requires the trusted issuer's verified-email claim for checkout.
- Payment integration is not configured by default. No real Paystack credentials, database, identity-provider session, recurring billing, refunds, video playback, ad network, or settlement configuration are included. A successful payment never replaces published-content and active-distribution-right checks.
- VOH AUTOPILOT is identified as planned; no automation or recommendations run.
- `.env.example` contains public frontend configuration only. `.env.server.example` documents API/database environment variables, but is not loaded automatically and contains no credentials.

## External services still required

VOH MOVIES does not provision a PostgreSQL server, database credentials, identity provider, or media services. Database-backed use requires an operator-configured PostgreSQL instance and all migrations. Authenticated studio and billing use additionally require a trusted JWT issuer and an external login/session layer. Follow the [catalog and monetization integration guide](docs/catalog-integration.md) for secret configuration, Paystack setup, webhook requirements, and the current sandbox limitations. Media upload, storage, transcoding, adaptive playback, downloads, account features, automatic renewals, refund automation, ad serving, and VOH AUTOPILOT remain unimplemented.

The hero currently uses a remote Unsplash landscape as concept art, explicitly not as a featured title. Replace it with approved VOH-owned artwork before production.
