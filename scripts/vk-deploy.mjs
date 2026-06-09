import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(rootDir, "vk-hosting-config.json");
const envPath = resolve(rootDir, ".env");
const buildScript = resolve(rootDir, "scripts/build.mjs");
const deployBin = resolve(
  rootDir,
  "node_modules/@vkontakte/vk-miniapps-deploy/bin/vk-miniapps-deploy",
);

const deployMode = process.argv[2] ?? "dev";
const shouldUpdateDev = deployMode === "dev" || deployMode === "all";
const shouldUpdateProd = deployMode === "production" || deployMode === "all";

if (!shouldUpdateDev && !shouldUpdateProd) {
  console.error(`Unknown deploy mode: ${deployMode}`);
  process.exit(1);
}

function loadDotEnv() {
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function assertBackendReady(apiBaseUrl) {
  let response;

  try {
    response = await fetch(`${apiBaseUrl}/health`);
  } catch (error) {
    console.error(`Cannot reach backend healthcheck at ${apiBaseUrl}/health.`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Backend healthcheck failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
}

loadDotEnv();

const apiBaseUrl = (process.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

if (!apiBaseUrl) {
  console.error("VITE_API_BASE_URL is required before VK deploy.");
  console.error("Set it to the public HTTPS URL of the backend, then run npm run deploy:all again.");
  process.exit(1);
}

if ((shouldUpdateProd || shouldUpdateDev) && !apiBaseUrl.startsWith("https://")) {
  console.error("VITE_API_BASE_URL must be an HTTPS URL for VK Mini Apps hosting.");
  process.exit(1);
}

await assertBackendReady(apiBaseUrl);

const buildResult = spawnSync(process.execPath, [buildScript], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
});

if (buildResult.error) {
  throw buildResult.error;
}

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const originalConfig = readFileSync(configPath, "utf8");
const parsedConfig = JSON.parse(originalConfig);
const nextConfig = {
  ...parsedConfig,
  noprompt: true,
  update_dev: shouldUpdateDev,
  update_prod: shouldUpdateProd,
};

writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

try {
  const env = {
    ...process.env,
    READABLE_STREAM: "disable",
  };

  if (deployMode !== "all") {
    env.MINI_APPS_ENVIRONMENT = deployMode;
  }

  const result = spawnSync(process.execPath, [deployBin], {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} finally {
  writeFileSync(configPath, originalConfig);
}
