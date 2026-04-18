# privmsg

一个与 PRD 对齐的 MVP：基于 Vue 构建的纯 Web 前端，客户端加密、服务端零知识、支持文本与多附件，并支持可配置访问次数限制的阅后即焚消息服务。

## 当前实现范围

- 浏览器端使用 `AES-GCM` + `HKDF(SHA-256)` 完成加密与解密
- 主密钥只存在于 URL fragment：`/m/<id>#<master_key>`
- 服务端 API：
  - `POST /api/create`
  - `GET /api/message/:id`
  - `GET /api/message/:id/file/:index`
  - `POST /api/confirm-read`
- 附件总大小限制 `<= 50MB`
- 发送端可设置最大访问次数，当前范围 `1 - 20`
- 支持类型：`jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `txt` `pdf`
- 消息读取端先拉取并本地解密所有密文，成功后才调用 `confirm-read`
- 所有 API 响应都携带 `Cache-Control: no-store`
- GitHub Actions CI / Deploy 工作流已接入
- D1 schema 已切换到 `migrations/` 管理
- 提供 GitHub Secrets 本地检查与同步脚本
- 固定 Node `22.22.2` 与 Wrangler `4.83.0`
- 前端已切换为 `Vue 3 + Vite`

## 还未补齐的 PRD 项

- 真正的 PDF.js 预览：当前版本先用隔离 iframe 承载 PDF 预览
- IP 限流 / 创建频率限制
- 定时清理已过期但尚未读取的对象
- 更完整的构建一致性校验（例如锁定 wrangler / node 版本并附带发布 hash）

## 本地启动

1. 使用 [`.nvmrc`](/Users/brilliant/repo/privmsg/.nvmrc) 切到固定 Node 版本，然后安装依赖

```bash
nvm use
npm install
```

2. 创建 D1 / R2 资源，并把真实 ID 写入 [wrangler.toml](/Users/brilliant/repo/privmsg/wrangler.toml)

```bash
npx wrangler d1 create privmsg
npx wrangler r2 bucket create privmsg-payloads
npx wrangler r2 bucket create privmsg-payloads-preview
```

3. 初始化本地 D1 开发库

```bash
npm run db:migrate:local
```

如果你新建了远端数据库，但暂时不想等 GitHub Actions 自动部署，也可以手动对远端环境补 migration：

```bash
npm run db:migrate:staging
npm run db:migrate:production
```

`Deploy` workflow 现在会在部署前自动执行目标环境的 D1 migrations，所以正常情况下不再需要手动执行初始化 SQL。

4. 启动前端开发环境

```bash
npm run dev
```

5. 如需调试 Worker API

```bash
npm run dev:worker
```

## 测试

```bash
npm test
```

构建前端产物：

```bash
npm run build
```

## GitHub Secrets

部署 workflow 需要以下 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

其中 `CLOUDFLARE_API_TOKEN` 应使用 Cloudflare API Token，不是 Global API Key。当前仓库部署已验证需要至少 `Account -> Workers Scripts Write`、`Account -> Workers R2 Storage Read`、`Account -> D1 Write`，并将资源范围限制在目标 account。更完整说明见 [docs/deployment.md](/Users/brilliant/repo/privmsg/docs/deployment.md)。

可先在本地检查：

```bash
npm run github:secrets:check
```

若本机已完成 `gh auth login`，也可以直接同步到指定仓库：

```bash
npm run github:secrets:sync -- owner/repo
```

更多说明见 [docs/deployment.md](/Users/brilliant/repo/privmsg/docs/deployment.md)。

## 数据模型

消息元数据保存在 D1：

```sql
messages (
  id,
  attachment_count,
  total_size,
  max_reads,
  read_count,
  created_at,
  expires_at,
  burned
)
```

密文对象保存在 R2：

```text
/messages/{id}/payload.bin
/messages/{id}/files/{index}.bin
```

## 安全边界

- 平台无法读取消息正文或附件明文
- 平台不提供匿名保护
- 平台不做附件安全扫描
- 若多个接收者在焚毁前同时拉取了密文，他们都可能离线解密；这属于“GET 不销毁”模型下的已知边界
