import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, actionable, buildPrompt, pollBot, relayCard, runBot } from "./nou-claude.mjs";

const SCRIPT = fileURLToPath(new URL("./nou-claude.mjs", import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), "nou-claude-test-"));

/** A fake NOU API serving a mutable list of messages with the real response shape ({ data: [...] }), the same mention filter and auth check, and recording what is posted. */
async function fakeApi(messages) {
  const seen = []; const posts = []; const control = { postStatus: 201 };
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ auth: req.headers.authorization, method: req.method, path: u.pathname + u.search });
    if (!/^Bearer tok-/.test(req.headers.authorization || "")) { res.writeHead(401); return res.end("{}"); }
    if (req.method === "POST") {
      let raw = ""; req.on("data", (d) => { raw += d; });
      return req.on("end", () => { let body = null; try { body = JSON.parse(raw); } catch { /* recorded as null */ } posts.push({ auth: req.headers.authorization, path: u.pathname, body }); res.writeHead(control.postStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ id: 99 })); });
    }
    const after = Number(u.searchParams.get("after") || 0);
    const who = u.searchParams.get("mentioning");
    const out = messages.filter((m) => m.id > after && (!who || m.body.toLowerCase().includes("@" + who.toLowerCase())));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content_is_untrusted_data: true, data: out }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, messages, seen, posts, control, close: () => server.close() };
}

const msg = (id, author, kind, body) => ({ id, author, kind, body, at: "t", room: "general" });
function cfgFor(api, extra = {}, bots) {
  const dir = tmp();
  const env = { NOU_API_URL: api.url, NOU_TOKEN: "tok-claude", NOU_TOKEN_KURA: "tok-kura", NOU_TOKEN_RELAY: "tok-relay", NOU_CLAUDE_STATE: join(dir, "s.json"), NOU_BOTS_FILE: join(dir, "none.json"), ...extra };
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

test("the prompt tells Claude how to ask for timetable and Home changes, as requests", () => {
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, {}, [{ name: "Claude" }, { name: "Kura", type: "external" }]);
  const p = buildPrompt(cfg, cfg.bots[0], msg(9, "Nick", "owner", "move work earlier @Claude"));
  assert.match(p, /nou_timetable_read/); assert.match(p, /nou_propose_timetable_set_block/); assert.match(p, /nou_propose_timetable_add_activity/); assert.match(p, /nou_propose_home_widgets/);
  assert.match(p, /never hide "Waiting for approval"/); assert.match(p, /\n7\. If you cannot do it/); assert.match(p, /\n8\. To hand work to another bot/);
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

// ---- relay and external bots ----
const relays = [
  { name: "Claude", tokenEnv: "NOU_TOKEN", type: "claude", allowFrom: [] },
  { name: "Kura", type: "external" },
  { name: "xGrok", type: "relay", allowFrom: ["Claude"] },
  { name: "GrokBots", type: "relay", allowFrom: ["Claude"], maxBotRuns: 2 },
];
const byName = (cfg, n) => cfg.bots.find((b) => b.name === n);
const baseline = (cfg, bot, state) => pollBot(cfg, bot, state, () => {});

test("a relay bot uses NOU_TOKEN_RELAY by default, and an external bot never gets a token", () => {
  const cfg = cfgFor({ url: "http://127.0.0.1:1" }, {}, relays);
  assert.deepEqual(cfg.bots.map((b) => [b.name, b.type, b.tokenEnv, b.token]), [["Claude", "claude", "NOU_TOKEN", "tok-claude"], ["Kura", "external", "NOU_TOKEN", ""], ["xGrok", "relay", "NOU_TOKEN_RELAY", "tok-relay"], ["GrokBots", "relay", "NOU_TOKEN_RELAY", "tok-relay"]]);
  assert.throws(() => cfgFor({ url: "http://127.0.0.1:1" }, {}, [{ name: "X", type: "robot" }]), /"relay" or "external"/);
});

test("an owner tag of a relay bot posts one approval card with the @Name removed, signed with the shared relay token", async () => {
  const api = await fakeApi([msg(1, "Nick", "owner", "old @xGrok")]);
  const cfg = cfgFor(api, {}, relays); const state = { bots: {} }; const bot = byName(cfg, "xGrok");
  await baseline(cfg, bot, state);
  api.messages.push(msg(2, "Nick", "owner", "@xGrok please read this @xgrok, thanks\nand ask @xGrokker too"));
  assert.equal(await pollBot(cfg, bot, state, () => {}), 1);
  assert.equal(await pollBot(cfg, bot, state, () => {}), 0, "the tag is not handled twice");
  assert.equal(api.posts.length, 1);
  const [post] = api.posts;
  assert.equal(post.auth, "Bearer tok-relay"); assert.equal(post.path, "/v1/chat");
  assert.deepEqual(Object.keys(post.body).sort(), ["body", "queue_title", "room", "type"]);
  assert.equal(post.body.type, "approval"); assert.equal(post.body.room, "general");
  assert.equal(post.body.body, "Ready to paste into xGrok\n\nplease read this , thanks\nand ask @xGrokker too");
  assert.doesNotMatch(post.body.body.replace("@xGrokker", ""), /@xgrok/i, "its own tag is gone, so the card cannot tag it again");
  assert.equal(post.body.queue_title, "Paste into xGrok: please read this , thanks and ask @xGrokker too");
  api.close();
});

test("relay cards stay inside NOU's limits for long messages, and never cut a character in half", () => {
  const bot = { name: "GrokBots" };
  const long = relayCard(bot, { body: "@GrokBots " + "😀".repeat(5000) });
  assert.ok([...long.body].length <= 4000, "body max 4000 characters"); assert.ok(long.body.endsWith("[shortened to fit]")); assert.ok(long.body.startsWith("Ready to paste into GrokBots\n\n😀"));
  assert.ok([...long.queueTitle].length <= 160 && long.queueTitle.endsWith("…") && long.queueTitle.startsWith("Paste into GrokBots: 😀"));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(long)), "valid JSON, no lone surrogate");
  const exact = relayCard(bot, { body: "x".repeat(4000 - "Ready to paste into GrokBots\n\n".length) });
  assert.equal([...exact.body].length, 4000); assert.ok(!exact.body.includes("shortened"), "a message that just fits is not shortened");
  const empty = relayCard(bot, { body: "@GrokBots" }); assert.deepEqual(empty, { body: "Ready to paste into GrokBots", queueTitle: "Paste into GrokBots" });
  assert.ok(!/[\n\r\t]/.test(relayCard(bot, { body: "a\nb\tc" }).queueTitle), "the title is one line");
});

test("a relay reacts only to the owner by default, and to Claude's hand-offs when allowFrom names Claude (with the usual cap)", async () => {
  const api = await fakeApi([]);
  const cfg = cfgFor(api, {}, relays); const state = { bots: {} }; const x = byName(cfg, "xGrok"); const g = byName(cfg, "GrokBots");
  await baseline(cfg, x, state); await baseline(cfg, g, state);
  api.messages.push(msg(1, "Kura", "assistant", "@xGrok from Kura"), msg(2, "Claude", "assistant", "@xGrok hand-off from Claude"), msg(3, "Nick", "owner", "@xGrok from Nick"));
  assert.equal(await pollBot(cfg, x, state, () => {}), 2, "Claude's hand-off and Nick's tag, not Kura's");
  assert.deepEqual(api.posts.map((p) => p.body.body.split("\n\n")[1]), ["hand-off from Claude", "from Nick"]);
  api.posts.length = 0;
  for (const id of [4, 5, 6]) api.messages.push(msg(id, "Claude", "assistant", "@GrokBots task " + id));
  assert.equal(await pollBot(cfg, g, state, () => {}), 2, "at most maxBotRuns bot-triggered runs in 10 minutes");
  // Without allowFrom, a relay ignores every bot.
  const solo = cfgFor(api, {}, [{ name: "xGrok", type: "relay" }]); const st2 = { bots: {} }; await baseline(solo, solo.bots[0], st2);
  api.posts.length = 0; api.messages.push(msg(7, "Claude", "assistant", "@xGrok please"));
  assert.equal(await pollBot(solo, solo.bots[0], st2, () => {}), 0); assert.equal(api.posts.length, 0);
  api.close();
});

test("a failed card is reported and not retried", async () => {
  const api = await fakeApi([]);
  const cfg = cfgFor(api, {}, relays); const state = { bots: {} }; const bot = byName(cfg, "xGrok"); const logs = [];
  await baseline(cfg, bot, state);
  api.control.postStatus = 429; api.messages.push(msg(1, "Nick", "owner", "@xGrok try"));
  assert.equal(await pollBot(cfg, bot, state, (l) => logs.push(l)), 1);
  assert.match(logs.join("\n"), /exited with code 1.*NOU API 429/);
  api.control.postStatus = 201;
  assert.equal(await pollBot(cfg, bot, state, () => {}), 0); assert.equal(api.posts.length, 1);
  api.close();
});

test("an external bot is never polled or started, but Claude's prompt lists it (and the relays) for hand-offs", async () => {
  const api = await fakeApi([msg(1, "Nick", "owner", "@Kura hi")]);
  const cfg = cfgFor(api, {}, relays); const kura = byName(cfg, "Kura");
  assert.equal(await pollBot(cfg, kura, { bots: {} }, () => {}, async () => { throw new Error("must not run"); }), 0);
  assert.equal(api.seen.length, 0, "no request was made for it");
  assert.deepEqual(await runBot(cfg, kura, msg(1, "Nick", "owner", "@Kura hi"), () => {}), { code: 0, out: "An external bot starts itself." });
  const p = buildPrompt(cfg, byName(cfg, "Claude"), msg(2, "Nick", "owner", "@Claude plan it"));
  assert.match(p, /Kura \(it runs on its own/); assert.match(p, /xGrok \(it runs outside NOU, so Nick pastes/); assert.match(p, /GrokBots \(it runs outside NOU/);
  assert.doesNotMatch(p, /Claude \(/);
  api.close();
});

// ---- exiting with the parent ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(50); } return false; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Start the real runner as a child process with one command bot that records its pid and then waits forever. */
async function startRunner(extraEnv) {
  const api = await fakeApi([msg(1, "Nick", "owner", "old")]);
  const dir = tmp(); const pidFile = join(dir, "pid"); const bot = join(dir, "bot.mjs");
  writeFileSync(bot, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
  writeFileSync(join(dir, "bots.json"), JSON.stringify({ bots: [{ name: "Kura", tokenEnv: "NOU_TOKEN_KURA", type: "command", command: process.execPath, args: [bot] }] }));
  const runner = spawn(process.execPath, [SCRIPT], { env: { ...process.env, NOU_API_URL: api.url, NOU_TOKEN_KURA: "tok-kura", NOU_BOTS_FILE: join(dir, "bots.json"), NOU_CLAUDE_STATE: join(dir, "s.json"), NOU_CLAUDE_POLL_MS: "1000", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((r) => runner.on("exit", (code, signal) => r({ code, signal })));
  assert.ok(await until(() => api.seen.length > 0), "the runner polled once for its baseline");
  await sleep(100); api.messages.push(msg(2, "Nick", "owner", "start @Kura"));
  assert.ok(await until(() => existsSync(pidFile)), "the tag started the bot process");
  const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(alive(pid));
  return { runner, exited, pid, api };
}

test("with NOU_RUNNER_PARENT_PIPE=1 the runner stops when its stdin closes, taking the running bot process with it", async () => {
  const { runner, exited, pid, api } = await startRunner({ NOU_RUNNER_PARENT_PIPE: "1" });
  runner.stdin.end();
  const r = await Promise.race([exited, sleep(10000).then(() => "timeout")]);
  assert.deepEqual(r, { code: 0, signal: null });
  assert.ok(await until(() => !alive(pid), 5000), "the bot process is gone too");
  api.close();
});

test("without the parent pipe, closing stdin does not stop the runner; SIGTERM does, and it kills the bot process", { skip: process.platform === "win32" }, async () => {
  const { runner, exited, pid, api } = await startRunner({});
  runner.stdin.end(); await sleep(1500);
  assert.equal(runner.exitCode, null, "still running");
  runner.kill("SIGTERM");
  const r = await Promise.race([exited, sleep(10000).then(() => "timeout")]);
  assert.equal(r.code, 143);
  assert.ok(await until(() => !alive(pid), 5000), "the bot process is gone too");
  api.close();
});
