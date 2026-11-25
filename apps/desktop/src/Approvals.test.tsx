import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Approvals from "./Approvals";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { list: [] as any[], failDecide: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "gateway_list_proposals") return state.list;
  if (command === "gateway_decide") { if (state.failDecide) throw new Error(state.failDecide); state.list = state.list.filter(p => p.id !== args.id); return {}; }
  if (command === "create_page") return { id: "new-page" };
  if (command === "upload_attachment_bytes") return { id: "f".repeat(64), name: "x.html", mime: "text/html", bytes: 1 };
  if (command === "gateway_mark_applied") return {};
} }));
const appended: any[] = []; vi.mock("./noteAppend", () => ({ appendBlocksToNote: async (page: string, blocks: any[]) => { appended.push({ page, blocks }); return { changed: true, message: "Added 1 block" }; } }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
const proposal = (extra: object = {}) => ({ id: "p1", token_id: "t", token_name: "Claude", op: "create_page", payload: { title: "Ideas" }, summary: "Totally harmless page", status: "pending", created_at: "x", decided_at: null, applied_at: null, result: null, ...extra });
beforeEach(() => { appended.length = 0; calls.length = 0; state.list = [proposal()]; state.failDecide = ""; });

describe("Approvals", () => {
  it("shows the exact operation and fields, and labels the clients own description as unverified", async () => {
    render(<Approvals disabled={false} refresh={async () => {}} />);
    const card = await screen.findByLabelText("Create a page");
    expect(within(card).getByText("title")).toBeTruthy();
    expect(within(card).getByText("Ideas")).toBeTruthy();
    expect(within(card).getByText(/from Claude/)).toBeTruthy();
    expect(within(card).getByText(/not verified/)).toBeTruthy();
    expect(within(card).getByText("Totally harmless page")).toBeTruthy();
  });
  it("says in one sentence what approving a timetable or Home request would do, above the exact fields", async () => {
    state.list = [proposal({ id: "t1", op: "timetable_set_block", payload: { weeks: ["A"], days: ["Mon"], start: "09:00", end: "10:30", activities: ["Work"] }, summary: "Move my work earlier" }),
      proposal({ id: "h1", op: "home_set_widgets", payload: { show: ["weather"] }, summary: "Weather please" })];
    render(<Approvals disabled={false} refresh={async () => {}} />);
    const tt = await screen.findByLabelText("Change the Life Timetable");
    expect(within(tt).getByText(/will be set to Work, replacing what is there now/)).toBeTruthy(); expect(within(tt).getByText("weeks")).toBeTruthy();
    expect(within(tt).getByText(/Their description \(not verified\)/)).toBeTruthy();
    expect(within(screen.getByLabelText("Show or hide Home sections")).getByText(/Show: Weather\. Nothing else on the Home page changes/)).toBeTruthy();
    expect(screen.queryByLabelText("Create a page")).toBeNull();
  });
  it("renders hostile text as plain text, never as markup", async () => {
    state.list = [proposal({ payload: { title: "<img src=x onerror=alert(1)>" }, summary: "<script>alert(1)</script>" })];
    const { container } = render(<Approvals disabled={false} refresh={async () => {}} />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img,script")).toBeNull();
  });
  it("approving decides first, then applies through the normal command, then records the result and refreshes", async () => {
    const refresh = vi.fn(async () => {});
    render(<Approvals disabled={false} refresh={refresh} />);
    fireEvent.click(await screen.findByText("Approve and apply"));
    await waitFor(() => expect(calls.some(c => c.command === "gateway_mark_applied")).toBe(true));
    expect(calls.map(c => c.command).slice(1, 4)).toEqual(["gateway_decide", "create_page", "gateway_mark_applied"]);
    expect(calls.find(c => c.command === "gateway_decide")!.args).toEqual({ id: "p1", approve: true });
    expect(calls.find(c => c.command === "gateway_mark_applied")!.args).toEqual({ id: "p1", ok: true, result: "Created page new-page" });
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText(/Approved and applied/)).toBeTruthy();
  });
  it("rejecting never applies anything", async () => {
    render(<Approvals disabled={false} refresh={async () => {}} />);
    fireEvent.click(await screen.findByText("Reject"));
    await waitFor(() => expect(calls.some(c => c.command === "gateway_decide" && c.args.approve === false)).toBe(true));
    expect(calls.some(c => c.command === "create_page" || c.command === "gateway_mark_applied")).toBe(false);
  });
  it("if the decision is refused (expired, revoked) nothing is applied and the reason is shown", async () => {
    state.failDecide = "The token that made this proposal has been revoked";
    render(<Approvals disabled={false} refresh={async () => {}} />);
    fireEvent.click(await screen.findByText("Approve and apply"));
    expect(await screen.findByText(/has been revoked/)).toBeTruthy();
    expect(calls.some(c => c.command === "create_page")).toBe(false);
  });
  it("kinds the app cannot apply yet can only be rejected", async () => {
    state.list = [proposal({ op: "link_pages", payload: { a: "p", b: "q" } })];
    render(<Approvals disabled={false} refresh={async () => {}} />);
    const approve = (await screen.findByText("Approve and apply")) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect((screen.getByText("Reject") as HTMLButtonElement).disabled).toBe(false);
  });
  it("is locked while the app is saving or restoring, and says so when empty", async () => {
    const { unmount } = render(<Approvals disabled={true} refresh={async () => {}} />);
    expect(((await screen.findByText("Approve and apply")) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    state.list = [];
    render(<Approvals disabled={false} refresh={async () => {}} />);
    expect(await screen.findByText(/Nothing waiting/)).toBeTruthy();
  });
  it("shows an embed request as a card and loads nothing until asked; approving it adds the block through the normal path", async () => {
    state.list = [proposal({ id: "e1", op: "append_embed", payload: { page: "p1", url: "https://claude.ai/artifact/abc", title: "Chart" }, summary: "Show my chart" })];
    const { container } = render(<Approvals disabled={false} refresh={async () => {}} />);
    const card = await screen.findByLabelText("Embed a page in a note");
    expect(within(card).getByText(/will be embedded at the end of the note/)).toBeTruthy();
    const preview = within(card).getByLabelText("Preview of the embed"); expect(within(preview).getByText("https://claude.ai/artifact/abc")).toBeTruthy(); expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(appended).toHaveLength(1)); expect(appended[0].blocks[0].block.props).toMatchObject({ url: "https://claude.ai/artifact/abc", mode: "live" });
    expect(calls.find(c => c.command === "gateway_mark_applied")!.args).toMatchObject({ id: "e1", ok: true });
  });
  it("shows a snapshot request's page in a no-network frame, and rejecting it stores nothing", async () => {
    state.list = [proposal({ id: "e2", op: "attach_html", payload: { page: "p1", title: "Chart", html: "<p>Hi there</p>" }, summary: "Attach it" })];
    const { container } = render(<Approvals disabled={false} refresh={async () => {}} />);
    const card = await screen.findByLabelText("Attach an HTML page to a note");
    const frame = await waitFor(() => { const f = container.querySelector("iframe"); expect(f).not.toBeNull(); return f!; });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); expect(frame.getAttribute("srcdoc")).toContain("Hi there"); expect(frame.getAttribute("srcdoc")).toMatch(/connect-src 'none'/);
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.some(c => c.command === "gateway_decide" && c.args.approve === false)).toBe(true));
    expect(calls.some(c => c.command === "upload_attachment_bytes")).toBe(false); expect(appended).toEqual([]);
  });
  it("a request for a site that is not allowed still shows its raw fields but no preview, and cannot add anything", async () => {
    state.list = [proposal({ id: "e3", op: "append_embed", payload: { page: "p1", url: "https://evil.example/x" }, summary: "x" })];
    const { container } = render(<Approvals disabled={false} refresh={async () => {}} />);
    const card = await screen.findByLabelText("Embed a page in a note");
    expect(container.querySelector("iframe")).toBeNull(); expect(within(card).queryByLabelText("Preview of the embed")).toBeNull(); expect(within(card).getByText("https://evil.example/x")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(calls.find(c => c.command === "gateway_mark_applied")?.args).toMatchObject({ ok: false })); expect(appended).toEqual([]);
  });
});
