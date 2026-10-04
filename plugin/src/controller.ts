/** Plugin state + behaviour, independent of the panel DOM. */
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI } from "./host-api";
import {
  ANALYZE_CHUNK,
  type AnalysisOptions,
  type AnalysisRow,
  type AnalyzeStats,
  type InputFeature,
  buildRows,
  hotspotStyle,
  isAnalyzable,
  toResultCollection,
  velocityStyle,
} from "./analysis";
import { DispMapLayers } from "./map-layers";
import { type Pick, type PickGeometry, PickManager } from "./picks";
import { AsfClient, type Basemap, type ExtentInfo, ProxyClient, type ValueResult, bboxToWkt } from "./services";
import { DEFAULT_STATE, type DispState, type Direction } from "./state";
import { CubeClient } from "./cube-series";
import { TimeseriesClient } from "./timeseries";
import { type SiteConfig, loadSiteConfig } from "./site";
import { wktToGeometry } from "./wkt";

export const FRAMES_MIN_ZOOM = 5;
/**
 * GeoLibre drops plugin layers while it loads a project or rebuilds the style for a new
 * basemap. Layers that disappear within this window after either event are restored;
 * outside it a disappearance is the user's (Layers panel trash button).
 */
export const RESTORE_GRACE_MS = 20_000;
export const BASEMAP_GRACE_MS = 10_000;

export interface IdentifyResult {
  lngLat: [number, number];
  asc: ValueResult | null;
  desc: ValueResult | null;
  error?: string;
}

export interface ControllerEvents {
  onState?: (state: DispState) => void;
  onExtent?: (extent: ExtentInfo | null, error?: string) => void;
  onProxyStatus?: (ok: boolean) => void;
  onFrames?: (frameIds: number[], note: string) => void;
  onIdentify?: (result: IdentifyResult | null, pending: boolean) => void;
  onBasemaps?: (basemaps: Basemap[]) => void;
  /** Picks changed (added, loaded, removed, reference changed). */
  onPicks?: (picks: Pick[], reference: Pick | null) => void;
  /** A pick was added (the plugin opens the chart). */
  onPickAdded?: (pick: Pick) => void;
  /** Analysis progress or finished result. */
  onAnalysis?: (analysis: AnalysisResult | null, status: string, running: boolean) => void;
}

export interface AnalysisResult {
  sourceName: string;
  rows: AnalysisRow[];
  options: AnalysisOptions;
  resultLayerId: string | null;
  hotspotLayerId: string | null;
  skipped: number;
}

export class DispController {
  state: DispState = { ...DEFAULT_STATE };
  basemaps: Basemap[] = [];
  /** Static-site config (GitHub Pages build), null when served by disp-proxy. */
  site: SiteConfig | null = null;
  /** Last disp-proxy health result. */
  proxyOk = false;
  private listeners = new Set<ControllerEvents>();
  /** Last value of each event, replayed to a panel that mounts later. */
  private last: {
    extent?: [ExtentInfo | null, string | undefined];
    proxy?: boolean;
    frames?: [number[], string];
    identify?: [IdentifyResult | null, boolean];
    analysis?: [AnalysisResult | null, string, boolean];
  } = {};
  private analysisAbort: AbortController | null = null;
  private layers: DispMapLayers | null = null;
  private map: MapLibreMap | null = null;
  private proxy = new ProxyClient(DEFAULT_STATE.proxyUrl);
  private asf = new AsfClient(DEFAULT_STATE.tsApiUrl);
  readonly picks = new PickManager(
    new TimeseriesClient(DEFAULT_STATE.tsApiUrl),
    this.asf,
    () => this.picksChanged(),
    new CubeClient(DEFAULT_STATE.proxyUrl),
  );
  private framesTimer: ReturnType<typeof setTimeout> | null = null;
  private framesAbort: AbortController | null = null;
  private identifyAbort: AbortController | null = null;
  private disposers: (() => void)[] = [];
  /** Until this time, a missing velocity layer is re-added rather than treated as removed. */
  private restoreUntil = 0;

  private emit<K extends keyof ControllerEvents>(key: K, ...args: Parameters<NonNullable<ControllerEvents[K]>>): void {
    for (const l of this.listeners) (l[key] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }

  /** Emitters that remember the last value (see `subscribe`). */
  readonly events: Required<ControllerEvents> = {
    onState: (state) => this.emit("onState", state),
    onExtent: (extent, error) => {
      this.last.extent = [extent, error];
      this.emit("onExtent", extent, error);
    },
    onProxyStatus: (ok) => {
      this.last.proxy = ok;
      this.emit("onProxyStatus", ok);
    },
    onFrames: (ids, note) => {
      this.last.frames = [ids, note];
      this.emit("onFrames", ids, note);
    },
    onIdentify: (result, pending) => {
      this.last.identify = [result, pending];
      this.emit("onIdentify", result, pending);
    },
    onBasemaps: (list) => this.emit("onBasemaps", list),
    onPicks: (picks, reference) => this.emit("onPicks", picks, reference),
    onPickAdded: (pick) => this.emit("onPickAdded", pick),
    onAnalysis: (analysis, status, running) => {
      this.last.analysis = [analysis, status, running];
      this.emit("onAnalysis", analysis, status, running);
    },
  };

  constructor(private readonly app: GeoLibreAppAPI) {}

  /** Add UI listeners and replay the latest values. Returns an unsubscribe function. */
  subscribe(listeners: ControllerEvents): () => void {
    this.listeners.add(listeners);
    listeners.onState?.(this.state);
    listeners.onBasemaps?.(this.basemaps);
    if (this.last.proxy !== undefined) listeners.onProxyStatus?.(this.last.proxy);
    if (this.last.extent) listeners.onExtent?.(...this.last.extent);
    if (this.last.frames) listeners.onFrames?.(...this.last.frames);
    if (this.last.identify) listeners.onIdentify?.(...this.last.identify);
    listeners.onPicks?.(this.picks.picks, this.picks.reference);
    if (this.last.analysis) listeners.onAnalysis?.(...this.last.analysis);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  private picksChanged(): void {
    this.layers?.setPicks(this.picks.picks);
    this.events.onPicks(this.picks.picks, this.picks.reference);
  }

  /** Vector layers the user could analyse (anything GeoLibre can return features for). */
  analyzableLayers(): { id: string; name: string }[] {
    const own = new Set(["opera-disp-velocity", "opera-disp-frames"]);
    return (this.app.listLayers?.() ?? [])
      .filter((l) => !own.has(l.id) && !/raster|tile|wms|wmts|cog|background|zarr|basemap/i.test(l.type))
      .map((l) => ({ id: l.id, name: l.name }));
  }

  /**
   * Analyse a layer's features (or the current selection when `layerId` is "selection").
   * Writes a new GeoLibre layer with velocity attributes and publishes the table.
   */
  async analyze(layerId: string, options: AnalysisOptions): Promise<AnalysisResult | null> {
    this.analysisAbort?.abort();
    const controller = new AbortController();
    this.analysisAbort = controller;
    const layers = this.app.listLayers?.() ?? [];
    let sourceName: string;
    let features: InputFeature[];
    try {
      if (layerId === "drawn") {
        features = (this.app.getDrawnFeatures?.() ?? []) as InputFeature[];
        sourceName = "Drawn shapes";
      } else if (layerId === "selection") {
        features = (this.app.getSelectedFeatures?.() ?? []) as InputFeature[];
        const selectedLayer = layers.find((l) => l.id === this.app.getSelectedLayerId?.());
        sourceName = `${selectedLayer?.name ?? "selection"} (selected)`;
      } else {
        features = (this.app.getLayerFeatures?.(layerId) ?? []) as InputFeature[];
        sourceName = layers.find((l) => l.id === layerId)?.name ?? layerId;
      }
    } catch (e) {
      this.events.onAnalysis(null, `Could not read features: ${(e as Error).message}`, false);
      return null;
    }
    const usable = features.filter(isAnalyzable);
    const skipped = features.length - usable.length;
    if (!usable.length) {
      const why = features.length
        ? "none has a point, line or polygon geometry"
        : layerId === "drawn"
          ? "nothing is drawn yet (press Draw polygon, draw, then Analyze)"
          : layerId === "selection"
            ? "no features are selected"
            : "the layer has no features GeoLibre can read (e.g. vector tiles)";
      this.events.onAnalysis(null, `Nothing to analyse: ${why}.`, false);
      return null;
    }

    const results: Partial<Record<Direction, AnalyzeStats[]>> = {};
    const total = usable.length * options.directions.length;
    let done = 0;
    try {
      for (const direction of options.directions) {
        results[direction] = [];
        for (let i = 0; i < usable.length; i += ANALYZE_CHUNK) {
          this.events.onAnalysis(
            null,
            `Analysing ${sourceName} (${options.source === "cube" ? "downloaded cubes" : "ASF overview"}): ${done}/${total}…`,
            true,
          );
          const chunk = usable.slice(i, i + ANALYZE_CHUNK).map((f) => ({ type: "Feature", geometry: f.geometry }));
          const response = await this.proxy.analyze(
            chunk,
            direction,
            { absThreshold: options.thresholdMm / 1000, stepM: options.stepM, source: options.source },
            controller.signal,
          );
          results[direction]!.push(...response.results);
          done += chunk.length;
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return null;
      this.events.onAnalysis(null, `Analysis failed: ${(e as Error).message}`, false);
      return null;
    }

    const rows = buildRows(usable, results, options);
    const collection = toResultCollection(rows, options);
    const hot = rows.filter((r) => r.hotspot.length);
    let resultLayerId: string | null = null;
    let hotspotLayerId: string | null = null;
    const styleWarnings: string[] = [];
    try {
      resultLayerId = this.app.addGeoJsonLayer?.(`${sourceName} · OPERA velocity`, collection) ?? null;
      if (resultLayerId) {
        const r = this.app.importLayerStyle?.(resultLayerId, velocityStyle());
        if (r && !r.ok) styleWarnings.push(`velocity style: ${r.reason}`);
      }
      if (hot.length) {
        const hotFeatures = collection.features.filter((_f, i) => rows[i].hotspot.length);
        hotspotLayerId =
          this.app.addGeoJsonLayer?.(`${sourceName} · hotspots ≥ ${options.thresholdMm} mm/yr`, {
            type: "FeatureCollection",
            features: hotFeatures,
          }) ?? null;
        if (hotspotLayerId) {
          const r = this.app.importLayerStyle?.(hotspotLayerId, hotspotStyle());
          if (r && !r.ok) styleWarnings.push(`hotspot style: ${r.reason}`);
        }
      }
    } catch (e) {
      console.warn("[opera-disp] could not add the result layers", e);
    }
    if (styleWarnings.length) console.warn("[opera-disp]", styleWarnings.join("; "));
    const analysis: AnalysisResult = { sourceName, rows, options, resultLayerId, hotspotLayerId, skipped };
    let message = `${rows.length} feature(s) analysed; ${hot.length} hotspot(s) with |median| ≥ ${options.thresholdMm} mm/yr`;
    if (!hot.length) {
      const ranked = rows.filter((r) => r.maxAbsMedianMm !== null).sort((a, b) => b.maxAbsMedianMm! - a.maxAbsMedianMm!);
      message += ranked.length
        ? ` (largest: ${ranked[0].maxAbsMedianMm!.toFixed(1)} mm/yr at “${ranked[0].name}”; lower the threshold to flag more)`
        : " (no feature has enough valid pixels; check the minimum valid pixels or the area)";
    }
    if (skipped) message += `; ${skipped} skipped (no supported geometry)`;
    if (options.source === "cube") {
      const outside = rows.filter((r) => options.directions.every((d) => r.stats[d]?.error?.includes("no downloaded"))).length;
      const insignificant = rows.filter((r) => !r.hotspot.length && r.notSignificant.length).length;
      if (outside) message += `; ${outside} outside the downloaded cubes`;
      if (insignificant) message += `; ${insignificant} above the threshold but < 2σ (not flagged)`;
    }
    if (resultLayerId) message += "; layers added (coloured by velocity" + (hotspotLayerId ? ", hotspots in red)" : ")");
    this.events.onAnalysis(analysis, message, false);
    return analysis;
  }

  zoomTo(bounds: [number, number, number, number]): void {
    const [w, s, e, n] = bounds;
    // Pad points/small features so the map does not zoom in to the maximum.
    const pad = Math.max(0.01, (e - w) * 0.15, (n - s) * 0.15);
    this.app.fitBounds?.([w - pad, s - pad, e + pad, n + pad]);
  }

  /** Add a time-series pick (point or polygon). Returns false for unsupported geometry. */
  addPick(geometry: PickGeometry, label?: string): boolean {
    const pick = this.picks.add(geometry, label);
    if (pick) this.events.onPickAdded(pick);
    return pick !== null;
  }

  /** Add picks from features (drawn shapes or a selection); returns how many were usable. */
  addPicksFromFeatures(features: { geometry: unknown; properties?: Record<string, unknown> | null }[]): number {
    let added = 0;
    for (const f of features) {
      const g = f.geometry as PickGeometry | null;
      if (!g || !["Point", "Polygon", "MultiPolygon"].includes(g.type)) continue;
      const name = f.properties?.name ?? f.properties?.label;
      if (this.addPick(g, typeof name === "string" && name ? name.slice(0, 24) : undefined)) added++;
    }
    return added;
  }

  /** Attach to the host map (call once the map exists). */
  attach(map: MapLibreMap): void {
    this.map = map;
    this.layers = new DispMapLayers(this.app, map, {
      velocityTiles: this.proxy.tileTemplate(this.state.direction),
      opacity: this.state.opacity,
      visible: this.state.visible,
      labelTiles: null,
      labelsMaxzoom: 16,
      showFrames: this.state.showFrames,
      onHostVisibility: (layer, visible) => {
        const key = layer === "velocity" ? "visible" : "showFrames";
        if (this.state[key] !== visible) this.update({ [key]: visible });
      },
    });
    this.extendRestoreWindow(RESTORE_GRACE_MS);
    const ensure = () => this.layers?.ensure();
    const onStyleLoad = () => {
      this.extendRestoreWindow(BASEMAP_GRACE_MS);
      ensure();
    };
    if (map.isStyleLoaded()) ensure();
    else map.once("load", ensure);
    map.on("style.load", onStyleLoad);
    // Layers removed by the host's project sync come back; a later removal is the user's
    // (Layers panel trash button), so reflect it in the panel instead of fighting it.
    const onStyleData = () => {
      if (!this.layers || this.layers.hasVelocity() || !this.state.visible) return;
      if (Date.now() < this.restoreUntil) ensure();
      else this.update({ visible: false });
    };
    map.on("styledata", onStyleData);
    const onMove = () => this.scheduleFrames();
    const onClick = (e: MapMouseEvent) => void this.onMapClick(e);
    map.on("moveend", onMove);
    map.on("click", onClick);
    const offBasemap = this.app.onBasemapChange?.(() => {
      this.extendRestoreWindow(BASEMAP_GRACE_MS);
      setTimeout(ensure, 0);
    });
    this.disposers.push(() => {
      map.off("style.load", onStyleLoad);
      map.off("styledata", onStyleData);
      map.off("moveend", onMove);
      map.off("click", onClick);
      offBasemap?.();
    });
    void this.refreshProxy();
    this.scheduleFrames(0);
  }

  private extendRestoreWindow(ms: number): void {
    this.restoreUntil = Math.max(this.restoreUntil, Date.now() + ms);
  }

  detach(): void {
    this.analysisAbort?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.framesAbort?.abort();
    this.identifyAbort?.abort();
    if (this.framesTimer) clearTimeout(this.framesTimer);
    this.layers?.remove();
    this.layers = null;
    this.map = null;
  }

  /** Merge settings (from a project, URL or the panel) and apply what changed. */
  update(patch: Partial<DispState>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    const s = this.state;
    if (s.proxyUrl !== prev.proxyUrl) {
      this.proxy = new ProxyClient(s.proxyUrl);
      this.picks.setClients(new TimeseriesClient(s.tsApiUrl), this.asf, new CubeClient(s.proxyUrl));
      void this.refreshProxy();
    }
    if (s.tsApiUrl !== prev.tsApiUrl) {
      this.asf = new AsfClient(s.tsApiUrl);
      this.picks.setClients(new TimeseriesClient(s.tsApiUrl), this.asf);
    }
    if (s.proxyUrl !== prev.proxyUrl || s.direction !== prev.direction) {
      this.applyVelocitySource();
      void this.loadExtent();
      this.scheduleFrames(0);
    }
    if (s.opacity !== prev.opacity) this.layers?.setOpacity(s.opacity);
    if (s.visible !== prev.visible) {
      if (s.visible && this.layers && !this.layers.hasVelocity()) this.layers.ensure();
      this.layers?.setVisible(s.visible);
    }
    if (s.showFrames !== prev.showFrames) {
      this.layers?.setFramesVisible(s.showFrames);
      this.scheduleFrames(0);
    }
    if (s.basemap !== prev.basemap) this.applyBasemap();
    if (
      s.showFit !== prev.showFit ||
      s.fit !== prev.fit ||
      s.tsView !== prev.tsView ||
      s.tsSource !== prev.tsSource ||
      s.cubeVariable !== prev.cubeVariable ||
      s.tsModelOnly !== prev.tsModelOnly ||
      s.tsLegend !== prev.tsLegend ||
      s.tsStyles !== prev.tsStyles
    ) {
      this.picksChanged();
    }
    if (s.labelsOnTop !== prev.labelsOnTop) this.applyLabels();
    if (!s.identify && prev.identify) {
      this.layers?.setPick(null);
      this.events.onIdentify(null, false);
    }
    this.events.onState(this.state);
  }

  private async refreshProxy(): Promise<void> {
    const [ok, site] = await Promise.all([this.proxy.health(), loadSiteConfig()]);
    this.site = site;
    this.proxyOk = ok;
    // Cube series come from disp-proxy; without it, skip the lookup instead of showing a failed row.
    this.picks.setClients(new TimeseriesClient(this.state.tsApiUrl), this.asf, ok ? new CubeClient(this.state.proxyUrl) : null);
    // Without a proxy the ASF tiles cannot load (CORS): use the site's mirror when it has one.
    this.applyVelocitySource();
    this.layers?.setVisible((ok || Boolean(site?.overview)) && this.state.visible);
    this.events.onProxyStatus(ok);
    if (!ok) {
      if (site?.overview) void this.loadExtent();
      else this.events.onExtent(null, site?.mode === "static" ? "" : `disp-proxy not reachable at ${this.state.proxyUrl}`);
      if (site?.basemaps?.length) {
        this.basemaps = site.basemaps;
        this.events.onBasemaps(this.basemaps);
        this.applyBasemap();
      }
      return;
    }
    await this.loadExtent();
    try {
      this.basemaps = await this.proxy.basemaps();
      this.events.onBasemaps(this.basemaps);
      this.applyBasemap();
    } catch (e) {
      this.basemaps = [];
      this.events.onBasemaps([]);
      console.warn("[opera-disp] basemap catalogue unavailable", e);
    }
  }

  /** True when the velocity overview comes from the static site's mirror (no disp-proxy). */
  get staticOverview(): boolean {
    return !this.proxyOk && Boolean(this.site?.overview);
  }

  private applyVelocitySource(): void {
    const o = this.site?.overview;
    if (this.staticOverview && o) this.layers?.setVelocityTiles(o.tiles.replace("{dir}", this.state.direction), o.maxzoom);
    else this.layers?.setVelocityTiles(this.proxy.tileTemplate(this.state.direction), 12);
  }

  private async loadExtent(): Promise<void> {
    try {
      const o = this.site?.overview;
      if (this.staticOverview && o) {
        const r = await fetch(o.extent.replace("{dir}", this.state.direction), { cache: "no-cache" });
        if (!r.ok) throw new Error(`overview legend: ${r.status}`);
        this.events.onExtent((await r.json()) as ExtentInfo);
        return;
      }
      this.events.onExtent(await this.proxy.extent(this.state.direction));
    } catch (e) {
      this.events.onExtent(null, String(e));
    }
  }

  private applyBasemap(): void {
    const b = this.basemaps.find((x) => x.key === this.state.basemap);
    if (b && this.app.getActiveBasemap?.() !== b.style_url) {
      this.extendRestoreWindow(BASEMAP_GRACE_MS);
      this.app.setBasemap?.(b.style_url);
    }
    this.applyLabels();
  }

  private applyLabels(): void {
    const b = this.basemaps.find((x) => x.key === this.state.basemap);
    const tiles = this.state.labelsOnTop && b?.labels?.length ? b.labels : null;
    this.layers?.setLabels(tiles, b?.maxzoom ?? 16);
  }

  scheduleFrames(delay = 400): void {
    if (this.framesTimer) clearTimeout(this.framesTimer);
    this.framesTimer = setTimeout(() => void this.loadFrames(), delay);
  }

  private async loadFrames(): Promise<void> {
    const map = this.map;
    if (!map || !this.layers) return;
    this.framesAbort?.abort();
    if (!this.state.showFrames) {
      this.layers.setFrames({});
      this.events.onFrames([], "");
      return;
    }
    if (map.getZoom() < FRAMES_MIN_ZOOM) {
      this.layers.setFrames({});
      this.events.onFrames([], `Zoom in past ${FRAMES_MIN_ZOOM} to list frames.`);
      return;
    }
    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      Math.max(b.getWest(), -180),
      Math.max(b.getSouth(), -85),
      Math.min(b.getEast(), 180),
      Math.min(b.getNorth(), 85),
    ];
    const controller = new AbortController();
    this.framesAbort = controller;
    try {
      const raw = await this.asf.frameIntersection(bboxToWkt(bbox), this.state.direction, controller.signal);
      const frames = Object.fromEntries(Object.entries(raw).map(([id, wkt]) => [id, wktToGeometry(wkt)]));
      this.layers.setFrames(frames);
      const ids = Object.keys(frames).map(Number).sort((a, b) => a - b);
      this.events.onFrames(ids, `${ids.length} ${this.state.direction} frame(s) in view`);
    } catch (e) {
      if (controller.signal.aborted) return;
      this.layers.setFrames({});
      const msg = String(e).includes("No OPERA-S1 burst frame") ? "No OPERA frames in view." : `Frames: ${e}`;
      this.events.onFrames([], msg);
    }
  }

  private async onMapClick(e: MapMouseEvent): Promise<void> {
    if (!this.layers) return;
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (this.state.tsOnClick) this.addPick({ type: "Point", coordinates: lngLat });
    if (this.state.identify) await this.identify(lngLat);
  }

  private async identify(lngLat: [number, number]): Promise<void> {
    if (!this.layers) return;
    this.layers.setPick(lngLat);
    this.identifyAbort?.abort();
    const controller = new AbortController();
    this.identifyAbort = controller;
    this.events.onIdentify({ lngLat, asc: null, desc: null }, true);
    const read = (d: Direction) => this.proxy.value(lngLat[0], lngLat[1], d, controller.signal).catch(() => null);
    const [asc, desc] = await Promise.all([read("asc"), read("desc")]);
    if (controller.signal.aborted) return;
    const error = asc === null && desc === null ? "disp-proxy did not answer" : undefined;
    this.events.onIdentify({ lngLat, asc, desc, error }, false);
  }
}
