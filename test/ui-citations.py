import asyncio
from playwright.async_api import async_playwright
REFS = """1. Smith J. Cortical thickness predicts naming in aphasia. NeuroImage. 2023;45:120-131.
2. Jones A. White matter integrity and anomia. Brain and Language, 2022, 88, 45-59.
3. Lee K. Arcuate fasciculus after stroke. NeuroImage: Clinical 2021;30:102-115.
4. Garcia M. Lesion-symptom mapping of naming. Brain and Language. 2020;77:12-24.
5. Chen L. Predicting recovery in post-stroke aphasia. Brain Communications, 2022;4:88.
6. Okafor N. Network reorganisation. Human Brain Mapping 2023;44:1123-1140.
7. Novak T. Naming treatment outcomes. Aphasiology, 2021, 35, 500-518.
8. Ahmed S. Cortical atrophy and semantics. Neurobiology of Language 2023;4:210-228.
9. Weber F. Grey matter and speech. Cortex. 2022;150:88-99.
"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1180,'height':950})
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        pg.on('console',lambda m: errs.append('console: '+m.text) if m.type=='error' else None)
        await pg.goto('http://localhost:8899/index.html')
        # baseline, no references
        await pg.click('#demoBtn'); await pg.wait_for_selector('.card',timeout=90000)
        await pg.wait_for_timeout(700)
        base=[]
        for i in range(6):
            c=pg.locator('.card').nth(i)
            base.append((await c.locator('.fitnum').inner_text(), await c.locator('.jname').inner_text()))
        print('WITHOUT references:')
        for f,n in base: print(f'   {f:>3}%  {n}')
        # now with references
        await pg.click('#refBox summary'); await pg.fill('#refs', REFS)
        await pg.wait_for_timeout(1400)
        print('\nlive feedback:', await pg.inner_text('#refStat'))
        # Wait for THIS run to finish, not for the stale cards from the demo run
        # to still be present -- matching '.card' immediately succeeds against
        # the previous results and reads them instead.
        await pg.evaluate("document.getElementById('status').textContent = 'PENDING'")
        await pg.click('#goBtn')
        await pg.wait_for_function(
            "() => document.getElementById('status').textContent.startsWith('Done')",
            timeout=120000)
        await pg.wait_for_timeout(700)
        print('\nWITH references:')
        for i in range(8):
            c=pg.locator('.card').nth(i)
            badges=await c.locator('.badge.b-cite').count()
            cite=await c.locator('.badge.b-cite').inner_text() if badges else ''
            print(f"   {await c.locator('.fitnum').inner_text():>3}%  {await c.locator('.jname').inner_text():<34} {cite}")
        ev=await pg.locator('.ev-block').all_inner_texts()
        cited=[e for e in ev if 'you cite' in e.lower()]
        print('\nevidence panel:', (cited[0][:160].replace('\n',' | ') if cited else 'no cited block'))
        print('errors:', errs[:4] or 'none')
        await pg.locator('#results').scroll_into_view_if_needed(); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/tmp/s-cite.png')
        await b.close()
asyncio.run(main())
