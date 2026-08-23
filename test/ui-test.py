import asyncio, sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width':1280,'height':1500})
        errs, logs = [], []
        pg.on('console', lambda m: (errs if m.type=='error' else logs).append(m.text))
        pg.on('pageerror', lambda e: errs.append('PAGEERROR: '+str(e)))
        await pg.goto('http://localhost:8899/index.html')
        await pg.click('#demoBtn')
        try:
            await pg.wait_for_selector('.card', timeout=90000)
        except Exception as e:
            print('NO CARDS:', e); print('ERRORS:', errs[:10]); await pg.screenshot(path='/tmp/jp-fail.png', full_page=True); await b.close(); sys.exit(1)
        await pg.wait_for_timeout(1500)
        n = await pg.locator('.card').count()
        status = await pg.inner_text('#status')
        print('cards:', n, '| status:', status)
        print('count line:', await pg.inner_text('.res-count'))
        # first 8 cards summary
        for i in range(min(8,n)):
            c = pg.locator('.card').nth(i)
            print(f"  {await c.locator('.fitnum').inner_text():>3}%  {await c.locator('.cost-amount').inner_text():>8}  {await c.locator('.cost-label').inner_text():<38}  {await c.locator('.jname').inner_text()}")
        # test filters
        await pg.fill('#apcSlider','0'); await pg.dispatch_event('#apcSlider','input')
        await pg.wait_for_timeout(400)
        print('\n-- APC cap $0 --'); print('  ', await pg.inner_text('.res-count'))
        await pg.check('input[name="route"][value="free"]'); await pg.wait_for_timeout(400)
        print('-- route=free --'); print('  ', await pg.inner_text('.res-count'))
        for i in range(min(5, await pg.locator('.card').count())):
            c = pg.locator('.card').nth(i)
            print(f"   {await c.locator('.cost-amount').inner_text():>7} {await c.locator('.cost-label').inner_text():<34} {await c.locator('.jname').inner_text()}")
        await pg.check('input[name="route"][value="freeoa")'.replace(')','')) if False else None
        await pg.check('input[name="route"][value="freeoa"]'); await pg.wait_for_timeout(400)
        print('-- route=free+OA --'); print('  ', await pg.inner_text('.res-count'))
        for i in range(min(5, await pg.locator('.card').count())):
            c = pg.locator('.card').nth(i)
            print(f"   {await c.locator('.cost-amount').inner_text():>7} {await c.locator('.jname').inner_text()}")
        # reset & screenshot
        await pg.check('input[name="route"][value="any"]')
        await pg.fill('#apcSlider','13'); await pg.dispatch_event('#apcSlider','input')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/jp-light.png', full_page=True)
        await pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='/tmp/jp-dark.png', full_page=True)
        print('\nCONSOLE ERRORS:', errs[:10] if errs else 'none')
        await b.close()
asyncio.run(main())
