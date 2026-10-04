import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareSeries } from "../src/chart";
import { picksCsv } from "../src/chart-panel";
import { PickManager, type Pick } from "../src/picks";
import {
  NoDataError,
  TimeseriesClient,
  fitLinear,
  geometryAnchor,
  geometryToWkt,
  parseTimeseries,
  subtractReference,
  toCsv,
} from "../src/timeseries";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/timeseries_point_F08882.json"), "utf8"));
const DAY = 86_400_000;

describe("parseTimeseries", () => {
  it("skips the mean entry, parses dates as UTC and finds the frame", () => {
    const s = parseTimeseries(fixture, "asc");
    expect(s.points).toHaveLength(Object.keys(fixture).length - 1);
    expect(s.frameId).toBe(8882);
    expect(s.mean).not.toBeNull();
    expect(new Date(s.points[0].t).toISOString().slice(0, 10)).toBe("2016-10-09");
    expect(s.points.every((p, i) => i === 0 || p.t >= s.points[i - 1].t)).toBe(true);
    expect(s.points.every((p) => p.ref !== null)).toBe(true);
  });
});

describe("fitLinear", () => {
  it("recovers a known slope in m/yr", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ t: i * 36.525 * DAY, value: 0.005 + 0.012 * (i / 10) }));
    const fit = fitLinear(pts)!;
    expect(fit.slope).toBeCloseTo(0.012, 6);
    expect(fit.intercept).toBeCloseTo(0.005, 6);
  });
  it("needs two distinct times", () => {
    expect(fitLinear([{ t: 0, value: 1 }])).toBeNull();
    expect(fitLinear([{ t: 0, value: 1 }, { t: 0, value: 2 }])).toBeNull();
  });
});

describe("subtractReference", () => {
  it("differences on common dates only", () => {
    const a = [0, 12, 24].map((d) => ({ t: d * DAY + 3600_000, ref: null, value: d / 1000, granule: `a${d}` }));
    const r = [0, 24].map((d) => ({ t: d * DAY, ref: null, value: 0.001, granule: `r${d}` }));
    const out = subtractReference(a, r);
    expect(out.map((p) => p.granule)).toEqual(["a0", "a24"]);
    expect(out[1].value).toBeCloseTo(0.023, 9);
  });
});

describe("geometry helpers", () => {
  it("writes WKT for point, polygon and multipolygon", () => {
    expect(geometryToWkt({ type: "Point", coordinates: [-95.4, 29.75] })).toBe("POINT(-95.4 29.75)");
    const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
    expect(geometryToWkt({ type: "Polygon", coordinates: [ring] })).toBe("POLYGON((0 0,1 0,1 1,0 0))");
    expect(geometryToWkt({ type: "MultiPolygon", coordinates: [[ring], [ring]] })).toBe(
      "MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((0 0,1 0,1 1,0 0)))",
    );
    expect(geometryToWkt({ type: "LineString", coordinates: [] })).toBeNull();
  });
  it("anchors polygons at the ring mean", () => {
    expect(geometryAnchor({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] })).toEqual([1, 1]);
  });
});

describe("TimeseriesClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caches by direction and geometry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TimeseriesClient("http://ts");
    await client.fetch("POINT(1 2)", "asc");
    await client.fetch("POINT(1 2)", "asc");
    await client.fetch("POINT(1 2)", "desc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ wkt: "POINT(1 2)", flightDirection: "ASCENDING", polarization: "VV" });
  });

  it("does not retry the service's wrapped no-data 500", async () => {
    const detail = 'Failed to calculate timeseries. Original Exception: 400: No valid data found for wkt "POINT (1 2)"';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new TimeseriesClient("http://ts").fetch("POINT(1 2)", "asc")).rejects.toBeInstanceOf(NoDataError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("PickManager + chart preparation + CSV", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function twoPicks() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/frame_intersection")
          ? new Response(JSON.stringify({ "08882": "POINT (1 2)", "36268": "POINT (1 2)" }), { status: 200 })
          : new Response(JSON.stringify(fixture), { status: 200 }),
      ),
    );
    const { AsfClient } = await import("../src/services");
    let changes = 0;
    const m = new PickManager(new TimeseriesClient("http://ts"), new AsfClient("http://ts"), () => changes++);
    m.add({ type: "Point", coordinates: [1, 2] });
    m.add({ type: "Point", coordinates: [1.1, 2] });
    await vi.waitFor(() => expect(m.loading).toBe(false));
    return { m, changes };
  }

  it("loads both directions and flags other covering frames", async () => {
    const { m } = await twoPicks();
    const p = m.picks[0];
    expect(p.label).toBe("P1");
    expect(p.results.asc.status).toBe("ok");
    expect(p.results.asc.otherFrames).toEqual([36268]);
    expect(m.picks[0].color).not.toBe(m.picks[1].color);
  });

  it("relative series are zero against an identical reference and export to CSV", async () => {
    const { m } = await twoPicks();
    m.setReference(m.picks[0].id);
    const prepared = prepareSeries(m.picks, { showFit: true, reference: m.reference });
    expect(prepared.map((s) => s.pick.label)).toEqual(["P2", "P2"]);
    expect(prepared[0].points.every((pt) => Math.abs(pt.value) < 1e-12)).toBe(true);
    const csv = picksCsv(m.picks, m.reference as Pick);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("displacement_m");
    expect(lines).toHaveLength(1 + 2 * (Object.keys(fixture).length - 1));
    expect(lines[1]).toContain("P2,ascending,F08882,POINT(1.1 2),2016-10-09");
    expect(lines[1]).toContain(",asf,short_wavelength_displacement,");
    expect(lines[1].endsWith(".nc")).toBe(true);
    expect(lines[1]).toContain(",P1,");
  });

  it("drops the oldest pick beyond the limit and clears the reference with it", async () => {
    const { m } = await twoPicks();
    m.setReference(m.picks[0].id);
    for (let i = 0; i < 8; i++) m.add({ type: "Point", coordinates: [i, i] });
    expect(m.picks).toHaveLength(8);
    expect(m.referenceId).toBeNull();
  });

  it("toCsv quotes geometry with commas", () => {
    const series = parseTimeseries(fixture, "desc");
    const csv = toCsv([{ label: "A", wkt: "POLYGON((0 0,1 0,1 1,0 0))", series, points: series.points.slice(0, 1) }]);
    expect(csv.split("\n")[1]).toContain('"POLYGON((0 0,1 0,1 1,0 0))"');
  });
});
