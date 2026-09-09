import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import vm from "node:vm";

// Exercise the real implementation, not a second copy of the parser. No Pi
// imports are executed: all filesystem/auth/network access below is synthetic.
// Requires Node 22.13+ for stripTypeScriptTypes.
const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source, { mode: "transform" })
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "")
  .replace("export default function multiSub", "function multiSub")
  .replace(/^export (?=(?:async )?function )/gm, "");
let fetchImpl = () => { throw new Error("Unexpected network request"); };
let deadline;
let timerCount = 0;
const deadlines = new Set();
const files = new Map();
const sandbox = vm.createContext({
  AbortController, AbortSignal, Date, Error, Headers, Response, console,
  process: { env: {} }, join,
  getAgentDir: () => "/fixture-agent",
  existsSync: (path) => files.has(path),
  readFileSync: (path) => {
    assert.ok(files.has(path), `Unexpected file read: ${path}`);
    return files.get(path);
  },
  readStoredCredential: () => { throw new Error("Unexpected credential read"); },
  fetch: (...args) => fetchImpl(...args),
  setTimeout: (callback, ms) => {
    assert.equal(ms, 15_000);
    timerCount++;
    deadlines.add(callback);
    deadline = callback;
    return callback;
  },
  clearTimeout: (callback) => { deadlines.delete(callback); timerCount--; },
});
vm.runInContext(`${code}\nthis.api = {
  parseAnthropicQuotaWindows, classifyAnthropicQuotaKind, anthropicQuotaChecker,
  collectQuotaAccounts, runQuotaChecks, loadQuotaResults, PoolManager,
};`, sandbox);
const api = sandbox.api;
const window = (utilization, resets_at = "2026-10-01T12:00:00Z") => ({ utilization, resets_at });
const body = (five = 20, seven = 30, more = {}) => ({ five_hour: window(five), seven_day: window(seven), ...more });
const classify = (data, modelId) => api.classifyAnthropicQuotaKind(api.parseAnthropicQuotaWindows(data, modelId));
const auth = { type: "oauth", access: "fixture-old-secret", refresh: "fixture-refresh-secret", expires: 1 };
const account = { providerName: "anthropic-2", baseProvider: "anthropic", displayName: "Work", auth };
let resolverCalls = [];
let resolver = async (provider) => {
  resolverCalls.push(provider);
  return { source: "OAuth", auth: { apiKey: "fixture-resolved-secret" } };
};
const registry = { getProviderAuth: (provider) => resolver(provider) };
const context = { modelRegistry: registry, modelId: "claude-sonnet-4-5" };
const check = (value = account, signal, options = context) => api.anthropicQuotaChecker.check(value, signal, options);
const visible = (result) => JSON.stringify(result);
const assertSafe = (result) => assert.doesNotMatch(visible(result), /fixture-.*secret|SENSITIVE|statusText/);

assert.equal(classify(body()).score, 70);
for (const [used, expected] of [[0, "ready"], [70, "watch"], [85, "low"], [95, "blocked"], [100, "blocked"]]) {
  assert.equal(classify(body(used, 0)).kind, expected);
}
for (const invalid of [undefined, null, [], "bad", {}, { five_hour: window(0) }, { seven_day: window(0) }]) {
  assert.equal(classify(invalid).kind, "error");
}
for (const invalid of [null, "0", "", false, NaN, Infinity, -1, 101, {}, []]) {
  assert.equal(classify(body(invalid)).kind, "error");
}
for (const reset of ["bad", "", "0", "123", 123, {}, "2026-10-01", "1970-01-01T00:00:00Z"]) {
  assert.equal(classify({ ...body(), five_hour: window(0, reset) }).kind, "error");
}
const noReset = api.parseAnthropicQuotaWindows({ ...body(), five_hour: window(0, null) });
assert.equal(noReset[0].remainingPercent, 100);
assert.equal(noReset[0].resetAt, undefined);
assert.equal(api.parseAnthropicQuotaWindows(body())[0].resetAt, Date.parse("2026-10-01T12:00:00Z") / 1000);
const specific = body(10, 20, { seven_day_sonnet: window(100), seven_day_opus: window(30) });
assert.equal(classify(specific, "claude-sonnet-4-5").kind, "blocked");
assert.equal(classify(specific, "claude-3-7-sonnet-20250219").kind, "blocked");
assert.equal(classify(specific, "claude-opus-4-6").score, 70);
assert.equal(classify(specific, "claude-haiku-4-5").score, 80);
assert.equal(classify(specific).score, 80);
assert.equal(classify(specific, "custom-sonnet-proxy").score, 80);
assert.equal(classify(body(0, 0, { seven_day_sonnet: {}, seven_day_opus: null }), "claude-opus-4-6").kind, "ready");
assert.equal(classify(body(0, 0, { seven_day_sonnet: {} }), "claude-sonnet-4-5").kind, "error");
assert.equal(classify(body(0, 0, { seven_day_oauth_apps: window(99) })).kind, "blocked");
assert.equal(classify(body(0, 0, { seven_day_oauth_apps: {} })).kind, "error");
assert.equal(classify(body(0, 0, { seven_day_cowork: window(100), extra_usage: { utilization: 100 } })).score, 100);

let fetchCalls = 0;
fetchImpl = async (url, options) => {
  fetchCalls++;
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(options.headers.Authorization, "Bearer fixture-resolved-secret");
  assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "GET");
  assert.ok(options.signal instanceof AbortSignal);
  return Response.json(specific);
};
let result = await check();
assert.equal(result.kind, "blocked");
assert.equal(fetchCalls, 1);
assert.deepEqual(resolverCalls, ["anthropic-2"]);
assert.match(result.summary, /7d Sonnet 0%/);
assert.match(result.details.join("\n"), /7d Opus: 70%.*not scored/);
assert.equal(result.account.auth, undefined);
assert.equal(auth.access, "fixture-old-secret");
assertSafe(result);
for (const value of [undefined, { type: "api_key", key: "fixture-api-secret" }, { type: "oauth" }, { ...auth, expires: NaN }]) {
  result = await check({ ...account, auth: value });
  assert.equal(result.kind, "missing-auth");
  assertSafe(result);
}
assert.equal(fetchCalls, 1);
assert.match((await check(account, undefined, {})).summary, /resolver unavailable/);

for (const status of [401, 403, 429, 500]) {
  let requests = 0;
  fetchImpl = async () => {
    requests++;
    return new Response("SENSITIVE fixture-response-secret", { status, statusText: "SENSITIVE statusText" });
  };
  result = await check();
  assert.equal(requests, 1);
  assert.equal(result.kind, "error");
  assert.match(result.summary, new RegExp(`HTTP ${status}`));
  assertSafe(result);
}
fetchImpl = async () => { throw new Error("SENSITIVE fixture-network-secret"); };
result = await check();
assert.equal(result.kind, "error");
assertSafe(result);
fetchImpl = async () => new Response("SENSITIVE fixture-json-secret");
result = await check();
assert.match(result.summary, /invalid usage data/);
assertSafe(result);
resolver = async () => { throw new Error("SENSITIVE fixture-refresh-secret"); };
result = await check();
assert.match(result.summary, /OAuth resolution failed/);
assertSafe(result);
resolver = async () => ({ source: "API key", auth: { apiKey: "fixture-api-secret" } });
assert.equal((await check()).kind, "missing-auth");

// Cancellation/deadline cover auth, HTTP and response-body reads, even when a
// dependency ignores its signal. A late native refresh must not start usage I/O.
let resolveLate;
resolver = () => new Promise((resolve) => { resolveLate = resolve; });
let controller = new AbortController();
let pending = check(account, controller.signal);
controller.abort(new Error("SENSITIVE caller reason"));
assert.match((await pending).summary, /cancelled/);
let lateFetchCalls = 0;
fetchImpl = () => { lateFetchCalls++; throw new Error("Late usage request must not run"); };
resolveLate({ source: "OAuth", auth: { apiKey: "fixture-late-secret" } });
await Promise.resolve();
await Promise.resolve();
assert.equal(lateFetchCalls, 0);
pending = check();
deadline();
assert.match((await pending).summary, /timed out/);
controller = new AbortController();
controller.abort();
assert.match((await check(account, controller.signal)).summary, /cancelled/);
resolver = async () => ({ source: "OAuth", auth: { apiKey: "fixture-resolved-secret" } });
for (const [phase, cancel] of [["fetch", false], ["body", false], ["fetch", true], ["body", true]]) {
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  let requestSignal;
  fetchImpl = async (_url, options) => {
    requestSignal = options.signal;
    if (phase === "fetch") {
      started();
      return new Promise(() => {});
    }
    return { ok: true, json: () => { started(); return new Promise(() => {}); } };
  };
  controller = new AbortController();
  pending = check(account, controller.signal);
  await start;
  if (cancel) controller.abort();
  else deadline();
  assert.match((await pending).summary, cancel ? /cancelled/ : /timed out/);
  assert.equal(requestSignal.aborted, true);
}
assert.equal(timerCount, 0);

// Real account enumeration and quota-first integration, with synthetic config.
files.set("/fixture-agent/multi-pass.json", JSON.stringify({ subscriptions: [
  { provider: "anthropic", index: 2, label: "Work" }, { provider: "anthropic", index: 3 },
] }));
registry.authStorage = { hasAuth: (provider) => provider.startsWith("anthropic"), get: () => auth };
const ctx = { cwd: "/fixture-project", modelRegistry: registry, model: { provider: "anthropic-2", id: "claude-sonnet-4-5" }, hasUI: false };
assert.deepEqual(Array.from(api.collectQuotaAccounts(ctx), (a) => a.providerName), ["anthropic", "anthropic-2", "anthropic-3"]);
files.set("/fixture-project/.pi/multi-pass.json", JSON.stringify({ allowedSubs: ["anthropic-2"] }));
let accounts = api.collectQuotaAccounts(ctx);
assert.deepEqual(Array.from(accounts, (a) => a.providerName), ["anthropic-2"]);
files.set("/fixture-project/.pi/multi-pass.json", JSON.stringify({ allowedSubs: ["anthropic"] }));
assert.deepEqual(Array.from(api.collectQuotaAccounts(ctx), (a) => a.providerName), ["anthropic"]);
fetchImpl = async () => Response.json(specific);
assert.equal((await api.loadQuotaResults(ctx, accounts))[0].kind, "blocked");
ctx.model = { provider: "openai-codex", id: "claude-sonnet-4-5" };
assert.equal((await api.loadQuotaResults(ctx, accounts))[0].score, 80);
files.delete("/fixture-project/.pi/multi-pass.json");
const pool = { name: "Claude", baseProvider: "anthropic", members: ["anthropic", "anthropic-2", "anthropic-3"], enabled: true, strategy: "quota-first" };
const manager = new api.PoolManager();
manager.getAvailableMembers = () => pool.members;
resolver = async (provider) => ({ source: "OAuth", auth: { apiKey: provider } });
fetchImpl = async (_url, options) => Response.json(options.headers.Authorization.endsWith("-2")
  ? specific : body(50, 50));
assert.equal(await manager.getQuotaBestMember(pool, "anthropic", registry.authStorage, undefined, context), "anthropic-3");
assert.equal(await manager.getQuotaBestMember(pool, "anthropic", registry.authStorage, undefined, { ...context, modelId: "claude-opus-4-6" }), "anthropic-2");
const plan = { candidates: ["anthropic-2", "anthropic-3"].map((provider) => ({ source: "pool", poolName: pool.name, provider })) };
ctx.ui = { notify() {} };
await manager.reorderCandidatesByStrategy(pool, plan, { provider: "anthropic", id: "claude-sonnet-4-5" }, ctx, { attemptedProviders: new Set() }, null);
assert.equal(plan.candidates[0].provider, "anthropic-3");
fetchImpl = async () => Response.json({});
assert.equal(await manager.getQuotaBestMember(pool, "anthropic", registry.authStorage, undefined, context), undefined);
assert.equal(timerCount, 0);

// Full caller: Esc during quota-first must not turn unavailable quota into a
// round-robin switch and a fresh queued prompt. All planning/checker code is real.
for (const phase of ["auth", "fetch", "body"]) {
  controller = new AbortController();
  const actions = [];
  const fullManager = new api.PoolManager({
    setModel: async () => { actions.push("setModel"); return true; },
    sendUserMessage: () => { actions.push("sendUserMessage"); },
  });
  fullManager.loadPools([pool]);
  registry.find = (provider, id) => ({ provider, id });
  ctx.signal = controller.signal;
  ctx.ui = { notify() {}, setStatus() {} };
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  resolver = async () => {
    if (phase === "auth") { started(); return new Promise(() => {}); }
    return { source: "OAuth", auth: { apiKey: "fixture-resolved-secret" } };
  };
  fetchImpl = async () => {
    if (phase === "fetch") { started(); return new Promise(() => {}); }
    return { ok: true, json: () => { started(); return new Promise(() => {}); } };
  };
  pending = fullManager.handleError("402 usage limit reached", { provider: "anthropic", id: "claude-sonnet-4-5" }, ctx, "fixture prompt", { pools: [pool], chains: [] });
  await start;
  controller.abort();
  ctx.signal = undefined; // A later context read must not lose the original cancellation.
  const rotated = await pending;
  assert.deepEqual(actions, [], `${phase} cancellation must not switch or queue continuation`);
  assert.equal(rotated, false);
}
assert.equal(timerCount, 0);
for (const mode of ["normal", "pre-abort", "switch-abort", "timeout"]) {
  controller = new AbortController();
  if (mode === "pre-abort") controller.abort();
  const actions = [];
  const fullManager = new api.PoolManager({
    setModel: async () => {
      actions.push("setModel");
      if (mode === "switch-abort") controller.abort();
      return true;
    },
    sendUserMessage: () => { actions.push("sendUserMessage"); },
  });
  fullManager.loadPools([pool]);
  ctx.signal = controller.signal;
  resolver = async () => mode === "timeout" ? new Promise(() => {})
    : { source: "OAuth", auth: { apiKey: "fixture-resolved-secret" } };
  fetchImpl = async () => Response.json(body());
  pending = fullManager.handleError("402 usage limit reached", { provider: "anthropic", id: "claude-sonnet-4-5" }, ctx, "fixture prompt", { pools: [pool], chains: [] });
  if (mode === "timeout") {
    assert.equal(deadlines.size, 2);
    for (const callback of [...deadlines]) callback();
  }
  const rotated = await pending;
  assert.equal(rotated, mode === "normal" || mode === "timeout");
  assert.deepEqual(actions, mode === "pre-abort" ? [] : mode === "switch-abort" ? ["setModel"] : ["setModel", "sendUserMessage"]);
}
assert.equal(timerCount, 0);
for (const reset of ["2026-02-30T12:00:00Z", "2025-02-29T12:00:00+02:00", "2026-04-31T12:00:00-05:00"]) {
  assert.equal(classify({ ...body(), five_hour: window(0, reset) }).kind, "error");
  assert.equal(api.parseAnthropicQuotaWindows({ ...body(), five_hour: window(0, reset) })[0].resetAt, undefined);
}
for (const reset of ["2024-02-29T12:00:00Z", "2026-01-31T23:59:59-05:00", "2026-01-01T00:00:00+14:00"]) {
  assert.equal(classify({ ...body(), five_hour: window(0, reset) }).kind, "ready");
}
// Model-scoped `limits` entries (e.g. Fable) join model-family windows. percent
// is utilization on the same 0..100 scale as the named windows.
const fableLimit = (percent, extra = {}) => ({
  kind: "weekly_scoped", group: "weekly", percent, severity: "normal",
  resets_at: "2026-09-13T19:00:00.432929+00:00", is_active: true,
  scope: { model: { id: null, display_name: "Fable" }, surface: null }, ...extra,
});
const unscopedLimit = (percent) => ({ kind: "weekly_all", group: "weekly", percent, severity: "normal", resets_at: null, is_active: false, scope: null });
assert.equal(classify({ ...body(0, 0), limits: [unscopedLimit(100), { ...fableLimit(100), is_active: true }] }, "claude-fable-5-1").kind, "blocked");
assert.equal(classify({ ...body(0, 0), limits: [unscopedLimit(100), { ...fableLimit(100), is_active: true }] }, "claude-fable-5-1").kind, "blocked");
assert.equal(classify({ ...body(0, 0), limits: [fableLimit(20)] }, "claude-fable-5-1").score, 80);
// Inactive, non-model, and foreign-model entries do not affect other families.
assert.equal(classify({ ...body(0, 0), limits: [{ ...fableLimit(100), is_active: false }] }, "claude-fable-5-1").kind, "ready");
assert.equal(classify({ ...body(0, 0), limits: [{ ...fableLimit(100), scope: {} }] }).kind, "ready");
assert.equal(classify({ ...body(0, 0), limits: [fableLimit(100)] }, "claude-sonnet-4-5").kind, "ready");
assert.equal(classify({ ...body(0, 0), limits: [fableLimit(101)] }, "claude-fable-5-1").kind, "error");
const fableWindow = api.parseAnthropicQuotaWindows({ ...body(0, 0), limits: [{ ...fableLimit(30) }] }, "claude-fable-5-1").find((w) => w.label === "7d Fable");
assert.deepEqual({ ...fableWindow }, { label: "7d Fable", remainingPercent: 70, resetAt: Date.parse("2026-09-13T19:00:00Z") / 1000, applies: true });
console.log("Anthropic limits checks passed (real source; isolated auth, network, timers and config)");
