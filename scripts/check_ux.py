"""Check the v0.2 UX in the self-hosted GeoLibre (headless Chromium):
time-series mode button (off by default), cube series in the chart, search, annotations,
draw polygon, GeoZarr output option. Screenshots go to results/phase2/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright python scripts/check_ux.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase2"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1500, "height": 1000}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.goto(f"{args.proxy}/?lon=-95.38&lat=29.76&z=14", wait_until="domcontentloaded", timeout=90_000)
        panel = page.locator(".od-panel")
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(3000)
        print("version:", "v0.2.0" in panel.inner_text())
        print("GeoZarr output option:", panel.locator("label:has-text('GeoZarr cube') input").is_checked())
        print("GeoLibre search panel open (project):", page.locator("text=Search").count() > 0)

        # time-series mode: off by default -> a click adds no point
        mode = page.locator(".od-ts-mode button")
        print("mode button pressed:", mode.get_attribute("aria-pressed"))
        canvas = page.locator("canvas.maplibregl-canvas").first.bounding_box()
        page.mouse.click(canvas["x"] + canvas["width"] * 0.55, canvas["y"] + canvas["height"] * 0.55)
        page.wait_for_timeout(1500)
        print("points after click with mode off:", panel.locator(".od-picks li").count())
        mode.click()
        print("mode button pressed after toggle:", mode.get_attribute("aria-pressed"))
        page.mouse.click(canvas["x"] + canvas["width"] * 0.55, canvas["y"] + canvas["height"] * 0.55)
        chart = page.locator(".od-chart-panel").first
        chart.wait_for(timeout=30_000)
        page.wait_for_function("document.querySelector('.od-loading')?.hidden === true", timeout=180_000)
        page.wait_for_timeout(1500)
        table = page.locator(".od-ts-table").inner_text()
        print("chart rows:\n  " + "\n  ".join(line for line in table.splitlines() if line.strip())[:900])
        page.screenshot(path=args.out / "cube_and_asf_series.png")
        chart.locator("select[aria-label='Source']").select_option("cube")
        page.wait_for_timeout(800)
        page.screenshot(path=args.out / "cube_series_only.png")
        mode.click()  # off again

        # search
        search = panel.locator("input[aria-label='Search place or coordinates']")
        search.fill("29.05, -95.43")
        search.press("Enter")
        page.wait_for_timeout(2500)
        print("search coords:", panel.locator(".od-search-results").inner_text().strip()[:80])
        search.fill("Galveston, Texas")
        search.press("Enter")
        page.wait_for_function("document.querySelector('.od-search-results')?.children.length > 0", timeout=20_000)
        print("search place first result:", panel.locator(".od-search-results li").first.inner_text()[:80])

        # map tools
        panel.get_by_role("button", name="Annotations").click()
        page.wait_for_timeout(2500)
        print("annotations:", panel.locator("section:has(h3:text('Map tools')) p").inner_text())
        panel.locator("section:has(h3:text('Map tools'))").get_by_role("button", name="Draw polygon").click()
        page.wait_for_timeout(2500)
        print("draw:", panel.locator("section:has(h3:text('Map tools')) p").inner_text())
        page.screenshot(path=args.out / "tools.png")
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
