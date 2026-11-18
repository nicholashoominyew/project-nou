/** Pasting a screenshot (or a copied image) into a note. */
const IMAGE = /^image\/(png|jpeg|gif|webp|bmp)$/;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
export const MAX_PASTED_IMAGES = 10;

type Clipboard = { files?: ArrayLike<File> | null; getData?: (type: string) => string } | null | undefined;

/**
 * The images on the clipboard, or none. A screenshot is an image with no text, so that is what is taken over. When the clipboard also carries text
 * (copying cells from a spreadsheet puts a picture of them next to the text) the normal paste is left alone and the text is pasted.
 */
export function pastedImages(clip: Clipboard): File[] {
  if (!clip?.files || !clip.files.length) return [];
  let text = "";
  try { text = clip.getData?.("text/plain") ?? ""; } catch { /* some clipboards refuse; treat as no text */ }
  if (text.trim()) return [];
  return Array.from(clip.files).filter(f => IMAGE.test(f.type) && f.size > 0).slice(0, MAX_PASTED_IMAGES);
}

const generic = /^(image|blob|untitled|clipboard)?\d*\.?(png|jpe?g|gif|webp|bmp)?$/i;
/** Screenshots arrive called "image.png" (or nothing). Give them a name that says when they were taken: "Screenshot 2026-11-18 21.40.12.png". */
export function pastedName(file: File, now = new Date()): string {
  const ext = EXT[file.type] ?? "png";
  const name = (file.name || "").trim();
  if (name && !generic.test(name)) return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
  const p = (n: number) => String(n).padStart(2, "0");
  return `Screenshot ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
}
/** The same image under its screenshot name. Pasting several in one go keeps them apart with a counter. */
export function namedPastes(files: File[], now = new Date()): File[] {
  const used = new Map<string, number>();
  return files.map(f => {
    let name = pastedName(f, now);
    const n = (used.get(name) ?? 0) + 1; used.set(name, n);
    if (n > 1) name = name.replace(/(\.[a-z]+)$/i, ` (${n})$1`);
    return new File([f], name, { type: f.type });
  });
}
