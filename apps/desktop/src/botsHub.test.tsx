import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotsHub from "./BotsHub";
import { codeOf, addMention, approvalWord, dayLabel, filterCounts, filterItems, handoffLine, mergeById, openCount, statusWord, type HubMessage, type QueueItem } from "./hubModel";

const be = vi.hoisted(() => ({
  messages: [] as any[], queue: [] as any[], rooms: [] as any[], state: "running", calls: [] as [string, any][], fail: "" as string,
}));
const summary = () => ({
  rooms: be.rooms, bots_online: 3,
  participants: [{ name: "You", code: "YO", online: true, you: true }, { name: "Claude", code: "CL", online: true, you: false }, { name: "ChatGPT", code: "CH", online: true, you: false }, { name: "XGrok", code: "XG", online: false, you: false }],
  waiting: be.queue.filter(q => q.status === "needs_nick").length, open: be.queue.filter(q => q.status !== "done").length,
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  be.calls.push([command, args]);
  if (be.fail && command === be.fail) throw new Error("The database is busy");
  if (command === "hub_summary") return summary();
  if (command === "chat_list") { const after = args?.after ?? 0; return be.messages.filter(m => m.room === (args?.room ?? "general") && m.id > after); }
  if (command === "chat_post") { const m = { id: be.messages.length + 100, at: new Date().toISOString(), kind: "owner", author: "You", body: args.body, room: args.room ?? "general", type: "message", role: "YOU", from: null, to: null, task_ref: null, approval: null, queue_item_id: null, decided_at: null }; be.messages.push(m); return m; }
  if (command === "chat_decide_approval") { const m = be.messages.find(x => x.id === args.id); m.approval = args.approve ? "approved" : "declined"; m.decided_at = new Date().toISOString(); const q = be.queue.find(x => x.id === m.queue_item_id); if (q) q.status = "done"; return m; }
  if (command === "chat_room_create") { const r = { id: be.rooms.length + 1, name: args.name, slug: args.name.toLowerCase().replace(/\s+/g, "-") }; be.rooms.push(r); return r; }
  if (command === "queue_items") return be.queue;
  if (command === "gateway_api_status") return { enabled: true, running: true, port: 47651, address: "127.0.0.1:47651" };
  if (command === "gateway_list_proposals") return [];
  return null;
} }));

const at = (hhmm: string) => { const d = new Date(); const [h, m] = hhmm.split(":").map(Number); d.setHours(h, m, 0, 0); return d.toISOString(); };
const msg = (id: number, over: Record<string, unknown>) => ({ id, at: at("07:40"), kind: "assistant", author: "Claude", body: "", room: "draftbot", type: "message", role: null, from: null, to: null, task_ref: null, approval: null, queue_item_id: null, decided_at: null, ...over });
beforeEach(() => {
  be.calls.length = 0; be.state = "running"; be.fail = "";
  be.rooms = [{ id: 1, name: "General", slug: "general" }, { id: 2, name: "DraftBot", slug: "draftbot" }];
  be.messages = [
    msg(1, { kind: "owner", author: "You", role: "YOU", body: "@Claude plan the DraftBot dimension tool for this week. @ChatGPT takes the Grasshopper side." }),
    msg(2, { author: "Claude", role: "ROUTER", at: at("07:41"), body: "Splitting it in three." }),
    msg(3, { author: "Claude", type: "handoff", from: "Claude", to: "ChatGPT", task_ref: "C# dimension component", body: "Handed over", at: at("07:42") }),
    msg(4, { author: "ChatGPT", role: "EXECUTOR", at: at("07:46"), body: "Picked it up." }),
    msg(5, { author: "Claude", type: "approval", approval: "open", queue_item_id: 10, task_ref: "DraftBot dimension spec", body: "Spec is ready. Approve it so ChatGPT can build against it?", at: at("07:50") }),
    msg(6, { author: "Claude", room: "general", body: "General only message" }),
  ];
  be.queue = [
    { id: 10, title: "Approve dimension spec", bot: "Claude", status: "needs_nick", room: "draftbot", created_at: "", updated_at: "", approval_message_id: 5 },
    { id: 11, title: "Spec DraftBot dimension rules", bot: "Claude", status: "running", room: "draftbot", created_at: "", updated_at: "", approval_message_id: null },
    { id: 12, title: "C# dimension component", bot: "ChatGPT", status: "running", room: "draftbot", created_at: "", updated_at: "", approval_message_id: null },
    { id: 13, title: "Harvest Vanguard tier posts", bot: "XGrok", status: "queued", room: "draftbot", created_at: "", updated_at: "", approval_message_id: null },
    { id: 14, title: "Pick today's five teachings", bot: "Kura", status: "done", room: "draftbot", created_at: "", updated_at: "", approval_message_id: null },
  ];
});
afterEach(() => cleanup());

const open = async (props: Record<string, unknown> = {}) => {
  const view = render(<BotsHub pollMs={60000} {...props} />);
  await screen.findByRole("region", { name: "Bot collaboration room" });
  return view;
};
const room = () => screen.getByRole("region", { name: "Bot collaboration room" });
const queuePanel = () => screen.getByRole("region", { name: "Bot queue" });

describe("Bots Hub: layout and content", () => {
  it("shows the two panels at once: the room and the queue", async () => {
    await open(); await screen.findByText("General only message");
    expect(screen.getByRole("heading", { name: "Bots Hub", level: 1 })).toBeTruthy();
    expect(screen.getByText(/3 BOTS ONLINE/)).toBeTruthy();
    expect(room().querySelector("h2")!.textContent).toBe("# general");
    expect(within(queuePanel()).getByText("Bot queue")).toBeTruthy();
  });
  it("shows a message with its role and time, a hand-off line, and an approval card with its status as a dot plus a word", async () => {
    await open(); fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" }));
    await screen.findByText("Picked it up.");
    const feed = within(room()).getByRole("log", { name: "Messages in draftbot" });
    expect(within(feed).getByText("ROUTER")).toBeTruthy(); expect(within(feed).getByText("EXECUTOR")).toBeTruthy(); expect(within(feed).getAllByText("YOU").length).toBe(1);
    expect(within(feed).getByText("CLAUDE → CHATGPT · HANDED OFF “C# DIMENSION COMPONENT”")).toBeTruthy();
    const card = within(feed).getByRole("group", { name: "Approval from Claude" });
    expect(card.textContent).toContain("NEEDS NICK · FROM CLAUDE"); expect(card.textContent).toContain("Spec is ready."); expect(card.querySelector(".hub-dot.ask")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy(); expect(within(card).getByRole("button", { name: "Open spec" })).toBeTruthy();
    expect(within(feed).getByRole("separator").textContent).toBe("TODAY");
  });
  it("lists the people in the room with their presence", async () => {
    await open();
    const people = await within(room()).findAllByRole("listitem");
    expect(people.map(p => p.getAttribute("aria-label"))).toEqual(["You, online", "Claude, online", "ChatGPT, online", "XGrok, idle"]);
  });
  it("has exactly one accent-filled button: the room's Send (the style rules are checked in theme.test.ts)", async () => {
    const { container } = await open();
    expect(container.querySelectorAll("button.hub-send").length).toBe(1);
  });
});

describe("Bots Hub: the room", () => {
  it("switches rooms from the tabs and only shows that room's messages", async () => {
    await open(); await screen.findByText("General only message");
    expect(screen.queryByText("Picked it up.")).toBeNull();
    fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" }));
    expect(await screen.findByText("Picked it up.")).toBeTruthy(); expect(screen.queryByText("General only message")).toBeNull();
    expect(room().querySelector("h2")!.textContent).toBe("# draftbot"); expect(within(room()).getByRole("tab", { name: "DraftBot" }).getAttribute("aria-selected")).toBe("true");
  });
  it("adds a room from the plus tab", async () => {
    await open();
    fireEvent.click(within(room()).getByRole("button", { name: "Add a room" }));
    const input = within(room()).getByLabelText("New room name"); fireEvent.change(input, { target: { value: "NOU build" } }); fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(be.calls.find(c => c[0] === "chat_room_create")?.[1]).toEqual({ name: "NOU build" }));
    await waitFor(() => expect(room().querySelector("h2")!.textContent).toBe("# nou-build"));
  });
  it("the mention buttons add @Name to the draft, Enter sends to the current room, Shift+Enter adds a line", async () => {
    await open(); fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" })); await screen.findByText("Picked it up.");
    const box = within(room()).getByLabelText("Message the room") as HTMLTextAreaElement;
    fireEvent.click(within(room()).getByRole("button", { name: "@ChatGPT" })); expect(box.value).toBe("@ChatGPT ");
    fireEvent.change(box, { target: { value: "@ChatGPT build it" } }); fireEvent.click(within(room()).getByRole("button", { name: "@Claude" })); expect(box.value).toBe("@ChatGPT build it @Claude ");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true }); expect(be.calls.some(c => c[0] === "chat_post")).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(be.calls.find(c => c[0] === "chat_post")?.[1]).toEqual({ body: "@ChatGPT build it @Claude", room: "draftbot" }));
    expect(await within(room()).findByText("@ChatGPT build it @Claude")).toBeTruthy(); await waitFor(() => expect(box.value).toBe(""));
    expect(within(room()).queryByRole("button", { name: "@You" })).toBeNull();
  });
  it("Send is disabled until there is text, and an error from the app is shown", async () => {
    await open();
    const send = within(room()).getByRole("button", { name: "Send" }) as HTMLButtonElement; expect(send.disabled).toBe(true);
    const box = within(room()).getByLabelText("Message the room"); fireEvent.change(box, { target: { value: "hello" } }); expect(send.disabled).toBe(false);
    be.fail = "chat_post"; fireEvent.click(send);
    expect((await within(room()).findByRole("alert")).textContent).toContain("The database is busy");
  });
  it("Open spec opens the page named by the card, or says there is none", async () => {
    const openPage = vi.fn();
    await open({ pages: [{ id: "p9", title: "DraftBot dimension spec", parent_id: null, sort_key: "1", icon: "document", is_favorite: false }], openPage });
    fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" })); await screen.findByText("Picked it up.");
    fireEvent.click(within(room()).getByRole("button", { name: "Open spec" })); expect(openPage).toHaveBeenCalledWith("p9");
    cleanup(); const none = vi.fn();
    await open({ pages: [], openPage: none }); fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" })); await screen.findByText("Picked it up.");
    fireEvent.click(within(room()).getByRole("button", { name: "Open spec" })); expect(none).not.toHaveBeenCalled();
    expect(await screen.findByText(/No page called “DraftBot dimension spec”/)).toBeTruthy();
  });
});

describe("Bots Hub: approving", () => {
  it("approving closes the card, marks the queue row Done and updates the waiting count, with no reload", async () => {
    const onWaiting = vi.fn();
    await open({ onWaiting }); fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" })); await screen.findByText("Picked it up.");
    await waitFor(() => expect(onWaiting).toHaveBeenLastCalledWith(1));
    expect(within(queuePanel()).getByText("NEEDS NICK")).toBeTruthy();
    fireEvent.click(within(room()).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(be.calls.find(c => c[0] === "chat_decide_approval")?.[1]).toEqual({ id: 5, approve: true }));
    const card = within(room()).getByRole("group", { name: "Approval from Claude" });
    await waitFor(() => expect(card.textContent).toContain("APPROVED · FROM CLAUDE"));
    expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull(); expect(card.querySelector(".hub-dot.ask")).toBeNull();
    await waitFor(() => expect(within(queuePanel()).queryByText("NEEDS NICK")).toBeNull());
    const row = within(queuePanel()).getByText("Approve dimension spec").closest("li")!; expect(row.className).toContain("done"); expect(row.textContent).toContain("DONE");
    await waitFor(() => expect(onWaiting).toHaveBeenLastCalledWith(0));
    expect(within(queuePanel()).getByRole("tab", { name: "Needs Nick 0" })).toBeTruthy();
  });
  it("shows the app's reason when it cannot approve", async () => {
    await open(); fireEvent.click(within(room()).getByRole("tab", { name: "DraftBot" })); await screen.findByText("Picked it up.");
    be.fail = "chat_decide_approval"; fireEvent.click(within(room()).getByRole("button", { name: "Approve" }));
    expect((await within(room()).findByRole("alert")).textContent).toContain("The database is busy");
    expect(within(room()).getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});

describe("Bots Hub: the queue", () => {
  it("shows the open count, the filters with counts, a bot code, a title and a status word per row", async () => {
    await open();
    const q = await within(queuePanel()).findByText("Approve dimension spec");
    expect(within(queuePanel()).getByText("4 OPEN")).toBeTruthy();
    expect(within(queuePanel()).getAllByRole("tab").map(t => t.textContent)).toEqual(["All 5", "Running 2", "Needs Nick 1", "Done 1"]);
    const row = q.closest("li")!; expect(row.textContent).toContain("CL"); expect(row.textContent).toContain("NEEDS NICK");
    expect(within(queuePanel()).getByText("QUEUED").querySelector("i")!.className).toContain("muted");
    expect(within(queuePanel()).getAllByText("RUNNING").length).toBe(2);
  });
  it("the filters show the right items, a Done row is struck through, and an empty filter says Nothing here.", async () => {
    await open(); await within(queuePanel()).findByText("Approve dimension spec");
    fireEvent.click(within(queuePanel()).getByRole("tab", { name: "Running 2" }));
    expect(within(queuePanel()).getAllByRole("listitem").map(li => li.textContent!.replace(/RUNNING|[A-Z]{2}(?=[A-Z a-z#])/g, "").trim())).toHaveLength(2);
    fireEvent.click(within(queuePanel()).getByRole("tab", { name: "Done 1" }));
    const done = within(queuePanel()).getAllByRole("listitem"); expect(done).toHaveLength(1); expect(done[0].className).toBe("done"); expect(done[0].textContent).toContain("Pick today's five teachings");
    be.queue = be.queue.filter(q => q.status !== "needs_nick"); cleanup(); await open();
    fireEvent.click(await within(queuePanel()).findByRole("tab", { name: "Needs Nick 0" }));
    expect(within(queuePanel()).getByText("Nothing here.")).toBeTruthy();
  });
  it("Open full queue shows the full approvals view and a way back", async () => {
    await open();
    fireEvent.click(within(queuePanel()).getByRole("button", { name: "OPEN FULL QUEUE →" }));
    expect(await screen.findByRole("heading", { name: "Full queue" })).toBeTruthy(); expect(screen.getByRole("region", { name: "Full queue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Bots Hub" }));
    expect(await screen.findByRole("region", { name: "Bot collaboration room" })).toBeTruthy();
  });
});

describe("Bots Hub: header buttons", () => {
  it("Tokens & scopes opens the AI access screen, and the API button explains how a bot posts", async () => {
    const onTokens = vi.fn(); await open({ onTokens });
    fireEvent.click(screen.getByRole("button", { name: "Tokens & scopes" })); expect(onTokens).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "API: POST /v1/chat" }));
    expect((await screen.findByRole("note")).textContent).toContain("127.0.0.1:47651");
  });
});

describe("hubModel helpers", () => {
  const item = (id: number, status: string): QueueItem => ({ id, title: "t" + id, bot: "Claude", status, room: "general", created_at: "", updated_at: "", approval_message_id: null });
  it("counts and filters queue items and counts what is open", () => {
    const items = [item(1, "running"), item(2, "needs_nick"), item(3, "done"), item(4, "queued"), item(5, "running")];
    expect(filterCounts(items)).toEqual({ all: 5, running: 2, needs_nick: 1, done: 1 }); expect(filterItems(items, "running").map(i => i.id)).toEqual([1, 5]); expect(filterItems(items, "all")).toHaveLength(5); expect(openCount(items)).toBe(4);
    expect([statusWord("running"), statusWord("needs_nick"), statusWord("queued"), statusWord("done")]).toEqual(["RUNNING", "NEEDS NICK", "QUEUED", "DONE"]);
  });
  it("codes, mentions, hand-off lines, approval words, merging and day labels", () => {
    expect([codeOf("ChatGPT"), codeOf("  k"), codeOf("123"), codeOf("Éa")]).toEqual(["CH", "K", "??", "ÉA"]);
    expect([addMention("", "Claude"), addMention("hi", "Claude"), addMention("hi  ", "Kura")]).toEqual(["@Claude ", "hi @Claude ", "hi @Kura "]);
    expect(handoffLine({ from: "Claude", to: "ChatGPT", task_ref: "C# dimension component", body: "" })).toBe("CLAUDE → CHATGPT · HANDED OFF “C# DIMENSION COMPONENT”");
    expect([approvalWord("open"), approvalWord("approved"), approvalWord("declined"), approvalWord(null)]).toEqual(["NEEDS NICK", "APPROVED", "DECLINED", ""]);
    expect(mergeById([{ id: 1, v: "a" }, { id: 3, v: "c" }], [{ id: 2, v: "b" }, { id: 3, v: "C" }])).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "C" }]);
    const now = new Date(2026, 10, 21, 12, 0); expect([dayLabel(new Date(2026, 10, 21, 7).toISOString(), now), dayLabel(new Date(2026, 10, 20, 23).toISOString(), now), dayLabel(new Date(2026, 10, 17, 9).toISOString(), now)]).toEqual(["TODAY", "YESTERDAY", "17 NOV"]);
    void ({} as HubMessage); void act;
  });
});

