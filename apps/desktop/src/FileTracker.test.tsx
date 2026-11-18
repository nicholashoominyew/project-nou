import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileTracker from "./FileTracker";
import { filterFiles, formatBytes, isUnused, kindOf, previewKind, totals, type TrackedFile } from "./fileList";

const { state, calls, dialog } = vi.hoisted(() => ({ state: { files: [] as any[], fail: "", exportFail: "" }, calls: [] as { command: string; args: any }[], dialog: { path: "C:\\out\\copy.pdf" as string | null } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "list_files") { if (state.fail) throw new Error(state.fail); return state.files; }
  if (command === "read_attachment") { const f = state.files.find(x => x.id === args.id); return { data: Array.from(new TextEncoder().encode(f?.content ?? "x")), info: { mime: f?.mime ?? "application/octet-stream" } }; }
  if (command === "export_attachment") { if (state.exportFail) throw new Error(state.exportFail); return undefined; }
} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => dialog.path }));

const file = (name: string, extra: Partial<TrackedFile> = {}): TrackedFile => ({ id: name.padEnd(64, "0").slice(0, 64), name, mime: "application/pdf", bytes: 2048, pages: [], trashed_pages: 0, ...extra });
const sample = () => [
  file("report.pdf", { bytes: 5 * 1024 * 1024, pages: [{ id: "p1", title: "Plan" }, { id: "p2", title: "Budget" }] }),
  file("photo.png", { mime: "image/png", bytes: 300, pages: [{ id: "p1", title: "Plan" }] }),
  file("orphan.zip", { mime: "application/zip", bytes: 9000 }),
  file("old.pdf", { bytes: 100, trashed_pages: 2 }),
];
beforeEach(() => { localStorage.setItem("nou-files-view", "list"); URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {}; calls.length = 0; state.files = sample(); state.fail = ""; state.exportFail = ""; dialog.path = "C:\\out\\copy.pdf"; });

describe("file tracker helpers", () => {
  it("formats sizes", () => {
    expect([0, 999, 1024, 1536, 10 * 1024, 5 * 1024 * 1024, 3 * 1024 ** 3].map(formatBytes)).toEqual(["0 B", "999 B", "1.0 KB", "1.5 KB", "10 KB", "5.0 MB", "3.0 GB"]);
    expect(formatBytes(-1)).toBe("?"); expect(formatBytes(NaN)).toBe("?");
  });
  it("classifies types and unused files (a file only in the trash is not unused)", () => {
    expect(kindOf("image/jpeg")).toBe("image"); expect(kindOf("application/pdf")).toBe("pdf"); expect(kindOf("text/html")).toBe("other");
    const [, , orphan, old] = sample();
    expect(isUnused(orphan)).toBe(true); expect(isUnused(old)).toBe(false);
  });
  it("filters by text (file or page name), type and unused, and sorts", () => {
    const all = sample();
    const names = (l: TrackedFile[]) => l.map(f => f.name);
    expect(names(filterFiles(all, { text: "budget", kind: "all", unusedOnly: false, sort: "newest" }))).toEqual(["report.pdf"]);
    expect(names(filterFiles(all, { text: "", kind: "pdf", unusedOnly: false, sort: "newest" }))).toEqual(["report.pdf", "old.pdf"]);
    expect(names(filterFiles(all, { text: "", kind: "all", unusedOnly: true, sort: "newest" }))).toEqual(["orphan.zip"]);
    expect(names(filterFiles(all, { text: "", kind: "all", unusedOnly: false, sort: "name" }))).toEqual(["old.pdf", "orphan.zip", "photo.png", "report.pdf"]);
    expect(names(filterFiles(all, { text: "", kind: "all", unusedOnly: false, sort: "size" }))[0]).toBe("report.pdf");
  });
  it("totals count and bytes, and the unused part", () => {
    expect(totals(sample())).toEqual({ count: 4, bytes: 5 * 1024 * 1024 + 300 + 9000 + 100, unusedCount: 1, unusedBytes: 9000 });
  });
});

describe("FileTracker", () => {
  it("lists every file with its size and the pages that use it, and flags unused ones", async () => {
    render(<FileTracker onOpen={() => {}} />);
    const list = await screen.findByRole("list", { name: "Files" });
    expect(within(list).getAllByRole("listitem").length).toBe(4);
    expect(screen.getByText(/4 files,/)).toBeTruthy();
    expect(screen.getByText("1 not used by any page")).toBeTruthy();
    expect(within(list).getByText("Not used by any page")).toBeTruthy();
    expect(within(list).getByText("Only on 2 pages in the trash")).toBeTruthy();
    expect(within(list).getByText("PDF · 5.0 MB")).toBeTruthy();
  });
  it("opens a page that uses a file, unless the app is busy", async () => {
    const open = vi.fn();
    const { unmount } = render(<FileTracker onOpen={open} />);
    fireEvent.click((await screen.findAllByText("Plan"))[0]);
    expect(open).toHaveBeenCalledWith("p1");
    unmount();
    const blocked = vi.fn();
    render(<FileTracker onOpen={blocked} disabled />);
    fireEvent.click((await screen.findAllByText("Plan"))[0]);
    expect(blocked).not.toHaveBeenCalled();
  });
  it("search, type and unused filters narrow the list; an empty result says so", async () => {
    render(<FileTracker onOpen={() => {}} />);
    await screen.findByRole("list", { name: "Files" });
    fireEvent.click(screen.getByLabelText("Unused only"));
    expect(within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem").length).toBe(1);
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "nothing like this" } });
    expect(screen.getByText("No files match.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Unused only")); fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("File type"), { target: { value: "image" } });
    expect(within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem").length).toBe(1);
  });
  it("Save a copy exports through the normal command and never deletes anything", async () => {
    render(<FileTracker onOpen={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Save a copy of report.pdf"));
    await waitFor(() => expect(calls).toContainEqual({ command: "export_attachment", args: { id: sample()[0].id, path: "C:\\out\\copy.pdf" } }));
    expect(await screen.findByText("Saved a copy of report.pdf")).toBeTruthy();
    expect(calls.every(c => c.command === "list_files" || c.command === "export_attachment")).toBe(true);
  });
  it("cancelling the save dialog does nothing, and a failed export shows the reason", async () => {
    dialog.path = null;
    const { unmount } = render(<FileTracker onOpen={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Save a copy of report.pdf"));
    await new Promise(r => setTimeout(r, 30));
    expect(calls.some(c => c.command === "export_attachment")).toBe(false);
    unmount();
    dialog.path = "C:\\x"; state.exportFail = "The file is missing";
    render(<FileTracker onOpen={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Save a copy of report.pdf"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: The file is missing");
  });
  it("says so when there are no files, and shows a load error", async () => {
    state.files = [];
    const { unmount } = render(<FileTracker onOpen={() => {}} />);
    expect(await screen.findByText(/No files yet/)).toBeTruthy();
    unmount();
    state.fail = "files database busy";
    render(<FileTracker onOpen={() => {}} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
  it("file names are shown as plain text", async () => {
    state.files = [file("<img src=x onerror=alert(1)>.pdf")];
    const { container } = render(<FileTracker onOpen={() => {}} />);
    await screen.findByRole("list", { name: "Files" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });
});

describe("previewKind", () => {
  it("shows images, PDFs and text, never runs html or svg, and has no preview for the rest", () => {
    expect(previewKind("image/png", "a.png")).toBe("image"); expect(previewKind("image/svg+xml", "a.svg")).toBe("none");
    expect(previewKind("application/pdf", "a.pdf")).toBe("pdf"); expect(previewKind("text/html", "a.html")).toBe("text");
    expect(previewKind("application/octet-stream", "notes.md")).toBe("text"); expect(previewKind("application/zip", "a.zip")).toBe("none");
  });
});

describe("FileTracker gallery and preview", () => {
  beforeEach(() => {
    localStorage.removeItem("nou-files-view");
    state.files = [
      file("photo.png", { mime: "image/png", bytes: 300, pages: [{ id: "p1", title: "Plan" }] }),
      file("report.pdf", { pages: [{ id: "p2", title: "Budget" }] }),
      file("todo.txt", { mime: "text/plain", bytes: 12, content: "<b>buy milk</b>" } as any),
      file("orphan.zip", { mime: "application/zip", bytes: 9000 }),
    ];
  });
  it("opens as a gallery with a picture for the image and an icon for the others, and can switch to the list", async () => {
    const { container } = render(<FileTracker onOpen={() => {}} />);
    await screen.findByLabelText("Preview photo.png");
    expect(container.querySelectorAll(".file-tile").length).toBe(4);
    await waitFor(() => expect(container.querySelector(".file-thumb img")).toBeTruthy());
    expect(container.querySelectorAll(".file-thumb img").length).toBe(1);
    fireEvent.click(screen.getByText("List"));
    expect(container.querySelectorAll(".file-tile").length).toBe(0);
    expect(localStorage.getItem("nou-files-view")).toBe("list");
  });
  it("previews an image, a PDF (in a frame) and a text file as plain text, and says so when it cannot", async () => {
    render(<FileTracker onOpen={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Preview photo.png"));
    const dialog = await screen.findByRole("dialog", { name: "Preview of photo.png" });
    await waitFor(() => expect(within(dialog).getByAltText("photo.png")).toBeTruthy());
    fireEvent.click(within(dialog).getByLabelText("Next file"));
    const pdf = await screen.findByRole("dialog", { name: "Preview of report.pdf" });
    await waitFor(() => expect(pdf.querySelector("iframe")).toBeTruthy());
    fireEvent.click(within(pdf).getByLabelText("Next file"));
    const text = await screen.findByRole("dialog", { name: "Preview of todo.txt" });
    expect((await within(text).findByLabelText("File text")).textContent).toBe("<b>buy milk</b>");
    expect(text.querySelector("b")).toBeNull();
    fireEvent.click(within(text).getByLabelText("Next file"));
    expect(await screen.findByText(/no preview for this kind of file/)).toBeTruthy();
    expect((screen.getByLabelText("Next file") as HTMLButtonElement).disabled).toBe(true);
  });
  it("arrow keys move between files, Esc closes, and the pages that use the file can be opened", async () => {
    const open = vi.fn();
    render(<FileTracker onOpen={open} />);
    fireEvent.click(await screen.findByLabelText("Preview photo.png"));
    await screen.findByRole("dialog", { name: "Preview of photo.png" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "Preview of report.pdf" })).toBeTruthy();
    fireEvent.click(screen.getByText("Budget"));
    expect(open).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByLabelText("Preview photo.png"));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("does not read a file that is too large to preview", async () => {
    state.files = [file("huge.png", { mime: "image/png", bytes: 80 * 1024 * 1024 })];
    render(<FileTracker onOpen={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Preview huge.png"));
    expect(await screen.findByText(/Too large to preview/)).toBeTruthy();
    expect(calls.some(c => c.command === "read_attachment")).toBe(false);
  });
});
