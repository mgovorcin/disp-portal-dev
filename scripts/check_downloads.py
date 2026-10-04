"""End-to-end check of Phase 1e in the self-hosted GeoLibre (headless Chromium).

1. click a point: the time-series window shows the Earthdata loading banner, and the
   "OPERA DISP time-series points" layer is listed in the Layers panel;
2. "Download subset (DISP-S1)" for the current view (zoomed in), ascending, Q1 2023;
   wait for the job, then "Show velocity" loads the GeoZarr cube as a GeoLibre Zarr layer.
Screenshots go to results/phase1e/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_downloads.py [--proxy http://127.0.0.1:8790]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from check_geolibre import open_card


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1e"))
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

        # 1. loading banner + points layer
        canvas = page.locator("canvas.maplibregl-canvas").first.bounding_box()
        page.mouse.click(canvas["x"] + canvas["width"] * 0.7, canvas["y"] + canvas["height"] * 0.8)
        banner = page.locator(".od-loading")
        banner.wait_for(state="visible", timeout=30_000)
        print("loading banner:", banner.inner_text())
        page.screenshot(path=args.out / "timeseries_loading.png")
        page.wait_for_function("document.body.innerText.includes('OPERA DISP time-series points')", timeout=30_000)
        print("points layer in Layers panel: True")
        banner.wait_for(state="hidden", timeout=180_000)
        print("banner hidden after load; table:", page.locator(".od-ts-table").inner_text().splitlines()[:2])
        # close the chart window so the map is free
        chart_close = page.locator("text=OPERA DISP time series").locator("xpath=..").locator("button").last
        if chart_close.count():
            chart_close.click()

        # 2. download for the current view
        section = panel.locator("section:has(h3:text('Download subset (DISP-S1)'))")
        open_card(section)
        section.locator("select[aria-label='Area']").select_option("view")
        print("area:", section.locator("p.od-muted").first.inner_text())
        section.locator("input[aria-label='Start date']").fill("2023-01-01")
        section.locator("input[aria-label='End date']").fill("2023-03-31")
        section.locator("label:has-text('descending') input").uncheck()
        section.locator("label:has-text('GeoTIFF (COG)') input").check()
        section.get_by_role("button", name="Download & prepare").click()
        jobs = page.locator(".od-jobs")
        jobs.wait_for(timeout=30_000)
        page.wait_for_function(
            "(() => { const t = document.querySelector('.od-jobs')?.innerText || ''; "
            "return /\\bdone\\b/.test(t.split('\\n').slice(0, 8).join(' ')) || t.includes('failed') || t.includes('Error:'); })()",
            timeout=600_000,
        )
        first_job = jobs.locator(".od-job").first
        print("job:", " | ".join(first_job.inner_text().splitlines()[:6]))
        page.screenshot(path=args.out / "downloads_done.png")
        show = first_job.get_by_role("button", name="Show velocity").first.element_handle()
        show.click()
        page.wait_for_function("(b) => b.textContent !== 'Show velocity'", arg=show, timeout=30_000)
        page.wait_for_function("document.body.innerText.includes('asc velocity (2023-01-01')", timeout=30_000)
        page.wait_for_timeout(5000)
        print("Show velocity button:", show.inner_text())
        print("zarr layer in Layers panel:", "asc velocity (2023-01-01" in page.inner_text("body"))
        cog = first_job.locator(".od-tif-row").get_by_role("button", name="velocity", exact=True).first.element_handle()
        cog.click()
        page.wait_for_function("(b) => b.textContent !== 'velocity'", arg=cog, timeout=30_000)
        page.wait_for_timeout(4000)
        print("COG button:", cog.text_content(), "| COG layer in Layers panel:", "asc velocity (COG)" in page.inner_text("body"))
        print("disk:", jobs.locator(".od-chart-toolbar").inner_text().replace("\n", " "))
        page.screenshot(path=args.out / "geozarr_velocity.png")
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
