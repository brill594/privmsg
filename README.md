# privmsg

中文 | [English](./README.en.md)

`privmsg` 是一个面向敏感信息分享的一次性消息服务。消息在浏览器内完成加密，服务端只保存密文与必要元数据，适合发送短文本、图片、文档和少量附件，并支持访问次数限制与可选密码保护。

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
- 当前支持类型：`jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `txt` `pdf` `pk8`

## 使用方式

1. 发送者填写消息内容，并可附加文件。
2. 按需设置访问次数上限与访问密码。
3. 生成链接后将其发送给接收者。
4. 接收者打开链接，在浏览器内完成解密与查看。

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
