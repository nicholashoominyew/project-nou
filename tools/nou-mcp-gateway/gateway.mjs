#!/usr/bin/env node
// NOU MCP gateway: Streamable HTTP at /mcp for a remote MCP client, through a private HTTPS reverse proxy on this computer.
//
//   * Listens on loopback only. Every request needs the gateway's own bearer token, which is not a NOU token.
//   * NOU_TOKEN stays here and is only ever sent to NOU's loopback API.
//   * Tools and their behaviour come from the stdio bridge (../nou-mcp/nou-mcp.mjs). Only reads and proposals are offered:
//     there is no approve or apply tool, and the person approves every change inside NOU.
//   * Never logs tokens, headers, bodies or note content.
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { handleMessage, SERVER_INFO, TOOLS } from "../nou-mcp/nou-mcp.mjs";
import { loadConfig, ConfigError } from "./config.mjs";

const MAX_BODY = 128 * 1024;
const MAX_SESSIONS = 16;
const IDLE_MS = 30 * 60_000;
const MAX_AUTH_FAILURES_PER_MINUTE = 20;
/** The stdio tools that write to the Bots Hub straight away. They change no note, but nothing approves them, so they are off unless asked for. */
const HUB_WRITES = ["nou_chat_post", "nou_queue_add", "nou_queue_update"];

/**
 * The tools offered remotely. Decided from what each one would send to NOU, not from its name: reads (GET) and proposals are offered,
 * anything else is left out, so a direct write added to the stdio bridge later does not appear here by itself.
 */
export function remoteTools(allowHubWrites) {
  return TOOLS.filter((tool) => {
    const plan = tool.run({});
    if (plan.method === "GET") return plan.path.startsWith("/v1/");
    if (plan.method === "POST" && plan.path === "/v1/proposals") return true;
    return allowHubWrites && HUB_WRITES.includes(tool.name);
  }).map((t) => t.name);
}

const digest = (value) => createHash("sha256").update(value).digest();

export async function startGateway(config, { log = (line) => process.stderr.write("[nou-mcp-gateway] " + line + "\n"), idleMs = IDLE_MS, maxSessions = MAX_SESSIONS } = {}) {
  const expected = digest(config.gatewayToken);
  const api = { token: config.nouToken, url: config.apiUrl };
  const offered = new Set(remoteTools(config.allowHubWrites));
  const sessions = new Map(); // id -> { transport, server, seen, streams }
  let failures = [];
  let allowedHosts = new Set();
  /** Defence in depth: should either secret ever come back from NOU, it does not leave this computer. */
  const scrub = (s) => s.split(config.nouToken).join("[redacted]").split(config.gatewayToken).join("[redacted]");

  async function mcpServer() {
    const shared = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, api)).result;
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: shared.instructions });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const all = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, api)).result.tools;
      return { tools: all.filter((t) => offered.has(t.name)) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      if (!offered.has(name)) throw new McpError(-32602, "Unknown tool: " + String(name).slice(0, 80));
      // The stdio bridge checks the arguments, calls NOU and words the answer, so both ways in behave the same.
      const reply = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: request.params }, api);
      if (reply.error) throw new McpError(reply.error.code, reply.error.message);
      return { ...reply.result, content: reply.result.content.map((c) => (c.type === "text" ? { ...c, text: scrub(c.text) } : c)) };
    });
    return server;
  }

  function refuse(res, status, message, reason, headers = {}) {
    log(`refused ${status} ${reason}`);
    if (res.headersSent) return res.end();
    // The request body is not read: the connection is closed after the answer.
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close", ...headers });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
  }

  /** Everything that must be true before a request is looked at. X-Forwarded-* and Forwarded are never read. */
  function gate(req, res) {
    const from = req.socket.remoteAddress;
    if (from !== "127.0.0.1" && from !== "::1" && from !== "::ffff:127.0.0.1") return refuse(res, 403, "Forbidden", "not-loopback");
    const hosts = req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === "host").length;
    if (hosts !== 1 || !allowedHosts.has(String(req.headers.host).toLowerCase())) return refuse(res, 403, "Unexpected host", "host");
    // Tailscale marks requests that came from the public internet. This gateway is for the private tailnet only.
    if (req.headers["tailscale-funnel-request"] !== undefined) return refuse(res, 403, "Public (Funnel) requests are not allowed", "funnel");
    if (req.headers.origin !== undefined && !config.allowedOrigins.includes(req.headers.origin.toLowerCase())) return refuse(res, 403, "Browser requests are not allowed", "origin");

    const match = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(req.headers.authorization ?? "");
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      const now = Date.now();
      failures = failures.filter((t) => now - t < 60_000);
      if (failures.length >= MAX_AUTH_FAILURES_PER_MINUTE) return refuse(res, 429, "Too many failed attempts", "auth-rate");
      failures.push(now);
      return refuse(res, 401, "A valid gateway bearer token is required", match ? "auth-wrong" : "auth-missing", { "WWW-Authenticate": 'Bearer realm="nou-mcp-gateway"' });
    }
    if (req.url !== "/mcp") return refuse(res, 404, "Not found", "path");
    if (!["GET", "POST", "DELETE"].includes(req.method)) return refuse(res, 405, "Method not allowed", "method", { Allow: "GET, POST, DELETE" });
    return true;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      if (Number(req.headers["content-length"]) > MAX_BODY) return reject(413);
      req.on("data", (d) => { size += d.length; if (size > MAX_BODY) { reject(413); req.pause(); } else chunks.push(d); });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(400); } });
      req.on("error", () => reject(400));
    });
  }

  async function drop(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { await s.server.close(); } catch { /* already closed */ }
  }

  async function handle(req, res) {
    if (gate(req, res) !== true) return;
    let body;
    if (req.method === "POST") {
      try { body = await readJson(req); } catch (status) { return refuse(res, status === 413 ? 413 : 400, status === 413 ? "The request is too large" : "The body must be JSON", "body"); }
    }
    const id = req.headers["mcp-session-id"];
    let session = id === undefined ? undefined : sessions.get(id);
    if (id !== undefined && !session) return refuse(res, 404, "Session not found", "session-unknown");
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(body)) return refuse(res, 400, "Start with an initialize request", "session-missing");
      // Full: the session unused the longest makes room (its client simply initializes again).
      while (sessions.size >= maxSessions) await drop([...sessions].sort((a, b) => a[1].seen - b[1].seen)[0][0]);
      const server = await mcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (newId) => { sessions.set(newId, session); log("session started"); },
      });
      session = { transport, server, seen: Date.now(), streams: 0 };
      transport.onclose = () => { if (transport.sessionId && sessions.delete(transport.sessionId)) log("session ended"); };
      await server.connect(transport);
    }
    session.seen = Date.now();
    if (req.method === "GET") { session.streams++; res.once("close", () => { session.streams--; session.seen = Date.now(); }); }
    res.setHeader("Cache-Control", "no-store");
    await session.transport.handleRequest(req, res, body);
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch((e) => { log(`error ${e?.name ?? "Error"}`); if (!res.headersSent) refuse(res, 500, "Internal error", "internal"); else res.end(); });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  const { address, port } = server.address();
  if (address !== "127.0.0.1" && address !== "::1") { server.close(); throw new ConfigError("The gateway did not bind to loopback."); }
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...config.allowedHosts]);

  const sweep = setInterval(() => {
    for (const [id, s] of sessions) if (s.streams === 0 && Date.now() - s.seen > idleMs) void drop(id);
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  log(`listening on ${config.host === "::1" ? "[::1]" : config.host}:${port}/mcp, ${offered.size} tools, Hub writes ${config.allowHubWrites ? "on" : "off"}, ${config.allowedHosts.length} proxy host name(s)`);
  return {
    port, server, sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(drop));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  let gateway;
  try { gateway = await startGateway(loadConfig()); }
  catch (e) {
    // Only our own messages and the system's error code are shown.
    process.stderr.write("[nou-mcp-gateway] " + (e instanceof ConfigError ? e.message : `could not start (${e?.code ?? e?.name ?? "error"})`) + "\n");
    process.exit(1);
  }
  const stop = () => { void gateway.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
