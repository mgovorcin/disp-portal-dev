/** Time-series picks: points or polygons with their ascending/descending series. */
import type { CubeClient, CubeResult } from "./cube-series";
import type { AsfClient } from "./services";
import type { Direction } from "./state";
import {
  NoDataError,
  type TimeseriesClient,
  type TsSeries,
  geometryAnchor,
  geometryToWkt,
} from "./timeseries";

export const MAX_PICKS = 8;
/** Distinct, colour-blind-friendlier palette (Tableau 10 order). */
export const PICK_COLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#edc948", "#9c755f"];

export type PickGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface DirectionResult {
  status: "loading" | "ok" | "error";
  series?: TsSeries;
  error?: string;
  /** Frames that also cover the pick but were not used by the service. */
  otherFrames?: number[];
}

export interface Pick {
  id: number;
  label: string;
  color: string;
  geometry: PickGeometry;
  wkt: string;
  anchor: [number, number];
  results: Record<Direction, DirectionResult>;
  /** Series from downloaded GeoZarr cubes covering the pick (empty when none). */
  cube: CubeResult;
}

/** What is saved with the project for each pick (series are re-fetched on restore). */
export interface SavedPick {
  label: string;
  geometry: PickGeometry;
}

/** Validate saved picks from a project file; drops anything malformed. */
export function parseSavedPicks(value: unknown): SavedPick[] {
  if (!Array.isArray(value)) return [];
  const isPos = (p: unknown) => Array.isArray(p) && p.length >= 2 && p.every((x) => typeof x === "number" && Number.isFinite(x));
  const isRing = (r: unknown) => Array.isArray(r) && r.length >= 4 && r.every(isPos);
  const ok = (g: { type?: unknown; coordinates?: unknown }) =>
    (g.type === "Point" && isPos(g.coordinates)) ||
    (g.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(isRing)) ||
    (g.type === "MultiPolygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0 &&
      g.coordinates.every((p: unknown) => Array.isArray(p) && p.length > 0 && p.every(isRing)));
  return value
    .filter((v): v is SavedPick => {
      if (!v || typeof v !== "object") return false;
      const s = v as { label?: unknown; geometry?: { type?: unknown; coordinates?: unknown } };
      return typeof s.label === "string" && !!s.geometry && ok(s.geometry);
    })
    .slice(0, MAX_PICKS)
    .map((v) => ({ label: v.label.slice(0, 24), geometry: v.geometry }));
}

export class PickManager {
  picks: Pick[] = [];
  referenceId: number | null = null;
  private counter = 0;
  private aborts = new Map<number, AbortController>();

  constructor(
    private ts: TimeseriesClient,
    private asf: AsfClient,
    private readonly onChange: () => void,
    private cube: CubeClient | null = null,
  ) {}

  setClients(ts: TimeseriesClient, asf: AsfClient, cube: CubeClient | null = this.cube): void {
    this.ts = ts;
    this.asf = asf;
    this.cube = cube;
  }

  /** Add a pick and fetch both directions. Returns null for unsupported geometry. */
  add(geometry: PickGeometry, label?: string): Pick | null {
    const wkt = geometryToWkt(geometry);
    const anchor = geometryAnchor(geometry);
    if (!wkt || !anchor) return null;
    while (this.picks.length >= MAX_PICKS) this.remove(this.picks[0].id);
    this.counter += 1;
    const used = new Set(this.picks.map((p) => p.color));
    const pick: Pick = {
      id: this.counter,
      label: label ?? this.nextLabel(),
      color: PICK_COLORS.find((c) => !used.has(c)) ?? PICK_COLORS[this.counter % PICK_COLORS.length],
      geometry,
      wkt,
      anchor,
      results: { asc: { status: "loading" }, desc: { status: "loading" } },
      cube: { status: this.cube ? "loading" : "ok", series: [] },
    };
    this.picks.push(pick);
    this.onChange();
    void this.load(pick);
    return pick;
  }

  private async load(pick: Pick): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(pick.id, controller);
    const cubeTask = this.cube
      ? this.cube
          .timeseries(pick.geometry, controller.signal)
          .then((series) => {
            pick.cube = { status: "ok", series };
          })
          .catch((e: Error) => {
            if (!controller.signal.aborted) pick.cube = { status: "error", series: [], error: e.message };
          })
          .finally(() => !controller.signal.aborted && this.onChange())
      : Promise.resolve();
    await Promise.all([
      cubeTask,
      ...(["asc", "desc"] as Direction[]).map(async (direction) => {
        try {
          const [series, frames] = await Promise.all([
            this.ts.fetch(pick.wkt, direction, controller.signal),
            this.asf.frameIntersection(pick.wkt, direction, controller.signal).catch(() => ({})),
          ]);
          const covering = Object.keys(frames).map(Number);
          pick.results[direction] = {
            status: "ok",
            series,
            otherFrames: covering.filter((f) => f !== series.frameId).sort((a, b) => a - b),
          };
        } catch (e) {
          if (controller.signal.aborted) return;
          pick.results[direction] = {
            status: "error",
            error: e instanceof NoDataError ? e.message : `Time series failed: ${(e as Error).message}`,
          };
        }
        this.onChange();
      }),
    ]);
    this.aborts.delete(pick.id);
  }

  remove(id: number): void {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    this.picks = this.picks.filter((p) => p.id !== id);
    if (this.referenceId === id) this.referenceId = null;
    this.onChange();
  }

  clear(): void {
    for (const c of this.aborts.values()) c.abort();
    this.aborts.clear();
    this.picks = [];
    this.referenceId = null;
    this.onChange();
  }

  /** "P<n>" not used by any current pick (restored picks keep their saved labels). */
  private nextLabel(): string {
    const used = new Set(this.picks.map((p) => p.label));
    let n = this.counter;
    while (used.has(`P${n}`)) n += 1;
    return `P${n}`;
  }

  /** Picks and reference as saved with the project. */
  toSaved(): { picks: SavedPick[]; reference: string | null } {
    return {
      picks: this.picks.map((p) => ({ label: p.label, geometry: p.geometry })),
      reference: this.reference?.label ?? null,
    };
  }

  /** Replace the picks with saved ones (series are fetched again). */
  restore(saved: SavedPick[], reference: string | null = null): void {
    this.clear();
    for (const s of saved) this.add(s.geometry, s.label);
    const ref = this.picks.find((p) => p.label === reference);
    if (ref) this.setReference(ref.id);
  }

  setReference(id: number | null): void {
    this.referenceId = id !== null && this.picks.some((p) => p.id === id) ? id : null;
    this.onChange();
  }

  get reference(): Pick | null {
    return this.picks.find((p) => p.id === this.referenceId) ?? null;
  }

  get loading(): boolean {
    return this.picks.some((p) => p.results.asc.status === "loading" || p.results.desc.status === "loading");
  }
}
