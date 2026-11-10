import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Home, { type HomeWidget } from "./Home";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => {
  if (command === "list_recent_pages") return [{ id: "a", title: "Alpha", updated_at: new Date(Date.now() - 5 * 60000).toISOString() }, { id: "b", title: "Beta", updated_at: "2020-01-01T00:00:00.000Z" }];
  if (command === "list_tags") return [{ name: "research", count: 3 }];
} }));
const pages = [
  { id: "a", title: "Alpha", parent_id: null, sort_key: "1", icon: "document", is_favorite: true },
  { id: "b", title: "Beta", parent_id: null, sort_key: "2", icon: "document", is_favorite: false },
] as any;
const show = (extra: Partial<React.ComponentProps<typeof Home>> = {}) => render(<Home pages={pages} open={() => {}} searchTag={() => {}} newPage={() => {}} disabled={false} {...extra} />);
beforeEach(() => localStorage.clear());

describe("Home", () => {
  it("shows the built-in widgets: recent pages, favorites and tags", async () => {
    show();
    expect(await screen.findByText("5 min ago")).toBeTruthy();
    expect(within(screen.getByLabelText("Favorites")).getByText("Alpha")).toBeTruthy();
    expect(within(screen.getByLabelText("Tags")).getByText("#research")).toBeTruthy();
  });
  it("opens a page from a widget and starts a tag search", async () => {
    const open = vi.fn(), tag = vi.fn();
    show({ open, searchTag: tag });
    fireEvent.click((await screen.findAllByText("Beta"))[0]);
    expect(open).toHaveBeenCalledWith("b");
    fireEvent.click(await screen.findByText("#research"));
    expect(tag).toHaveBeenCalledWith("research");
  });
  it("offers New page, or Create your first page when the workspace is empty", () => {
    const newPage = vi.fn();
    const { unmount } = show({ newPage });
    fireEvent.click(screen.getByText("New page"));
    expect(newPage).toHaveBeenCalledTimes(1);
    unmount();
    show({ pages: [] });
    expect(screen.getByText("Create your first page")).toBeTruthy();
  });
  it("is disabled while saving: widget links and New page cannot be used", async () => {
    show({ disabled: true });
    await screen.findByText("5 min ago");
    expect((screen.getByText("New page") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByText("Alpha")[0].closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("customize: hide, show again and reorder widgets, and remember the layout", async () => {
    const { unmount } = show();
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByLabelText("Hide Favorites"));
    expect(screen.queryByLabelText("Favorites")).toBeNull();
    fireEvent.click(screen.getByLabelText("Move Tags up"));
    const order = () => screen.getAllByRole("heading", { level: 2 }).map(h => h.textContent);
    expect(order().slice(0, 2)).toEqual(["Tags", "Recently edited"]);
    unmount();
    show(); // a fresh mount reads the saved layout
    expect(screen.queryByLabelText("Favorites")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })[0].textContent).toBe("Tags");
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByText("Show Favorites"));
    expect(screen.getByLabelText("Favorites")).toBeTruthy();
  });
  it("shows a message when every widget is hidden", () => {
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: ["recent", "favorites", "tags"], hidden: ["recent", "favorites", "tags"] }));
    show();
    expect(screen.getByText(/All widgets are hidden/)).toBeTruthy();
  });
  it("a later feature can plug in a widget through the registry", async () => {
    const extra: HomeWidget = { id: "inbox", title: "Inbox", render: () => <p>captured thought</p> };
    show({ widgets: [extra] });
    expect(within(screen.getByLabelText("Inbox")).getByText("captured thought")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Favorites")).toBeNull());
  });
});
