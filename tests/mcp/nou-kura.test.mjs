import test from "node:test";
import assert from "node:assert/strict";
import { buildMessages, configFromEnv, pending, runOnce, SYSTEM } from "../../tools/nou-kura/nou-kura.mjs";

const msgs = [{ id: 1, author: "owner", body: "What is left today?" }, { id: 2, author: "bot", body: "Three things." }, { id: 3, author: "owner", body: "Move the sidebar fix to tonight." }];

test("only the owner's messages after the last reply are waiting", () => {
  assert.deepEqual(pending(msgs).map((m) => m.id), [3]);
  assert.deepEqual(pending(msgs.slice(0, 2)), []);
  assert.deepEqual(pending([]), []);
  assert.deepEqual(pending([{ id: 1, author: "owner", body: "a" }, { id: 2, author: "owner", body: "b" }]).map((m) => m.id), [1, 2]);
});
test("the model sees the system prompt and the recent conversation with the right roles", () => {
  const m = buildMessages(msgs);
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "user"]); assert.equal(m[0].content, SYSTEM);
  assert.equal(buildMessages(Array.from({ length: 50 }, (_, i) => ({ id: i, author: "owner", body: "q" + i }))).length, 21, "at most the last 20 messages");
});
test("a waiting question is answered through the local model and posted back, and nothing happens when nothing is waiting", async () => {
  const config = { token: "t", api: "http://127.0.0.1:47651", ollama: "http://127.0.0.1:11434", model: "llama3.2" }; const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (url.endsWith("/v1/inhouse?limit=50")) return ok({ data: msgs });
    if (url.endsWith("/api/chat")) return ok({ message: { content: "  Done. It now sits in the 20:00 block.  " } });
    if (url.endsWith("/v1/inhouse/reply")) return ok({ id: 4 });
    throw new Error("unexpected " + url);
  };
  assert.equal(await runOnce(config, f), "answered");
  assert.equal(calls[1].body.model, "llama3.2"); assert.equal(calls[1].body.stream, false);
  assert.deepEqual(calls[2].body, { body: "Done. It now sits in the 20:00 block." }); assert.equal(calls[2].auth, "Bearer t");
  assert.ok(calls.every((c) => !JSON.stringify(c).includes("Bearer t") || c.auth), "the token only travels in the header");
  calls.length = 0;
  const idle = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: msgs.slice(0, 2) }) }; };
  assert.equal(await runOnce(config, idle), "idle"); assert.equal(calls.length, 1, "no model call when nothing is waiting");
});
test("errors say what to check, and an empty or oversized answer is handled", async () => {
  const config = { token: "t", api: "http://127.0.0.1:47651", ollama: "http://127.0.0.1:11434", model: "m" };
  const base = (chat) => async (url) => url.includes("/v1/inhouse?") ? { ok: true, status: 200, json: async () => ({ data: msgs }) } : url.endsWith("/api/chat") ? chat : { ok: true, status: 200, json: async () => ({ id: 1 }) };
  await assert.rejects(runOnce(config, base({ ok: false, status: 404, json: async () => ({}) })), /Is Ollama running/);
  await assert.rejects(runOnce(config, base({ ok: true, status: 200, json: async () => ({ message: { content: "  " } }) })), /empty answer/);
  let posted = ""; const f = async (url, init) => { if (url.endsWith("/v1/inhouse/reply")) posted = JSON.parse(init.body).body; return base({ ok: true, status: 200, json: async () => ({ message: { content: "x".repeat(9000) } }) })(url); };
  await runOnce(config, f); assert.equal(posted.length, 3900);
  await assert.rejects(runOnce(config, async () => ({ ok: false, status: 403, json: async () => ({ error: "This token lacks the inhouse:read scope" }) })), /inhouse:read/);
});
test("it needs a token and only talks to this computer", () => {
  assert.throws(() => configFromEnv({}), /NOU_TOKEN is not set/);
  assert.throws(() => configFromEnv({ NOU_TOKEN: "t", OLLAMA_URL: "https://example.com" }), /on this computer/);
  assert.throws(() => configFromEnv({ NOU_TOKEN: "t", NOU_API_URL: "http://192.168.1.5:47651" }), /on this computer/);
  const c = configFromEnv({ NOU_TOKEN: "t", KURA_MODEL: "qwen2.5", KURA_POLL_MS: "10" });
  assert.deepEqual([c.model, c.api, c.ollama, c.pollMs], ["qwen2.5", "http://127.0.0.1:47651", "http://127.0.0.1:11434", 1000]);
});
