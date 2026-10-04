"""Check analysis from downloaded cubes and time-series points surviving a reload
(self-hosted GeoLibre, headless Chromium). Screenshots go to results/phase2/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright python scripts/check_phase2b.py
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
    parser.add_argument("--out", type=Path, default=Path("results/phase2"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1500, "height": 1000}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))

        # 1. analysis from downloaded cubes (demo layer; only features inside the cubes get values)
        page.goto(f"{args.proxy}/?demo=1&lon=-95.38&lat=29.76&z=13", wait_until="domcontentloaded", timeout=90_000)
        panel = page.locator(".od-panel")
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(3000)
        section = panel.locator("section:has(h3:text('Analyze layer'))")
        open_card(section)
        layer = section.locator("select[aria-label='Layer to analyse']")
        layer.focus()
        layer.select_option(label="Houston demo features")
        section.locator("select[aria-label='Velocity from']").select_option("cube")
        section.locator("select[aria-label='Directions']").select_option("asc")
        section.get_by_role("button", name="Analyze", exact=True).click()
        results = page.locator(".od-analysis")
        results.wait_for(timeout=30_000)
        page.wait_for_function("document.querySelector('.od-analysis')?.innerText.includes('analysed')", timeout=120_000)
        print("status:", results.locator("p.od-muted").first.inner_text())
        for row in results.locator("table tr").all()[:6]:
            print("  ", " | ".join(row.locator("th, td").all_inner_texts()))
        page.screenshot(path=args.out / "analysis_from_cubes.png")

        # 2. a time-series point survives a reload (saved with the autosaved project)
        page.goto(f"{args.proxy}/?lon=-95.38&lat=29.76&z=13", wait_until="domcontentloaded", timeout=90_000)
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(2000)
        page.locator(".od-ts-mode button").click()
        box = page.locator("canvas.maplibregl-canvas").first.bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.7)
        page.wait_for_timeout(1500)
        before = panel.locator(".od-picks li").all_inner_texts()
        print("points before reload:", [b.split("·")[0].strip() for b in before])
        page.wait_for_timeout(5000)  # GeoLibre autosaves after ~3 s
        page.reload(wait_until="domcontentloaded")
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(5000)
        after = panel.locator(".od-picks li").all_inner_texts()
        print("points after reload:", [a.split("·")[0].strip() for a in after])
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
