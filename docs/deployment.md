# Deployment

## GitHub Actions

仓库包含两条 workflow：

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

`CI` 会在 `pull_request` 和 `push main` 时执行测试并生成 `build-manifest.json`。

`Deploy` 会在 `push main` 时自动部署到 `production`，也支持手工触发并选择 `staging` / `production`。

## 必需的 GitHub Secrets

根据 Cloudflare 官方 GitHub Actions 文档，CI/CD 至少需要以下 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` 这里应使用 Cloudflare **API Token**，不是 Global API Key。

### `CLOUDFLARE_API_TOKEN` 最小权限

当前仓库的部署 workflow 只做一件事：运行 `wrangler deploy` 上传 Worker 与静态资源，并绑定 `wrangler.toml` 中已经存在的 D1 / R2 资源。CI 中**不会**创建、删除或修改 D1 / R2 资源本身。

因此，当前仓库推荐把 token 收敛到以下最小范围：

- `Account` 权限：`Workers Scripts Write`
- `Account Resources`：只选目标 Cloudflare account

Cloudflare 控制台里该权限有时会显示为 `Workers Scripts Edit`，API 文档中通常写作 `Workers Scripts Write`。

当前仓库没有配置 `routes`、自定义域名、KV、Queues 等资源，所以默认**不需要**这些额外权限：

- `D1 Write`
- `Workers R2 Storage Write`
- `Workers Routes Write`

补充说明：

- Cloudflare Workers 上传 API 文档将 `PUT /accounts/{account_id}/workers/scripts/{script_name}` 的接受权限标注为 `Workers Scripts Write`。
- 当前 `wrangler.toml` 中的 D1 / R2 绑定只是把既有资源引用进 Worker 配置，不等于在 CI 中管理这些资源。

如果后续把更多 Cloudflare 资源管理动作放进 CI，再按需追加权限：

- 需要在 CI 中创建、迁移、修改或远程查询 D1：增加 `D1 Write`
- 需要在 CI 中创建或修改 R2 bucket：增加 `Workers R2 Storage Write`
- 需要在 CI 中发布 `routes`：增加 `Workers Routes Write`，并把资源范围收敛到对应 Zone

参考：

- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Upload Worker Module API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
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
