export const SUPPORTED_LOCALES = ["zh", "en"];
const STORAGE_KEY = "privmsg.locale";

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
      encryptMessage: "正在本地加密消息正文…",
      encryptAttachment: (index, total, name) => `正在加密附件 ${index + 1}/${total}: ${name}`,
      uploading: "正在上传密文…",
      created: (maxReads) => `消息已创建。最多可成功读取 ${maxReads} 次，请完整分享这条链接。`,
      copied: "链接已复制到剪贴板。",
      copyFailed: "无法直接访问剪贴板，请手动复制链接。",
      noFiles: "尚未选择附件。",
      selectedFiles: (count, size) => `已选择 ${count} 个附件，总计 ${size}。`,
      validation: {
        emptyDraft: "至少填写文本或选择一个附件。",
        exceedsSize: "附件总大小不能超过 50MB。",
        unsupportedType: (name) => `不支持的附件类型: ${name}`
      }
    },
    reader: {
      title: "读取并确认焚毁",
      previewTitle: "附件预览",
      bodyTitle: "消息正文",
      attachmentsTitle: "已解密附件",
      waitingBody: "等待解密…",
      emptyBody: "无文字消息。",
      previewPlaceholder: "选择一个已解密附件进行预览。",
      initialStatus: "打开链接后会先获取密文，再在本地解密。",
      fetching: "正在获取密文…",
      decryptingMessage: "正在本地解密正文…",
      decryptingAttachment: (name) => `正在解密附件: ${name}`,
      confirming: "正在确认焚毁…",
      burned: "消息已在本地解密，本次读取已达到访问上限，服务端已完成焚毁。",
      remaining: (count) => `消息已在本地解密，本次访问已确认，还剩 ${count} 次可读。`,
      unavailable: "无法显示消息内容。",
      noAttachments: "这条消息没有附件。",
      summary: (count) => `已解密 ${count} 个附件。`
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
            "平台无法读取消息正文、附件明文或链接 fragment 中的主密钥。",
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
            "只有成功解密后提交 confirm-read 才会扣减访问次数；普通获取密文不会扣减。",
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
      encryptMessage: "Encrypting message locally…",
      encryptAttachment: (index, total, name) => `Encrypting attachment ${index + 1}/${total}: ${name}`,
      uploading: "Uploading ciphertext…",
      created: (maxReads) => `Message created. Share the full link. It can be successfully opened up to ${maxReads} time(s).`,
      copied: "Link copied to clipboard.",
      copyFailed: "Clipboard access failed. Please copy the link manually.",
      noFiles: "No attachment selected.",
      selectedFiles: (count, size) => `${count} attachment(s) selected, total ${size}.`,
      validation: {
        emptyDraft: "Enter a message or select at least one attachment.",
        exceedsSize: "Total attachment size must not exceed 50MB.",
        unsupportedType: (name) => `Unsupported attachment type: ${name}`
      }
    },
    reader: {
      title: "Read and Confirm Burn",
      previewTitle: "Attachment Preview",
      bodyTitle: "Message",
      attachmentsTitle: "Decrypted Attachments",
      waitingBody: "Waiting for decryption…",
      emptyBody: "No text message.",
      previewPlaceholder: "Select a decrypted attachment to preview.",
      initialStatus: "The page fetches ciphertext first, then decrypts everything locally.",
      fetching: "Fetching ciphertext…",
      decryptingMessage: "Decrypting message locally…",
      decryptingAttachment: (name) => `Decrypting attachment: ${name}`,
      confirming: "Confirming read…",
      burned: "The message was decrypted locally and the final allowed read has been consumed. The server has burned it.",
      remaining: (count) => `The message was decrypted locally. This access is confirmed, and ${count} read(s) remain.`,
      unavailable: "Unable to display the message.",
      noAttachments: "This message has no attachments.",
      summary: (count) => `${count} attachment(s) decrypted.`
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
            "The platform cannot read message plaintext, attachment plaintext, or the master key stored in the URL fragment.",
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
            "A read is only consumed after successful local decryption followed by confirm-read. Plain ciphertext fetches do not consume reads.",
            "If multiple people hold the link before the read quota is exhausted, multiple recipients may decrypt it within the remaining quota."
          ]
        }
      ]
    }
  }
};
