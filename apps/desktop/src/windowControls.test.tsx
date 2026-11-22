import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WindowControls from "./WindowControls";

const win = vi.hoisted(() => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), maximized: false, fullscreen: false, resized: null as null | (() => void) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  minimize: win.minimize, toggleMaximize: win.toggleMaximize, close: win.close,
  isMaximized: async () => win.maximized, isFullscreen: async () => win.fullscreen,
  onResized: async (f: () => void) => { win.resized = f; return () => { win.resized = null; }; },
}) }));
beforeEach(() => { win.minimize.mockReset(); win.toggleMaximize.mockReset(); win.close.mockReset(); win.maximized = false; win.fullscreen = false; });
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
const desktop = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; };

describe("window controls", () => {
  it("are not drawn in a browser, where the browser has its own", () => {
    const { container } = render(<WindowControls />);
    expect(container.firstChild).toBeNull();
  });
  it("minimise, maximise and close call the window, with labels for every button", async () => {
    desktop(); render(<WindowControls />);
    fireEvent.click(screen.getByRole("button", { name: "Minimise" })); expect(win.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Maximise" })); expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(win.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Window controls" })).toBeTruthy();
  });
  it("shows Restore while the window is maximised and follows resizes", async () => {
    desktop(); win.maximized = true; render(<WindowControls />);
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    win.maximized = false; win.resized?.();
    expect(await screen.findByRole("button", { name: "Maximise" })).toBeTruthy();
  });
  it("hides itself in fullscreen", async () => {
    desktop(); win.fullscreen = true; render(<WindowControls />);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull());
  });
});
