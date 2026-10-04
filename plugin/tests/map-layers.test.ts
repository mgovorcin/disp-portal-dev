import { DispMapLayers, IDS } from "../src/map-layers";
import type { GeoLibreAppAPI } from "../src/host-api";

/** Just enough of maplibre's Map to track sources, layers, order and properties. */
class FakeMap {
  sources = new Map<string, any>();
  layers: any[] = [];
  styleLoaded = true;
  idle: (() => void)[] = [];
  isStyleLoaded() { return this.styleLoaded; }
  once(event: string, fn: () => void) { if (event === "idle") this.idle.push(fn); }
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, spec: any) {
    this.sources.set(id, { ...spec, setTiles: (t: string[]) => (spec.tiles = t), setData: (d: any) => (spec.data = d), spec });
  }
  removeSource(id: string) { this.sources.delete(id); }
  getLayer(id: string) { return this.layers.find((l) => l.id === id); }
  addLayer(layer: any) { this.layers.push(structuredClone(layer)); }
  removeLayer(id: string) { this.layers = this.layers.filter((l) => l.id !== id); }
  moveLayer(id: string) { const l = this.getLayer(id); this.removeLayer(id); this.layers.push(l); }
  setPaintProperty(id: string, k: string, v: unknown) { this.getLayer(id).paint[k] = v; }
  setLayoutProperty(id: string, k: string, v: unknown) { (this.getLayer(id).layout ??= {})[k] = v; }
}

function setup() {
  const map = new FakeMap();
  const registered: any[] = [];
  const app: GeoLibreAppAPI = { registerExternalNativeLayer: (r) => registered.push(r), unregisterExternalNativeLayer: vi.fn() };
  const layers = new DispMapLayers(app, map as never, {
    velocityTiles: "http://p/tiles/asc/vel/{z}/{x}/{y}.png", opacity: 0.8, visible: true,
    labelTiles: ["http://labels/{z}/{y}/{x}"], labelsMaxzoom: 16, showFrames: true,
  });
  layers.ensure();
  return { map, app, layers, registered };
}

describe("DispMapLayers", () => {
  it("adds layers in order with labels and pick above velocity", () => {
    const { map } = setup();
    expect(map.layers.map((l) => l.id)).toEqual([IDS.velocity, IDS.frames, IDS.labels, IDS.picksOutline, IDS.picks, IDS.pick]);
  });
  it("is idempotent and re-adds after a style reset", () => {
    const { map, layers, registered } = setup();
    layers.ensure();
    expect(map.layers).toHaveLength(6);
    expect(registered).toHaveLength(3);
    map.layers = [];
    map.sources.clear();
    layers.ensure();
    expect(map.layers.map((l) => l.id)).toEqual([IDS.velocity, IDS.frames, IDS.labels, IDS.picksOutline, IDS.picks, IDS.pick]);
    // re-registered so the host's Layers panel gets its entries back
    expect(registered.map((r) => r.id)).toEqual([IDS.velocity, IDS.frames, IDS.picks, IDS.velocity, IDS.frames, IDS.picks]);
  });
  it("bridges opacity and visibility from the Layers panel", () => {
    const { map, registered } = setup();
    registered[0].paintBridge.setOpacity(0.3);
    registered[0].paintBridge.setVisibility(false);
    expect(map.getLayer(IDS.velocity).paint["raster-opacity"]).toBe(0.3);
    expect(map.getLayer(IDS.velocity).layout.visibility).toBe("none");
  });
  it("switches direction by retargeting tiles", () => {
    const { map, layers } = setup();
    layers.setVelocityTiles("http://p/tiles/desc/vel/{z}/{x}/{y}.png");
    expect(map.getSource(IDS.velocity).spec.tiles).toEqual(["http://p/tiles/desc/vel/{z}/{x}/{y}.png"]);
  });
  it("removes labels when none and cleans up on remove", () => {
    const { map, layers, app } = setup();
    layers.setLabels(null);
    expect(map.getLayer(IDS.labels)).toBeUndefined();
    layers.remove();
    expect(map.layers).toHaveLength(0);
    expect(app.unregisterExternalNativeLayer).toHaveBeenCalledTimes(3);
  });
  it("defers edits while the style is loading and applies them when idle", () => {
    const { map, layers } = setup();
    map.styleLoaded = false;
    map.layers = [];
    map.sources.clear();
    layers.setLabels(["http://other-labels/{z}/{y}/{x}"]);
    layers.ensure();
    expect(map.layers).toHaveLength(0);
    expect(map.idle).toHaveLength(1);
    map.styleLoaded = true;
    map.idle.splice(0).forEach((fn) => fn());
    expect(map.layers.map((l) => l.id)).toEqual([IDS.velocity, IDS.frames, IDS.labels, IDS.picksOutline, IDS.picks, IDS.pick]);
    expect(map.getSource(IDS.labels).spec.tiles).toEqual(["http://other-labels/{z}/{y}/{x}"]);
  });
  it("lists time-series points in the Layers panel with a visibility bridge", () => {
    const { map, registered } = setup();
    const picks = registered.find((r) => r.id === IDS.picks);
    expect(picks.name).toBe("OPERA DISP time-series points");
    picks.paintBridge.setVisibility(false);
    expect(map.getLayer(IDS.picks).layout.visibility).toBe("none");
    expect(map.getLayer(IDS.picksOutline).layout.visibility).toBe("none");
  });
  it("turns frame geometries into features", () => {
    const { map, layers } = setup();
    layers.setFrames({ "8882": { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, "1": null });
    const data = map.getSource(IDS.frames).spec.data;
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties.frame_id).toBe(8882);
  });
});
