const {test,expect}=require('@playwright/test');

let errors=[];
test.beforeEach(({page})=>{
  errors=[];page.on('pageerror',error=>errors.push(error.message));
});
test.afterEach(()=>expect(errors,'No opening-screen runtime errors').toEqual([]));

async function ready(page,name){
  await page.addInitScript(name=>{
    if(name)localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:false,volume:0,sensitivity:1}));
  },name);
  await page.goto('/');await page.waitForFunction(()=>!!window.HollowGame);
}

test('minimal menu keeps actions visible and optional content collapsed across viewports',async({page})=>{
  await ready(page,'Menu QA');
  const help=page.locator('#menu .controls-details'),scores=page.locator('#menu .scores-detail');
  await expect(help).not.toHaveAttribute('open');await expect(scores).not.toHaveAttribute('open');
  await expect(page.locator('#menu .keys')).toBeHidden();await expect(page.locator('#menu .board')).toBeHidden();
  for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
    await page.setViewportSize(viewport);
    await page.locator('#menu').evaluate(node=>node.scrollTop=0);
    for(const id of ['startDarkBtn','startBtn','coopBtn'])await expect(page.locator('#'+id)).toBeInViewport();
    const overflow=await page.locator('#menu').evaluate(node=>node.scrollWidth>node.clientWidth+1);
    expect(overflow,'No horizontal menu overflow at '+viewport.width+'x'+viewport.height).toBe(false);
    const words=(await page.locator('#menu').innerText()).trim().split(/\s+/);
    expect(words.length).toBeLessThan(35);
    if(viewport.width===1280)await page.screenshot({path:'artifacts/minimal-menu-desktop.png'});
    if(viewport.width===390)await page.screenshot({path:'artifacts/minimal-menu-phone.png'});
  }
  await help.locator('summary').focus();await page.keyboard.press('Enter');
  await expect(page.locator('#menu .keys')).toBeVisible();await expect(help.locator('.rules')).toContainText('three fuses');
  await page.keyboard.press('Enter');await expect(page.locator('#menu .keys')).toBeHidden();
  await scores.locator('summary').click();await expect(page.locator('#menu .board')).toBeVisible();
  await scores.locator('summary').click();await expect(page.locator('#menu .board')).toBeHidden();
});

test('short name entry, name changes, co-op and immediate entry preserve navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await ready(page,null);
  await expect(page.locator('#name')).toBeVisible();await expect(page.locator('#name .board')).toBeHidden();
  await expect(page.locator('#nameSave')).toBeInViewport();
  await page.locator('#nameSave').click();await expect(page.locator('#nameErr')).toContainText('at least 2');
  await page.getByLabel('Your name',{exact:true}).fill('New guest');await page.locator('#nameSave').click();
  await expect(page.locator('#menu')).toBeVisible();await expect(page.locator('#whoName')).toHaveText('New guest');
  await page.getByRole('button',{name:'Change player name'}).click();await expect(page.locator('#playerName')).toHaveValue('New guest');
  await page.locator('#nameSave').click();await page.locator('#coopBtn').click();await expect(page.locator('#coop')).toBeVisible();
  await page.locator('#coopBack').click();await expect(page.locator('#menu')).toBeVisible();
  await page.getByRole('button',{name:'Enter',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');await expect(page.locator('#hud')).toBeVisible();
});
