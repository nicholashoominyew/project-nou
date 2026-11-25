// Settings of the NOU MCP gateway. Anything unsafe stops the gateway from starting. No message ever repeats a configured value,
// because a secret pasted into the wrong setting must not reach a terminal or a log.
import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 47660;
export const DEFAULT_API_URL = "http://127.0.0.1:47651";
const MIN_TOKEN = 32, MAX_TOKEN = 256;
const FILE_KEYS = ["gatewayToken", "nouToken", "nouApiUrl", "host", "port", "allowedHosts", "allowedOrigins", "allowHubWrites"];

export class ConfigError extends Error {}
const fail = (message) => { throw new ConfigError(message); };

function readFileSettings(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { fail("NOU_GATEWAY_CONFIG names a file that cannot be read."); }
  let json;
  // A JSON parse error quotes the file's text, which holds secrets, so it is replaced.
  try { json = JSON.parse(text.replace(/^﻿/, "")); } catch { fail("The gateway config file is not valid JSON."); }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("The gateway config file must hold one JSON object.");
  if (Object.keys(json).some((k) => !FILE_KEYS.includes(k))) fail("The gateway config file has an unknown setting. Known settings: " + FILE_KEYS.join(", ") + ".");
  return json;
}

const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v, name) => {
  if (v === undefined || v === "") return [];
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : fail(name + " must be a list.");
  return items.map((x) => (typeof x === "string" ? x.trim() : fail(name + " must hold text only."))).filter(Boolean);
};

/** The address of NOU's own API. Only plain HTTP on this computer: the NOU token is never sent anywhere else. */
function apiUrl(value) {
  let u;
  try { u = new URL(value); } catch { fail("NOU_API_URL is not an address."); }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    fail("NOU_API_URL must be an http:// address on this computer (127.0.0.1, localhost or [::1]) with nothing after the port.");
  return u.origin;
}

/** A Tailscale name the private reverse proxy is reached by, as it appears in the Host header. */
function proxyHost(value) {
  const host = value.toLowerCase();
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net(:\d{1,5})?$/.test(host)) fail("NOU_GATEWAY_ALLOWED_HOSTS takes full Tailscale names only (for example my-pc.my-tailnet.ts.net), without https:// and without wildcards.");
  return host;
}

function origin(value) {
  let u;
  try { u = new URL(value); } catch { fail("NOU_GATEWAY_ALLOWED_ORIGINS takes exact https:// origins only."); }
  if (u.protocol !== "https:" || u.origin !== value.toLowerCase()) fail("NOU_GATEWAY_ALLOWED_ORIGINS takes exact https:// origins only (no wildcard, path or trailing slash).");
  return u.origin;
}

export function loadConfig(env = process.env) {
  const file = text(env.NOU_GATEWAY_CONFIG) ? readFileSettings(text(env.NOU_GATEWAY_CONFIG)) : {};
  const pick = (envName, key) => (env[envName] !== undefined && env[envName] !== "" ? env[envName] : file[key]);

  const nouToken = text(pick("NOU_TOKEN", "nouToken"));
  const gatewayToken = text(pick("NOU_GATEWAY_TOKEN", "gatewayToken"));
  if (!nouToken) fail("NOU_TOKEN is not set: create a token in NOU under AI access. It stays on this computer.");
  if (!gatewayToken) fail("NOU_GATEWAY_TOKEN is not set: make a new random secret for the remote client (see docs/development/MCP-GATEWAY.md).");
  if (gatewayToken === nouToken || gatewayToken.startsWith("nou_")) fail("NOU_GATEWAY_TOKEN must not be a NOU token. Make a separate random secret for the remote client.");
  if (gatewayToken.length < MIN_TOKEN || gatewayToken.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(gatewayToken)) fail(`NOU_GATEWAY_TOKEN must be ${MIN_TOKEN} to ${MAX_TOKEN} printable characters without spaces.`);

  const host = text(pick("NOU_GATEWAY_HOST", "host")) || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") fail("NOU_GATEWAY_HOST must be 127.0.0.1 or ::1. The gateway only listens on this computer.");
  const rawPort = pick("NOU_GATEWAY_PORT", "port") ?? DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(String(rawPort).trim()) ? Number(rawPort) : NaN;
  if (!(port >= 1024 && port <= 65535)) fail("NOU_GATEWAY_PORT must be a number from 1024 to 65535.");
  const url = apiUrl(text(pick("NOU_API_URL", "nouApiUrl")) || DEFAULT_API_URL);
  if (Number(new URL(url).port || 80) === port) fail("NOU_GATEWAY_PORT must differ from the port of NOU's own API.");

  const hubWrites = pick("NOU_GATEWAY_ALLOW_HUB_WRITES", "allowHubWrites");
  if (![undefined, true, false, "0", "1"].includes(hubWrites)) fail("NOU_GATEWAY_ALLOW_HUB_WRITES must be 0 or 1.");

  return {
    host, port, apiUrl: url, nouToken, gatewayToken,
    allowedHosts: list(pick("NOU_GATEWAY_ALLOWED_HOSTS", "allowedHosts"), "NOU_GATEWAY_ALLOWED_HOSTS").map(proxyHost),
    allowedOrigins: list(pick("NOU_GATEWAY_ALLOWED_ORIGINS", "allowedOrigins"), "NOU_GATEWAY_ALLOWED_ORIGINS").map(origin),
    allowHubWrites: hubWrites === true || hubWrites === "1",
  };
}
