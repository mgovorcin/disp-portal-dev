"""End-to-end check of the opera-disp plugin inside GeoLibre web (headless Chromium).

Opens https://web.geolibre.app/?url=<proxy>/project.json, accepts the plugin trust
prompt, then checks the plugin panel, velocity tiles, identify, direction and basemap
switching, and the Layers panel entries. Screenshots go to results/phase1/.

Chrome's Local Network Access check blocks https pages from calling localhost until
the user allows it; headless Chrome denies by default, so the permission is granted here.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_geolibre.py [--proxy http://127.0.0.1:8790]
"""

from __future__ import annotations

import argparse
import contextlib
import math
import re
from pathlib import Path

from playwright.sync_api import Page, sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeout

GEOLIBRE = "https://web.geolibre.app"


def lonlat_to_offset(lon: float, lat: float, center: tuple[float, float], zoom: float) -> tuple[float, float]:
    """Pixel offset of lon/lat from the map centre (Web Mercator, 512 px tiles as in MapLibre)."""
    scale = 512 * 2**zoom / (2 * math.pi)

    def project(lo: float, la: float) -> tuple[float, float]:
        return scale * math.radians(lo), -scale * math.log(math.tan(math.pi / 4 + math.radians(la) / 2))

    x0, y0 = project(*center)
    x1, y1 = project(lon, lat)
    return x1 - x0, y1 - y0


def accept_trust(page) -> None:
    """GeoLibre web asks to trust project plugins; the self-hosted build does not."""
    button = page.get_by_role("button", name="Trust and load")
    with contextlib.suppress(PlaywrightTimeout):  # no prompt on the self-hosted build
        button.click(timeout=8_000)


def panel_text(page: Page) -> str:
    return page.locator(".od-panel").inner_text()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        context.grant_permissions(["local-network-access"], origin=GEOLIBRE)
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"[:200]))
        tile_requests: list[str] = []
        page.on("request", lambda r: tile_requests.append(r.url) if "/tiles/" in r.url else None)

        # The proxy root redirects to GeoLibre web with its project, as a user would open it.
        # The project sets the Houston view the click offsets below assume.
        page.goto(f"{args.proxy}/?lon=-95.4&lat=29.8&z=8", wait_until="domcontentloaded", timeout=90_000)
        accept_trust(page)
        page.wait_for_selector(".od-panel", timeout=60_000)
        page.wait_for_function(
            "document.querySelector('.od-panel')?.innerText.includes('Tiles generated')", timeout=60_000
        )
        page.wait_for_timeout(6000)
        page.screenshot(path=args.out / "geolibre_plugin.png")
        print("velocity tile requests:", len(tile_requests), tile_requests[:1])
        text = panel_text(page)
        print("legend:", re.search(r"Tiles generated[^\n]*", text).group(0))
        frames = re.search(r"\d+ asc frame\(s\) in view[^\n]*|No OPERA frames in view\.|Zoom in[^\n]*", text)
        print("frames:", frames.group(0) if frames else "(none listed)")

        page.locator(".od-ts-mode button").click()  # time-series mode is off by default
        canvas = page.locator("canvas.maplibregl-canvas").first
        box = canvas.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_function(
            "document.querySelector('.od-readout')?.innerText.includes('Ascending')", timeout=30_000
        )
        print("identify:", page.locator(".od-readout").inner_text().replace("\n", " | "))

        # 1c: the identify click above also added time series P1; the chart window opens.
        chart = page.locator(".od-chart-panel")
        chart.wait_for(timeout=30_000)
        try:
            page.wait_for_function(
                "(document.querySelector('.od-ts-table')?.innerText.match(/epochs/g) || []).length >= 2",
                timeout=120_000,
            )
        except Exception:
            page.screenshot(path=args.out / "geolibre_timeseries_timeout.png")
            print("TIMEOUT; tables:", [t.inner_text() for t in page.locator(".od-ts-table").all()])
            print("picks:", page.locator(".od-picks").inner_text())
            raise
        # Second point on land near Lake Jackson, below the chart window (which floats top-left).
        dx, dy = lonlat_to_offset(-95.43, 29.05, center=(-95.4, 29.8), zoom=8)
        page.mouse.click(box["x"] + box["width"] / 2 + dx, box["y"] + box["height"] / 2 + dy)
        page.wait_for_function(
            "(document.querySelector('.od-ts-table')?.innerText.match(/epochs|No valid data|No OPERA|failed/g) || []).length >= 4",
            timeout=120_000,
        )
        print("time series:\n  " + page.locator(".od-ts-table").inner_text().replace("\n", "\n  "))
        print("uPlot canvas:", page.locator(".od-chart canvas").count() > 0)
        page.screenshot(path=args.out / "geolibre_timeseries.png")
        chart.locator("select[aria-label='Reference series']").select_option(label="P1")
        page.wait_for_timeout(1000)
        print("reference applied:", "reference" in page.locator(".od-ts-table").inner_text())
        with page.expect_download() as download:
            chart.get_by_role("button", name="Export CSV").click()
        csv_path = args.out / "geolibre_timeseries.csv"
        download.value.save_as(csv_path)
        lines = csv_path.read_text().splitlines()
        print(f"CSV: {len(lines) - 1} rows; header: {lines[0]}")
        print("CSV first row:", lines[1][:160] if len(lines) > 1 else "(empty)")
        page.screenshot(path=args.out / "geolibre_timeseries_relative.png")

        tile_requests.clear()
        page.locator(".od-panel input[value=desc]").check()
        page.wait_for_timeout(4000)
        print("after switching to descending, tile requests:", len(tile_requests), tile_requests[:1])

        basemap_tiles: list[str] = []
        page.on("request", lambda r: basemap_tiles.append(r.url) if "google.com/vt" in r.url else None)
        tile_requests.clear()
        page.locator(".od-panel select[aria-label='Basemap']").select_option("hybrid")
        page.wait_for_timeout(8000)
        page.screenshot(path=args.out / "geolibre_plugin_hybrid.png")
        print("basemap after selecting hybrid:", page.locator(".od-panel select[aria-label='Basemap']").input_value())
        print("google tiles requested:", len(basemap_tiles))
        page.mouse.wheel(0, -300)  # zoom in a little so new velocity tiles must load on the new style
        page.wait_for_timeout(5000)
        print("velocity tiles after basemap switch + zoom:", len(tile_requests))
        body = page.inner_text("body")
        print("Layers panel lists velocity:", "OPERA DISP velocity" in body)
        print("Layers panel lists frames:", "OPERA DISP frames" in body)
        page.locator(".od-panel select[aria-label='Basemap']").select_option("dark")
        page.wait_for_timeout(6000)
        page.screenshot(path=args.out / "geolibre_plugin_dark.png")
        print("basemap after selecting dark:", page.locator(".od-panel select[aria-label='Basemap']").input_value())
        print("velocity still ticked:", page.locator(".od-panel input[type=checkbox]").first.is_checked())
        print("console errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()


def open_card(section) -> None:
    """Expand a collapsible sidebar card (plugin v0.3+) if it is closed."""
    details = section.locator("details").first
    if details.count() and not details.evaluate("d => d.open"):
        section.locator("summary").first.click()
