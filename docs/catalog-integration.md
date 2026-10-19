# Catalogue integration contract

Catalog storage is replaceable through `CatalogRepository`. When `VITE_API_BASE_URL` is configured, the app uses `HttpCatalogRepository`; otherwise it uses `LocalCatalogRepository`, which stores records in this browser's localStorage under `voh-movies.catalog.v1`. Local storage is a development bridge only: it is per-browser, not shared, not synchronized, can be cleared by the user, and is not an authorization or backup boundary.

The frontend must never connect directly to a database or receive database credentials. `VITE_` variables are visible in the built browser bundle and must contain no secrets.

`HttpCatalogRepository` currently expects:

- `GET /catalog` returns `{ "items": CatalogEntry[] }`.
- `GET /catalog/:id` returns `{ "item": CatalogEntry }`.
- `POST /catalog` accepts a `CatalogEntry` and returns `{ "item": CatalogEntry }`.
- `PUT /catalog/:id` accepts a complete `CatalogEntry` and returns `{ "item": CatalogEntry }`.
- `DELETE /catalog/:id` returns a success response (`204` is supported).
- Writes may return `409 Conflict` for duplicate stable/external IDs or matching normalized title, release year, and synopsis. The service preflights for helpful errors, but the API/database must enforce identity atomically to handle concurrent writes.
- Requests include browser credentials. The future API must authenticate and authorize every protected operation server-side, use appropriate CSRF protections for cookie sessions, and apply CORS narrowly.

Every response is runtime-validated before it reaches the UI. Invalid records, broken actor/character references, duplicate records, network failures, HTTP failures, and unavailable storage are surfaced as explicit results. Only published films and series with a currently active web-streaming right appear in public browse results. Drafts and records without current rights remain in the studio only.

The `/admin` catalog studio uses the same service for create, update, and delete; its JSON editor reports Zod paths for invalid fields. Publication is rejected unless streaming rights exist. Deletion requires browser confirmation. This is a functional local catalog workflow, not a secure production admin system: any user with access to this browser can edit local records. A connected API must enforce authentication, authorization, publication rules, and duplicate uniqueness server-side.

`.env.server.example` describes backend-only configuration (`DATABASE_URL`, `SESSION_SECRET`, and allowed origins) for a future API service. No backend, database, migration, session handling, production catalog persistence, admin authorization, or media service is included or connected in this frontend repository. Copy those values only into a backend environment/secret manager when that service exists; do not add them to a Vite `.env` or expose them as `VITE_` variables.