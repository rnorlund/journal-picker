"""Smoke-test the DEPLOYED site. Opt-in only.

Every run pulls multi-megabyte catalogs over the production CDN, and doing it
routinely is what exhausted the free tier's bandwidth and left Netlify refusing
production deploys (drafts still worked, which is the tell). Test against
localhost during development; run this only to confirm a release.

    JP_PROD=1 python3 test/ui-prod.py
"""
import os, sys
if not os.environ.get('JP_PROD'):
    print('skipped: set JP_PROD=1 to test against production (uses CDN bandwidth)')
    sys.exit(0)

import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':900})
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        pg.on('console',lambda m: errs.append('console:'+m.text) if m.type=='error' else None)
        await pg.goto('https://journal-picker.netlify.app/', wait_until='load')
        print('title:', await pg.title())
        await pg.click('#demoBtn')
        for _ in range(100):
            if await pg.locator('.card').count(): break
            st=await pg.inner_text('#status')
            if 'credit' in st.lower() or 'wrong' in st.lower(): print('STATUS:',st); break
            await pg.wait_for_timeout(1000)
        n=await pg.locator('.card').count()
        print('cards:', n)
        if n:
            print('count:', await pg.inner_text('.res-count'))
            for i in range(min(5,n)):
                c=pg.locator('.card').nth(i)
                print(f"   {await c.locator('.fitnum').inner_text():>3}% {await c.locator('.cost-amount').inner_text():>8}  {await c.locator('.jname').inner_text()}")
        await pg.screenshot(path='/tmp/s-prod.png')
        print('errors:', [e for e in errs if 'favicon' not in e][:4] or 'none')
        await b.close()
asyncio.run(main())
