/** Floating "analysis" panel: per-feature velocity table, hotspots, zoom, CSV, time series. */
import { type AnalysisRow, VELOCITY_CLASSES, geometryBounds, rowsToCsv } from "./analysis";
import { downloadText } from "./chart-panel";
import type { AnalysisResult, DispController } from "./controller";
import { MAX_PICKS, type PickGeometry } from "./picks";
import type { Direction } from "./state";

const fmt = (v: number | undefined) => (v === undefined ? "–" : `${v * 1000 >= 0 ? "+" : ""}${(v * 1000).toFixed(1)}`);

type SortKey = "maxAbs" | "name" | Direction;

function sortRows(rows: AnalysisRow[], key: SortKey): AnalysisRow[] {
  const val = (r: AnalysisRow): number => {
    if (key === "maxAbs") return r.maxAbsMedianMm ?? -1;
    if (key === "name") return 0;
    const m = r.stats[key]?.median;
    return m === undefined ? Infinity : m;
  };
  const sorted = [...rows];
  if (key === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (key === "maxAbs") sorted.sort((a, b) => val(b) - val(a));
  else sorted.sort((a, b) => val(a) - val(b));
  return sorted;
}

/** Geometry usable as a time-series pick: points, polygons; lines use their midpoint. */
export function pickGeometryFor(row: AnalysisRow): PickGeometry | null {
  const g = row.feature.geometry;
  if (!g) return null;
  if (g.type === "Point" || g.type === "Polygon" || g.type === "MultiPolygon") return g as PickGeometry;
  if (g.type === "MultiPoint") return { type: "Point", coordinates: (g.coordinates as [number, number][])[0] };
  if (g.type === "LineString" || g.type === "MultiLineString") {
    const coords = (g.type === "LineString" ? [g.coordinates] : g.coordinates) as [number, number][][];
    const line = coords[0];
    return line?.length ? { type: "Point", coordinates: line[Math.floor(line.length / 2)] } : null;
  }
  return null;
}

export function renderAnalysisPanel(container: HTMLElement, controller: DispController): () => void {
  const root = document.createElement("div");
  root.className = "od-chart-panel od-analysis";
  const status = Object.assign(document.createElement("p"), { className: "od-muted" });
  const toolbar = document.createElement("div");
  toolbar.className = "od-chart-toolbar";
  const exportBtn = Object.assign(document.createElement("button"), { type: "button", className: "od-btn", textContent: "Export CSV" });
  const tsBtn = Object.assign(document.createElement("button"), {
    type: "button",
    className: "od-btn",
    textContent: `Time series for top ${MAX_PICKS} hotspots`,
  });
  const hotOnly = Object.assign(document.createElement("input"), { type: "checkbox" });
  const hotLabel = document.createElement("label");
  hotLabel.append(hotOnly, " Hotspots only");
  toolbar.append(hotLabel, exportBtn, tsBtn);
  const tableWrap = document.createElement("div");
  tableWrap.className = "od-table-wrap";
  const legend = document.createElement("div");
  legend.className = "od-class-legend";
  for (const c of VELOCITY_CLASSES) {
    const item = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = c.color;
    item.append(sw, c.label);
    legend.append(item);
  }
  legend.prepend(Object.assign(document.createElement("span"), { className: "od-muted", textContent: "Map colours (mm/yr):" }));
  const note = Object.assign(document.createElement("p"), {
    className: "od-muted",
    textContent:
      "Values in mm/yr: ASF overview (short-wavelength LOS, 0.24 mm/yr steps, clipped at ±30) or downloaded cubes " +
      "(full-displacement velocity, with σ; a cube hotspot also needs |median| ≥ 2σ). " +
      "Median over polygon pixels / line samples; hotspot = |median| ≥ threshold in a direction with enough " +
      "valid pixels ('low' = below the minimum, not ranked). Click a row to zoom.",
  });
  root.append(status, toolbar, legend, tableWrap, note);
  container.append(root);

  let current: AnalysisResult | null = null;
  let sortKey: SortKey = "maxAbs";

  const render = () => {
    exportBtn.disabled = !current;
    const nHot = current?.rows.filter((r) => r.hotspot.length).length ?? 0;
    tsBtn.disabled = !current?.rows.some((r) => r.maxAbsMedianMm !== null);
    tsBtn.textContent = nHot ? `Time series for top ${Math.min(MAX_PICKS, nHot)} hotspots` : `Time series for top ${MAX_PICKS} features`;
    if (!current) {
      tableWrap.replaceChildren();
      return;
    }
    const { rows, options } = current;
    const dirs = options.directions;
    const table = document.createElement("table");
    table.className = "od-table";
    const head = table.createTHead().insertRow();
    const cube = options.source === "cube";
    const headers: [string, SortKey | null][] = [
      ["Feature", "name"],
      ["Type", null],
      ...dirs.map((d) => [`${d} median`, d] as [string, SortKey]),
      ...(cube ? dirs.map((d) => [`${d} σ`, null] as [string, SortKey | null]) : []),
      ...dirs.map((d) => [`${d} p5 … p95`, null] as [string, SortKey | null]),
      ["max |median|", "maxAbs"],
      ["valid", null],
    ];
    for (const [label, key] of headers) {
      const th = document.createElement("th");
      th.textContent = label + (key && key === sortKey ? " ▾" : "");
      if (key) {
        th.className = "od-sortable";
        th.addEventListener("click", () => {
          sortKey = key;
          render();
        });
      }
      head.append(th);
    }
    const body = table.createTBody();
    const shown = sortRows(rows, sortKey).filter((r) => !hotOnly.checked || r.hotspot.length);
    for (const r of shown.slice(0, 1000)) {
      const tr = body.insertRow();
      if (r.hotspot.length) tr.className = "od-hot";
      else if (r.lowCoverage.length) tr.className = "od-lowcov";
      const cells: string[] = [
        r.name,
        r.geometryType.replace("Multi", "M-"),
        ...dirs.map((d) => r.stats[d]?.error ?? fmt(r.stats[d]?.median)),
        ...(cube ? dirs.map((d) => (r.stats[d]?.stderr_median == null ? "–" : `±${(r.stats[d]!.stderr_median! * 1000).toFixed(1)}`)) : []),
        ...dirs.map((d) => (r.stats[d]?.p5 === undefined ? "–" : `${fmt(r.stats[d]?.p5)} … ${fmt(r.stats[d]?.p95)}`)),
        r.maxAbsMedianMm === null ? "–" : r.maxAbsMedianMm.toFixed(1),
        (dirs
          .map((d) => r.stats[d]?.valid_fraction)
          .filter((v) => v !== undefined)
          .map((v) => `${Math.round(v! * 100)}%`)
          .join(" / ") || "–") + (r.lowCoverage.length ? " low" : ""),
      ];
      for (const c of cells) tr.insertCell().textContent = c;
      tr.addEventListener("click", () => {
        const b = geometryBounds(r.feature.geometry);
        if (b) controller.zoomTo(b);
      });
    }
    tableWrap.replaceChildren(table);
    if (shown.length > 1000) tableWrap.append(Object.assign(document.createElement("p"), { className: "od-muted", textContent: `Showing 1000 of ${shown.length}; export CSV for all.` }));
  };

  hotOnly.addEventListener("change", render);
  exportBtn.addEventListener("click", () => {
    if (!current) return;
    const safe = current.sourceName.replace(/[^\w.-]+/g, "_").slice(0, 40);
    downloadText(`opera_disp_velocity_${safe}.csv`, rowsToCsv(current.rows, current.options));
  });
  tsBtn.addEventListener("click", () => {
    if (!current) return;
    const hot = current.rows.filter((r) => r.hotspot.length);
    // No hotspots: fall back to the features with the largest |median|.
    const top = sortRows(hot.length ? hot : current.rows.filter((r) => r.maxAbsMedianMm !== null), "maxAbs").slice(0, MAX_PICKS);
    for (const r of top) {
      const g = pickGeometryFor(r);
      if (g) controller.addPick(g, r.name.slice(0, 24));
    }
  });

  const unsubscribe = controller.subscribe({
    onAnalysis: (analysis, message) => {
      if (analysis) current = analysis;
      status.textContent = message;
      render();
    },
  });

  return () => {
    unsubscribe();
    root.remove();
  };
}
