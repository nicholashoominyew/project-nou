/** Operations on a block that the ⠿ menu offers. Kept apart from the menu so they are easy to test. */
export type AnyBlock = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] };

/** A copy of a block (and its children) without ids, so the editor gives the copy its own. */
export function copyBlock(b: AnyBlock): AnyBlock {
  return { type: b.type, props: b.props ? { ...b.props } : undefined, content: b.content, children: (b.children ?? []).map(copyBlock) } as AnyBlock;
}

/** Text-like blocks can be turned into one another from the menu. Page links, files, databases and the like cannot. */
export const TURN_INTO_FROM = ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "codeBlock"];
export const canTurnInto = (type: string) => TURN_INTO_FROM.includes(type);
export const TURN_INTO: { label: string; type: string; props?: Record<string, unknown>; keys: string[] }[] = [
  { label: "Text", type: "paragraph", keys: ["paragraph", "plain"] },
  { label: "Heading 1", type: "heading", props: { level: 1 }, keys: ["h1", "title"] },
  { label: "Heading 2", type: "heading", props: { level: 2 }, keys: ["h2"] },
  { label: "Heading 3", type: "heading", props: { level: 3 }, keys: ["h3"] },
  { label: "Bulleted list", type: "bulletListItem", keys: ["bullet", "list"] },
  { label: "Numbered list", type: "numberedListItem", keys: ["number", "list"] },
  { label: "To-do list", type: "checkListItem", keys: ["todo", "check", "task"] },
  { label: "Quote", type: "quote", keys: ["quote"] },
  { label: "Code", type: "codeBlock", keys: ["code"] },
];

/** The colours a page-link box can use for its border and fill. "default" means the normal look. */
export const BOX_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export type BoxColor = (typeof BOX_COLORS)[number];
export const BOX_COLOR_HEX: Record<BoxColor, string> = { default: "#8a8f87", gray: "#7a7f87", brown: "#9a6b4b", red: "#d1453b", orange: "#d9772b", yellow: "#c9a227", green: "#3f9a5a", blue: "#3b7dd8", purple: "#8a5cc7", pink: "#d0549b" };
export const boxColor = (v: unknown): BoxColor => ((BOX_COLORS as readonly string[]).includes(v as string) ? (v as BoxColor) : "default");

/** Does a menu entry match what was typed in the menu's search box? */
export function matchesAction(query: string, label: string, keys: string[] = []): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return label.toLowerCase().includes(q) || keys.some(k => k.toLowerCase().includes(q));
}

/** Line types for the outline of a box and for an arrow. A box can also have no outline; an arrow cannot. */
export const LINE_TYPES = ["solid", "dashed", "dotted", "none"] as const;
export type LineType = (typeof LINE_TYPES)[number];
export const lineType = (v: unknown): LineType => ((LINE_TYPES as readonly string[]).includes(v as string) ? (v as LineType) : "solid");
export const LINE_NAMES: Record<LineType, string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted", none: "No line" };
/** SVG dash pattern for a line type (empty means a continuous line). */
export const dashFor = (l: LineType | undefined): string | undefined => (l === "dashed" ? "9 6" : l === "dotted" ? "2 6" : undefined);
/** The colour of a named tone, and a light tint of it for fills that reads in light and dark mode. */
export const toneStroke = (t: BoxColor | undefined): string | undefined => (t && t !== "default" ? BOX_COLOR_HEX[t] : undefined);
export const toneFill = (t: BoxColor | undefined): string | undefined => (t && t !== "default" ? `color-mix(in srgb, ${BOX_COLOR_HEX[t]} 24%, var(--bg))` : undefined);
