# privmsg

中文 | [English](./README.en.md)

`privmsg` 是一个面向敏感信息分享的一次性消息服务。消息在浏览器内完成加密，服务端只保存密文与必要元数据，适合发送短文本、图片、文档和少量附件，并支持访问次数限制与可选密码保护。

部署效果：
[demo](https://privmsg.cc)

相关文档：

- 部署说明（中文）：[docs/deployment.md](./docs/deployment.md)
- Deployment guide (English): [docs/deployment.en.md](./docs/deployment.en.md)

## 产品特性

- 浏览器端完成加密与解密，服务端不接触明文
- 链接 fragment 仅包含本地密钥 share，便于直接分享
- 支持文本与多附件发送，附件总大小限制为 `50MB`
- 支持最大访问次数限制，当前可配置范围为 `1 - 20`
- 支持访问密码保护，服务端在返回解密授权前先校验密码证明
- 所有接口响应均带 `Cache-Control: no-store`
- 不限制具体文件格式，附件总大小限制仍为 `50MB`

## 使用方式

1. 发送者填写消息内容，并可附加文件。
2. 按需设置访问次数上限与访问密码。
3. 生成链接后将其发送给接收者。
4. 接收者打开链接，在浏览器内完成解密与查看。

## CLI

CLI 在本地加密文本，再把密文上传到 `privmsg`：

```sh
npx privmsg-cli create "需要分享的内容"
printf '%s' '需要分享的内容' | npx privmsg-cli create
```

默认只输出分享链接，便于 agent 调用。使用 `--json` 获取结构化结果，使用 `--base-url` 指向自建实例：

```sh
privmsg create --expires-in 86400 --max-reads 1 --json "需要分享的内容"
privmsg create --base-url https://privmsg.example.com "需要分享的内容"
```

原有的 `--server` 参数继续作为 `--base-url` 的兼容别名。

可以将自部署地址保存为当前用户的默认值，之后无需每次传入地址：

```sh
privmsg config set base-url https://privmsg.example.com
privmsg config get base-url
privmsg create "需要分享的内容"
privmsg config reset base-url
```

配置保存在 `~/.config/privmsg/config.json`；设置了 `XDG_CONFIG_HOME` 时使用该目录下的 `privmsg/config.json`。命令行 `--base-url` / `--server` 优先于保存的默认值，重置后恢复为 `https://privmsg.cc`。

CLI 要求 Node.js 22 或更高版本。首版支持文本分享；附件、访问密码和增强 X25519 加密仍通过网页创建。

消息创建接口按 Cloudflare 提供的来源 IP 限制为每分钟 10 次。超限时返回 HTTP `429` 和 `Retry-After: 60`。该计数按 Cloudflare 数据中心执行，属于防滥用保护而非精确计费系统；共享同一出口 IP 的用户会共用额度。

## 隐私与安全边界

- 平台无法读取消息正文或附件明文
- 平台不提供匿名保护
- 平台不做附件安全扫描
- 接收者先获取密文，再请求一次性解密授权；服务端发放授权前会原子扣减剩余访问次数
- 若多个接收者在焚毁前都已获取密文，他们仍可能在本地离线解密；这是当前访问模型的已知边界

## 自建部署

项目基于 Cloudflare Workers、D1 与 R2。若要自行部署，请直接参考部署文档：

- 中文：[docs/deployment.md](./docs/deployment.md)
- English: [docs/deployment.en.md](./docs/deployment.en.md)
