import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM, buildMessages, configFromEnv, pending, pendingChats, runOnce } from "../../tools/nou-kura/nou-kura.mjs";

const msg = (id, author, body, chat_id) => ({ id, author, body, ...(chat_id === undefined ? {} : { chat_id }) });
const config = { token: "t", api: "http://127.0.0.1:47651", ollama: "http://127.0.0.1:11434", model: "m", pollMs: 4000 };

test("pending: the owner's messages after the last reply", () => {
  assert.deepEqual(pending([msg(1, "owner", "a"), msg(2, "bot", "b"), msg(3, "owner", "c"), msg(4, "owner", "d")]).map((m) => m.id), [3, 4]);
  assert.deepEqual(pending([msg(1, "owner", "a"), msg(2, "bot", "b")]), []);
});
test("pendingChats: each chat is judged on its own, the longest-waiting first, and an old NOU without chat ids counts as chat 1", () => {
  const all = [msg(1, "owner", "q", 2), msg(2, "owner", "q", 1), msg(3, "bot", "a", 1), msg(4, "owner", "q", 3), msg(5, "bot", "a", 2)];
  assert.deepEqual(pendingChats(all), [3]);
  assert.deepEqual(pendingChats([msg(1, "owner", "q", 5), msg(2, "owner", "q", 4)]), [5, 4]);
  assert.deepEqual(pendingChats([msg(1, "owner", "q"), msg(2, "bot", "a"), msg(3, "owner", "q")]), [1]);
  assert.deepEqual(pendingChats([]), []);
});
test("buildMessages: the harness goes after the usual instructions and says what it cannot change", () => {
  const plain = buildMessages([msg(1, "owner", "hi")]);
  assert.equal(plain[0].content, SYSTEM); assert.deepEqual(plain[1], { role: "user", content: "hi" });
  const withHarness = buildMessages([msg(1, "owner", "hi")], "## Style\nBe brief.");
  assert.ok(withHarness[0].content.startsWith(SYSTEM) && withHarness[0].content.includes("never change what you can do") && withHarness[0].content.endsWith("## Style\nBe brief."));
  assert.equal(buildMessages([msg(1, "owner", "hi")], "   ")[0].content, SYSTEM, "blank harness adds nothing");
  assert.equal(buildMessages(Array.from({ length: 30 }, (_, i) => msg(i, "owner", "x"))).length, 21);
});

function fakeFetch(routes, calls) {
  return async (url, init = {}) => {
    const path = url.replace(config.api, "").replace(config.ollama, "OLLAMA");
    calls.push([init.method ?? "GET", path, init.body ? JSON.parse(init.body) : undefined]);
    const hit = routes.find(([m, p]) => m === (init.method ?? "GET") && (p instanceof RegExp ? p.test(path) : p === path));
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: "no route " + path }) };
    const out = typeof hit[2] === "function" ? hit[2](init) : hit[2];
    return { ok: out.status === undefined, status: out.status ?? 200, json: async () => out.body };
  };
}
test("runOnce answers the waiting chat with its own history and harness, and replies into that chat", async () => {
  const all = [msg(1, "owner", "first chat", 1), msg(2, "bot", "ok", 1), msg(3, "owner", "kanji question", 2)];
  const calls = [];
  const f = fakeFetch([
    ["GET", "/v1/inhouse?limit=200", { body: { data: all } }],
    ["GET", "/v1/inhouse?chat=2&limit=50", { body: { data: [all[2]] } }],
    ["GET", "/v1/inhouse/harness?chat=2", { body: { data: { instructions: "## Study\nTeach N3 kanji." } } }],
    ["POST", "OLLAMA/api/chat", { body: { message: { content: "  Here you go.  " } } }],
    ["POST", "/v1/inhouse/reply", { body: {} }],
  ], calls);
  assert.equal(await runOnce(config, f), "answered");
  const ask = calls.find(([, p]) => p === "OLLAMA/api/chat")[2];
  assert.deepEqual(ask.messages.map((m) => m.role), ["system", "user"]); assert.ok(ask.messages[0].content.includes("Teach N3 kanji.")); assert.equal(ask.messages[1].content, "kanji question");
  assert.deepEqual(calls.at(-1), ["POST", "/v1/inhouse/reply", { body: "Here you go.", chat: 2 }]);
});
test("runOnce is idle when nothing waits, and still answers when the harness cannot be read", async () => {
  const idle = [];
  assert.equal(await runOnce(config, fakeFetch([["GET", "/v1/inhouse?limit=200", { body: { data: [msg(1, "owner", "q", 1), msg(2, "bot", "a", 1)] } }]], idle)), "idle");
  assert.equal(idle.length, 1, "nothing else is called when idle");
  const calls = [];
  const f = fakeFetch([
    ["GET", "/v1/inhouse?limit=200", { body: { data: [msg(1, "owner", "q")] } }],
    ["GET", /^\/v1\/inhouse\?chat=1/, { body: { data: [msg(1, "owner", "q")] } }],
    ["POST", "OLLAMA/api/chat", { body: { message: { content: "a" } } }],
    ["POST", "/v1/inhouse/reply", { body: {} }],
  ], calls);
  assert.equal(await runOnce(config, f), "answered");
  assert.equal(calls.find(([, p]) => p === "OLLAMA/api/chat")[2].messages[0].content, SYSTEM);
});
test("runOnce explains a missing model and refuses an empty answer", async () => {
  const base = [["GET", "/v1/inhouse?limit=200", { body: { data: [msg(1, "owner", "q", 1)] } }], ["GET", /^\/v1\/inhouse\?chat=1/, { body: { data: [msg(1, "owner", "q", 1)] } }]];
  await assert.rejects(runOnce(config, fakeFetch([...base, ["POST", "OLLAMA/api/chat", { status: 404, body: {} }]], [])), /Is Ollama running/);
  await assert.rejects(runOnce(config, fakeFetch([...base, ["POST", "OLLAMA/api/chat", { body: { message: { content: " " } } }]], [])), /empty answer/);
});
test("configFromEnv only talks to this computer", () => {
  assert.throws(() => configFromEnv({}), /NOU_TOKEN/);
  assert.throws(() => configFromEnv({ NOU_TOKEN: "t", OLLAMA_URL: "http://example.com" }), /on this computer/);
  assert.equal(configFromEnv({ NOU_TOKEN: "t" }).model, "llama3.2");
});
