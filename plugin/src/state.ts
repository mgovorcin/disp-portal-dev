/** Plugin settings, persisted in the GeoLibre project under plugins.settings["opera-disp"]. */

export type Direction = "asc" | "desc";

/** Time-series model settings (see fit.ts); steps as YYYY-MM-DD for readable project files. */
export interface FitSettings {
  polyOrder: 0 | 1 | 2 | 3;
  annual: boolean;
  semiannual: boolean;
  steps: string[];
  rejectOutliers: boolean;
}

export interface DispState {
  /** disp-proxy base URL (tiles, values, basemaps). */
  proxyUrl: string;
  /** ASF time-series API base URL (CORS *, called directly). */
  tsApiUrl: string;
  direction: Direction;
  opacity: number;
  visible: boolean;
  /** Basemap key from the proxy catalogue, or null to leave GeoLibre's basemap alone. */
  basemap: string | null;
  /** Draw the basemap's label overlay above the velocity layer. */
  labelsOnTop: boolean;
  showFrames: boolean;
  identify: boolean;
  /** Whether the plugin panel is expanded (saved with the project). */
  panelOpen: boolean;
  /** A map click also fetches the ASF time series at that point. */
  tsOnClick: boolean;
  /** Draw the fitted model through each time series. */
  showFit: boolean;
  /** Chart: hide the data points, keep the fitted model curves. */
  tsModelOnly: boolean;
  /** Chart: draw a legend inside the plot (kept in screenshots / PNG export). */
  tsLegend: boolean;
  /** Chart: per-series style overrides, keyed by the series label (e.g. "P1 asc"). */
  tsStyles: Record<string, SeriesStyle>;
  fit: FitSettings;
  /** Chart shows the data, or data minus the fitted model. */
  tsView: "data" | "residuals";
  /** Which time series to plot: ASF service, downloaded cubes, or both. */
  tsSource: "asf" | "cube" | "both";
  /** Cube variable plotted: full displacement or short-wavelength displacement. */
  cubeVariable: "displacement" | "short_wavelength_displacement";
}

/**
 * Where disp-proxy lives by default: the page's own origin when GeoLibre is served by the
 * proxy (self-hosted build), otherwise the usual local port (GeoLibre web or desktop).
 */
export function defaultProxyUrl(location: { origin: string; protocol: string; hostname: string } | undefined = globalThis.location): string {
  if (location && /^https?:$/.test(location.protocol) && !location.hostname.endsWith("geolibre.app")) {
    return location.origin;
  }
  return "http://localhost:8790";
}

export const DEFAULT_STATE: DispState = {
  proxyUrl: defaultProxyUrl(),
  tsApiUrl: "https://d2qmcvu7qty7vn.cloudfront.net",
  direction: "asc",
  opacity: 0.85,
  visible: true,
  // Sentinel-2 cloudless (EOX) in both the local and the GitHub Pages catalogue.
  basemap: "sentinel2",
  labelsOnTop: true,
  showFrames: true,
  identify: true,
  panelOpen: true,
  // Off by default: picking is explicit (map button or sidebar) so a stray click adds nothing.
  tsOnClick: false,
  showFit: true,
  tsModelOnly: false,
  tsLegend: true,
  tsStyles: {},
  fit: { polyOrder: 1, annual: false, semiannual: false, steps: [], rejectOutliers: false },
  tsView: "data",
  tsSource: "both",
  cubeVariable: "displacement",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const MARKER_SHAPES = ["circle", "ring", "square", "diamond", "triangle", "cross"] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];
export type LineDash = "solid" | "dashed" | "dotted";

/** Chart style of one series: data markers and its model (fit) line. Unset = default. */
export interface SeriesStyle {
  color?: string;
  marker?: MarkerShape;
  /** Marker size in CSS pixels. */
  size?: number;
  fitColor?: string;
  fitWidth?: number;
  fitDash?: LineDash;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Validate saved series styles (project file / localStorage); drops anything malformed. */
export function parseStyles(value: unknown): Record<string, SeriesStyle> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, SeriesStyle> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const s: SeriesStyle = {};
    if (typeof r.color === "string" && HEX.test(r.color)) s.color = r.color;
    if (typeof r.fitColor === "string" && HEX.test(r.fitColor)) s.fitColor = r.fitColor;
    if (MARKER_SHAPES.includes(r.marker as MarkerShape)) s.marker = r.marker as MarkerShape;
    if (typeof r.size === "number" && r.size >= 1 && r.size <= 20) s.size = r.size;
    if (typeof r.fitWidth === "number" && r.fitWidth >= 0.5 && r.fitWidth <= 8) s.fitWidth = r.fitWidth;
    if (r.fitDash === "solid" || r.fitDash === "dashed" || r.fitDash === "dotted") s.fitDash = r.fitDash;
    if (Object.keys(s).length) out[key.slice(0, 64)] = s;
  }
  return out;
}

export function parseFit(value: unknown): FitSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const order = Number(v.polyOrder);
  return {
    polyOrder: ([0, 1, 2, 3].includes(order) ? order : 1) as FitSettings["polyOrder"],
    annual: v.annual === true,
    semiannual: v.semiannual === true,
    steps: Array.isArray(v.steps)
      ? [...new Set(v.steps.filter((d): d is string => typeof d === "string" && ISO_DAY.test(d) && !Number.isNaN(Date.parse(d))))].sort().slice(0, 20)
      : [],
    rejectOutliers: v.rejectOutliers === true,
  };
}

/** Accept only well-typed fields from a saved project; ignore everything else. */
export function parseState(value: unknown): Partial<DispState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const out: Partial<DispState> = {};
  if (typeof v.proxyUrl === "string" && /^https?:\/\//.test(v.proxyUrl)) {
    out.proxyUrl = v.proxyUrl.replace(/\/+$/, "");
  }
  if (typeof v.tsApiUrl === "string" && /^https?:\/\//.test(v.tsApiUrl)) {
    out.tsApiUrl = v.tsApiUrl.replace(/\/+$/, "");
  }
  const dir = parseDirection(v.direction);
  if (dir) out.direction = dir;
  if (typeof v.opacity === "number" && v.opacity >= 0 && v.opacity <= 1) out.opacity = v.opacity;
  if (typeof v.basemap === "string" || v.basemap === null) out.basemap = v.basemap as string | null;
  for (const key of ["visible", "labelsOnTop", "showFrames", "identify", "panelOpen", "tsOnClick", "showFit", "tsModelOnly", "tsLegend"] as const) {
    if (typeof v[key] === "boolean") out[key] = v[key] as boolean;
  }
  const fit = parseFit(v.fit);
  if (fit) out.fit = fit;
  if (v.tsView === "data" || v.tsView === "residuals") out.tsView = v.tsView;
  const styles = parseStyles(v.tsStyles);
  if (styles) out.tsStyles = styles;
  if (v.tsSource === "asf" || v.tsSource === "cube" || v.tsSource === "both") out.tsSource = v.tsSource;
  if (v.cubeVariable === "displacement" || v.cubeVariable === "short_wavelength_displacement") out.cubeVariable = v.cubeVariable;
  return out;
}

export function parseDirection(value: unknown): Direction | null {
  if (typeof value !== "string") return null;
  const d = value.trim().toLowerCase();
  if (d === "asc" || d === "ascending" || d === "a") return "asc";
  if (d === "desc" || d === "descending" || d === "d") return "desc";
  return null;
}

/**
 * ASF portal compatible URL parameters: `?dispOverview=VEL&dir=asc`.
 * `dispOverview` turns the overview on (VEL) or off (anything else); only VEL exists.
 */
export function stateFromUrl(params: URLSearchParams): Partial<DispState> {
  const out: Partial<DispState> = {};
  const overview = params.get("dispOverview");
  if (overview !== null) out.visible = overview.toUpperCase() === "VEL";
  const dir = parseDirection(params.get("dir"));
  if (dir) out.direction = dir;
  const proxy = params.get("dispProxy");
  if (proxy && /^https?:\/\//.test(proxy)) out.proxyUrl = proxy.replace(/\/+$/, "");
  return out;
}
