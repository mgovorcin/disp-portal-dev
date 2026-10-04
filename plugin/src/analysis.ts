/**
 * Velocity analysis of a user's vector layer against the ASF overview (via disp-proxy /analyze).
 *
 * Points get the pixel value, lines are sampled along their length, polygons get zonal
 * statistics of all zoom-12 pixels inside. Results are copied onto the features as
 * attributes (mm/yr) so the new layer can be styled, filtered and exported in GeoLibre.
 */
import type { Direction } from "./state";

export interface AnalyzeStats {
  geometry_type?: string;
  n_pixels?: number;
  n_valid?: number;
  mean?: number;
  median?: number;
  std?: number;
  min?: number;
  max?: number;
  p5?: number;
  p95?: number;
  fraction_abs_exceeding?: number;
  valid_fraction?: number;
  /** Downloaded-cube analysis only: median formal 1-sigma of the velocity (m/yr) and the cube used. */
  stderr_median?: number | null;
  cube?: { job_id: string; frame: number; path: string; time_range: string[]; n_epochs: number; corrections?: Record<string, boolean> };
  error?: string;
}

export interface InputFeature {
  type?: string;
  id?: string | number;
  geometry: { type: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface AnalysisOptions {
  /** Hotspot threshold on |velocity|, mm/yr. */
  thresholdMm: number;
  /** Sampling step along lines, metres. */
  stepM: number;
  directions: Direction[];
  /** A direction counts towards a hotspot only with at least this share of valid pixels (%). */
  minValidPct: number;
  /** Velocity source: ASF overview tiles (default) or downloaded GeoZarr cubes. */
  source?: "asf" | "cube";
}

/** With a formal σ (cubes), a hotspot also needs |median| ≥ SIGNIFICANCE_K · σ. */
export const SIGNIFICANCE_K = 2;

export interface AnalysisRow {
  index: number;
  name: string;
  geometryType: string;
  feature: InputFeature;
  stats: Partial<Record<Direction, AnalyzeStats>>;
  /** Largest |median| over the directions, mm/yr (null when no valid pixel). */
  maxAbsMedianMm: number | null;
  /** Signed median (mm/yr) of the direction with the largest |median| and enough coverage. */
  repMedianMm: number | null;
  /** Directions in which |median| >= threshold (and coverage is sufficient). */
  hotspot: Direction[];
  /** Directions whose valid-pixel share is below the minimum. */
  lowCoverage: Direction[];
  /** Directions above the threshold but not significant (|median| < 2σ). */
  notSignificant: Direction[];
}

export const ANALYZE_CHUNK = 500;
const NAME_KEYS = ["name", "NAME", "Name", "label", "LABEL", "title", "id", "ID", "OBJECTID", "fid", "FID"];

export function featureName(feature: InputFeature, index: number): string {
  for (const key of NAME_KEYS) {
    const v = feature.properties?.[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
    if (typeof v === "number") return `${key} ${v}`;
  }
  return feature.id !== undefined ? String(feature.id) : `#${index + 1}`;
}

const SUPPORTED = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

export function isAnalyzable(feature: InputFeature): boolean {
  return Boolean(feature.geometry && SUPPORTED.has(feature.geometry.type));
}

const mm = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100000) / 100);
const pct = (v: number | undefined) => (v === undefined ? null : Math.round(v * 1000) / 10);

/** Build result rows from per-direction /analyze results (aligned with `features`). */
export function buildRows(
  features: InputFeature[],
  results: Partial<Record<Direction, AnalyzeStats[]>>,
  options: AnalysisOptions,
): AnalysisRow[] {
  return features.map((feature, index) => {
    const stats: Partial<Record<Direction, AnalyzeStats>> = {};
    for (const d of options.directions) stats[d] = results[d]?.[index] ?? { error: "no result" };
    const covered = (d: Direction) => (stats[d]?.valid_fraction ?? 0) * 100 >= options.minValidPct;
    const significant = (d: Direction, m: number) => {
      const sigma = stats[d]?.stderr_median;
      return sigma === null || sigma === undefined || Math.abs(m) >= SIGNIFICANCE_K * sigma;
    };
    const lowCoverage = options.directions.filter((d) => stats[d]?.median !== undefined && !covered(d));
    // Ranking and hotspots use only directions with enough valid pixels: a polygon that is
    // mostly water or masked would otherwise be ranked on a handful of noisy pixels.
    const medians = options.directions
      .filter(covered)
      .map((d) => [d, stats[d]?.median] as const)
      .filter((x): x is readonly [Direction, number] => x[1] !== undefined);
    const maxAbs = medians.length ? Math.max(...medians.map(([, m]) => Math.abs(m) * 1000)) : null;
    const rep = medians.length ? medians.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))[1] * 1000 : null;
    return {
      index,
      name: featureName(feature, index),
      geometryType: feature.geometry?.type ?? "none",
      feature,
      stats,
      maxAbsMedianMm: maxAbs === null ? null : Math.round(maxAbs * 100) / 100,
      repMedianMm: rep === null ? null : Math.round(rep * 100) / 100,
      hotspot: medians.filter(([d, m]) => Math.abs(m) * 1000 >= options.thresholdMm && significant(d, m)).map(([d]) => d),
      lowCoverage,
      notSignificant: medians.filter(([d, m]) => Math.abs(m) * 1000 >= options.thresholdMm && !significant(d, m)).map(([d]) => d),
    };
  });
}

/** Attribute names written onto the features (prefixed by direction). */
export function velocityProperties(row: AnalysisRow, options: AnalysisOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const point = row.geometryType === "Point";
  for (const d of options.directions) {
    const s = row.stats[d] ?? {};
    if (point) {
      out[`${d}_vel_mmyr`] = mm(s.median);
    } else {
      out[`${d}_median_mmyr`] = mm(s.median);
      out[`${d}_mean_mmyr`] = mm(s.mean);
      out[`${d}_p5_mmyr`] = mm(s.p5);
      out[`${d}_p95_mmyr`] = mm(s.p95);
      out[`${d}_exceed_pct`] = pct(s.fraction_abs_exceeding);
      out[`${d}_valid_pct`] = pct(s.valid_fraction);
    }
    if (s.stderr_median !== undefined) out[`${d}_stderr_mmyr`] = mm(s.stderr_median ?? undefined);
    if (s.cube) out[`${d}_frame`] = `F${String(s.cube.frame).padStart(5, "0")}`;
    if (s.error) out[`${d}_error`] = s.error;
  }
  out.max_abs_median_mmyr = row.maxAbsMedianMm;
  out.vel_mmyr = row.repMedianMm;
  out.hotspot = row.hotspot.length ? row.hotspot.join("+") : "";
  out.low_coverage = row.lowCoverage.length ? row.lowCoverage.join("+") : "";
  if (row.notSignificant.length) out.not_significant = row.notSignificant.join("+");
  out.vel_source =
    options.source === "cube"
      ? "downloaded OPERA DISP-S1 cubes (least-squares velocity of full displacement)"
      : "ASF overview (short-wavelength, 0.24 mm/yr steps, clipped ±30 mm/yr)";
  return out;
}

/** GeoJSON FeatureCollection with the original attributes plus velocity attributes. */
export function toResultCollection(rows: AnalysisRow[], options: AnalysisOptions) {
  return {
    type: "FeatureCollection" as const,
    features: rows.map((row) => ({
      type: "Feature" as const,
      ...(row.feature.id !== undefined ? { id: row.feature.id } : {}),
      geometry: row.feature.geometry,
      properties: { ...(row.feature.properties ?? {}), ...velocityProperties(row, options) },
    })),
  };
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the analysis table (one row per feature, without geometry). */
export function rowsToCsv(rows: AnalysisRow[], options: AnalysisOptions): string {
  const props = rows.map((r) => ({ feature: r.name, geometry_type: r.geometryType, ...velocityProperties(r, options) }));
  const columns = [...new Set(props.flatMap((p) => Object.keys(p)))];
  return [columns.join(","), ...props.map((p) => columns.map((c) => csvCell((p as Record<string, unknown>)[c])).join(","))].join("\n") + "\n";
}

/** Graduated classes for `vel_mmyr` (mm/yr): blue = away from / red = towards the satellite. */
export const VELOCITY_CLASSES: { min: number; color: string; label: string }[] = [
  { min: -9999, color: "#bdbdbd", label: "no data" },
  { min: -999, color: "#08306b", label: "≤ −10" },
  { min: -10, color: "#2171b5", label: "−10 … −5" },
  { min: -5, color: "#9ecae1", label: "−5 … −2" },
  { min: -2, color: "#e0e0e0", label: "−2 … +2" },
  { min: 2, color: "#fcae91", label: "+2 … +5" },
  { min: 5, color: "#de2d26", label: "+5 … +10" },
  { min: 10, color: "#67000d", label: "≥ +10" },
];

/** Mapbox GL style (as GeoLibre imports it) colouring features by `vel_mmyr`. */
export function velocityStyle(): string {
  const [first, ...rest] = VELOCITY_CLASSES;
  // Missing values fall back to -9999 -> the "no data" class.
  const color = ["step", ["to-number", ["get", "vel_mmyr"], first.min], first.color, ...rest.flatMap((c) => [c.min, c.color])];
  return JSON.stringify({
    version: 8,
    sources: {},
    layers: [
      { id: "fill", type: "fill", paint: { "fill-color": color, "fill-opacity": 0.6 } },
      { id: "line", type: "line", paint: { "line-color": color, "line-width": 2 } },
      { id: "circle", type: "circle", paint: { "circle-color": color, "circle-radius": 7, "circle-stroke-color": "#222222", "circle-stroke-width": 1 } },
    ],
  });
}

/** Style for the hotspot layer: thick red outlines, light fill. */
export function hotspotStyle(): string {
  return JSON.stringify({
    version: 8,
    sources: {},
    layers: [
      { id: "fill", type: "fill", paint: { "fill-color": "#d62728", "fill-opacity": 0.15 } },
      { id: "line", type: "line", paint: { "line-color": "#d62728", "line-width": 4 } },
      { id: "circle", type: "circle", paint: { "circle-color": "#ffffff", "circle-radius": 10, "circle-stroke-color": "#d62728", "circle-stroke-width": 4 } },
    ],
  });
}

/** [west, south, east, north] of a GeoJSON geometry. */
export function geometryBounds(geometry: InputFeature["geometry"]): [number, number, number, number] | null {
  if (!geometry) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geometry.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
