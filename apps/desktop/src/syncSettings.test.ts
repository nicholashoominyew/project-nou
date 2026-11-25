import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ saved: [] as any[], stored: [] as any[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command === "app_settings_save_cmd") { h.saved = args.entries; return args.entries.length; }
  if (command === "app_settings_get_cmd") return h.stored;
  return null;
} }));
import { applySettingsSnapshot, saveSettingsSnapshot, SHARED_SETTINGS } from "./syncSettings";
beforeEach(() => { localStorage.clear(); h.saved = []; h.stored = []; });

describe("settings that travel with a sync", () => {
  it("saves the shared preferences, and leaves screen- and device-specific ones out", async () => {
    localStorage.setItem("nou-theme", "\"dark\""); localStorage.setItem("nou-home-layout", "{\"a\":1}"); localStorage.setItem("nou-open-tabs", "[1]"); localStorage.setItem("nou-sim-offset", "5"); localStorage.setItem("other", "x");
    expect(await saveSettingsSnapshot()).toBe(2);
    expect(h.saved).toEqual([{ key: "nou-theme", value: "\"dark\"" }, { key: "nou-home-layout", value: "{\"a\":1}" }]);
    expect(SHARED_SETTINGS).not.toContain("nou-open-tabs"); expect(SHARED_SETTINGS).not.toContain("nou-sim-offset");
  });
  it("puts them back after a restore, ignoring anything that is not on the shared list", async () => {
    localStorage.setItem("nou-theme", "\"light\"");
    h.stored = [{ key: "nou-theme", value: "\"dark\"" }, { key: "nou-open-tabs", value: "[9]" }, { key: "evil", value: "x" }];
    expect(await applySettingsSnapshot()).toBe(1);
    expect(localStorage.getItem("nou-theme")).toBe("\"dark\""); expect(localStorage.getItem("nou-open-tabs")).toBeNull(); expect(localStorage.getItem("evil")).toBeNull();
  });
});
