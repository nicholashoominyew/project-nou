import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import FlowchartView, { type FlowMode } from "./FlowchartView";
// @ts-ignore node built-ins are available in the test runner
import { readFileSync } from "node:fs";
import { parseFlowchart, serializeFlowchart, emptyChart, addNode, connect, moveNode } from "./flowchart";

/** Keeps the chart in state the way the editor block does, so each action sees the result of the last. */
function Harness({ start = "", editable = true, mode = "edit", spy }: { start?: string; editable?: boolean; mode?: FlowMode; spy?: (json: string) => void }) {
  const [data, setData] = useState(start);
  return <FlowchartView data={data} editable={editable} mode={mode} onChange={json => { setData(json); spy?.(json); }} />;
}
const seeded = () => {
  let c = emptyChart();
  c = addNode(c, "Start", "terminal", "a").chart; c = addNode(c, "Decide", "decision", "b").chart; c = addNode(c, "Done", "step", "c").chart;
  return serializeFlowchart(connect(c, "a", "b"));
};
const last = (spy: ReturnType<typeof vi.fn>) => parseFlowchart(spy.mock.calls[spy.mock.calls.length - 1][0]);
const frame = (el: Element) => { (el as SVGElement).getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 440, right: 800, bottom: 440, x: 0, y: 0, toJSON() {} }) as DOMRect; };
const viewBox = (c: HTMLElement) => c.querySelector("svg.flowchart-svg")!.getAttribute("viewBox")!;
const btn = (name: string) => screen.getByRole("button", { name });

describe("edit mode", () => {
  it("has exactly three tools, as icons with names: Box, Connect and Tidy up", () => {
    render(<Harness start={seeded()} />);
    const bar = screen.getByRole("toolbar", { name: "Flowchart tools" });
    expect(within(bar).getAllByRole("button").map(b => b.getAttribute("aria-label"))).toEqual(["Box", "Connect", "Tidy up"]);
    expect(bar.textContent).toBe("");
  });
  it("starts empty with a hint; double-clicking the canvas places a box and opens its text for typing", () => {
    const spy = vi.fn();
    const { container } = render(<Harness spy={spy} />);
    expect(screen.getByText(/empty flowchart/)).toBeTruthy();
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    fireEvent.doubleClick(svg, { clientX: 400, clientY: 220 });
    expect(last(spy).nodes.length).toBe(1);
    const text = screen.getByLabelText("Box text") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "Open the app" } });
    fireEvent.keyDown(text, { key: "Enter" });
    expect(last(spy).nodes[0].text).toBe("Open the app");
    expect(screen.queryByLabelText("Box text")).toBeNull();
    expect(screen.getByLabelText("Step: Open the app")).toBeTruthy();
  });
  it("the Box tool places one box where you click, then turns off", () => {
    const spy = vi.fn();
    const { container } = render(<Harness spy={spy} />);
    fireEvent.click(btn("Box"));
    expect(btn("Box").getAttribute("aria-pressed")).toBe("true");
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    fireEvent.click(svg, { clientX: 400, clientY: 220 });
    expect(last(spy).nodes.length).toBe(1);
    expect(btn("Box").getAttribute("aria-pressed")).toBe("false");
  });
  it("double-clicking a box edits its text on the canvas: Enter saves, Escape cancels", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    let text = screen.getByLabelText("Box text") as HTMLInputElement;
    expect(text.value).toBe("Done");
    fireEvent.change(text, { target: { value: "Finished" } }); fireEvent.keyDown(text, { key: "Escape" });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    text = screen.getByLabelText("Box text") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "Finished" } }); fireEvent.keyDown(text, { key: "Enter" });
    expect(last(spy).nodes.find(n => n.id === "c")!.text).toBe("Finished");
  });
  it("double-clicking an arrow edits its label", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    fireEvent.doubleClick(container.querySelector(".flowchart-edge")!);
    const text = screen.getByLabelText("Connection label");
    fireEvent.change(text, { target: { value: "yes" } }); fireEvent.keyDown(text, { key: "Enter" });
    expect(last(spy).edges[0].label).toBe("yes");
  });
  it("anything can be selected by clicking: a box shows the box bar, an arrow the connection bar, the background clears it", () => {
    const { container } = render(<Harness start={seeded()} />);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(screen.getByRole("toolbar", { name: "Box settings" })).toBeTruthy();
    fireEvent.click(container.querySelector(".flowchart-edge")!);
    expect(screen.getByRole("toolbar", { name: "Connection settings" })).toBeTruthy();
    fireEvent.click(container.querySelector("svg.flowchart-svg")!);
    expect(screen.queryByRole("toolbar", { name: /settings/ })).toBeNull();
  });
  it("dragging a box moves it", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    const n0 = parseFlowchart(seeded()).nodes.find(n => n.id === "c")!;
    const box = screen.getByLabelText("Step: Done");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 220, clientY: 160, pointerId: 1 });
    const moved = last(spy).nodes.find(n => n.id === "c")!;
    expect(moved.x !== n0.x || moved.y !== n0.y).toBe(true);
  });
  it("Connect joins two boxes by clicking them in turn", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(btn("Connect"));
    fireEvent.click(screen.getByLabelText("Decision: Decide"));
    fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(last(spy).edges.map(e => [e.from, e.to])).toEqual([["a", "b"], ["b", "c"]]);
  });
  it("Connect needs at least two boxes", () => {
    render(<Harness start={serializeFlowchart(addNode(emptyChart(), "Only", "step", "a").chart)} />);
    expect((btn("Connect") as HTMLButtonElement).disabled).toBe(true);
  });
  it("Delete removes the selected arrow, or a focused box with its connections", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(container.querySelector(".flowchart-edge")!);
    fireEvent.click(btn("Delete connection"));
    expect(last(spy).edges.length).toBe(0);
    fireEvent.keyDown(screen.getByLabelText("Decision: Decide"), { key: "Delete" });
    expect(last(spy).nodes.map(n => n.id)).toEqual(["a", "c"]);
  });
  it("a selected box can change shape, line, line colour and fill colour from small icon buttons", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    fireEvent.click(btn("Shape: Decision")); expect(last(spy).nodes.find(n => n.id === "c")!.shape).toBe("decision");
    fireEvent.click(btn("Line: Dashed")); expect(last(spy).nodes.find(n => n.id === "c")!.line).toBe("dashed");
    fireEvent.click(btn("Line colour")); fireEvent.click(btn("Line colour: Red"));
    expect(last(spy).nodes.find(n => n.id === "c")!.border).toBe("red");
    fireEvent.click(btn("Fill colour")); fireEvent.click(btn("Fill colour: Blue"));
    expect(last(spy).nodes.find(n => n.id === "c")!.fill).toBe("blue");
  });
  it("a selected arrow can change line, route, arrowhead and colour", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(container.querySelector(".flowchart-edge")!);
    fireEvent.click(btn("Line: Dotted")); expect(last(spy).edges[0].line).toBe("dotted");
    fireEvent.click(btn("Route: Straight")); expect(last(spy).edges[0].route).toBe("straight");
    fireEvent.click(btn("Arrowhead")); expect(last(spy).edges[0].arrow).toBe(false);
    fireEvent.click(btn("Line colour")); fireEvent.click(btn("Line colour: Green"));
    expect(last(spy).edges[0].color).toBe("green");
  });
  it("a selected arrow shows end handles for moving it to another box", () => {
    const { container } = render(<Harness start={seeded()} />);
    expect(container.querySelector(".fc-handle")).toBeNull();
    fireEvent.click(container.querySelector(".flowchart-edge")!);
    expect(container.querySelectorAll(".fc-handle").length).toBe(2);
  });
  it("Tidy up lays the boxes out", () => {
    const spy = vi.fn();
    render(<Harness start={serializeFlowchart(moveNode(parseFlowchart(seeded()), "c", 900, 5))} spy={spy} />);
    fireEvent.click(btn("Tidy up"));
    expect(spy).toHaveBeenCalled();
  });
});

describe("view mode", () => {
  it("shows only the chart: no toolbar, no settings, no zoom buttons, no buttons of any kind", () => {
    const { container } = render(<Harness start={seeded()} mode="view" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    for (const t of ["Box", "Connect", "Tidy up", "Fit"]) expect(screen.queryByText(t)).toBeNull();
    expect(screen.queryByLabelText("Zoom in")).toBeNull();
    expect(container.querySelector(".flowchart-panel")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".flowchart.view")).not.toBeNull();
    expect(screen.getByLabelText("Step: Done")).toBeTruthy();
  });
  it("cannot be changed: no selecting, renaming, deleting, dragging, panning or zooming, and the whole chart stays fitted", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} mode="view" spy={spy} />);
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    const fitted = viewBox(container);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    fireEvent.keyDown(screen.getByLabelText("Step: Done"), { key: "Delete" });
    fireEvent.click(svg);
    svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 80, deltaY: 40, bubbles: true, cancelable: true }));
    svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -9, ctrlKey: true, bubbles: true, cancelable: true }));
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(spy).not.toHaveBeenCalled();
    expect(viewBox(container)).toBe(fitted);
    expect(screen.queryByLabelText("Box text")).toBeNull();
    expect(container.querySelector(".flowchart-halo")).toBeNull();
    expect(container.querySelector("svg.editing")).toBeNull();
  });
  it("is also what a read-only note shows, whatever the mode says", () => {
    const { container } = render(<Harness start={seeded()} editable={false} mode="edit" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(container.querySelector(".flowchart.view")).not.toBeNull();
  });
  it("keeps the colours and line types of the chart", () => {
    const styled = JSON.stringify({ nodes: [{ id: "a", text: "A", x: 0, y: 0, border: "red", line: "dashed", fill: "blue" }, { id: "b", text: "B", x: 0, y: 100 }], edges: [{ from: "a", to: "b", color: "green", line: "dotted" }] });
    const { container } = render(<Harness start={styled} mode="view" />);
    const rect = screen.getByLabelText("Step: A").querySelector("rect") as SVGElement;
    expect(rect.style.strokeDasharray).toBe("9 6"); expect(rect.style.stroke).toContain("#d1453b");
    expect((container.querySelector(".flowchart-edge path[marker-end]") as SVGElement).style.stroke).toContain("#3f9a5a");
  });
  it("switching from edit to view clears the selection and the tools, and back again starts clean", () => {
    function Switch() { const [m, setM] = useState<FlowMode>("edit"); return <><button onClick={() => setM(x => (x === "edit" ? "view" : "edit"))}>toggle</button><Harness start={seeded()} mode={m} /></>; }
    const { container } = render(<Switch />);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(screen.getByRole("toolbar", { name: "Box settings" })).toBeTruthy();
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByRole("toolbar", { name: "Box settings" })).toBeNull();
    expect(container.querySelector(".flowchart-halo")).toBeNull();
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByRole("toolbar", { name: "Box settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Box" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("safety and canvas", () => {
  it("hostile text is drawn as text, and damaged data opens as an empty chart", () => {
    const hostile = JSON.stringify({ nodes: [{ id: "a", text: "<img src=x onerror=alert(1)>", x: 0, y: 0 }], edges: [] });
    const { container, unmount } = render(<Harness start={hostile} />);
    expect(container.querySelector("img,script")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    unmount();
    render(<Harness start="{{{ not json" />);
    expect(screen.getByText(/empty flowchart/i)).toBeTruthy();
  });
  it("while editing, two-finger scroll pans and pinch zooms the canvas, and the page is not scrolled", async () => {
    const { container } = render(<Harness start={seeded()} />);
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    const start = viewBox(container);
    const pan = new WheelEvent("wheel", { deltaX: 40, deltaY: 12.5, bubbles: true, cancelable: true });
    svg.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    await waitFor(() => expect(viewBox(container)).not.toBe(start));
    const [, , w1] = viewBox(container).split(" ").map(Number);
    svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -6, ctrlKey: true, clientX: 400, clientY: 220, bubbles: true, cancelable: true }));
    await waitFor(() => expect(Number(viewBox(container).split(" ")[2])).toBeLessThan(w1));
  });
  it("dragging the background pans the canvas; Tidy up refits it", () => {
    const { container } = render(<Harness start={seeded()} />);
    const svg = container.querySelector("svg.flowchart-svg")!; frame(svg);
    const fitted = viewBox(container);
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(viewBox(container)).not.toBe(fitted);
    fireEvent.click(screen.getByRole("button", { name: "Tidy up" }));
    expect(viewBox(container)).not.toBe("");
  });
});

describe("width", () => {
  // @ts-ignore process is available in the test runner
  const css = readFileSync(process.cwd() + "/src/styles.css", "utf8") as string;
  it("the flowchart block spans the page from where the text starts to the right margin in both modes, never into the side menu's space, and stays inside a column or the split pane", () => {
    expect(css).toMatch(/\.bn-block-content\[data-content-type="nouFlowchart"\]\{display:block;width:100%;max-width:none\}/);
    expect(css).toMatch(/\.flowchart\{width:calc\(100% \+ var\(--doc-pad,52px\) - 16px\);margin-inline:0 calc\(16px - var\(--doc-pad,52px\)\)/);
    // the left edge stays where the text starts, so the side menu (+ and the six dots) in the left margin is never covered
    expect(css).not.toMatch(/\.flowchart\{[^}]*margin-inline:calc\(16px - var\(--doc-pad/);
    expect(css).toMatch(/\.split-body\{--doc-pad:32px\}/);
    expect(css).toMatch(/\.bn-block:has\(>\.node-nouColumns\) \.flowchart\{width:100%;margin-inline:0\}/);
    // no mode narrows it again
    expect(css).not.toMatch(/\.flowchart\.view\{[^}]*(max-width|width:)/);
  });
  it("the same block class is used in both modes, so one rule covers both", () => {
    const { container, unmount } = render(<Harness start={seeded()} mode="edit" />);
    expect(container.querySelector(".flowchart")).not.toBeNull();
    unmount();
    const view = render(<Harness start={seeded()} mode="view" />);
    expect(view.container.querySelector(".flowchart.view")).not.toBeNull();
  });
});
