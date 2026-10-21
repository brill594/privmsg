# privmsg-cli

Create a `privmsg` share from a terminal while keeping encryption on the client.

Requires Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x). Older releases are rejected before reading input or making requests. These versions include the October 2026 TLS/DNS/Brotli security fixes and updated bundled CA certificates. Keep your browser and OS trust store updated too; custom CA stores need separate maintenance.

```sh
npx privmsg-cli create "secret text"
printf '%s' 'secret text' | npx privmsg-cli create
```

The command prints only the share URL by default. Use `--json` for structured output:

```sh
privmsg create --expires-in 86400 --max-reads 1 --json "secret text"
```

Use `--base-url` to target a self-hosted deployment:

```sh
privmsg create --base-url https://privmsg.example.com "secret text"
```

`--server` remains available as an alias for compatibility. Plain HTTP is accepted only for `localhost` and `127.0.0.1`.

Save your deployment as the default for future commands:

```sh
privmsg config set base-url https://privmsg.example.com
privmsg config get base-url
privmsg create "secret text"
privmsg config reset base-url
```

The URL is stored in `~/.config/privmsg/config.json` (or `$XDG_CONFIG_HOME/privmsg/config.json` when set). `--base-url` / `--server` overrides the saved value for a single command. Reset restores `https://privmsg.cc`.

Send files with repeatable `--file` options:

```sh
privmsg create --file ./report.pdf
privmsg create "Related documents" --file ./report.pdf --file ./data.zip
printf '%s' 'Notes' | privmsg create - --file ./report.pdf
```

Attachments may total up to 50 MiB (52,428,800 bytes), matching the web interface. Without a message, `--file` creates a file-only share without waiting for stdin; `-` explicitly reads the message from stdin. Files and their names are encrypted locally. Recipients use the existing web interface to preview supported formats or download the original files.

For JavaScript callers, `createShare()` in `privmsg-cli/lib/client.js` accepts `files: File[]` alongside the optional `message`:

```js
import { createShare } from "privmsg-cli/lib/client.js";

const result = await createShare({
  message: "Notes",
  files: [new File(["secret text"], "note.txt", { type: "text/plain" })]
});
console.log(result.shareUrl);
```

Requires Node.js 22 or newer. Use the web interface for password protection and enhanced X25519 encryption. Attachments are encrypted and uploaded in memory; this is not a streaming or resumable transfer.
