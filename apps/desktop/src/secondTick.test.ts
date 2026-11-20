import { afterEach, describe, expect, it, vi } from "vitest";
import { onSecond } from "./secondTick";

afterEach(() => { vi.useRealTimers(); });

describe("the shared second clock", () => {
  it("wakes every listener at the same top of the second, whenever each one subscribed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 21, 7, 2, 58, 400));
    const seen: string[] = [];
    const stopA = onSecond(() => seen.push("A@" + new Date().getSeconds() + "." + new Date().getMilliseconds()));
    vi.advanceTimersByTime(250); // a second listener joins a quarter of a second later
    const stopB = onSecond(() => seen.push("B@" + new Date().getSeconds() + "." + new Date().getMilliseconds()));
    vi.advanceTimersByTime(350); // 07:02:59.000
    expect(seen).toEqual(["A@59.0", "B@59.0"]);
    vi.advanceTimersByTime(1000);
    expect(seen.slice(2)).toEqual(["A@0.0", "B@0.0"]); // 07:03:00: the same instant again
    stopA(); stopB();
  });
  it("stops when nobody is listening, starts again for a new listener, and one failing listener does not stop the rest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 21, 7, 0, 0, 0));
    const a = vi.fn(), b = vi.fn();
    const stopA = onSecond(a); stopA();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000); expect(a).not.toHaveBeenCalled();
    const stopBad = onSecond(() => { throw new Error("boom"); }); const stopB = onSecond(b);
    vi.advanceTimersByTime(2000); expect(b).toHaveBeenCalledTimes(2);
    stopBad(); stopB(); expect(vi.getTimerCount()).toBe(0);
  });
});
