export type TrackedFile = { id: string; name: string; mime: string; bytes: number; pages: { id: string; title: string }[]; trashed_pages: number };
export type Kind = "all" | "image" | "pdf" | "other";
export type SortBy = "newest" | "name" | "size";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
}
export const kindOf = (mime: string): Exclude<Kind, "all"> => (mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "other");
/** In use by no page, in the trash or out of it. Such a file can still be saved out; nothing here deletes it. */
export const isUnused = (f: TrackedFile) => f.pages.length === 0 && f.trashed_pages === 0;

export function filterFiles(files: TrackedFile[], opts: { text: string; kind: Kind; unusedOnly: boolean; sort: SortBy }): TrackedFile[] {
  const needle = opts.text.trim().toLowerCase();
  const kept = files.filter(f => (opts.kind === "all" || kindOf(f.mime) === opts.kind) && (!opts.unusedOnly || isUnused(f)) && (!needle || f.name.toLowerCase().includes(needle) || f.pages.some(p => p.title.toLowerCase().includes(needle))));
  // The list arrives newest first, and sort() is stable, so "newest" keeps that order.
  if (opts.sort === "name") return [...kept].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  if (opts.sort === "size") return [...kept].sort((a, b) => b.bytes - a.bytes);
  return kept;
}
export function totals(files: TrackedFile[]) {
  const unused = files.filter(isUnused);
  return { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), unusedCount: unused.length, unusedBytes: unused.reduce((n, f) => n + f.bytes, 0) };
}
