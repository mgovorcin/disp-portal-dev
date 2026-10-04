/**
 * MapLibre sources/layers owned by the plugin.
 *
 * GeoLibre's plugin API cannot remove or retarget layers added with addTileLayer, so
 * the plugin adds its own layers to the host map and mirrors them into the Layers
 * panel with registerExternalNativeLayer (opacity/visibility bridged back here).
 * A basemap switch can rebuild the style, so `ensure()` re-adds anything missing.
 */
import type { GeoJSONSource, Map as MapLibreMap, RasterTileSource } from "maplibre-gl";
import type { GeoLibreAppAPI } from "./host-api";
import type { Geometry } from "./wkt";

export const IDS = {
  velocity: "opera-disp-velocity",
  frames: "opera-disp-frames",
  labels: "opera-disp-basemap-labels",
  picks: "opera-disp-picks",
  picksOutline: "opera-disp-picks-outline",
  pick: "opera-disp-pick",
} as const;

type FeatureCollection = { type: "FeatureCollection"; features: unknown[] };
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export interface LayerOptions {
  velocityTiles: string;
  /** Highest zoom of the velocity tiles (12 from disp-proxy, lower for a static mirror). */
  velocityMaxzoom?: number;
  opacity: number;
  visible: boolean;
  labelTiles: string[] | null;
  labelsMaxzoom: number;
  showFrames: boolean;
  /** GeoLibre's Layers panel changed a layer's visibility (keeps the plugin's switches in step). */
  onHostVisibility?: (layer: "velocity" | "frames", visible: boolean) => void;
}

export class DispMapLayers {
  private frames: FeatureCollection = EMPTY;
  private pick: FeatureCollection = EMPTY;
  private picks: FeatureCollection = EMPTY;
  private registered = new Set<string>();
  private deferred = false;

  constructor(
    private readonly app: GeoLibreAppAPI,
    private readonly map: MapLibreMap,
    private options: LayerOptions,
  ) {}

  /** True while the velocity layer exists on the map. */
  hasVelocity(): boolean {
    return Boolean(this.map.getLayer(IDS.velocity));
  }

  /**
   * Add any missing source/layer (idempotent) and keep the plugin's layers in order.
   * While the host swaps the basemap style MapLibre rejects edits ("Style is not done
   * loading"), so wait for the map to go idle and try again.
   */
  ensure(): void {
    const map = this.map;
    if (!map.isStyleLoaded()) {
      if (!this.deferred) {
        this.deferred = true;
        map.once("idle", () => {
          this.deferred = false;
          this.ensure();
        });
      }
      return;
    }
    const recreated = !map.getLayer(IDS.velocity) || !map.getLayer(IDS.frames) || !map.getLayer(IDS.picks);
    if (recreated) this.registered.clear();
    if (!map.getSource(IDS.velocity)) {
      map.addSource(IDS.velocity, {
        type: "raster",
        tiles: [this.options.velocityTiles],
        tileSize: 256,
        minzoom: 2,
        maxzoom: this.options.velocityMaxzoom ?? 12,
        attribution: "OPERA DISP-S1 velocity: ASF overview (OPERA-DISP-TMS)",
      });
    }
    if (!map.getLayer(IDS.velocity)) {
      map.addLayer({
        id: IDS.velocity,
        type: "raster",
        source: IDS.velocity,
        layout: { visibility: this.options.visible ? "visible" : "none" },
        paint: { "raster-opacity": this.options.opacity, "raster-resampling": "nearest" },
      });
    }
    if (!map.getSource(IDS.frames)) map.addSource(IDS.frames, { type: "geojson", data: this.frames as never });
    if (!map.getLayer(IDS.frames)) {
      map.addLayer({
        id: IDS.frames,
        type: "line",
        source: IDS.frames,
        layout: { visibility: this.options.showFrames ? "visible" : "none" },
        paint: { "line-color": "#7a3db8", "line-width": 1.2, "line-dasharray": [3, 2] },
      });
    }
    this.syncLabels();
    // Time-series picks: polygons as outlines, points as circles, in each pick's colour.
    if (!map.getSource(IDS.picks)) map.addSource(IDS.picks, { type: "geojson", data: this.picks as never });
    if (!map.getLayer(IDS.picksOutline)) {
      map.addLayer({
        id: IDS.picksOutline,
        type: "line",
        source: IDS.picks,
        filter: ["!=", ["geometry-type"], "Point"],
        paint: { "line-color": ["get", "color"], "line-width": 2.5 },
      });
    }
    if (!map.getLayer(IDS.picks)) {
      map.addLayer({
        id: IDS.picks,
        type: "circle",
        source: IDS.picks,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    // Identify marker: a ring, so a pick drawn at the same spot stays visible.
    if (!map.getSource(IDS.pick)) map.addSource(IDS.pick, { type: "geojson", data: this.pick as never });
    if (!map.getLayer(IDS.pick)) {
      map.addLayer({
        id: IDS.pick,
        type: "circle",
        source: IDS.pick,
        paint: {
          "circle-radius": 10,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#d62728",
          "circle-stroke-width": 2,
        },
      });
    }
    // Keep labels and markers above the velocity layer.
    for (const id of [IDS.frames, IDS.labels, IDS.picksOutline, IDS.picks, IDS.pick]) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
    this.register();
  }

  private syncLabels(): void {
    const map = this.map;
    const tiles = this.options.labelTiles;
    if (map.getLayer(IDS.labels)) map.removeLayer(IDS.labels);
    if (map.getSource(IDS.labels)) map.removeSource(IDS.labels);
    if (!tiles?.length) return;
    map.addSource(IDS.labels, { type: "raster", tiles, tileSize: 256, maxzoom: this.options.labelsMaxzoom });
    map.addLayer({ id: IDS.labels, type: "raster", source: IDS.labels });
  }

  private register(): void {
    const register = this.app.registerExternalNativeLayer;
    // Re-registering after the host dropped the layers restores the Layers panel entries.
    if (!register || this.registered.has(IDS.velocity)) return;
    register({
      id: IDS.velocity,
      name: "OPERA DISP velocity (ASF overview)",
      type: "raster",
      nativeLayerIds: [IDS.velocity],
      sourceIds: [IDS.velocity],
      opacity: this.options.opacity,
      metadata: { plugin: "opera-disp", units: "m/yr" },
      paintBridge: {
        setOpacity: (opacity) => this.setOpacity(opacity),
        setVisibility: (visible) => {
          this.setVisible(visible);
          this.options.onHostVisibility?.("velocity", visible);
        },
      },
    });
    register({
      id: IDS.frames,
      name: "OPERA DISP frames (in view)",
      type: "geojson",
      nativeLayerIds: [IDS.frames],
      sourceIds: [IDS.frames],
      opacity: 1,
      paintBridge: {
        setVisibility: (visible) => {
          this.setFramesVisible(visible);
          this.options.onHostVisibility?.("frames", visible);
        },
      },
    });
    register({
      id: IDS.picks,
      name: "OPERA DISP time-series points",
      type: "geojson",
      nativeLayerIds: [IDS.picks, IDS.picksOutline],
      sourceIds: [IDS.picks],
      opacity: 1,
      metadata: { plugin: "opera-disp", description: "Points and polygons picked for ASF time series" },
      paintBridge: {
        setVisibility: (visible) => this.setPicksVisible(visible),
        setOpacity: (opacity) => this.setPicksOpacity(opacity),
      },
    });
    this.registered.add(IDS.velocity).add(IDS.frames).add(IDS.picks);
  }

  setVelocityTiles(template: string, maxzoom = 12): void {
    const sameZoom = (this.options.velocityMaxzoom ?? 12) === maxzoom;
    this.options.velocityTiles = template;
    this.options.velocityMaxzoom = maxzoom;
    const source = this.map.getSource(IDS.velocity) as RasterTileSource | undefined;
    if (!source) return;
    if (sameZoom) {
      source.setTiles([template]);
      return;
    }
    // A source's maxzoom is fixed at creation: rebuild the layer with the new range.
    if (this.map.getLayer(IDS.velocity)) this.map.removeLayer(IDS.velocity);
    this.map.removeSource(IDS.velocity);
    this.ensure();
  }

  setOpacity(opacity: number): void {
    this.options.opacity = opacity;
    if (this.map.getLayer(IDS.velocity)) this.map.setPaintProperty(IDS.velocity, "raster-opacity", opacity);
  }

  setVisible(visible: boolean): void {
    this.options.visible = visible;
    if (this.map.getLayer(IDS.velocity)) {
      this.map.setLayoutProperty(IDS.velocity, "visibility", visible ? "visible" : "none");
    }
  }

  setFramesVisible(visible: boolean): void {
    this.options.showFrames = visible;
    if (this.map.getLayer(IDS.frames)) {
      this.map.setLayoutProperty(IDS.frames, "visibility", visible ? "visible" : "none");
    }
  }

  setLabels(tiles: string[] | null, maxzoom = 16): void {
    this.options.labelTiles = tiles;
    this.options.labelsMaxzoom = maxzoom;
    if (!this.map.isStyleLoaded()) {
      this.ensure(); // deferred; ensure() re-syncs labels from options
      return;
    }
    this.syncLabels();
    for (const id of [IDS.picksOutline, IDS.picks, IDS.pick]) {
      if (this.map.getLayer(id)) this.map.moveLayer(id);
    }
  }

  setPicksVisible(visible: boolean): void {
    for (const id of [IDS.picks, IDS.picksOutline]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }

  setPicksOpacity(opacity: number): void {
    if (this.map.getLayer(IDS.picks)) {
      this.map.setPaintProperty(IDS.picks, "circle-opacity", opacity);
      this.map.setPaintProperty(IDS.picks, "circle-stroke-opacity", opacity);
    }
    if (this.map.getLayer(IDS.picksOutline)) this.map.setPaintProperty(IDS.picksOutline, "line-opacity", opacity);
  }

  setPicks(picks: { id: number; label: string; color: string; geometry: unknown }[]): void {
    this.picks = {
      type: "FeatureCollection",
      features: picks.map((p) => ({
        type: "Feature",
        properties: { id: p.id, label: p.label, color: p.color },
        geometry: p.geometry,
      })),
    };
    (this.map.getSource(IDS.picks) as GeoJSONSource | undefined)?.setData(this.picks as never);
  }

  setFrames(frames: Record<string, Geometry | null>): void {
    this.frames = {
      type: "FeatureCollection",
      features: Object.entries(frames)
        .filter(([, g]) => g !== null)
        .map(([id, geometry]) => ({ type: "Feature", properties: { frame_id: Number(id) }, geometry })),
    };
    (this.map.getSource(IDS.frames) as GeoJSONSource | undefined)?.setData(this.frames as never);
  }

  setPick(lngLat: [number, number] | null): void {
    this.pick = lngLat
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lngLat } }] }
      : EMPTY;
    (this.map.getSource(IDS.pick) as GeoJSONSource | undefined)?.setData(this.pick as never);
  }

  remove(): void {
    for (const id of this.registered) this.app.unregisterExternalNativeLayer?.(id);
    this.registered.clear();
    for (const id of [IDS.pick, IDS.picks, IDS.picksOutline, IDS.labels, IDS.frames, IDS.velocity]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    for (const id of [IDS.pick, IDS.picks, IDS.labels, IDS.frames, IDS.velocity]) {
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}
