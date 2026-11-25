import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { saved } = vi.hoisted(() => ({ saved: [] as string[][] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => { if (command === "app_settings_save_cmd") { saved.push(args.entries.filter((e: any) => e.key === "nou-embed-hosts").map((e: any) => e.value)); return args.entries.length; } return null; } }));
import EmbedSettings from "./EmbedSettings";
import { allowedHosts } from "./embed";
beforeEach(() => { localStorage.clear(); saved.length = 0; }); afterEach(cleanup);

it("lists claude.ai as built in, adds and removes sites, and copies the list into the database so assistants' requests are checked against it", async () => {
  render(<EmbedSettings />);
  const list = screen.getByRole("list", { name: "Sites that can be embedded" }); expect(within(list).getByText("claude.ai")).toBeTruthy(); expect(within(list).queryByRole("button")).toBeNull(); // the built-in one cannot be removed
  fireEvent.change(screen.getByLabelText("Site to allow"), { target: { value: "https://Docs.Example.com/some/page" } }); fireEvent.click(screen.getByRole("button", { name: "Add site" }));
  expect(within(list).getByText("docs.example.com")).toBeTruthy(); expect(allowedHosts()).toEqual(["claude.ai", "docs.example.com"]);
  await vi.waitFor(() => expect(saved.at(-1)).toEqual([JSON.stringify(["docs.example.com"])]));
  fireEvent.click(screen.getByRole("button", { name: "Remove docs.example.com" })); expect(allowedHosts()).toEqual(["claude.ai"]);
  await vi.waitFor(() => expect(saved.at(-1)).toEqual([JSON.stringify([])]));
});
it("refuses a site that is not a real host name, or is already there", () => {
  render(<EmbedSettings />);
  for (const bad of ["localhost", "127.0.0.1", "http://", "a b.com", "claude.ai"]) { fireEvent.change(screen.getByLabelText("Site to allow"), { target: { value: bad } }); fireEvent.click(screen.getByRole("button", { name: "Add site" })); expect(screen.getByRole("alert"), bad).toBeTruthy(); }
  expect(allowedHosts()).toEqual(["claude.ai"]);
});
