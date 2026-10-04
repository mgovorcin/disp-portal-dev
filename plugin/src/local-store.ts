/**
 * Per-browser memory of the plugin's points and settings, so a page reload keeps them.
 * GeoLibre's autosave is crash recovery only; saved projects carry the same data and win.
 * Storage can be unavailable (private windows, blocked site data): every access is guarded.
 */
import type { SavedPick } from "./picks";
import type { DispState } from "./state";

const KEY = "opera-disp:v1";

export interface LocalSnapshot {
  state: Partial<DispState>;
  picks: SavedPick[];
  reference: string | null;
  /** Version of the defaults the snapshot was saved under (see DEFAULTS_VERSION). */
  defaultsVersion?: number;
}

/**
 * Bumped when a default changes and remembered values should give way to it once.
 * 2: Sentinel-2 cloudless became the default basemap (older snapshots drop their basemap).
 */
export const DEFAULTS_VERSION = 2;

/** Apply one-time default changes to a snapshot saved under older defaults. */
export function migrateSnapshot(snap: LocalSnapshot): LocalSnapshot {
  if ((snap.defaultsVersion ?? 1) < 2 && snap.state) {
    const { basemap: _basemap, ...state } = snap.state;
    return { ...snap, state, defaultsVersion: DEFAULTS_VERSION };
  }
  return snap;
}

export function loadLocal(): LocalSnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? migrateSnapshot(JSON.parse(raw) as LocalSnapshot) : null;
  } catch {
    return null;
  }
}

export function saveLocal(snapshot: LocalSnapshot): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...snapshot, defaultsVersion: DEFAULTS_VERSION }));
  } catch {
    // quota or blocked storage: the reload just starts fresh
  }
}

/** Settings worth remembering per browser (not the panel layout or service URLs). */
export function rememberedState(s: DispState): Partial<DispState> {
  const { panelOpen: _panelOpen, proxyUrl: _proxyUrl, tsApiUrl: _tsApiUrl, ...rest } = s;
  return rest;
}
