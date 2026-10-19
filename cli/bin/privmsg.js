#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";

import { MAX_TOTAL_SIZE_BYTES, createShare } from "../lib/client.js";
import { getDefaultBaseUrl, resetDefaultBaseUrl, setDefaultBaseUrl } from "../lib/config.js";

const HELP = `Usage: privmsg create [options] [message]
       privmsg config set base-url <url>
       privmsg config get base-url
       privmsg config reset base-url

Create an end-to-end encrypted text or file share and print its URL.

Options:
  --base-url <url>       override the saved deployment URL (default: https://privmsg.cc)
  --server <url>         alias for --base-url
  --expires-in <seconds> expiry in seconds, from 3600 to 604800 (default: 86400)
  --max-reads <count>    allowed reads, from 1 to 20 (default: 1)
  --file <path>         attach a file (repeatable; combined limit: 50 MiB)
  --json                 print the complete JSON response
  -h, --help             show this help
  -v, --version          show the CLI version

When message is omitted and no files are given, privmsg reads it from stdin.
With --file, omit message for a file-only share, or use - to read text from stdin.
`;

try {
  if (process.argv[2] === "config") {
    await configure(process.argv.slice(3));
  } else {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(HELP);
    } else if (options.version) {
      process.stdout.write("0.2.0\n");
    } else {
      const files = [];
      let totalSize = 0;
      for (const path of options.files) {
        const info = await stat(path);
        if (!info.isFile()) {
          throw new Error(`Not a regular file: ${path}`);
        }
        totalSize += info.size;
        if (totalSize > MAX_TOTAL_SIZE_BYTES) {
          throw new Error("Total attachment size must not exceed 50 MiB");
        }
        const blob = await openAsBlob(path);
        files.push({ name: basename(path), type: blob.type, size: blob.size, arrayBuffer: () => blob.arrayBuffer() });
      }
      const message = options.message === "-" || (options.message === null && files.length === 0)
        ? await readStdin()
        : options.message ?? "";
      const result = await createShare({
        message,
        files,
        baseUrl: options.baseUrl ?? await getDefaultBaseUrl(),
        expiresInSeconds: options.expiresInSeconds,
        maxReads: options.maxReads
      });
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.shareUrl}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`privmsg: ${error.message}\n`);
  process.exitCode = 1;
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let message = "";
  for await (const chunk of process.stdin) {
    message += chunk;
  }
  return message;
}

async function configure(args) {
  const [action, key, value] = args;
  if (key !== "base-url" || !["set", "get", "reset"].includes(action) || args.length !== (action === "set" ? 3 : 2)) {
    throw new Error("Usage: privmsg config set base-url <url> | get base-url | reset base-url");
  }

  const baseUrl = action === "set"
    ? await setDefaultBaseUrl(value)
    : action === "reset"
      ? await resetDefaultBaseUrl()
      : await getDefaultBaseUrl();
  process.stdout.write(`${baseUrl}\n`);
}

function parseArgs(args) {
  const options = {
    baseUrl: undefined,
    expiresInSeconds: 86400,
    maxReads: 1,
    json: false,
    help: false,
    version: false,
    files: [],
    message: null
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "create") {
      if (index !== 0) {
        throw new Error("create must be the first argument");
      }
      continue;
    }

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    if (argument === "-v" || argument === "--version") {
      options.version = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (
      argument === "--file" ||
      argument === "--base-url" ||
      argument === "--server" ||
      argument === "--expires-in" ||
      argument === "--max-reads"
    ) {
      const value = args[index + 1];
      if (value == null) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;

      if (argument === "--file") {
        options.files.push(value);
      } else if (argument === "--base-url" || argument === "--server") {
        options.baseUrl = value;
      } else if (argument === "--expires-in") {
        options.expiresInSeconds = parseInteger(value, argument);
      } else {
        options.maxReads = parseInteger(value, argument);
      }
      continue;
    }

    if (argument.startsWith("-") && argument !== "-") {
      throw new Error(`unknown option: ${argument}`);
    }

    positional.push(argument);
  }

  if (positional.length > 0) {
    options.message = positional.join(" ");
  }

  return options;
}

function parseInteger(value, option) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} requires an integer`);
  }
  return Number(value);
}
