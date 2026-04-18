# privmsg

[中文](./README.md) | English

An MVP aligned with the product spec: a web-based burn-after-reading message service built with Vue, using client-side encryption, a zero-knowledge server model, support for text plus multiple attachments, and configurable access limits.

Related docs:

- Deployment guide (English): [docs/deployment.en.md](./docs/deployment.en.md)
- 部署说明（中文）: [docs/deployment.md](./docs/deployment.md)

## Current Scope

- Browser-side encryption and decryption with `AES-GCM` + `HKDF(SHA-256)`
- The URL fragment stores only the local key share: `/m/<id>#<local_key_share>`
- Server API:
  - `POST /api/create-bootstrap`
  - `POST /api/create`
  - `GET /api/message/:id`
  - `GET /api/message/:id/file/:index`
  - `POST /api/message/:id/access-key`
- Total attachment size limit `<= 50MB`
- Sender-configured max access count, currently `1 - 20`
- Supported types: `jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `txt` `pdf` `pk8`
- Readers fetch ciphertext first, then request a one-time decryption grant; the server decrements remaining access count atomically before returning its key share
- All API responses include `Cache-Control: no-store`
- GitHub Actions CI and deployment workflows are included
- D1 schema is managed through [`migrations/`](./migrations/)
- Local validation and sync scripts are provided for GitHub secrets and variables
- Pinned Node `22.22.2` and Wrangler `4.83.0`
- Frontend is built with `Vue 3 + Vite`
- D1 / R2 usage accounting and guardrails are supported, with per-environment thresholds supplied through GitHub Variables
- `GET /api/usage` exposes current D1 / R2 usage counters, active windows, and configured limits

## Remaining PRD Gaps

- Real PDF.js preview support: the current version uses an isolated iframe for PDF preview
- IP-based rate limiting / create-frequency throttling
- Scheduled cleanup for expired-but-unread objects
- Stronger build consistency verification, such as pinned wrangler / node validation and release hashes

## Local Development

1. Use the pinned Node version from [`.nvmrc`](./.nvmrc), then install dependencies

```bash
nvm use
npm install
```

2. Create your own D1 / R2 resources and update the matching bindings in [`wrangler.toml`](./wrangler.toml)

```bash
npx wrangler d1 create <database-name>
npx wrangler r2 bucket create <bucket-name>
npx wrangler r2 bucket create <preview-bucket-name>
```

3. Initialize the local D1 development database

```bash
npm run db:migrate:local
```

If you already created remote databases and do not want to wait for GitHub Actions, you can also apply remote migrations manually:

```bash
npm run db:migrate:staging
npm run db:migrate:production
```

The `Deploy` workflow applies pending D1 migrations before publishing, so manual remote initialization is usually unnecessary.

4. Start the frontend dev server

```bash
npm run dev
```

5. Start the Worker API in development mode when needed

```bash
npm run dev:worker
```

## Test and Build

```bash
npm test
```

Build the frontend bundle:

```bash
npm run build
```

## Deployment Configuration

The deployment workflow expects these GitHub secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` should be a Cloudflare API Token, not the Global API Key. Scope it to the target account / resources and grant only the permissions your CI steps actually need. See [docs/deployment.en.md](./docs/deployment.en.md) and [docs/deployment.md](./docs/deployment.md) for details.

You can validate configuration locally first:

```bash
npm run github:secrets:check
npm run github:variables:check
```

If `gh auth login` is already configured, you can sync values to a repository directly:

```bash
npm run github:secrets:sync -- owner/repo
npm run github:variables:sync -- owner/repo
```

Supported GitHub Variables:

- `USAGE_LIMIT_D1_ROWS_READ_DAILY`
- `USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY`
- `USAGE_LIMIT_D1_STORAGE_GB`
- `USAGE_LIMIT_R2_CLASS_A_MONTHLY`
- `USAGE_LIMIT_R2_CLASS_B_MONTHLY`
- `USAGE_LIMIT_R2_STORAGE_GB_MONTH`

## Data Model

Message metadata is stored in D1:

```sql
messages (
  id,
  attachment_count,
  total_size,
  stored_bytes,
  max_reads,
  read_count,
  created_at,
  expires_at,
  burned,
  objects_deleted,
  storage_projection_month
)
```

Usage accounting is stored in D1:

```sql
usage_counters (
  scope,
  period_key,
  metric,
  value,
  updated_at
)

usage_state (
  key,
  value,
  updated_at
)
```

Ciphertext objects are stored in R2:

```text
/messages/{id}/payload.bin
/messages/{id}/files/{index}.bin
```

## Security Boundaries

- The platform cannot read message bodies or attachment plaintext
- The platform does not provide sender or reader anonymity
- The platform does not perform attachment malware scanning
- If multiple recipients fetch ciphertext before the message burns, they may all decrypt it offline later; this is an expected limitation of the current "GET does not burn" model
