"""Headless browser check of the running disp-proxy viewer.

Loads the viewer, waits for the velocity tiles, clicks a point, waits for the
ASF time series chart, and saves screenshots. Also loads the tiles from a page on
a *different* origin to confirm CORS works for MapLibre WebGL textures.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_viewer.py [--proxy http://127.0.0.1:8790] [--out results/phase1]
"""

from __future__ import annotations

import argparse
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

CROSS_ORIGIN_PAGE = """<!doctype html><html><head>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl.css">
<script src="https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl.js"></script>
<style>html,body,#m{margin:0;height:100%}</style></head><body><div id="m"></div><script>
window.tileErrors = 0;
const map = new maplibregl.Map({container: "m", center: [-95.4, 29.8], zoom: 9, style: {version: 8,
  sources: {v: {type: "raster", tileSize: 256, maxzoom: 12, tiles: ["PROXY/tiles/desc/vel/{z}/{x}/{y}.png"]}},
  layers: [{id: "v", type: "raster", source: "v"}]}});
map.on("error", () => { window.tileErrors += 1; });
map.on("idle", () => { window.mapIdle = true; });
</script></body></html>"""


def serve_cross_origin(proxy: str, port: int) -> http.server.ThreadingHTTPServer:
    body = CROSS_ORIGIN_PAGE.replace("PROXY", proxy).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1"))
    parser.add_argument("--lon", type=float, default=-95.37)
    parser.add_argument("--lat", type=float, default=29.76)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{args.proxy}/viewer?lon={args.lon}&lat={args.lat}&z=9")
        page.wait_for_function("document.querySelector('#meta').textContent.length > 0", timeout=30_000)
        page.wait_for_timeout(4000)
        page.screenshot(path=args.out / "viewer_map.png")
        print("legend:", page.inner_text("#meta"))

        failed_tiles: list[str] = []
        page.on("response", lambda r: failed_tiles.append(f"{r.status} {r.url[:90]}") if r.status >= 400 else None)
        for key in ("light", "dark", "osm", "satellite", "hybrid"):
            page.select_option("#basemap", key)
            page.wait_for_timeout(3000)
            page.screenshot(path=args.out / f"basemap_{key}.png")
        print("basemap tile failures:", failed_tiles or "none")
        page.select_option("#basemap", "light")

        page.mouse.click(640, 400)
        page.wait_for_selector("#chart canvas", timeout=90_000)
        page.wait_for_timeout(1000)
        print("status:", page.inner_text("#status"))
        page.screenshot(path=args.out / "viewer_timeseries.png")

        server = serve_cross_origin(args.proxy, 8791)
        other = browser.new_page(viewport={"width": 800, "height": 600})
        other.goto("http://127.0.0.1:8791/")
        other.wait_for_function("window.mapIdle === true", timeout=60_000)
        print("cross-origin tile errors:", other.evaluate("window.tileErrors"))
        other.screenshot(path=args.out / "cross_origin.png")
        server.shutdown()

        print("console errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
