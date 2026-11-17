import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GraphView from "./GraphView";

const { state } = vi.hoisted(() => ({ state: { edges: [] as { source: string; target: string }[], fail: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => { if (command === "list_link_edges") { if (state.fail) throw new Error(state.fail); return state.edges; } } }));
const page = (id: string, title: string, parent_id: string | null = null) => ({ id, title, parent_id, sort_key: id });
const pages = [page("a", "Alpha"), page("b", "Beta"), page("c", "Gamma", "a"), page("d", "Lonely")];
beforeEach(() => { state.edges = [{ source: "a", target: "b" }]; state.fail = ""; });

describe("GraphView", () => {
  it("draws every page and counts pages and links", async () => {
    render(<GraphView pages={pages} onOpen={() => {}} />);
    expect(await screen.findByLabelText("Open Alpha")).toBeTruthy();
    for (const t of ["Beta", "Gamma", "Lonely"]) expect(screen.getByLabelText("Open " + t)).toBeTruthy();
    expect(await screen.findByText("4 pages, 1 link")).toBeTruthy(); // the link count appears once the links have loaded
  });
  it("draws main pages bigger than subpages, and gives main pages a bold label", async () => {
    const { container } = render(<GraphView pages={[page("a", "Main"), page("b", "Sub", "a"), page("c", "Subsub", "b")]} onOpen={() => {}} />);
    await screen.findByLabelText("Open Main");
    const r = (t: string) => Number(screen.getByLabelText("Open " + t).querySelector("circle")!.getAttribute("r"));
    expect(r("Main")).toBeGreaterThan(r("Sub")); expect(r("Sub")).toBeGreaterThan(r("Subsub"));
    expect(screen.getByLabelText("Open Main").getAttribute("class")).toContain("main");
    expect(screen.getByLabelText("Open Sub").getAttribute("class")).not.toContain("main");
    expect(container.querySelectorAll(".graph-node.main").length).toBe(1);
  });
  it("opens a page when its dot is clicked or Enter is pressed", async () => {
    const open = vi.fn();
    render(<GraphView pages={pages} onOpen={open} />);
    fireEvent.click(await screen.findByLabelText("Open Beta"));
    fireEvent.keyDown(screen.getByLabelText("Open Gamma"), { key: "Enter" });
    expect(open.mock.calls).toEqual([["b"], ["c"]]);
  });
  it("does not open pages while the app is saving", async () => {
    const open = vi.fn();
    render(<GraphView pages={pages} onOpen={open} disabled />);
    fireEvent.click(await screen.findByLabelText("Open Beta"));
    expect(open).not.toHaveBeenCalled();
  });
  it("can hide pages that have no lines, and the hierarchy lines", async () => {
    const { container } = render(<GraphView pages={pages} onOpen={() => {}} />);
    await screen.findByLabelText("Open Alpha");
    expect(container.querySelectorAll("line.tree").length).toBe(1);
    fireEvent.click(screen.getByLabelText("Show page hierarchy"));
    expect(container.querySelectorAll("line.tree").length).toBe(0);
    expect(screen.getByLabelText("Open Lonely")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show pages with no lines"));
    expect(screen.queryByLabelText("Open Lonely")).toBeNull();
    expect(screen.queryByLabelText("Open Gamma")).toBeNull();
    expect(screen.getByLabelText("Open Alpha")).toBeTruthy();
  });
  it("ignores links to pages that are not in the list (trashed or hidden)", async () => {
    state.edges = [{ source: "a", target: "ghost" }, { source: "a", target: "b" }];
    const { container } = render(<GraphView pages={pages} onOpen={() => {}} />);
    await screen.findByLabelText("Open Alpha");
    await waitFor(() => expect(screen.getByText("4 pages, 1 link")).toBeTruthy());
    expect(container.querySelectorAll("line:not(.tree)").length).toBe(1);
  });
  it("explains how to make links when there are none, and when there are no pages", async () => {
    state.edges = [];
    const { unmount } = render(<GraphView pages={pages} onOpen={() => {}} />);
    expect(await screen.findByText(/Type @ in a note/)).toBeTruthy();
    unmount();
    render(<GraphView pages={[]} onOpen={() => {}} />);
    expect(await screen.findByText("No pages yet.")).toBeTruthy();
  });
  it("shows an error from the backend but still draws the pages", async () => {
    state.fail = "database busy";
    render(<GraphView pages={pages} onOpen={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: database busy");
    expect(screen.getByLabelText("Open Alpha")).toBeTruthy();
  });
  it("refuses to draw an enormous workspace and says why", async () => {
    const many = Array.from({ length: 420 }, (_, i) => page("p" + i, "Page " + i));
    render(<GraphView pages={many} onOpen={() => {}} />);
    expect(await screen.findByText(/too many to draw at once/, {}, { timeout: 5000 })).toBeTruthy();
  });
  it("zoom buttons change the view and Reset puts it back", async () => {
    const { container } = render(<GraphView pages={pages} onOpen={() => {}} />);
    await screen.findByLabelText("Open Alpha");
    const g = () => container.querySelector("svg > g")!.getAttribute("transform");
    const start = g();
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(g()).not.toBe(start);
    fireEvent.click(screen.getByText("Reset"));
    expect(g()).toBe(start);
  });
  it("trackpad: two-finger scroll pans, pinch zooms, and the page is not scrolled or zoomed underneath", async () => {
    const { container } = render(<GraphView pages={pages} onOpen={() => {}} />);
    await screen.findByLabelText("Open Alpha");
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const g = () => container.querySelector("svg > g")!.getAttribute("transform");
    const start = g();
    const pan = new WheelEvent("wheel", { deltaX: 20, deltaY: 10.5, bubbles: true, cancelable: true });
    svg.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    await waitFor(() => expect(g()).toBe("translate(-20 -10.5) scale(1)"));
    const pinch = new WheelEvent("wheel", { deltaY: -5, ctrlKey: true, clientX: 500, clientY: 350, bubbles: true, cancelable: true });
    svg.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    await waitFor(() => expect(g()).toMatch(/scale\(1\.0/));
    expect(g()).not.toBe(start);
  });
});
