/** Right-sidebar panel (plain DOM, as GeoLibre's panel contract requires). */
import type { DispController, IdentifyResult } from "./controller";
import type { Pick } from "./picks";
import { renderSearchSection, type SearchResult } from "./search";
import type { Basemap, ExtentInfo, ValueResult } from "./services";
import type { DispState } from "./state";
import { button, card, el, field, segmented, switchRow } from "./ui";

export function formatVelocity(v: ValueResult | null): string {
  if (!v) return "unavailable";
  if (v.value === null) return "no data";
  const mm = v.value * 1000;
  const prefix = v.clipped ? (mm < 0 ? "≤ " : "≥ ") : "";
  return `${prefix}${mm >= 0 ? "+" : ""}${mm.toFixed(1)} mm/yr`;
}

export interface PanelActions {
  /** Add the user's drawn shapes as picks; returns how many were usable. */
  addDrawn?: () => number;
  /** Add the selected features as picks; returns how many were usable. */
  addSelected?: () => number;
  openChart?: () => void;
  openAnalysis?: () => void;
  /** Builds the "Download subset" section (needs the host app). */
  downloadSection?: () => HTMLElement;
  /** Switch on GeoLibre's drawing tools (GeoEditor). */
  startDrawing?: () => Promise<boolean>;
  /** Switch on GeoLibre's annotation tools. */
  startAnnotations?: () => Promise<boolean>;
  /** Switch the drawing / annotation tools off again. */
  stopDrawing?: () => boolean;
  stopAnnotations?: () => boolean;
  /** Move the map to a search result. */
  goTo?: (r: SearchResult) => void;
}

function pickStatus(pick: Pick): string {
  const part = (d: "asc" | "desc") => {
    const r = pick.results[d];
    if (r.status === "loading") return `${d} …`;
    if (r.status === "error") return `${d} –`;
    return `${d} ${r.series!.points.length}`;
  };
  return `${part("asc")} · ${part("desc")}`;
}

export const PLUGIN_VERSION = "0.3.0";

export function renderPanel(container: HTMLElement, controller: DispController, actions: PanelActions = {}): () => void {
  const s = controller.state;
  const root = el("div", { className: "od-panel" });

  // Connection
  const proxyDot = el("span", { className: "od-dot" });
  const proxyText = el("span", { textContent: "disp-proxy" });
  const proxyInput = el("input", { type: "url", value: s.proxyUrl, className: "od-input", ariaLabel: "disp-proxy URL" });
  proxyInput.addEventListener("change", () => controller.update({ proxyUrl: proxyInput.value.trim().replace(/\/+$/, "") }));
  const offlineNote = el("div", { className: "od-notice", hidden: true });
  const header = el(
    "div",
    { className: "od-header" },
    el("span", { className: "od-status" }, proxyDot, proxyText),
    el("span", { className: "od-version", textContent: `v${PLUGIN_VERSION}` }),
  );
  const connection = card(
    "Settings",
    { id: "settings", open: false },
    field("disp-proxy URL", proxyInput),
    el("p", { className: "od-muted", textContent: "Server for tiles, time series, downloads and products." }),
  );

  // Velocity
  const show = el("input", { type: "checkbox", checked: s.visible, ariaLabel: "Show velocity overview" });
  show.addEventListener("change", () => controller.update({ visible: show.checked }));
  const dirAsc = el("input", { checked: s.direction === "asc" });
  const dirDesc = el("input", { checked: s.direction === "desc" });
  for (const r of [dirAsc, dirDesc]) r.addEventListener("change", () => r.checked && controller.update({ direction: r.value as "asc" | "desc" }));
  const opacity = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(s.opacity), className: "od-range" });
  opacity.addEventListener("input", () => controller.update({ opacity: Number(opacity.value) }));
  const bar = el("div", { className: "od-bar" });
  const tickLo = el("span");
  const tickHi = el("span");
  const legendNote = el("p", { className: "od-muted" });
  const velocity = card(
    "Velocity (LOS)",
    { id: "velocity" },
    switchRow(show, "Show velocity overview"),
    segmented("od-dir", [
      { value: "asc", label: "Ascending", input: dirAsc },
      { value: "desc", label: "Descending", input: dirDesc },
    ]),
    el("label", { className: "od-row od-opacity" }, el("span", { className: "od-field-label", textContent: "Opacity" }), opacity),
    el("div", { className: "od-legend" }, bar, el("div", { className: "od-ticks" }, tickLo, el("span", { textContent: "0" }), tickHi)),
    legendNote,
  );

  // Basemap
  const basemapSelect = el("select", { className: "od-input", ariaLabel: "Basemap" });
  basemapSelect.addEventListener("change", () => controller.update({ basemap: basemapSelect.value || null }));
  const labels = el("input", { type: "checkbox", checked: s.labelsOnTop });
  labels.addEventListener("change", () => controller.update({ labelsOnTop: labels.checked }));


  // Frames
  const frames = el("input", { type: "checkbox", checked: s.showFrames });
  frames.addEventListener("change", () => controller.update({ showFrames: frames.checked }));
  const frameList = el("p", { className: "od-muted" });


  // Identify
  const identify = el("input", { type: "checkbox", checked: s.identify });
  identify.addEventListener("change", () => controller.update({ identify: identify.checked }));
  const readout = el("div", { className: "od-readout" }, el("p", { className: "od-muted", textContent: "Click the map to read the velocity." }));
  const mapSection = card(
    "Map",
    { id: "map", open: false },
    field("Basemap", basemapSelect),
    switchRow(labels, "Labels above velocity", "Light and Dark basemaps"),
    switchRow(frames, "Outline OPERA frames in view"),
    frameList,
    switchRow(identify, "Click map for value"),
    readout,
  );

  // Analyze a user layer
  const layerSelect = el("select", { className: "od-input", ariaLabel: "Layer to analyse" });
  const fillLayers = () => {
    const keep = layerSelect.value;
    layerSelect.replaceChildren(
      el("option", { value: "drawn", textContent: "Drawn shapes" }),
      el("option", { value: "selection", textContent: "Selected features" }),
    );
    for (const l of controller.analyzableLayers()) layerSelect.append(el("option", { value: l.id, textContent: l.name }));
    if ([...layerSelect.options].some((o) => o.value === keep)) layerSelect.value = keep;
    else if (layerSelect.options.length > 2) layerSelect.selectedIndex = 2;
  };
  layerSelect.addEventListener("focus", fillLayers);
  layerSelect.addEventListener("pointerdown", fillLayers);
  fillLayers();
  const sourceChoice = el("select", { className: "od-input", ariaLabel: "Velocity from" });
  sourceChoice.append(
    el("option", { value: "asf", textContent: "ASF overview tiles" }),
    el("option", { value: "cube", textContent: "downloaded cubes" }),
  );
  const dirChoice = el("select", { className: "od-input", ariaLabel: "Directions" });
  dirChoice.append(
    el("option", { value: "both", textContent: "asc + desc" }),
    el("option", { value: "asc", textContent: "ascending" }),
    el("option", { value: "desc", textContent: "descending" }),
  );
  const threshold = el("input", { type: "number", value: "5", min: "0", step: "0.5", className: "od-input od-num", ariaLabel: "Hotspot threshold mm/yr" });
  const step = el("input", { type: "number", value: "30", min: "5", step: "5", className: "od-input od-num", ariaLabel: "Line sampling step m" });
  const minValid = el("input", { type: "number", value: "25", min: "0", max: "100", step: "5", className: "od-input od-num", ariaLabel: "Minimum valid pixels percent" });
  const runBtn = el("button", { type: "button", className: "od-btn od-primary", textContent: "Analyze" });
  const resultsBtn = el("button", { type: "button", className: "od-btn", textContent: "Open results", disabled: !actions.openAnalysis });
  resultsBtn.addEventListener("click", () => actions.openAnalysis?.());
  const analysisStatus = el("p", { className: "od-muted", textContent: "Adds a copy of the layer with velocity attributes (mm/yr)." });
  runBtn.addEventListener("click", () => {
    const directions = dirChoice.value === "both" ? (["asc", "desc"] as const) : ([dirChoice.value] as ["asc" | "desc"]);
    actions.openAnalysis?.();
    void controller.analyze(layerSelect.value, {
      directions: [...directions],
      thresholdMm: Math.max(0, Number(threshold.value) || 0),
      stepM: Math.max(5, Number(step.value) || 30),
      minValidPct: Math.min(100, Math.max(0, Number(minValid.value) || 0)),
      source: sourceChoice.value as "asf" | "cube",
    });
  });
  const analysisSection = card(
    "Analyze layer",
    { id: "analyze", open: false },
    field("Layer", layerSelect),
    field("Velocity from", sourceChoice),
    field("Directions", dirChoice),
    field("Hotspot ≥", threshold, el("span", { className: "od-unit", textContent: "mm/yr |median|" })),
    field("Min. valid pixels", minValid, el("span", { className: "od-unit", textContent: "%" })),
    field("Line sampling", step, el("span", { className: "od-unit", textContent: "m" })),
    el("div", { className: "od-row od-buttons" }, runBtn, resultsBtn),
    analysisStatus,
  );

  // Time series
  const tsOnClick = el("input", { type: "checkbox", checked: s.tsOnClick, ariaLabel: "Time-series mode" });
  tsOnClick.addEventListener("change", () => controller.update({ tsOnClick: tsOnClick.checked }));
  const tsMessage = el("p", { className: "od-muted" });
  const addFrom = (fn: (() => number) | undefined, what: string) => () => {
    const n = fn?.() ?? 0;
    tsMessage.textContent = n ? `Added ${n} ${what}.` : `No ${what} with a point or polygon geometry.`;
  };
  const pickList = el("ul", { className: "od-picks" });
  const pickCount = el("span", { className: "od-badge" });
  const tsSection = card(
    "Time series",
    { id: "timeseries", badge: pickCount },
    switchRow(tsOnClick, "Time-series mode", "Each map click adds a point (map button 📈)"),
    el(
      "div",
      { className: "od-row od-buttons" },
      button("Open chart", () => actions.openChart?.(), { primary: true, enabled: Boolean(actions.openChart) }),
      button("Add drawn", addFrom(actions.addDrawn, "drawn shape(s)"), { enabled: Boolean(actions.addDrawn), title: "Add the shapes drawn with Draw polygon" }),
      button("Add selected", addFrom(actions.addSelected, "selected feature(s)"), { enabled: Boolean(actions.addSelected), title: "Add the selected map features" }),
    ),
    tsMessage,
    pickList,
  );

  const caveat = el("p", {
    className: "od-muted od-caveat",
    textContent:
      "ASF overview: short-wavelength displacement only, quantized to 0.24 mm/yr and clipped at ±30 mm/yr; " +
      "line-of-sight values.",
  });

  const downloadSection = actions.downloadSection?.();
  const searchSection = actions.goTo
    ? renderSearchSection(actions.goTo, (r) => {
        actions.goTo?.(r);
        controller.addPick({ type: "Point", coordinates: [r.lon, r.lat] });
      })
    : null;

  // Map tools: GeoLibre's own drawing and annotation plugins.
  const toolsMessage = el("p", { className: "od-muted" });
  // Toggle buttons: first click switches the GeoLibre tool on, second click switches it off.
  const toolButton = (
    label: string,
    title: string,
    fn: (() => Promise<boolean>) | undefined,
    okText: string,
    stop?: () => boolean,
  ) => {
    const b = el("button", { type: "button", className: "od-btn od-toggle", textContent: label, title, disabled: !fn });
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", async () => {
      if (b.getAttribute("aria-pressed") === "true") {
        const off = stop?.() ?? false;
        b.setAttribute("aria-pressed", "false");
        toolsMessage.textContent = off ? `${label} off.` : `${label}: close it from the Plugins menu.`;
        return;
      }
      const ok = await fn?.();
      b.setAttribute("aria-pressed", String(Boolean(ok)));
      toolsMessage.textContent = ok ? `${okText} Click again to switch it off.` : `Could not start ${label}; open it from the Plugins menu.`;
    });
    return b;
  };
  const toolsSection = card(
    "Map tools",
    { id: "tools" },
    el(
      "div",
      { className: "od-row od-buttons" },
      toolButton("Draw polygon", "GeoLibre GeoEditor", actions.startDrawing, "Drawing tools on: use the GeoEditor toolbar on the map.", actions.stopDrawing),
      toolButton("Annotations", "GeoLibre Annotations: text, arrows, shapes on the map", actions.startAnnotations, "Annotation tools on: use the Annotations toolbar on the map.", actions.stopAnnotations),
    ),
    toolsMessage,
    el("div", { className: "od-group-label", textContent: "Demo" }),
    el(
      "div",
      { className: "od-row od-buttons" },
      button(
        "Roads · geology · 3D buildings",
        () => {
          if (!confirm("Open the demo project (Overture roads and 3D buildings, USGS geology WMS)? Save your current project first if you need it.")) return;
          const project = controller.proxyOk || !controller.site?.demoProject
            ? `${controller.state.proxyUrl}/demo/context-layers.geolibre`
            : controller.site.demoProject;
          window.location.href = `${new URL("./", window.location.href).href}?url=${encodeURIComponent(project)}`;
        },
        { title: "GeoLibre project with PMTiles (Overture) and WMS (USGS) layers, tilted for 3D" },
      ),
    ),
  );
  root.append(
    header,
    offlineNote,
    ...(searchSection ? [searchSection] : []),
    velocity,
    tsSection,
    toolsSection,
    ...(downloadSection ? [downloadSection] : []),
    analysisSection,
    mapSection,
    connection,
    caveat,
  );
  container.appendChild(root);

  const fillBasemaps = (list: Basemap[]) => {
    basemapSelect.replaceChildren(el("option", { value: "", textContent: "GeoLibre default" }));
    for (const b of list) basemapSelect.append(el("option", { value: b.key, textContent: b.name }));
    basemapSelect.value = controller.state.basemap ?? "";
  };
  fillBasemaps(controller.basemaps);

  const unsubscribe = controller.subscribe({
    onState: (state: DispState) => {
      show.checked = state.visible;
      dirAsc.checked = state.direction === "asc";
      dirDesc.checked = state.direction === "desc";
      opacity.value = String(state.opacity);
      labels.checked = state.labelsOnTop;
      frames.checked = state.showFrames;
      identify.checked = state.identify;
      if (document.activeElement !== proxyInput) proxyInput.value = state.proxyUrl;
      basemapSelect.value = state.basemap ?? "";
    },
    onProxyStatus: (ok) => {
      const site = controller.site;
      offlineNote.hidden = ok;
      offlineNote.replaceChildren(
        el("strong", { textContent: site?.mode === "static" ? "Static demo" : "disp-proxy not connected" }),
        el("span", {
          textContent:
            (site?.note ? `${site.note} ` : "") +
            (site?.overview
              ? `Velocity overview mirrored from ASF up to zoom ${site.overview.maxzoom} (~${Math.round(40075016 / 256 / 2 ** site.overview.maxzoom * 0.87)} m). Time series (ASF), frames, ` +
                "search and map tools work. Full-resolution overview, identify, layer analysis, downloads and products " +
                "need disp-proxy: run it locally and enter its URL under Settings."
              : "Time series (ASF), frames, search and map tools work. The velocity overview, identify, layer analysis, " +
                "downloads and products need disp-proxy: run it locally and enter its URL under Settings."),
        }),
      );
      proxyDot.classList.toggle("od-ok", ok);
      proxyDot.classList.toggle("od-bad", !ok);
      proxyDot.title = ok ? "connected" : "not reachable";
      proxyText.textContent = ok ? "Connected to disp-proxy" : site?.mode === "static" ? "Static demo · no server" : "disp-proxy not reachable";
    },
    onExtent: (extent: ExtentInfo | null, error?: string) => {
      if (!extent) {
        legendNote.textContent = error ?? "";
        return;
      }
      const [lo, hi] = extent.scale_range.range;
      bar.style.background = `linear-gradient(to right, ${extent.legend_colors.join(",")})`;
      tickLo.textContent = `≤ ${(lo * 1000).toFixed(0)}`;
      tickHi.textContent = `≥ +${(hi * 1000).toFixed(0)} mm/yr`;
      const date = extent.tile_date ? new Date(extent.tile_date).toISOString().slice(0, 10) : "unknown";
      const mirror = (extent as ExtentInfo & { mirror?: { max_zoom: number; mirrored: string } }).mirror;
      legendNote.textContent = mirror
        ? `Tiles generated ${date} (ASF overview), mirrored ${mirror.mirrored} up to zoom ${mirror.max_zoom} ` +
          `(~${Math.round(40075016 / 256 / 2 ** mirror.max_zoom * 0.87)} m); ` +
          "run disp-proxy for full resolution."
        : `Tiles generated ${date} (ASF overview).`;
    },
    onBasemaps: fillBasemaps,
    onFrames: (ids, note) => {
      frameList.textContent = ids.length ? `${note}: ${ids.map((i) => `F${String(i).padStart(5, "0")}`).join(", ")}` : note;
    },
    onPicks: (picks: Pick[]) => {
      pickCount.textContent = picks.length ? `${picks.length} point${picks.length > 1 ? "s" : ""}` : "";
      pickList.replaceChildren(
        ...picks.map((p) => {
          const swatch = el("span", { className: "od-swatch" });
          swatch.style.setProperty("--od-color", p.color);
          const remove = el("button", { type: "button", className: "od-icon-btn", textContent: "×", title: `Remove ${p.label}` });
          remove.addEventListener("click", () => controller.picks.remove(p.id));
          const kind = p.geometry.type === "Point" ? `${p.anchor[0].toFixed(4)}, ${p.anchor[1].toFixed(4)}` : "polygon mean";
          const loading = p.results.asc.status === "loading" || p.results.desc.status === "loading";
          const spinner = loading ? [el("span", { className: "od-spinner od-spinner-sm", title: "Retrieving from Earthdata…" })] : [];
          return el("li", {}, swatch, el("strong", { textContent: p.label }), ...spinner, el("span", { className: "od-muted", textContent: ` ${kind} · ${pickStatus(p)}` }), remove);
        }),
      );
    },
    onAnalysis: (_analysis, message, running) => {
      analysisStatus.textContent = message;
      runBtn.disabled = running;
    },
    onIdentify: (result: IdentifyResult | null, pending: boolean) => {
      if (!result) {
        readout.replaceChildren(el("p", { className: "od-muted", textContent: "Identify is off." }));
        return;
      }
      const [lng, lat] = result.lngLat;
      const rows = pending
        ? [el("p", { className: "od-muted", textContent: "Reading…" })]
        : [
            el("div", { className: "od-kv" }, el("span", { textContent: "Ascending" }), el("strong", { textContent: formatVelocity(result.asc) })),
            el("div", { className: "od-kv" }, el("span", { textContent: "Descending" }), el("strong", { textContent: formatVelocity(result.desc) })),
            ...(result.error ? [el("p", { className: "od-error", textContent: result.error })] : []),
          ];
      readout.replaceChildren(el("p", { className: "od-coords", textContent: `${lng.toFixed(5)}, ${lat.toFixed(5)}` }), ...rows);
    },
  });

  return () => {
    unsubscribe();
    root.remove();
  };
}
