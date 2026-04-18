# Deployment

## GitHub Actions

仓库包含两条 workflow：

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

`CI` 会在 `pull_request` 和 `push main` 时执行测试并生成 `build-manifest.json`。

`Deploy` 会在 `push main` 时自动部署到 `production`，也支持手工触发并选择 `staging` / `production`。

当前 `Deploy` workflow 会按以下顺序执行：

1. 构建前端产物
2. 对目标环境执行 `wrangler d1 migrations apply DB --remote --env <environment>`
3. 执行 `wrangler deploy --env <environment>`

## 必需的 GitHub Secrets

根据 Cloudflare 官方 GitHub Actions 文档，CI/CD 至少需要以下 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` 这里应使用 Cloudflare **API Token**，不是 Global API Key。

### `CLOUDFLARE_API_TOKEN` 最小权限

当前仓库的部署 workflow 会上传 Worker 与静态资源，并在部署前对目标环境执行远端 D1 migrations。CI 中**不会**创建或删除 D1 / R2 资源本身，但会修改目标 D1 的 schema（以及未来 migration 中可能包含的数据变更）。

因此，当前仓库当前已验证的最小可用范围应为：

- `Account` 权限：`Workers Scripts Write`
- `Account` 权限：`Workers R2 Storage Read`
- `Account` 权限：`D1 Write`
- `Account Resources`：只选目标 Cloudflare account

Cloudflare 控制台里该权限有时会显示为 `Workers Scripts Edit`，API 文档中通常写作 `Workers Scripts Write`。

类似地，部分控制台界面可能把 `Read` / `Write` 显示成 `Read` / `Edit`。

之所以还需要 `Workers R2 Storage Read`，是因为当前 Worker 绑定了现有 R2 bucket。实际部署时，Cloudflare / Wrangler 会校验该 bucket，因此仅有 `Workers Scripts Write` 不够；没有 R2 读取权限时，会报类似下面的错误：

- `A request to the Cloudflare API (/accounts/{account_id}/r2/buckets/<bucket_name>) failed`

当前仓库没有配置 `routes`、自定义域名、KV、Queues 等资源，所以默认**不需要**这些额外权限：

- `Workers R2 Storage Write`
- `Workers Routes Write`

补充说明：

- Cloudflare Workers 上传 API 文档将 `PUT /accounts/{account_id}/workers/scripts/{script_name}` 的接受权限标注为 `Workers Scripts Write`。
- 当前仓库的真实部署报错表明：对已绑定的 R2 bucket，部署阶段仍需要读取该 bucket 的权限。
- 当前 workflow 在部署前会执行远端 D1 migrations，因此 token 还必须具备 `D1 Write`。
- 当前 `wrangler.toml` 中的 R2 绑定不会在 CI 中创建或修改 bucket，所以通常只需要 `Workers R2 Storage Read`，不需要 `Workers R2 Storage Write`。

如果后续把更多 Cloudflare 资源管理动作放进 CI，再按需追加权限：

- 如果你移除了自动 migrations，但仍需在 CI 查询 D1 元数据：可额外增加 `D1 Read`
- 需要在 CI 中创建或修改 R2 bucket：增加 `Workers R2 Storage Write`
- 需要在 CI 中发布 `routes`：增加 `Workers Routes Write`，并把资源范围收敛到对应 Zone

参考：

- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Upload Worker Module API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [List R2 Buckets API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)
- [Get D1 Database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
- [Create D1 Database API](https://developers.cloudflare.com/api/operations/cloudflare-d1-create-database)
- [Create R2 Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)
- [Create Route API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/)
- [GitHub Actions secrets CLI](https://docs.github.com/actions/reference/encrypted-secrets?tool=cli)

## 本地检查

可以把本地值放到 `.dev.vars` 或 `.env`，然后执行：

```bash
npm run github:secrets:check
```

如果要把它们推到 GitHub 仓库 secrets：

```bash
npm run github:secrets:sync -- owner/repo
```

脚本会从以下位置按顺序读取：

1. 当前 shell 环境变量
2. `.dev.vars`
3. `.env`

## Cloudflare 资源

当前仓库定义了两个 Wrangler 环境：

- `production`
- `staging`

在 [wrangler.toml](/Users/brilliant/repo/privmsg/wrangler.toml) 中，你仍需填入真实资源：

- `database_id`
- `bucket_name`
- `preview_bucket_name`

这些值不是高敏感密钥，但如果你不想公开暴露，也可以改成只在私有仓库中维护，或由 CI 生成配置文件再部署。

## D1 Migrations

当前仓库的 D1 schema 以 [`migrations/0001_init_messages.sql`](/Users/brilliant/repo/privmsg/migrations/0001_init_messages.sql) 为单一来源。

- 本地开发库初始化：`npm run db:migrate:local`
- 手动初始化 staging：`npm run db:migrate:staging`
- 手动初始化 production：`npm run db:migrate:production`

只要通过 GitHub Actions 执行 `Deploy`，目标环境的 pending migrations 会在 Worker 发布前自动应用。
