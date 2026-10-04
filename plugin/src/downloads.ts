/**
 * "Download subset (DISP-S1)": request a subset download + GeoZarr preparation from
 * disp-proxy (/jobs), follow the jobs, and load results into GeoLibre.
 */
import type { DispController } from "./controller";
import type { GeoLibreAppAPI } from "./host-api";
import type { Direction } from "./state";
import { card, stackedField } from "./ui";

export interface GeoTiffRecord {
  path: string;
  kind: "velocity" | "velocity_stderr" | "coherence" | "displacement_last" | "displacement_epoch" | string;
  units?: string;
  date?: string;
  description?: string;
}

export interface JobFrame {
  frame: number;
  direction: Direction;
  state: string;
  n_files?: number;
  cube?: string;
  geotiffs?: GeoTiffRecord[];
  summary?: {
    epsg?: number;
    levels?: Record<string, number>[];
    n_epochs?: number;
    time_range?: [string, string];
    velocity_median_m_yr?: number | null;
    valid_velocity_fraction?: number;
    validation?: unknown;
  };
}

export interface Job {
  id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled" | string;
  step?: string;
  progress?: number;
  error?: string | null;
  frames?: JobFrame[];
  elapsed_s?: number;
  request?: {
    start?: string | null;
    end?: string | null;
    directions?: string[];
    area_km2?: number;
    title?: string;
    created?: string;
  } | null;
  log?: string[];
  combined?: JobCombined | null;
}

/** Frames merged per direction and asc/desc decomposed (disp_portal.combine). */
export interface JobCombined {
  error?: string;
  crs?: string;
  shape?: [number, number];
  files?: GeoTiffRecord[];
  merge?: Record<string, { frame: number; offset_m_yr: number | null; overlap_pixels: number | null; role: string }[]>;
  decomposition?: { valid_fraction?: number; vertical_median_m_yr?: number | null; assumption?: string; error?: string };
}

export interface JobRequestBody {
  geometry?: unknown;
  bbox?: [number, number, number, number];
  start?: string;
  end?: string;
  directions: Direction[];
  apply_solid_earth: boolean;
  apply_ionosphere: boolean;
  geotiff?: boolean;
  geotiff_epochs?: boolean;
  combine?: boolean;
  title?: string;
}

export interface JobsUsage {
  jobs: number;
  bytes: number;
  max_bytes: number;
  max_age_days: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((body as { detail?: unknown }).detail ?? r.statusText));
  return body as T;
}

export class JobsClient {
  constructor(public baseUrl: string) {}
  create(body: JobRequestBody): Promise<Job> {
    return json(`${this.baseUrl}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  list(): Promise<Job[]> {
    return json(`${this.baseUrl}/jobs`);
  }
  cancel(id: string): Promise<Job> {
    return json(`${this.baseUrl}/jobs/${id}/cancel`, { method: "POST" });
  }
  remove(id: string): Promise<void> {
    return json(`${this.baseUrl}/jobs/${id}`, { method: "DELETE" });
  }
  usage(): Promise<JobsUsage> {
    return json(`${this.baseUrl}/jobs-usage`);
  }
  fileUrl(id: string, rel: string): string {
    return `${this.baseUrl}/jobs/${id}/files/${rel}`;
  }
}

/** Approximate geodesic area (km²) of a lon/lat polygon ring set (spherical excess formula). */
export function polygonAreaKm2(geometry: { type: string; coordinates: unknown }): number {
  const R = 6371.0088;
  const ringArea = (ring: number[][]) => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      sum += ((lon2 - lon1) * Math.PI) / 180 * (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
    }
    return Math.abs((sum * R * R) / 2);
  };
  const polyArea = (rings: number[][][]) => ringArea(rings[0]) - rings.slice(1).reduce((a, r) => a + ringArea(r), 0);
  if (geometry.type === "Polygon") return polyArea(geometry.coordinates as number[][][]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).reduce((a, p) => a + polyArea(p), 0);
  return 0;
}

export function bboxPolygon([w, s, e, n]: [number, number, number, number]) {
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** First polygon among features, or null. */
export function firstPolygon(features: { geometry: { type: string; coordinates?: unknown } | null }[]) {
  const f = features.find((x) => x.geometry && (x.geometry.type === "Polygon" || x.geometry.type === "MultiPolygon"));
  return f ? (f.geometry as { type: string; coordinates: unknown }) : null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Colour stretch per GeoTIFF kind (coolwarm: blue negative, red positive, as the legend). */
export const COG_STYLE: Record<string, { colormap: string; rescaleMin: number; rescaleMax: number; label: string }> = {
  velocity: { colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03, label: "velocity" },
  velocity_stderr: { colormap: "viridis", rescaleMin: 0, rescaleMax: 0.01, label: "velocity σ" },
  coherence: { colormap: "gray", rescaleMin: 0, rescaleMax: 1, label: "coherence" },
  displacement_last: { colormap: "coolwarm", rescaleMin: -0.05, rescaleMax: 0.05, label: "displacement" },
  displacement_epoch: { colormap: "coolwarm", rescaleMin: -0.05, rescaleMax: 0.05, label: "displacement" },
  vertical_velocity: { colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03, label: "vertical" },
  east_velocity: { colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03, label: "east" },
  asc_velocity: { colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03, label: "asc merged" },
  desc_velocity: { colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03, label: "desc merged" },
  vertical_velocity_sigma: { colormap: "viridis", rescaleMin: 0, rescaleMax: 0.01, label: "vertical σ" },
  east_velocity_sigma: { colormap: "viridis", rescaleMin: 0, rescaleMax: 0.01, label: "east σ" },
  asc_velocity_sigma: { colormap: "viridis", rescaleMin: 0, rescaleMax: 0.01, label: "asc σ" },
  desc_velocity_sigma: { colormap: "viridis", rescaleMin: 0, rescaleMax: 0.01, label: "desc σ" },
};

/** Order of the combined products in the jobs panel (main products first, σ last). */
export const COMBINED_ORDER = [
  "vertical_velocity", "east_velocity", "asc_velocity", "desc_velocity",
  "vertical_velocity_sigma", "east_velocity_sigma", "asc_velocity_sigma", "desc_velocity_sigma",
];

/** One-line summary of a job's merge + decomposition. */
export function combinedSummary(c: JobCombined): string {
  if (c.error) return `Combine failed: ${c.error}`;
  const parts: string[] = [];
  for (const [dir, info] of Object.entries(c.merge ?? {})) {
    const frames = info.map((i) =>
      i.role === "reference"
        ? `F${i.frame} ref`
        : i.offset_m_yr === null || !i.role.startsWith("aligned")
          ? `F${i.frame} ${i.role}`
          : `F${i.frame} ${(i.offset_m_yr * 1000).toFixed(1)} mm/yr offset (${i.overlap_pixels} px)`,
    );
    parts.push(`${dir}: ${frames.join(", ")}`);
  }
  const d = c.decomposition;
  if (d?.error) parts.push(`vertical/east: ${d.error}`);
  else if (d) {
    const med = d.vertical_median_m_yr;
    parts.push(
      `vertical/east on ${Math.round((d.valid_fraction ?? 0) * 100)}% of the area` +
        (med !== null && med !== undefined ? `, vertical median ${(med * 1000).toFixed(1)} mm/yr` : "") +
        (d.assumption ? ` (${d.assumption})` : ""),
    );
  }
  return parts.join(" · ");
}

/** Add one of a job's GeoTIFFs to GeoLibre as a client-side COG layer. */
export async function addGeoTiffToMap(app: GeoLibreAppAPI, client: JobsClient, job: Job, frame: JobFrame | null, rec: GeoTiffRecord): Promise<string> {
  if (!app.addCogLayer) throw new Error("this GeoLibre version cannot add COG layers");
  const style = COG_STYLE[rec.kind] ?? COG_STYLE.velocity;
  const prefix = frame ? `F${String(frame.frame).padStart(5, "0")} ${frame.direction}` : `${job.request?.title || job.id} combined`;
  const name = `${prefix} ${style.label}${rec.date ? ` ${rec.date}` : ""} (COG)`;
  return app.addCogLayer(name, client.fileUrl(job.id, rec.path), {
    bands: "1",
    colormap: style.colormap,
    rescaleMin: style.rescaleMin,
    rescaleMax: style.rescaleMax,
    opacity: 0.9,
    zoomTo: false,
  });
}

/** Load a cube's velocity (full-resolution level) into GeoLibre as a Zarr layer. */
export async function addCubeToMap(
  app: GeoLibreAppAPI,
  client: JobsClient,
  job: Job,
  frame: JobFrame,
  colors: string[],
): Promise<string> {
  if (!app.addZarrLayer) throw new Error("this GeoLibre version cannot add Zarr layers");
  if (!frame.cube) throw new Error("no cube for this frame");
  const level = client.fileUrl(job.id, `${frame.cube}/0`);
  const meta = await json<{ attributes?: Record<string, unknown> }>(`${level}/zarr.json`);
  const attrs = meta.attributes ?? {};
  const crs = String(attrs["proj:code"] ?? (frame.summary?.epsg ? `EPSG:${frame.summary.epsg}` : ""));
  const bbox = attrs["spatial:bbox"] as [number, number, number, number] | undefined;
  const name = `F${String(frame.frame).padStart(5, "0")} ${frame.direction} velocity (${job.request?.start ?? ""}…${job.request?.end ?? ""})`;
  return app.addZarrLayer(name, level, {
    variable: "velocity",
    // velocity is 2-D; without an explicit selector GeoLibre applies its default (band, month).
    selector: {},
    clim: [-0.03, 0.03],
    colormap: colors.length ? colors : "rdbu",
    zarrVersion: 3,
    crs: crs || undefined,
    bounds: bbox,
    spatialDimensions: { lat: "y", lon: "x" },
    opacity: 0.9,
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function productsButton(open: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", className: "od-btn", textContent: "Products", title: "Whole-frame velocity products processed on the server" });
  b.addEventListener("click", open);
  return b;
}

/** Sidebar section: choose area, dates, directions, corrections; start a job. */
export function renderDownloadSection(
  app: GeoLibreAppAPI,
  controller: DispController,
  openJobs: () => void,
  startDrawing?: () => Promise<boolean>,
  openProducts?: () => void,
): HTMLElement {
  const source = el("select", { className: "od-input", ariaLabel: "Area" });
  source.append(
    new Option("Area: drawn shape", "drawn"),
    new Option("Area: selected feature", "selected"),
    new Option("Area: current map view", "view"),
  );
  const today = new Date();
  const start = el("input", { type: "date", className: "od-input od-input-inline", value: isoDay(new Date(today.getTime() - 365 * 86_400_000)), ariaLabel: "Start date" });
  const end = el("input", { type: "date", className: "od-input od-input-inline", value: isoDay(today), ariaLabel: "End date" });
  const asc = el("input", { type: "checkbox", checked: true });
  const desc = el("input", { type: "checkbox", checked: true });
  const set = el("input", { type: "checkbox", checked: true });
  const iono = el("input", { type: "checkbox", checked: false });
  // The GeoZarr cube is always written: COGs and the cube time series are read from it.
  const geozarr = el("input", { type: "checkbox", checked: true, disabled: true, title: "Always written (source for COGs and cube time series)" });
  const geotiff = el("input", { type: "checkbox", checked: true });
  const epochs = el("input", { type: "checkbox", checked: false });
  const combine = el("input", {
    type: "checkbox",
    checked: true,
    title: "Merge overlapping frames per direction and, with both directions, solve vertical and east velocity (uses DISP-S1-STATIC line of sight)",
  });
  const areaInfo = el("p", { className: "od-muted" });
  const message = el("p", { className: "od-muted" });
  const go = el("button", { type: "button", className: "od-btn od-primary", textContent: "Download → GeoZarr" });
  const jobsBtn = el("button", { type: "button", className: "od-btn", textContent: "Downloads" });
  const drawBtn = el("button", { type: "button", className: "od-btn", textContent: "Draw polygon", disabled: !startDrawing });
  drawBtn.addEventListener("click", async () => {
    const ok = await startDrawing?.();
    source.value = "drawn";
    areaInfo.textContent = ok
      ? "Drawing tools on: use the GeoEditor toolbar on the map to draw a polygon, then press Download."
      : "Could not start the drawing tools; open Plugins → GeoEditor.";
  });
  jobsBtn.addEventListener("click", openJobs);

  const resolveArea = (): { geometry?: unknown; bbox?: [number, number, number, number]; km2: number } | null => {
    if (source.value === "view") {
      const b = app.getViewBounds?.() ?? (() => {
        const m = app.getMap?.()?.getBounds();
        return m ? ([m.getWest(), m.getSouth(), m.getEast(), m.getNorth()] as [number, number, number, number]) : null;
      })();
      return b ? { bbox: b, km2: polygonAreaKm2(bboxPolygon(b)) } : null;
    }
    const features = (source.value === "drawn" ? app.getDrawnFeatures?.() : app.getSelectedFeatures?.()) ?? [];
    const g = firstPolygon(features);
    return g ? { geometry: g, km2: polygonAreaKm2(g) } : null;
  };
  const refreshArea = () => {
    const a = resolveArea();
    areaInfo.textContent = a
      ? `Area ≈ ${a.km2 < 10 ? a.km2.toFixed(1) : Math.round(a.km2).toLocaleString()} km² (limit 2,500 km²).`
      : source.value === "drawn"
        ? "Draw a polygon (GeoLibre draw tools) first."
        : source.value === "selected"
          ? "Select a polygon feature first."
          : "Map view not available.";
  };
  source.addEventListener("change", refreshArea);
  source.addEventListener("focus", refreshArea);

  go.addEventListener("click", async () => {
    const a = resolveArea();
    refreshArea();
    if (!a) return;
    const directions = [asc.checked && "asc", desc.checked && "desc"].filter(Boolean) as Direction[];
    if (!directions.length) {
      message.textContent = "Pick at least one direction.";
      return;
    }
    go.disabled = true;
    message.textContent = "Submitting…";
    try {
      const job = await new JobsClient(controller.state.proxyUrl).create({
        ...(a.geometry ? { geometry: a.geometry } : { bbox: a.bbox }),
        start: start.value || undefined,
        end: end.value || undefined,
        directions,
        apply_solid_earth: set.checked,
        apply_ionosphere: iono.checked,
        geotiff: geotiff.checked || epochs.checked,
        geotiff_epochs: epochs.checked,
        combine: combine.checked,
      });
      message.textContent = `Job ${job.id} ${job.state}.`;
      openJobs();
    } catch (e) {
      message.textContent = `Not started: ${(e as Error).message}`;
    } finally {
      go.disabled = false;
    }
  });
  refreshArea();

  const pill = (input: HTMLInputElement, text: string, extra?: HTMLElement) =>
    el("label", { className: "od-pill" }, input, el("span", {}, text, ...(extra ? [extra] : [])));
  const tag = (text: string, title: string, cls = "") => el("em", { className: `od-tag ${cls}`, textContent: text, title });
  return card(
    "Download subset (DISP-S1)",
    { id: "download", open: false },
    stackedField("Area", source, drawBtn),
    areaInfo,
    stackedField("Dates", start, el("span", { className: "od-unit", textContent: "→" }), end),
    el("div", { className: "od-group-label", textContent: "Directions and corrections" }),
    el("div", { className: "od-pills" }, pill(asc, "ascending"), pill(desc, "descending"), pill(set, "solid earth tide"), pill(iono, "ionosphere")),
    el("div", { className: "od-group-label", textContent: "Output" }),
    el(
      "div",
      { className: "od-pills od-outputs" },
      pill(geozarr, "GeoZarr cube", tag("always", "Always written: the COGs and cube time series are made from it", "od-tag-lock")),
      pill(geotiff, "GeoTIFF (COG)"),
      pill(epochs, "+ every epoch"),
      pill(combine, "merge + vertical/east", tag("BETA", "Beta: frame merge by overlap offset and asc/desc decomposition (north motion neglected); check results", "od-tag-beta")),
    ),
    el("div", { className: "od-actions" }, go, el("div", { className: "od-row od-buttons od-split" }, jobsBtn, ...(openProducts ? [productsButton(openProducts)] : []))),
    message,
    el("p", {
      className: "od-muted",
      title:
        "Downloads only the area with opera-utils, re-references the stack, and writes a multiscale GeoZarr cube " +
        "per frame and direction, plus COGs (velocity, σ, coherence, last displacement; optionally every epoch). " +
        "With merge on, overlapping frames are merged per direction and, with both directions, vertical and " +
        "east velocity are solved (north motion neglected).",
      textContent: "Subset → re-referenced GeoZarr cube and COGs per frame on the server.",
    }),
  );
}

const stateLabel: Record<string, string> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Floating panel: list of jobs with progress and actions; polls while jobs are active. */
export function renderJobsPanel(container: HTMLElement, app: GeoLibreAppAPI, controller: DispController): () => void {
  const root = el("div", { className: "od-chart-panel od-jobs" });
  const status = el("p", { className: "od-muted" });
  const list = el("div", { className: "od-job-list" });
  const refreshBtn = el("button", { type: "button", className: "od-btn", textContent: "Refresh" });
  root.append(el("div", { className: "od-chart-toolbar" }, refreshBtn, status), list);
  container.append(root);
  let colors: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const client = () => new JobsClient(controller.state.proxyUrl);

  const cogButtons = (job: Job, frame: JobFrame | null, rec: GeoTiffRecord): HTMLElement[] => {
    const style = COG_STYLE[rec.kind];
    const add = el("button", { type: "button", className: "od-btn", textContent: style?.label ?? rec.kind, title: `Add ${rec.path} to the map` });
    add.addEventListener("click", async () => {
      add.disabled = true;
      try {
        await addGeoTiffToMap(app, client(), job, frame, rec);
        add.textContent = `${style?.label ?? rec.kind} ✓`;
      } catch (e) {
        add.textContent = "failed";
        status.textContent = `Could not add COG: ${(e as Error).message}`;
      }
    });
    const dl = el("a", { href: client().fileUrl(job.id, rec.path), textContent: "↓", title: `Download ${rec.path}`, className: "od-dl" });
    dl.setAttribute("download", rec.path.split("/").pop() ?? "");
    return [add, dl];
  };

  const renderCombined = (job: Job): HTMLElement | null => {
    const c = job.combined;
    if (!c) return null;
    const box = el(
      "div",
      { className: "od-combined" },
      el("strong", { textContent: "Combined" }),
      el("em", { className: "od-tag od-tag-beta", textContent: "BETA", title: "Frame merge and asc/desc decomposition are in beta" }),
    );
    const files = [...(c.files ?? [])].sort((a, b) => COMBINED_ORDER.indexOf(a.kind) - COMBINED_ORDER.indexOf(b.kind));
    if (files.length) {
      const row = el("div", { className: "od-tif-row" }, el("span", { className: "od-muted", textContent: "COG:" }));
      for (const rec of files) row.append(...cogButtons(job, null, rec));
      box.append(row);
    }
    box.append(el("div", { className: "od-muted", textContent: combinedSummary(c) }));
    return box;
  };

  const renderJob = (job: Job) => {
    const req = job.request ?? {};
    const head = el(
      "div",
      { className: "od-job-head" },
      el("strong", { textContent: req.title || job.id }),
      el("span", { className: `od-job-state od-state-${job.state}`, textContent: stateLabel[job.state] ?? job.state }),
    );
    const meta = el("div", {
      className: "od-muted",
      textContent: `${req.start ?? "first"} → ${req.end ?? "latest"} · ${(req.directions ?? []).join("+")} · ${req.area_km2 ?? "?"} km²` +
        (job.elapsed_s ? ` · ${Math.round(job.elapsed_s)} s` : ""),
    });
    const bar = el("div", { className: "od-progress" }, el("span"));
    (bar.firstChild as HTMLElement).style.width = `${Math.round((job.progress ?? 0) * 100)}%`;
    const step = el("div", { className: "od-muted", textContent: job.error ? `Error: ${job.error}` : job.step ?? "" });
    if (job.error) step.classList.add("od-error");

    const frames = el("ul", { className: "od-picks" });
    for (const f of job.frames ?? []) {
      const name = `F${String(f.frame).padStart(5, "0")} ${f.direction}`;
      const s = f.summary;
      const detail = s
        ? ` · ${s.n_epochs} epochs ${s.time_range?.[0]}…${s.time_range?.[1]} · median ${((s.velocity_median_m_yr ?? NaN) * 1000).toFixed(1)} mm/yr · ${s.validation === "ok" ? "GeoZarr valid" : "validation issues"}`
        : f.n_files !== undefined ? ` · ${f.n_files} files` : "";
      const li = el("li", {}, el("strong", { textContent: name }), el("span", { className: "od-muted", textContent: ` ${f.state}${detail}` }));
      if (f.cube && f.state === "done") {
        const show = el("button", { type: "button", className: "od-btn", textContent: "Show velocity" });
        show.addEventListener("click", async () => {
          show.disabled = true;
          try {
            await addCubeToMap(app, client(), job, f, colors);
            show.textContent = "Added";
          } catch (e) {
            show.textContent = "Failed";
            show.title = (e as Error).message;
            status.textContent = `Could not add layer: ${(e as Error).message}`;
          }
        });
        const copy = el("button", { type: "button", className: "od-btn", textContent: "Copy path", title: "Server path of the GeoZarr cube (e.g. for bowser)" });
        copy.addEventListener("click", () => {
          const path = `jobs/${job.id}/${f.cube}`;
          void navigator.clipboard?.writeText(path).then(
            () => (copy.textContent = "Copied"),
            () => (status.textContent = path),
          );
        });
        li.append(show, copy);
      }
      const tifs = (f.geotiffs ?? []).filter((r) => r.kind !== "displacement_epoch");
      const nEpochs = (f.geotiffs ?? []).length - tifs.length;
      if (tifs.length) {
        const row = el("div", { className: "od-tif-row" }, el("span", { className: "od-muted", textContent: "COG:" }));
        for (const rec of tifs) row.append(...cogButtons(job, f, rec));
        if (nEpochs) row.append(el("span", { className: "od-muted", textContent: ` + ${nEpochs} epoch files` }));
        li.append(row);
      }
      frames.append(li);
    }

    const actions = el("div", { className: "od-row od-buttons" });
    if (job.state === "queued" || job.state === "running") {
      const cancel = el("button", { type: "button", className: "od-btn", textContent: "Cancel" });
      cancel.addEventListener("click", async () => {
        await client().cancel(job.id).catch(() => undefined);
        void refresh();
      });
      actions.append(cancel);
    } else {
      const del = el("button", { type: "button", className: "od-btn", textContent: "Delete" });
      del.addEventListener("click", async () => {
        if (!confirm(`Delete job ${job.id} and its files?`)) return;
        await client().remove(job.id).catch(() => undefined);
        void refresh();
      });
      actions.append(del);
    }
    const combined = renderCombined(job);
    return el("div", { className: "od-job" }, head, meta, bar, step, frames, ...(combined ? [combined] : []), actions);
  };

  const refresh = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      const jobs = await client().list();
      list.replaceChildren(...(jobs.length ? jobs.map(renderJob) : [el("p", { className: "od-muted", textContent: "No downloads yet." })]));
      const active = jobs.some((j) => j.state === "queued" || j.state === "running");
      const usage = await client().usage().catch(() => null);
      const disk = usage
        ? ` · ${(usage.bytes / 1e6).toFixed(1)} MB of ${(usage.max_bytes / 1e9).toFixed(0)} GB; finished jobs kept ${usage.max_age_days} days`
        : "";
      status.textContent = (active ? "Updating every 3 s…" : `${jobs.length} job(s)`) + disk;
      if (active && !stopped) timer = setTimeout(() => void refresh(), 3000);
    } catch (e) {
      status.textContent = `disp-proxy not reachable: ${(e as Error).message}`;
    }
  };
  refreshBtn.addEventListener("click", () => void refresh());

  const unsubscribe = controller.subscribe({
    onExtent: (extent) => {
      if (extent) colors = extent.legend_colors;
    },
  });
  void refresh();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    root.remove();
  };
}
