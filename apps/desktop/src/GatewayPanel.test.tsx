import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GatewayPanel, { runnerWord } from "./GatewayPanel";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { tokens: [] as any[], api: false, runner: null as any, runnerFail: "" } }));
const BOTS = [
  { name: "Claude", kind: "claude", note: "Starts Claude Code, replies and proposes" }, { name: "Kura", kind: "external", note: "Polls NOU itself, nothing to start here" },
  { name: "xGrok", kind: "relay", note: "Adds a ready-to-paste card for you to send" }, { name: "GrokBots", kind: "relay", note: "Adds a ready-to-paste card for you to send" },
];
const runner = (over: Record<string, unknown> = {}) => ({ enabled: false, running: false, api_on: state.api, port: 47651, node_ok: true, claude_ok: true, bots: BOTS, log_tail: "", last_error: null, ...over });
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "runner_status") return state.runner ?? runner();
  if (command === "runner_set_enabled") { if (state.runnerFail) throw new Error(state.runnerFail); state.runner = runner({ enabled: args.enabled, running: args.enabled && state.api }); return state.runner; }
  if (command === "gateway_list_tokens") return state.tokens;
  if (command === "gateway_api_status") return { enabled: state.api, running: state.api, port: 47651, address: "http://127.0.0.1:47651" };
  if (command === "gateway_api_set_enabled") { state.api = args.enabled; return { enabled: state.api, running: state.api, port: 47651, address: "http://127.0.0.1:47651" }; }
  if (command === "gateway_audit") return [{ id: 1, at: "2026-11-11T10:00:00.000Z", actor: "owner", action: "token.created", detail: {} }];
  if (command === "gateway_create_token") { const info = { id: "t1", name: args.name, scopes: args.scopes, created_at: "2026-11-11T10:00:00.000Z", last_used_at: null, revoked_at: null }; state.tokens = [info]; return { info, secret: "nou_SECRET123" }; }
  if (command === "gateway_revoke_token") { state.tokens = state.tokens.map(t => ({ ...t, revoked_at: "now" })); }
} }));
beforeEach(() => { calls.length = 0; state.tokens = []; state.api = false; state.runner = null; state.runnerFail = ""; });

describe("GatewayPanel", () => {
  it("creates a token with chosen scopes and shows the secret once, with a warning", async () => {
    render(<GatewayPanel onClose={() => {}} />);
    await screen.findByText("No tokens yet.");
    expect((screen.getByText("Create token") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Claude desktop" } });
    fireEvent.click(screen.getByLabelText(/Propose note changes/));
    fireEvent.click(screen.getByText("Create token"));
    expect(await screen.findByLabelText("Token value")).toBeTruthy();
    expect(screen.getByLabelText("Token value").textContent).toBe("nou_SECRET123");
    expect(screen.getByText(/only time it is shown/)).toBeTruthy();
    expect(calls).toContainEqual({ command: "gateway_create_token", args: { name: "Claude desktop", scopes: ["notes:read", "notes:write"] } });
    fireEvent.click(screen.getByText("I have saved it"));
    expect(screen.queryByLabelText("Token value")).toBeNull();
    expect(screen.queryByText("nou_SECRET123")).toBeNull();
  });
  it("cannot create a token with no scope", async () => {
    render(<GatewayPanel onClose={() => {}} />);
    await screen.findByText("No tokens yet.");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText(/Read notes/));
    expect((screen.getByText("Create token") as HTMLButtonElement).disabled).toBe(true);
  });
  it("revokes only after confirmation and shows the token as revoked", async () => {
    state.tokens = [{ id: "t1", name: "Grok", scopes: ["notes:read"], created_at: "2026-11-01T00:00:00.000Z", last_used_at: null, revoked_at: null }];
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<GatewayPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Revoke Grok"));
    expect(calls.some(c => c.command === "gateway_revoke_token")).toBe(false);
    fireEvent.click(screen.getByLabelText("Revoke Grok"));
    await waitFor(() => expect(calls).toContainEqual({ command: "gateway_revoke_token", args: { id: "t1" } }));
    expect(await screen.findByText("No active tokens.")).toBeTruthy();
    expect(screen.queryByText("revoked")).toBeNull();
    fireEvent.click(screen.getByText("Show 1 revoked token"));
    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(screen.queryByLabelText("Revoke Grok")).toBeNull();
    fireEvent.click(screen.getByText("Hide revoked tokens"));
    expect(screen.queryByText("revoked")).toBeNull();
    confirm.mockRestore();
  });
  it("keeps revoked tokens out of the way but lists active ones, with a plural count", async () => {
    const t = (id: string, name: string, revoked_at: string | null) => ({ id, name, scopes: ["notes:read"], created_at: "2026-11-01T00:00:00.000Z", last_used_at: null, revoked_at });
    state.tokens = [t("a", "Alpha", null), t("b", "Old one", "x"), t("c", "Old two", "y")];
    render(<GatewayPanel onClose={() => {}} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Old one")).toBeNull();
    fireEvent.click(screen.getByText("Show 2 revoked tokens"));
    expect(screen.getByText("Old one")).toBeTruthy();
    expect(screen.getByText("Old two")).toBeTruthy();
  });
  it("lists recent activity", async () => {
    render(<GatewayPanel onClose={() => {}} />);
    expect(await screen.findByText("token.created")).toBeTruthy();
  });
  it("the local API is off by default and is turned on and off with an explicit switch", async () => {
    render(<GatewayPanel onClose={() => {}} />);
    const toggle = (await screen.findByLabelText("Enable the local API")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Nothing is listening.")).toBeTruthy();
    expect(screen.queryByText(/How a tool uses it/)).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toContainEqual({ command: "gateway_api_set_enabled", args: { enabled: true } }));
    expect(await screen.findByText(/Listening at http:\/\/127.0.0.1:47651/)).toBeTruthy();
    expect(screen.getByText(/How a tool uses it/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Enable the local API"));
    await waitFor(() => expect(calls).toContainEqual({ command: "gateway_api_set_enabled", args: { enabled: false } }));
    expect(await screen.findByText("Nothing is listening.")).toBeTruthy();
  });

  describe("Bot runners", () => {
    const card = async () => { render(<GatewayPanel onClose={() => {}} />); return await screen.findByRole("region", { name: "Bot runners" }); };
    const word = () => screen.getByRole("status", { name: /Runner status/ }).textContent;
    it("shows the four bots with their one-line notes, and the runner as STOPPED by default", async () => {
      const c = await card();
      expect(within(c).getByRole("switch", { name: "Start bots when tagged" })).toBeTruthy();
      expect((within(c).getByRole("switch", { name: "Start bots when tagged" }) as HTMLInputElement).checked).toBe(false);
      await waitFor(() => expect(word()).toBe("STOPPED"));
      const items = within(within(c).getByRole("list", { name: "Bots" })).getAllByRole("listitem").map(li => li.textContent);
      expect(items).toEqual(["Claude Starts Claude Code, replies and proposes", "Kura Polls NOU itself, nothing to start here", "xGrok Adds a ready-to-paste card for you to send", "GrokBots Adds a ready-to-paste card for you to send"]);
    });
    it("the switch calls runner_set_enabled and shows RUNNING once the Local API is on", async () => {
      state.api = true;
      const c = await card();
      fireEvent.click(within(c).getByRole("switch", { name: "Start bots when tagged" }));
      await waitFor(() => expect(calls).toContainEqual({ command: "runner_set_enabled", args: { enabled: true } }));
      await waitFor(() => expect(word()).toBe("RUNNING"));
      expect((within(c).getByRole("switch", { name: "Start bots when tagged" }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(within(c).getByRole("switch", { name: "Start bots when tagged" }));
      await waitFor(() => expect(calls.filter(x => x.command === "runner_set_enabled").pop()?.args).toEqual({ enabled: false }));
      await waitFor(() => expect(word()).toBe("STOPPED"));
    });
    it("explains what is missing: the Local API, Node.js, or the Claude Code CLI", async () => {
      state.runner = runner({ enabled: true, api_on: false });
      const c = await card(); await waitFor(() => expect(word()).toBe("NEEDS THE LOCAL API"));
      expect(within(c).getByText(/Turn on the Local API above/)).toBeTruthy(); cleanup();
      state.runner = runner({ enabled: true, api_on: true, node_ok: false });
      const c2 = await card(); await waitFor(() => expect(word()).toBe("NODE MISSING"));
      expect(within(c2).getByText(/Node.js 18 or newer was not found/)).toBeTruthy(); cleanup();
      state.runner = runner({ enabled: true, api_on: true, running: true, claude_ok: false });
      const c3 = await card(); await waitFor(() => expect(word()).toBe("CLAUDE CLI MISSING"));
      expect(within(c3).getByText(/a tag of @Claude will fail/)).toBeTruthy();
    });
    it("shows an error from the switch, and the runner's own last error", async () => {
      state.api = true; state.runnerFail = "Review the interrupted restore in Backups & restore before editing";
      const c = await card();
      fireEvent.click(within(c).getByRole("switch", { name: "Start bots when tagged" }));
      expect((await within(c).findByRole("alert")).textContent).toMatch(/Review the interrupted restore/);
      expect((within(c).getByRole("switch", { name: "Start bots when tagged" }) as HTMLInputElement).checked).toBe(false);
      cleanup(); state.runnerFail = ""; state.runner = runner({ enabled: true, api_on: true, last_error: "The runner stopped by itself (exit status: 1)." });
      const c2 = await card(); expect((await within(c2).findByRole("alert")).textContent).toMatch(/stopped by itself/);
    });
    it("keeps the log behind a collapsible section, and never shows a token", async () => {
      state.runner = runner({ enabled: true, api_on: true, running: true, log_tail: "[10:00:01] Watching for tags of @Claude, @xGrok, @GrokBots every 3s.\n[10:00:05] xGrok: posted a \"ready to paste\" card." });
      const c = await card();
      const details = c.querySelector("details") as HTMLDetailsElement; expect(details.open).toBe(false);
      expect((await within(c).findByLabelText("Runner log")).textContent).toMatch(/posted a "ready to paste" card/);
      expect(c.textContent).not.toMatch(/nou_[0-9a-f]{8}/);
    });
    it("picks one word for every combination, the first blocker winning", () => {
      const s = (o: Record<string, unknown>) => runnerWord(runner(o) as any).word;
      expect([s({}), s({ enabled: true, api_on: false, node_ok: false }), s({ enabled: true, api_on: true, node_ok: false, claude_ok: false }), s({ enabled: true, api_on: true, claude_ok: false }), s({ enabled: true, api_on: true, running: true }), s({ enabled: true, api_on: true })])
        .toEqual(["STOPPED", "NEEDS THE LOCAL API", "NODE MISSING", "CLAUDE CLI MISSING", "RUNNING", "STOPPED"]);
    });
    it("the runner tokens are listed like any other token", async () => {
      state.tokens = [{ id: "r1", name: "NOU relay", scopes: ["chat:read", "chat:write", "queue:read", "queue:write"], created_at: "2026-11-24T10:00:00.000Z", last_used_at: null, revoked_at: null }, { id: "r2", name: "Claude", scopes: ["notes:read"], created_at: "2026-11-24T10:00:00.000Z", last_used_at: null, revoked_at: null }];
      render(<GatewayPanel onClose={() => {}} />);
      const list = await screen.findByRole("region", { name: "Tokens" });
      expect(within(list).getByText("NOU relay")).toBeTruthy(); expect(within(list).getByText("Claude")).toBeTruthy();
    });
  });
});
