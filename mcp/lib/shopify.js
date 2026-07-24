/**
 * Thin Shopify Admin GraphQL client, scoped per store.
 * Uses Node 18+ built-in fetch — no extra deps.
 *
 * Supports two credential shapes per store:
 *   1. clientId + clientSecret  -> mints a 24h access token via the OAuth
 *      "client credentials" grant, caches it, and auto-refreshes. This is the
 *      current (2026+) path for apps built in the Shopify Dev Dashboard.
 *   2. adminAccessToken (shpat_) -> used directly. The legacy custom-app path,
 *      still supported for anyone who already has such a token.
 */

export class ShopifyError extends Error {
  constructor(message, { store, status, details } = {}) {
    super(message);
    this.name = "ShopifyError";
    this.store = store;
    this.status = status;
    this.details = details;
  }
}

function graphqlEndpoint(store) {
  return `https://${store.shopDomain}/admin/api/${store.apiVersion}/graphql.json`;
}

// storeName -> { token, expiresAt (ms epoch), scope }
const tokenCache = new Map();

/** Return cached token metadata (scope/expiry) for display, if any. */
export function getTokenMeta(storeName) {
  return tokenCache.get(storeName) || null;
}

/**
 * Exchange client_id + client_secret for a 24h access token (client
 * credentials grant). Caches the result (refreshing ~2 min early).
 */
async function mintAccessToken(store) {
  const url = `https://${store.shopDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: store.clientId,
    client_secret: store.clientSecret,
  });

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new ShopifyError(`Network error requesting token from ${store.shopDomain}: ${e.message}`, {
      store: store.name,
    });
  }

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* fall through to error below */
  }

  if (!res.ok || !json.access_token) {
    const reason = json.error_description || json.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new ShopifyError(
      `Could not mint an access token for store "${store.name}" (HTTP ${res.status}): ${reason}. ` +
        `Check the client ID / client secret, and that the app is INSTALLED on ${store.shopDomain} ` +
        `with the access scopes it needs.`,
      { store: store.name, status: res.status, details: json },
    );
  }

  const expiresIn = Number(json.expires_in) || 86399;
  const meta = {
    token: json.access_token,
    scope: json.scope || "",
    expiresAt: Date.now() + Math.max(0, expiresIn - 120) * 1000, // refresh ~2 min early
  };
  tokenCache.set(store.name, meta);
  return meta.token;
}

/** Resolve a currently-valid access token for a store (minting/refreshing as needed). */
async function getAccessToken(store) {
  if (store.adminAccessToken) return store.adminAccessToken;
  if (store.clientId && store.clientSecret) {
    const cached = tokenCache.get(store.name);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return await mintAccessToken(store);
  }
  throw new ShopifyError(
    `Store "${store.name}" has no usable credentials. Provide clientId + clientSecret ` +
      `(from the Dev Dashboard) or a legacy adminAccessToken.`,
    { store: store.name },
  );
}

/**
 * Execute a GraphQL operation against a single store.
 * Returns the `data` object on success. Throws ShopifyError on transport,
 * HTTP, or GraphQL-level errors. For client-credentials stores, a 401/403 is
 * retried once with a freshly minted token (in case the cached one was revoked).
 */
export async function graphql(store, query, variables = {}) {
  return runGraphql(store, query, variables, false);
}

async function runGraphql(store, query, variables, isRetry) {
  const token = await getAccessToken(store);

  let res;
  try {
    res = await fetch(graphqlEndpoint(store), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new ShopifyError(`Network error contacting ${store.shopDomain}: ${e.message}`, {
      store: store.name,
    });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ShopifyError(
      `Non-JSON response from ${store.shopDomain} (HTTP ${res.status}): ${text.slice(0, 300)}`,
      { store: store.name, status: res.status },
    );
  }

  if (res.status === 401 || res.status === 403) {
    // A minted token may have been revoked — drop it and retry once.
    if (!store.adminAccessToken && store.clientId && !isRetry) {
      tokenCache.delete(store.name);
      return runGraphql(store, query, variables, true);
    }
    throw new ShopifyError(
      `Authentication failed for store "${store.name}" (HTTP ${res.status}). ` +
        `Check the credentials and that the app has the needed scopes.`,
      { store: store.name, status: res.status, details: json },
    );
  }

  if (!res.ok && !json.data) {
    throw new ShopifyError(`Shopify returned HTTP ${res.status} for store "${store.name}".`, {
      store: store.name,
      status: res.status,
      details: json,
    });
  }

  if (Array.isArray(json.errors) && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new ShopifyError(`GraphQL error on store "${store.name}": ${msg}`, {
      store: store.name,
      status: res.status,
      details: json.errors,
    });
  }

  return json.data;
}

/**
 * Collect userErrors from a mutation payload (Shopify puts validation errors
 * here rather than in top-level `errors`). Returns an array of {field, message}.
 */
export function collectUserErrors(payload) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object" && Array.isArray(value.userErrors)) {
      out.push(...value.userErrors);
    }
  }
  return out;
}
