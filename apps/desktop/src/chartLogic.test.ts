import { describe, expect, it } from "vitest";
import { buildChart, niceScale } from "./chartLogic";
import { DATABASE_VIEW_COMMANDS } from "./editorKeys";
import { VIEW_TYPES, defaultConfig, type Property, type Row } from "./dbShared";

const status: Property = { id: "s", name: "Status", type: "status", options: [{ id: "o1", name: "Todo", color: "gray" }, { id: "o2", name: "Done", color: "green" }] };
const hours: Property = { id: "h", name: "Hours", type: "number", options: [] };
const due: Property = { id: "d", name: "Due", type: "date", options: [] };
const tags: Property = { id: "t", name: "Tags", type: "multi_select", options: [{ id: "a", name: "A", color: "blue" }, { id: "b", name: "B", color: "red" }] };
const props = [status, hours, due, tags];
const row = (id: string, values: Row["values"]): Row => ({ id, title: id, values });
const rows = [row("1", { s: "o1", h: 2, d: "2026-11-03", t: ["a"] }), row("2", { s: "o2", h: 4, d: "2026-11-20", t: ["a", "b"] }), row("3", { s: "o2", h: 6, d: "2026-12-01" }), row("4", {})];

describe("chart data", () => {
  it("needs an X axis", () => expect(buildChart(rows, props, {})).toBeNull());
  it("counts rows per option in the property's own order, with a No value bucket last", () => {
    const d = buildChart(rows, props, { xBy: "s" })!;
    expect(d.buckets.map(b => [b.label, b.total])).toEqual([["Todo", 1], ["Done", 2], ["No Status", 1]]);
    expect(d.max).toBe(2);
  });
  it("sums, averages and takes the median of a number property", () => {
    const by = (yFn: "sum" | "average" | "median" | "min" | "max") => buildChart(rows, props, { xBy: "s", yFn, yBy: "h" })!.buckets.map(b => b.total);
    expect(by("sum")).toEqual([2, 10, 0]); expect(by("average")).toEqual([2, 5, 0]); expect(by("median")).toEqual([2, 5, 0]); expect(by("min")).toEqual([2, 4, 0]); expect(by("max")).toEqual([2, 6, 0]);
  });
  it("sorts by value and hides empty and zero buckets", () => {
    expect(buildChart(rows, props, { xBy: "s", xSort: "y_desc" })!.buckets.map(b => b.label)).toEqual(["Done", "Todo", "No Status"]);
    expect(buildChart(rows, props, { xBy: "s", hideEmpty: true })!.buckets.map(b => b.label)).toEqual(["Todo", "Done"]);
    expect(buildChart(rows, props, { xBy: "s", yFn: "sum", yBy: "h", hideZero: true })!.buckets.map(b => b.label)).toEqual(["Todo", "Done"]);
  });
  it("groups dates by month, week or year in time order", () => {
    expect(buildChart(rows, props, { xBy: "d" })!.buckets.map(b => [b.label, b.total])).toEqual([["Nov 2026", 2], ["Dec 2026", 1], ["No Due", 1]]);
    expect(buildChart(rows, props, { xBy: "d", xGroup: "year" })!.buckets.map(b => b.label)).toEqual(["2026", "No Due"]);
    expect(buildChart(rows, props, { xBy: "d", xGroup: "week" })!.buckets[0].label).toMatch(/^Week of/);
  });
  it("a multi-select row lands in each of its options", () => {
    const d = buildChart(rows, props, { xBy: "t" })!;
    expect(d.buckets.map(b => [b.label, b.total])).toEqual([["A", 2], ["B", 1], ["No Tags", 2]]);
  });
  it("colour groups make one series each; stacked max is the tallest stack, 100% fills to 100", () => {
    const d = buildChart(rows, props, { xBy: "t", colorBy: "s", barStyle: "stacked" })!;
    expect(d.series.map(s => s.label)).toEqual(["Todo", "Done", "No Status"]);
    expect(d.max).toBe(2);
    const p = buildChart(rows, props, { xBy: "t", colorBy: "s", barStyle: "percent" })!;
    expect(p.max).toBe(100); expect(p.buckets[0].values.reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("cumulative adds up along the axis", () => {
    expect(buildChart(rows, props, { xBy: "s", cumulative: true })!.buckets.map(b => b.total)).toEqual([1, 3, 4]);
  });
  it("a tidy axis rounds up to a step", () => {
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 1] });
    const s = niceScale(37); expect(s.top).toBeGreaterThanOrEqual(37); expect(s.ticks[0]).toBe(0);
  });
});

describe("every database view is a slash command", () => {
  it("has one command per view type, each named '<View> view database'", () => {
    expect(DATABASE_VIEW_COMMANDS.map(c => c.type)).toEqual(VIEW_TYPES.map(v => v.type));
    expect(DATABASE_VIEW_COMMANDS.map(c => c.title)).toContain("Table view database");
    expect(DATABASE_VIEW_COMMANDS.map(c => c.title)).toContain("Chart view database");
    expect(DATABASE_VIEW_COMMANDS.every(c => c.aliases.includes("database"))).toBe(true);
  });
  it("a new chart view starts on a Status or Select property", () => {
    expect(defaultConfig("chart", props)).toEqual({ chartType: "vbar", xBy: "s" });
  });
});
