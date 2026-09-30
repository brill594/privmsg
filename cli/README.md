# privmsg-cli

Create a `privmsg` share from a terminal while keeping encryption on the client.

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

Requires Node.js 22 or newer. The initial CLI supports text shares; use the web interface for attachments, password protection, and enhanced X25519 encryption.
