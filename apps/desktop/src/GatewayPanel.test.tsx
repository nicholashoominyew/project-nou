import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GatewayPanel from "./GatewayPanel";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { tokens: [] as any[], api: false } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "gateway_list_tokens") return state.tokens;
  if (command === "gateway_api_status") return { enabled: state.api, running: state.api, port: 47651, address: "http://127.0.0.1:47651" };
  if (command === "gateway_api_set_enabled") { state.api = args.enabled; return { enabled: state.api, running: state.api, port: 47651, address: "http://127.0.0.1:47651" }; }
  if (command === "gateway_audit") return [{ id: 1, at: "2026-11-11T10:00:00.000Z", actor: "owner", action: "token.created", detail: {} }];
  if (command === "gateway_create_token") { const info = { id: "t1", name: args.name, scopes: args.scopes, created_at: "2026-11-11T10:00:00.000Z", last_used_at: null, revoked_at: null }; state.tokens = [info]; return { info, secret: "nou_SECRET123" }; }
  if (command === "gateway_revoke_token") { state.tokens = state.tokens.map(t => ({ ...t, revoked_at: "now" })); }
} }));
beforeEach(() => { calls.length = 0; state.tokens = []; state.api = false; });

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
    expect(await screen.findByText("revoked")).toBeTruthy();
    confirm.mockRestore();
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
});
