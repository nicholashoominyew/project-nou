import { createContext, useContext, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { BlockColorsItem, DragHandleMenu, SideMenu, TableColumnHeaderItem, TableRowHeaderItem, useBlockNoteEditor, useComponentsContext, useExtensionState, usePortalElement, type SideMenuProps } from "@blocknote/react";
import { appendBlocksToNote } from "./noteAppend";
import { useEditorFeatures } from "./EditorContext";
import { Icon } from "./Icons";
import { BOX_COLORS, BOX_COLOR_HEX, TURN_INTO, boxColor, canTurnInto, copyBlock, matchesAction, type AnyBlock } from "./blockOps";
import { FROM_LINKED, canLink, fromLinked, toLinked } from "./linkedConvert";

export type PageLinkStyle = "line" | "box";
export const nextPageStyle = (style: unknown): PageLinkStyle => (style === "line" ? "box" : "line");

/** The page the editor is showing, so "Move to" can leave it out of the list and say where a block came from. */
export const PageIdContext = createContext<string>("");

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type Item = { id: string; icon?: string; label: string; keys?: string[]; hint?: string; checked?: boolean; swatch?: string; run: () => void };

/** The words and characters typed in a block (its own text, not its children), or nothing for blocks without text. */
export function blockCount(content: unknown): { words: number; characters: number } | null {
  if (!Array.isArray(content)) return null;
  const text = content.map(c => typeof c?.text === "string" ? c.text : Array.isArray(c?.content) ? c.content.map((x: { text?: string }) => x.text ?? "").join("") : "").join("");
  return { words: text.split(/\s+/).filter(Boolean).length, characters: Array.from(text).length };
}

function Row({ i }: { i: Item }) {
  const Components = useComponentsContext()!;
  return <Components.Generic.Menu.Item className="bn-menu-item" checked={i.checked} onClick={i.run}>
    <span className="nou-menu-row">{i.icon&&<span className="nou-menu-icon"><Icon name={i.icon} size={15} /></span>}{i.swatch && <span className="nou-swatch" style={{ background: i.swatch }} />}<span>{i.label}</span>{i.hint && <kbd className="nou-menu-hint">{i.hint}</kbd>}</span></Components.Generic.Menu.Item>;
}
function Sub({ label, icon, children }: { label: string; icon?: string; children: ReactNode }) {
  const Components = useComponentsContext()!;
  const portal = usePortalElement();
  return <Components.Generic.Menu.Root position="right" sub portalElement={portal}>
    <Components.Generic.Menu.Trigger sub><Components.Generic.Menu.Item className="bn-menu-item" subTrigger><span className="nou-menu-row">{icon&&<span className="nou-menu-icon"><Icon name={icon} size={15} /></span>}<span>{label}</span></span></Components.Generic.Menu.Item></Components.Generic.Menu.Trigger>
    <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown nou-submenu">{children}</Components.Generic.Menu.Dropdown>
  </Components.Generic.Menu.Root>;
}

/**
 * The ⠿ menu. Like Notion's: a search box on top, Turn into, Color, Duplicate, Move to and Delete, plus the style and colours of a page link.
 * Typing in the search box shows the matching actions as one flat list.
 */
function NouMenuItems() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const features = useEditorFeatures();
  const pageId = useContext(PageIdContext);
  const block = useExtensionState(SideMenuExtension, { editor, selector: s => s?.block }) as AnyBlock | undefined;
  const [query, setQuery] = useState("");
  const [moveQuery, setMoveQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  // The menu opens level with the block and, with little room to the left, on top of it. It is moved just below the block (when it fits there) so what it acts on stays visible.
  // It cannot go left over the sidebar: the editor clips it there.
  useEffect(() => {
    const t = setTimeout(() => {
      const menu = input.current?.closest<HTMLElement>(".bn-drag-handle-menu"), target = block && document.querySelector(`.bn-editor .bn-block-outer[data-id="${block.id}"]>.bn-block>.bn-block-content`);
      if (!menu || !target || !menu.dataset.position?.startsWith("right")) return;
      const top = menu.getBoundingClientRect().top, down = target.getBoundingClientRect().bottom + 10 - top;
      if (down > 0 && top + down + menu.offsetHeight <= window.innerHeight - 8) menu.style.translate = `0 ${down}px`;
    }, 30);
    return () => clearTimeout(t);
  }, [block?.id]);
  const pages = useMemo(() => features.pages.filter(p => p.id !== pageId), [features.pages, pageId]);
  if (!block) return null;

  const isPage = block.type === "nouPage";
  const isFlow = block.type === "nouFlowchart";
  const flowEditing = isFlow && block.props?.mode !== "view";
  const box = isPage && block.props?.style !== "line";
  const update = (props: Record<string, unknown>) => editor.updateBlock(block as never, { props } as never);
  const textTurn = canTurnInto(block.type) ? TURN_INTO.map(t => ({ id: "turn-" + t.label, label: "Turn into " + t.label, shortLabel: t.label, keys: ["turn", "into", ...t.keys], checked: block.type === t.type && (t.props?.level === undefined || block.props?.level === t.props.level), run: () => editor.updateBlock(block as never, { type: t.type, props: t.props ?? {} } as never) })) : [];
  // Plain lists and checkboxes can become a linked to-do, and a linked to-do can become any of them again.
  const toLinkedItem = canLink(block.type) ? [{ id: "turn-linked", icon: "checklist", label: "Turn into Linked to-do", shortLabel: "Linked to-do", keys: ["turn", "into", "linked", "shared", "todo", "to-do", "checkbox"], checked: false, run: () => void toLinked(editor as never, block).catch(e => features.onError(e)) }] : [];
  const fromLinkedItems = block.type === "nouLinkedTodo" ? FROM_LINKED.map(t => ({ id: "turn-from-" + t.type, label: "Turn into " + t.label, shortLabel: t.label, keys: ["turn", "into", "unlink", ...t.keys], checked: false, run: () => void fromLinked(editor as never, block, t.type).catch(e => features.onError(e)) })) : [];
  const turn = [...textTurn, ...toLinkedItem, ...fromLinkedItems];
  const duplicate = () => editor.insertBlocks([copyBlock(block)] as never, block as never, "after");
  const remove = () => { const picked = editor.getSelection()?.blocks; editor.removeBlocks(picked && picked.some(b => b.id === block.id) ? picked : [block as never]); };
  const moveTo = async (target: { id: string; title: string }) => {
    try {
      await appendBlocksToNote(target.id, [{ type: "raw", block: copyBlock(block) }]);
      try { window.dispatchEvent(new CustomEvent("nou:note-changed", { detail: target.id })); } catch { /* only a refresh hint */ }
      editor.removeBlocks([block as never]); // only after the copy is safely saved on the other page
    } catch (e) { features.onError(e); }
  };

  const flat: Item[] = [
    ...(isFlow ? [{ id: "mode", icon: "eye", label: flowEditing ? "Switch to view mode" : "Switch to edit mode", keys: ["flowchart", "view", "edit", "mode", "lock", "read"], run: () => update({ mode: flowEditing ? "view" : "edit" }) }] : []),
    ...(isPage ? [{ id: "style", icon: "box", label: box ? "Show as a line" : "Show as a box", keys: ["page", "link", "line", "box", "style"], run: () => update({ style: box ? "line" : "box" }) }] : []),
    ...(isPage && box ? [
      ...BOX_COLORS.map(c => ({ id: "border-" + c, label: "Box border: " + capitalise(c), keys: ["border", "line", "colour", "color", c], checked: boxColor(block.props?.boxBorder) === c, swatch: BOX_COLOR_HEX[c], run: () => update({ boxBorder: c }) })),
      ...BOX_COLORS.map(c => ({ id: "fill-" + c, label: "Box fill: " + capitalise(c), keys: ["fill", "background", "colour", "color", c], checked: boxColor(block.props?.boxFill) === c, swatch: BOX_COLOR_HEX[c], run: () => update({ boxFill: c }) })),
    ] : []),
    ...turn,
    { id: "dup", icon: "duplicate", label: "Duplicate", keys: ["copy", "clone"], hint: "Ctrl+D", run: duplicate },
    ...pages.map(p => ({ id: "move-" + p.id, icon: "move", label: "Move to " + (p.title || "Untitled"), keys: ["move", "send"], run: () => void moveTo(p) })),
    { id: "del", icon: "trash", label: "Delete", keys: ["remove", "trash"], hint: "Del", run: remove },
  ];
  const searching = query.trim().length > 0;
  const found = searching ? flat.filter(i => matchesAction(query, i.label, i.keys)).slice(0, 14) : [];
  const moveShown = pages.filter(p => matchesAction(moveQuery, p.title || "Untitled")).slice(0, 40);

  const count = blockCount((block as { content?: unknown }).content);
  return <>
    {/* The block the menu acts on is outlined while the menu is open. A style rule, so nothing inside the editor's own page is touched. */}
    <style>{`.bn-editor .bn-block-outer[data-id="${block.id}"]>.bn-block>.bn-block-content{outline:1px solid color-mix(in srgb,var(--muted) 55%,transparent);outline-offset:3px;border-radius:6px}`}</style>
    <div className="nou-menu-search"><input ref={input} aria-label="Search actions" placeholder="Search actions…" value={query} onChange={e => setQuery(e.target.value)}
      onKeyDown={e => { if (e.key !== "Escape") e.stopPropagation(); if (e.key === "Enter" && found[0]) { e.preventDefault(); found[0].run(); } }} /></div>
    {searching ? (found.length ? found.map(i => <Row key={i.id} i={i} />) : <Components.Generic.Menu.Label>No actions match</Components.Generic.Menu.Label>) : <>
      <Components.Generic.Menu.Label>{isPage ? "Page link" : isFlow ? "Flowchart" : "Text"}</Components.Generic.Menu.Label>
      {isFlow && <Row i={flat.find(i => i.id === "mode")!} />}
      {isPage && <Row i={flat.find(i => i.id === "style")!} />}
      {isPage && box && <>
        <Sub icon="palette" label="Box border colour">{BOX_COLORS.map(c => <Row key={c} i={flat.find(i => i.id === "border-" + c)!} />)}</Sub>
        <Sub icon="palette" label="Box fill colour">{BOX_COLORS.map(c => <Row key={c} i={flat.find(i => i.id === "fill-" + c)!} />)}</Sub>
      </>}
      {turn.length > 0 && <Sub icon="turn" label="Turn into">{turn.map(t => <Row key={t.id} i={{ ...t, icon: undefined, label: t.shortLabel }} />)}</Sub>}
      <BlockColorsItem><span className="nou-menu-row"><span className="nou-menu-icon"><Icon name="palette" size={15} /></span><span>Color</span></span></BlockColorsItem>
      <Components.Generic.Menu.Divider />
      <Row i={flat.find(i => i.id === "dup")!} />
      <Sub icon="move" label="Move to…">
        <div className="nou-menu-search"><input aria-label="Find a page to move to" placeholder="Find a page…" value={moveQuery} onChange={e => setMoveQuery(e.target.value)} onKeyDown={e => { if (e.key !== "Escape") e.stopPropagation(); }} /></div>
        {moveShown.length ? moveShown.map(p => <Components.Generic.Menu.Item key={p.id} className="bn-menu-item" onClick={() => void moveTo(p)}>{p.title || "Untitled"}</Components.Generic.Menu.Item>) : <Components.Generic.Menu.Label>No other pages</Components.Generic.Menu.Label>}
      </Sub>
      <TableRowHeaderItem>Header row</TableRowHeaderItem>
      <TableColumnHeaderItem>Header column</TableColumnHeaderItem>
      <Components.Generic.Menu.Divider />
      <Row i={flat.find(i => i.id === "del")!} />
      {count && <><Components.Generic.Menu.Divider /><div className="nou-menu-foot">{count.words} word{count.words === 1 ? "" : "s"}, {count.characters} character{count.characters === 1 ? "" : "s"}</div></>}
    </>}
  </>;
}

const NouDragHandleMenu: FC = () => <DragHandleMenu><NouMenuItems /></DragHandleMenu>;
export const NouSideMenu = (props: SideMenuProps) => <SideMenu {...props} dragHandleMenu={NouDragHandleMenu} />;
