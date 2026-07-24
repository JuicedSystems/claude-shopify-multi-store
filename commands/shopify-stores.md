---
description: List the Shopify stores configured in the multi-store connector
---

Call the `list_stores` tool from the shopify-multi-store connector and show me the
configured stores in a compact table: name, label, domain, and API version.

If the tool reports an error or zero stores, tell me exactly where the `stores.json`
file needs to go (the `configPath` it returns) and what a minimal entry looks like.
Do not reveal any access tokens.
