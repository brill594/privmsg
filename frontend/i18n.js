export const SUPPORTED_LOCALES = ["zh", "en"];
const STORAGE_KEY = "privmsg.locale";

function formatProgressBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function detectInitialLocale() {
  if (typeof window !== "undefined") {
    const storedLocale = window.localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED_LOCALES.includes(storedLocale)) {
      return storedLocale;
    }
  }

  const language = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "zh";
  return language.startsWith("zh") ? "zh" : "en";
}

export function persistLocale(locale) {
  if (typeof window !== "undefined" && SUPPORTED_LOCALES.includes(locale)) {
    window.localStorage.setItem(STORAGE_KEY, locale);
  }
}

export const messages = {
  zh: {
    appName: "privmsg",
    localeLabel: "中文",
    localeOptions: {
      zh: "中文",
      en: "English"
    },
    footer: {
      legal: "免责声明与使用守则",
      home: "返回主页"
    },
    ttlOptions: [
      { label: "1 小时", value: 3600 },
      { label: "3 小时", value: 10800 },
      { label: "6 小时", value: 21600 },
      { label: "12 小时", value: 43200 },
      { label: "24 小时", value: 86400 },
      { label: "3 天", value: 259200 },
      { label: "7 天", value: 604800 }
    ],
    composer: {
      title: "创建私密消息",
      bodyLabel: "文本内容",
      bodyPlaceholder: "输入要加密的消息内容，可留空，仅发送附件。",
      attachmentsLabel: "附件",
      chooseFiles: "选择文件",
      expiresLabel: "未读失效时间",
      maxReadsLabel: "最大访问次数",
      summaryLabel: "附件摘要",
      create: "本地加密并生成分享链接",
      creating: "正在创建中…",
      shareTitle: "分享链接",
      copyLink: "复制链接",
      initialStatus: "输入文本或附件后，浏览器会先完成本地加密，再上传密文。",
      requestingServerKey: "正在向服务端申请本次加密所需的密钥 share…",
      encryptMessage: "正在本地加密消息正文…",
      encryptAttachment: (index, total, name) => `正在加密附件 ${index + 1}/${total}: ${name}`,
      uploading: "正在上传密文…",
      created: (maxReads) => `消息已创建。最多可成功读取 ${maxReads} 次，请完整分享这条链接。`,
      copied: "链接已复制到剪贴板。",
      copyFailed: "无法直接访问剪贴板，请手动复制链接。",
      noFiles: "尚未选择附件。",
      selectedFiles: (count, size) => `已选择 ${count} 个附件，总计 ${size}。`,
      enhanced: {
        toggleLabel: "增强加密",
        toggleHint: "启用后，消息会先用接收方的 X25519 公钥做一次本地加密，再进入现有的一次性链接加密。",
        bootstrapLabel: "增强加密资源",
        bootstrapIdle: "勾选后会从服务端拉取本地生成密钥所需资源。",
        bootstrapProgress: (loaded, total) =>
          total
            ? `正在拉取增强加密资源：${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`
            : `正在拉取增强加密资源：已接收 ${formatProgressBytes(loaded)}`,
        bootstrapReadyInline: (version) => `增强加密资源已就绪，版本 ${version}。`,
        retryBootstrap: "重新拉取",
        generateTitle: "生成本地 X25519 密钥对",
        generateHint: "私钥会直接下载到本地文件，服务端不会保存。公钥会保留在页面上供复制。",
        generateButton: "生成 X25519 公私钥",
        privateKeyDownloaded: (name) => `私钥已下载为 ${name}。请妥善保存，解密增强加密消息时需要它。`,
        publicKeyLabel: "我的公钥",
        copyPublicKey: "复制公钥",
        publicKeyPlaceholder: "点击上方按钮生成公私钥后，这里会长期显示你的公钥。",
        recipientPublicKeyLabel: "接收方公钥",
        recipientPublicKeyPlaceholder: "填入接收方的 X25519 公钥（base64url）。系统会先做一次 X25519 加密，再进行二次加密。",
        generatingKeyPair: "正在本地生成 X25519 公私钥…",
        keyPairReady: (name) => `X25519 密钥对已生成，私钥文件 ${name} 已下载。`,
        publicKeyCopied: "公钥已复制到剪贴板。",
        publicKeyCopyFailed: "无法直接复制公钥，请手动复制。",
        encryptMessage: "正在执行第一次 X25519 加密…",
        encryptAttachment: (index, total, name) => `正在执行第一次附件加密 ${index + 1}/${total}: ${name}`,
        errors: {
          bootstrapFailed: "增强加密资源拉取失败。",
          keyGenerationFailed: "X25519 密钥生成失败。"
        }
      },
      validation: {
        emptyDraft: "至少填写文本或选择一个附件。",
        exceedsSize: "附件总大小不能超过 50MB。",
        unsupportedType: (name) => `不支持的附件类型: ${name}`,
        missingRecipientPublicKey: "已启用增强加密，请先填写接收方公钥。",
        invalidRecipientPublicKey: "接收方公钥无效，请检查格式后重试。"
      },
      errors: {
        serverKeyBootstrapFailed: "无法获取服务端密钥 share。",
        createFailed: "创建失败。"
      }
    },
    reader: {
      title: "密文内容",
      previewTitle: "附件预览",
      bodyTitle: "消息正文",
      attachmentsTitle: "已解密附件",
      waitingBody: "等待解密…",
      emptyBody: "无文字消息。",
      previewPlaceholder: "选择一个已解密附件进行预览。",
      initialStatus: "打开链接后会先获取密文，再在本地解密。",
      fetching: "正在获取密文…",
      fetchingAttachments: "正在预取附件密文…",
      requestingAccessKey: "正在向服务端申请本次解密授权…",
      decryptingMessage: "正在本地解密正文…",
      selectPrivateKey: "检测到增强加密，请先选择本地私钥文件。",
      decryptingOuterMessage: "正在解开外层一次性链接加密…",
      decryptingEnhancedMessage: "正在执行 X25519 内层解密…",
      decryptingAttachment: (name) => `正在解密附件: ${name}`,
      decryptingOuterAttachment: (name) => `正在解开附件外层加密: ${name}`,
      decryptingEnhancedAttachment: (name) => `正在执行附件 X25519 解密: ${name}`,
      burned: "消息已在本地解密，本次读取已达到访问上限，服务端已完成焚毁。",
      remaining: (count) => `消息已在本地解密，本次访问已确认，还剩 ${count} 次可读。`,
      unavailable: "无法显示消息内容。",
      noAttachments: "这条消息没有附件。",
      summary: (count) => `已解密 ${count} 个附件。`,
      expandPreview: "查看大图",
      closeExpandedPreview: "关闭预览",
      previewTruncated: "[预览已截断。请下载附件查看完整内容。]",
      privateKeyPromptTitle: "选择增强加密私钥",
      privateKeyPromptBody: "这条消息使用了增强加密。请先选择本地私钥文件，系统会先解开外层加密，再继续执行 X25519 解密。",
      privateKeyPromptCancel: "取消",
      privateKeyPromptChoose: "选择私钥文件",
      privateKeySelected: (name) => `已选择私钥文件: ${name}`,
      errors: {
        missingMessageId: "缺少消息 ID。",
        missingDecryptionKey: "缺少解密密钥。",
        invalidDecryptionKey: "链接中的本地密钥 share 无效。",
        readFailed: "读取失败。",
        fetchAttachmentFailed: (name) => `无法获取附件: ${name}`,
        missingAttachmentEnvelope: (index) => `缺少附件 ${index} 的加密封装信息。`,
        missingEnhancedAttachmentEnvelope: (index) => `缺少附件 ${index} 的增强加密封装信息。`,
        invalidEnhancedEnvelope: "增强加密封装信息无效。",
        privateKeyRequired: "未选择私钥文件，无法继续解密增强加密消息。",
        invalidPrivateKey: "私钥文件无效，请重新选择正确的 X25519 私钥文件。",
        accessKeyFailed: "申请解密授权失败。",
        invalidAccessKey: "服务端返回的解密授权无效。",
        decryptFailed: "解密失败。"
      }
    },
    common: {
      preview: "预览",
      download: "下载",
      attachmentTypeFallback: "application/octet-stream",
      sizeUnitTypes: "jpg / png / webp / gif / mp4 / webm / mov / txt / pdf"
    },
    policy: {
      title: "免责声明与使用守则",
      intro: "使用本服务前，请先了解隐私边界、附件风险和平台职责范围。",
      sections: [
        {
          title: "免责声明",
          items: [
            "平台无法直接读取消息正文、附件明文或链接 fragment 中的本地密钥 share。",
            "平台不提供匿名保护，也不提供防截图、撤回缓存或防二次传播能力。",
            "平台不做附件安全扫描，不保证附件本身安全无害。"
          ]
        },
        {
          title: "使用守则",
          items: [
            "请仅向你信任的接收者分享完整链接，并自行判断附件来源是否可信。",
            "请勿将本服务用于非法内容传播、恶意软件分发或侵犯他人权益的用途。",
            "本服务适合短期私密投递，不应作为长期存储或合规归档工具。"
          ]
        },
        {
          title: "安全边界",
          items: [
            "附件总大小上限为 50MB，支持类型包括 jpg、png、webp、gif、mp4、webm、mov、txt、pdf。",
            "未读失效时间支持 1 小时到 7 天；访问次数支持 1 到 20 次。",
            "只有服务端发放一次解密授权时才会扣减访问次数；普通获取密文不会扣减。",
            "若在次数耗尽前链接被多人持有，多人都可能在额度内完成解密。"
          ]
        }
      ]
    }
  },
  en: {
    appName: "privmsg",
    localeLabel: "English",
    localeOptions: {
      zh: "中文",
      en: "English"
    },
    footer: {
      legal: "Disclaimer & Usage Rules",
      home: "Back to Home"
    },
    ttlOptions: [
      { label: "1 hour", value: 3600 },
      { label: "3 hours", value: 10800 },
      { label: "6 hours", value: 21600 },
      { label: "12 hours", value: 43200 },
      { label: "24 hours", value: 86400 },
      { label: "3 days", value: 259200 },
      { label: "7 days", value: 604800 }
    ],
    composer: {
      title: "Create Private Message",
      bodyLabel: "Message",
      bodyPlaceholder: "Type the message to encrypt. You can leave this empty and send attachments only.",
      attachmentsLabel: "Attachments",
      chooseFiles: "Choose files",
      expiresLabel: "Unread expiration",
      maxReadsLabel: "Max reads",
      summaryLabel: "Attachment summary",
      create: "Encrypt locally and generate link",
      creating: "Creating…",
      shareTitle: "Share link",
      copyLink: "Copy link",
      initialStatus: "Your browser encrypts the message locally before any ciphertext is uploaded.",
      requestingServerKey: "Requesting the server-side key share for this message…",
      encryptMessage: "Encrypting message locally…",
      encryptAttachment: (index, total, name) => `Encrypting attachment ${index + 1}/${total}: ${name}`,
      uploading: "Uploading ciphertext…",
      created: (maxReads) => `Message created. Share the full link. It can be successfully opened up to ${maxReads} time(s).`,
      copied: "Link copied to clipboard.",
      copyFailed: "Clipboard access failed. Please copy the link manually.",
      noFiles: "No attachment selected.",
      selectedFiles: (count, size) => `${count} attachment(s) selected, total ${size}.`,
      enhanced: {
        toggleLabel: "Enhanced encryption",
        toggleHint: "When enabled, the browser first encrypts locally with the recipient's X25519 public key, then applies the existing one-time-link encryption.",
        bootstrapLabel: "Enhanced encryption resources",
        bootstrapIdle: "After enabling this option, the page fetches the resources needed to generate keys locally.",
        bootstrapProgress: (loaded, total) =>
          total
            ? `Fetching enhanced-encryption resources: ${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`
            : `Fetching enhanced-encryption resources: received ${formatProgressBytes(loaded)}`,
        bootstrapReadyInline: (version) => `Enhanced-encryption resources are ready. Version: ${version}.`,
        retryBootstrap: "Retry fetch",
        generateTitle: "Generate a local X25519 key pair",
        generateHint: "The private key is downloaded to a local file and is never uploaded. The public key stays visible here for copying.",
        generateButton: "Generate X25519 key pair",
        privateKeyDownloaded: (name) => `Private key downloaded as ${name}. Keep it safe: it is required to decrypt enhanced-encryption messages.`,
        publicKeyLabel: "My public key",
        copyPublicKey: "Copy public key",
        publicKeyPlaceholder: "Generate a key pair to keep your public key visible here for future copy/paste.",
        recipientPublicKeyLabel: "Recipient public key",
        recipientPublicKeyPlaceholder: "Paste the recipient's X25519 public key (base64url). The browser encrypts with X25519 first, then applies the second encryption layer.",
        generatingKeyPair: "Generating the local X25519 key pair…",
        keyPairReady: (name) => `X25519 key pair generated. The private key file ${name} has been downloaded.`,
        publicKeyCopied: "Public key copied to clipboard.",
        publicKeyCopyFailed: "Clipboard access failed. Please copy the public key manually.",
        encryptMessage: "Running the first X25519 encryption pass…",
        encryptAttachment: (index, total, name) => `Running the first attachment encryption pass ${index + 1}/${total}: ${name}`,
        errors: {
          bootstrapFailed: "Failed to fetch enhanced-encryption resources.",
          keyGenerationFailed: "Failed to generate the X25519 key pair."
        }
      },
      validation: {
        emptyDraft: "Enter a message or select at least one attachment.",
        exceedsSize: "Total attachment size must not exceed 50MB.",
        unsupportedType: (name) => `Unsupported attachment type: ${name}`,
        missingRecipientPublicKey: "Enhanced encryption is enabled. Enter the recipient public key first.",
        invalidRecipientPublicKey: "The recipient public key is invalid. Check the format and try again."
      },
      errors: {
        serverKeyBootstrapFailed: "Unable to obtain the server key share.",
        createFailed: "Create failed."
      }
    },
    reader: {
      title: "Encrypted Content",
      previewTitle: "Attachment Preview",
      bodyTitle: "Message",
      attachmentsTitle: "Decrypted Attachments",
      waitingBody: "Waiting for decryption…",
      emptyBody: "No text message.",
      previewPlaceholder: "Select a decrypted attachment to preview.",
      initialStatus: "The page fetches ciphertext first, then decrypts everything locally.",
      fetching: "Fetching ciphertext…",
      fetchingAttachments: "Preloading attachment ciphertext…",
      requestingAccessKey: "Requesting the server-side decryption authorization…",
      decryptingMessage: "Decrypting message locally…",
      selectPrivateKey: "Enhanced encryption detected. Choose the local private key file first.",
      decryptingOuterMessage: "Decrypting the outer one-time-link layer…",
      decryptingEnhancedMessage: "Decrypting the inner X25519 layer…",
      decryptingAttachment: (name) => `Decrypting attachment: ${name}`,
      decryptingOuterAttachment: (name) => `Decrypting the outer attachment layer: ${name}`,
      decryptingEnhancedAttachment: (name) => `Decrypting the X25519 attachment layer: ${name}`,
      burned: "The message was decrypted locally and the final allowed read has been consumed. The server has burned it.",
      remaining: (count) => `The message was decrypted locally. This access is confirmed, and ${count} read(s) remain.`,
      unavailable: "Unable to display the message.",
      noAttachments: "This message has no attachments.",
      summary: (count) => `${count} attachment(s) decrypted.`,
      expandPreview: "Open large preview",
      closeExpandedPreview: "Close preview",
      previewTruncated: "[Preview truncated. Download the file to view the full content.]",
      privateKeyPromptTitle: "Choose the enhanced-encryption private key",
      privateKeyPromptBody: "This message uses enhanced encryption. Select the local private key file first. The page will decrypt the outer layer first, then continue with X25519 decryption.",
      privateKeyPromptCancel: "Cancel",
      privateKeyPromptChoose: "Choose private key file",
      privateKeySelected: (name) => `Selected private key file: ${name}`,
      errors: {
        missingMessageId: "Missing message id.",
        missingDecryptionKey: "Missing decryption key.",
        invalidDecryptionKey: "The local key share in the link is invalid.",
        readFailed: "Read failed.",
        fetchAttachmentFailed: (name) => `Unable to fetch attachment: ${name}`,
        missingAttachmentEnvelope: (index) => `Missing encrypted envelope for attachment ${index}.`,
        missingEnhancedAttachmentEnvelope: (index) => `Missing enhanced-encryption envelope for attachment ${index}.`,
        invalidEnhancedEnvelope: "The enhanced-encryption envelope is invalid.",
        privateKeyRequired: "No private key file was selected, so the enhanced-encryption message cannot be decrypted.",
        invalidPrivateKey: "The private key file is invalid. Choose the correct X25519 private key file and try again.",
        accessKeyFailed: "Failed to request the decryption authorization.",
        invalidAccessKey: "The server returned an invalid decryption authorization.",
        decryptFailed: "Decrypt failed."
      }
    },
    common: {
      preview: "Preview",
      download: "Download",
      attachmentTypeFallback: "application/octet-stream",
      sizeUnitTypes: "jpg / png / webp / gif / mp4 / webm / mov / txt / pdf"
    },
    policy: {
      title: "Disclaimer & Usage Rules",
      intro: "Please review the privacy boundaries, attachment risks, and platform responsibilities before using this service.",
      sections: [
        {
          title: "Disclaimer",
          items: [
            "The platform cannot directly read message plaintext, attachment plaintext, or the local key share stored in the URL fragment.",
            "The platform does not provide anonymity, screenshot prevention, cache revocation, or redistribution prevention.",
            "The platform does not scan attachments and cannot guarantee that attachments are safe."
          ]
        },
        {
          title: "Usage Rules",
          items: [
            "Only share the complete link with recipients you trust, and judge attachment sources on your own.",
            "Do not use this service for illegal distribution, malware delivery, or any activity that infringes on others' rights.",
            "This service is for short-lived private delivery, not for long-term storage or compliance archiving."
          ]
        },
        {
          title: "Security Boundaries",
          items: [
            "Total attachment size is capped at 50MB. Supported types are jpg, png, webp, gif, mp4, webm, mov, txt, and pdf.",
            "Unread expiration ranges from 1 hour to 7 days. Access count ranges from 1 to 20 reads.",
            "A read is only consumed when the server issues a decryption authorization. Plain ciphertext fetches do not consume reads.",
            "If multiple people hold the link before the read quota is exhausted, multiple recipients may decrypt it within the remaining quota."
          ]
        }
      ]
    }
  }
};
