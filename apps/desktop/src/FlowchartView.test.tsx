import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import FlowchartView, { type FlowMode } from "./FlowchartView";
// @ts-ignore node built-ins are available in the test runner
import { readFileSync } from "node:fs";
import { parseFlowchart, serializeFlowchart, emptyChart, addNode, connect } from "./flowchart";

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
const tool = (name: string) => within(screen.getByRole("group", { name: "Tool" })).getByText(name);
const frame = (el: Element) => { (el as SVGElement).getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 440, right: 800, bottom: 440, x: 0, y: 0, toJSON() {} }) as DOMRect; };
const viewBox = (c: HTMLElement) => c.querySelector("svg")!.getAttribute("viewBox")!;

describe("edit mode: tools", () => {
  it("starts empty with a hint; the Box tool places a box where you click, then opens its text box", () => {
    const spy = vi.fn();
    const { container } = render(<Harness spy={spy} />);
    expect(screen.getByText(/Choose the Box tool/)).toBeTruthy();
    fireEvent.click(tool("Box"));
    expect(screen.getByText("Click the canvas to place a box.")).toBeTruthy();
    const svg = container.querySelector("svg")!; frame(svg);
    fireEvent.click(svg, { clientX: 400, clientY: 220 });
    expect(last(spy).nodes.length).toBe(1);
    const text = screen.getByLabelText("Box text") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "Open the app" } });
    fireEvent.click(screen.getByText("Save"));
    expect(last(spy).nodes[0].text).toBe("Open the app");
    expect(screen.getByLabelText("Step: Open the app")).toBeTruthy();
    expect(tool("Select").getAttribute("aria-pressed")).toBe("true"); // one box per click, then back to Select
  });
  it("Add box in the Box panel adds a box without clicking the canvas", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(tool("Box"));
    fireEvent.click(screen.getByText("Add box"));
    expect(last(spy).nodes.length).toBe(1);
  });
  it("the Connect tool joins two boxes with one click each, stays on for more, and ignores a click on the same box twice", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(tool("Connect"));
    expect(screen.getByText("Click the first box.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Decision: Decide"));
    expect(screen.getByText("Now click the second box.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(last(spy).edges.map(e => [e.from, e.to])).toEqual([["a", "b"], ["b", "c"]]);
    expect(tool("Connect").getAttribute("aria-pressed")).toBe("true");
  });
  it("connecting a box to itself is ignored", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(tool("Connect"));
    fireEvent.click(screen.getByLabelText("Step: Done")); fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(spy).not.toHaveBeenCalled();
  });
  it("Select: double-click renames, Escape cancels, and a selected box can be deleted", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    fireEvent.change(screen.getByLabelText("Box text"), { target: { value: "Changed" } });
    fireEvent.keyDown(screen.getByLabelText("Box text"), { key: "Escape" });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Step: Done"));
    fireEvent.click(screen.getByText("Delete box"));
    expect(last(spy).nodes.map(n => n.id)).toEqual(["a", "b"]);
  });
  it("Delete on a focused box removes it and its connections", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.keyDown(screen.getByLabelText("Decision: Decide"), { key: "Delete" });
    const c = last(spy);
    expect(c.nodes.map(n => n.id)).toEqual(["a", "c"]); expect(c.edges).toEqual([]);
  });
  it("an arrow can be selected, labelled and deleted", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide/));
    fireEvent.click(screen.getByText("Label"));
    fireEvent.change(screen.getByLabelText("Connection label"), { target: { value: "yes" } });
    fireEvent.click(screen.getByText("Save"));
    expect(last(spy).edges[0].label).toBe("yes");
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide, yes/));
    fireEvent.click(screen.getByText("Delete connection"));
    expect(last(spy).edges).toEqual([]);
  });
  it("Tidy up lays the boxes out in rows", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByText("Tidy up"));
    expect(last(spy).nodes.find(n => n.id === "b")!.y).toBe(100);
  });
  it("Connect needs at least two boxes", () => {
    render(<Harness />);
    expect((tool("Connect") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("edit mode: line types, line colours and fill colours", () => {
  it("a selected box can change shape, line type, line colour and fill colour", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    const panel = screen.getByRole("group", { name: "Box settings" });
    fireEvent.change(within(panel).getByLabelText("Shape"), { target: { value: "decision" } });
    fireEvent.change(within(panel).getByLabelText("Box line type"), { target: { value: "dashed" } });
    fireEvent.click(within(panel).getByLabelText("Box line colour: Red"));
    fireEvent.click(within(panel).getByLabelText("Box fill colour: Blue"));
    expect(last(spy).nodes.find(n => n.id === "c")).toMatchObject({ shape: "decision", line: "dashed", border: "red", fill: "blue" });
    expect(within(panel).getByLabelText("Box line colour: Red").getAttribute("aria-pressed")).toBe("true");
  });
  it("the box is drawn with that dash pattern, outline colour and fill; 'No line' removes the outline; a halo marks the selection", () => {
    const { container } = render(<Harness start={seeded()} />);
    fireEvent.click(screen.getByLabelText("Step: Done"));
    const panel = screen.getByRole("group", { name: "Box settings" });
    fireEvent.change(within(panel).getByLabelText("Box line type"), { target: { value: "dotted" } });
    fireEvent.click(within(panel).getByLabelText("Box line colour: Green"));
    fireEvent.click(within(panel).getByLabelText("Box fill colour: Yellow"));
    const rect = () => screen.getByLabelText("Step: Done").querySelector("rect:not(.flowchart-halo)") as SVGElement;
    expect(rect().style.strokeDasharray).toBe("2 6");
    expect(rect().style.stroke).toContain("#3f9a5a");
    expect(rect().style.fill).toContain("#c9a227");
    fireEvent.change(within(panel).getByLabelText("Box line type"), { target: { value: "none" } });
    expect(rect().style.stroke).toBe("none");
    expect(container.querySelector(".flowchart-halo")).not.toBeNull();
  });
  it("a selected arrow can change line type, line colour, arrowhead fill and lose its arrowhead", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide/));
    const panel = screen.getByRole("group", { name: "Connection settings" });
    fireEvent.change(within(panel).getByLabelText("Connection line type"), { target: { value: "dashed" } });
    fireEvent.click(within(panel).getByLabelText("Connection line colour: Purple"));
    fireEvent.click(within(panel).getByLabelText("Connection fill colour: Pink"));
    expect(last(spy).edges[0]).toMatchObject({ line: "dashed", color: "purple", fill: "pink" });
    const line = () => container.querySelector(".flowchart-edge path[marker-end]") as SVGElement;
    expect(line().style.strokeDasharray).toBe("9 6");
    expect(line().style.stroke).toContain("#8a5cc7");
    expect(line().getAttribute("marker-end")).toContain("pink");
    fireEvent.click(within(panel).getByLabelText("Arrowhead"));
    expect(last(spy).edges[0].arrow).toBe(false);
    expect(container.querySelector(".flowchart-edge path[marker-end]")).toBeNull();
  });
  it("arrows are stepped by default, drawn with right angles, and Straight is a choice per connection", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} spy={spy} />);
    const path = () => container.querySelector(".flowchart-edge path[marker-end]") as SVGElement;
    expect(path().getAttribute("d")).toMatch(/^M[-\d. ]+ L[-\d. ]+/);
    expect(path().getAttribute("d")).not.toMatch(/ Q/); // a and b are in line, so one straight segment
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide/));
    const panel = screen.getByRole("group", { name: "Connection settings" });
    expect((within(panel).getByLabelText("Connection shape") as HTMLSelectElement).value).toBe("stepped");
    fireEvent.change(within(panel).getByLabelText("Connection shape"), { target: { value: "straight" } });
    expect(last(spy).edges[0].route).toBe("straight");
  });
  it("an arrow between boxes that are offset is drawn with a step and rounded corners", () => {
    const offset = JSON.stringify({ nodes: [{ id: "a", text: "A", x: 400, y: 0 }, { id: "b", text: "B", x: 0, y: 200 }], edges: [{ from: "a", to: "b" }] });
    const { container } = render(<Harness start={offset} mode="view" />);
    expect((container.querySelector(".flowchart-edge path[marker-end]") as SVGElement).getAttribute("d")).toContain(" Q");
  });
  it("what you choose with nothing selected is used for the next box and the next arrow", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(tool("Box"));
    const panel = screen.getByRole("group", { name: "Box settings" });
    fireEvent.click(within(panel).getByLabelText("Box line colour: Orange"));
    fireEvent.change(within(panel).getByLabelText("Box line type"), { target: { value: "dashed" } });
    fireEvent.click(screen.getByText("Add box"));
    const added = last(spy).nodes[last(spy).nodes.length - 1];
    expect(added).toMatchObject({ border: "orange", line: "dashed" });
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(tool("Connect"));
    fireEvent.change(within(screen.getByRole("group", { name: "Connection settings" })).getByLabelText("Connection line type"), { target: { value: "dotted" } });
    fireEvent.click(screen.getByLabelText("Step: Done")); fireEvent.click(screen.getByLabelText("Decision: Decide"));
    expect(last(spy).edges.find(e => e.from === "c" && e.to === "b")).toMatchObject({ line: "dotted" });
  });
  it("a filled start/end box keeps readable text", () => {
    const { container } = render(<Harness start={seeded()} />);
    fireEvent.click(screen.getByLabelText("Start / end: Start"));
    fireEvent.click(within(screen.getByRole("group", { name: "Box settings" })).getByLabelText("Box fill colour: Yellow"));
    expect((container.querySelector(".flowchart-node.terminal text") as SVGElement).style.fill).toBe("var(--text)");
  });
});

describe("view mode", () => {
  it("shows only the chart: no toolbar, no settings, no zoom buttons, no buttons of any kind", () => {
    const { container } = render(<Harness start={seeded()} mode="view" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    for (const t of ["Select", "Box", "Connect", "Tidy up", "Fit", "Add box"]) expect(screen.queryByText(t)).toBeNull();
    expect(screen.queryByLabelText("Zoom in")).toBeNull();
    expect(container.querySelector(".flowchart-panel")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".flowchart.view")).not.toBeNull();
    expect(screen.getByLabelText("Step: Done")).toBeTruthy();
  });
  it("cannot be changed: no selecting, renaming, deleting, dragging, panning or zooming, and the whole chart stays fitted", () => {
    const spy = vi.fn();
    const { container } = render(<Harness start={seeded()} mode="view" spy={spy} />);
    const svg = container.querySelector("svg")!; frame(svg);
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
    expect(screen.getByRole("group", { name: "Box settings" })).toBeTruthy();
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByRole("group", { name: "Box settings" })).toBeNull();
    expect(container.querySelector(".flowchart-halo")).toBeNull();
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByRole("group", { name: "Box settings" })).toBeNull();
    expect(tool("Select").getAttribute("aria-pressed")).toBe("true");
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
    const svg = container.querySelector("svg")!; frame(svg);
    const start = viewBox(container);
    const pan = new WheelEvent("wheel", { deltaX: 40, deltaY: 12.5, bubbles: true, cancelable: true });
    svg.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    await waitFor(() => expect(viewBox(container)).not.toBe(start));
    const [, , w1] = viewBox(container).split(" ").map(Number);
    svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -6, ctrlKey: true, clientX: 400, clientY: 220, bubbles: true, cancelable: true }));
    await waitFor(() => expect(Number(viewBox(container).split(" ")[2])).toBeLessThan(w1));
  });
  it("dragging the background pans in the Select tool; Fit brings the chart back; the zoom buttons zoom", () => {
    const { container } = render(<Harness start={seeded()} />);
    const svg = container.querySelector("svg")!; frame(svg);
    const fitted = viewBox(container);
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(viewBox(container)).not.toBe(fitted);
    fireEvent.click(screen.getByText("Fit"));
    expect(viewBox(container)).toBe(fitted);
    const w = () => Number(viewBox(container).split(" ")[2]);
    const before = w();
    fireEvent.click(screen.getByLabelText("Zoom in")); expect(w()).toBeLessThan(before);
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
