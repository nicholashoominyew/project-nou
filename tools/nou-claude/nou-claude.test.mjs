import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, actionable, buildPrompt, pollBot, runBot } from "./nou-claude.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "nou-claude-test-"));

/** A fake NOU API serving a mutable list of messages, with the same mention filter and auth check. */
async function fakeApi(messages) {
  const seen = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ auth: req.headers.authorization, path: u.pathname + u.search });
    if (!/^Bearer tok-/.test(req.headers.authorization || "")) { res.writeHead(401); return res.end("{}"); }
    const after = Number(u.searchParams.get("after") || 0);
    const who = u.searchParams.get("mentioning");
    const out = messages.filter((m) => m.id > after && (!who || m.body.includes("@" + who)));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, messages, seen, close: () => server.close() };
}

const msg = (id, author, kind, body) => ({ id, author, kind, body, at: "t", room: "general" });
function cfgFor(api, extra = {}, bots) {
  const dir = tmp();
  const env = { NOU_API_URL: api.url, NOU_TOKEN: "tok-claude", NOU_TOKEN_KURA: "tok-kura", NOU_CLAUDE_STATE: join(dir, "s.json"), NOU_BOTS_FILE: join(dir, "none.json"), ...extra };
  if (bots) { writeFileSync(join(dir, "bots.json"), JSON.stringify({ bots })); env.NOU_BOTS_FILE = join(dir, "bots.json"); }
  return config(env);
}

test("config refuses a non-local API address and bad bot files", () => {
  assert.throws(() => config({ NOU_API_URL: "http://example.com:47651", NOU_BOTS_FILE: "/nonexistent" }), /on this computer/);
  assert.throws(() => config({ NOU_API_URL: "https://127.0.0.1:47651", NOU_BOTS_FILE: "/nonexistent" }), /on this computer/);
  const dir = tmp(); const f = join(dir, "b.json");
  writeFileSync(f, JSON.stringify({ bots: [{ name: "A" }, { name: "a" }] }));
  assert.throws(() => config({ NOU_BOTS_FILE: f }), /Duplicate/);
  writeFileSync(f, JSON.stringify({ bots: [{ name: "A", type: "command" }] }));
  assert.throws(() => config({ NOU_BOTS_FILE: f }), /needs a command/);
  writeFileSync(f, JSON.stringify({ bots: [{ name: "A", type: "weird" }] }));
  assert.throws(() => config({ NOU_BOTS_FILE: f }), /type must be/);
});

test("default bot is Claude with NOU_TOKEN", () => {
  const c = config({ NOU_TOKEN: "tok-x", NOU_BOTS_FILE: "/nonexistent" });
  assert.equal(c.bots.length, 1);
  assert.equal(c.bots[0].name, "Claude");
  assert.equal(c.bots[0].token, "tok-x");
});

test("first poll sets a baseline and handles nothing", async () => {
  const api = await fakeApi([msg(1, "Nick", "owner", "hello @Claude"), msg(2, "Claude", "assistant", "hi")]);
  const cfg = cfgFor(api); const state = { bots: {} }; const runs = [];
  const n = await pollBot(cfg, cfg.bots[0], state, () => {}, async (...a) => { runs.push(a); return { code: 0, out: "" }; });
  assert.equal(n, 0); assert.equal(runs.length, 0); assert.equal(state.bots.Claude.last, 2);
  api.close();
});

test("an owner tag starts the bot once and is not repeated", async () => {
  const api = await fakeApi([msg(1, "Nick", "owner", "old")]);
  const cfg = cfgFor(api); const state = { bots: {} }; const runs = [];
  const run = async (c, bot, m) => { runs.push(m.id); return { code: 0, out: "" }; };
  await pollBot(cfg, cfg.bots[0], state, () => {}, run);
  api.messages.push(msg(2, "Nick", "owner", "please help @Claude"));
  assert.equal(await pollBot(cfg, cfg.bots[0], state, () => {}, run), 1);
  assert.equal(await pollBot(cfg, cfg.bots[0], state, () => {}, run), 0);
  assert.deepEqual(runs, [2]);
  assert.ok(api.seen.every((s) => s.auth === "Bearer tok-claude"));
  api.close();
});

test("a failed run is not retried, and its own messages and bot tags are ignored by default", async () => {
  const api = await fakeApi([]);
  const cfg = cfgFor(api); const state = { bots: {} }; const runs = [];
  await pollBot(cfg, cfg.bots[0], state, () => {}, async () => ({ code: 0 }));
  api.messages.push(msg(1, "Claude", "assistant", "@Claude self"));
  api.messages.push(msg(2, "Kura", "assistant", "@Claude from a bot"));
  api.messages.push(msg(3, "Nick", "owner", "@Claude real"));
  const run = async (c, b, m) => { runs.push(m.id); return { code: 1, out: "boom" }; };
  assert.equal(await pollBot(cfg, cfg.bots[0], state, () => {}, run), 1);
  assert.deepEqual(runs, [3]);
  assert.equal(await pollBot(cfg, cfg.bots[0], state, () => {}, run), 0);
  api.close();
});

test("allowFrom lets a named bot trigger, with a limit per 10 minutes", async () => {
  const api = await fakeApi([]);
  const cfg = cfgFor(api, {}, [{ name: "Claude", tokenEnv: "NOU_TOKEN", allowFrom: ["Kura"], maxBotRuns: 2 }, { name: "Kura", tokenEnv: "NOU_TOKEN_KURA", type: "command", command: "x" }]);
  const bot = cfg.bots[0]; const state = { bots: {} }; const runs = []; let t = 1000;
  await pollBot(cfg, bot, state, () => {}, async () => ({ code: 0 }), () => t);
  for (const id of [1, 2, 3]) api.messages.push(msg(id, "Kura", "assistant", "@Claude task " + id));
  api.messages.push(msg(4, "Other", "assistant", "@Claude not allowed"));
  const run = async (c, b, m) => { runs.push(m.id); return { code: 0 }; };
  assert.equal(await pollBot(cfg, bot, state, () => {}, run, () => t), 2);
  assert.deepEqual(runs, [1, 2]);
  t += 11 * 60 * 1000;
  api.messages.push(msg(5, "Kura", "assistant", "@Claude later"));
  assert.equal(await pollBot(cfg, bot, state, () => {}, run, () => t), 1);
  api.close();
});

test("each bot polls with its own token", async () => {
  const api = await fakeApi([]);
  const cfg = cfgFor(api, {}, [{ name: "Claude", tokenEnv: "NOU_TOKEN" }, { name: "Kura", tokenEnv: "NOU_TOKEN_KURA", type: "command", command: "x" }]);
  const state = { bots: {} };
  for (const b of cfg.bots) await pollBot(cfg, b, state, () => {}, async () => ({ code: 0 }));
  assert.deepEqual(api.seen.map((s) => s.auth), ["Bearer tok-claude", "Bearer tok-kura"]);
  api.close();
});

test("the prompt names the other bots and treats the message as data", () => {
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, {}, [{ name: "Claude" }, { name: "Kura", type: "command", command: "x" }]);
  const p = buildPrompt(cfg, cfg.bots[0], msg(9, "Nick", "owner", "do a thing @Claude"));
  assert.match(p, /<message>\ndo a thing @Claude\n<\/message>/);
  assert.match(p, /handoff/); assert.match(p, /Kura/);
  assert.match(p, /leave out the parent field/);
  const solo = buildPrompt(config({ NOU_BOTS_FILE: "/nonexistent" }), config({ NOU_BOTS_FILE: "/nonexistent" }).bots[0], msg(1, "Nick", "owner", "x"));
  assert.doesNotMatch(solo, /handoff/);
});

test("a command bot gets the prompt on stdin and its own token, and the token is not written to a file", async () => {
  const dir = tmp(); const script = join(dir, "bot.mjs"); const outFile = join(dir, "out.json");
  writeFileSync(script, `import {readFileSync,writeFileSync} from "node:fs"; let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{writeFileSync(${JSON.stringify(outFile)},JSON.stringify({s,t:process.env.NOU_TOKEN,id:process.env.NOU_MESSAGE_ID,n:process.env.NOU_BOT_NAME}));});`);
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, {}, [{ name: "Claude" }, { name: "Kura", tokenEnv: "NOU_TOKEN_KURA", type: "command", command: process.execPath, args: [script] }]);
  const r = await runBot(cfg, cfg.bots[1], msg(7, "Nick", "owner", "hi @Kura"), () => {});
  assert.equal(r.code, 0);
  const o = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(o.t, "tok-kura"); assert.equal(o.id, "7"); assert.equal(o.n, "Kura"); assert.match(o.s, /hi @Kura/);
});

test("the Claude bot is started with NOU tools only, a token-free MCP file, and the token in the environment", async () => {
  const dir = tmp(); const fake = join(dir, "fake-claude.mjs"); const outFile = join(dir, "out.json");
  writeFileSync(fake, `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from "node:fs"; const a=process.argv.slice(2); const cfg=readFileSync(a[a.indexOf("--mcp-config")+1],"utf8"); let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{writeFileSync(${JSON.stringify(outFile)},JSON.stringify({a,cfg,t:process.env.NOU_TOKEN,s}));});`);
  const { chmodSync } = await import("node:fs"); chmodSync(fake, 0o755);
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, { NOU_CLAUDE_BIN: fake });
  const r = await runBot(cfg, cfg.bots[0], msg(3, "Nick", "owner", "@Claude hi"), () => {});
  assert.equal(r.code, 0);
  const o = JSON.parse(readFileSync(outFile, "utf8"));
  assert.ok(o.a.includes("-p") && o.a.includes("--strict-mcp-config"));
  assert.equal(o.a[o.a.indexOf("--allowedTools") + 1], "mcp__nou");
  assert.ok(!o.cfg.includes("tok-claude")); assert.ok(o.cfg.includes("${NOU_TOKEN}"));
  assert.equal(o.t, "tok-claude"); assert.match(o.s, /@Claude hi/);
});

test("a missing command is reported, not thrown", async () => {
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, { NOU_CLAUDE_BIN: "/definitely/not/here" });
  const r = await runBot(cfg, cfg.bots[0], msg(1, "Nick", "owner", "x"), () => {});
  assert.equal(r.code !== 0, true);
});
