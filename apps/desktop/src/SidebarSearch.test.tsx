import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarResults, SidebarSearchBox, splitSnippet } from "./SidebarSearch";

const { calls, data } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], data: { lines: [] as any[], files: [] as any[], failLines: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "search_lines") { if (data.failLines) throw new Error(data.failLines); return data.lines; }
  if (command === "list_files") return data.files;
} }));
const page = (id: string, title: string) => ({ id, title, parent_id: null, sort_key: id, icon: "document" });
const pages = [page("a", "Trip plan"), page("b", "Budget 2026"), page("c", "Kyoto notes")] as any;
const S = "\u0001", E = "\u0002";
beforeEach(() => { calls.length = 0; data.lines = []; data.files = []; data.failLines = ""; });

function Harness({ onOpen = () => {} }: { onOpen?: (id: string) => void }) {
  const [q, setQ] = useState("");
  return <><SidebarSearchBox query={q} onQuery={setQ} /><SidebarResults query={q} pages={pages} onOpen={onOpen} /></>;
}

describe("splitSnippet", () => {
  it("splits an excerpt into plain and matched pieces", () => {
    expect(splitSnippet(`train to ${S}Kyoto${E} before`)).toEqual([{ text: "train to ", hit: false }, { text: "Kyoto", hit: true }, { text: " before", hit: false }]);
    expect(splitSnippet("no match here")).toEqual([{ text: "no match here", hit: false }]);
    expect(splitSnippet(`${S}a${E}${S}b${E}`)).toEqual([{ text: "a", hit: true }, { text: "b", hit: true }]);
    expect(splitSnippet("")).toEqual([]);
  });
});

describe("sidebar search", () => {
  it("shows nothing until something is typed, and asks the backend nothing", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector(".sb-results")).toBeNull();
    expect(calls).toEqual([]);
  });
  it("finds pages by title at once, ignoring case", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Search pages, lines and files"), { target: { value: "KYOTO" } });
    const box = await screen.findByLabelText("Pages");
    expect(within(box).getByText("Kyoto notes")).toBeTruthy();
    expect(within(box).queryByText("Trip plan")).toBeNull();
  });
  it("shows matching lines from notes with the matched words highlighted, as plain text", async () => {
    data.lines = [{ id: "a", title: "Trip plan", snippet: `<b>train</b> to ${S}Kyoto${E} <img src=x>` }];
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByLabelText("Search pages, lines and files"), { target: { value: "kyoto" } });
    const lines = await screen.findByLabelText("Lines");
    expect(within(lines).getByText("Kyoto").tagName).toBe("MARK");
    expect(lines.textContent).toContain("<b>train</b>");
    expect(container.querySelector("img,b")).toBeNull();
    expect(calls.find(c => c.command === "search_lines")!.args).toEqual({ query: "kyoto" });
  });
  it("finds files by name and lists the pages that use them; an unused file says so", async () => {
    data.files = [
      { id: "f1".repeat(32), name: "kyoto-map.pdf", mime: "application/pdf", bytes: 2048, pages: [{ id: "a", title: "Trip plan" }], trashed_pages: 0 },
      { id: "f2".repeat(32), name: "kyoto-old.png", mime: "image/png", bytes: 10, pages: [], trashed_pages: 0 },
      { id: "f3".repeat(32), name: "budget.xlsx", mime: "x", bytes: 1, pages: [], trashed_pages: 0 },
    ];
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Search pages, lines and files"), { target: { value: "kyoto" } });
    const files = await screen.findByLabelText("Files");
    expect(within(files).getByText("kyoto-map.pdf")).toBeTruthy();
    expect(within(files).getByText("Trip plan")).toBeTruthy();
    expect(within(files).getByText("Not used by any page")).toBeTruthy();
    expect(within(files).queryByText("budget.xlsx")).toBeNull();
  });
  it("opens the page a result belongs to", async () => {
    data.lines = [{ id: "b", title: "Budget 2026", snippet: `the ${S}rent${E} line` }];
    const open = vi.fn();
    render(<Harness onOpen={open} />);
    fireEvent.change(screen.getByLabelText("Search pages, lines and files"), { target: { value: "rent" } });
    fireEvent.click(await screen.findByText("Budget 2026", { selector: "strong" }));
    expect(open).toHaveBeenCalledWith("b");
  });
  it("says so when nothing matches, shows a search error, and Escape clears the box", async () => {
    data.failLines = "That search could not be run";
    render(<Harness />);
    const box = screen.getByLabelText("Search pages, lines and files") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "zzzz" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(await screen.findByText("Nothing found.")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(box.value).toBe(""));
    expect(screen.queryByRole("region", { name: "Search results" })).toBeNull();
  });
  it("does not ask for the file list more than once while typing", async () => {
    render(<Harness />);
    const box = screen.getByLabelText("Search pages, lines and files");
    for (const q of ["k", "ky", "kyo"]) fireEvent.change(box, { target: { value: q } });
    await waitFor(() => expect(calls.some(c => c.command === "search_lines")).toBe(true));
    expect(calls.filter(c => c.command === "list_files").length).toBe(1);
  });
});
