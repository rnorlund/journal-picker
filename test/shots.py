import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':900})
        await pg.goto('http://localhost:8899/index.html')
        await pg.click('#demoBtn'); await pg.wait_for_selector('.card',timeout=90000)
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path='/tmp/s-top.png')
        # open a details panel on first card then shoot the results region
        await pg.locator('.card .papers summary').first.click()
        await pg.wait_for_timeout(300)
        await pg.locator('#results').scroll_into_view_if_needed(); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/tmp/s-cards.png')
        await pg.locator('#filterPanel').scroll_into_view_if_needed(); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/tmp/s-filters.png')
        await b.close()
asyncio.run(main())
