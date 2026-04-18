import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { USAGE_LIMIT_VARIABLES } from "../src/usage.js";

const USAGE = "Usage: node scripts/github-variables.mjs <check|sync> [repo]";

const command = process.argv[2];
const explicitRepo = process.argv[3] || process.env.GITHUB_REPOSITORY || "";

if (!["check", "sync"].includes(command)) {
  console.error(USAGE);
  process.exit(1);
}

const variables = loadVariables();
const presentEntries = Object.entries(variables).filter(([, value]) => value !== "");
const invalidEntries = presentEntries.filter(([, value]) => !isPositiveNumber(value));

if (invalidEntries.length > 0) {
  console.error(
    `Invalid GitHub variables: ${invalidEntries.map(([name]) => name).join(", ")}. Expected positive numeric strings.`
  );
  process.exit(1);
}

if (command === "check") {
  if (presentEntries.length === 0) {
    console.log(`No optional GitHub variables configured. Supported variables: ${USAGE_LIMIT_VARIABLES.join(", ")}`);
    process.exit(0);
  }

  console.log(`Validated ${presentEntries.length} GitHub variables: ${presentEntries.map(([name]) => name).join(", ")}`);
  process.exit(0);
}

if (presentEntries.length === 0) {
  console.log("No GitHub variables found in local environment. Nothing to sync.");
  process.exit(0);
}

const repo = resolveRepo(explicitRepo);
ensureGhAuthenticated();

for (const [name, value] of presentEntries) {
  const result = spawnSync("gh", ["variable", "set", name, "--repo", repo, "--body", value], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Synced ${presentEntries.length} GitHub variables to ${repo}`);

function loadVariables() {
  const fileValues = parseDotEnv();
  const mergedValues = {};

  for (const name of USAGE_LIMIT_VARIABLES) {
    mergedValues[name] = process.env[name] || fileValues[name] || "";
  }

  return mergedValues;
}

function parseDotEnv() {
  for (const fileName of [".dev.vars", ".env"]) {
    if (!existsSync(fileName)) {
      continue;
    }

    const content = readFileSync(fileName, "utf8");
    const values = {};

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values[key] = value;
    }

    return values;
  }

  return {};
}

function isPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function resolveRepo(repo) {
  if (repo) {
    return repo;
  }

  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const parsed = parseGitHubRepo(remoteUrl);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Ignore and fail below with a better message.
  }

  console.error("GitHub repository is not set. Pass <owner/repo> or export GITHUB_REPOSITORY.");
  process.exit(1);
}

function parseGitHubRepo(remoteUrl) {
  const normalized = remoteUrl.replace(/\.git$/, "");
  let match = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (match) {
    return match[1];
  }

  match = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (match) {
    return match[1];
  }

  return "";
}

function ensureGhAuthenticated() {
  const result = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    console.error("GitHub CLI is not authenticated. Run `gh auth login` first.");
    process.exit(result.status || 1);
  }
}
