/** Floating "time series" panel: interactive chart, model settings, steps, CSV export. */
import { TimeseriesChart, describeFit, prepareSeries } from "./chart";
import type { DispController } from "./controller";
import type { Pick } from "./picks";
import type { DispState, FitSettings } from "./state";
import { toCsv } from "./timeseries";

export function downloadText(filename: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV of what the chart shows (relative to the reference when one is chosen), with model columns. */
export interface SourceOptions {
  source?: "asf" | "cube" | "both";
  cubeVariable?: "displacement" | "short_wavelength_displacement";
}

export function picksCsv(
  picks: Pick[],
  reference: Pick | null,
  fit?: FitSettings,
  withModel = false,
  src: SourceOptions = {},
): string {
  return toCsv(
    prepareSeries(picks, { showFit: withModel, reference, fit, ...src }).map((s) => ({
      label: s.pick.label,
      wkt: s.pick.wkt,
      series:
        s.source === "cube"
          ? { direction: s.direction, frameId: s.cube!.frame, points: s.points, mean: null }
          : s.pick.results[s.direction].series!,
      referenceLabel: reference?.label,
      points: s.points,
      model: withModel && s.fit ? s.fit.predict : undefined,
      used: withModel && s.fit ? s.fit.used : undefined,
      source: s.source,
      variable: s.source === "cube" ? (src.cubeVariable ?? "displacement") : "short_wavelength_displacement",
    })),
  );
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per series with the fitted parameters (mm, mm/yr) and their 1-sigma errors. */
export function fitCsv(picks: Pick[], reference: Pick | null, fit: FitSettings, src: SourceOptions = {}): string {
  const prepared = prepareSeries(picks, { showFit: true, reference, fit, ...src });
  const rows = prepared.map((s) => {
    const f = s.fit;
    const row: Record<string, unknown> = {
      series: s.pick.label,
      direction: s.direction === "asc" ? "ascending" : "descending",
      source: s.source,
      variable: s.source === "cube" ? (src.cubeVariable ?? "displacement") : "short_wavelength_displacement",
      frame: s.source === "cube" ? s.cube!.frame : (s.pick.results[s.direction].series?.frameId ?? ""),
      geometry: s.pick.wkt,
      relative_to: reference?.label ?? "",
      model: modelLabel(fit),
      n_epochs: s.points.length,
    };
    if (f) {
      f.names.forEach((name, j) => {
        const key = name.replace(/[^\w]+/g, "_");
        row[`${key}_mm`] = (f.coefficients[j] * 1000).toFixed(3);
        row[`${key}_std_mm`] = (f.stdErrors[j] * 1000).toFixed(3);
      });
      row.mean_rate_mm_yr = (f.meanRate * 1000).toFixed(3);
      if (f.annual) {
        row.annual_amplitude_mm = (f.annual.amplitude * 1000).toFixed(3);
        row.annual_amplitude_std_mm = (f.annual.amplitudeStd * 1000).toFixed(3);
        row.annual_peak_doy = f.annual.peakDoy;
      }
      if (f.semiannual) {
        row.semiannual_amplitude_mm = (f.semiannual.amplitude * 1000).toFixed(3);
        row.semiannual_amplitude_std_mm = (f.semiannual.amplitudeStd * 1000).toFixed(3);
      }
      row.rms_mm = (f.rms * 1000).toFixed(3);
      row.n_used = f.nUsed;
      row.n_outliers = f.nOutliers;
      row.mid_epoch = new Date(f.tMid).toISOString().slice(0, 10);
    } else {
      row.error = "model not estimable";
    }
    return row;
  });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return `${[columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n")}\n`;
}

export function modelLabel(fit: FitSettings): string {
  const parts = [["offset", "linear", "quadratic", "cubic"][fit.polyOrder]];
  if (fit.annual) parts.push("annual");
  if (fit.semiannual) parts.push("semi-annual");
  if (fit.steps.length) parts.push(`${fit.steps.length} step(s)`);
  if (fit.rejectOutliers) parts.push("3σ outliers");
  return parts.join(" + ");
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

export function renderChartPanel(container: HTMLElement, controller: DispController): () => void {
  const root = el("div", { className: "od-chart-panel" });
  const setFit = (patch: Partial<FitSettings>) => controller.update({ fit: { ...controller.state.fit, ...patch } });
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const srcOpts = (): SourceOptions => ({ source: controller.state.tsSource, cubeVariable: controller.state.cubeVariable });

  // Row 1: reference, view, zoom, export
  const refSelect = el("select", { className: "od-input od-input-inline", ariaLabel: "Reference series" });
  refSelect.addEventListener("change", () => controller.picks.setReference(refSelect.value ? Number(refSelect.value) : null));
  const view = el("select", { className: "od-input od-input-inline", ariaLabel: "View" });
  view.append(new Option("data", "data"), new Option("residuals (data − model)", "residuals"));
  view.addEventListener("change", () => controller.update({ tsView: view.value as DispState["tsView"] }));
  const source = el("select", { className: "od-input od-input-inline", ariaLabel: "Source" });
  source.append(new Option("ASF + cubes", "both"), new Option("ASF service", "asf"), new Option("downloaded cubes", "cube"));
  source.addEventListener("change", () => controller.update({ tsSource: source.value as DispState["tsSource"] }));
  const cubeVar = el("select", { className: "od-input od-input-inline", ariaLabel: "Cube layer", title: "Variable read from downloaded cubes" });
  cubeVar.append(new Option("full displacement", "displacement"), new Option("short-wavelength", "short_wavelength_displacement"));
  cubeVar.addEventListener("change", () => controller.update({ cubeVariable: cubeVar.value as DispState["cubeVariable"] }));
  const resetBtn = el("button", { type: "button", className: "od-btn", textContent: "Reset zoom", title: "Or double-click the chart" });
  const exportBtn = el("button", { type: "button", className: "od-btn", textContent: "Export CSV", title: "Data, model and residuals per epoch" });
  exportBtn.addEventListener("click", () =>
    downloadText(
      `opera_disp_timeseries_${stamp()}.csv`,
      picksCsv(controller.picks.picks, controller.picks.reference, controller.state.fit, controller.state.showFit, srcOpts()),
    ),
  );
  const exportFitBtn = el("button", { type: "button", className: "od-btn", textContent: "Export fit", title: "Model parameters ± 1σ per series" });
  exportFitBtn.addEventListener("click", () =>
    downloadText(`opera_disp_fit_${stamp()}.csv`, fitCsv(controller.picks.picks, controller.picks.reference, controller.state.fit, srcOpts())),
  );
  const pngBtn = el("button", { type: "button", className: "od-btn", textContent: "Save PNG", title: "Chart with its legend as an image" });
  const clearBtn = el("button", { type: "button", className: "od-btn", textContent: "Clear" });
  clearBtn.addEventListener("click", () => controller.picks.clear());
  const row1 = el(
    "div",
    { className: "od-chart-toolbar" },
    el("label", {}, "Relative to ", refSelect),
    el("label", {}, "Show ", view),
    el("label", {}, "Source ", source),
    el("label", {}, "Cube ", cubeVar),
    resetBtn,
    exportBtn,
    exportFitBtn,
    pngBtn,
    clearBtn,
  );

  // Row 2: model
  const showFit = el("input", { type: "checkbox", checked: controller.state.showFit });
  showFit.addEventListener("change", () => controller.update({ showFit: showFit.checked }));
  const modelOnly = el("input", { type: "checkbox", checked: controller.state.tsModelOnly });
  modelOnly.addEventListener("change", () => controller.update({ tsModelOnly: modelOnly.checked, ...(modelOnly.checked ? { showFit: true } : {}) }));
  const legendBox = el("input", { type: "checkbox", checked: controller.state.tsLegend });
  legendBox.addEventListener("change", () => controller.update({ tsLegend: legendBox.checked }));
  const order = el("select", { className: "od-input od-input-inline", ariaLabel: "Polynomial order" });
  order.append(new Option("0 offset", "0"), new Option("1 linear", "1"), new Option("2 quadratic", "2"), new Option("3 cubic", "3"));
  order.addEventListener("change", () => setFit({ polyOrder: Number(order.value) as FitSettings["polyOrder"] }));
  const annual = el("input", { type: "checkbox" });
  annual.addEventListener("change", () => setFit({ annual: annual.checked }));
  const semi = el("input", { type: "checkbox" });
  semi.addEventListener("change", () => setFit({ semiannual: semi.checked }));
  const outliers = el("input", { type: "checkbox" });
  outliers.addEventListener("change", () => setFit({ rejectOutliers: outliers.checked }));
  const row2 = el(
    "div",
    { className: "od-chart-toolbar" },
    el("label", {}, showFit, " Model"),
    el("label", { title: "Hide the data points; keep the fitted curves" }, modelOnly, " model only"),
    el("label", { title: "Legend inside the chart (kept in screenshots and Save PNG)" }, legendBox, " legend"),
    el("label", {}, "polynomial ", order),
    el("label", {}, annual, " annual"),
    el("label", {}, semi, " semi-annual"),
    el("label", {}, outliers, " reject 3σ outliers"),
  );

  // Row 3: steps
  const stepDate = el("input", { type: "date", className: "od-input od-input-inline", ariaLabel: "Step date" });
  const addStepBtn = el("button", { type: "button", className: "od-btn", textContent: "Add step" });
  const clickStep = el("button", { type: "button", className: "od-btn", textContent: "Pick step on chart", ariaPressed: "false" });
  const stepChips = el("span", { className: "od-chips" });
  const addStep = (iso: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    const steps = [...new Set([...controller.state.fit.steps, iso])].sort().slice(0, 20);
    setFit({ steps });
  };
  addStepBtn.addEventListener("click", () => addStep(stepDate.value));
  const row3 = el("div", { className: "od-chart-toolbar" }, "Steps:", stepChips, stepDate, addStepBtn, clickStep);

  // Shown while any series is being fetched: ASF's service reads the OPERA products from
  // NASA Earthdata, which takes 10-30 s per point and direction.
  const loading = el("div", { className: "od-loading", role: "status", ariaLive: "polite", hidden: true });
  const loadingText = el("span");
  loading.append(el("span", { className: "od-spinner", ariaHidden: "true" }), loadingText);
  let loadingSince: number | null = null;
  let loadingTimer: ReturnType<typeof setInterval> | null = null;
  const updateLoading = (picks: Pick[]) => {
    const all = picks.flatMap((p) => [p.results.asc, p.results.desc]);
    const pending = all.filter((r) => r.status === "loading").length;
    if (!pending) {
      loading.hidden = true;
      loadingSince = null;
      if (loadingTimer) clearInterval(loadingTimer);
      loadingTimer = null;
      return;
    }
    loadingSince ??= Date.now();
    const render = () => {
      const secs = Math.round((Date.now() - (loadingSince ?? Date.now())) / 1000);
      loadingText.textContent =
        `Retrieving time series from NASA Earthdata (OPERA DISP-S1 via ASF)… ` +
        `${all.length - pending} of ${all.length} series ready · ${secs} s (usually 10–30 s)`;
    };
    render();
    loadingTimer ??= setInterval(render, 1000);
    loading.hidden = false;
  };

  const chartHost = el("div");
  const note = el("p", {
    className: "od-muted",
    textContent:
      "Drag to zoom time, mouse wheel to zoom around the cursor, double-click or Reset zoom for the full range; " +
      "click a legend entry to hide a series. Filled dots ascending, rings descending, grey rings excluded outliers, " +
      "red dashed lines steps; lines are downloaded cubes. Rate is at the mid-epoch; ± are formal 1σ. " +
      "ASF service: short-wavelength LOS; cubes: full (or short-wavelength) LOS, positive towards the satellite.",
  });
  root.append(row1, row2, row3, loading, chartHost, note);
  container.append(root);

  const chart = new TimeseriesChart(chartHost, {
    onAddStep: (t) => {
      addStep(new Date(t).toISOString().slice(0, 10));
      setAdding(false);
    },
  });
  const setAdding = (on: boolean) => {
    chart.setAddingStep(on);
    clickStep.ariaPressed = String(on);
    clickStep.classList.toggle("od-active", on);
    clickStep.textContent = on ? "Click the chart…" : "Pick step on chart";
  };
  clickStep.addEventListener("click", () => setAdding(!chart.addingStep));
  resetBtn.addEventListener("click", () => chart.resetZoom());
  pngBtn.addEventListener("click", () => {
    const url = chart.toPng();
    if (!url) return;
    const a = el("a", { href: url, download: `opera_disp_timeseries_${stamp()}.png` });
    a.click();
  });

  const renderChips = (steps: string[]) => {
    stepChips.replaceChildren(
      ...(steps.length
        ? steps.map((d) => {
            const x = el("button", { type: "button", className: "od-icon-btn", textContent: "×", title: `Remove step ${d}` });
            x.addEventListener("click", () => setFit({ steps: controller.state.fit.steps.filter((s) => s !== d) }));
            return el("span", { className: "od-chip" }, d, x);
          })
        : [el("span", { className: "od-muted", textContent: "none" })]),
    );
  };

  const syncControls = (state: DispState) => {
    showFit.checked = state.showFit;
    modelOnly.checked = state.tsModelOnly;
    legendBox.checked = state.tsLegend;
    order.value = String(state.fit.polyOrder);
    annual.checked = state.fit.annual;
    semi.checked = state.fit.semiannual;
    outliers.checked = state.fit.rejectOutliers;
    view.value = state.tsView;
    source.value = state.tsSource;
    cubeVar.value = state.cubeVariable;
    renderChips(state.fit.steps);
  };

  const unsubscribe = controller.subscribe({
    onPicks: (picks, reference) => {
      refSelect.replaceChildren(new Option("nothing (absolute)", ""));
      for (const p of picks) refSelect.add(new Option(p.label, String(p.id)));
      refSelect.value = reference ? String(reference.id) : "";
      const hasData = picks.some((p) => p.results.asc.series || p.results.desc.series);
      exportBtn.disabled = !hasData;
      exportFitBtn.disabled = !hasData;
      updateLoading(picks);
      chart.update(picks, {
        modelOnly: controller.state.tsModelOnly,
        legend: controller.state.tsLegend,
        showFit: controller.state.showFit,
        reference,
        fit: controller.state.fit,
        view: controller.state.tsView,
        source: controller.state.tsSource,
        cubeVariable: controller.state.cubeVariable,
      });
    },
    onState: syncControls,
  });

  return () => {
    unsubscribe();
    if (loadingTimer) clearInterval(loadingTimer);
    chart.destroy();
    root.remove();
  };
}

export { describeFit };
