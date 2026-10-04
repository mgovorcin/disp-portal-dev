/**
 * Static-site support (GitHub Pages build): where the site lives and its optional
 * `disp-portal.json` (basemaps and demo project when no disp-proxy is available).
 */
import type { Basemap } from "./services";

export interface SiteConfig {
  /** "static": no disp-proxy behind the site (GitHub Pages); "proxy": served by disp-proxy. */
  mode: "static" | "proxy";
  /** Basemap catalogue; style_url may be relative to the site base. */
  basemaps?: Basemap[];
  /** Demo project path relative to the site base. */
  demoProject?: string;
  /** Short note shown in the sidebar header in static mode. */
  note?: string;
}

/**
 * Site base URL (ends with "/"). The bundle is served from `<base>plugins/opera-disp/dist/index.js`
 * in the self-hosted and Pages builds; elsewhere fall back to the page's directory.
 */
export function siteBase(moduleUrl: string = import.meta.url, page: string = globalThis.location?.href ?? "http://localhost/"): string {
  const marker = "/plugins/opera-disp/";
  const i = moduleUrl.indexOf(marker);
  if (i >= 0) return moduleUrl.slice(0, i + 1);
  return new URL("./", page).href;
}

/** Resolve the relative URLs in a site config against `base`. */
export function resolveSiteConfig(raw: SiteConfig, base: string): SiteConfig {
  return {
    ...raw,
    basemaps: raw.basemaps?.map((b) => ({ ...b, style_url: new URL(b.style_url, base).href })),
    demoProject: raw.demoProject ? new URL(raw.demoProject, base).href : undefined,
  };
}

let cached: Promise<SiteConfig | null> | null = null;

/** `disp-portal.json` next to the site root, or null when the site has none (proxy-served). */
export function loadSiteConfig(base: string = siteBase()): Promise<SiteConfig | null> {
  cached ??= fetch(new URL("disp-portal.json", base).href, { cache: "no-cache" })
    .then(async (r) => (r.ok ? resolveSiteConfig((await r.json()) as SiteConfig, base) : null))
    .catch(() => null);
  return cached;
}
