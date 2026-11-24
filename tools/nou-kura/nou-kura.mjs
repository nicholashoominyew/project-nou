#!/usr/bin/env node
// Kura: the runner behind the Bots Hub "In-house bot" chat.
//
// NOU keeps the private chat (it is a separate channel that no other bot can read). This small script is what answers in it: it reads your
// questions through the local API with a token that has ONLY the inhouse:read and inhouse:write scopes, asks a model running on this computer
// (Ollama, on 127.0.0.1) and posts the answer back. Nothing leaves your computer, it has no access to your notes, and it has no dependencies
// (needs Node 18 or newer).
//
//   NOU_TOKEN      the token (create it under Settings, then AI access, with the two in-house scopes)
//   NOU_API_URL    default http://127.0.0.1:47651
//   OLLAMA_URL     default http://127.0.0.1:11434
//   KURA_MODEL     the Ollama model to use, default llama3.2
//   KURA_POLL_MS   how often to look for a question, default 4000
//
// Run it with:  node tools/nou-kura/nou-kura.mjs
import { pathToFileURL } from "node:url";

export const SYSTEM = "You are Kura, a small assistant that runs on the user's own computer inside NOU. You are private to the user. Answer briefly and plainly in British English. You cannot read or change the user's notes; if asked to, say that you cannot and suggest the user opens the note. Never claim to have done something you cannot do.";
const MAX_REPLY = 3900;
const LOOPBACK = (u) => { try { const h = new URL(u).hostname; return h === "127.0.0.1" || h === "localhost" || h === "[::1]"; } catch { return false; } };

/** The owner's messages that have not been answered yet: everything after the last bot reply. */
export function pending(history) {
  let last = -1; history.forEach((m, i) => { if (m.author === "bot") last = i; });
  return history.slice(last + 1).filter((m) => m.author === "owner");
}
/** The conversation for the model: the system prompt, then up to the last 20 messages with the owner as "user" and Kura as "assistant". */
export function buildMessages(history) {
  return [{ role: "system", content: SYSTEM }, ...history.slice(-20).map((m) => ({ role: m.author === "owner" ? "user" : "assistant", content: m.body }))];
}

async function nou(config, f, method, path, body) {
  const res = await f(config.api + path, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: "Bearer " + config.token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`NOU said no (${res.status}): ${json?.error ?? "no details"}`);
  return json;
}

/** One look: fetch the channel, and if a question is waiting, ask the model and post the answer. Returns "idle", "answered" or throws. */
export async function runOnce(config, f = fetch) {
  const got = await nou(config, f, "GET", "/v1/inhouse?limit=50");
  const history = Array.isArray(got?.data) ? got.data : [];
  if (!pending(history).length) return "idle";
  const res = await f(config.ollama + "/api/chat", { method: "POST", redirect: "error", signal: AbortSignal.timeout(120000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, stream: false, messages: buildMessages(history) }) });
  if (!res.ok) throw new Error(`The local model said no (${res.status}). Is Ollama running and is the model "${config.model}" installed?`);
  const answer = String((await res.json().catch(() => null))?.message?.content ?? "").trim().slice(0, MAX_REPLY);
  if (!answer) throw new Error("The local model gave an empty answer");
  await nou(config, f, "POST", "/v1/inhouse/reply", { body: answer });
  return "answered";
}

export function configFromEnv(env = process.env) {
  const config = { token: env.NOU_TOKEN ?? "", api: (env.NOU_API_URL ?? "http://127.0.0.1:47651").replace(/\/$/, ""), ollama: (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""), model: env.KURA_MODEL ?? "llama3.2", pollMs: Math.max(1000, Number(env.KURA_POLL_MS) || 4000) };
  if (!config.token) throw new Error("NOU_TOKEN is not set. Create a token under Settings, then AI access, with the inhouse:read and inhouse:write scopes.");
  if (!LOOPBACK(config.api) || !LOOPBACK(config.ollama)) throw new Error("NOU_API_URL and OLLAMA_URL must be addresses on this computer (127.0.0.1 or localhost).");
  return config;
}

async function main() {
  let config; try { config = configFromEnv(); } catch (e) { process.stderr.write(e.message + "\n"); process.exit(1); }
  process.stderr.write(`Kura is running with model ${config.model}. Press Ctrl+C to stop.\n`);
  for (;;) {
    try { await runOnce(config); } catch (e) { process.stderr.write(String(e.message ?? e) + "\n"); }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
