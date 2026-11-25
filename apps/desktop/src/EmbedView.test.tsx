import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbedView from "./EmbedView";
import { writeExtraHosts } from "./embed";

const { calls, files } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], files: {} as Record<string, string> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "read_attachment") { if (!(args.id in files)) throw new Error("File not found"); return { data: Array.from(new TextEncoder().encode(files[args.id])), info: { mime: "text/html" } }; }
  return null;
} }));
const base = { url: "", title: "Chart", height: 480, mode: "live" as const, fileId: "", editable: false };
const setOnline = (v: boolean) => Object.defineProperty(navigator, "onLine", { value: v, configurable: true });
beforeEach(() => { calls.length = 0; localStorage.clear(); setOnline(true); for (const k of Object.keys(files)) delete files[k]; });
afterEach(() => { cleanup(); vi.useRealTimers(); setOnline(true); });

describe("a live embed", () => {
  it("is a sandboxed, lazy frame of an allowed https page, with exactly the sandbox asked for and no top navigation", () => {
    writeExtraHosts(["example.com"]);
    const { container } = render(<EmbedView {...base} url="https://docs.example.com/page" />);
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("src")).toBe("https://docs.example.com/page"); expect(f.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
    expect(f.getAttribute("sandbox")).not.toMatch(/top-navigation/); expect(f.getAttribute("loading")).toBe("lazy"); expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect((f as HTMLElement).style.height).toBe("480px"); expect(screen.getByText("Open in new tab")).toBeTruthy(); // never a frame without a way out
  });
  it("shows a plain link card, not a frame, for a site that is not on the list (and a link card names the setting to change)", () => {
    const { container } = render(<EmbedView {...base} url="https://evil.example/x" />);
    expect(container.querySelector("iframe")).toBeNull();
    const card = screen.getByRole("group", { name: "Embedded page: Chart" }); expect(within(card).getByText(/not on your list/)).toBeTruthy(); expect(within(card).getByText("Open in new tab")).toBeTruthy();
    cleanup(); for (const url of ["http://claude.ai/a", "javascript:alert(1)", "https://claude.ai.evil.com/a", "https://evilclaude.ai/a", "https://user:pw@claude.ai/a"]) { const r = render(<EmbedView {...base} url={url} />); expect(r.container.querySelector("iframe"), url).toBeNull(); r.unmount(); }
  });
  it("shows the address in a card with “Open in new tab” for a site known to refuse framing (claude.ai), and loads it only if asked", () => {
    const { container } = render(<EmbedView {...base} url="https://claude.ai/artifact/abc" />);
    expect(container.querySelector("iframe")).toBeNull();
    const card = screen.getByRole("group", { name: "Embedded page: Chart" });
    expect(within(card).getByText(/frame-ancestors/)).toBeTruthy(); expect(within(card).getByText("https://claude.ai/artifact/abc")).toBeTruthy();
    fireEvent.click(within(card).getByText("Open in new tab")); expect(calls.at(-1)).toEqual({ command: "open_bookmark", args: { url: "https://claude.ai/artifact/abc" } });
    fireEvent.click(within(card).getByText("Try live view anyway"));
    const f = container.querySelector("iframe")!; expect(f.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups"); // the same sandbox: it is never loosened to make a page load
  });
  it("falls back to the card when the frame never reports loading, with Open in new tab and Try again", () => {
    vi.useFakeTimers(); writeExtraHosts(["example.com"]);
    const { container } = render(<EmbedView {...base} url="https://example.com/p" />);
    act(() => { vi.advanceTimersByTime(10_500); }); // it never reported loading
    expect(container.querySelector("iframe")).toBeNull(); expect(screen.getByText(/did not load inside NOU/)).toBeTruthy(); expect(screen.getByText("Open in new tab")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again")); expect(container.querySelector("iframe")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10_500); }); // it never reported loading
    expect(container.querySelector("iframe")).toBeNull(); expect(screen.getByText(/did not load inside NOU/)).toBeTruthy();
    cleanup(); const r = render(<EmbedView {...base} url="https://example.com/p" />); const f = r.container.querySelector("iframe")!;
    fireEvent.load(f); act(() => { vi.advanceTimersByTime(20_000); }); expect(r.container.querySelector("iframe")).not.toBeNull(); // a page that did load stays
  });
  it("says it is offline instead of showing a blank frame, and shows the frame again when the connection returns", () => {
    writeExtraHosts(["example.com"]); setOnline(false);
    const { container } = render(<EmbedView {...base} url="https://example.com/p" />);
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(container.querySelector("iframe")).toBeNull(); expect(screen.getByText(/You are offline/)).toBeTruthy();
    setOnline(true); act(() => { window.dispatchEvent(new Event("online")); }); expect(container.querySelector("iframe")).not.toBeNull();
  });
  it("shows a card asking for an address when there is none or it is not valid", () => {
    render(<EmbedView {...base} url="" />); expect(screen.getByText(/Add the page's address/)).toBeTruthy(); cleanup();
    render(<EmbedView {...base} url="ftp://x.y/z" />); expect(screen.getByText(/Only https/)).toBeTruthy();
  });
  it("an allowed host added in Settings starts to embed at once", () => {
    const { container } = render(<EmbedView {...base} url="https://docs.example.com/p" />); expect(container.querySelector("iframe")).toBeNull();
    act(() => { writeExtraHosts(["example.com"]); }); expect(container.querySelector("iframe")).not.toBeNull();
  });
});

describe("a snapshot", () => {
  it("is shown from its stored file in a frame with scripts only: no same-origin, no network policy gaps, no navigation", async () => {
    files["a".repeat(64)] = "<!DOCTYPE html><p id=x>Saved page</p>";
    const { container } = render(<EmbedView {...base} mode="snapshot" fileId={"a".repeat(64)} />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts"); expect(f.getAttribute("src")).toBeNull();
    const doc = f.getAttribute("srcdoc")!; expect(doc).toContain("Saved page"); expect(doc).toMatch(/connect-src 'none'/); expect(doc).toMatch(/default-src 'none'/); expect(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(screen.getByText(/saved copy: it will not update/i)).toBeTruthy(); expect(calls.find(c => c.command === "read_attachment")!.args).toEqual({ id: "a".repeat(64) });
  });
  it("works offline (it needs no connection) and explains when the file is missing or nothing is attached", async () => {
    setOnline(false); files["b".repeat(64)] = "<p>offline ok</p>";
    const { container } = render(<EmbedView {...base} mode="snapshot" fileId={"b".repeat(64)} />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull()); expect(screen.queryByText(/offline/i)).toBeNull(); cleanup();
    render(<EmbedView {...base} mode="snapshot" fileId={"c".repeat(64)} />); expect(await screen.findByText(/could not be opened/)).toBeTruthy(); cleanup();
    render(<EmbedView {...base} mode="snapshot" fileId="" editable />); expect(screen.getByText(/No page is attached yet/)).toBeTruthy(); expect(screen.getAllByText(/Attach an \.html file/).length).toBeGreaterThan(0);
  });
  it("attaching a file hands it to the page's file store, and switching modes changes only the mode", async () => {
    const attach = vi.fn(async () => {}), change = vi.fn();
    render(<EmbedView {...base} mode="snapshot" fileId="" editable onAttach={attach} onChange={change} />);
    const file = new File(["<p>x</p>"], "chart.html", { type: "text/html" });
    fireEvent.change(screen.getByLabelText("Choose an .html file"), { target: { files: [file] } });
    await waitFor(() => expect(attach).toHaveBeenCalledWith(file));
    fireEvent.click(screen.getByRole("button", { name: "Live" })); expect(change).toHaveBeenCalledWith({ mode: "live" });
  });
});

describe("resizing", () => {
  it("changes the height with the keyboard within its limits (and not at all when it cannot be edited)", () => {
    writeExtraHosts(["example.com"]); const change = vi.fn();
    const { container } = render(<EmbedView {...base} url="https://example.com/p" editable onChange={change} />);
    const grip = screen.getByRole("slider", { name: "Embed height" }); expect(grip.getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(grip, { key: "ArrowDown" }); expect(change).toHaveBeenLastCalledWith({ height: 520 }); fireEvent.keyDown(grip, { key: "ArrowUp" }); expect(change).toHaveBeenLastCalledWith({ height: 440 });
    cleanup(); const r = render(<EmbedView {...base} url="https://example.com/p" height={99999} />); expect((r.container.querySelector("iframe") as HTMLElement).style.height).toBe("1600px"); expect(screen.queryByRole("slider")).toBeNull(); void container;
  });
});
