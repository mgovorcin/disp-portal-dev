"""Check the "Combined" block of a finished job (merged frames + vertical/east) in GeoLibre.

Opens the jobs window, prints the combined summary, adds the vertical-velocity COG and
takes a screenshot. Needs a finished job with combined outputs (e.g. jobs/test-combine).

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \\
  jobs-env/bin/python scripts/check_combined.py [--proxy http://127.0.0.1:8790] [--job test-combine]
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
    parser.add_argument("--job", default="test-combine")
    parser.add_argument("--out", type=Path, default=Path("results/phase2"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"[:200]))
        page.goto(f"{args.proxy}/?lon=-95.38&lat=29.76&z=13", wait_until="domcontentloaded", timeout=90_000)
        panel = page.locator(".od-panel")
        panel.wait_for(timeout=60_000)
        page.wait_for_timeout(2000)
        section = panel.locator("section:has(h3:text('Download subset (DISP-S1)'))")
        open_card(section)
        print("merge option checked:", section.locator("label:has-text('merge + vertical/east') input").is_checked())
        section.get_by_role("button", name="Downloads").click()
        jobs = page.locator(".od-jobs")
        jobs.wait_for(timeout=30_000)
        combined = jobs.locator(".od-job", has=page.locator(f"text={args.job}")).locator(".od-combined")
        combined.wait_for(timeout=30_000)
        print("combined block:\n  " + combined.inner_text().replace("\n", "\n  "))
        combined.get_by_role("button", name="vertical", exact=True).click()
        page.wait_for_function("document.body.innerText.includes('combined vertical (COG)')", timeout=30_000)
        print("vertical COG in Layers panel: True")
        page.wait_for_timeout(5000)
        page.screenshot(path=args.out / "combined_vertical.png")
        print("page errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
