# ahura-api — Cloudflare Worker backend for ahura.dev

Production API for the ahura.dev static site (hosted on GitHub Pages).
Provides privacy-conscious analytics ingestion, double opt-in newsletter
subscriptions, campaign drafts, and an admin API consumed by the static
dashboard at `/admin/`.

Live: `https://ahura-api.admine-070.workers.dev`
Database: Cloudflare D1 `ahura-db` (`d6558971-e6fb-46b3-9922-766f27a85930`)

## Architecture

```
GitHub Pages (static Astro site)
  |-- analytics snippet  -> POST /api/analytics
  |-- newsletter form    -> POST /api/subscribe
  |-- /admin/* dashboard -> /api/admin/* (Bearer token)
Cloudflare Worker (ahura-api)
  |-- D1 database (ahura-db)
  |-- cron: daily cleanup 03:00 UTC (expired tokens, stale rate limits)
```

Email sending is adapter-based (`mailProviders` in `src/worker.js`).
`EMAIL_PROVIDER=none` (default): subscriptions are stored as pending and the
API honestly reports `email_sent: false`. Nothing is ever reported as
delivered unless a provider really sent it.

## API endpoints

Public:

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| POST   | /api/analytics    | Anonymous page-view event. Deduplicated by `event_id`. |
| POST   | /api/subscribe    | Newsletter signup. Creates a pending subscriber + confirmation token. |
| GET    | /api/confirm      | Confirm subscription via `?token=`. Returns an HTML result page. |
| GET    | /api/unsubscribe  | Unsubscribe via `?token=`. No login required.          |

Admin (header `Authorization: Bearer <ADMIN_TOKEN>`):

| Method | Path                                        | Description                              |
| ------ | ------------------------------------------- | ---------------------------------------- |
| GET    | /api/admin/stats                            | Summary cards                            |
| GET    | /api/admin/analytics?days=7\|30\|90          | Daily series, top pages, referrers, devices |
| GET    | /api/admin/subscribers                      | Search / filter / paginate (`status,q,page,per_page`) |
| GET    | /api/admin/subscribers/export               | CSV download (auth required)             |
| POST   | /api/admin/subscribers/:id/unsubscribe      | Unsubscribe one subscriber               |
| POST   | /api/admin/subscribers/:id/resend           | Resend confirmation (409 until a mail provider exists) |
| DELETE | /api/admin/subscribers/:id                  | Delete subscriber + tokens               |
| GET    | /api/admin/campaigns                        | List campaigns                           |
| POST   | /api/admin/campaigns                        | Create draft                             |
| PUT    | /api/admin/campaigns/:id                    | Edit draft                               |
| POST   | /api/admin/campaigns/:id/test               | Test send (409 until a mail provider exists) |
| POST   | /api/admin/campaigns/:id/send               | Bulk send (409 until a mail provider exists) |
| GET    | /api/admin/health                           | Provider status, table counts            |
| GET    | /api/admin/documents                        | List/search documents (status,q,folder_id,type,tag,sort,page,per_page) |
| POST   | /api/admin/documents                        | Create document                          |
| GET    | /api/admin/documents/:id                    | Full document with Markdown source       |
| PUT    | /api/admin/documents/:id                    | Update (requires `version`; 409 on conflict) |
| DELETE | /api/admin/documents/:id                    | Soft-delete to trash (`?permanent=1` for hard delete) |
| POST   | /api/admin/documents/:id/duplicate          | Duplicate document                       |
| POST   | /api/admin/documents/:id/archive            | Archive                                  |
| POST   | /api/admin/documents/:id/restore            | Restore from trash/archive               |
| GET    | /api/admin/documents/:id/revisions          | Revision history                         |
| GET    | /api/admin/documents/:id/revisions/:revId   | Full revision content                    |
| POST   | /api/admin/documents/:id/revisions/:revId/restore | Restore revision (reversible)     |
| GET    | /api/admin/folders                          | List folders with document counts        |
| POST   | /api/admin/folders                          | Create folder                            |
| PUT    | /api/admin/folders/:id                      | Rename folder                            |
| DELETE | /api/admin/folders/:id                      | Delete folder (documents become unfiled) |
| POST   | /api/admin/upload                           | Image upload (multipart `file[]`, ≤2MB, magic-byte validated) |

Public:

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | /api/assets/:key  | Serve an uploaded image (unguessable key, immutable cache) |

## D1 schema

Migrations live in `migrations/` and are applied in order. Current: `0001_init.sql`.

Tables: `subscribers`, `email_tokens` (sha256 hashes only, 48h expiry),
`campaigns`, `analytics_events` (no IPs, no PII), `audit_log`, `rate_limits`,
`folders`, `documents` (+ `documents_fts` FTS5 index with sync triggers),
`revisions` (max 50 per document), `assets` (uploaded images as base64 TEXT;
R2 is not enabled on this account — migrate `assets` to R2 when available).

Apply a migration:

```bash
# via wrangler
wrangler d1 execute ahura-db --file migrations/0001_init.sql
# via API (see ../../custom-connectors/custom.cloudflare/CONNECTOR.md)
```

Never reset the production database to make a migration easier. New changes go
in a new numbered migration file.

## Configuration

Vars (in `wrangler.toml`, safe to commit):

| Var            | Value                                    |
| -------------- | ---------------------------------------- |
| SITE_ORIGIN    | `https://ahurabyte.github.io` (CORS allowlist, comma-separated) |
| SITE_URL       | `https://ahurabyte.github.io/ahura-dev`   |
| EMAIL_PROVIDER | `none`                                   |

Secrets (via `wrangler secret put`, never committed):

| Secret      | Description                                          |
| ----------- | ---------------------------------------------------- |
| ADMIN_TOKEN | 256-bit hex token for the admin dashboard/API        |

Generate: `openssl rand -hex 32`. The dashboard login stores it in
`sessionStorage` (cleared when the tab closes).

## Local development

```bash
cd worker
npm install -g wrangler   # or npx wrangler
wrangler dev              # serves locally with a local D1
```

## Deployment

Option A — API script (no token needed locally; uses the vault credential):

```bash
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/deploy_worker.py \
  <ACCOUNT_ID> ahura-api worker/src/worker.js worker/metadata.json
```

`metadata.json` must carry `main_module`, `compatibility_date`, the D1
`bindings` and `vars` (see `wrangler.toml` for values).

Option B — wrangler (needs `CLOUDFLARE_API_TOKEN`):

```bash
cd worker && wrangler deploy
```

Option C — GitHub Actions: `.github/workflows/worker-deploy.yml` deploys on
pushes touching `worker/`. Add these repository secrets once:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Secrets are managed separately:

```bash
wrangler secret put ADMIN_TOKEN
```

## Email provider setup (Resend)

The provider is Resend (`EMAIL_PROVIDER=resend`); the adapter lives in
`mailProviders` in `src/worker.js` and reads its credential from the
`RESEND_API_KEY` Worker secret — never from the repo. The sending domain
ahura.dev must be verified in the Resend dashboard (SPF/DKIM records in
Cloudflare DNS); `EMAIL_FROM` optionally overrides the default sender
`Ahura Blog <newsletter@ahura.dev>`. Until the secret is set, the adapter
reports `canSend: false`, `/api/subscribe` returns `email_sent: false`
and the dashboard shows the provider as inactive. After setting the
secret, resend pending confirmations from the dashboard (subscriber row
action). Campaign sending stays disabled (not implemented yet).

## Admin authentication

The dashboard at `/admin/` asks for the admin token on first visit and keeps
it in `sessionStorage`. Rotate with `wrangler secret put ADMIN_TOKEN`.
All `/api/admin/*` routes return 401 without a valid Bearer token, and
admin actions are written to `audit_log`.

## Troubleshooting

- `401 unauthorized` on admin calls: token missing/wrong or `ADMIN_TOKEN`
  secret not set on the Worker.
- `409 email_provider_not_configured`: expected until a mail provider is added.
- `429 rate_limited`: slow down; limits are per IP / per email / per session.
- Analytics not appearing: check the browser console and confirm the request
  reaches `/api/analytics` (ad-blockers may block it; that is expected and fine).
- After changing Worker code, redeploy; there is no build step.

## Tests

```bash
cd worker
ADMIN_TOKEN=<token> node --test test.mjs            # newsletter/analytics/admin
ADMIN_TOKEN=<token> node --test test-studio.mjs     # writing studio
```

End-to-end tests against the deployed Worker. The studio suite covers
document CRUD, FTS search (including Persian), optimistic-concurrency
conflicts, revision creation/restoration, image upload validation
(magic bytes, size limits, spoofed types), asset serving, and auth on
every protected route. Test data is cleaned up afterwards.
