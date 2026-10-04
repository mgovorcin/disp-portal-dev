/** HTTP clients for disp-proxy and the ASF time-series API. */
import type { Direction } from "./state";

export interface ExtentInfo {
  scale_range: { range: [number, number]; units: string };
  tile_date: string | null;
  quantization: number;
  legend_colors: string[];
}

export interface ValueResult {
  value: number | null;
  clipped: boolean;
  units: string;
  tile_date: string | null;
}

export interface Basemap {
  key: string;
  name: string;
  attribution: string;
  maxzoom: number;
  tiles: string[];
  labels: string[] | null;
  style_url: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (body as { detail?: string }).detail ?? response.statusText;
    throw new Error(`${response.status}: ${detail}`);
  }
  return body as T;
}

export interface AnalyzeResponse {
  results: import("./analysis").AnalyzeStats[];
  tile_date?: string | null;
}

export class ProxyClient {
  constructor(public baseUrl: string) {}

  tileTemplate(direction: Direction): string {
    return `${this.baseUrl}/tiles/${direction}/vel/{z}/{x}/{y}.png`;
  }

  extent(direction: Direction): Promise<ExtentInfo> {
    return getJson(`${this.baseUrl}/extent/${direction}/vel`);
  }

  value(lon: number, lat: number, direction: Direction, signal?: AbortSignal): Promise<ValueResult> {
    const q = new URLSearchParams({ lon: String(lon), lat: String(lat), dir: direction });
    return getJson(`${this.baseUrl}/value?${q}`, { signal });
  }

  /** Velocity statistics for many features (one request; the caller chunks large layers). */
  analyze(
    features: unknown[],
    direction: Direction,
    options: { absThreshold?: number; stepM?: number; source?: "asf" | "cube" },
    signal?: AbortSignal,
  ): Promise<AnalyzeResponse> {
    const endpoint = options.source === "cube" ? "/cubes/analyze" : "/analyze";
    return getJson(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features,
        direction,
        abs_threshold: options.absThreshold,
        step_m: options.stepM ?? 30,
      }),
      signal,
    });
  }

  basemaps(): Promise<Basemap[]> {
    return getJson(`${this.baseUrl}/basemaps`);
  }

  async health(): Promise<boolean> {
    try {
      await getJson(`${this.baseUrl}/health`);
      return true;
    } catch {
      return false;
    }
  }
}

export class AsfClient {
  constructor(public baseUrl: string) {}

  /** `{frame_id: WKT clipped to the query geometry}` for frames covering `wkt`. */
  frameIntersection(wkt: string, direction: Direction, signal?: AbortSignal): Promise<Record<string, string>> {
    return getJson(`${this.baseUrl}/frame_intersection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wkt, flightDirection: direction === "asc" ? "ascending" : "descending" }),
      signal,
    });
  }
}

export function bboxToWkt([w, s, e, n]: [number, number, number, number]): string {
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}
