import { invoke } from "@tauri-apps/api/core";
import type { Summary } from "./logic";
import type { ImportDay } from "./importHistory";

export type Entry = { id: string; section: string; time: string; source: string; topic: string; text: string; link: string; done: boolean };
export type DayPage = { day: string; exists: boolean; notion_page_id: string | null; entries: Entry[]; journal: Record<string, string[]> };
export type Imported = { days: number; entries_added: number; entries_skipped: number; journals_added: number; journals_kept: number };

export const dailyApi = {
  get: (day: string) => invoke<DayPage>("daily_get_cmd", { day }),
  summaries: (from: string, to: string) => invoke<Summary[]>("daily_summaries_cmd", { from, to }),
  saveJournal: (day: string, journal: Record<string, string[]>) => invoke<void>("daily_journal_save_cmd", { day, journal }),
  setTodo: (id: string, done: boolean) => invoke<void>("daily_todo_set_cmd", { id, done }),
  import: (days: ImportDay[]) => invoke<Imported>("daily_import_cmd", { days }),
  openLink: (url: string) => invoke<void>("open_bookmark", { url }),
};
