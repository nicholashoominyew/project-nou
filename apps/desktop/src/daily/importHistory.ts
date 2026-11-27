// Reading a history file into days. Two shapes are taken: a Markdown file for one day (as Notion exports a page), or a JSON file
// {"days":[{"date":"2026-11-27","notion_page_id":"…","markdown":"…"}]}. Headings are matched to section-registry.json.
import { BLOCKS, SECTIONS, type BlockId } from "./logic";

export type ImportEntry = { section: string; time: string; source: string; topic: string; text: string; link: string; done: boolean };
export type ImportDay = { day: string; notion_page_id: string | null; entries: ImportEntry[]; journal: Partial<Record<BlockId, string[]>> };
export type Parsed = { days: ImportDay[]; unknownHeadings: string[] };

const plain = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\*\*|__|`/g, "").replace(/^\s*\d+[a-z]?[.)]\s*/, "").replace(/\s*\(.*?\)\s*$/, "").replace(/[:\s]+$/, "").trim();
const sectionNames = new Map<string, string>([...SECTIONS.filter(s => s.id !== "journal").map(s => [plain(s.title), s.id] as const), ["todo list", "todo_list"], ["to do list", "todo_list"], ["braindump", "braindump"]]);
const blockNames = new Map<string, BlockId>([...BLOCKS.map(b => [plain(b.title), b.id] as const), ["quote of the day", "quote"], ["quotes of the day", "quote"]]);

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-11-27", "27 November 2026" or "November 27, 2026" found in a line. */
export function findDate(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (iso) return iso[0];
  const a = text.match(/\b(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})\b/), b = text.match(/\b([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})\b/);
  const [d, m, y] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : ["", "", ""];
  const month = MONTHS.findIndex(name => m && name.startsWith(m.toLowerCase()));
  return month < 0 ? null : `${y}-${pad(month + 1)}-${pad(Number(d))}`;
}

function toEntry(section: string, line: string, done: boolean): ImportEntry {
  let text = line.trim(), time = "", source = "", topic = "", link = "";
  const stamped = text.match(/^(\d{2}:\d{2})\s*[·•|-]\s*([^:\[\]]{1,60}):\s+(.*)$/);
  if (stamped) [, time, source, text] = stamped;
  // Markdown links keep their words; the first address becomes the entry's link.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, words: string, url: string) => { link ||= url; return words; });
  const bare = text.match(/\s+[-–]\s+(https?:\/\/\S+|no link|link)\s*$/i);
  if (bare) { text = text.slice(0, bare.index); if (bare[1].startsWith("http")) link ||= bare[1]; }
  const tagged = text.match(/^\[([^\]]{1,60})\]\s*(.+)$/);
  if (tagged) { topic = tagged[1]; text = tagged[2]; }
  return { section, time, source: source.trim(), topic, text: text.replace(/\*\*|__/g, "").trim(), link, done };
}

export function parseMarkdown(markdown: string, name = "", fallback: string | null = null): Parsed & { day: string | null } {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const day = fallback ?? findDate(lines.find(l => /^\s*date\s*:/i.test(l)) ?? "") ?? findDate(lines.find(l => l.startsWith("# ")) ?? "") ?? findDate(name);
  const entries: ImportEntry[] = [], journal: Partial<Record<BlockId, string[]>> = {}, unknown: string[] = [];
  let section: string | null = null, block: BlockId | null = null, inJournal = false, last: ImportEntry | null = null;
  for (const raw of lines) {
    const heading = raw.match(/^\s*#{1,6}\s+(.*)$/);
    // A block title may also be a line of its own in bold.
    const bold = raw.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*$/);
    const title = heading?.[1] ?? bold?.[1];
    if (title !== undefined) {
      const key = plain(title);
      last = null;
      if (key === "journal") { inJournal = true; section = null; block = null; continue; }
      const asBlock = blockNames.get(key);
      if (asBlock && (inJournal || asBlock !== "notes")) { inJournal = true; block = asBlock; section = null; continue; }
      const found = sectionNames.get(key);
      if (found) { section = found; block = null; inJournal = false; continue; }
      if (heading && !/^#\s/.test(raw.trim())) { unknown.push(title.trim()); section = null; block = null; }
      continue;
    }
    if (!raw.trim() || /^\s*(---+|<\/?[a-z][^>]*>)\s*$/i.test(raw)) continue;
    const item = raw.match(/^(\s*)(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/);
    const indent = (item?.[1] ?? raw.match(/^\s*/)![0]).length, text = (item ? item[3] : raw).trim();
    if (!text) continue;
    if (block) (journal[block] ??= []).push(text);
    else if (section) {
      if (indent >= 2 && last) last.text += " · " + text;
      else { last = toEntry(section, text, item?.[2]?.toLowerCase() === "x"); if (last.text) entries.push(last); }
    }
  }
  const id = name.match(/([0-9a-f]{32})(?:\.md)?$/i)?.[1] ?? null;
  return { day, unknownHeadings: unknown, days: day ? [{ day, notion_page_id: id, entries, journal }] : [] };
}

export function parseHistoryFile(name: string, text: string): Parsed {
  if (name.toLowerCase().endsWith(".json")) {
    let data: { days?: { date?: string; day?: string; notion_page_id?: string; markdown?: string }[] };
    try { data = JSON.parse(text); } catch { throw new Error(`${name} is not valid JSON.`); }
    if (!Array.isArray(data?.days)) throw new Error(`${name} has no list of days.`);
    const days: ImportDay[] = [], unknown: string[] = [];
    for (const d of data.days) {
      const got = parseMarkdown(String(d.markdown ?? ""), "", findDate(String(d.date ?? d.day ?? "")));
      if (!got.days.length) throw new Error(`${name} has a day without a date.`);
      days.push({ ...got.days[0], notion_page_id: d.notion_page_id ?? null }); unknown.push(...got.unknownHeadings);
    }
    return { days, unknownHeadings: [...new Set(unknown)] };
  }
  const got = parseMarkdown(text, name);
  if (!got.days.length) throw new Error(`No date found in ${name}. It needs a "Date:" line or a date in its title.`);
  return { days: got.days, unknownHeadings: [...new Set(got.unknownHeadings)] };
}
