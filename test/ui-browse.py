import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':950})
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        pg.on('console',lambda m: errs.append('console: '+m.text) if m.type=='error' else None)
        await pg.goto('http://localhost:8899/index.html')
        await pg.click('#modeBrowse')
        await pg.wait_for_selector('.card', timeout=45000)
        await pg.wait_for_timeout(600)
        print('browse default:', await pg.inner_text('#browseCount'))
        print('  cards:', await pg.locator('.card').count())
        for preset,label in [('diamond','free + OA'),('free','free to publish'),('cheap','under $1.5k'),('all','everything')]:
            await pg.click(f'.qp[data-preset="{preset}"]'); await pg.wait_for_timeout(700)
            n=await pg.locator('.card').count()
            print(f'  preset {label:18s} -> {await pg.inner_text("#browseCount")} | {n} cards')
            if preset=='diamond':
                for i in range(min(6,n)):
                    c=pg.locator('.card').nth(i)
                    amt=await c.locator('.cost-amount').inner_text()
                    nm=await c.locator('.jname').inner_text()
                    print(f"       {amt:>5}  {nm}")
        # search + sort
        await pg.click('.qp[data-preset="all"]'); await pg.wait_for_timeout(500)
        await pg.fill('#browseQ','dental'); await pg.wait_for_timeout(900)
        print('  search "dental":', await pg.inner_text('#browseCount'))
        await pg.fill('#browseQ',''); await pg.wait_for_timeout(900)
        await pg.select_option('#browseSort','cheap'); await pg.wait_for_timeout(800)
        print('  sorted cheapest, first 4:')
        for i in range(4):
            c=pg.locator('.card').nth(i)
            print(f"       {await c.locator('.cost-amount').inner_text():>7}  {await c.locator('.jname').inner_text()}")
        # back to match mode still works
        await pg.click('#modeMatch'); await pg.wait_for_timeout(300)
        print('  match panel visible again:', not await pg.locator('#matchPanel').is_hidden())
        await pg.click('#modeBrowse'); await pg.wait_for_timeout(600)
        await pg.click('.qp[data-preset="diamond"]'); await pg.wait_for_timeout(700)
        await pg.locator('#results').scroll_into_view_if_needed(); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/tmp/s-browse.png')
        print('  errors:', errs[:5] or 'none')
        await b.close()
asyncio.run(main())
