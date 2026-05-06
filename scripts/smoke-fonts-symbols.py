#!/usr/bin/env python3
"""Headless smoke check for /fonts, /symbols and the redesigned home page.

Uses the python `playwright` install at /opt/homebrew/bin/playwright (and the
Chromium binary it bundled at ~/Library/Caches/ms-playwright/chromium-1187/...).
Run while `apple-docs web serve` is up on localhost:3000:

    python3 scripts/smoke-fonts-symbols.py

Writes screenshots to dist/smoke/{home,fonts,symbols}.png.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get("APPLE_DOCS_URL", "http://127.0.0.1:3000")
OUT = Path(__file__).resolve().parent.parent / "dist" / "smoke"
OUT.mkdir(parents=True, exist_ok=True)


def main() -> int:
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()

            # /fonts ------------------------------------------------------
            page.goto(f"{URL}/fonts")
            page.wait_for_selector(".font-preview-line")
            page.wait_for_function(
                "() => document.querySelectorAll('.font-pill').length > 0",
                timeout=10_000,
            )
            family_count = page.locator(".font-family").count()
            pill_count = page.locator(".font-pill").count()
            face_rules = page.evaluate(
                "() => document.getElementById('fonts-page-faces')?.sheet?.cssRules?.length ?? 0"
            )
            badges = page.locator(".font-family__badge").count()
            page.screenshot(path=str(OUT / "fonts.png"), full_page=True)
            if family_count < 1:
                failures.append("/fonts: no family cards rendered")
            if pill_count < 1:
                failures.append("/fonts: no weight pills rendered")
            if face_rules < 10:
                failures.append(f"/fonts: only {face_rules} @font-face rules injected")
            if badges < 1:
                failures.append("/fonts: no category badges rendered")

            # /symbols ----------------------------------------------------
            page.goto(f"{URL}/symbols")
            page.wait_for_selector("#symbols-status")
            page.wait_for_function(
                "() => document.querySelectorAll('.symbol-tile').length > 30",
                timeout=20_000,
            )
            # Mask-image fetches are kicked off when tiles mount, but each cold
            # SVG render takes ~400ms server-side (it shells out to Swift). Give
            # the network a chance to settle before the screenshot so the
            # finished image actually shows the icons.
            try:
                page.wait_for_load_state("networkidle", timeout=60_000)
            except Exception:
                pass
            tile_count = page.locator(".symbol-tile").count()
            page.locator(".symbol-tile").first.click()
            page.wait_for_selector("#symbols-detail:not([hidden])")
            try:
                page.wait_for_load_state("networkidle", timeout=15_000)
            except Exception:
                pass
            metadata_keys = page.locator("#symbols-detail-meta dt").count()
            page.screenshot(path=str(OUT / "symbols.png"), full_page=True)
            if tile_count < 30:
                failures.append(f"/symbols: only {tile_count} tiles mounted")
            if metadata_keys < 1:
                failures.append("/symbols: detail pane did not populate metadata")

            # / -----------------------------------------------------------
            page.goto(f"{URL}/")
            page.wait_for_selector("section#design")
            fonts_link = page.locator("section#design a", has_text="Apple Fonts").count()
            symbols_link = page.locator("section#design a", has_text="SF Symbols").count()
            page.screenshot(path=str(OUT / "home.png"), full_page=True)
            if fonts_link != 1:
                failures.append(f"/: expected 1 'Apple Fonts' link in design section, got {fonts_link}")
            if symbols_link != 1:
                failures.append(f"/: expected 1 'SF Symbols' link in design section, got {symbols_link}")

        finally:
            browser.close()

    if failures:
        print("FAIL")
        for line in failures:
            print(f"  - {line}")
        return 1
    print("OK — screenshots in", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
