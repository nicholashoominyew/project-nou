import * as Y from "yjs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutoApply, undoAuto } from "./autoApprove";
import AutoApprovalPanel, { pagePaths } from "./AutoApprovalPanel";
import AutoBar from "./AutoBar";
import Approvals from "./Approvals";
import { groupProposals } from "./proposalGroups";
import { appendBlocksToNote, removeAddedBlocks, type AddedBlock } from "./noteAppend";
import { blocksToPlainText, migrateLegacy } from "./blockModel";
import { inspectDocument } from "./noteTransfer";

const h = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: {} as any }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  h.calls.push({ command, args });
  const s = h.state;
  if (command === "load_note") return { updates: s.updates, format: "blocknote-v1", legacy_text: null, seq: s.updates.length, epoch: 1 };
  if (command === "save_note") { s.updates = [...s.updates, args.update]; return s.updates.length; }
  if (command === "auto_pending") return s.pending;
  if (command === "auto_claim") return s.claims[args.id] ?? null;
  if (command === "auto_undo_plan") return s.plan;
  if (command === "auto_overview") return s.overview;
  if (command === "auto_recent") return s.recent;
  if (command === "auto_unseen") return { count: s.unseen, pages: [] };
  if (command === "gateway_list_proposals") return s.list;
  if (command === "gateway_decide") { s.list = s.list.filter((p: any) => p.id !== args.id); return {}; }
  if (command === "list_pages") return s.pages;
  if (command === "create_page") return { id: "new-" + args.title };
  return {};
} }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));

const pages = [{ id: "bots", title: "Bots", parent_id: null, sort_key: "a" }, { id: "inbox", title: "Inbox", parent_id: "bots", sort_key: "a" }];
const proposal = (id: string, title: string, extra: object = {}) => ({ id, token_id: "t", token_name: "Claude", op: "create_page", payload: { title, parent: "inbox" }, summary: `Create a page called “${title}”`, status: "pending", created_at: id, decided_at: null, applied_at: null, result: null, ...extra });
const sent = (command: string) => h.calls.filter(c => c.command === command);
beforeEach(() => {
  h.calls.length = 0;
  Object.assign(h.state, { updates: [Array.from(Y.encodeStateAsUpdate(migrateLegacy(new Y.Doc())))], pending: [], claims: {}, plan: null, overview: { feature_on: true, paused: false, rules: [], sources: ["Claude", "Grok"] }, recent: [], unseen: 0, list: [], pages });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
const textsOnPage = () => { const doc = new Y.Doc(); for (const u of h.state.updates) Y.applyUpdate(doc, Uint8Array.from(u)); return (inspectDocument(doc, "blocknote-v1").blocks as any[]).map(b => blocksToPlainText([b]).trim()).filter(Boolean); };

describe("applying what a rule approved", () => {
  it("applies only what the backend lets it claim, and reports what was made", async () => {
    h.state.pending = ["a", "withdrawn"]; h.state.claims = { a: proposal("a", "Monday") };
    expect(await runAutoApply()).toBe(1);
    expect(sent("auto_claim").map(c => c.args.id)).toEqual(["a", "withdrawn"]);
    expect(sent("create_page")).toHaveLength(1);
    expect(sent("auto_applied")[0].args).toEqual({ id: "a", ok: true, result: "Created page new-Monday", after: { page: "new-Monday" } });
    expect(sent("gateway_decide"), "no hand approval is faked").toHaveLength(0);
  });
  it("does nothing when nothing is waiting", async () => {
    expect(await runAutoApply()).toBe(0);
    expect(h.calls.map(c => c.command)).toEqual(["auto_pending"]);
  });
});

describe("undo", () => {
  it("takes out exactly the added blocks, and leaves them if they were edited", async () => {
    const added: AddedBlock[] = [];
    await appendBlocksToNote("p1", [{ type: "paragraph", text: "keep me" }]);
    await appendBlocksToNote("p1", [{ type: "paragraph", text: "bot line one" }, { type: "checkListItem", text: "bot to-do" }], added);
    expect(added.map(a => a.text.trim())).toEqual(["bot line one", "bot to-do"]);
    const saves = sent("save_note").length;
    await expect(removeAddedBlocks("p1", [added[0], { ...added[1], text: "something else" }])).rejects.toThrow(/changed it since/);
    expect(sent("save_note")).toHaveLength(saves);
    await removeAddedBlocks("p1", added);
    expect(textsOnPage()).toEqual(["keep me"]);
  });
  it("uses the app's ordinary commands for a new page, a rename and a cell, then records it", async () => {
    for (const [plan, command, args] of [
      [{ kind: "trash", page: "x" }, "trash_page", { pageId: "x" }],
      [{ kind: "rename", page: "x", title: "Old" }, "rename_page", { pageId: "x", title: "Old" }],
      [{ kind: "clear", row: "r", property: "p" }, "set_value", { rowId: "r", propertyId: "p", value: null }],
    ] as const) {
      h.calls.length = 0; h.state.plan = plan;
      await undoAuto("id");
      expect(h.calls.map(c => c.command)).toEqual(["auto_undo_plan", command, "auto_undone"]);
      expect(h.calls[1].args).toEqual(args);
    }
  });
});

describe("grouping and bulk approval", () => {
  it("puts a bulk job in one group even though each summary names its page, and keeps different jobs apart", () => {
    const list = [...Array.from({ length: 12 }, (_, i) => proposal("p" + i, "Day " + i)), proposal("g", "Day 0", { token_name: "Grok" }), proposal("top", "Elsewhere", { payload: { title: "Elsewhere" } })];
    const groups = groupProposals(list as never, pages);
    expect(groups.map(g => [g.source, g.items.length, g.where])).toEqual([["Claude", 12, "under Inbox"], ["Grok", 1, "under Inbox"], ["Claude", 1, ""]]);
  });
  it("approves a whole group with one tap, after asking", async () => {
    h.state.list = [proposal("1", "A"), proposal("2", "B"), proposal("3", "C")];
    const refresh = vi.fn(async () => {});
    render(<Approvals disabled={false} refresh={refresh} />);
    const group = await screen.findByLabelText("3 × Create a page from Claude");
    fireEvent.click(within(group).getByText("Approve these 3"));
    await waitFor(() => expect(sent("gateway_mark_applied")).toHaveLength(3));
    expect(window.confirm).toHaveBeenCalledWith("Approve and apply these 3 requests from Claude?");
    expect(sent("create_page").map(c => c.args.title)).toEqual(["A", "B", "C"]);
    await screen.findByText("Approved 3.");
  });
  it("rejects all without applying anything, and does nothing if you say no", async () => {
    h.state.list = [proposal("1", "A"), proposal("2", "B", { token_name: "Grok" })];
    (window.confirm as any).mockReturnValueOnce(false);
    render(<Approvals disabled={false} refresh={async () => {}} />);
    fireEvent.click(await screen.findByText("Reject all"));
    expect(sent("gateway_decide")).toHaveLength(0);
    fireEvent.click(screen.getByText("Reject all"));
    await waitFor(() => expect(sent("gateway_decide")).toHaveLength(2));
    expect(sent("gateway_decide").every(c => c.args.approve === false)).toBe(true);
    expect(sent("create_page")).toHaveLength(0);
  });
});

describe("the screens", () => {
  const panel = () => render(<AutoApprovalPanel pages={pages as never} onClose={() => {}} onOpenPage={() => {}} refresh={() => {}} />);
  it("names pages by their path", () => { expect(pagePaths(pages as never).map(p => p.path)).toEqual(["Bots", "Bots / Inbox"]); });
  it("will not save a rule until it has a name, an action and a chosen bot", async () => {
    panel();
    fireEvent.click(await screen.findByText("Add a rule"));
    const form = screen.getByRole("form", { name: "New rule" });
    const save = within(form).getByText("Save rule") as HTMLButtonElement;
    fireEvent.change(within(form).getByLabelText("Rule name"), { target: { value: "Bots inbox" } });
    fireEvent.change(within(form).getByLabelText("Where"), { target: { value: "inbox" } });
    fireEvent.click(within(form).getByLabelText(/Add text to a page/));
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Which bot"), { target: { value: "*" } });
    expect(within(form).getByRole("alert").textContent).toMatch(/Any bot means every token/);
    fireEvent.change(within(form).getByLabelText("Which bot"), { target: { value: "Claude" } });
    fireEvent.click(save);
    await waitFor(() => expect(sent("auto_rule_save")).toHaveLength(1));
    expect(sent("auto_rule_save")[0].args.rule).toEqual({ id: "", name: "Bots inbox", page_id: "inbox", include_subtree: true, ops: ["append_text"], source: "Claude", enabled: true, per_hour: 100 });
  });
  it("lists what was approved automatically and undoes it with one tap", async () => {
    h.state.recent = [{ proposal_id: "z", at: "2026-11-25T10:00:00Z", source: "Claude", op: "create_page", rule_name: "Bots inbox", page_id: "inbox", page_title: "Inbox", change_text: "Create the page “Monday” under “Inbox”", summary: "daily", status: "applied", result: "ok", undone_at: null, seen: false }];
    h.state.plan = { kind: "trash", page: "x" };
    panel();
    const section = await screen.findByLabelText("Recently auto-approved");
    expect(within(section).getByText(/rule “Bots inbox”/)).toBeTruthy();
    fireEvent.click(within(section).getByText("Undo"));
    await waitFor(() => expect(sent("auto_undone")).toHaveLength(1));
    expect(sent("auto_seen")[0].args).toEqual({ pageId: null });
  });
  it("pauses from Home at once", async () => {
    h.state.unseen = 4;
    render(<AutoBar disabled={false} />);
    fireEvent.click(await screen.findByLabelText("Pause all auto-approval"));
    await waitFor(() => expect(sent("auto_set_switches")[0].args).toEqual({ featureOn: true, paused: true }));
    expect(screen.getByText("4 approved automatically · View")).toBeTruthy();
  });
});
