import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedTodoView, announceLinkedTodo } from "./CustomBlocks";
import { blockLinkedTodoIds } from "./noteTransfer";
import { blocksToPlainText } from "./blockModel";
import { wantsExistingTodos } from "./editorKeys";
import { EditorFeatures } from "./EditorContext";

const { calls, db } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], db: { todo: null as null | { id: string; text: string; checked: boolean; pages: number }, fail: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "linked_todo_get") return db.todo ? [db.todo] : [];
  if (command === "linked_todo_set") { if (db.fail) throw new Error(db.fail); db.todo = { ...db.todo!, checked: args.checked ?? db.todo!.checked, text: args.text ?? db.todo!.text }; return db.todo; }
  if (command === "linked_todo_pages") return [{ id: "p2", title: "Shopping" }];
} }));
const ctx = (open = vi.fn(), onError = vi.fn()) => ({ pages: [], theme: "light" as const, canNavigate: true, open, create: async () => { throw Error("x"); }, upload: async () => null, uploadFile: async () => { throw Error("x"); }, onError, setPeekBusy: () => {} });
function view(props: Partial<Parameters<typeof LinkedTodoView>[0]> = {}, c = ctx()) {
  const onCache = vi.fn();
  render(<EditorFeatures.Provider value={c}><LinkedTodoView todoId="todo-12345678" cachedText="Old text" cachedChecked={false} editable onCache={onCache} {...props} /></EditorFeatures.Provider>);
  return onCache;
}
beforeEach(() => { calls.length = 0; db.todo = { id: "todo-12345678", text: "Buy milk", checked: false, pages: 2 }; db.fail = ""; });

describe("linked to-do block", () => {
  it("shows the shared state from the database, not the stale copy in the note", async () => {
    view();
    await waitFor(() => expect((screen.getByLabelText("To-do text") as HTMLInputElement).value).toBe("Buy milk"));
    expect(screen.getByLabelText("Shown on 2 pages")).toBeTruthy();
  });
  it("ticking saves to the shared state, tells other copies, and updates the copy kept in the note", async () => {
    const onCache = view();
    const heard: any[] = []; const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("nou:linked-todo", on);
    await waitFor(() => expect((screen.getByLabelText("Done") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Done"));
    await waitFor(() => expect(calls).toContainEqual({ command: "linked_todo_set", args: { id: "todo-12345678", checked: true, text: null } }));
    await waitFor(() => expect(onCache).toHaveBeenCalledWith({ text: "Buy milk", checked: true }));
    window.removeEventListener("nou:linked-todo", on);
    expect(heard[0]).toMatchObject({ id: "todo-12345678", checked: true });
    expect((screen.getByLabelText("Done") as HTMLInputElement).checked).toBe(true);
  });
  it("a change made on another page shows up here at once, and other to-dos are ignored", async () => {
    view();
    await waitFor(() => expect((screen.getByLabelText("Done") as HTMLInputElement).disabled).toBe(false));
    announceLinkedTodo({ id: "other-todo-id", text: "Nope", checked: true, pages: 1 });
    expect((screen.getByLabelText("Done") as HTMLInputElement).checked).toBe(false);
    announceLinkedTodo({ id: "todo-12345678", text: "Buy oat milk", checked: true, pages: 2 });
    await waitFor(() => expect((screen.getByLabelText("Done") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText("To-do text") as HTMLInputElement).value).toBe("Buy oat milk");
  });
  it("editing the text saves when you leave the box", async () => {
    view();
    const box = await screen.findByLabelText("To-do text") as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe("Buy milk"));
    fireEvent.focus(box); fireEvent.change(box, { target: { value: "Buy bread" } });
    expect(calls.some(c => c.command === "linked_todo_set")).toBe(false);
    fireEvent.blur(box);
    await waitFor(() => expect(calls).toContainEqual({ command: "linked_todo_set", args: { id: "todo-12345678", checked: null, text: "Buy bread" } }));
  });
  it("is read-only when the editor is", async () => {
    view({ editable: false });
    await waitFor(() => expect((screen.getByLabelText("To-do text") as HTMLInputElement).readOnly).toBe(true));
    expect((screen.getByLabelText("Done") as HTMLInputElement).disabled).toBe(true);
  });
  it("a missing to-do keeps the saved text visible and cannot be ticked", async () => {
    db.todo = null;
    view();
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect((screen.getByLabelText("To-do text") as HTMLInputElement).value).toBe("Old text");
    expect((screen.getByLabelText("Done") as HTMLInputElement).disabled).toBe(true);
  });
  it("lists the pages that show it and opens one", async () => {
    const open = vi.fn();
    view({}, ctx(open));
    await waitFor(() => expect(screen.getByLabelText("Shown on 2 pages")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Shown on 2 pages"));
    fireEvent.click(await screen.findByText("Shopping"));
    expect(open).toHaveBeenCalledWith("p2");
  });
  it("reports a failed save instead of pretending it worked", async () => {
    db.fail = "The notes are read-only";
    const onError = vi.fn();
    view({}, ctx(vi.fn(), onError));
    await waitFor(() => expect((screen.getByLabelText("Done") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Done"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect((screen.getByLabelText("Done") as HTMLInputElement).checked).toBe(false);
  });
});

describe("linked to-do plumbing", () => {
  it("finds the linked to-dos in nested blocks without duplicates", () => {
    const blocks = [{ type: "nouLinkedTodo", props: { todoId: "a" } }, { type: "paragraph", children: [{ type: "nouLinkedTodo", props: { todoId: "b" } }, { type: "nouLinkedTodo", props: { todoId: "a" } }, { type: "nouLinkedTodo", props: { todoId: "" } }] }];
    expect(blockLinkedTodoIds(blocks).sort()).toEqual(["a", "b"]);
  });
  it("search text includes the to-do text", () => {
    expect(blocksToPlainText([{ type: "nouLinkedTodo", props: { text: "Buy milk" } }, { type: "paragraph", content: [{ type: "text", text: "after" }] }])).toContain("Buy milk");
  });
  it("existing to-dos are offered for /linked and /shared, not for everyday words", () => {
    expect(wantsExistingTodos("linked")).toBe(true); expect(wantsExistingTodos("Link to-do")).toBe(true); expect(wantsExistingTodos("shared")).toBe(true);
    expect(wantsExistingTodos("to")).toBe(false); expect(wantsExistingTodos("")).toBe(false); expect(wantsExistingTodos("head")).toBe(false);
  });
});
