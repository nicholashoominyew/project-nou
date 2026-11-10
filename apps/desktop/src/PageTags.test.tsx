import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import PageTags from "./PageTags";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { tags: ["Research"] as string[], fail: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "get_page_tags") return state.tags;
  if (command === "list_tags") return [{ name: "Research", count: 2 }, { name: "Ideas", count: 1 }];
  if (command === "set_page_tags") { if (state.fail) throw new Error(state.fail); state.tags = args.names.map((n: string) => n.replace(/^#/, "")); return state.tags; }
} }));
beforeEach(() => { calls.length = 0; state.tags = ["Research"]; state.fail = ""; });

describe("PageTags", () => {
  it("shows the page's tags and removes one", async () => {
    render(<PageTags pageId="p" readOnly={false} onError={() => {}} />);
    expect(await screen.findByText("#Research")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove tag Research"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_page_tags", args: { pageId: "p", names: [] } }));
  });
  it("adds tags typed with Enter or commas, keeping the existing ones", async () => {
    render(<PageTags pageId="p" readOnly={false} onError={() => {}} />);
    await screen.findByText("#Research");
    const input = screen.getByLabelText("Add a tag");
    fireEvent.change(input, { target: { value: "Ideas, Deep Work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toContainEqual({ command: "set_page_tags", args: { pageId: "p", names: ["Research", "Ideas", "Deep Work"] } }));
  });
  it("suggests existing tags that the page does not already have", async () => {
    const { container } = render(<PageTags pageId="p" readOnly={false} onError={() => {}} />);
    await screen.findByText("#Research");
    const options = Array.from(container.querySelectorAll("datalist option")).map(o => (o as HTMLOptionElement).value);
    expect(options).toEqual(["Ideas"]);
  });
  it("reports a rejected tag and does not leave a half-added chip", async () => {
    state.fail = "Tags cannot contain commas";
    const errors: unknown[] = [];
    render(<PageTags pageId="p" readOnly={false} onError={e => errors.push(e)} />);
    await screen.findByText("#Research");
    const input = screen.getByLabelText("Add a tag");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(errors.length).toBe(1));
    expect(screen.queryByText("#bad")).toBeNull();
  });
  it("is read-only while saving is blocked: no input, no remove buttons, and empty tags render nothing", async () => {
    const { container, rerender } = render(<PageTags pageId="p" readOnly={true} onError={() => {}} />);
    await screen.findByText("#Research");
    expect(screen.queryByLabelText("Add a tag")).toBeNull();
    expect(screen.queryByLabelText("Remove tag Research")).toBeNull();
    state.tags = [];
    rerender(<PageTags pageId="q" readOnly={true} onError={() => {}} />);
    await waitFor(() => expect(calls.filter(c => c.command === "get_page_tags").length).toBe(2));
    expect(container.querySelector(".page-tags")).toBeNull();
  });
});
