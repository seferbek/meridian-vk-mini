import type { PersistedState, VKUserProfile } from "./types";

type BackendAuthResponse = {
  state: PersistedState;
  error?: string;
};

type BackendSessionResponse = {
  state: PersistedState;
  error?: string;
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

export function getVKLaunchParams() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.location.search.startsWith("?")
    ? window.location.search.slice(1)
    : window.location.search;
}

export function hasVKLaunchParams() {
  const launchParams = getVKLaunchParams();
  const params = new URLSearchParams(launchParams);
  return Boolean(params.get("sign") && params.get("vk_user_id"));
}

function getVKAuthorizationHeader() {
  const launchParams = getVKLaunchParams();
  const params = new URLSearchParams(launchParams);

  if (!launchParams || !params.get("sign") || !params.get("vk_user_id")) {
    return "";
  }

  return `Bearer ${launchParams}`;
}

async function requestBackend<T>(
  path: string,
  options: RequestInit & { vkAuth?: boolean } = {}
): Promise<T> {
  const { vkAuth, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  headers.set("Content-Type", "application/json");

  if (vkAuth) {
    const authorization = getVKAuthorizationHeader();

    if (authorization) {
      headers.set("Authorization", authorization);
    }
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...requestOptions,
    headers,
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || "Backend request failed.");
  }

  return payload;
}

export function isBackendConfigured() {
  return Boolean(API_BASE_URL);
}

export function hasBackendSession() {
  return isBackendConfigured() && hasVKLaunchParams();
}

export async function loadBackendState(profile: VKUserProfile | null): Promise<PersistedState | null> {
  if (!hasVKLaunchParams()) {
    return null;
  }

  if (!isBackendConfigured()) {
    throw new Error("Backend авторизации VK не настроен. Укажите VITE_API_BASE_URL перед деплоем.");
  }

  const payload = await requestBackend<BackendAuthResponse>("/api/auth/vk", {
    method: "POST",
    body: JSON.stringify({
      profile,
    }),
    vkAuth: true,
  });

  return payload.state;
}

export async function saveBackendState(state: PersistedState) {
  if (!hasBackendSession()) {
    return false;
  }

  await requestBackend<BackendSessionResponse>("/api/state", {
    method: "PUT",
    body: JSON.stringify({ state }),
    vkAuth: true,
  });
  return true;
}
