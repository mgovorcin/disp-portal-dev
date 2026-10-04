"""End-to-end check of the interactive time-series chart and model fitting in GeoLibre web.

Adds two picks (Houston, Lake Jackson), turns on annual + semi-annual + outlier rejection,
adds a step by date and another by clicking the chart, zooms with the mouse wheel, switches
to residuals, and exports the data and fit CSVs. Screenshots go to results/phase1/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_timeseries_fit.py [--proxy http://127.0.0.1:8790]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from check_geolibre import GEOLIBRE, accept_trust, lonlat_to_offset


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1500, "height": 1000})
        context.grant_permissions(["local-network-access"], origin=GEOLIBRE)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"[:200]))
        page.goto(f"{args.proxy}/?lon=-95.4&lat=29.8&z=8", wait_until="domcontentloaded", timeout=90_000)
        accept_trust(page)
        page.locator(".od-panel").wait_for(timeout=60_000)
        page.wait_for_timeout(3000)

        canvas = page.locator("canvas.maplibregl-canvas").first.bounding_box()
        cx, cy = canvas["x"] + canvas["width"] / 2, canvas["y"] + canvas["height"] / 2
        page.locator(".od-ts-mode button").click()  # time-series mode is off by default
        page.mouse.click(cx, cy)  # P1 Houston
        chart = page.locator(".od-chart-panel")
        chart.wait_for(timeout=30_000)
        dx, dy = lonlat_to_offset(-95.43, 29.05, center=(-95.4, 29.8), zoom=8)
        page.mouse.click(cx + dx, cy + dy)  # P2 Lake Jackson (below the chart window)
        page.wait_for_function(
            "(document.querySelector('.od-ts-table')?.innerText.match(/epochs|No valid data|failed/g) || []).length >= 4",
            timeout=180_000,
        )

        print("x range after all series loaded:", chart.locator(".od-chart").get_attribute("data-x-range"))
        chart.locator("label:has-text('annual') input").first.check()
        chart.locator("label:has-text('semi-annual') input").check()
        chart.locator("label:has-text('reject 3σ outliers') input").check()
        chart.locator("input[type=date]").fill("2020-06-15")
        chart.get_by_role("button", name="Add step").click()
        page.wait_for_timeout(800)
        chart.get_by_role("button", name="Pick step on chart").click()
        over = chart.locator(".u-over")
        box = over.bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.25, box["y"] + box["height"] / 2)
        page.wait_for_timeout(800)
        steps = chart.locator(".od-chip").all_inner_texts()
        print("steps:", [s.replace("×", "").strip() for s in steps])
        print("model rows:")
        for line in chart.locator(".od-ts-table").inner_text().splitlines():
            if "rate" in line or "epochs" in line:
                print("  ", line)
        page.screenshot(path=args.out / "timeseries_fit.png")

        page.mouse.move(box["x"] + box["width"] * 0.7, box["y"] + box["height"] / 2)
        x_before = chart.locator(".od-chart").get_attribute("data-x-range")
        for _ in range(3):
            page.mouse.wheel(0, -200)
            page.wait_for_timeout(150)
        x_after = chart.locator(".od-chart").get_attribute("data-x-range")
        print("wheel zoom:", x_before, "->", x_after)
        page.screenshot(path=args.out / "timeseries_zoom.png")
        chart.get_by_role("button", name="Reset zoom").click()
        print("after reset:", chart.locator(".od-chart").get_attribute("data-x-range"))

        chart.locator("select[aria-label='View']").select_option("residuals")
        page.wait_for_timeout(800)
        print("residual view y label:", chart.locator(".u-axis .u-label").all_inner_texts())
        page.screenshot(path=args.out / "timeseries_residuals.png")

        for name, fname in (("Export CSV", "timeseries_fit_data.csv"), ("Export fit", "timeseries_fit_params.csv")):
            with page.expect_download() as download:
                chart.get_by_role("button", name=name).click()
            path = args.out / fname
            download.value.save_as(path)
            lines = path.read_text().splitlines()
            print(f"{name}: {len(lines) - 1} rows; header: {lines[0][:200]}")
            if name == "Export fit":
                for line in lines[1:]:
                    print("   ", line[:260])
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
