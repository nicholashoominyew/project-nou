import { invoke } from "@tauri-apps/api/core";
import { blocksToPlainText } from "./blockModel";
import type { AnyBlock } from "./blockOps";

/** Blocks that can become a linked to-do: ordinary text, bullets, numbered items and checkboxes. */
export const LINKABLE = ["paragraph", "bulletListItem", "numberedListItem", "checkListItem"];
export const canLink = (type: string) => LINKABLE.includes(type);
export const MAX_LINKED_TEXT = 500;

/** What a linked to-do can be turned back into. */
export const FROM_LINKED: { label: string; type: string; keys: string[] }[] = [
  { label: "Text", type: "paragraph", keys: ["paragraph", "plain"] },
  { label: "Bulleted list", type: "bulletListItem", keys: ["bullet", "list"] },
  { label: "Numbered list", type: "numberedListItem", keys: ["number", "list"] },
  { label: "To-do list", type: "checkListItem", keys: ["todo", "check", "task"] },
];

type Editor = { replaceBlocks: (remove: unknown[], insert: unknown[]) => unknown };
type Todo = { id: string; text: string; checked: boolean };

/** The block's own text, without anything nested under it. Styles such as bold are not kept: a linked to-do is plain text. */
export const ownText = (b: AnyBlock) => blocksToPlainText([{ ...b, children: [] } as never]).replace(/\s+/g, " ").trim();

/**
 * Turn a bullet, numbered item, checkbox or plain line into a linked to-do. A new shared to-do is made from its text (ticked if the checkbox was),
 * and the block is replaced by a block that points at it. Anything nested under the block stays under it.
 */
export async function toLinked(editor: Editor, block: AnyBlock): Promise<void> {
  if (!canLink(block.type)) throw new Error("That kind of block cannot become a linked to-do.");
  const text = ownText(block);
  if (text.length > MAX_LINKED_TEXT) throw new Error(`A linked to-do can be at most ${MAX_LINKED_TEXT} characters. This line has ${text.length}.`);
  const checked = block.type === "checkListItem" && block.props?.checked === true;
  const made = await invoke<Todo>("linked_todo_create", { text });
  if (checked) await invoke("linked_todo_set", { id: made.id, checked: true, text: null });
  editor.replaceBlocks([block], [{ type: "nouLinkedTodo", props: { todoId: made.id, text, checked }, children: (block.children ?? []).map(strip) }]);
}

/**
 * Turn a linked to-do back into an ordinary block, using its text and ticked state as they are now. Other pages that show the same shared to-do keep it:
 * this page just stops being one of them.
 */
export async function fromLinked(editor: Editor, block: AnyBlock, type: string): Promise<void> {
  if (block.type !== "nouLinkedTodo") throw new Error("This is not a linked to-do.");
  let text = String(block.props?.text ?? ""), checked = block.props?.checked === true;
  const id = String(block.props?.todoId ?? "");
  if (id) {
    try { const now = (await invoke<Todo[]>("linked_todo_get", { ids: [id] }))?.[0]; if (now) { text = now.text; checked = now.checked; } } catch { /* the saved copy is used */ }
  }
  const props = type === "checkListItem" ? { checked } : {};
  editor.replaceBlocks([block], [{ type, props, content: text ? [{ type: "text", text, styles: {} }] : [], children: (block.children ?? []).map(strip) }]);
}

/** A block and its children without ids, so the editor gives them their own. */
function strip(b: AnyBlock): AnyBlock {
  return { type: b.type, props: b.props ? { ...b.props } : undefined, content: b.content, children: (b.children ?? []).map(strip) } as AnyBlock;
}
