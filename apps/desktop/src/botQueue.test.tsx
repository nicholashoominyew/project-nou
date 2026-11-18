import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BotQueue from "./BotQueue";
import { authorTone, clock, continues, lastId, mergeMessages, readSeen, unreadCount, writeSeen, type ChatMessage } from "./chatModel";

const { calls, chat } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], chat: { list: [] as any[], failPost: "", failList: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "chat_list") { if (chat.failList) throw new Error(chat.failList); const after = args?.after ?? 0; return chat.list.filter(m => m.id > after); }
  if (command === "chat_post") { if (chat.failPost) throw new Error(chat.failPost); const m = { id: chat.list.length + 1, at: new Date().toISOString(), kind: "owner", author: "You", body: args.body }; chat.list.push(m); return m; }
  if (command === "chat_clear") { chat.list = []; return 0; }
} }));
const msg = (id: number, author: string, body: string, kind = "assistant", at = "2026-11-18T10:00:00.000Z"): ChatMessage => ({ id, at, kind, author, body });
beforeEach(() => { calls.length = 0; chat.list = []; chat.failPost = ""; chat.failList = ""; localStorage.clear(); });

describe("chat helpers", () => {
  it("an assistant always gets the same tone, one of six", () => {
    expect(authorTone("Claude")).toBe(authorTone("Claude"));
    for (const n of ["Claude", "Grok", "ChatGPT", "Gemini", "XGrok", "a", ""]) expect(authorTone(n)).toBeGreaterThanOrEqual(0), expect(authorTone(n)).toBeLessThan(6);
    expect(new Set(["Claude", "Grok", "ChatGPT", "Gemini", "Llama", "Mistral", "Kura"].map(authorTone)).size).toBeGreaterThan(2);
  });
  it("unread counts only assistant messages newer than what was seen", () => {
    const list = [msg(1, "Claude", "a"), msg(2, "You", "b", "owner"), msg(3, "Grok", "c"), msg(4, "Claude", "d")];
    expect(unreadCount(list, 0)).toBe(3); expect(unreadCount(list, 3)).toBe(1); expect(unreadCount(list, 4)).toBe(0);
    expect(lastId(list)).toBe(4); expect(lastId([])).toBe(0);
  });
  it("merging keeps order, replaces a repeat of the same message and caps the list", () => {
    const merged = mergeMessages([msg(1, "A", "x"), msg(3, "A", "z")], [msg(2, "B", "y"), msg(3, "A", "z")]);
    expect(merged.map(m => m.id)).toEqual([1, 2, 3]);
    expect(mergeMessages([], Array.from({ length: 10 }, (_, i) => msg(i + 1, "A", "m")), 4).map(m => m.id)).toEqual([7, 8, 9, 10]);
  });
  it("remembers what was seen, and survives broken storage", () => {
    expect(readSeen()).toBe(0); writeSeen(42); expect(readSeen()).toBe(42);
    localStorage.setItem("nou-chat-seen", "junk"); expect(readSeen()).toBe(0);
    localStorage.setItem("nou-chat-seen", "-5"); expect(readSeen()).toBe(0);
  });
  it("shows the time for today and the date for another day; messages from the same author close together continue", () => {
    const now = new Date(2026, 10, 18, 12, 0, 0);
    expect(clock(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toBe("09:05");
    expect(clock(new Date(2026, 10, 17, 9, 5).toISOString(), now)).toMatch(/^17 Nov 09:05$/);
    expect(clock("nonsense", now)).toBe("");
    const a = msg(1, "Claude", "x", "assistant", "2026-11-18T10:00:00Z");
    expect(continues(a, msg(2, "Claude", "y", "assistant", "2026-11-18T10:02:00Z"))).toBe(true);
    expect(continues(a, msg(2, "Claude", "y", "assistant", "2026-11-18T10:20:00Z"))).toBe(false);
    expect(continues(a, msg(2, "Grok", "y", "assistant", "2026-11-18T10:01:00Z"))).toBe(false);
    expect(continues(undefined, a)).toBe(false);
  });
});

describe("BotQueue", () => {
  it("shows the conversation with who said what, tells assistants from you, and says what the chat is for", async () => {
    chat.list = [msg(1, "Claude", "I drafted the plan"), msg(2, "You", "thanks", "owner"), msg(3, "Grok", "I will review it")];
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    const log = await screen.findByRole("log", { name: "Messages" });
    expect(within(log).getByText("I drafted the plan")).toBeTruthy();
    expect(within(log).getByText("I will review it")).toBeTruthy();
    expect(within(log).getAllByText("assistant").length).toBe(2);
    expect(within(log).getByText("Claude")).toBeTruthy(); expect(within(log).getByText("Grok")).toBeTruthy(); expect(within(log).getByText("You")).toBeTruthy();
    expect(screen.getByText(/shared chat for you and your AI assistants/)).toBeTruthy();
  });
  it("says so when nobody has spoken yet, and how an assistant joins in", async () => {
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    expect(await screen.findByText(/No messages yet/)).toBeTruthy();
    expect(screen.getByText("POST /v1/chat")).toBeTruthy();
  });
  it("sends with Enter, keeps a newline for Shift+Enter, and clears the box", async () => {
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    const box = await screen.findByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "line one\nline two" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls.some(c => c.command === "chat_post")).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls).toContainEqual({ command: "chat_post", args: { body: "line one\nline two" } }));
    expect(await screen.findByText(/line one/)).toBeTruthy();
    expect(box.value).toBe("");
  });
  it("does not send an empty message and locks while the notes are read-only", async () => {
    const { unmount } = render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    expect((await screen.findByText("Send") as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<BotQueue onSeen={() => {}} pollMs={100000} disabled />);
    expect((await screen.findByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
  });
  it("picks up what an assistant says on the next check, without repeating earlier messages", async () => {
    chat.list = [msg(1, "Claude", "first")];
    render(<BotQueue onSeen={() => {}} pollMs={40} />);
    await screen.findByText("first");
    chat.list.push(msg(2, "Grok", "second, from someone else"));
    expect(await screen.findByText("second, from someone else")).toBeTruthy();
    expect(screen.getAllByText("first").length).toBe(1);
    await waitFor(() => expect(calls.filter(c => c.command === "chat_list").some(c => c.args?.after === 1)).toBe(true));
  });
  it("reports the newest message it has shown, so the sidebar badge can clear", async () => {
    chat.list = [msg(1, "Claude", "a"), msg(2, "Claude", "b")];
    const seen = vi.fn();
    render(<BotQueue onSeen={seen} pollMs={100000} />);
    await screen.findByText("b");
    await waitFor(() => expect(seen).toHaveBeenLastCalledWith(2));
  });
  it("shows messages as plain text, never as markup", async () => {
    chat.list = [msg(1, "Claude", "<img src=x onerror=alert(1)> **not bold**")];
    const { container } = render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    expect(await screen.findByText(/<img src=x/)).toBeTruthy();
    expect(container.querySelector("img,b,strong:not(header strong)")).toBeNull();
  });
  it("clearing the chat asks first, and Keep leaves everything alone", async () => {
    chat.list = [msg(1, "Claude", "keep me")];
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    await screen.findByText("keep me");
    fireEvent.click(screen.getByText("Clear chat"));
    fireEvent.click(screen.getByText("Keep"));
    expect(calls.some(c => c.command === "chat_clear")).toBe(false);
    expect(screen.getByText("keep me")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear chat"));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(calls.some(c => c.command === "chat_clear")).toBe(true));
    expect(await screen.findByText(/No messages yet/)).toBeTruthy();
  });
  it("shows why a message could not be sent and keeps what was typed", async () => {
    chat.failPost = "Review the interrupted restore before editing";
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    const box = await screen.findByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "keep this text" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Review the interrupted restore before editing");
    expect(box.value).toBe("keep this text");
  });
  it("shows a load error and still lets you write", async () => {
    chat.failList = "database busy";
    render(<BotQueue onSeen={() => {}} pollMs={100000} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });
});
