import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(rootDir, "server", "data");
const dbPath = process.env.MERIDIAN_DB_PATH || resolve(dataDir, "db.json");
const port = Number(process.env.PORT || 8787);
const vkAppId = process.env.VK_APP_ID || "";
const vkAppSecret = process.env.VK_APP_SECRET || "";
const vkLaunchParamsMaxAgeSeconds = Number(process.env.VK_LAUNCH_PARAMS_MAX_AGE_SECONDS || 0);
const corsOrigin = process.env.CORS_ORIGIN || "*";

const defaultDb = {
  users: [],
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-VK-Launch-Params",
  };
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function emptyResponse(res, status = 204) {
  res.writeHead(status, corsHeaders());
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body.");
    error.status = 400;
    throw error;
  }
}

async function loadDb() {
  try {
    const raw = await readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
  } catch {
    return structuredClone(defaultDb);
  }
}

async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, `${JSON.stringify({ users: db.users }, null, 2)}\n`);
}

function readLaunchParamEntries(searchOrQuery) {
  const formattedSearch = String(searchOrQuery || "").startsWith("?")
    ? String(searchOrQuery).slice(1)
    : String(searchOrQuery || "");
  const queryParams = [];
  let sign = "";

  for (const [key, value] of new URLSearchParams(formattedSearch).entries()) {
    if (!key) {
      continue;
    }

    if (key === "sign") {
      sign = value;
    } else if (key.startsWith("vk_")) {
      queryParams.push({ key, value });
    }
  }

  return { queryParams, sign };
}

function signLaunchParams(searchOrQuery, secretKey) {
  const { queryParams } = readLaunchParamEntries(searchOrQuery);
  const queryString = queryParams
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return crypto
    .createHmac("sha256", secretKey)
    .update(queryString)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyLaunchParams(searchOrQuery, secretKey) {
  if (!secretKey) {
    return null;
  }

  const formattedSearch = String(searchOrQuery || "").startsWith("?")
    ? String(searchOrQuery).slice(1)
    : String(searchOrQuery || "");
  const { queryParams, sign } = readLaunchParamEntries(formattedSearch);
  const receivedVkAppId = queryParams.find((param) => param.key === "vk_app_id")?.value || "";
  const vkUserId = queryParams.find((param) => param.key === "vk_user_id")?.value || "";
  const vkTs = queryParams.find((param) => param.key === "vk_ts")?.value || "";

  if (!sign || !vkUserId || !/^\d+$/.test(vkUserId)) {
    return null;
  }

  if (vkAppId && receivedVkAppId !== vkAppId) {
    return null;
  }

  if (vkTs && vkLaunchParamsMaxAgeSeconds > 0) {
    const timestampSeconds = Number(vkTs);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds > nowSeconds + 300 ||
      nowSeconds - timestampSeconds > vkLaunchParamsMaxAgeSeconds
    ) {
      return null;
    }
  }

  const expectedSign = signLaunchParams(formattedSearch, secretKey);

  if (!timingSafeEqualString(expectedSign, sign)) {
    return null;
  }

  return {
    vkUserId,
    vkAppId: receivedVkAppId,
    vkTs,
  };
}

function getHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value || "";
}

function readBearerLaunchParams(req) {
  const value = getHeaderValue(req.headers.authorization);
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function extractLaunchParams(req, body = {}) {
  if (typeof body.launchParams === "string" && body.launchParams.trim()) {
    return body.launchParams;
  }

  const bearerParams = readBearerLaunchParams(req);

  if (bearerParams) {
    return bearerParams;
  }

  return getHeaderValue(req.headers["x-vk-launch-params"]);
}

function requireVKAuth(req, body = {}) {
  if (!vkAppSecret) {
    const error = new Error("VK_APP_SECRET is not configured on backend.");
    error.status = 500;
    throw error;
  }

  const verified = verifyLaunchParams(extractLaunchParams(req, body), vkAppSecret);

  if (!verified) {
    const error = new Error("Не удалось подтвердить пользователя VK.");
    error.status = 401;
    throw error;
  }

  return verified;
}

function toPublicUser(user) {
  return {
    id: user.id,
    vkId: user.vkId || undefined,
    fullName: user.fullName || "Пользователь",
    email: user.email || "",
    password: "",
    region: user.region || "Москва",
    createdAt: user.createdAt,
    survey: user.survey || {},
    onboardingComplete: Boolean(user.onboardingComplete),
    favorites: Array.isArray(user.favorites) ? user.favorites : [],
    metrics: Array.isArray(user.metrics) ? user.metrics : [],
  };
}

function stateForUser(user) {
  return {
    accounts: [toPublicUser(user)],
    currentUserId: user.id,
  };
}

function buildNameFromProfile(profile, fallback) {
  const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();
  return fullName || fallback;
}

function getOrCreateVKUser(db, verified, profile) {
  let user = db.users.find((item) => item.vkId === verified.vkUserId);
  const isNewUser = !user;

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      vkId: verified.vkUserId,
      fullName: buildNameFromProfile(profile, `Пользователь VK ${verified.vkUserId}`),
      email: "",
      region: "Москва",
      createdAt: new Date().toISOString(),
      survey: {},
      onboardingComplete: false,
      favorites: [],
      metrics: [],
    };
    db.users.push(user);
    return { user, isNewUser };
  }

  if (profile) {
    const profileName = buildNameFromProfile(profile, user.fullName);
    user.fullName = user.fullName || profileName;
  }

  return { user, isNewUser };
}

function applyStateToUser(user, state) {
  if (!state || !Array.isArray(state.accounts)) {
    return;
  }

  const incoming =
    state.accounts.find((account) => account.id === user.id) ||
    state.accounts.find((account) => account.id === state.currentUserId);

  if (!incoming || typeof incoming !== "object") {
    return;
  }

  user.fullName = String(incoming.fullName || user.fullName).trim() || user.fullName;
  user.region = String(incoming.region || user.region).trim() || user.region;
  user.survey = incoming.survey && typeof incoming.survey === "object" ? incoming.survey : user.survey;
  user.onboardingComplete = Boolean(incoming.onboardingComplete);
  user.favorites = Array.isArray(incoming.favorites) ? incoming.favorites : user.favorites;
  user.metrics = Array.isArray(incoming.metrics) ? incoming.metrics : user.metrics;
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    emptyResponse(res);
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    const db = await loadDb();

    if (req.method === "POST" && url.pathname === "/api/auth/vk") {
      const body = await readJsonBody(req);
      const verified = requireVKAuth(req, body);
      const { user, isNewUser } = getOrCreateVKUser(db, verified, body.profile);

      await saveDb(db);
      jsonResponse(res, 200, { state: stateForUser(user), user: toPublicUser(user), isNewUser });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const verified = requireVKAuth(req);
      const { user } = getOrCreateVKUser(db, verified);

      await saveDb(db);
      jsonResponse(res, 200, { state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      const body = await readJsonBody(req);
      const verified = requireVKAuth(req, body);
      const { user } = getOrCreateVKUser(db, verified);

      applyStateToUser(user, body.state);
      await saveDb(db);
      jsonResponse(res, 200, { state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    jsonResponse(res, 404, { error: "Not found." });
  } catch (error) {
    jsonResponse(res, error.status || 500, {
      error: error.message || "Internal server error.",
    });
  }
}

createServer(handleRequest).listen(port, () => {
  console.log(`Meridian backend listening on http://localhost:${port}`);
});
