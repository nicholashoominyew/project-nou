import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartView } from "./ChartView";
import { Popover } from "./DatabaseView";
import type { DatabaseData, ViewConfig, ViewContext } from "./dbShared";

afterEach(cleanup);
const data: DatabaseData = {
  title: "T", views: [],
  properties: [{ id: "s", name: "Status", type: "status", options: [{ id: "o1", name: "Todo", color: "gray" }, { id: "o2", name: "Done", color: "green" }] }],
  rows: [{ id: "1", title: "a", values: { s: "o1" } }, { id: "2", title: "b", values: { s: "o2" } }, { id: "3", title: "c", values: { s: "o2" } }],
};
const ctx = (config: ViewConfig): ViewContext => ({ data, view: { id: "v", name: "Chart", type: "chart", config }, readOnly: false, open: () => {}, setValue: async () => {}, addRow: async () => {}, onError: () => {} });

describe("chart view", () => {
  it("asks for an X axis until one is chosen", () => {
    render(<ChartView ctx={ctx({})} />);
    expect(screen.getByText(/Choose a property for the X axis/)).toBeTruthy();
  });
  it.each([["vbar", /Vertical bar chart/], ["hbar", /Horizontal bar chart/], ["line", /Line chart/], ["donut", /Donut chart/]] as const)("draws a %s chart with a mark per value", (chartType, name) => {
    const { container } = render(<ChartView ctx={ctx({ chartType, xBy: "s", dataLabels: true })} />);
    expect(screen.getByRole("img", { name })).toBeTruthy();
    expect(container.querySelectorAll(".db-chart-mark").length).toBe(chartType === "line" ? 2 : 2);
    expect(container.textContent).toContain("2");
  });
  it("the donut shows the total in the middle, and the reference line and axis names are optional", () => {
    const { container, rerender } = render(<ChartView ctx={ctx({ chartType: "donut", xBy: "s" })} />);
    expect(container.querySelector(".db-chart-center")!.textContent).toBe("3");
    rerender(<ChartView ctx={ctx({ chartType: "vbar", xBy: "s", refLine: 2, axisNames: true })} />);
    expect(container.querySelector(".db-chart-ref")).not.toBeNull();
    expect(container.textContent).toContain("Count");
  });
});

describe("menu position", () => {
  it("opens next to its button even when an ancestor with a transform shifts the fixed menu", () => {
    const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON() {} }) as DOMRect;
    const orig = Element.prototype.getBoundingClientRect;
    // The button is at (300, 100). The menu lands 120px to the right and 40px lower than asked, as inside a transformed ancestor.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.tagName === "DETAILS") return rect(300, 100, 30, 28);
      if (this.classList.contains("db-menu")) { const s = (this as HTMLElement).style; return rect(parseFloat(s.left) + 120, parseFloat(s.top) + 40, 200, 100); }
      return orig.call(this);
    };
    try {
      render(<Popover summary="+" summaryLabel="Add a view">menu</Popover>);
      const details = document.querySelector("details")!;
      details.open = true; fireEvent(details, new Event("toggle"));
      const menu = document.querySelector(".db-menu") as HTMLElement;
      expect(parseFloat(menu.style.left)).toBeCloseTo(300 - 120, 0); // pulled back so it appears at the button
      expect(parseFloat(menu.style.top)).toBeCloseTo(128 + 4 - 40, 0);
    } finally { Element.prototype.getBoundingClientRect = orig; }
  });
});
