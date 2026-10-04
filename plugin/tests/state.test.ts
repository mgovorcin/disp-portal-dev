import { DEFAULT_STATE, defaultProxyUrl, parseState, stateFromUrl } from "../src/state";

describe("parseState", () => {
  it("keeps valid fields and drops the rest", () => {
    const s = parseState({ proxyUrl: "http://host:8790/", direction: "Descending", opacity: 0.5, bogus: 1, identify: "yes" });
    expect(s).toEqual({ proxyUrl: "http://host:8790", direction: "desc", opacity: 0.5 });
  });
  it("rejects non-http proxy urls and out-of-range opacity", () => {
    expect(parseState({ proxyUrl: "javascript:alert(1)", opacity: 2 })).toEqual({});
  });
  it("ignores non-objects", () => {
    expect(parseState(null)).toEqual({});
    expect(parseState([1])).toEqual({});
  });
  it("defaults to the page origin when self-hosted, else the local proxy port", () => {
    expect(defaultProxyUrl({ origin: "http://localhost:8790", protocol: "http:", hostname: "localhost" })).toBe("http://localhost:8790");
    expect(defaultProxyUrl({ origin: "http://localhost:18790", protocol: "http:", hostname: "localhost" })).toBe("http://localhost:18790");
    expect(defaultProxyUrl({ origin: "https://web.geolibre.app", protocol: "https:", hostname: "web.geolibre.app" })).toBe("http://localhost:8790");
    expect(defaultProxyUrl({ origin: "tauri://localhost", protocol: "tauri:", hostname: "localhost" })).toBe("http://localhost:8790");
    expect(typeof DEFAULT_STATE.proxyUrl).toBe("string");
  });
});

describe("stateFromUrl", () => {
  it("reads ASF portal style parameters", () => {
    expect(stateFromUrl(new URLSearchParams("dispOverview=VEL&dir=desc"))).toEqual({ visible: true, direction: "desc" });
    expect(stateFromUrl(new URLSearchParams("dispOverview=none"))).toEqual({ visible: false });
    expect(stateFromUrl(new URLSearchParams("dispProxy=https://p.example/"))).toEqual({ proxyUrl: "https://p.example" });
  });
});

describe("fit settings", () => {
  it("validates model settings from a project", () => {
    const s = parseState({
      fit: { polyOrder: 2, annual: true, semiannual: "yes", steps: ["2020-06-15", "bad", "2019-01-01", "2020-06-15"], rejectOutliers: true },
      tsView: "residuals",
    });
    expect(s.fit).toEqual({ polyOrder: 2, annual: true, semiannual: false, steps: ["2019-01-01", "2020-06-15"], rejectOutliers: true });
    expect(s.tsView).toBe("residuals");
    expect(parseState({ fit: { polyOrder: 7 } }).fit?.polyOrder).toBe(1);
  });
});

import { resolveSiteConfig, siteBase } from "../src/site";

describe("static site", () => {
  it("derives the site base from the plugin bundle URL", () => {
    expect(siteBase("https://mgovorcin.github.io/disp-portal-dev/plugins/opera-disp/dist/index.js")).toBe(
      "https://mgovorcin.github.io/disp-portal-dev/",
    );
    expect(siteBase("http://localhost:8790/plugins/opera-disp/dist/index.js")).toBe("http://localhost:8790/");
  });
  it("resolves relative basemap and demo URLs", () => {
    const cfg = resolveSiteConfig(
      {
        mode: "static",
        demoProject: "demo/context-layers.geolibre",
        basemaps: [{ key: "dark", name: "Dark", attribution: "", maxzoom: 19, tiles: [], labels: null, style_url: "basemaps/dark.json" }],
      },
      "https://mgovorcin.github.io/disp-portal-dev/",
    );
    expect(cfg.basemaps?.[0].style_url).toBe("https://mgovorcin.github.io/disp-portal-dev/basemaps/dark.json");
    expect(cfg.demoProject).toBe("https://mgovorcin.github.io/disp-portal-dev/demo/context-layers.geolibre");
  });
});

describe("static overview mirror", () => {
  it("keeps tile placeholders when resolving against the site base", () => {
    const cfg = resolveSiteConfig(
      { mode: "static", overview: { tiles: "overview/{dir}/vel/{z}/{x}/{y}.png", extent: "overview/{dir}/extent.json", maxzoom: 9 } },
      "https://mgovorcin.github.io/disp-portal-dev/",
    );
    expect(cfg.overview?.tiles).toBe("https://mgovorcin.github.io/disp-portal-dev/overview/{dir}/vel/{z}/{x}/{y}.png");
    expect(cfg.overview?.extent).toBe("https://mgovorcin.github.io/disp-portal-dev/overview/{dir}/extent.json");
    expect(cfg.overview?.maxzoom).toBe(9);
  });
});
