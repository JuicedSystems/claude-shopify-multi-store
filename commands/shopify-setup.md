---
description: Walk me through connecting a Shopify store to the multi-store connector
---

Help me connect a Shopify store to the multi-store connector.

1. First call `list_stores` to report which stores (if any) are already configured.
2. Explain how to get credentials for the store I want to add (2026 flow):
   - Go to the **Shopify Dev Dashboard** (dev.shopify.com) and create an app (or reuse one)
     for my organization.
   - Configure the **Admin API access scopes** I need (typically `read_products`,
     `write_products`, `read_orders`, `read_customers`, `read_inventory`, `write_inventory`).
   - **Install the app on the store** I want to connect — client credentials only works for
     apps installed in stores my org owns.
   - Copy the app's **Client ID** and **Client secret** (`shpss_…`) from its credentials page.
     Remind me I need BOTH values, not just the `shpss_` secret.
   - (If I happen to already have a legacy `shpat_` access token, that works too via
     `adminAccessToken`.)
3. Ask me for a short store `name` (kebab-case), the `myshopify.com` domain, the Client ID,
   and the Client secret. Then call `add_store` with `clientId` + `clientSecret` — it will mint
   a token, validate against Shopify, and save. The store is usable immediately.
4. If validation fails, help me check: is the app installed on this store? Are the Client ID and
   secret correct? Does the app have at least `read_products` scope? Then retry.
5. On success, confirm the shop name and granted scopes it connected with.

Never print the secret back to me in full. `add_store` saves it to the local `stores.json`
file — it's sent only to Shopify's own token endpoint.
