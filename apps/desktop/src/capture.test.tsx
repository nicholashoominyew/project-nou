import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QuickCapture from "./QuickCapture";
import { parseCapture, pickInbox, MAX_CAPTURE_LINES } from "./captureParse";

const page = (id: string, title: string, parent_id: string | null = null) => ({ id, title, parent_id, sort_key: id });

describe("parseCapture", () => {
  it("makes a paragraph per line and ignores blank lines and control characters", () => {
    expect(parseCapture("First\r\n\n  Second \n\u0007Third")).toEqual([{ type: "paragraph", text: "First" }, { type: "paragraph", text: "Second" }, { type: "paragraph", text: "Third" }]);
  });
  it("reads [], [ ], - [ ] as to-dos and [x] as ticked, but not ordinary brackets", () => {
    expect(parseCapture("[] call Sam\n[ ] pay rent\n- [ ] buy milk\n* [x] done thing\n[x]no space\n[link] text")).toEqual([
      { type: "checkListItem", text: "call Sam", checked: false }, { type: "checkListItem", text: "pay rent", checked: false }, { type: "checkListItem", text: "buy milk", checked: false },
      { type: "checkListItem", text: "done thing", checked: true }, { type: "paragraph", text: "[x]no space" }, { type: "paragraph", text: "[link] text" },
    ]);
  });
  it("treats markup as plain text", () => {
    expect(parseCapture("<b>bold</b> # not a heading")).toEqual([{ type: "paragraph", text: "<b>bold</b> # not a heading" }]);
  });
  it("is empty for whitespace and refuses oversized captures", () => {
    expect(parseCapture("  \n \t ")).toEqual([]);
    expect(() => parseCapture("x".repeat(20001))).toThrow(/too long/);
    expect(() => parseCapture(Array.from({ length: MAX_CAPTURE_LINES + 1 }, (_, i) => "l" + i).join("\n"))).toThrow(/Too many lines/);
    expect(() => parseCapture("y".repeat(2001))).toThrow(/Too many lines/);
  });
});

describe("pickInbox", () => {
  const pages = [page("a", "Notes"), page("inb", "  inbox "), page("sub", "Inbox", "a")];
  it("uses the remembered page while it exists", () => { expect(pickInbox(pages, "a")).toBe("a"); });
  it("otherwise finds a top-level page called Inbox, ignoring case and spacing, and never a subpage", () => {
    expect(pickInbox(pages, "gone")).toBe("inb"); expect(pickInbox(pages, null)).toBe("inb");
    expect(pickInbox([page("a", "Notes"), page("sub", "Inbox", "a")], null)).toBeNull();
  });
  it("is null when there is no Inbox yet", () => { expect(pickInbox([], null)).toBeNull(); });
});

describe("QuickCapture", () => {
  const setup = (save = vi.fn(async () => "Saved to Inbox."), extra: Partial<Parameters<typeof QuickCapture>[0]> = {}) => {
    const onClose = vi.fn(), onOpenInbox = vi.fn();
    render(<QuickCapture save={save} onClose={onClose} onOpenInbox={onOpenInbox} {...extra} />);
    return { save, onClose, onOpenInbox, box: screen.getByLabelText("Capture text") as HTMLTextAreaElement };
  };
  it("is focused, Enter saves and clears the box, and Open Inbox is offered", async () => {
    const { save, box, onOpenInbox } = setup();
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "[] call Sam" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledWith("[] call Sam"));
    expect(await screen.findByText(/Saved to Inbox/)).toBeTruthy();
    expect(box.value).toBe("");
    fireEvent.click(screen.getByText("Open Inbox"));
    expect(onOpenInbox).toHaveBeenCalled();
  });
  it("Shift+Enter is a new line, not a save", () => {
    const { save, box } = setup();
    fireEvent.change(box, { target: { value: "one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(save).not.toHaveBeenCalled();
  });
  it("does nothing for an empty box and shows the reason when saving fails", async () => {
    const save = vi.fn(async () => { throw new Error("The notes are read-only"); });
    const { box } = setup(save);
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The notes are read-only");
    expect(box.value).toBe("keep me");
  });
  it("shows the limit error without saving", async () => {
    const { save, box } = setup();
    fireEvent.change(box, { target: { value: "x".repeat(20001) } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it("Escape closes, and the box is locked while restoring", () => {
    const { onClose } = setup(undefined, { disabled: true });
    expect((screen.getByLabelText("Capture text") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
