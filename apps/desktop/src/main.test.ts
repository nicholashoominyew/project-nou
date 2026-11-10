import { expect, it } from "vitest";
import entry from "./main.tsx?raw";

it("does not use React.StrictMode, which destroys the editor's undo history in development", () => {
  const code = entry.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/StrictMode/);
});
