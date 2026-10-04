import { COG_STYLE, COMBINED_ORDER, JobsClient, combinedSummary, addCubeToMap, addGeoTiffToMap, bboxPolygon, firstPolygon, polygonAreaKm2, type Job } from "../src/downloads";
import type { GeoLibreAppAPI } from "../src/host-api";

describe("download helpers", () => {
  it("computes polygon area close to the geodesic value", () => {
    // 0.02 x 0.02 degree box near Houston: ~4.3 km² (proxy computes 4.29 with pyproj)
    expect(polygonAreaKm2(bboxPolygon([-95.39, 29.75, -95.37, 29.77]))).toBeCloseTo(4.29, 1);
    expect(polygonAreaKm2({ type: "Point", coordinates: [0, 0] })).toBe(0);
  });

  it("picks the first polygon feature", () => {
    const poly = bboxPolygon([0, 0, 1, 1]);
    expect(firstPolygon([{ geometry: { type: "Point", coordinates: [0, 0] } }, { geometry: poly }])).toBe(poly);
    expect(firstPolygon([{ geometry: null }])).toBeNull();
  });
});

describe("JobsClient and map loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts job requests and reports server errors", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ detail: "area is 9,000 km², limit is 2,500 km²" }), { status: 422 })
        : new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const c = new JobsClient("http://p");
    await expect(c.create({ bbox: [0, 0, 1, 1], directions: ["asc"], apply_solid_earth: true, apply_ionosphere: false })).rejects.toThrow(/limit is 2,500/);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ bbox: [0, 0, 1, 1], directions: ["asc"] });
    expect(await c.list()).toEqual([]);
    expect(c.fileUrl("j1", "out/F08882_asc.zarr/0")).toBe("http://p/jobs/j1/files/out/F08882_asc.zarr/0");
  });

  it("adds a cube's velocity as a GeoLibre Zarr layer with its CRS and bounds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ attributes: { "proj:code": "EPSG:32615", "spatial:bbox": [1, 2, 3, 4] } }), { status: 200 })),
    );
    const calls: unknown[][] = [];
    const app: GeoLibreAppAPI = { addZarrLayer: async (...args) => (calls.push(args), "z1") };
    const job: Job = { id: "j1", state: "done", request: { start: "2023-01-01", end: "2023-03-31" } };
    const id = await addCubeToMap(app, new JobsClient("http://p"), job, { frame: 8882, direction: "asc", state: "done", cube: "out/F08882_asc.zarr" }, ["#000", "#fff"]);
    expect(id).toBe("z1");
    const [name, url, opts] = calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe("F08882 asc velocity (2023-01-01…2023-03-31)");
    expect(url).toBe("http://p/jobs/j1/files/out/F08882_asc.zarr/0");
    expect(opts).toMatchObject({ variable: "velocity", selector: {}, crs: "EPSG:32615", bounds: [1, 2, 3, 4], zarrVersion: 3, clim: [-0.03, 0.03] });
  });
});

describe("GeoTIFF layers", () => {
  it("adds a velocity COG with the blue-to-red stretch", async () => {
    const calls: unknown[][] = [];
    const app: GeoLibreAppAPI = { addCogLayer: async (...args) => (calls.push(args), "c1") };
    const job: Job = { id: "j1", state: "done" };
    const frame = { frame: 8882, direction: "asc" as const, state: "done" };
    await addGeoTiffToMap(app, new JobsClient("http://p"), job, frame, { path: "out/F08882_asc_velocity.tif", kind: "velocity" });
    const [name, url, opts] = calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe("F08882 asc velocity (COG)");
    expect(url).toBe("http://p/jobs/j1/files/out/F08882_asc_velocity.tif");
    expect(opts).toMatchObject({ bands: "1", colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03 });
    expect(COG_STYLE.coherence.rescaleMax).toBe(1);
  });

  it("adds a combined (job-level) COG named after the job", async () => {
    const calls: unknown[][] = [];
    const app: GeoLibreAppAPI = { addCogLayer: async (...args) => (calls.push(args), "c2") };
    const job: Job = { id: "j2", state: "done", request: { title: "Houston" } };
    await addGeoTiffToMap(app, new JobsClient("http://p"), job, null, { path: "out/combined/vertical_velocity.tif", kind: "vertical_velocity" });
    const [name, url, opts] = calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe("Houston combined vertical (COG)");
    expect(url).toBe("http://p/jobs/j2/files/out/combined/vertical_velocity.tif");
    expect(opts).toMatchObject({ colormap: "coolwarm", rescaleMin: -0.03 });
    for (const kind of COMBINED_ORDER) expect(COG_STYLE[kind]).toBeDefined();
    expect(COG_STYLE.vertical_velocity_sigma.colormap).toBe("viridis");
  });
});

describe("combined summary", () => {
  it("describes merge offsets and the decomposition", () => {
    const text = combinedSummary({
      merge: {
        asc: [{ frame: 8882, offset_m_yr: 0, overlap_pixels: null, role: "reference" }],
        desc: [
          { frame: 38238, offset_m_yr: 0, overlap_pixels: null, role: "reference" },
          { frame: 38239, offset_m_yr: 0.0021, overlap_pixels: 900, role: "aligned" },
          { frame: 38240, offset_m_yr: null, overlap_pixels: 0, role: "no valid pixels in area" },
        ],
      },
      decomposition: { valid_fraction: 0.896, vertical_median_m_yr: -0.0042, assumption: "north component neglected" },
    });
    expect(text).toContain("asc: F8882 ref");
    expect(text).toContain("F38239 2.1 mm/yr offset (900 px)");
    expect(text).toContain("F38240 no valid pixels in area");
    expect(text).toContain("vertical/east on 90% of the area, vertical median -4.2 mm/yr");
    expect(combinedSummary({ decomposition: { error: "needs both ascending and descending frames" } })).toBe(
      "vertical/east: needs both ascending and descending frames",
    );
  });
});
