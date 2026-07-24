#!/usr/bin/env node
/**
 * Shopify Multi-Store MCP server (zero-dependency).
 *
 * Connects any number of Shopify stores (configured in stores.json) through a
 * single MCP server. Every tool takes a REQUIRED `store` argument, typed as an
 * enum of the configured store names, so the model must always name a store and
 * can never target one that isn't configured. That guardrail is what keeps
 * Claude from pulling up the wrong shop when you move between projects.
 *
 * Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0) directly,
 * so the plugin needs no `npm install` and ships no node_modules.
 */
import {
  loadConfig,
  readRawConfig,
  writeRawConfig,
  resolveConfigPath,
  DEFAULT_API_VERSION,
} from "./lib/config.js";
import { graphql, collectUserErrors, ShopifyError, getTokenMeta } from "./lib/shopify.js";

const SERVER_INFO = { name: "shopify-multi-store", version: "1.0.0" };
const SUPPORTED_PROTOCOL = "2025-06-18";

// Live, reloadable config. `add_store` / `remove_store` rewrite the file and
// call reloadConfig() so changes take effect immediately, without a restart.
let config = loadConfig();
let storeNames = [...config.stores.keys()];

function reloadConfig() {
  config = loadConfig();
  storeNames = [...config.stores.keys()];
  applyStoreProp();
}

// ---------------------------------------------------------------------------
// tool result / store helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requireStore(name) {
  const store = config.stores.get(name);
  if (!store) {
    const list = storeNames.length ? storeNames.join(", ") : "(none configured)";
    throw new ShopifyError(
      `Unknown store "${name}". Configured stores: ${list}. ` +
        `Use list_stores to see them, or edit stores.json at ${config.path}.`,
    );
  }
  return store;
}

/** Accept a numeric id or a full GID; always return a GID. */
function toGid(type, value) {
  const v = String(value).trim();
  if (v.startsWith("gid://")) return v;
  const digits = v.replace(/[^0-9]/g, "");
  return `gid://shopify/${type}/${digits}`;
}

// JSON-Schema fragment for the required store selector. This is a single shared
// object referenced by every tool's inputSchema, so mutating it in place (via
// applyStoreProp) updates the enum on all tools at once. After a change we emit
// notifications/tools/list_changed so the client refetches the new enum.
const storeProp = { type: "string" };
function applyStoreProp() {
  if (storeNames.length > 0) {
    storeProp.enum = storeNames;
    storeProp.description =
      "REQUIRED. Which configured Shopify store to act on. Must be exactly one of: " +
      `${storeNames.join(", ")}. Always confirm the intended store before writes.`;
  } else {
    delete storeProp.enum;
    storeProp.description = "Store name (no stores configured yet — use add_store or list_stores).";
  }
}
applyStoreProp();

const PRODUCT_STATUS = ["ACTIVE", "ARCHIVED", "DRAFT"];

// ---------------------------------------------------------------------------
// tool definitions  { name, description, inputSchema, handler }
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = `
  id title handle status vendor productType tags totalInventory
  updatedAt createdAt
  featuredImage { url altText }
  variants(first: 20) {
    edges { node { id title sku price compareAtPrice inventoryQuantity } }
  }`;

function schema(properties, required = []) {
  return { type: "object", properties, required };
}

const tools = [
  {
    name: "list_stores",
    description:
      "List every Shopify store configured in this connector (names, domains, API " +
      "version). Never returns access tokens. Call this first to see which store " +
      "names are valid and whether any configuration needs fixing.",
    inputSchema: schema({}),
    handler: async () => {
      const stores = storeNames.map((name) => {
        const s = config.stores.get(name);
        return { name: s.name, label: s.label, shopDomain: s.shopDomain, apiVersion: s.apiVersion, authType: s.authType };
      });
      return ok({
        configPath: config.path,
        storeCount: stores.length,
        stores,
        ...(config.error ? { error: config.error } : {}),
        ...(config.warning ? { warning: config.warning } : {}),
      });
    },
  },

  {
    name: "add_store",
    description:
      "Connect a new Shopify store and save its credentials to stores.json. This is the " +
      "simple setup path — no hand-editing files. Preferred (2026+): pass `clientId` + " +
      "`clientSecret` from the app in the Shopify Dev Dashboard (the server mints and " +
      "auto-refreshes 24h access tokens for you). Legacy: pass `adminAccessToken` " +
      "(shpat_) if you already have one. By default it validates against Shopify and " +
      "only saves if it works; the store is usable immediately, no restart. The app must " +
      "be INSTALLED on the store with the scopes you need.",
    inputSchema: schema(
      {
        name: {
          type: "string",
          description: "Short unique id for the store (kebab-case, e.g. matching your project name).",
        },
        shopDomain: { type: "string", description: "The store's *.myshopify.com domain." },
        clientId: { type: "string", description: "Dev Dashboard app Client ID (preferred; used with clientSecret)." },
        clientSecret: { type: "string", description: "Dev Dashboard app Client secret (shpss_...; preferred)." },
        adminAccessToken: { type: "string", description: "Legacy Admin API access token (shpat_...), if you have one instead." },
        label: { type: "string", description: "Optional friendly label shown in listings." },
        apiVersion: { type: "string", description: `Optional API version override (default ${DEFAULT_API_VERSION}).` },
        validate: { type: "boolean", description: "Validate credentials against Shopify before saving (default true)." },
        overwrite: { type: "boolean", description: "Replace an existing store with the same name (default false)." },
      },
      ["name", "shopDomain"],
    ),
    handler: async ({ name, shopDomain, clientId, clientSecret, adminAccessToken, label, apiVersion, validate, overwrite }) => {
      name = String(name || "").trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
        return fail(`Invalid store name "${name}". Use letters, numbers, dot, dash, underscore (no spaces).`);
      }
      const domain = normalizeDomain(shopDomain);
      if (!domain) return fail("shopDomain is required (e.g. my-shop.myshopify.com).");

      clientId = String(clientId || "").trim();
      clientSecret = String(clientSecret || "").trim();
      const token = String(adminAccessToken || "").trim();
      const hasClientCreds = clientId && clientSecret;

      if (!hasClientCreds && !token) {
        if (clientSecret && !clientId) {
          return fail("You provided a clientSecret but no clientId. Add the Client ID from the Dev Dashboard app.");
        }
        return fail(
          "Provide credentials: either `clientId` + `clientSecret` (preferred, from the Dev Dashboard), " +
            "or a legacy `adminAccessToken`.",
        );
      }
      if (!hasClientCreds && token.startsWith("shpss_")) {
        return fail(
          "That value (shpss_) is a client SECRET, not an access token. Pass it as `clientSecret` and " +
            "include the `clientId` too — the server will mint the access token for you.",
        );
      }

      const raw = readRawConfig(resolveConfigPath());
      const existingIdx = raw.stores.findIndex((s) => (s.name || "").trim() === name);
      if (existingIdx >= 0 && !overwrite) {
        return fail(`A store named "${name}" already exists. Pass overwrite:true to replace it, or use a different name.`);
      }

      const version = (apiVersion || raw.defaultApiVersion || DEFAULT_API_VERSION).trim();
      const entry = {
        name,
        ...(label ? { label } : {}),
        shopDomain: domain,
        ...(hasClientCreds ? { clientId, clientSecret } : { adminAccessToken: token }),
        ...(apiVersion ? { apiVersion: version } : {}),
      };
      const candidate = { name, shopDomain: domain, apiVersion: version, ...(hasClientCreds ? { clientId, clientSecret } : { adminAccessToken: token }) };

      // Validate the credentials before persisting (default on). For client
      // credentials this also proves the token mint + install worked.
      let shop = null;
      if (validate !== false) {
        try {
          const data = await graphql(
            candidate,
            `query { shop { name myshopifyDomain currencyCode plan { displayName } } }`,
          );
          shop = data.shop;
        } catch (e) {
          return fail(
            `Could not connect to "${domain}", so nothing was saved. ${e.message}\n\n` +
              `Checklist: the app is INSTALLED on this store; the Client ID/Secret are correct; ` +
              `and it has at least read_products scope. (Pass validate:false to save without checking.)`,
          );
        }
      }

      if (existingIdx >= 0) raw.stores[existingIdx] = entry;
      else raw.stores.push(entry);
      const savedPath = writeRawConfig(raw, resolveConfigPath());

      reloadConfig();
      notifyToolsChanged();

      const meta = getTokenMeta(name);
      return ok({
        saved: true,
        store: name,
        shopDomain: domain,
        authType: hasClientCreds ? "client_credentials" : "access_token",
        apiVersion: version,
        savedTo: savedPath,
        ...(shop ? { verified: true, shopName: shop.name, currency: shop.currencyCode, plan: shop.plan?.displayName } : { verified: false }),
        ...(meta?.scope ? { grantedScopes: meta.scope } : {}),
        message: `Store "${name}" is ready to use now (no restart needed).`,
      });
    },
  },

  {
    name: "remove_store",
    description:
      "Remove a store from stores.json by name. Deletes its saved token. Takes effect immediately.",
    inputSchema: schema({ name: { type: "string", description: "The store name to remove." } }, ["name"]),
    handler: async ({ name }) => {
      name = String(name || "").trim();
      const raw = readRawConfig(resolveConfigPath());
      const before = raw.stores.length;
      raw.stores = raw.stores.filter((s) => (s.name || "").trim() !== name);
      if (raw.stores.length === before) {
        return fail(`No store named "${name}" to remove. Configured: ${storeNames.join(", ") || "(none)"}.`);
      }
      const savedPath = writeRawConfig(raw, resolveConfigPath());
      reloadConfig();
      notifyToolsChanged();
      return ok({ removed: name, remaining: storeNames, savedTo: savedPath });
    },
  },

  {
    name: "get_shop_info",
    description:
      "Get basic information about a store (name, domain, plan, currency, timezone). " +
      "Good for confirming you're pointed at the right shop.",
    inputSchema: schema({ store: storeProp }, ["store"]),
    handler: async ({ store }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query {
          shop {
            name email myshopifyDomain
            primaryDomain { url }
            currencyCode ianaTimezone
            plan { displayName partnerDevelopment shopifyPlus }
          }
        }`,
      );
      return ok({ store, ...data.shop });
    },
  },

  {
    name: "list_products",
    description:
      "List/search products in a store. Use `query` for Shopify search syntax " +
      "(e.g. 'status:active', 'title:hat', 'vendor:Acme', 'tag:sale'). Returns a page " +
      "of products newest-updated first, plus a cursor for the next page.",
    inputSchema: schema(
      {
        store: storeProp,
        query: { type: "string", description: "Shopify product search query, e.g. 'status:active tag:sale'." },
        first: { type: "integer", minimum: 1, maximum: 100, description: "How many to return (default 25, max 100)." },
        after: { type: "string", description: "Pagination cursor from a previous call's endCursor." },
      },
      ["store"],
    ),
    handler: async ({ store, query, first, after }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($first:Int!, $query:String, $after:String){
          products(first:$first, query:$query, after:$after, sortKey:UPDATED_AT, reverse:true){
            edges { cursor node { ${PRODUCT_FIELDS} } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: clampInt(first, 25, 1, 100), query: query || null, after: after || null },
      );
      const products = data.products.edges.map((e) => e.node);
      return ok({ store, count: products.length, pageInfo: data.products.pageInfo, products });
    },
  },

  {
    name: "get_product",
    description: "Get a single product by numeric/GID id or by handle.",
    inputSchema: schema(
      {
        store: storeProp,
        id: { type: "string", description: "Product id (numeric or gid://shopify/Product/...)." },
        handle: { type: "string", description: "Product handle (URL slug). Used if id is omitted." },
      },
      ["store"],
    ),
    handler: async ({ store, id, handle }) => {
      const s = requireStore(store);
      if (!id && !handle) return fail("Provide either `id` or `handle`.");
      if (id) {
        const data = await graphql(
          s,
          `query($id:ID!){ product(id:$id){ ${PRODUCT_FIELDS} descriptionHtml } }`,
          { id: toGid("Product", id) },
        );
        if (!data.product) return fail(`No product with id ${id} in store "${store}".`);
        return ok({ store, product: data.product });
      }
      const data = await graphql(
        s,
        `query($q:String!){ products(first:1, query:$q){ edges { node { ${PRODUCT_FIELDS} descriptionHtml } } } }`,
        { q: `handle:${handle}` },
      );
      const node = data.products.edges[0]?.node;
      if (!node) return fail(`No product with handle "${handle}" in store "${store}".`);
      return ok({ store, product: node });
    },
  },

  {
    name: "create_product",
    description:
      "Create a new product in a store. Only `title` is required. This is a WRITE — " +
      "make sure `store` is the intended shop.",
    inputSchema: schema(
      {
        store: storeProp,
        title: { type: "string", minLength: 1 },
        descriptionHtml: { type: "string" },
        vendor: { type: "string" },
        productType: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: PRODUCT_STATUS, description: "Defaults to DRAFT if omitted." },
        handle: { type: "string" },
      },
      ["store", "title"],
    ),
    handler: async ({ store, ...fields }) => {
      const s = requireStore(store);
      const product = pick(fields, ["title", "descriptionHtml", "vendor", "productType", "tags", "status", "handle"]);
      const data = await graphql(
        s,
        `mutation($product: ProductCreateInput!){
          productCreate(product:$product){
            product { id title handle status }
            userErrors { field message }
          }
        }`,
        { product },
      );
      const errs = collectUserErrors(data);
      if (errs.length) return fail(`create_product failed: ${JSON.stringify(errs)}`);
      return ok({ store, created: data.productCreate.product });
    },
  },

  {
    name: "update_product",
    description:
      "Update fields on an existing product (including changing status, e.g. to ACTIVE " +
      "or ARCHIVED). Only include the fields you want to change. WRITE.",
    inputSchema: schema(
      {
        store: storeProp,
        id: { type: "string", description: "Product id (numeric or GID)." },
        title: { type: "string" },
        descriptionHtml: { type: "string" },
        vendor: { type: "string" },
        productType: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: PRODUCT_STATUS },
        handle: { type: "string" },
      },
      ["store", "id"],
    ),
    handler: async ({ store, id, ...fields }) => {
      const s = requireStore(store);
      const product = {
        id: toGid("Product", id),
        ...pick(fields, ["title", "descriptionHtml", "vendor", "productType", "tags", "status", "handle"]),
      };
      const data = await graphql(
        s,
        `mutation($product: ProductUpdateInput!){
          productUpdate(product:$product){
            product { id title handle status vendor productType tags }
            userErrors { field message }
          }
        }`,
        { product },
      );
      const errs = collectUserErrors(data);
      if (errs.length) return fail(`update_product failed: ${JSON.stringify(errs)}`);
      return ok({ store, updated: data.productUpdate.product });
    },
  },

  {
    name: "list_orders",
    description:
      "List/search orders in a store, newest first. `query` supports search syntax " +
      "(e.g. 'financial_status:paid', 'fulfillment_status:unfulfilled', 'created_at:>2026-01-01').",
    inputSchema: schema(
      {
        store: storeProp,
        query: { type: "string" },
        first: { type: "integer", minimum: 1, maximum: 100, description: "Default 25, max 100." },
        after: { type: "string" },
      },
      ["store"],
    ),
    handler: async ({ store, query, first, after }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($first:Int!, $query:String, $after:String){
          orders(first:$first, query:$query, after:$after, sortKey:CREATED_AT, reverse:true){
            edges { cursor node {
              id name createdAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { id displayName email }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: clampInt(first, 25, 1, 100), query: query || null, after: after || null },
      );
      const orders = data.orders.edges.map((e) => e.node);
      return ok({ store, count: orders.length, pageInfo: data.orders.pageInfo, orders });
    },
  },

  {
    name: "get_order",
    description:
      "Get full detail for a single order by id (numeric or GID): line items, totals, " +
      "customer, and shipping address.",
    inputSchema: schema({ store: storeProp, id: { type: "string" } }, ["store", "id"]),
    handler: async ({ store, id }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($id:ID!){
          order(id:$id){
            id name createdAt email phone note
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            customer { id displayName email }
            shippingAddress { name address1 address2 city province country zip }
            lineItems(first:50){ edges { node {
              title quantity sku variantTitle
              originalUnitPriceSet { shopMoney { amount } }
            } } }
          }
        }`,
        { id: toGid("Order", id) },
      );
      if (!data.order) return fail(`No order with id ${id} in store "${store}".`);
      const order = data.order;
      order.lineItems = order.lineItems.edges.map((e) => e.node);
      return ok({ store, order });
    },
  },

  {
    name: "list_customers",
    description:
      "List/search customers in a store. `query` supports Shopify customer search " +
      "(e.g. 'email:jane@example.com', 'country:US', 'orders_count:>3').",
    inputSchema: schema(
      {
        store: storeProp,
        query: { type: "string" },
        first: { type: "integer", minimum: 1, maximum: 100, description: "Default 25, max 100." },
        after: { type: "string" },
      },
      ["store"],
    ),
    handler: async ({ store, query, first, after }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($first:Int!, $query:String, $after:String){
          customers(first:$first, query:$query, after:$after, sortKey:UPDATED_AT, reverse:true){
            edges { cursor node {
              id displayName email phone numberOfOrders createdAt
              amountSpent { amount currencyCode }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: clampInt(first, 25, 1, 100), query: query || null, after: after || null },
      );
      const customers = data.customers.edges.map((e) => e.node);
      return ok({ store, count: customers.length, pageInfo: data.customers.pageInfo, customers });
    },
  },

  {
    name: "get_customer",
    description: "Get detail for a single customer by id (numeric or GID).",
    inputSchema: schema({ store: storeProp, id: { type: "string" } }, ["store", "id"]),
    handler: async ({ store, id }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($id:ID!){
          customer(id:$id){
            id displayName email phone numberOfOrders createdAt note tags
            amountSpent { amount currencyCode }
            defaultAddress { address1 address2 city province country zip }
          }
        }`,
        { id: toGid("Customer", id) },
      );
      if (!data.customer) return fail(`No customer with id ${id} in store "${store}".`);
      return ok({ store, customer: data.customer });
    },
  },

  {
    name: "list_collections",
    description: "List/search collections in a store.",
    inputSchema: schema(
      {
        store: storeProp,
        query: { type: "string" },
        first: { type: "integer", minimum: 1, maximum: 100, description: "Default 25, max 100." },
        after: { type: "string" },
      },
      ["store"],
    ),
    handler: async ({ store, query, first, after }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($first:Int!, $query:String, $after:String){
          collections(first:$first, query:$query, after:$after){
            edges { cursor node { id title handle updatedAt productsCount { count } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: clampInt(first, 25, 1, 100), query: query || null, after: after || null },
      );
      const collections = data.collections.edges.map((e) => e.node);
      return ok({ store, count: collections.length, pageInfo: data.collections.pageInfo, collections });
    },
  },

  {
    name: "create_collection",
    description: "Create a manual (custom) collection in a store. WRITE.",
    inputSchema: schema(
      {
        store: storeProp,
        title: { type: "string", minLength: 1 },
        descriptionHtml: { type: "string" },
      },
      ["store", "title"],
    ),
    handler: async ({ store, title, descriptionHtml }) => {
      const s = requireStore(store);
      const input = { title, ...(descriptionHtml ? { descriptionHtml } : {}) };
      const data = await graphql(
        s,
        `mutation($input: CollectionInput!){
          collectionCreate(input:$input){
            collection { id title handle }
            userErrors { field message }
          }
        }`,
        { input },
      );
      const errs = collectUserErrors(data);
      if (errs.length) return fail(`create_collection failed: ${JSON.stringify(errs)}`);
      return ok({ store, created: data.collectionCreate.collection });
    },
  },

  {
    name: "add_products_to_collection",
    description:
      "Add one or more products to a manual collection. WRITE. Returns an async job " +
      "handle (large adds process in the background).",
    inputSchema: schema(
      {
        store: storeProp,
        collectionId: { type: "string", description: "Collection id (numeric or GID)." },
        productIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Product ids (numeric or GID)." },
      },
      ["store", "collectionId", "productIds"],
    ),
    handler: async ({ store, collectionId, productIds }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `mutation($id:ID!, $productIds:[ID!]!){
          collectionAddProductsV2(id:$id, productIds:$productIds){
            job { id done }
            userErrors { field message }
          }
        }`,
        { id: toGid("Collection", collectionId), productIds: productIds.map((p) => toGid("Product", p)) },
      );
      const errs = collectUserErrors(data);
      if (errs.length) return fail(`add_products_to_collection failed: ${JSON.stringify(errs)}`);
      return ok({ store, job: data.collectionAddProductsV2.job });
    },
  },

  {
    name: "get_inventory_levels",
    description:
      "Show inventory for a product's variants across all locations (available and " +
      "on-hand quantities). Also returns the inventoryItemId/locationId needed to set inventory.",
    inputSchema: schema(
      { store: storeProp, productId: { type: "string", description: "Product id (numeric or GID)." } },
      ["store", "productId"],
    ),
    handler: async ({ store, productId }) => {
      const s = requireStore(store);
      const data = await graphql(
        s,
        `query($id:ID!){
          product(id:$id){
            title
            variants(first:50){ edges { node {
              id sku title
              inventoryItem {
                id
                inventoryLevels(first:20){ edges { node {
                  location { id name }
                  quantities(names:["available","on_hand"]){ name quantity }
                } } }
              }
            } } }
          }
        }`,
        { id: toGid("Product", productId) },
      );
      if (!data.product) return fail(`No product with id ${productId} in store "${store}".`);
      const variants = data.product.variants.edges.map((e) => {
        const n = e.node;
        return {
          variantId: n.id,
          sku: n.sku,
          title: n.title,
          inventoryItemId: n.inventoryItem?.id,
          levels: (n.inventoryItem?.inventoryLevels.edges || []).map((le) => ({
            location: le.node.location,
            quantities: le.node.quantities,
          })),
        };
      });
      return ok({ store, product: data.product.title, variants });
    },
  },

  {
    name: "set_inventory_quantity",
    description:
      "Set the available/on-hand quantity for an inventory item at a location. WRITE. " +
      "Get inventoryItemId and locationId from get_inventory_levels first.",
    inputSchema: schema(
      {
        store: storeProp,
        inventoryItemId: { type: "string", description: "InventoryItem id (numeric or GID)." },
        locationId: { type: "string", description: "Location id (numeric or GID)." },
        quantity: { type: "integer", description: "The absolute quantity to set." },
        name: { type: "string", enum: ["available", "on_hand"], description: "Which quantity to set (default available)." },
      },
      ["store", "inventoryItemId", "locationId", "quantity"],
    ),
    handler: async ({ store, inventoryItemId, locationId, quantity, name }) => {
      const s = requireStore(store);
      const input = {
        name: name || "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId: toGid("InventoryItem", inventoryItemId),
            locationId: toGid("Location", locationId),
            quantity,
          },
        ],
      };
      const data = await graphql(
        s,
        `mutation($input: InventorySetQuantitiesInput!){
          inventorySetQuantities(input:$input){
            inventoryAdjustmentGroup { createdAt reason }
            userErrors { field message }
          }
        }`,
        { input },
      );
      const errs = collectUserErrors(data);
      if (errs.length) return fail(`set_inventory_quantity failed: ${JSON.stringify(errs)}`);
      return ok({ store, result: data.inventorySetQuantities.inventoryAdjustmentGroup });
    },
  },

  {
    name: "graphql_query",
    description:
      "Run an arbitrary Admin API GraphQL READ (query) against a store. Use this for " +
      "anything the helper tools don't cover (metafields, discounts, markets, fulfillments, " +
      "analytics/ShopifyQL, etc.). Pass `variables` as an object.",
    inputSchema: schema(
      {
        store: storeProp,
        query: { type: "string", description: "A GraphQL query document." },
        variables: { type: "object", description: "Variables object for the query." },
      },
      ["store", "query"],
    ),
    handler: async ({ store, query, variables }) => {
      const s = requireStore(store);
      if (/\bmutation\b/.test(query)) return fail("Use graphql_mutation for writes. This tool is read-only.");
      const data = await graphql(s, query, variables || {});
      return ok({ store, data });
    },
  },

  {
    name: "graphql_mutation",
    description:
      "Run an arbitrary Admin API GraphQL WRITE (mutation) against a store. Powerful and " +
      "irreversible — always confirm the `store` is correct first. Surfaces userErrors from the payload.",
    inputSchema: schema(
      {
        store: storeProp,
        mutation: { type: "string", description: "A GraphQL mutation document." },
        variables: { type: "object", description: "Variables object for the mutation." },
      },
      ["store", "mutation"],
    ),
    handler: async ({ store, mutation, variables }) => {
      const s = requireStore(store);
      const data = await graphql(s, mutation, variables || {});
      const errs = collectUserErrors(data);
      return ok({ store, data, ...(errs.length ? { userErrors: errs } : {}) });
    },
  },
];

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function clampInt(v, def, min, max) {
  const n = Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "";
  let d = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return d.split("/")[0].toLowerCase();
}

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC loop
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
// Tell the client the tool list (specifically the store enum) changed, so it
// refetches tools/list. Only meaningful once the client has initialized.
function notifyToolsChanged() {
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      result(id, {
        protocolVersion: requested || SUPPORTED_PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const tool = toolByName.get(params?.name);
      if (!tool) {
        error(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const res = await tool.handler(params.arguments || {});
        result(id, res);
      } catch (e) {
        // Report tool failures as tool results (isError) rather than protocol
        // errors, so the model can read and react to them.
        const detail =
          e instanceof ShopifyError && e.details
            ? `\n\nDetails: ${JSON.stringify(e.details, null, 2)}`
            : "";
        result(id, fail(`${e.message}${detail}`));
      }
      return;
    }
    default:
      if (isNotification) return; // ignore unknown notifications (e.g. notifications/initialized)
      error(id, -32601, `Method not found: ${method}`);
  }
}

function start() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines
      }
      Promise.resolve(handleMessage(msg)).catch((e) => {
        if (msg && msg.id != null) error(msg.id, -32603, `Internal error: ${e.message}`);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));

  if (config.error) {
    console.error(`[shopify-multi-store] Config problem: ${config.error}`);
  } else {
    console.error(
      `[shopify-multi-store] Ready with ${storeNames.length} store(s): ${storeNames.join(", ")}`,
    );
  }
}

start();
