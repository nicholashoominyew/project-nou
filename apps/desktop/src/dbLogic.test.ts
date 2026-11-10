import { describe, expect, it } from "vitest";
import { calcOptions, computeCalc, groupRows, matches, visibleRows } from "./dbLogic";
import type { Property, Row } from "./dbShared";

const status: Property = { id: "st", name: "Status", type: "status", options: [{ id: "a", name: "Todo", color: "gray" }, { id: "b", name: "Done", color: "green" }] };
const hours: Property = { id: "h", name: "Hours", type: "number", options: [] };
const due: Property = { id: "d", name: "Due", type: "date", options: [] };
const name: Property = { id: "n", name: "Notes", type: "text", options: [] };
const tags: Property = { id: "t", name: "Tags", type: "multi_select", options: [{ id: "x", name: "Urgent", color: "red" }] };
const done: Property = { id: "c", name: "Done?", type: "checkbox", options: [] };
const props = [status, hours, due, name, tags, done];
const rows: Row[] = [
  { id: "1", title: "one", values: { st: "b", h: 5, d: "2026-11-03", n: "Alpha beta", t: ["x"], c: true } },
  { id: "2", title: "two", values: { st: "a", h: 2, d: "2026-11-20", n: "gamma" } },
  { id: "3", title: "three", values: { h: 9 } },
  { id: "4", title: "four", values: {} },
];
const ids = (list: Row[]) => list.map(r => r.id).join("");

describe("filters", () => {
  it("covers each property type", () => {
    expect(ids(visibleRows(rows, props, { filters: [{ p: "st", op: "is", v: "b" }] }))).toBe("1");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "st", op: "is_not", v: "b" }] }))).toBe("234");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "h", op: "gt", v: 2 }] }))).toBe("13");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "h", op: "empty" }] }))).toBe("4");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "n", op: "contains", v: "BETA" }] }))).toBe("1");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "d", op: "before", v: "2026-11-10" }] }))).toBe("1");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "d", op: "after", v: "2026-11-10" }] }))).toBe("2");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "t", op: "contains", v: "x" }] }))).toBe("1");
    expect(ids(visibleRows(rows, props, { filters: [{ p: "c", op: "unchecked" }] }))).toBe("234");
  });
  it("an unfinished filter hides nothing and filters combine with AND", () => {
    expect(visibleRows(rows, props, { filters: [{ p: "st", op: "is" }] })).toHaveLength(4);
    expect(ids(visibleRows(rows, props, { filters: [{ p: "h", op: "gt", v: 1 }, { p: "st", op: "is", v: "a" }] }))).toBe("2");
  });
  it("ignores filters on properties that no longer exist", () => {
    expect(visibleRows(rows, props, { filters: [{ p: "gone", op: "empty" }] })).toHaveLength(4);
  });
  it("matches() treats a missing number as not equal", () => {
    expect(matches(rows[3], hours, { p: "h", op: "is_not", v: 5 })).toBe(true);
  });
});

describe("filter modes and automatic properties", () => {
  it("'or' keeps rows matching any filter, 'and' needs all", () => {
    const two = [{ p: "st", op: "is" as const, v: "a" }, { p: "h", op: "gt" as const, v: 8 }];
    expect(ids(visibleRows(rows, props, { filters: two }))).toBe("");
    expect(ids(visibleRows(rows, props, { filters: two, filterMode: "or" }))).toBe("23");
  });
  it("created/last-edited time filter and sort as dates; email and phone filter as text", () => {
    const created: Property = { id: "cr", name: "Created", type: "created_time", options: [] };
    const mail: Property = { id: "em", name: "Mail", type: "email", options: [] };
    const stamped: Row[] = [
      { id: "a", title: "", values: { cr: "2026-11-02T08:00:00.000Z", em: "ann@example.com" } },
      { id: "b", title: "", values: { cr: "2026-11-09T20:30:00.000Z", em: "bob@other.org" } },
    ];
    const all = [created, mail];
    expect(ids(visibleRows(stamped, all, { filters: [{ p: "cr", op: "after", v: "2026-11-05" }] }))).toBe("b");
    expect(ids(visibleRows(stamped, all, { sorts: [{ p: "cr", dir: "desc" }] }))).toBe("ba");
    expect(ids(visibleRows(stamped, all, { filters: [{ p: "em", op: "contains", v: "EXAMPLE" }] }))).toBe("a");
    expect(computeCalc("earliest", stamped, created)).toBe("2026-11-02");
  });
});

describe("sorting", () => {
  it("sorts numbers both ways with empty values always last", () => {
    expect(ids(visibleRows(rows, props, { sorts: [{ p: "h", dir: "asc" }] }))).toBe("2134");
    expect(ids(visibleRows(rows, props, { sorts: [{ p: "h", dir: "desc" }] }))).toBe("3124");
  });
  it("sorts select values by option order and breaks ties with the next sort", () => {
    expect(ids(visibleRows(rows, props, { sorts: [{ p: "st", dir: "asc" }] }))).toBe("2134");
    const tie: Row[] = [{ id: "p", title: "", values: { st: "a", h: 3 } }, { id: "q", title: "", values: { st: "a", h: 1 } }];
    expect(ids(visibleRows(tie, props, { sorts: [{ p: "st", dir: "asc" }, { p: "h", dir: "asc" }] }))).toBe("qp");
  });
  it("does not change the stored row order when there is no sort", () => {
    expect(ids(visibleRows(rows, props, {}))).toBe("1234");
  });
});

describe("grouping", () => {
  it("groups by status in option order with an empty group last", () => {
    const groups = groupRows(rows, status);
    expect(groups.map(g => g.label)).toEqual(["Todo", "Done", "No Status"]);
    expect(groups.map(g => g.rows.length)).toEqual([1, 1, 2]);
  });
  it("groups checkboxes", () => {
    expect(groupRows(rows, done).map(g => g.label + g.rows.length)).toEqual(["Checked1", "Unchecked3"]);
  });
});

describe("calculations", () => {
  it("computes number statistics", () => {
    expect(computeCalc("sum", rows, hours)).toBe("16");
    expect(computeCalc("average", rows, hours)).toBe("5.33");
    expect(computeCalc("median", rows, hours)).toBe("5");
    expect(computeCalc("min", rows, hours)).toBe("2");
    expect(computeCalc("max", rows, hours)).toBe("9");
    expect(computeCalc("range", rows, hours)).toBe("7");
  });
  it("counts and percentages", () => {
    expect(computeCalc("count", rows, hours)).toBe("4");
    expect(computeCalc("count_empty", rows, hours)).toBe("1");
    expect(computeCalc("percent_not_empty", rows, hours)).toBe("75%");
    expect(computeCalc("checked", rows, done)).toBe("1");
    expect(computeCalc("percent_checked", rows, done)).toBe("25%");
  });
  it("handles dates and offers sensible functions per type", () => {
    expect(computeCalc("earliest", rows, due)).toBe("2026-11-03");
    expect(computeCalc("latest", rows, due)).toBe("2026-11-20");
    expect(computeCalc("range", rows, due)).toBe("17 days");
    expect(calcOptions("number")).toContain("sum");
    expect(calcOptions("text")).not.toContain("sum");
    expect(computeCalc("sum", [], hours)).toBe("0");
  });
});
