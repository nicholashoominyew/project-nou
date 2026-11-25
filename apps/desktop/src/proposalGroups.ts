import type { Proposal } from "./gatewayApply";

export type PageRef = { id: string; title: string; parent_id: string | null };
export type ProposalGroup = { key: string; source: string; op: string; where: string; summary: string; items: Proposal[] };

/** Titles differ from request to request in a bulk job ("Create a page called “Monday”"), so quoted text is ignored when comparing. */
const shape = (summary: string) => summary.replace(/“[^”]*”|"[^"]*"/g, "“…”");

/** Waiting requests that belong together: the same bot, the same kind of change, the same parent place and the same description. Order is kept. */
export function groupProposals(items: Proposal[], pages: PageRef[]): ProposalGroup[] {
  const byId = new Map(pages.map(p => [p.id, p]));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const placeOf = (p: Proposal): string => {
    const d = p.payload;
    if (p.op === "create_page") return str(d.parent);
    if (p.op === "create_row") return str(d.database);
    if (p.op === "set_value") return str(d.property);
    return byId.get(str(d.page))?.parent_id ?? "";
  };
  const groups = new Map<string, ProposalGroup>();
  for (const p of items) {
    const place = placeOf(p), summary = shape(p.summary);
    const key = JSON.stringify([p.token_name, p.op, place, summary]);
    const found = groups.get(key);
    if (found) { found.items.push(p); continue; }
    const title = byId.get(place)?.title;
    groups.set(key, { key, source: p.token_name, op: p.op, where: title ? (p.op === "create_row" ? "in " : "under ") + title : "", summary, items: [p] });
  }
  // A group of one keeps the request's own words.
  return [...groups.values()].map(g => (g.items.length === 1 ? { ...g, summary: g.items[0].summary } : g));
}
