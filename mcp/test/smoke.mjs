// Smoke test: start the MCP server over stdio with a throwaway config and check
// the handshake, the tool list, and the per-tool store guardrail. No network.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "sms-"));
const cfg = join(dir, "stores.json");
writeFileSync(cfg, JSON.stringify({
  defaultApiVersion: "2025-10",
  stores: [
    { name: "alpha", shopDomain: "alpha.myshopify.com", adminAccessToken: "shpat_test" },
    { name: "beta", shopDomain: "beta.myshopify.com", adminAccessToken: "shpat_test" },
  ],
}));

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const child = spawn(process.execPath, [server], { env: { ...process.env, SHOPIFY_STORES_CONFIG: cfg } });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const send = (id, method, params = {}) => new Promise((res) => {
  pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const timer = setTimeout(() => { console.error("timeout"); child.kill(); process.exit(1); }, 10000);

const init = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
assert.equal(init.result.serverInfo.name, "shopify-multi-store");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const { result } = await send(2, "tools/list");
const names = result.tools.map((t) => t.name);
for (const n of ["list_stores", "add_store", "remove_store", "list_products", "graphql_query", "graphql_mutation"]) {
  assert.ok(names.includes(n), `missing tool ${n}`);
}
const setup = new Set(["list_stores", "add_store", "remove_store"]);
for (const t of result.tools.filter((t) => !setup.has(t.name))) {
  assert.ok(t.inputSchema.required?.includes("store"), `${t.name}: store must be required`);
  assert.deepEqual([...t.inputSchema.properties.store.enum].sort(), ["alpha", "beta"], `${t.name}: store enum`);
}
console.log(`ok: ${names.length} tools, store guardrail on ${names.length - setup.size}`);
clearTimeout(timer); child.kill();
