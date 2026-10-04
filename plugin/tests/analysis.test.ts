import {
  buildRows,
  featureName,
  geometryBounds,
  isAnalyzable,
  rowsToCsv,
  toResultCollection,
  type InputFeature,
} from "../src/analysis";
import { pickGeometryFor } from "../src/analysis-panel";
import { DispController } from "../src/controller";
import type { GeoLibreAppAPI } from "../src/host-api";

const poly: InputFeature = {
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]] },
  properties: { NAME: "Levee A", keep: 1 },
};
const point: InputFeature = { type: "Feature", id: 7, geometry: { type: "Point", coordinates: [1, 1] }, properties: {} };
const line: InputFeature = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1], [2, 2]] },
  properties: { OBJECTID: 3 },
};
const opts = { thresholdMm: 5, stepM: 30, minValidPct: 25, directions: ["asc", "desc"] as ("asc" | "desc")[] };

describe("analysis model", () => {
  it("names features from common attribute keys", () => {
    expect(featureName(poly, 0)).toBe("Levee A");
    expect(featureName(point, 4)).toBe("7");
    expect(featureName(line, 1)).toBe("OBJECTID 3");
    expect(featureName({ geometry: null }, 2)).toBe("#3");
    expect(isAnalyzable({ geometry: null })).toBe(false);
  });

  it("builds rows, hotspots and attributes in mm/yr", () => {
    const rows = buildRows([poly, point], {
      asc: [{ median: -0.0071, mean: -0.007, p5: -0.012, p95: -0.002, valid_fraction: 0.95, fraction_abs_exceeding: 0.6 }, { median: 0.001, valid_fraction: 1 }],
      desc: [{ median: -0.0042, valid_fraction: 0.9 }, { error: "no data" }],
    }, opts);
    expect(rows[0].hotspot).toEqual(["asc"]);
    expect(rows[0].maxAbsMedianMm).toBeCloseTo(7.1, 6);
    expect(rows[1].hotspot).toEqual([]);
    const fc = toResultCollection(rows, opts);
    const p0 = fc.features[0].properties as Record<string, unknown>;
    expect(p0).toMatchObject({ NAME: "Levee A", keep: 1, asc_median_mmyr: -7.1, asc_p5_mmyr: -12, asc_exceed_pct: 60, asc_valid_pct: 95, hotspot: "asc" });
    const p1 = fc.features[1].properties as Record<string, unknown>;
    expect(p1.asc_vel_mmyr).toBe(1);
    expect(p1.desc_error).toBe("no data");
    expect(fc.features[1]).toHaveProperty("id", 7);
  });

  it("exports CSV and computes bounds", () => {
    const rows = buildRows([poly], { asc: [{ median: -0.006, valid_fraction: 1 }], desc: [{ median: 0.002, valid_fraction: 1 }] }, opts);
    const csv = rowsToCsv(rows, opts).trim().split("\n");
    expect(csv[0].split(",")).toContain("asc_median_mmyr");
    expect(csv[1]).toContain("Levee A,Polygon,-6");
    expect(geometryBounds(poly.geometry)).toEqual([0, 0, 2, 1]);
  });

  it("does not rank or flag directions with too few valid pixels", () => {
    const rows = buildRows([poly], { asc: [{ median: -0.0106, valid_fraction: 0.08 }], desc: [{ median: -0.002, valid_fraction: 0.9 }] }, opts);
    expect(rows[0].hotspot).toEqual([]);
    expect(rows[0].lowCoverage).toEqual(["asc"]);
    expect(rows[0].maxAbsMedianMm).toBeCloseTo(2, 6);
    const props = toResultCollection(rows, opts).features[0].properties as Record<string, unknown>;
    expect(props.low_coverage).toBe("asc");
    expect(props.asc_median_mmyr).toBe(-10.6);
  });

  it("needs |median| >= 2 sigma for a hotspot when the cube gives a sigma", () => {
    const cubeOpts = { ...opts, source: "cube" as const };
    const rows = buildRows([poly, point], {
      asc: [{ median: 0.0092, stderr_median: 0.0133, valid_fraction: 0.9 }, { median: -0.008, stderr_median: 0.001, valid_fraction: 1 }],
      desc: [{ error: "no downloaded desc cube covers this feature" }, { error: "no downloaded desc cube covers this feature" }],
    }, cubeOpts);
    expect(rows[0].hotspot).toEqual([]);
    expect(rows[0].notSignificant).toEqual(["asc"]);
    expect(rows[1].hotspot).toEqual(["asc"]);
    const p = toResultCollection(rows, cubeOpts).features[1].properties as Record<string, unknown>;
    expect(p.asc_stderr_mmyr).toBe(1);
    expect(String(p.vel_source)).toMatch(/downloaded/);
  });

  it("turns rows into time-series picks (lines use their midpoint)", () => {
    const rows = buildRows([poly, point, line], {}, { ...opts, directions: [] });
    expect(pickGeometryFor(rows[0])?.type).toBe("Polygon");
    expect(pickGeometryFor(rows[1])).toEqual({ type: "Point", coordinates: [1, 1] });
    expect(pickGeometryFor(rows[2])).toEqual({ type: "Point", coordinates: [1, 1] });
  });
});

describe("DispController.analyze", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads a layer, calls /analyze per direction and adds a result layer", async () => {
    const calls: { direction: string; n: number }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ direction: body.direction, n: body.features.length });
        return new Response(
          JSON.stringify({ results: body.features.map(() => ({ median: body.direction === "asc" ? -0.008 : -0.001, n_valid: 3, valid_fraction: 1 })), tile_date: null }),
          { status: 200 },
        );
      }),
    );
    const added: { name: string; data: any }[] = [];
    const styled: { id: string; style: any }[] = [];
    const app: GeoLibreAppAPI = {
      listLayers: () => [
        { id: "wells", name: "Wells", type: "geojson", visible: true, opacity: 1 },
        { id: "opera-disp-velocity", name: "OPERA", type: "raster", visible: true, opacity: 1 },
      ],
      getLayerFeatures: () => [point as any, { type: "Feature", geometry: null, properties: {} }, poly as any],
      addGeoJsonLayer: (name, data) => {
        added.push({ name, data });
        return `layer-${added.length}`;
      },
      importLayerStyle: (id, text) => {
        styled.push({ id, style: JSON.parse(text) });
        return { ok: true, warnings: [] };
      },
    };
    const c = new DispController(app);
    expect(c.analyzableLayers()).toEqual([{ id: "wells", name: "Wells" }]);
    const messages: string[] = [];
    c.subscribe({ onAnalysis: (_a, m) => messages.push(m) });
    const result = await c.analyze("wells", opts);
    expect(calls).toEqual([{ direction: "asc", n: 2 }, { direction: "desc", n: 2 }]);
    expect(result?.rows).toHaveLength(2);
    expect(result?.skipped).toBe(1);
    expect(result?.resultLayerId).toBe("layer-1");
    expect(result?.hotspotLayerId).toBe("layer-2");
    expect(added[0].name).toBe("Wells · OPERA velocity");
    expect(added[0].data.features[0].properties.asc_vel_mmyr).toBe(-8);
    expect(messages.at(-1)).toMatch(/2 feature\(s\) analysed; 2 hotspot\(s\) with \|median\| ≥ 5 mm\/yr; 1 skipped/);
    // result layer + hotspot layer, both styled
    expect(added.map((a) => a.name)).toEqual(["Wells · OPERA velocity", "Wells · hotspots ≥ 5 mm/yr"]);
    expect(styled).toHaveLength(2);
    expect(added[0].data.features[0].properties.vel_mmyr).toBe(-8);
  });

  it("says what the largest value was when nothing reaches the threshold", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: body.features.map(() => ({ median: -0.0021, valid_fraction: 1 })) }), { status: 200 });
    }));
    const added: string[] = [];
    const app: GeoLibreAppAPI = {
      listLayers: () => [{ id: "w", name: "Wells", type: "geojson", visible: true, opacity: 1 }],
      getLayerFeatures: () => [point as any],
      addGeoJsonLayer: (name) => (added.push(name), "x"),
      importLayerStyle: () => ({ ok: true, warnings: [] }),
    };
    const c = new DispController(app);
    const messages: string[] = [];
    c.subscribe({ onAnalysis: (_a, m) => messages.push(m) });
    await c.analyze("w", opts);
    expect(messages.at(-1)).toMatch(/0 hotspot\(s\).*largest: 2\.1 mm\/yr at “7”; lower the threshold/);
    expect(added).toEqual(["Wells · OPERA velocity"]);
  });

  it("analyses drawn shapes and explains when nothing is drawn", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: body.features.map(() => ({ median: 0.012, valid_fraction: 0.9 })) }), { status: 200 });
    }));
    let drawn: any[] = [];
    const app: GeoLibreAppAPI = { getDrawnFeatures: () => drawn, addGeoJsonLayer: () => "x", importLayerStyle: () => ({ ok: true, warnings: [] }) };
    const c = new DispController(app);
    const messages: string[] = [];
    c.subscribe({ onAnalysis: (_a, m) => messages.push(m) });
    expect(await c.analyze("drawn", opts)).toBeNull();
    expect(messages.at(-1)).toMatch(/nothing is drawn yet/);
    drawn = [poly];
    const r = await c.analyze("drawn", opts);
    expect(r?.sourceName).toBe("Drawn shapes");
    expect(r?.rows[0].hotspot).toEqual(["asc", "desc"]);
  });

  it("explains an empty layer", async () => {
    const app: GeoLibreAppAPI = { listLayers: () => [], getLayerFeatures: () => [] };
    const c = new DispController(app);
    const messages: string[] = [];
    c.subscribe({ onAnalysis: (_a, m) => messages.push(m) });
    expect(await c.analyze("x", opts)).toBeNull();
    expect(messages.at(-1)).toMatch(/no features GeoLibre can read/);
  });
});
