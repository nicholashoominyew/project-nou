import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import QuickFind from "./QuickFind";

const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "find_pages_by_tag") return [{ id: "b", title: "Beta" }];
  if (command === "search_notes") return [{ id: "a", title: "Alpha" }];
  return [];
} }));
const pages = [{ id: "a", title: "Alpha", parent_id: null, sort_key: "1", icon: "document" }, { id: "b", title: "Beta", parent_id: null, sort_key: "2", icon: "document" }] as any;
beforeEach(() => { calls.length = 0; });

describe("QuickFind", () => {
  it("#tag lists the pages carrying a matching tag instead of searching titles and bodies", async () => {
    const open = vi.fn();
    render(<QuickFind pages={pages} onOpen={open} onClose={() => {}} />);
    const input = screen.getByLabelText("Find a page");
    fireEvent.change(input, { target: { value: "#proj" } });
    await waitFor(() => expect(calls).toContainEqual({ command: "find_pages_by_tag", args: { prefix: "proj" } }));
    expect(await screen.findByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    await new Promise(r => setTimeout(r, 250));
    expect(calls.some(c => c.command === "search_notes")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledWith("b");
  });
  it("a lone # does nothing special and normal text still searches bodies", async () => {
    render(<QuickFind pages={pages} onOpen={() => {}} onClose={() => {}} />);
    const input = screen.getByLabelText("Find a page");
    fireEvent.change(input, { target: { value: "#" } });
    await new Promise(r => setTimeout(r, 250));
    expect(calls.some(c => c.command === "find_pages_by_tag")).toBe(false);
    fireEvent.change(input, { target: { value: "alp" } });
    await waitFor(() => expect(calls.some(c => c.command === "search_notes")).toBe(true));
  });
});
