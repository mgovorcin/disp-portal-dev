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
}

export function loadLocal(): LocalSnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as LocalSnapshot) : null;
  } catch {
    return null;
  }
}

export function saveLocal(snapshot: LocalSnapshot): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // quota or blocked storage: the reload just starts fresh
  }
}

/** Settings worth remembering per browser (not the panel layout or service URLs). */
export function rememberedState(s: DispState): Partial<DispState> {
  const { panelOpen: _panelOpen, proxyUrl: _proxyUrl, tsApiUrl: _tsApiUrl, ...rest } = s;
  return rest;
}
