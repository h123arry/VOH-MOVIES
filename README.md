# VOH MOVIES

VOH MOVIES is a responsive streaming-product frontend built with React, TypeScript, Vite, and Tailwind CSS. Its catalog studio and viewer catalog share typed domain models, validation, a service, and replaceable API/device-storage repositories. No backend, database, authentication, playback, or upload service is connected.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Vite prints the local URL. Available checks and preview commands:

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

## Project layout

```text
src/
  app/                    Routing and shared application shell
  components/             Branding and navigation
  features/
    admin/                 Catalog studio and record editing
    catalog/               Typed domain, validation, repositories, service, UI
  styles.css               VOH design tokens, responsive styles, motion
docs/
  catalog-integration.md   API contract and secure server configuration boundary
```

`CatalogService` validates data for both repositories and reports loading, ready, and error states. When no API origin is configured, records are stored only in this browser. The app contains no sample movies or fabricated activity. See [catalog integration](docs/catalog-integration.md) for CRUD payloads, publication rules, and storage limitations.

## Current behavior and boundaries

- Catalogue search covers normalized titles, synopsis, genres, cast, characters, release metadata, and series episodes. Type/genre filters and title/release-date sorting use actual catalog fields.
- Movie, series, season, episode, actor, character, genre, collection, and distribution-right records are runtime validated at the API boundary.
- The `/admin` catalog studio creates, edits, publishes, and deletes records; publication requires streaming rights and deletion requires confirmation.
- Only published films and series with current web-streaming rights appear in viewer listings. Series details order and display real seasons/episodes.
- Duplicate detection uses IDs/external IDs or matching normalized title, release year, and synopsis; distinct same-title records are retained.
- When `VITE_API_BASE_URL` is blank, catalog data lives in this browser's localStorage and is not shared or synchronized. The future API/database must enforce authorization and uniqueness.
- The watchlist stores IDs in this browser only. It is not an account feature and does not sync between devices.
- Movie detail UI includes a truthful playback-not-connected notice. No stream or download is available.
- `/admin` offers functional local catalog editing but is not authenticated and grants no server-enforced privileges.
- VOH AUTOPILOT is identified as planned; no automation or recommendations run.
- `.env.example` contains public frontend configuration only. `.env.server.example` is a template for a future backend and is not used by Vite.

## Production architecture direction

Keep this frontend modular by feature and use a trusted API as the authority for identity, role checks, catalog writes, and audit logs. Persist accounts, catalog metadata, entitlements, and admin audit events in a database; store media in private object storage, deliver adaptive streams through a managed video pipeline/CDN, and process uploads asynchronously. Keep future VOH AUTOPILOT jobs server-side, permission-scoped, observable, and approval-gated for consequential actions. Do not expose storage credentials or admin authorization logic in the browser.

The hero currently uses a remote Unsplash landscape as concept art, explicitly not as a featured title. Replace it with approved VOH-owned artwork before production.
