#!/usr/bin/env python3
"""Render status/grid.html to status/progress.png.

Edit grid.html, then run this. Kept separate from PROGRESS.md on purpose:
the markdown is the source of truth for detail, this is the at-a-glance view.
"""
import asyncio, pathlib
from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).parent

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1560, 'height': 1200}, device_scale_factor=2)
        await pg.goto((HERE / 'grid.html').as_uri())
        await pg.wait_for_timeout(400)
        out = HERE / 'progress.png'
        await pg.screenshot(path=str(out), full_page=True)
        print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
        await b.close()

asyncio.run(main())
