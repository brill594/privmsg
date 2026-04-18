# privmsg

[中文](./README.md) | English

`privmsg` is a one-time message sharing product for sensitive information. Encryption and decryption happen in the browser, while the server stores only ciphertext and the minimum metadata needed to enforce access rules. It is suitable for short text, documents, images, and a small set of attachments, with access limits and optional password protection.

Related docs:

- Deployment guide (English): [docs/deployment.en.md](./docs/deployment.en.md)
- 部署说明（中文）: [docs/deployment.md](./docs/deployment.md)

## Product Features

- Browser-side encryption and decryption with a zero-knowledge server model
- URL fragments contain only the local key share for direct link sharing
- Support for text plus multiple attachments, up to `50MB` in total
- Configurable max access count, currently from `1` to `20`
- Optional password protection before the server returns decryption authorization
- All API responses include `Cache-Control: no-store`
- Supported types: `jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `txt` `pdf` `pk8`

## How It Works

1. The sender writes a message and optionally adds attachments.
2. The sender can set a max access count and an optional password.
3. A shareable link is generated.
4. The recipient opens the link and decrypts the content in the browser.

## Privacy and Security Boundaries

- The platform cannot read message bodies or attachment plaintext
- The platform does not provide sender or reader anonymity
- The platform does not perform attachment malware scanning
- Recipients fetch ciphertext first, then request a one-time decryption grant; the server decrements remaining access count atomically before returning its key share
- If multiple recipients obtain ciphertext before the message burns, they may still decrypt it offline later; this is an expected limitation of the current access model

## Self-Hosting

The project is built on Cloudflare Workers, D1, and R2. For deployment details, go straight to the operator docs:

- English: [docs/deployment.en.md](./docs/deployment.en.md)
- 中文: [docs/deployment.md](./docs/deployment.md)
