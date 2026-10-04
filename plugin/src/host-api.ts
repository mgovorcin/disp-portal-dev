/**
 * The subset of GeoLibre's plugin host API this plugin uses.
 *
 * Source of truth: GeoLibre `docs/plugin-api.md` (GeoLibreAppAPI / GeoLibrePlugin).
 * Every capability except the plugin lifecycle is optional on the host, so call
 * them with optional chaining and degrade when one is missing.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

export interface ExternalNativeLayerRegistration {
  id: string;
  name: string;
  type?: "raster" | "geojson" | string;
  nativeLayerIds: string[];
  sourceIds?: string[];
  opacity?: number;
  metadata?: Record<string, unknown>;
  paintMode?: "geolibre" | "plugin";
  paintBridge?: {
    setOpacity?: (opacity: number) => void;
    setVisibility?: (visible: boolean) => void;
  };
}

export interface RightPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}

export interface FloatingPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onClose?: () => void;
}

/** Minimal GeoJSON feature as returned by getDrawnFeatures / getSelectedFeatures. */
export interface HostFeature {
  type: "Feature";
  geometry: { type: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface ToolbarMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
}

export interface ToolbarMenu {
  id: string;
  label: string;
  items: ToolbarMenuAction[];
}

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

export interface ZarrLayerOptions {
  variable: string;
  selector?: Record<string, number | string>;
  clim?: [number, number];
  colormap?: string | string[];
  opacity?: number;
  zarrVersion?: 2 | 3;
  crs?: string;
  proj4?: string;
  bounds?: [number, number, number, number];
  spatialDimensions?: { lat?: string; lon?: string };
  headers?: Record<string, string>;
  beforeLayerId?: string;
}

export interface CogLayerOptions {
  bands?: string;
  colormap?: string;
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number;
  opacity?: number;
  beforeLayerId?: string;
  zoomTo?: boolean;
}

export interface MapControl {
  onAdd(map: MapLibreMap): HTMLElement;
  onRemove(): void;
}

export interface GeoLibreAppAPI {
  addMapControl?: (control: MapControl, position?: "top-left" | "top-right" | "bottom-left" | "bottom-right") => boolean;
  removeMapControl?: (control: MapControl) => void;
  activatePlugin?: (id: string, state?: unknown) => Promise<boolean>;
  addCogLayer?: (name: string, url: string, options?: CogLayerOptions) => Promise<string>;
  addZarrLayer?: (name: string, url: string, options: ZarrLayerOptions) => Promise<string>;
  addGeoJsonLayer?: (name: string, data: { type: "FeatureCollection"; features: unknown[] }, sourcePath?: string) => string;
  listLayers?: () => LayerSummary[];
  getLayerFeatures?: (layerId: string) => HostFeature[];
  getSelectedLayerId?: () => string | null;
  importLayerStyle?: (layerId: string, text: string) => { ok: boolean; reason?: string; warnings: string[] };
  getMap?: () => MapLibreMap | null;
  getMapRenderer?: () => "maplibre" | "mapbox" | "cesium" | "arcgis";
  setBasemap?: (styleUrl: string) => void;
  getActiveBasemap?: () => string;
  onBasemapChange?: (callback: (styleUrl: string) => void) => () => void;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getViewBounds?: () => [number, number, number, number] | null;
  registerExternalNativeLayer?: (layer: ExternalNativeLayerRegistration) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
  registerRightPanel?: (panel: RightPanelRegistration) => () => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
  collapseRightPanel?: (id: string) => void;
  getActiveRightPanel?: () => string | null;
  registerToolbarMenu?: (menu: ToolbarMenu) => () => void;
  registerFloatingPanel?: (panel: FloatingPanelRegistration) => () => void;
  openFloatingPanel?: (id: string) => boolean;
  closeFloatingPanel?: (id: string) => void;
  getOpenFloatingPanels?: () => string[];
  getDrawnFeatures?: () => HostFeature[];
  getSelectedFeatures?: () => HostFeature[];
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  urlParameterNames?: string[];
  /**
   * The plugin restores its own panel open/collapsed state from the project, so the
   * host does not force-collapse its panel on project load (GeoLibre #952).
   */
  restoresPanelCollapseState?: boolean;
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  handleUrlParameters?: (app: GeoLibreAppAPI, params: URLSearchParams) => void | Promise<void>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}
