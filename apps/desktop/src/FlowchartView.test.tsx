import { render, screen, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import FlowchartView from "./FlowchartView";
import { parseFlowchart, serializeFlowchart, emptyChart, addNode, connect } from "./flowchart";

/** Keeps the chart in state the way the editor block does, so each action sees the result of the last. */
function Harness({ start = "", editable = true, spy }: { start?: string; editable?: boolean; spy?: (json: string) => void }) {
  const [data, setData] = useState(start);
  return <FlowchartView data={data} editable={editable} onChange={json => { setData(json); spy?.(json); }} />;
}
const seeded = () => {
  let c = emptyChart();
  c = addNode(c, "Start", "terminal", "a").chart; c = addNode(c, "Decide", "decision", "b").chart; c = addNode(c, "Done", "step", "c").chart;
  return serializeFlowchart(connect(c, "a", "b"));
};
const last = (spy: ReturnType<typeof vi.fn>) => parseFlowchart(spy.mock.calls[spy.mock.calls.length - 1][0]);

describe("FlowchartView", () => {
  it("starts empty with a hint, then Add step creates a step and opens its text box", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    expect(screen.getByText(/empty flowchart/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Add step"));
    expect(last(spy).nodes.length).toBe(1);
    const box = screen.getByLabelText("Step text") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Open the app" } });
    fireEvent.click(screen.getByText("Save"));
    expect(last(spy).nodes[0].text).toBe("Open the app");
    expect(screen.getByLabelText("Step: Open the app")).toBeTruthy();
  });
  it("Connect then two clicks draws an arrow; a third click on the same step does nothing", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByText("Connect"));
    expect(screen.getByText("Click the first step")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Decision: Decide"));
    expect(screen.getByText("Click the second step")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(last(spy).edges).toEqual([{ from: "a", to: "b", label: "" }, { from: "b", to: "c", label: "" }]);
    expect(screen.getByText("Connect")).toBeTruthy();
  });
  it("connecting a step to itself is ignored", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByText("Connect"));
    fireEvent.click(screen.getByLabelText("Step: Done")); fireEvent.click(screen.getByLabelText("Step: Done"));
    expect(spy).not.toHaveBeenCalled();
  });
  it("selecting a step offers shape, rename and delete; deleting also removes its arrows", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText("Decision: Decide"));
    fireEvent.change(screen.getByLabelText("Shape"), { target: { value: "step" } });
    expect(last(spy).nodes.find(n => n.id === "b")!.shape).toBe("step");
    fireEvent.click(screen.getByText("Delete step"));
    const c = last(spy);
    expect(c.nodes.map(n => n.id)).toEqual(["a", "c"]); expect(c.edges).toEqual([]);
  });
  it("double-click renames, Escape cancels without saving", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    fireEvent.change(screen.getByLabelText("Step text"), { target: { value: "Changed" } });
    fireEvent.keyDown(screen.getByLabelText("Step text"), { key: "Escape" });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Step text")).toBeNull();
  });
  it("an arrow can be selected, labelled and deleted", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide/));
    fireEvent.click(screen.getByText("Label arrow"));
    fireEvent.change(screen.getByLabelText("Arrow label"), { target: { value: "yes" } });
    fireEvent.click(screen.getByText("Save"));
    expect(last(spy).edges[0].label).toBe("yes");
    fireEvent.click(screen.getByLabelText(/Arrow from Start to Decide, yes/));
    fireEvent.click(screen.getByText("Delete arrow"));
    expect(last(spy).edges).toEqual([]);
  });
  it("Tidy up lays the steps out in rows", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.click(screen.getByText("Tidy up"));
    const c = last(spy);
    expect(c.nodes.find(n => n.id === "a")!.y).toBe(0); expect(c.nodes.find(n => n.id === "b")!.y).toBe(100);
  });
  it("Delete on a focused step removes it", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} spy={spy} />);
    fireEvent.keyDown(screen.getByLabelText("Step: Done"), { key: "Delete" });
    expect(last(spy).nodes.map(n => n.id)).toEqual(["a", "b"]);
  });
  it("read-only shows the chart with no tools and ignores edit gestures", () => {
    const spy = vi.fn();
    render(<Harness start={seeded()} editable={false} spy={spy} />);
    expect(screen.queryByText("Add step")).toBeNull();
    expect(screen.getByLabelText("Step: Done")).toBeTruthy();
    fireEvent.doubleClick(screen.getByLabelText("Step: Done"));
    fireEvent.keyDown(screen.getByLabelText("Step: Done"), { key: "Delete" });
    expect(spy).not.toHaveBeenCalled(); expect(screen.queryByLabelText("Step text")).toBeNull();
  });
  it("hostile text is drawn as text, and damaged data opens as an empty chart", () => {
    const hostile = JSON.stringify({ nodes: [{ id: "a", text: "<img src=x onerror=alert(1)>", x: 0, y: 0 }], edges: [] });
    const { container, unmount } = render(<Harness start={hostile} />);
    expect(container.querySelector("img,script")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    unmount();
    render(<Harness start="{{{ not json" />);
    expect(screen.getByText(/empty flowchart/i)).toBeTruthy();
  });
  it("connect needs at least two steps", () => {
    render(<Harness />);
    expect((screen.getByText("Connect") as HTMLButtonElement).disabled).toBe(true);
    const bar = screen.getByRole("toolbar");
    expect(within(bar).getByText("Add step")).toBeTruthy();
  });
});
