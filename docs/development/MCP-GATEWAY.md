# MCP gateway (Streamable HTTP) for a remote assistant

`tools/nou-mcp-gateway/` lets an MCP client on another device (intended: Grok Bot) use NOU's tools over HTTP. The stdio bridge (`tools/nou-mcp/nou-mcp.mjs`) is unchanged and keeps working without it.

## Topology

```
Grok Bot ──HTTPS──▶ Tailscale Serve ──HTTP──▶ gateway 127.0.0.1:47660/mcp ──HTTP──▶ NOU API 127.0.0.1:47651
(a tailnet device)  (private, on this PC)     checks the gateway token              checks NOU_TOKEN and its scopes
```

- Both NOU's API and the gateway listen on loopback only. The only way in from another device is Tailscale Serve on the same PC.
- **Never use Tailscale Funnel** (public internet) and never point Serve or any proxy at port 47651.
- **The client must be on your tailnet.** Private Serve cannot be reached from a service running in a provider's cloud. Check where Grok Bot actually runs before setting anything up.
- What the assistant reads (note text, timetable, habits, tasks) leaves your PC and goes to that assistant's provider. Give the NOU token only the scopes you want read. Locked notes are refused by NOU's API.

## Two credentials

| | `NOU_TOKEN` | `NOU_GATEWAY_TOKEN` |
| --- | --- | --- |
| Who holds it | The gateway, on the PC running NOU | The remote client (Grok Bot) |
| Used for | Gateway → NOU API only. Never sent to the client | Client → gateway, as `Authorization: Bearer …` on every request |
| Made | In NOU, **AI access**, with chosen scopes | By you, a new random secret (32 to 256 characters) |
| Revoke | Revoke it in NOU | Change the value and restart the gateway |

The gateway refuses to start if the two are equal or if the gateway token looks like a NOU token (`nou_…`).

## What is offered

Tool names, descriptions, argument checks and answers come from the stdio bridge, so both behave the same. Only **reads** and **proposals** are offered (25 tools at the time of writing, including `nou_timetable_read`). There is no approve or apply tool, and NOU's API has no route that does either: you approve each change inside NOU, unless an auto-approve rule you wrote covers it ([AUTO-APPROVE.md](AUTO-APPROVE.md)). Pick the bot in each rule so that a rule meant for a local one does not cover this remote one.

The three stdio tools that write to the Bots Hub at once (`nou_chat_post`, `nou_queue_add`, `nou_queue_update`) change no note but are not approved by anyone, so they are **off**. `NOU_GATEWAY_ALLOW_HUB_WRITES=1` turns them on if you decide the remote assistant may post. A tool added to the bridge later is offered only if it reads or proposes.

## Settings

Environment variables, or a JSON file named by `NOU_GATEWAY_CONFIG` (see `nou-gateway.example.json`; the environment wins). A file named `nou-gateway.local.json` is ignored by git. Keep it outside synced folders such as OneDrive.

| Variable | File key | Default | Notes |
| --- | --- | --- | --- |
| `NOU_TOKEN` | `nouToken` | none, required | |
| `NOU_GATEWAY_TOKEN` | `gatewayToken` | none, required | |
| `NOU_API_URL` | `nouApiUrl` | `http://127.0.0.1:47651` | `http://` on this computer only |
| `NOU_GATEWAY_HOST` | `host` | `127.0.0.1` | only `127.0.0.1` or `::1` |
| `NOU_GATEWAY_PORT` | `port` | `47660` | 1024 to 65535, not NOU's port |
| `NOU_GATEWAY_ALLOWED_HOSTS` | `allowedHosts` | none | the PC's full Tailscale name, e.g. `my-pc.my-tailnet.ts.net`; comma separated |
| `NOU_GATEWAY_ALLOWED_ORIGINS` | `allowedOrigins` | none | exact `https://` origins; only needed if a browser-based client sends `Origin` |
| `NOU_GATEWAY_ALLOW_HUB_WRITES` | `allowHubWrites` | off | `1` / `true` |

## Install and test

Node 20 or newer (verified with Node 26 on Windows 11; not yet run on Node 20 or 22).

```powershell
npm ci --prefix tools/nou-mcp-gateway
```

```powershell
npm test --prefix tools/nou-mcp-gateway
```

```powershell
node --test tests/mcp/nou-mcp.test.mjs
```

The first test command uses a fake NOU API and made-up secrets; the second is the stdio regression.

## Start and stop (Windows, PowerShell 7)

1. In NOU: **AI access** → create a token for this client with only the scopes it needs → switch the **Local API** on.
2. Make the gateway secret and put it straight on the clipboard, then store it in your password manager and give it to the client:

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard
```

3. Start it in a terminal you keep open. `-MaskInput` keeps the values off the screen and out of command history:

```powershell
$env:NOU_TOKEN = Read-Host "NOU token" -MaskInput
```

```powershell
$env:NOU_GATEWAY_TOKEN = Read-Host "Gateway token" -MaskInput
```

```powershell
$env:NOU_GATEWAY_ALLOWED_HOSTS = "my-pc.my-tailnet.ts.net"
```

```powershell
node tools/nou-mcp-gateway/gateway.mjs
```

It prints where it listens, how many tools it offers and, later, one line per refused request (status and reason only: never a token, header or note).

**Stop:** press Ctrl+C in that terminal, then close the terminal so the variables are gone. Nothing starts by itself: no service, scheduled task, autostart or firewall rule is created.

On Linux or macOS (the code has not been run there) set the same variables with `read -rs NOU_TOKEN; export NOU_TOKEN` and run the same `node` command.

## Private HTTPS with Tailscale Serve (not configured or tested by this work)

Prerequisites: Tailscale installed and signed in on the PC and on the client's device; MagicDNS and **HTTPS certificates** enabled for the tailnet; tailnet access rules limiting who may reach this PC. Check the syntax against your Tailscale version.

```powershell
tailscale serve --bg --https=443 127.0.0.1:47660
```

```powershell
tailscale serve status
```

The client's MCP address is then `https://<pc-name>.<tailnet>.ts.net/mcp`, with the header `Authorization: Bearer <gateway token>`.

`--bg` stays in place across restarts of Tailscale and the PC until turned off (the gateway itself does not):

```powershell
tailscale serve --bg --https=443 127.0.0.1:47660 off
```

Serve passes your tailnet name through as the `Host` header, which is why it must be listed in `NOU_GATEWAY_ALLOWED_HOSTS`. If you use another HTTPS port, list `name:port`. Requests that Tailscale marks as public (Funnel) are refused, but that is a backstop: do not enable Funnel.

## How requests are checked

In this order, before anything MCP happens: the connection is from loopback; exactly one `Host` header with an expected value (DNS rebinding); no Funnel marker; no `Origin` unless listed; the bearer token (compared in constant time; after 20 failures a minute further wrong guesses get 429); path exactly `/mcp`; method `GET`, `POST` or `DELETE`. `X-Forwarded-*`, `Forwarded` and Tailscale identity headers are never read. No CORS header is ever sent. Bodies over 128 KB are refused.

Sessions follow the Streamable HTTP rules (the official `@modelcontextprotocol/sdk`): `initialize` returns `Mcp-Session-Id`; later requests carry it; `GET` opens the event stream; `DELETE` ends the session. At most 16 sessions (the least recently used makes room) and 30 minutes idle. The token is checked on every request, so a session id alone is useless.

NOU's own limit (120 requests a minute) still applies.

## Rollback to stdio only

1. Stop the gateway (Ctrl+C) and turn Serve off (above).
2. In NOU, revoke the token made for it. Switch the Local API off if nothing else uses it.
3. Optionally delete `tools/nou-mcp-gateway/node_modules` and any `nou-gateway.local.json`.

Existing stdio clients need no change: the gateway did not modify the bridge, NOU or its API.

## Verified, and not

**Fixture-tested** (fake NOU API; `npm test` in the gateway folder): settings refusal; missing, empty and wrong credentials; initialize, tool list and reads with the official client; sessions; proposals staying pending and no approve/apply tool; Host, Origin, Funnel, forwarded-header and path checks; no secret in responses or logs.

**Run once against a real NOU API** (25 November 2026, Windows 11, a test build on a new throwaway profile): refused without a token; 25 tools; timetable and search reads; a create-page proposal pending in the app with no page created; scope refusal passed through; no secret in the gateway log.

**Not verified** (needs the owner's PC and devices): Tailscale Serve and the `Host` value it sends; access from a second tailnet device; Grok Bot (whether it speaks Streamable HTTP, can send a bearer header and runs inside the tailnet); approving a gateway-made proposal in NOU's window; behaviour through sleep and reconnect over long periods; installed (not test) build of NOU.
