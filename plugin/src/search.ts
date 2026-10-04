/** "Search" section: go to a place (OpenStreetMap Nominatim) or to coordinates. */

export interface SearchResult {
  label: string;
  lon: number;
  lat: number;
  /** [west, south, east, north] when the place has an extent. */
  bbox?: [number, number, number, number];
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/**
 * Parse coordinates typed as "lat, lon" (the usual order), or "lon, lat" when the first number
 * cannot be a latitude. Returns null when the text is not two numbers.
 */
export function parseCoordinates(text: string): SearchResult | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  let lat = a;
  let lon = b;
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [lat, lon] = [b, a];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lon, lat };
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const coords = parseCoordinates(query);
  if (coords) return [coords];
  const q = new URLSearchParams({ q: query, format: "jsonv2", limit: "6" });
  const r = await fetch(`${NOMINATIM}?${q}`, { signal, headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`place search failed (${r.status})`);
  const rows = (await r.json()) as { display_name: string; lon: string; lat: string; boundingbox?: string[] }[];
  return rows.map((row) => {
    const [s, n, w, e] = (row.boundingbox ?? []).map(Number);
    return {
      label: row.display_name,
      lon: Number(row.lon),
      lat: Number(row.lat),
      bbox: [w, s, e, n].every(Number.isFinite) ? ([w, s, e, n] as [number, number, number, number]) : undefined,
    };
  });
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

/**
 * Search box + result list. `goTo` moves the map; `addPoint` (optional) adds a time-series
 * point at a result.
 */
export function renderSearchSection(
  goTo: (r: SearchResult) => void,
  addPoint?: (r: SearchResult) => void,
): HTMLElement {
  const input = el("input", {
    type: "search",
    className: "od-input",
    placeholder: "Place, address, or lat, lon",
    ariaLabel: "Search place or coordinates",
  });
  const results = el("ul", { className: "od-search-results" });
  const note = el("p", { className: "od-muted" });
  let controller: AbortController | null = null;

  const run = async () => {
    const query = input.value.trim();
    if (!query) return;
    controller?.abort();
    controller = new AbortController();
    note.textContent = "Searching…";
    results.replaceChildren();
    try {
      const found = await searchPlaces(query, controller.signal);
      note.textContent = found.length ? "" : "Nothing found.";
      if (found.length === 1 && parseCoordinates(query)) goTo(found[0]);
      results.replaceChildren(
        ...found.map((r) => {
          const go = el("button", { type: "button", className: "od-link", textContent: r.label, title: "Go here" });
          go.addEventListener("click", () => goTo(r));
          const li = el("li", {}, go);
          if (addPoint) {
            const pt = el("button", { type: "button", className: "od-btn", textContent: "+ point", title: "Add a time-series point here" });
            pt.addEventListener("click", () => addPoint(r));
            li.append(pt);
          }
          return li;
        }),
      );
    } catch (e) {
      if (!controller.signal.aborted) note.textContent = (e as Error).message;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void run();
  });
  const goBtn = el("button", { type: "button", className: "od-btn", textContent: "Search" });
  goBtn.addEventListener("click", () => void run());

  input.title = "Places from OpenStreetMap (Nominatim), or coordinates as lat, lon";
  return el("section", { className: "od-section od-search" }, el("div", { className: "od-search-box" }, input, goBtn), note, results);
}
