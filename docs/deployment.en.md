# Deployment

[中文](./deployment.md) | English

## GitHub Actions

This repository includes two workflows:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

`CI` runs on `pull_request` and `push main`, executes verification, and uploads build artifacts.

`Deploy` runs automatically on `push main` to `production`, and it can also be triggered manually for either `staging` or `production`.

The current `Deploy` workflow runs in this order:

1. Build the frontend bundle
2. Validate GitHub secrets and optional GitHub variables
3. Run `wrangler d1 migrations apply DB --remote --env <environment>`
4. Run `wrangler deploy --env <environment>` and inject GitHub Variables through `--var`

## Required GitHub Secrets

Deployment requires at least:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` should be a Cloudflare **API Token**, not the Global API Key.

### Recommended Minimum Permissions

If CI only deploys the Worker, validates existing R2 bindings, and applies D1 migrations before release, start with:

- `Account` / `Workers Scripts Write`
- `Account` / `Workers R2 Storage Read`
- `Account` / `D1 Write`
- Scope the token to the target Cloudflare account or a narrower resource set

Permission names can vary slightly between the Cloudflare dashboard and the documentation, especially around `Write` versus `Edit`. Use the dashboard wording that matches the capabilities above.

If CI later manages more Cloudflare resources, add permissions only as needed. For example:

- Create or modify R2 buckets: add `Workers R2 Storage Write`
- Publish routes: add `Workers Routes Write`
- Read D1 metadata only: add `D1 Read`

References:

- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Upload Worker Module API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [Get D1 Database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
- [GitHub Actions secrets CLI](https://docs.github.com/actions/reference/encrypted-secrets?tool=cli)

## Local Validation

You can put local values in `.dev.vars` or `.env`, then run:

```bash
npm run github:secrets:check
npm run github:variables:check
```

To sync them to a GitHub repository:

```bash
npm run github:secrets:sync -- owner/repo
npm run github:variables:sync -- owner/repo
```

The scripts read values in this order:

1. Current shell environment variables
2. `.dev.vars`
3. `.env`

## GitHub Variables

Usage guardrails are non-sensitive configuration values passed into the Worker through GitHub Variables. Because the deploy job is bound to a GitHub `environment`, it is usually best to configure them separately for `production` and `staging`.

Supported variables:

- `USAGE_LIMIT_D1_ROWS_READ_DAILY`
- `USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY`
- `USAGE_LIMIT_D1_STORAGE_GB`
- `USAGE_LIMIT_R2_CLASS_A_MONTHLY`
- `USAGE_LIMIT_R2_CLASS_B_MONTHLY`
- `USAGE_LIMIT_R2_STORAGE_GB_MONTH`

All of them are optional. When unset, the corresponding metric is tracked but not enforced.

Current accounting rules:

- D1: daily reads and writes are derived from query `meta.rows_read` / `meta.rows_written`, and the latest query `meta.size_after` is stored as the current database size
- R2: Class A / Class B counters come from actual Worker `put` / `get` operations; storage is estimated as `GB-month` based on object size and lifetime within the current month

These values are meant to act as protective guardrails, not as a replacement for final billing figures from the Cloudflare dashboard or GraphQL Analytics.

Set the limits according to your current Cloudflare plan and internal budget, rather than treating any public example quotas as a permanent configuration.

`GET /api/usage` returns current counters, windows, and configured limits so you can monitor headroom after deployment.

## Cloudflare Resources

The repository currently defines two Wrangler environments:

- `production`
- `staging`

Review [`wrangler.toml`](../wrangler.toml) before deploying and make sure the D1 / R2 bindings match your own environments. If you plan to publish the repository, avoid documenting account-specific resource identifiers in public-facing docs, and move environment-specific values to private configuration or CI injection when appropriate.

## D1 Migrations

The D1 schema is sourced from [`migrations/`](../migrations/).

- Initialize the local development database: `npm run db:migrate:local`
- Apply staging manually: `npm run db:migrate:staging`
- Apply production manually: `npm run db:migrate:production`

When deployment runs through GitHub Actions, pending migrations are applied automatically before the Worker is published.
