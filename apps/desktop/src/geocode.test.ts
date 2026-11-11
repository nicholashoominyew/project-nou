import { describe, expect, it, vi } from "vitest";
import { searchPlaces } from "./geocode";

const reply = (rows: unknown, ok = true, status = 200) => vi.fn(async () => ({ ok, status, json: async () => rows }) as unknown as Response);

describe("searchPlaces", () => {
  it("returns names, addresses and coordinates from the geocoder's answer", async () => {
    const fetchImpl = reply([{ name: "Tokyo Station", display_name: "Tokyo Station, Marunouchi, Chiyoda, Tokyo, Japan", lat: "35.6812", lon: "139.7671" }]);
    expect(await searchPlaces("tokyo station", undefined, fetchImpl)).toEqual([{ name: "Tokyo Station", address: "Tokyo Station, Marunouchi, Chiyoda, Tokyo, Japan", lat: 35.6812, lng: 139.7671 }]);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url.startsWith("https://nominatim.openstreetmap.org/search?")).toBe(true);
    expect(url).toContain("q=tokyo%20station");
    expect(url).toContain("limit=5");
  });
  it("uses the first part of the address when there is no name", async () => {
    const found = await searchPlaces("x1", undefined, reply([{ display_name: "10 Downing Street, Westminster, London", lat: 51.5033, lon: -0.1276 }]));
    expect(found[0].name).toBe("10 Downing Street");
  });
  it("never trusts the remote answer: bad or out-of-range coordinates and empty entries are dropped, text is length-limited", async () => {
    const found = await searchPlaces("anything", undefined, reply([
      { name: "ok", display_name: "ok place", lat: "10", lon: "20" },
      { name: "far", display_name: "far", lat: "91", lon: "0" },
      { name: "wide", display_name: "wide", lat: "0", lon: "181" },
      { name: "nan", display_name: "nan", lat: "abc", lon: "0" },
      { lat: "1", lon: "1" },
      null,
      { name: "x".repeat(500), display_name: "y".repeat(900), lat: 1, lon: 2 },
    ]));
    expect(found.map(f => f.name.length)).toEqual([2, 100]);
    expect(found[1].address.length).toBe(300);
  });
  it("does not contact the service for queries that are too short or too long", async () => {
    const fetchImpl = reply([]);
    expect(await searchPlaces("a", undefined, fetchImpl)).toEqual([]);
    expect(await searchPlaces("   ", undefined, fetchImpl)).toEqual([]);
    expect(await searchPlaces("x".repeat(201), undefined, fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports a service error and ignores a non-list answer", async () => {
    await expect(searchPlaces("tokyo", undefined, reply({}, false, 429))).rejects.toThrow("429");
    expect(await searchPlaces("tokyo", undefined, reply({ error: "nope" }))).toEqual([]);
  });
});
