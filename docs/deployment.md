# Deployment

中文 | [English](./deployment.en.md)

## GitHub Actions

仓库包含两条 workflow：

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

`CI` 会在 `pull_request` 和 `push main` 时执行测试，并上传构建产物。

`Deploy` 会在 `push main` 时自动部署到 `production`，也支持手工触发并选择 `staging` / `production`。

当前 `Deploy` workflow 的顺序如下：

1. 构建前端产物
2. 校验 GitHub Secrets 与可选的 GitHub Variables
3. 对目标环境执行 `wrangler d1 migrations apply DB --remote --env <environment>`
4. 执行 `wrangler deploy --env <environment>`，并通过 `--var` 注入 GitHub Variables

## 必需的 GitHub Secrets

部署至少需要以下 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` 应使用 Cloudflare **API Token**，不是 Global API Key。

### 推荐的最小权限

如果 CI 只负责发布 Worker、校验已有 R2 绑定，并在部署前执行 D1 migrations，可从下面这组权限开始：

- `Account` / `Workers Scripts Write`
- `Account` / `Workers R2 Storage Read`
- `Account` / `D1 Write`
- 资源范围限制在目标 Cloudflare account 或更小的资源集合

Cloudflare 控制台与文档中的权限名称可能略有差异，例如 `Write` / `Edit` 的表述不同；以控制台可配置项为准。

如果后续把更多 Cloudflare 资源管理动作放进 CI，再按需追加权限。例如：

- 创建或修改 R2 bucket：增加 `Workers R2 Storage Write`
- 发布 routes：增加 `Workers Routes Write`
- 只读取 D1 元数据：增加 `D1 Read`

参考：

- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Upload Worker Module API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [Get D1 Database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
- [GitHub Actions secrets CLI](https://docs.github.com/actions/reference/encrypted-secrets?tool=cli)

## 本地检查

可以把本地值放到 `.dev.vars` 或 `.env`，然后执行：

```bash
npm run github:secrets:check
npm run github:variables:check
```

如果要把它们同步到 GitHub 仓库：

```bash
npm run github:secrets:sync -- owner/repo
npm run github:variables:sync -- owner/repo
```

脚本会按以下顺序读取：

1. 当前 shell 环境变量
2. `.dev.vars`
3. `.env`

## GitHub Variables

用量上限属于非敏感配置，当前通过 GitHub Variables 注入 Worker。由于 deploy job 绑定了 GitHub `environment`，推荐直接在 `production` / `staging` 环境级别配置这些变量，以便两个环境独立设置阈值。

当前支持的变量如下：

- `USAGE_LIMIT_D1_ROWS_READ_DAILY`
- `USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY`
- `USAGE_LIMIT_D1_STORAGE_GB`
- `USAGE_LIMIT_R2_CLASS_A_MONTHLY`
- `USAGE_LIMIT_R2_CLASS_B_MONTHLY`
- `USAGE_LIMIT_R2_STORAGE_GB_MONTH`

这些变量全部是可选的；未设置时，对应指标只统计不拦截。

当前实现的统计口径：

- D1：按 query `meta.rows_read` / `meta.rows_written` 统计每日读写量，并记录最近一次 query `meta.size_after` 作为当前数据库大小
- R2：按 Worker 实际执行的 `put` / `get` 统计 Class A / Class B；按对象大小与生存时间窗口估算当月 `GB-month`

这些数字用于保护性限额，目标是尽早阻断超量趋势，不是替代 Cloudflare 控制台或 GraphQL Analytics 的最终账单数据。

建议根据当前 Cloudflare 套餐额度与团队预算设置这些值，而不是把公开文档中的示例额度直接当作长期固定配置。

`GET /api/usage` 会返回当前统计值、窗口与已配置限额，适合在部署后观测是否接近阈值。

## Cloudflare 资源

当前仓库定义了两个 Wrangler 环境：

- `production`
- `staging`

部署前请检查 [`wrangler.toml`](../wrangler.toml)，确保其中的 D1 / R2 绑定与目标环境一致。若仓库计划公开发布，建议不要在公开文档中记录账号专属资源标识，并根据需要将环境差异改为私有配置或 CI 注入。

## D1 Migrations

当前仓库的 D1 schema 以 [`migrations/`](../migrations/) 目录为单一来源。

- 本地开发库初始化：`npm run db:migrate:local`
- 手动初始化 staging：`npm run db:migrate:staging`
- 手动初始化 production：`npm run db:migrate:production`

通过 GitHub Actions 执行 `Deploy` 时，目标环境的 pending migrations 会在 Worker 发布前自动应用。
