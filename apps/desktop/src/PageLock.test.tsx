import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { LockButton, LockGate, LockScreen } from "./PageLock";

const { calls, st } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], st: { open: false, fail: {} as Record<string, string>, note: null as any } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (st.fail[command]) throw new Error(st.fail[command]);
  if (command === "lock_state") return { locked: true, open: st.open };
  if (command === "lock_unlock") { st.open = true; return; }
  if (command === "lock_relock") { st.open = false; return; }
  if (command === "load_note") return st.note;
} }));
const tick = () => new Promise(r => setTimeout(r, 20));
beforeEach(() => { calls.length = 0; st.open = false; st.fail = {}; st.note = null; });

describe("LockScreen and LockGate", () => {
  it("an unlocked page shows its content straight away and never asks the backend", () => {
    render(<LockGate pageId="p" locked={false}><p>the note</p></LockGate>);
    expect(screen.getByText("the note")).toBeTruthy();
    expect(calls).toEqual([]);
  });
  it("a locked page shows the lock screen, not the content, until it is unlocked with the right password", async () => {
    render(<LockGate pageId="p" locked title="Diary"><p>the secret note</p></LockGate>);
    expect(await screen.findByText("“Diary” is locked")).toBeTruthy();
    expect(screen.queryByText("the secret note")).toBeNull();
    const box = screen.getByLabelText("Password") as HTMLInputElement;
    expect((screen.getByText("Unlock") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByText("Unlock"));
    await waitFor(() => expect(calls).toContainEqual({ command: "lock_unlock", args: { pageId: "p", password: "correct horse" } }));
    expect(await screen.findByText("the secret note")).toBeTruthy();
  });
  it("a locked page that is already unlocked this session opens straight into the content", async () => {
    st.open = true;
    render(<LockGate pageId="p" locked><p>the secret note</p></LockGate>);
    expect(await screen.findByText("the secret note")).toBeTruthy();
  });
  it("a wrong password shows the reason and the content stays hidden; the password box is not echoed in the page", async () => {
    st.fail.lock_unlock = "That password is not right.";
    render(<LockScreen pageId="p" />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope nope" } });
    fireEvent.keyDown(screen.getByLabelText("Password"), { key: "Enter" });
    fireEvent.click(screen.getByText("Unlock"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That password is not right.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
  });
  it("locking again returns to the lock screen", async () => {
    st.open = true;
    render(<><LockButton pageId="p" locked onChanged={() => {}} /><LockGate pageId="p" locked><p>the secret note</p></LockGate></>);
    await screen.findByText("the secret note");
    fireEvent.click(await screen.findByLabelText("Lock options"));
    fireEvent.click(screen.getByText("Lock now"));
    expect(await screen.findByLabelText("Locked note")).toBeTruthy();
    expect(screen.queryByText("the secret note")).toBeNull();
  });
});

describe("LockButton", () => {
  it("on an unlocked page, offers a password form that needs 8+ matching characters and warns it cannot be recovered", async () => {
    const changed = vi.fn();
    render(<LockButton pageId="p" locked={false} onChanged={changed} />);
    fireEvent.click(screen.getByLabelText("Lock this note"));
    expect(screen.getByText(/cannot be recovered/)).toBeTruthy();
    expect(screen.getByText(/not encrypted/)).toBeTruthy();
    const submit = screen.getAllByText("Lock this note").find(el => el.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    expect(screen.getByText(/At least 8 characters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long enough pw" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "different one" } });
    expect(screen.getByText(/The two passwords differ/)).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "long enough pw" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toContainEqual({ command: "lock_set", args: { pageId: "p", password: "long enough pw" } }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("shows a failure instead of pretending the note was locked", async () => {
    st.fail.lock_set = "This is an old plain-text note. Open it and convert it to rich text first, then lock it.";
    const changed = vi.fn();
    render(<LockButton pageId="p" locked={false} onChanged={changed} />);
    fireEvent.click(screen.getByLabelText("Lock this note"));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long enough pw" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "long enough pw" } });
    fireEvent.click(screen.getAllByText("Lock this note").find(el => (el as HTMLButtonElement).type === "submit")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
  });
  it("on a locked note that is open, the menu has Lock now, Change password and Remove lock", async () => {
    st.open = true;
    render(<LockButton pageId="p" locked onChanged={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Lock options"));
    for (const t of ["Lock now", "Change password…", "Remove lock…"]) expect(screen.getByText(t)).toBeTruthy();
  });
  it("is not shown while the note is locked and not yet unlocked (the lock screen is in charge)", async () => {
    render(<LockButton pageId="p" locked onChanged={() => {}} />);
    await tick();
    expect(screen.queryByLabelText("Lock options")).toBeNull();
  });
  it("changing the password sends the old and the new one", async () => {
    st.open = true;
    render(<LockButton pageId="p" locked onChanged={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Lock options"));
    fireEvent.click(screen.getByText("Change password…"));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "brand new pw" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "brand new pw" } });
    fireEvent.click(screen.getAllByText("Change password").find(el => (el as HTMLButtonElement).type === "submit")!);
    await waitFor(() => expect(calls).toContainEqual({ command: "lock_change_password", args: { pageId: "p", oldPassword: "old password", newPassword: "brand new pw" } }));
  });
  it("removing the lock reads the note's text first so it is searchable again, then removes the lock", async () => {
    st.open = true;
    const { blocksToYXmlFragment } = await import("@blocknote/core/yjs");
    const { BlockNoteEditor } = await import("@blocknote/core");
    const { noteSchema, FRAGMENT } = await import("./blockModel");
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const doc = new Y.Doc();
    blocksToYXmlFragment(editor, [{ type: "paragraph", content: [{ type: "text", text: "secret zebra", styles: {} }] }] as never, doc.getXmlFragment(FRAGMENT));
    st.note = { updates: [Array.from(Y.encodeStateAsUpdate(doc))], format: "blocknote-v1" };
    render(<LockButton pageId="p" locked onChanged={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Lock options"));
    fireEvent.click(screen.getByText("Remove lock…"));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password" } });
    fireEvent.click(screen.getAllByText("Remove lock").find(el => (el as HTMLButtonElement).type === "submit")!);
    await waitFor(() => expect(calls.some(c => c.command === "lock_remove")).toBe(true));
    const remove = calls.find(c => c.command === "lock_remove")!;
    expect(remove.args.pageId).toBe("p"); expect(remove.args.password).toBe("old password"); expect(remove.args.plainText).toContain("secret zebra");
    expect(calls.findIndex(c => c.command === "load_note")).toBeLessThan(calls.findIndex(c => c.command === "lock_remove"));
  });
  it("is disabled while the app is saving", () => {
    render(<LockButton pageId="p" locked={false} disabled onChanged={() => {}} />);
    expect((screen.getByLabelText("Lock this note") as HTMLButtonElement).disabled).toBe(true);
  });
});
