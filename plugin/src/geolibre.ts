/**
 * GeoLibre plugin entry: OPERA DISP velocity overview (Phase 1b).
 *
 * Load it in GeoLibre web with a project that lists this manifest, e.g.
 * https://web.geolibre.app/?url=http://localhost:8790/project.json
 */
import { DispController } from "./controller";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./host-api";
import { renderAnalysisPanel } from "./analysis-panel";
import { renderChartPanel } from "./chart-panel";
import { renderDownloadSection, renderJobsPanel } from "./downloads";
import { renderProductsPanel } from "./products";
import { PLUGIN_VERSION, renderPanel } from "./panel";
import { TsModeControl } from "./ts-mode-control";
import { loadLocal, rememberedState, saveLocal } from "./local-store";
import { parseSavedPicks, type SavedPick } from "./picks";
import { type DispState, parseState, stateFromUrl } from "./state";
import "./style.css";

export const PLUGIN_ID = "opera-disp";
export const PANEL_ID = "opera-disp-panel";
export const CHART_PANEL_ID = "opera-disp-timeseries";
export const ANALYSIS_PANEL_ID = "opera-disp-analysis";
export const JOBS_PANEL_ID = "opera-disp-downloads";
export const PRODUCTS_PANEL_ID = "opera-disp-products";
export const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";
export const ANNOTATIONS_PLUGIN_ID = "maplibre-gl-annotations";

/** Switch on GeoLibre's drawing tools (GeoEditor) and leave time-series mode so clicks draw. */
async function startDrawing(app: GeoLibreAppAPI): Promise<boolean> {
  controller?.update({ tsOnClick: false });
  return (await app.activatePlugin?.(GEO_EDITOR_PLUGIN_ID)) ?? false;
}
const MAP_WAIT_MS = 15_000;

let controller: DispController | null = null;
let pendingState: Partial<DispState> = {};
let disposers: (() => void)[] = [];
let mapPoll: ReturnType<typeof setInterval> | null = null;
/**
 * GeoLibre re-applies the project's plugin settings as they were at load time after
 * some host changes (e.g. a basemap switch), which would undo the user's newer choices.
 * There is no API to report plugin state changes, so skip a re-application of the
 * exact payload already applied.
 */
let lastAppliedState: string | null = null;
/** Picks from a project applied before the controller existed. */
let pendingPicks: { picks: SavedPick[]; reference: string | null } | null = null;

function restorePicks(saved: { picks: SavedPick[]; reference: string | null }): void {
  if (!controller) {
    pendingPicks = saved;
    return;
  }
  const current = JSON.stringify(controller.picks.toSaved());
  if (current !== JSON.stringify(saved)) controller.picks.restore(saved.picks, saved.reference);
}

/** The host map can appear after activation (engine start-up); poll briefly for it. */
function whenMapReady(app: GeoLibreAppAPI, onReady: (map: NonNullable<ReturnType<NonNullable<GeoLibreAppAPI["getMap"]>>>) => void): void {
  const started = Date.now();
  const tryAttach = () => {
    const map = app.getMap?.();
    if (map) {
      if (mapPoll) clearInterval(mapPoll);
      mapPoll = null;
      onReady(map);
      return true;
    }
    if (Date.now() - started > MAP_WAIT_MS) {
      if (mapPoll) clearInterval(mapPoll);
      mapPoll = null;
      console.warn("[opera-disp] no MapLibre map from the host; switch the renderer to MapLibre");
    }
    return false;
  };
  if (!tryAttach()) mapPoll = setInterval(tryAttach, 250);
}

function openFloating(app: GeoLibreAppAPI, id: string): void {
  if (app.getOpenFloatingPanels?.().includes(id)) return;
  app.openFloatingPanel?.(id);
}

function openChart(app: GeoLibreAppAPI): void {
  openFloating(app, CHART_PANEL_ID);
}

export const plugin: GeoLibrePlugin = {
  id: PLUGIN_ID,
  name: "OPERA DISP",
  version: PLUGIN_VERSION, // must match geolibre-plugin/plugin.json
  urlParameterNames: ["dispOverview", "dir", "dispProxy"],
  restoresPanelCollapseState: true,

  activate(app) {
    // Diagnostics handle for check scripts (map/layer inspection from the page).
    (window as unknown as { __operaDispApp?: unknown }).__operaDispApp = app;
    controller = new DispController(app);
    // Settings and points from this browser's last session (a project applied later wins).
    const local = loadLocal();
    if (local) {
      controller.update(parseState(local.state));
      if (!pendingPicks && local.picks?.length) {
        pendingPicks = { picks: parseSavedPicks(local.picks), reference: local.reference ?? null };
      }
    }
    controller.update(pendingState);
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!controller) return;
        const saved = controller.picks.toSaved();
        saveLocal({ state: rememberedState(controller.state), picks: saved.picks, reference: saved.reference });
      }, 500);
    };
    disposers.push(controller.subscribe({ onState: persist, onPicks: persist }));
    disposers.push(() => saveTimer && clearTimeout(saveTimer));

    const unregister = app.registerRightPanel?.({
      id: PANEL_ID,
      title: "OPERA DISP",
      defaultWidth: 320,
      onOpen: () => controller?.update({ panelOpen: true }),
      onCollapse: () => controller?.update({ panelOpen: false }),
      render: (container) =>
        controller
          ? renderPanel(container, controller, {
              addDrawn: app.getDrawnFeatures ? () => controller?.addPicksFromFeatures(app.getDrawnFeatures?.() ?? []) ?? 0 : undefined,
              addSelected: app.getSelectedFeatures
                ? () => controller?.addPicksFromFeatures(app.getSelectedFeatures?.() ?? []) ?? 0
                : undefined,
              openChart: () => openChart(app),
              openAnalysis: app.registerFloatingPanel ? () => openFloating(app, ANALYSIS_PANEL_ID) : undefined,
              downloadSection: () =>
                renderDownloadSection(
                  app,
                  controller!,
                  () => openFloating(app, JOBS_PANEL_ID),
                  () => startDrawing(app),
                  () => openFloating(app, PRODUCTS_PANEL_ID),
                ),
              startDrawing: app.activatePlugin ? () => startDrawing(app) : undefined,
              stopDrawing: app.deactivatePlugin ? () => app.deactivatePlugin?.(GEO_EDITOR_PLUGIN_ID) ?? false : undefined,
              stopAnnotations: app.deactivatePlugin ? () => app.deactivatePlugin?.(ANNOTATIONS_PLUGIN_ID) ?? false : undefined,
              startAnnotations: app.activatePlugin
                ? async () => {
                    controller?.update({ tsOnClick: false });
                    return (await app.activatePlugin?.(ANNOTATIONS_PLUGIN_ID)) ?? false;
                  }
                : undefined,
              goTo: (r) => {
                if (r.bbox) app.fitBounds?.(r.bbox);
                else {
                  const d = 0.01;
                  app.fitBounds?.([r.lon - d, r.lat - d, r.lon + d, r.lat + d]);
                }
              },
            })
          : undefined,
    });
    if (unregister) {
      disposers.push(() => {
        app.closeRightPanel?.(PANEL_ID);
        unregister();
      });
      if (controller.state.panelOpen) app.openRightPanel?.(PANEL_ID);
    }
    const unregisterChart = app.registerFloatingPanel?.({
      id: CHART_PANEL_ID,
      title: "OPERA DISP time series",
      defaultWidth: 640,
      render: (container) => (controller ? renderChartPanel(container, controller) : undefined),
    });
    if (unregisterChart) {
      disposers.push(() => {
        app.closeFloatingPanel?.(CHART_PANEL_ID);
        unregisterChart();
      });
    }
    const unregisterAnalysis = app.registerFloatingPanel?.({
      id: ANALYSIS_PANEL_ID,
      title: "OPERA DISP analysis",
      defaultWidth: 700,
      render: (container) => (controller ? renderAnalysisPanel(container, controller) : undefined),
    });
    if (unregisterAnalysis) {
      disposers.push(() => {
        app.closeFloatingPanel?.(ANALYSIS_PANEL_ID);
        unregisterAnalysis();
      });
    }
    const unregisterJobs = app.registerFloatingPanel?.({
      id: JOBS_PANEL_ID,
      title: "OPERA DISP downloads",
      defaultWidth: 560,
      render: (container) => (controller ? renderJobsPanel(container, app, controller) : undefined),
    });
    if (unregisterJobs) {
      disposers.push(() => {
        app.closeFloatingPanel?.(JOBS_PANEL_ID);
        unregisterJobs();
      });
    }
    const unregisterProducts = app.registerFloatingPanel?.({
      id: PRODUCTS_PANEL_ID,
      title: "OPERA DISP velocity products",
      defaultWidth: 600,
      render: (container) => (controller ? renderProductsPanel(container, app, controller) : undefined),
    });
    if (unregisterProducts) {
      disposers.push(() => {
        app.closeFloatingPanel?.(PRODUCTS_PANEL_ID);
        unregisterProducts();
      });
    }
    // Bring the chart up when a new time series is requested.
    disposers.push(controller.subscribe({ onPickAdded: () => openChart(app) }));

    const unregisterMenu = app.registerToolbarMenu?.({
      id: `${PLUGIN_ID}-menu`,
      label: "OPERA DISP",
      items: [
        { id: `${PLUGIN_ID}-open-panel`, label: "Open panel", onSelect: () => app.openRightPanel?.(PANEL_ID) },
        { id: `${PLUGIN_ID}-open-chart`, label: "Open time-series chart", onSelect: () => openChart(app) },
        { id: `${PLUGIN_ID}-open-analysis`, label: "Open analysis results", onSelect: () => openFloating(app, ANALYSIS_PANEL_ID) },
        { id: `${PLUGIN_ID}-open-downloads`, label: "Open downloads", onSelect: () => openFloating(app, JOBS_PANEL_ID) },
        { id: `${PLUGIN_ID}-open-products`, label: "Velocity products", onSelect: () => openFloating(app, PRODUCTS_PANEL_ID) },
        { id: `${PLUGIN_ID}-annotations`, label: "Annotations", onSelect: () => void app.activatePlugin?.(ANNOTATIONS_PLUGIN_ID) },
        { id: `${PLUGIN_ID}-draw`, label: "Draw polygon", onSelect: () => void startDrawing(app) },
      ],
    });
    if (unregisterMenu) disposers.push(unregisterMenu);

    // Map button for time-series mode (off by default).
    if (app.addMapControl) {
      const tsControl = new TsModeControl(controller);
      if (app.addMapControl(tsControl, "top-right")) disposers.push(() => app.removeMapControl?.(tsControl));
    }

    whenMapReady(app, (map) => {
      controller?.attach(map);
      if (pendingPicks) {
        const saved = pendingPicks;
        pendingPicks = null;
        restorePicks(saved);
      }
    });
  },

  deactivate() {
    lastAppliedState = null;
    if (controller) pendingPicks = controller.picks.toSaved();
    if (mapPoll) clearInterval(mapPoll);
    mapPoll = null;
    if (controller) pendingState = controller.state;
    controller?.detach();
    controller = null;
    for (const dispose of disposers.splice(0)) dispose();
    disposers = [];
  },

  handleUrlParameters(_app, params) {
    const patch = stateFromUrl(params);
    if (controller) controller.update(patch);
    else pendingState = { ...pendingState, ...patch };
  },

  getProjectState() {
    // Time-series picks are saved with the project (geometry + label; series re-fetched on load).
    const saved = controller?.picks.toSaved() ?? pendingPicks ?? { picks: [], reference: null };
    return { ...(controller?.state ?? pendingState), picks: saved.picks, referencePick: saved.reference };
  },

  applyProjectState(app, state) {
    const serialized = JSON.stringify(state ?? null);
    if (serialized === lastAppliedState) return;
    lastAppliedState = serialized;
    const patch = parseState(state);
    pendingState = { ...pendingState, ...patch };
    controller?.update(patch);
    const raw = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    if (Array.isArray(raw.picks)) {
      restorePicks({
        picks: parseSavedPicks(raw.picks),
        reference: typeof raw.referencePick === "string" ? raw.referencePick : null,
      });
    }
    if (controller && patch.panelOpen === true) app.openRightPanel?.(PANEL_ID);
    if (controller && patch.panelOpen === false) app.collapseRightPanel?.(PANEL_ID);
  },
};

export default plugin;
