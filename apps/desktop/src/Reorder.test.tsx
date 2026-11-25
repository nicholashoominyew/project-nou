import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { dropTarget, GRIP, moveBefore, nudge, useReorder } from "./Reorder";

describe("reordering", () => {
  it("moves an item before another, to the end, and ignores nonsense", () => {
    expect(moveBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveBefore(["a", "b", "c", "d"], "a", null)).toEqual(["b", "c", "d", "a"]);
    const same = ["a", "b"];
    expect(moveBefore(same, "a", "a")).toBe(same);
    expect(moveBefore(same, "x", "a")).toBe(same);
    expect(moveBefore(same, "a", "x")).toBe(same);
  });
  it("nudges an item up or down one place and stops at the ends", () => {
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    const l = ["a", "b"];
    expect(nudge(l, "a", -1)).toBe(l); expect(nudge(l, "b", 1)).toBe(l); expect(nudge(l, "z", 1)).toBe(l);
  });
});

afterEach(cleanup);
// jsdom has no PointerEvent: a MouseEvent carries the button and the coordinates the code reads.
if (typeof (window as any).PointerEvent === "undefined") (window as any).PointerEvent = class extends MouseEvent { pointerType: string; constructor(type: string, init: any = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; } };
describe("dragging with the pointer", () => {
  it("finds the row to drop before from the pointer height", () => {
    const rows = [{ id: "a", top: 0, bottom: 40 }, { id: "b", top: 40, bottom: 80 }, { id: "c", top: 80, bottom: 120 }];
    expect([dropTarget(rows, 5), dropTarget(rows, 25), dropTarget(rows, 65), dropTarget(rows, 119)]).toEqual(["a", "b", "c", null]);
  });
  function List({ ids, onChange, disabled }: { ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
    const r = useReorder(ids, onChange, disabled);
    return <ul>{ids.map(id => <li key={id} {...r.rowProps(id)}><button {...r.gripProps(id, id)}>{GRIP}</button>{id}</li>)}</ul>;
  }
  const lay = (li: Element, i: number) => { (li as HTMLElement).getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: i * 40, toJSON() {} }); };
  const setup = (onChange: (ids: string[]) => void, disabled?: boolean) => { const r = render(<List ids={["a", "b", "c"]} onChange={onChange} disabled={disabled} />); r.container.querySelectorAll("li").forEach(lay); return r; };
  it("press the grip, move down past the middle of another row and let go: the row moves there", () => {
    const change = vi.fn(); setup(change);
    fireEvent.pointerDown(screen.getByLabelText(/Drag a to reorder/), { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 70 }); expect(document.querySelector("li.reorder-dragging")).not.toBeNull(); expect(document.querySelector("li.reorder-over")!.textContent).toContain("c");
    fireEvent.pointerUp(window, { clientY: 70 });
    expect(change).toHaveBeenCalledWith(["b", "a", "c"]); expect(document.querySelector(".reorder-dragging")).toBeNull();
  });
  it("dropping below the last row moves it to the end, dropping where it was changes nothing, and Escape cancels", () => {
    const change = vi.fn(); setup(change);
    fireEvent.pointerDown(screen.getByLabelText(/Drag a to reorder/), { button: 0 }); fireEvent.pointerMove(window, { clientY: 500 }); fireEvent.pointerUp(window, { clientY: 500 }); expect(change).toHaveBeenLastCalledWith(["b", "c", "a"]);
    change.mockClear(); fireEvent.pointerDown(screen.getByLabelText(/Drag b to reorder/), { button: 0 }); fireEvent.pointerMove(window, { clientY: 45 }); fireEvent.pointerUp(window, { clientY: 45 }); expect(change).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByLabelText(/Drag c to reorder/), { button: 0 }); fireEvent.pointerMove(window, { clientY: 5 }); fireEvent.keyDown(window, { key: "Escape" }); fireEvent.pointerUp(window, { clientY: 5 }); expect(change).not.toHaveBeenCalled();
  });
  it("does nothing when reordering is off or the press is not the main button", () => {
    const change = vi.fn(); const r = setup(change, true);
    fireEvent.pointerDown(screen.getByLabelText(/Drag a to reorder/), { button: 0 }); fireEvent.pointerMove(window, { clientY: 100 }); fireEvent.pointerUp(window, { clientY: 100 }); expect(change).not.toHaveBeenCalled(); r.unmount();
    setup(change); fireEvent.pointerDown(screen.getByLabelText(/Drag a to reorder/), { button: 2 }); fireEvent.pointerMove(window, { clientY: 100 }); fireEvent.pointerUp(window, { clientY: 100 }); expect(change).not.toHaveBeenCalled(); void act;
  });
});
