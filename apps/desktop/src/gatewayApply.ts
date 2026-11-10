import { invoke } from "@tauri-apps/api/core";
import { newRichUpdate } from "./richUpdate";

/** One request from an outside client, as the gateway stores it. Never trust its shape: every field is re-checked here. */
export type Proposal = {
  id: string; token_id: string; token_name: string; op: string; payload: Record<string, unknown>; summary: string;
  status: string; created_at: string; decided_at: string | null; applied_at: string | null; result: string | null;
};

const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const id = (v: unknown) => typeof v === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(v);

export const OP_LABELS: Record<string, string> = {
  create_page: "Create a page", rename_page: "Rename a page", set_value: "Change a database cell", create_row: "Add a database row",
  append_text: "Add text to a page", add_checklist_item: "Add a checklist item",
};
/** Operations the app can apply today. The others can be viewed and rejected but not approved. */
export const APPLICABLE_OPS = ["create_page", "rename_page", "set_value", "create_row"] as const;
export const canApply = (op: string) => (APPLICABLE_OPS as readonly string[]).includes(op);

/**
 * Apply an approved proposal through the app's own commands (the same ones a person's edits use), so validation,
 * the restore barrier and backups all still apply. Returns a short result for the audit log; never throws.
 */
export async function applyProposal(p: Pick<Proposal, "op" | "payload">): Promise<{ ok: boolean; result: string }> {
  const d = p.payload;
  try {
    switch (p.op) {
      case "create_page": {
        if (!text(d.title, 200)) throw new Error("The title is missing or too long");
        if (d.parent !== undefined && !id(d.parent)) throw new Error("The parent page id is invalid");
        const page = await invoke<{ id: string }>("create_page", { parentId: (d.parent as string | undefined) ?? null, title: (d.title as string).trim(), initialUpdate: await newRichUpdate() });
        return { ok: true, result: "Created page " + page.id };
      }
      case "rename_page": {
        if (!id(d.page) || !text(d.title, 200)) throw new Error("The page or title is invalid");
        await invoke("rename_page", { pageId: d.page, title: (d.title as string).trim() });
        return { ok: true, result: "Renamed page " + d.page };
      }
      case "set_value": {
        if (!id(d.row) || !id(d.property) || !("value" in d)) throw new Error("The row, property or value is missing");
        await invoke("set_value", { rowId: d.row, propertyId: d.property, value: d.value });
        return { ok: true, result: "Updated a cell" };
      }
      case "create_row": {
        if (!id(d.database)) throw new Error("The database id is invalid");
        if (d.title !== undefined && !text(d.title, 200)) throw new Error("The title is invalid");
        const values = d.values === undefined ? {} : d.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("The values must be an object");
        const row = await invoke<{ id: string }>("add_row", { databaseId: d.database, initialUpdate: await newRichUpdate() });
        if (typeof d.title === "string") await invoke("rename_page", { pageId: row.id, title: d.title.trim() });
        for (const [property, value] of Object.entries(values as Record<string, unknown>)) await invoke("set_value", { rowId: row.id, propertyId: property, value });
        return { ok: true, result: "Added row " + row.id };
      }
      default:
        return { ok: false, result: "This kind of request cannot be applied yet" };
    }
  } catch (e) {
    return { ok: false, result: String(e instanceof Error ? e.message : e).slice(0, 500) };
  }
}
