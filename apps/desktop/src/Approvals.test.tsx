import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Approvals from "./Approvals";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { list: [] as any[], failDecide: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "gateway_list_proposals") return state.list;
  if (command === "gateway_decide") { if (state.failDecide) throw new Error(state.failDecide); state.list = state.list.filter(p => p.id !== args.id); return {}; }
  if (command === "create_page") return { id: "new-page" };
} }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
const proposal = (extra: object = {}) => ({ id: "p1", token_id: "t", token_name: "Claude", op: "create_page", payload: { title: "Ideas" }, summary: "Totally harmless page", status: "pending", created_at: "x", decided_at: null, applied_at: null, result: null, ...extra });
beforeEach(() => { calls.length = 0; state.list = [proposal()]; state.failDecide = ""; });

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
});
