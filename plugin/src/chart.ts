/** Interactive time-series chart (uPlot) with model fits, residual view and step markers. */
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { type FitModel, type FitResult, fitModel } from "./fit";
import { type CubeSeries, type CubeVariable, correctionsLabel, cubePoints, frameName } from "./cube-series";
import type { Pick } from "./picks";
import type { Direction, FitSettings } from "./state";
import { type TsPoint, subtractReference } from "./timeseries";

export interface ChartOptions {
  showFit: boolean;
  reference: Pick | null;
  fit?: FitSettings;
  view?: "data" | "residuals";
  source?: "asf" | "cube" | "both";
  cubeVariable?: CubeVariable;
  /** Hide data points and keep only the model curves (needs showFit). */
  modelOnly?: boolean;
  /** Draw a legend inside the plot area. */
  legend?: boolean;
}

export interface PreparedSeries {
  pick: Pick;
  direction: Direction;
  points: TsPoint[];
  fit: FitResult | null;
  source: "asf" | "cube";
  /** Legend label, e.g. "P1 asc" or "P1 asc cube F08882". */
  label: string;
  cube?: CubeSeries;
}

export function toFitModel(settings: FitSettings | undefined): FitModel {
  const s = settings ?? { polyOrder: 1, annual: false, semiannual: false, steps: [], rejectOutliers: false };
  return {
    polyOrder: s.polyOrder,
    annual: s.annual,
    semiannual: s.semiannual,
    steps: s.steps.map((d) => Date.parse(`${d}T00:00:00Z`)).filter(Number.isFinite),
    rejectOutliers: s.rejectOutliers,
  };
}

/** Points to plot per pick, direction and source (relative to the reference when set), with the model fit. */
export function prepareSeries(picks: Pick[], options: ChartOptions): PreparedSeries[] {
  const model = toFitModel(options.fit);
  const source = options.source ?? "both";
  const variable = options.cubeVariable ?? "displacement";
  const out: PreparedSeries[] = [];
  for (const pick of picks) {
    if (options.reference && pick.id === options.reference.id) continue;
    if (source !== "cube") {
      for (const direction of ["asc", "desc"] as Direction[]) {
        const series = pick.results[direction].series;
        if (!series) continue;
        let points = series.points;
        if (options.reference) {
          const ref = options.reference.results[direction].series;
          if (!ref) continue;
          points = subtractReference(points, ref.points);
        }
        if (!points.length) continue;
        out.push({ pick, direction, points, fit: fitModel(points, model), source: "asf", label: `${pick.label} ${direction}` });
      }
    }
    if (source !== "asf") {
      for (const cube of pick.cube?.series ?? []) {
        let points = cubePoints(cube, variable);
        if (options.reference) {
          // Same cube grid on both sides: reference must come from the same frame and direction.
          const ref = options.reference.cube?.series.find((r) => r.frame === cube.frame && r.direction === cube.direction);
          if (!ref) continue;
          points = subtractReference(points, cubePoints(ref, variable));
        }
        if (!points.length) continue;
        out.push({
          pick,
          direction: cube.direction,
          points,
          fit: fitModel(points, model),
          source: "cube",
          label: `${pick.label} ${cube.direction} cube ${frameName(cube.frame)}`,
          cube,
        });
      }
    }
  }
  return out;
}

const mmFmt = (m: number, digits = 1) => `${m * 1000 >= 0 ? "+" : ""}${(m * 1000).toFixed(digits)}`;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One-line description of a fit for the table. */
export function describeFit(fit: FitResult | null): string {
  if (!fit) return "model not estimable (too few epochs for the chosen terms)";
  const parts: string[] = [];
  const m = fit.model;
  if (m.polyOrder >= 1) {
    parts.push(`rate ${mmFmt(fit.rate)} ± ${(fit.rateStd * 1000).toFixed(1)} mm/yr`);
    if (m.polyOrder >= 2) parts.push(`mean rate ${mmFmt(fit.meanRate)} mm/yr`, `accel ${mmFmt(2 * fit.coefficients[2], 2)} mm/yr²`);
  }
  if (fit.annual) parts.push(`annual ${(fit.annual.amplitude * 1000).toFixed(1)} ± ${(fit.annual.amplitudeStd * 1000).toFixed(1)} mm (peak DOY ${fit.annual.peakDoy})`);
  if (fit.semiannual) parts.push(`semi-annual ${(fit.semiannual.amplitude * 1000).toFixed(1)} ± ${(fit.semiannual.amplitudeStd * 1000).toFixed(1)} mm`);
  for (const s of fit.steps) parts.push(`step ${day(s.t)} ${mmFmt(s.size)} ± ${(s.std * 1000).toFixed(1)} mm`);
  if (fit.droppedSteps.length) parts.push(`step(s) ${fit.droppedSteps.map(day).join(", ")} outside data`);
  parts.push(`RMS ${(fit.rms * 1000).toFixed(1)} mm`);
  if (fit.nOutliers) parts.push(`${fit.nOutliers} outlier(s) excluded`);
  return parts.join(" · ");
}

interface Built {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
}

function build(prepared: PreparedSeries[], options: ChartOptions): Built {
  const residuals = options.view === "residuals";
  const hideData = Boolean(options.modelOnly && options.showFit);
  const times = [...new Set(prepared.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const index = new Map(times.map((t, i) => [t, i]));
  const data: (number | null)[][] = [];
  const series: uPlot.Series[] = [{}];
  const value = (_u: uPlot, v: number | null) => (v === null ? "—" : `${v.toFixed(1)} mm`);

  for (const s of prepared) {
    const asc = s.direction === "asc";
    const used: (number | null)[] = new Array(times.length).fill(null);
    const outliers: (number | null)[] = new Array(times.length).fill(null);
    s.points.forEach((p, i) => {
      const v = residuals && s.fit ? p.value - s.fit.predict(p.t) : p.value;
      const target = s.fit && !s.fit.used[i] ? outliers : used;
      target[index.get(p.t)!] = v * 1000;
    });
    data.push(used);
    series.push(
      s.source === "cube"
        ? {
            // Downloaded cube: connected line + small points, dashed for descending.
            label: s.label,
            stroke: s.pick.color,
            width: 1.4,
            dash: asc ? [] : [5, 3],
            spanGaps: true,
            points: { show: true, size: 3, width: 1, stroke: s.pick.color, fill: s.pick.color },
            value,
            show: !hideData,
          }
        : {
            label: s.label,
            stroke: s.pick.color,
            paths: () => null,
            points: { show: true, size: 5, width: 1.5, stroke: s.pick.color, fill: asc ? s.pick.color : "transparent" },
            value,
            show: !hideData,
          },
    );
    if (s.fit?.nOutliers) {
      data.push(outliers);
      series.push({
        label: `${s.label} outliers`,
        stroke: s.pick.color,
        paths: () => null,
        points: { show: true, size: 7, width: 1, stroke: "#888", fill: "transparent" },
        value,
        show: !hideData,
      });
    }
  }
  if (options.showFit) {
    for (const s of prepared) {
      const col: (number | null)[] = new Array(times.length).fill(null);
      if (s.fit) {
        const first = s.points[0].t;
        const last = s.points[s.points.length - 1].t;
        for (let i = 0; i < times.length; i++) {
          if (times[i] >= first && times[i] <= last) col[i] = residuals ? 0 : s.fit.predict(times[i]) * 1000;
        }
      }
      data.push(col);
      series.push({
        label: `${s.label} model`,
        stroke: s.pick.color,
        width: hideData ? 2.2 : 1.5,
        dash: s.direction === "asc" ? [] : [6, 4],
        spanGaps: true,
        points: { show: false },
        value,
      });
    }
  }
  return { data: [times.map((t) => t / 1000), ...data] as uPlot.AlignedData, series };
}

/** Mouse-wheel zoom on the time axis, centred on the cursor; `onZoom` reports user zooms. */
function wheelZoom(onZoom: (zoomed: boolean) => void): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const { min, max } = u.scales.x;
            if (min === undefined || max === undefined) return;
            const at = u.posToVal(e.offsetX, "x");
            const factor = e.deltaY < 0 ? 0.8 : 1.25;
            const nMin = at - (at - min) * factor;
            const nMax = at + (max - at) * factor;
            const full = u.data[0];
            if (factor > 1 && nMin <= full[0] && nMax >= full[full.length - 1]) {
              u.setScale("x", { min: full[0], max: full[full.length - 1] });
              onZoom(false);
            } else {
              u.setScale("x", { min: nMin, max: nMax });
              onZoom(true);
            }
          },
          { passive: false },
        );
        // uPlot resets the zoom on double-click.
        u.over.addEventListener("dblclick", () => onZoom(false));
      },
      // Drag-to-zoom selection.
      setSelect: (u) => {
        if (u.select.width > 0) onZoom(true);
      },
    },
  };
}

/** Dashed vertical lines at step dates, and click-to-add-step when enabled. */
function stepMarkers(getSteps: () => number[], onClickTime: (t: number) => void, isAdding: () => boolean): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "#d62728";
        ctx.lineWidth = 1.2 * uPlot.pxRatio;
        ctx.setLineDash([5 * uPlot.pxRatio, 4 * uPlot.pxRatio]);
        for (const t of getSteps()) {
          const x = u.valToPos(t / 1000, "x", true);
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();
        }
        ctx.restore();
      },
      ready: (u) => {
        u.over.addEventListener("click", (e) => {
          if (!isAdding()) return;
          onClickTime(u.posToVal(e.offsetX, "x") * 1000);
        });
      },
    },
  };
}

export interface LegendEntry {
  label: string;
  color: string;
  /** Marker: filled dot (ascending ASF), ring (descending ASF), or line (cube / model only). */
  marker: "dot" | "ring" | "line" | "dash";
  detail?: string;
}

/** Legend entries for the plotted series (one per pick / direction / source). */
export function legendEntries(prepared: PreparedSeries[], options: ChartOptions): LegendEntry[] {
  const lineOnly = Boolean(options.modelOnly && options.showFit);
  return prepared.map((s) => {
    const desc = s.direction === "desc";
    const marker: LegendEntry["marker"] =
      lineOnly || s.source === "cube" ? (desc ? "dash" : "line") : desc ? "ring" : "dot";
    const rate = options.showFit && s.fit && s.fit.model.polyOrder >= 1
      ? `${s.fit.rate * 1000 >= 0 ? "+" : ""}${(s.fit.rate * 1000).toFixed(1)} ± ${(s.fit.rateStd * 1000).toFixed(1)} mm/yr`
      : undefined;
    return { label: s.label, color: s.pick.color, marker, detail: rate };
  });
}

/** Legend painted into the plot canvas (top-left), so screenshots and PNG export include it. */
function canvasLegend(getEntries: () => LegendEntry[], enabled: () => boolean): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const entries = getEntries();
        if (!enabled() || !entries.length) return;
        const r = uPlot.pxRatio;
        const ctx = u.ctx;
        const font = 11 * r;
        const lineH = 15 * r;
        const pad = 6 * r;
        const sw = 18 * r;
        ctx.save();
        // uPlot leaves its axis text alignment and dash pattern on the context.
        ctx.textAlign = "left";
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.font = `${font}px system-ui, sans-serif`;
        const texts = entries.map((e) => (e.detail ? `${e.label}  ${e.detail}` : e.label));
        const maxShown = Math.max(1, Math.floor((u.bbox.height - 2 * pad) / lineH));
        const shown = texts.slice(0, maxShown);
        const more = texts.length - shown.length;
        if (more > 0) shown[shown.length - 1] = `+ ${more + 1} more`;
        const w = Math.max(...shown.map((t) => ctx.measureText(t).width)) + sw + 3 * pad;
        const h = shown.length * lineH + 2 * pad - 3 * r;
        const x0 = u.bbox.left + 8 * r;
        const y0 = u.bbox.top + 8 * r;
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.lineWidth = r;
        ctx.beginPath();
        ctx.roundRect?.(x0, y0, w, h, 4 * r);
        if (!ctx.roundRect) ctx.rect(x0, y0, w, h);
        ctx.fill();
        ctx.stroke();
        shown.forEach((text, i) => {
          const e = entries[i];
          const cy = y0 + pad + i * lineH + lineH / 2 - 2 * r;
          const sx = x0 + pad;
          const isMore = more > 0 && i === shown.length - 1;
          if (!isMore) {
            ctx.strokeStyle = e.color;
            ctx.fillStyle = e.color;
            ctx.lineWidth = 2 * r;
            ctx.setLineDash(e.marker === "dash" ? [4 * r, 3 * r] : []);
            if (e.marker === "line" || e.marker === "dash") {
              ctx.beginPath();
              ctx.moveTo(sx, cy);
              ctx.lineTo(sx + sw, cy);
              ctx.stroke();
            } else {
              ctx.beginPath();
              ctx.arc(sx + sw / 2, cy, 3.5 * r, 0, 2 * Math.PI);
              if (e.marker === "dot") ctx.fill();
              else ctx.stroke();
            }
            ctx.setLineDash([]);
          }
          ctx.fillStyle = "#222";
          ctx.textBaseline = "middle";
          ctx.fillText(text, sx + sw + pad, cy);
        });
        ctx.restore();
      },
    },
  };
}

export interface ChartCallbacks {
  /** Called with a time (epoch ms) when the user clicks the chart in add-step mode. */
  onAddStep?: (t: number) => void;
}

export class TimeseriesChart {
  private plot: uPlot | null = null;
  private readonly chartEl: HTMLDivElement;
  private readonly tableEl: HTMLDivElement;
  private readonly emptyEl: HTMLParagraphElement;
  private resize: ResizeObserver | null = null;
  private lastKey = "";
  private steps: number[] = [];
  private legend: LegendEntry[] = [];
  private legendOn = true;
  /** Open state of the collapsible series list / no-data list, kept across re-renders. */
  private listOpen: boolean | null = null;
  private failedOpen = false;
  /** When true, a click on the plot adds a step instead of nothing. */
  addingStep = false;
  /** True after the user zoomed (drag/wheel); only then is the zoom kept across rebuilds. */
  private userZoomed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ChartCallbacks = {},
  ) {
    this.emptyEl = Object.assign(document.createElement("p"), {
      className: "od-muted",
      textContent: "Click the map (or use a drawn shape) to add a time series.",
    });
    this.chartEl = document.createElement("div");
    this.chartEl.className = "od-chart";
    this.tableEl = document.createElement("div");
    this.tableEl.className = "od-ts-table";
    container.append(this.emptyEl, this.chartEl, this.tableEl);
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => {
        if (this.plot) this.plot.setSize({ width: this.width(), height: this.plot.height });
      });
      this.resize.observe(container);
    }
  }

  private width(): number {
    return Math.max(280, this.container.clientWidth - 8);
  }

  /** Back to the full time range. */
  resetZoom(): void {
    this.userZoomed = false;
    const x = this.plot?.data[0];
    if (this.plot && x?.length) this.plot.setScale("x", { min: x[0], max: x[x.length - 1] });
  }

  setAddingStep(on: boolean): void {
    this.addingStep = on;
    this.chartEl.classList.toggle("od-adding-step", on);
  }

  update(picks: Pick[], options: ChartOptions): void {
    const prepared = prepareSeries(picks, options);
    this.steps = toFitModel(options.fit).steps;
    this.legend = legendEntries(prepared, options);
    this.legendOn = options.legend ?? true;
    this.renderTable(picks, prepared, options);
    this.emptyEl.hidden = prepared.length > 0;
    // Rebuild only when plotted content changes (uPlot setData cannot add series); keep zoom.
    const key = JSON.stringify([
      prepared.map((s) => [s.pick.id, s.label, s.points.length, s.pick.color, s.fit?.nOutliers ?? 0]),
      options.showFit,
      options.reference?.id ?? null,
      options.fit ?? null,
      options.view ?? "data",
      options.source ?? "both",
      options.cubeVariable ?? "displacement",
      options.modelOnly ?? false,
    ]);
    if (key === this.lastKey) {
      this.plot?.redraw(false, false); // legend text (rates) may have changed
      return;
    }
    this.lastKey = key;
    // Keep the user's zoom when series are added or the model changes; otherwise show the
    // full range (series arriving one by one must not freeze the axis on the first one).
    const prevX = this.plot && this.userZoomed ? { min: this.plot.scales.x.min, max: this.plot.scales.x.max } : null;
    this.plot?.destroy();
    this.plot = null;
    if (!prepared.length) return;

    const fg = getComputedStyle(this.container).color || "#444";
    const grid = { stroke: "rgba(128,128,128,0.2)", width: 1 };
    const { data, series } = build(prepared, options);
    const residuals = options.view === "residuals";
    const base = options.reference ? `rel. to ${options.reference.label}` : "LOS displacement";
    // (cube "displacement" is full displacement; ASF series are short-wavelength)
    this.plot = new uPlot(
      {
        width: this.width(),
        height: 280,
        scales: { x: { time: true } },
        axes: [
          { stroke: fg, grid },
          { stroke: fg, grid, label: `${residuals ? "Residual" : base} [mm]`, labelSize: 18, size: 52 },
        ],
        series,
        legend: { live: true },
        cursor: { points: { size: 7 }, drag: { x: true, y: false, setScale: true } },
        hooks: {
          // Expose the visible time range (ISO dates) for tests and debugging.
          setScale: [
            (u, key) => {
              if (key !== "x" || u.scales.x.min === undefined || u.scales.x.max === undefined) return;
              this.chartEl.dataset.xRange = `${day(u.scales.x.min * 1000)}/${day(u.scales.x.max * 1000)}`;
            },
          ],
        },
        plugins: [
          wheelZoom((zoomed) => {
            this.userZoomed = zoomed;
          }),
          stepMarkers(
            () => this.steps,
            (t) => this.callbacks.onAddStep?.(t),
            () => this.addingStep,
          ),
          canvasLegend(
            () => this.legend,
            () => this.legendOn,
          ),
        ],
      },
      data,
      this.chartEl,
    );
    if (prevX?.min !== undefined && prevX.max !== undefined) this.plot.setScale("x", { min: prevX.min, max: prevX.max });
    // Legend keeps live values for the data series; model and outlier rows are summarised in the table.
    this.plot.root.querySelectorAll<HTMLElement>(".u-legend .u-series").forEach((row, i) => {
      const label = String(series[i]?.label ?? "");
      if (i > 0 && (label.endsWith(" model") || label.endsWith(" outliers"))) row.style.display = "none";
    });
  }

  private renderTable(picks: Pick[], prepared: PreparedSeries[], options: ChartOptions): void {
    const rows: HTMLElement[] = [];
    for (const pick of picks) {
      for (const direction of ["asc", "desc"] as Direction[]) {
        const r = pick.results[direction];
        const row = document.createElement("div");
        row.className = "od-ts-row";
        const swatch = document.createElement("span");
        swatch.className = `od-swatch ${direction === "desc" ? "od-swatch-ring" : ""}`;
        swatch.style.setProperty("--od-color", pick.color);
        const name = document.createElement("span");
        name.textContent = `${pick.label} ${direction}`;
        const info = document.createElement("span");
        info.className = "od-ts-info";
        if (r.status === "loading") {
          const spin = document.createElement("span");
          spin.className = "od-spinner od-spinner-sm";
          info.append(spin, " retrieving from Earthdata…");
        }
        else if (r.status === "error") {
          info.textContent = (r.error ?? "failed").replace(/^Time series failed: \d+: /, "");
          info.classList.add("od-error");
          row.dataset.state = "error";
        } else if (r.series) {
          const s = r.series;
          const frame = s.frameId === null ? "" : `F${String(s.frameId).padStart(5, "0")} · `;
          const head = `${frame}${s.points.length} epochs ${day(s.points[0].t)} … ${day(s.points[s.points.length - 1].t)}`;
          if (options.reference?.id === pick.id) info.textContent = `${head} · reference`;
          else {
            const p = prepared.find((x) => x.pick.id === pick.id && x.direction === direction && x.source === "asf");
            info.textContent = p ? `${head}\n${describeFit(p.fit)}` : head;
          }
          if (r.otherFrames?.length) {
            const warn = document.createElement("span");
            warn.className = "od-warn";
            warn.textContent = ` · also covered by ${r.otherFrames.map((f) => `F${String(f).padStart(5, "0")}`).join(", ")} (not used by the service)`;
            info.append(warn);
          }
        }
        row.dataset.pick = String(pick.id);
        row.append(swatch, name, info);
        if ((options.source ?? "both") !== "cube") rows.push(row);
      }
      rows.push(...this.cubeRows(pick, prepared, options));
    }
    // Series that returned no data ("No data found for the given area of interest") are folded
    // into one expandable line so many failed picks do not stretch the window.
    const failed = rows.filter((r) => r.dataset.state === "error");
    const ok = rows.filter((r) => r.dataset.state !== "error");
    const children: HTMLElement[] = [];
    if (ok.length) {
      const list = document.createElement("details");
      list.className = "od-ts-group";
      list.open = this.listOpen ?? ok.length <= 6;
      list.addEventListener("toggle", () => (this.listOpen = list.open));
      const summary = document.createElement("summary");
      summary.textContent = `Series and fits (${ok.length})`;
      list.append(summary, ...ok);
      children.push(list);
    }
    if (failed.length) {
      const box = document.createElement("details");
      box.className = "od-ts-group od-ts-failed";
      box.open = this.failedOpen;
      box.addEventListener("toggle", () => (this.failedOpen = box.open));
      const summary = document.createElement("summary");
      const picksWithout = new Set(failed.map((r) => r.dataset.pick)).size;
      summary.textContent = `${failed.length} series without data (${picksWithout} point${picksWithout === 1 ? "" : "s"})`;
      box.append(summary, ...failed);
      children.push(box);
    }
    this.tableEl.replaceChildren(...children);
  }

  private cubeRows(pick: Pick, prepared: PreparedSeries[], options: ChartOptions): HTMLElement[] {
    const source = options.source ?? "both";
    if (source === "asf") return [];
    const cube = pick.cube;
    if (!cube) return [];
    const row = (label: string, text: string, color: string, ring = false, cls = "") => {
      const r = document.createElement("div");
      r.className = "od-ts-row";
      const swatch = document.createElement("span");
      swatch.className = `od-swatch od-swatch-line ${ring ? "od-swatch-ring" : ""}`;
      swatch.style.setProperty("--od-color", color);
      const name = document.createElement("span");
      name.textContent = label;
      const info = document.createElement("span");
      info.className = `od-ts-info ${cls}`;
      info.textContent = text;
      r.append(swatch, name, info);
      return r;
    };
    if (cube.status === "loading") return [row(`${pick.label} cube`, "looking for downloaded cubes…", pick.color)];
    if (cube.status === "error") return [row(`${pick.label} cube`, cube.error ?? "failed", pick.color, false, "od-error")];
    if (!cube.series.length) {
      return source === "cube" ? [row(`${pick.label} cube`, "no downloaded cube covers this pick (Download subset)", pick.color)] : [];
    }
    return cube.series.map((c) => {
      const p = prepared.find((x) => x.pick.id === pick.id && x.cube === c);
      const variable = options.cubeVariable === "short_wavelength_displacement" ? "short-wavelength" : "full displacement";
      const head =
        `${frameName(c.frame)} · cube (${variable}, ${correctionsLabel(c.corrections)}) · ${c.time.length} epochs ` +
        `${c.time[0]?.slice(0, 10)} … ${c.time[c.time.length - 1]?.slice(0, 10)}` +
        (c.n_pixels > 1 ? ` · mean of ${c.n_pixels} px` : "") +
        (c.coherence !== null ? ` · coherence ${c.coherence.toFixed(2)}` : "");
      const isRef = options.reference?.id === pick.id;
      return row(
        `${pick.label} ${c.direction} cube`,
        isRef ? `${head} · reference` : p ? `${head}\n${describeFit(p.fit)}` : head,
        pick.color,
        c.direction === "desc",
      );
    });
  }

  /** PNG of the plot (axes, series, step markers and the in-plot legend) on a white background. */
  toPng(): string | null {
    if (!this.plot) return null;
    const src = this.plot.ctx.canvas;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    return out.toDataURL("image/png");
  }

  destroy(): void {
    this.resize?.disconnect();
    this.plot?.destroy();
    this.plot = null;
    this.container.replaceChildren();
  }
}
