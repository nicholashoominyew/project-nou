import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(cleanup);
// Node 25+ ships its own global `localStorage` that is unusable without --localstorage-file and hides jsdom's.
// Use an in-memory Storage so tests behave the same on Node 22 (CI) and newer local Node versions.
if (typeof globalThis.localStorage?.clear !== "function") {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    get length() { return data.size; }, clear: () => data.clear(), key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, String(v)); }, removeItem: (k: string) => { data.delete(k); },
  } });
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, media: "", onchange: null });
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
