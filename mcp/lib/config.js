import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

const DEFAULT_API_VERSION = "2025-10";

/**
 * Resolve the path to stores.json.
 *
 * Priority:
 *   1. SHOPIFY_STORES_CONFIG env var (absolute or relative path)
 *   2. ~/.shopify-multi-store/stores.json   (recommended home location — keeps
 *      secrets out of the plugin repo)
 */
export function resolveConfigPath() {
  const fromEnv = process.env.SHOPIFY_STORES_CONFIG;
  if (fromEnv && fromEnv.trim()) {
    return resolve(fromEnv.trim());
  }
  return join(homedir(), ".shopify-multi-store", "stores.json");
}

function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "";
  let d = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  // Strip any path/query if someone pasted a full admin URL.
  d = d.split("/")[0];
  return d.toLowerCase();
}

/**
 * Load and validate the store configuration.
 * Returns { stores: Map<name, store>, path, error }.
 * `error` is a human-readable string when the config could not be loaded — the
 * server still starts so that list_stores can explain what's wrong.
 */
export function loadConfig() {
  const path = resolveConfigPath();
  const result = { path, stores: new Map(), error: null };

  if (!existsSync(path)) {
    result.error =
      `No stores.json found at "${path}". Create it (copy stores.example.json), ` +
      `or set SHOPIFY_STORES_CONFIG to its location, then restart Claude.`;
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    result.error = `stores.json at "${path}" is not valid JSON: ${e.message}`;
    return result;
  }

  const globalApiVersion = parsed.defaultApiVersion || DEFAULT_API_VERSION;

  // Accept either an array of stores or an object map keyed by name.
  let rawStores = [];
  if (Array.isArray(parsed.stores)) {
    rawStores = parsed.stores;
  } else if (parsed.stores && typeof parsed.stores === "object") {
    rawStores = Object.entries(parsed.stores).map(([name, v]) => ({ name, ...v }));
  } else {
    result.error = `stores.json must contain a "stores" array (or object map). See stores.example.json.`;
    return result;
  }

  const problems = [];
  for (const s of rawStores) {
    const name = (s.name || "").trim();
    const shopDomain = normalizeDomain(s.shopDomain || s.domain);
    // New (2026) credentials: client id + secret -> minted token.
    const clientId = (s.clientId || s.client_id || s.apiKey || "").trim();
    const clientSecret = (s.clientSecret || s.client_secret || "").trim();
    // Legacy credential: a directly-issued Admin API access token (shpat_).
    const adminAccessToken = (s.adminAccessToken || s.accessToken || s.token || "").trim();

    if (!name) {
      problems.push("a store is missing a \"name\"");
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      problems.push(`store "${name}" has an invalid name (use letters, numbers, dot, dash, underscore)`);
      continue;
    }
    if (!shopDomain) {
      problems.push(`store "${name}" is missing "shopDomain" (e.g. my-shop.myshopify.com)`);
      continue;
    }

    const hasClientCreds = clientId && clientSecret;
    if (!hasClientCreds && !adminAccessToken) {
      problems.push(
        `store "${name}" is missing credentials — provide "clientId" + "clientSecret" ` +
          `(from the Dev Dashboard), or a legacy "adminAccessToken"`,
      );
      continue;
    }
    // A lone shpss_ secret in the token field is the #1 mistake — catch it early.
    if (!hasClientCreds && adminAccessToken.startsWith("shpss_")) {
      problems.push(
        `store "${name}" has a client SECRET (shpss_) in "adminAccessToken". That's not an ` +
          `access token. Put it in "clientSecret" and add "clientId" instead`,
      );
      continue;
    }
    if (result.stores.has(name)) {
      problems.push(`duplicate store name "${name}"`);
      continue;
    }

    result.stores.set(name, {
      name,
      shopDomain,
      apiVersion: (s.apiVersion || globalApiVersion).trim(),
      label: s.label || s.description || name,
      authType: hasClientCreds ? "client_credentials" : "access_token",
      ...(hasClientCreds ? { clientId, clientSecret } : {}),
      ...(adminAccessToken ? { adminAccessToken } : {}),
    });
  }

  if (result.stores.size === 0) {
    result.error =
      `No valid stores in "${path}".` +
      (problems.length ? ` Problems: ${problems.join("; ")}.` : "");
  } else if (problems.length) {
    // Some stores loaded, some didn't — surface as a non-fatal warning.
    result.warning = `Some stores were skipped: ${problems.join("; ")}.`;
  }

  return result;
}

/**
 * Read the raw stores.json as a plain object, preserving any stores/settings we
 * don't manage. Returns a fresh skeleton if the file doesn't exist yet.
 * Always returns { defaultApiVersion, stores: [...] } with stores as an array.
 */
export function readRawConfig(path = resolveConfigPath()) {
  if (!existsSync(path)) {
    return { defaultApiVersion: DEFAULT_API_VERSION, stores: [] };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  let stores = [];
  if (Array.isArray(parsed.stores)) {
    stores = parsed.stores;
  } else if (parsed.stores && typeof parsed.stores === "object") {
    stores = Object.entries(parsed.stores).map(([name, v]) => ({ name, ...v }));
  }
  return { defaultApiVersion: parsed.defaultApiVersion || DEFAULT_API_VERSION, ...parsed, stores };
}

/** Write the stores.json file (pretty-printed), creating its directory if needed. */
export function writeRawConfig(data, path = resolveConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  // Drop any "//" comment keys before persisting.
  const clean = { ...data };
  for (const k of Object.keys(clean)) if (k.startsWith("//")) delete clean[k];
  writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", "utf8");
  return path;
}

export { DEFAULT_API_VERSION };
