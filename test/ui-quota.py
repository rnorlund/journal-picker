import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':800})
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8899/index.html')
        await pg.click('#demoBtn')
        # wait for either cards or an error status
        for _ in range(120):
            if await pg.locator('.card').count(): print('CARDS rendered'); break
            st = await pg.inner_text('#status')
            if 'credit' in st.lower() or 'limit' in st.lower() or 'wrong' in st.lower():
                print('STATUS:', st); break
            await pg.wait_for_timeout(1000)
        else: print('timed out with status:', await pg.inner_text('#status'))
        print('quota chip:', (await pg.inner_text('#quota')) if not await pg.locator('#quota').is_hidden() else '(hidden)')
        print('keybox open:', await pg.locator('#keyBox').get_attribute('open'))
        print('keystate:', await pg.inner_text('#keyState'))
        await pg.screenshot(path='/tmp/s-quota.png')
        print('pageerrors:', errs or 'none')
        await b.close()
asyncio.run(main())
