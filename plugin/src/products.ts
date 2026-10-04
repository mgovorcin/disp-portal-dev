/**
 * "Velocity products" window: whole-frame velocity products processed on the server
 * (disp_portal.products, Phase 2). Lists frames with their state and loads their COGs.
 */
import type { DispController } from "./controller";
import { COG_STYLE } from "./downloads";
import type { GeoLibreAppAPI } from "./host-api";

export interface ProductGeoTiff {
  path: string;
  kind: string;
  units?: string;
  description?: string;
}

export interface ProductFrame {
  frame: number;
  direction: "asc" | "desc";
  state: string;
  step?: string | null;
  error?: string | null;
  elapsed_s?: number | null;
  n_granules?: number | null;
  time_range?: [string, string] | null;
  velocity_median_m_yr?: number | null;
  geotiffs: ProductGeoTiff[];
  cubes: string[];
}

export interface ProductsListing {
  frames: ProductFrame[];
  catalogs: Record<string, { n_frames: number; n_with_products: number; created: string }>;
}

export class ProductsClient {
  constructor(public baseUrl: string) {}
  async list(): Promise<ProductsListing> {
    const r = await fetch(`${this.baseUrl}/products`);
    if (!r.ok) throw new Error(`products: ${r.status}`);
    return (await r.json()) as ProductsListing;
  }
  fileUrl(rel: string): string {
    return `${this.baseUrl}/products/files/${rel}`;
  }
}

export const frameLabel = (f: Pick<ProductFrame, "frame" | "direction">) =>
  `F${String(f.frame).padStart(5, "0")} ${f.direction}`;

/** Add one product COG to the map; "own" in the name tells it apart from ASF and job layers. */
export async function addProductCog(app: GeoLibreAppAPI, client: ProductsClient, frame: ProductFrame, rec: ProductGeoTiff): Promise<string> {
  if (!app.addCogLayer) throw new Error("this GeoLibre version cannot add COG layers");
  const style = COG_STYLE[rec.kind] ?? (rec.kind === "valid_epochs"
    ? { colormap: "viridis", rescaleMin: 0, rescaleMax: 400, label: "epochs" }
    : COG_STYLE.velocity);
  return app.addCogLayer(`${frameLabel(frame)} ${style.label} (own)`, client.fileUrl(rec.path), {
    bands: "1",
    colormap: style.colormap,
    rescaleMin: style.rescaleMin,
    rescaleMax: style.rescaleMax,
    opacity: 0.9,
    zoomTo: false,
  });
}

/** Counts per state, e.g. "4 done · 2 running". */
export function stateSummary(frames: ProductFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${n} ${s}`).join(" · ") || "no frames processed yet";
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

export function renderProductsPanel(container: HTMLElement, app: GeoLibreAppAPI, controller: DispController): () => void {
  const root = el("div", { className: "od-chart-panel od-jobs od-products" });
  const status = el("p", { className: "od-muted" });
  const list = el("div", { className: "od-job-list" });
  const refreshBtn = el("button", { type: "button", className: "od-btn", textContent: "Refresh" });
  const addAsc = el("button", { type: "button", className: "od-btn", textContent: "Add all asc velocity" });
  const addDesc = el("button", { type: "button", className: "od-btn", textContent: "Add all desc velocity" });
  root.append(el("div", { className: "od-chart-toolbar" }, refreshBtn, addAsc, addDesc, status), list);
  container.append(root);
  let frames: ProductFrame[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const client = () => new ProductsClient(controller.state.proxyUrl);

  const addAll = async (direction: "asc" | "desc", btn: HTMLButtonElement) => {
    btn.disabled = true;
    let n = 0;
    for (const f of frames.filter((x) => x.state === "done" && x.direction === direction)) {
      const rec = f.geotiffs.find((g) => g.kind === "velocity");
      if (!rec) continue;
      try {
        await addProductCog(app, client(), f, rec);
        n += 1;
      } catch (e) {
        status.textContent = `Could not add ${frameLabel(f)}: ${(e as Error).message}`;
      }
    }
    btn.textContent = `${n} ${direction} layer(s) added`;
    btn.disabled = false;
  };
  addAsc.addEventListener("click", () => void addAll("asc", addAsc));
  addDesc.addEventListener("click", () => void addAll("desc", addDesc));

  const renderFrame = (f: ProductFrame) => {
    const median = f.velocity_median_m_yr;
    const detail = [
      f.time_range ? `${f.time_range[0]}…${f.time_range[1]}` : null,
      f.n_granules ? `${f.n_granules} granules` : null,
      median !== null && median !== undefined ? `median ${(median * 1000).toFixed(1)} mm/yr` : null,
      f.elapsed_s ? `${Math.round(f.elapsed_s / 60)} min` : null,
    ].filter(Boolean).join(" · ");
    const li = el(
      "li",
      {},
      el("strong", { textContent: frameLabel(f) }),
      el("span", { className: `od-job-state od-state-${f.state}`, textContent: f.state === "running" ? f.step ?? "running" : f.state }),
      el("span", { className: "od-muted", textContent: ` ${detail}` }),
    );
    if (f.error) li.append(el("div", { className: "od-muted od-error", textContent: f.error }));
    if (f.geotiffs.length) {
      const row = el("div", { className: "od-tif-row" }, el("span", { className: "od-muted", textContent: "COG:" }));
      for (const rec of f.geotiffs) {
        const label = COG_STYLE[rec.kind]?.label ?? rec.kind.replace("_", " ");
        const add = el("button", { type: "button", className: "od-btn", textContent: label, title: `Add ${rec.path} to the map` });
        add.addEventListener("click", async () => {
          add.disabled = true;
          try {
            await addProductCog(app, client(), f, rec);
            add.textContent = `${label} ✓`;
          } catch (e) {
            add.textContent = "failed";
            status.textContent = `Could not add COG: ${(e as Error).message}`;
          }
        });
        const dl = el("a", { href: client().fileUrl(rec.path), textContent: "↓", title: `Download ${rec.path}`, className: "od-dl" });
        dl.setAttribute("download", rec.path.split("/").pop() ?? "");
        row.append(add, dl);
      }
      li.append(row);
    }
    return li;
  };

  const refresh = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      const listing = await client().list();
      frames = listing.frames;
      const cats = Object.entries(listing.catalogs)
        .map(([region, c]) => `${region}: ${c.n_with_products} frames with data`)
        .join(" · ");
      status.textContent = `${stateSummary(frames)}${cats ? ` · ${cats}` : ""}`;
      list.replaceChildren(
        frames.length
          ? el("ul", { className: "od-picks" }, ...frames.map(renderFrame))
          : el("p", { className: "od-muted", textContent: "No frames processed yet (python -m disp_portal.products run …)." }),
      );
      if (frames.some((f) => f.state === "running") && !stopped) timer = setTimeout(() => void refresh(), 15000);
    } catch (e) {
      status.textContent = `disp-proxy not reachable: ${(e as Error).message}`;
    }
  };
  refreshBtn.addEventListener("click", () => void refresh());
  void refresh();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    root.remove();
  };
}
