/**
 * ASF /timeseries model: fetching (cached, cancellable), parsing, fitting,
 * reference subtraction and CSV export. No DOM here.
 *
 * Response shape (undocumented, read from the ASF portal frontend and measured in
 * Phase 0): an object keyed by granule file name, one entry per epoch, plus a
 * `mean` summary entry without dates. Values are short-wavelength LOS displacement
 * in metres, already re-referenced to the first reference date of the stack.
 */
import type { Direction } from "./state";

export interface TsPoint {
  /** Secondary (acquisition) time, epoch ms UTC. */
  t: number;
  /** Reference time of the epoch's ministack, epoch ms UTC (null if missing). */
  ref: number | null;
  /** Short-wavelength LOS displacement, metres. */
  value: number;
  granule: string;
}

export interface TsSeries {
  direction: Direction;
  frameId: number | null;
  points: TsPoint[];
  /** The service's `mean` entry (polygon/point summary), if present. */
  mean: Record<string, unknown> | null;
}

const FRAME_RE = /_F(\d{5})_/;
const NO_DATA_MARKERS = ["No valid data found", "No OPERA-S1 burst frame ids were found"];
const BUCKET = "asf-cumulus-prod-opera-products";
const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

export class NoDataError extends Error {}

/** Parse an ISO datetime without zone as UTC (the service omits the Z). */
function parseUtc(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(t) ? t : null;
}

export function parseTimeseries(json: Record<string, unknown>, direction: Direction): TsSeries {
  const points: TsPoint[] = [];
  const frames = new Map<number, number>();
  for (const [granule, entry] of Object.entries(json)) {
    if (!granule.endsWith(".nc") || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const t = parseUtc(e.secondary_datetime);
    const value = Number(e.short_wavelength_displacement);
    if (t === null || !Number.isFinite(value)) continue;
    points.push({ t, ref: parseUtc(e.reference_datetime), value, granule });
    const m = FRAME_RE.exec(granule);
    if (m) frames.set(Number(m[1]), (frames.get(Number(m[1])) ?? 0) + 1);
  }
  points.sort((a, b) => a.t - b.t);
  const frameId = [...frames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const mean = json.mean && typeof json.mean === "object" ? (json.mean as Record<string, unknown>) : null;
  return { direction, frameId, points, mean };
}

export class TimeseriesClient {
  private cache = new Map<string, TsSeries>();

  constructor(
    public baseUrl: string,
    private readonly maxCache = 30,
    private readonly retries = 3,
  ) {}

  async fetch(wkt: string, direction: Direction, signal?: AbortSignal): Promise<TsSeries> {
    const key = `${direction}|${wkt}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const series = await this.request(wkt, direction, signal);
        this.cache.set(key, series);
        if (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
        return series;
      } catch (e) {
        if (signal?.aborted || e instanceof NoDataError) throw e;
        lastError = e;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastError;
  }

  private async request(wkt: string, direction: Direction, signal?: AbortSignal): Promise<TsSeries> {
    const response = await fetch(`${this.baseUrl}/timeseries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wkt,
        bucket: BUCKET,
        polarization: "VV",
        flightDirection: direction === "asc" ? "ASCENDING" : "DESCENDING",
      }),
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = String(body.detail ?? response.statusText);
      // The service wraps "no data" in a 500; retrying will not help.
      if (NO_DATA_MARKERS.some((m) => detail.includes(m))) throw new NoDataError(friendlyNoData(detail));
      throw new Error(`${response.status}: ${detail}`);
    }
    const series = parseTimeseries(body, direction);
    if (!series.points.length) throw new NoDataError("No epochs returned for this location.");
    return series;
  }
}

function friendlyNoData(detail: string): string {
  if (detail.includes("No OPERA-S1 burst frame")) return "No OPERA frame covers this location.";
  return "No valid data at this location (masked in every epoch).";
}

/** Least-squares slope (m/yr) and intercept (m) of value against years since the first epoch. */
export function fitLinear(points: { t: number; value: number }[]): { slope: number; intercept: number; t0: number } | null {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / DAY_MS / YEAR_DAYS);
  const ys = points.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, t0 };
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Subtract a reference series on common acquisition dates (same direction): the
 * difference removes signal shared by both points (e.g. residual atmosphere,
 * reference drift). Epochs without a match are dropped.
 */
export function subtractReference(points: TsPoint[], reference: TsPoint[]): TsPoint[] {
  const ref = new Map(reference.map((p) => [dayKey(p.t), p.value]));
  return points.flatMap((p) => {
    const r = ref.get(dayKey(p.t));
    return r === undefined ? [] : [{ ...p, value: p.value - r }];
  });
}

type Geometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: string; coordinates?: unknown };

const fmt = (xy: number[]) => `${+xy[0].toFixed(6)} ${+xy[1].toFixed(6)}`;
const ringWkt = (ring: number[][]) => `(${ring.map(fmt).join(",")})`;

/** WKT for the geometries the ASF service accepts (point, polygon, multipolygon). */
export function geometryToWkt(geometry: Geometry | null | undefined): string | null {
  if (!geometry) return null;
  if (geometry.type === "Point") return `POINT(${fmt(geometry.coordinates as number[])})`;
  if (geometry.type === "Polygon") return `POLYGON(${(geometry.coordinates as number[][][]).map(ringWkt).join(",")})`;
  if (geometry.type === "MultiPolygon") {
    const polys = (geometry.coordinates as number[][][][]).map((p) => `(${p.map(ringWkt).join(",")})`);
    return `MULTIPOLYGON(${polys.join(",")})`;
  }
  return null;
}

/** A representative lon/lat for labelling (point, or mean of the outer ring). */
export function geometryAnchor(geometry: Geometry): [number, number] | null {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  const ring =
    geometry.type === "Polygon"
      ? (geometry.coordinates as number[][][])[0]
      : geometry.type === "MultiPolygon"
        ? (geometry.coordinates as number[][][][])[0]?.[0]
        : null;
  if (!ring?.length) return null;
  const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

export interface CsvSeries {
  label: string;
  wkt: string;
  series: TsSeries;
  referenceLabel?: string;
  points: TsPoint[];
  /** Fitted model (metres) and per-point usage, when a model is shown. */
  model?: (t: number) => number;
  used?: boolean[];
  /** "asf" (default) or "cube"; and the plotted variable. */
  source?: string;
  variable?: string;
}

const csvCell = (v: string | number) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));

/** One row per epoch; columns follow the ASF portal export plus direction, frame and reference. */
export function toCsv(rows: CsvSeries[]): string {
  const header = [
    "series",
    "direction",
    "frame",
    "geometry",
    "date",
    "reference_date",
    "source",
    "variable",
    "displacement_m",
    "relative_to",
    "model_m",
    "residual_m",
    "outlier",
    "source_file",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    r.points.forEach((p, i) => {
      const model = r.model ? r.model(p.t) : null;
      lines.push(
        [
          r.label,
          r.series.direction === "asc" ? "ascending" : "descending",
          r.series.frameId === null ? "" : `F${String(r.series.frameId).padStart(5, "0")}`,
          r.wkt,
          dayKey(p.t),
          p.ref === null ? "" : dayKey(p.ref),
          r.source ?? "asf",
          r.variable ?? "short_wavelength_displacement",
          p.value.toFixed(6),
          r.referenceLabel ?? "",
          model === null ? "" : model.toFixed(6),
          model === null ? "" : (p.value - model).toFixed(6),
          r.used ? (r.used[i] ? "" : "1") : "",
          p.granule,
        ]
          .map(csvCell)
          .join(","),
      );
    });
  }
  return `${lines.join("\n")}\n`;
}
