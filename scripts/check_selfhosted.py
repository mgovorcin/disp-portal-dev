"""Check the self-hosted GeoLibre (served by disp-proxy at /): OPERA DISP is present without
prompts and survives reloads. Also opens /?demo=1. Screenshots go to results/phase1/.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=/u/aurora-r0/govorcin/tmp/ms-playwright \
  python scripts/check_selfhosted.py [--proxy http://127.0.0.1:8790]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8790")
    parser.add_argument("--out", type=Path, default=Path("results/phase1"))
    args = parser.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        # No local-network permission granted: same origin must not need it.
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        page.on("response", lambda r: errors.append(f"{r.status} {r.url[:100]}") if r.status >= 400 else None)

        page.goto(f"{args.proxy}/", wait_until="domcontentloaded", timeout=90_000)
        for attempt in ("first load", "reload 1", "reload 2"):
            if attempt != "first load":
                page.reload(wait_until="domcontentloaded")
            page.locator(".od-panel").wait_for(timeout=60_000)
            page.wait_for_function("document.body.innerText.includes('OPERA DISP velocity')", timeout=30_000)
            body = page.inner_text("body")
            tiles_ok = page.wait_for_function(
                "document.querySelector('.od-panel')?.innerText.includes('Tiles generated')", timeout=30_000
            )
            print(
                f"{attempt}: url={page.url} panel=yes trust_prompt={'Trust and load' in body} "
                f"layers_panel_velocity={'OPERA DISP velocity' in body} legend={bool(tiles_ok)}"
            )
        page.screenshot(path=args.out / "selfhosted.png")

        page.goto(f"{args.proxy}/?demo=1", wait_until="domcontentloaded", timeout=90_000)
        page.locator(".od-panel").wait_for(timeout=60_000)
        page.wait_for_timeout(3000)
        body = page.inner_text("body")
        print(f"demo: url={page.url} demo_layer={'Houston demo features' in body} trust_prompt={'Trust and load' in body}")
        page.screenshot(path=args.out / "selfhosted_demo.png")
        print("errors:", errors or "none")
        browser.close()


if __name__ == "__main__":
    main()
