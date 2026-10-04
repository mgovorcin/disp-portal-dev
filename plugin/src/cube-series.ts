/** Time series from downloaded GeoZarr cubes, served by disp-proxy (/cubes/timeseries). */
import type { Direction } from "./state";
import type { TsPoint } from "./timeseries";

export type CubeVariable = "displacement" | "short_wavelength_displacement";

export interface CubeSeries {
  job_id: string;
  frame: number;
  direction: Direction;
  cube: string;
  crs: string;
  n_pixels: number;
  corrections: { solid_earth?: boolean; ionosphere?: boolean };
  time: string[];
  reference_time: (string | null)[];
  displacement?: (number | null)[];
  short_wavelength_displacement?: (number | null)[];
  velocity: number | null;
  velocity_stderr: number | null;
  coherence: number | null;
}

export interface CubeResult {
  status: "loading" | "ok" | "error";
  series: CubeSeries[];
  error?: string;
}

export class CubeClient {
  constructor(public baseUrl: string) {}

  async timeseries(geometry: unknown, signal?: AbortSignal): Promise<CubeSeries[]> {
    const r = await fetch(`${this.baseUrl}/cubes/timeseries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry }),
      signal,
    });
    const body = (await r.json().catch(() => ({}))) as { series?: CubeSeries[]; detail?: string };
    if (!r.ok) throw new Error(body.detail ?? r.statusText);
    return body.series ?? [];
  }
}

const parseUtc = (s: string | null) => (s ? Date.parse(/[zZ]$/.test(s) ? s : `${s}Z`) : NaN);

/** Chart points for one cube series (epochs with no valid pixel are dropped). */
export function cubePoints(series: CubeSeries, variable: CubeVariable): TsPoint[] {
  const values = series[variable] ?? series.displacement ?? [];
  const points: TsPoint[] = [];
  series.time.forEach((iso, i) => {
    const v = values[i];
    const t = parseUtc(iso);
    if (v === null || v === undefined || !Number.isFinite(t)) return;
    const ref = parseUtc(series.reference_time[i] ?? null);
    points.push({ t, ref: Number.isFinite(ref) ? ref : null, value: v, granule: `cube:${series.job_id}/${series.cube}` });
  });
  return points;
}

export function frameName(frame: number): string {
  return `F${String(frame).padStart(5, "0")}`;
}

/** Short description of a cube series' processing, e.g. "SET" or "SET+iono". */
export function correctionsLabel(c: CubeSeries["corrections"]): string {
  const parts = [c.solid_earth && "SET", c.ionosphere && "iono"].filter(Boolean);
  return parts.length ? parts.join("+") : "no corrections";
}
