import asyncio, os

# Institutional agreement lists are licensed to the subscribing institution, so
# none ships with the repo. Point this at your own library's list:
#   JP_AGREEMENT=/path/to/list.xlsm python3 test/ui-agreement.py
AGREEMENT_FILE = os.environ.get('JP_AGREEMENT', 'USC Open Access Pub list.xlsm')

if not os.path.exists(AGREEMENT_FILE):
    print(f'skipped: no agreement list at {AGREEMENT_FILE}')
    print("These lists are licensed to the subscribing institution, so none ships here.")
    print('Point the test at your own list:  JP_AGREEMENT=/path/to/list.xlsm python3 test/ui-agreement.py')
    raise SystemExit(0)
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':900})
        errs=[]; pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
        pg.on('pageerror',lambda e: errs.append('PAGEERROR: '+str(e)))
        await pg.goto('http://localhost:8899/index.html')
        await pg.click('#demoBtn'); await pg.wait_for_selector('.card',timeout=90000)
        await pg.wait_for_timeout(1000)
        base=await pg.inner_text('.res-count')
        print('before upload:', base)
        # The panel is a collapsed <details>; hidden elements report empty text,
        # so open it before reading status.
        await pg.click('#agreeBox summary')
        await pg.set_input_files('#agreeFile',AGREEMENT_FILE)
        await pg.wait_for_timeout(4000)
        print('agreement status:', (await pg.inner_text('#agreeStatus')).replace('\n',' | '))
        print('after upload:', await pg.inner_text('.res-count'))
        cov = await pg.locator('.card.covered').count()
        print('covered cards:', cov)
        for i in range(min(10,cov)):
            c=pg.locator('.card.covered').nth(i)
            print(f"   {await c.locator('.cost-amount').inner_text():>7} {await c.locator('.cost-label').inner_text():<32} {await c.locator('.jname').inner_text()}")
        # agreement-only filter
        await pg.check('#agreeOnly'); await pg.wait_for_timeout(500)
        print('agreement-only:', await pg.inner_text('.res-count'))
        # free+OA now that agreement is loaded
        await pg.check('input[name="route"][value="freeoa"]'); await pg.wait_for_timeout(500)
        print('free+OA & covered:', await pg.inner_text('.res-count'))
        n=await pg.locator('.card').count()
        for i in range(min(8,n)):
            c=pg.locator('.card').nth(i)
            print(f"   {await c.locator('.fitnum').inner_text():>3}% {await c.locator('.cost-amount').inner_text():>5} {await c.locator('.jname').inner_text()}")
        await pg.locator('#results').scroll_into_view_if_needed(); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/tmp/s-covered.png')
        print('ERRORS:', errs[:6] if errs else 'none')
        await b.close()
asyncio.run(main())
