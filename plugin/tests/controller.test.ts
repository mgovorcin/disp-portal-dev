import { BASEMAP_GRACE_MS, DispController, RESTORE_GRACE_MS } from "../src/controller";
import { IDS } from "../src/map-layers";
import type { GeoLibreAppAPI } from "../src/host-api";

/** Fake map with events; enough for DispController.attach. */
class EventMap {
  layers: any[] = [];
  sources = new Map<string, any>();
  handlers = new Map<string, Set<(e?: any) => void>>();
  isStyleLoaded() { return true; }
  getZoom() { return 3; }
  getBounds() { return { getWest: () => -96, getSouth: () => 29, getEast: () => -95, getNorth: () => 30 }; }
  on(ev: string, fn: (e?: any) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(fn); }
  off(ev: string, fn: (e?: any) => void) { this.handlers.get(ev)?.delete(fn); }
  once(ev: string, fn: (e?: any) => void) { this.on(ev, fn); }
  fire(ev: string) { for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(); }
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, spec: any) { this.sources.set(id, { ...spec, setTiles() {}, setData() {} }); }
  removeSource(id: string) { this.sources.delete(id); }
  getLayer(id: string) { return this.layers.find((l) => l.id === id); }
  addLayer(layer: any) { this.layers.push(structuredClone(layer)); }
  removeLayer(id: string) { this.layers = this.layers.filter((l) => l.id !== id); }
  moveLayer(id: string) { const l = this.getLayer(id); this.removeLayer(id); this.layers.push(l); }
  setPaintProperty() {}
  setLayoutProperty(id: string, k: string, v: unknown) { (this.getLayer(id).layout ??= {})[k] = v; }
  /** What the host does when it rebuilds the style: plugin layers vanish. */
  dropPluginLayers() { this.layers = []; this.sources.clear(); this.fire("styledata"); }
}

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const map = new EventMap();
  let basemapListener: ((url: string) => void) | null = null;
  const app: GeoLibreAppAPI = {
    registerExternalNativeLayer: vi.fn(),
    unregisterExternalNativeLayer: vi.fn(),
    onBasemapChange: (cb) => { basemapListener = cb; return () => {}; },
  };
  const controller = new DispController(app);
  controller.attach(map as never);
  return { map, controller, fireBasemap: (url: string) => basemapListener?.(url) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DispController layer restore", () => {
  it("restores layers the host drops while a project loads", () => {
    const { map, controller } = setup();
    expect(map.getLayer(IDS.velocity)).toBeDefined();
    map.dropPluginLayers();
    expect(map.getLayer(IDS.velocity)).toBeDefined();
    expect(controller.state.visible).toBe(true);
  });

  it("restores layers dropped by a basemap switch after the load window", () => {
    const { map, controller, fireBasemap } = setup();
    vi.advanceTimersByTime(RESTORE_GRACE_MS + 1000);
    fireBasemap("http://proxy/basemaps/dark.json");
    map.dropPluginLayers();
    expect(map.getLayer(IDS.velocity)).toBeDefined();
    expect(controller.state.visible).toBe(true);
  });

  it("treats a later removal as the user's and unticks the overview", () => {
    const { map, controller, fireBasemap } = setup();
    fireBasemap("http://proxy/basemaps/dark.json");
    vi.advanceTimersByTime(Math.max(RESTORE_GRACE_MS, BASEMAP_GRACE_MS) + 1000);
    map.dropPluginLayers();
    expect(map.getLayer(IDS.velocity)).toBeUndefined();
    expect(controller.state.visible).toBe(false);
    controller.update({ visible: true });
    expect(map.getLayer(IDS.velocity)).toBeDefined();
  });
});
