import * as Y from "yjs";

/** Initial BlockNote/Yjs state for a brand-new page or database row. */
export async function newRichUpdate(): Promise<number[]> {
  const { migrateLegacy } = await import("./blockModel");
  const empty = new Y.Doc();
  const rich = migrateLegacy(empty);
  try { return Array.from(Y.encodeStateAsUpdate(rich)); } finally { rich.destroy(); empty.destroy(); }
}
