import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { normalizeBaseUrl } from "./client.js";

const DEFAULT_BASE_URL = "https://privmsg.cc";

function configPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "privmsg", "config.json");
}

export async function getDefaultBaseUrl() {
  let config;
  try {
    config = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return DEFAULT_BASE_URL;
    }
    throw new Error(`Cannot read privmsg config: ${error.message}`);
  }

  if (!config || typeof config !== "object" || typeof config.baseUrl !== "string") {
    throw new Error("Invalid privmsg config: expected a baseUrl string");
  }
  return normalizeBaseUrl(config.baseUrl).toString();
}

export async function setDefaultBaseUrl(value) {
  const baseUrl = normalizeBaseUrl(value).toString();
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ baseUrl }, null, 2)}\n`, { mode: 0o600 });
  return baseUrl;
}

export async function resetDefaultBaseUrl() {
  return setDefaultBaseUrl(DEFAULT_BASE_URL);
}
