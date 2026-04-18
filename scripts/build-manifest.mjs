import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const packageJsonPath = new URL("../package.json", import.meta.url);
const packageLockPath = new URL("../package-lock.json", import.meta.url);
const outputDir = new URL("../public/", import.meta.url);
const outputPath = new URL("../public/build-manifest.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageLockContent = readFileSync(packageLockPath, "utf8");

let commitSha = "unknown";
try {
  commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
} catch {
  commitSha = "unavailable";
}

const wranglerVersion = packageJson.devDependencies?.wrangler || "unavailable";
const buildHash = createHash("sha256")
  .update(JSON.stringify(packageJson))
  .update(packageLockContent)
  .digest("hex");

const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  commitSha,
  buildHash,
  nodeVersion: process.version,
  expectedNodeVersion: packageJson.engines?.node || "unavailable",
  wranglerVersion
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
