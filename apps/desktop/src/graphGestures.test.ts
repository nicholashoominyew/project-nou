import { describe, expect, it } from "vitest";
import { wheelAction, zoomAround, MAX_ZOOM, MIN_ZOOM } from "./graphGestures";

const w = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean }>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...o });

describe("wheelAction", () => {
  it("a trackpad pinch (Ctrl + wheel) zooms smoothly: spreading zooms in, pinching zooms out", () => {
    const inn = wheelAction(w({ ctrlKey: true, deltaY: -4.5 })), out = wheelAction(w({ ctrlKey: true, deltaY: 4.5 }));
    expect(inn.type).toBe("zoom"); expect(out.type).toBe("zoom");
    expect((inn as { factor: number }).factor).toBeGreaterThan(1);
    expect((out as { factor: number }).factor).toBeLessThan(1);
    expect((inn as { factor: number }).factor).toBeLessThan(1.1);
  });
  it("caps a single huge pinch event", () => {
    expect((wheelAction(w({ ctrlKey: true, deltaY: -5000 })) as { factor: number }).factor).toBeLessThan(2);
  });
  it("two-finger scrolling on a trackpad pans, with the picture following the fingers", () => {
    expect(wheelAction(w({ deltaX: 6, deltaY: 12.5 }))).toEqual({ type: "pan", dx: -6, dy: -12.5 });
    expect(wheelAction(w({ deltaX: 0, deltaY: 3 }))).toEqual({ type: "pan", dx: -0, dy: -3 });
  });
  it("a mouse wheel notch zooms a step, in or out", () => {
    expect(wheelAction(w({ deltaY: -100 }))).toEqual({ type: "zoom", factor: 1.15 });
    expect((wheelAction(w({ deltaY: 100 })) as { factor: number }).factor).toBeCloseTo(1 / 1.15);
    expect(wheelAction(w({ deltaY: -3, deltaMode: 1 })).type).toBe("zoom");
  });
});

describe("zoomAround", () => {
  it("keeps the point under the cursor fixed", () => {
    const v = { k: 1, x: 0, y: 0 };
    const z = zoomAround(v, 2, 300, 200);
    expect((300 - z.x) / z.k).toBeCloseTo(300); expect((200 - z.y) / z.k).toBeCloseTo(200);
  });
  it("stays within the zoom limits", () => {
    let v = { k: 1, x: 0, y: 0 };
    for (let i = 0; i < 40; i++) v = zoomAround(v, 2, 0, 0);
    expect(v.k).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i++) v = zoomAround(v, 0.5, 0, 0);
    expect(v.k).toBe(MIN_ZOOM);
  });
});
