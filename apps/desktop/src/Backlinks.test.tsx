import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Backlinks from "./Backlinks";

const { calls, result } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], result: { current: [] as any } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => { calls.push({ command, args }); if (command === "list_backlinks") return result.current; } }));
beforeEach(() => { calls.length = 0; result.current = []; });

describe("Backlinks", () => {
  it("renders nothing when no page links here", async () => {
    const { container } = render(<Backlinks pageId="p" onOpen={() => {}} />);
    await waitFor(() => expect(calls.some(c => c.command === "list_backlinks" && c.args.pageId === "p")).toBe(true));
    expect(container.querySelector(".backlinks")).toBeNull();
  });
  it("lists the linking pages and opens one", async () => {
    result.current = [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }];
    const open = vi.fn();
    render(<Backlinks pageId="p" onOpen={open} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByLabelText("Linked from").textContent).toContain("2");
    fireEvent.click(screen.getByText("Beta"));
    expect(open).toHaveBeenCalledWith("b");
  });
  it("loads once per page and never reloads or blanks itself on re-render (no flicker while typing)", async () => {
    result.current = [{ id: "a", title: "Alpha" }];
    const { rerender } = render(<Backlinks pageId="p" onOpen={() => {}} />);
    const first = await screen.findByText("Alpha");
    rerender(<Backlinks pageId="p" onOpen={() => {}} />);
    rerender(<Backlinks pageId="p" onOpen={() => {}} />);
    expect(screen.getByText("Alpha")).toBe(first);
    expect(calls.length).toBe(1);
    rerender(<Backlinks pageId="q" onOpen={() => {}} />);
    await waitFor(() => expect(calls.length).toBe(2));
  });
});
