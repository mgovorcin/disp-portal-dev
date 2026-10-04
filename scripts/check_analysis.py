"""End-to-end check of "Analyze layer" (Phase 1d) inside GeoLibre web (headless Chromium).

Opens <proxy>/?demo=1 (GeoLibre with the Houston demo layer), analyses that layer for
both directions, checks the results table and the new result layer, exports the CSV,
and sends the hotspots to the time-series chart. Screenshots go to results/phase1/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_analysis.py [--proxy http://127.0.0.1:8790]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from check_geolibre import accept_trust

GEOLIBRE = "https://web.geolibre.app"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1500, "height": 950})
        context.grant_permissions(["local-network-access"], origin=GEOLIBRE)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"[:200]))

        page.goto(f"{args.proxy}/?demo=1", wait_until="domcontentloaded", timeout=90_000)
        accept_trust(page)
        panel = page.locator(".od-panel")
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(3000)

        layer_select = panel.locator("select[aria-label='Layer to analyse']")
        layer_select.focus()
        options = layer_select.locator("option").all_inner_texts()
        print("layers offered:", options)
        layer_select.select_option(label="Houston demo features")
        panel.get_by_role("button", name="Analyze", exact=True).click()

        results = page.locator(".od-analysis")
        results.wait_for(timeout=30_000)
        page.wait_for_function(
            "document.querySelector('.od-analysis')?.innerText.includes('feature(s) analysed')"
            " || document.querySelector('.od-analysis')?.innerText.includes('failed')",
            timeout=120_000,
        )
        print("status:", results.locator("p.od-muted").first.inner_text())
        for row in results.locator("table tr").all()[:12]:
            print("  ", " | ".join(row.locator("th, td").all_inner_texts()))
        body = page.inner_text("body")
        print("result layer in Layers panel:", "Houston demo features · OPERA velocity" in body)
        print("hotspot layer in Layers panel:", "Houston demo features · hotspots" in body)
        page.screenshot(path=args.out / "geolibre_analysis.png")
        close = page.locator("text=OPERA DISP analysis").locator("xpath=..").locator("button").last
        close.click()
        panel.locator("label:has-text('Show velocity overview') input").uncheck()
        page.wait_for_timeout(3000)
        page.screenshot(path=args.out / "geolibre_analysis_map.png")
        panel.get_by_role("button", name="Open results").click()
        results.wait_for(timeout=10_000)

        with page.expect_download() as download:
            results.get_by_role("button", name="Export CSV").click()
        csv_path = args.out / "geolibre_analysis.csv"
        download.value.save_as(csv_path)
        lines = csv_path.read_text().splitlines()
        print(f"CSV: {len(lines) - 1} rows; columns: {lines[0]}")

        results.locator("table tbody tr").first.click()
        page.wait_for_timeout(2500)
        page.screenshot(path=args.out / "geolibre_analysis_zoom.png")

        results.get_by_role("button", name="Time series for top").click()
        page.locator(".od-chart-panel:not(.od-analysis)").wait_for(timeout=30_000)
        page.wait_for_function(
            "!(document.querySelector('.od-ts-table')?.innerText || 'loading').includes('loading')",
            timeout=180_000,
        )
        print("time series from hotspots:\n  " + page.locator(".od-ts-table").inner_text().replace("\n", "\n  "))
        page.screenshot(path=args.out / "geolibre_analysis_timeseries.png")
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
