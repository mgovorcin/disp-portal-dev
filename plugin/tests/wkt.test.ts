import { wktToGeometry } from "../src/wkt";
import { formatVelocity } from "../src/panel";

describe("wktToGeometry", () => {
  it("parses a polygon", () => {
    const g = wktToGeometry("POLYGON ((-95.26 29.94, -95.25 30, -95 30, -95.26 29.94))");
    expect(g).toEqual({ type: "Polygon", coordinates: [[[-95.26, 29.94], [-95.25, 30], [-95, 30], [-95.26, 29.94]]] });
  });
  it("parses a polygon with a hole", () => {
    const g = wktToGeometry("POLYGON((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))");
    expect(g?.type).toBe("Polygon");
    expect((g as { coordinates: number[][][] }).coordinates).toHaveLength(2);
  });
  it("parses a multipolygon", () => {
    const g = wktToGeometry("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5), (5.1 5.1, 5.2 5.1, 5.2 5.2, 5.1 5.1)))");
    expect(g?.type).toBe("MultiPolygon");
    const c = (g as { coordinates: number[][][][] }).coordinates;
    expect(c).toHaveLength(2);
    expect(c[1]).toHaveLength(2);
    expect(c[0][0][1]).toEqual([1, 0]);
  });
  it("parses a point and rejects junk", () => {
    expect(wktToGeometry("POINT (-95.4 29.75)")).toEqual({ type: "Point", coordinates: [-95.4, 29.75] });
    expect(wktToGeometry("LINESTRING (0 0, 1 1)")).toBeNull();
  });
});

describe("formatVelocity", () => {
  const base = { units: "m/yr", tile_date: null };
  it("formats in mm/yr with sign and clipping", () => {
    expect(formatVelocity({ ...base, value: 0.000945, clipped: false })).toBe("+0.9 mm/yr");
    expect(formatVelocity({ ...base, value: -0.03, clipped: true })).toBe("≤ -30.0 mm/yr");
    expect(formatVelocity({ ...base, value: null, clipped: false })).toBe("no data");
    expect(formatVelocity(null)).toBe("unavailable");
  });
});
