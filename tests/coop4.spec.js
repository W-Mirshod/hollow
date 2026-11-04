const {test,expect}=require('@playwright/test');
let diagnosticPages=[];
test.beforeEach(()=>{diagnosticPages=[];});
test.afterEach(()=>{expect(diagnosticPages.flatMap(page=>page.hollowErrors||[]),'No uncaught game or shader errors').toEqual([]);});

async function ready(page,name){
  page.hollowErrors=[];diagnosticPages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0}));
  },name);
  await page.goto('/?qa=1');await page.waitForFunction(()=>!!window.HollowTest);
}
async function state(page){return page.evaluate(()=>HollowGame.snapshot());}
async function pose(page,position){await page.evaluate(position=>HollowTest.pose(position),position);}

test('three real browser peers share one co-op round: seed, fourteen creatures, avatars, doors and the map',async({browser})=>{
  test.setTimeout(600000);
  const contexts=await Promise.all([0,1,2].map(()=>browser.newContext({viewport:{width:800,height:520}})));
  const [host,guest1,guest2]=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await ready(host,'Host');await ready(guest1,'Guest One');await ready(guest2,'Guest Two');
    await host.locator('#coopBtn').click();await host.locator('#coopCreate').click();await expect(host.locator('#coopLobby')).toBeVisible();
    const code=await host.locator('#coopCode').textContent();
    for(const guest of [guest1,guest2]){await guest.locator('#coopBtn').click();await guest.locator('#coopCodeIn').fill(code);await guest.locator('#coopJoinForm button').click();}
    // The lobby lists all three players, each ready.
    await expect(host.locator('#coopPlayers li')).toHaveCount(4);
    await expect(host.locator('#coopPlayers')).toContainText('Guest One');await expect(host.locator('#coopPlayers')).toContainText('Guest Two');
    await expect(guest2.locator('#coopPlayers')).toContainText('Guest One');
    await expect(host.locator('#coopStart')).toBeEnabled();await host.locator('#coopStart').click();
    for(const page of [host,guest1,guest2])await expect.poll(async()=>(await state(page)).state,{timeout:60000}).toBe('play');
    const seed=(await state(host)).seed;
    for(const page of [guest1,guest2])expect((await state(page)).seed).toBe(seed);
    // Three survivors: fourteen creatures hunt, and the guests mirror every slot.
    const hostEnemies=(await state(host)).enemies;expect(hostEnemies.filter(x=>!x.dormant)).toHaveLength(14);expect(hostEnemies.length).toBeLessThanOrEqual(20);
    for(const page of [guest1,guest2])await expect.poll(async()=>(await state(page)).enemies.length).toBe(hostEnemies.length);
    await host.evaluate(()=>HollowTest.silence());
    // Everyone sees the two other survivors.
    for(const page of [host,guest1,guest2])await expect.poll(async()=>(await state(page)).network.avatars,{timeout:30000}).toBe(2);
    const net=(await state(host)).network;
    expect(net.partner).toBe(true);
    expect(net.partners.map(p=>p.name).sort()).toEqual(['Guest One','Guest Two']);
    expect(net.partners.every(p=>p.present&&p.alive&&p.inRound)).toBe(true);
    expect((await state(guest1)).network.partners.map(p=>p.name).sort()).toEqual(['Guest Two','Host']);
    // A door the second guest works is seen by the host and the first guest.
    const d=(await state(guest2)).doors[0],was=(await state(host)).doors[0].open;
    await pose(guest2,{x:d.x,z:d.z-2,yaw:Math.PI});await guest2.evaluate(()=>HollowTest.action('interact',true));
    await expect.poll(async()=>(await state(host)).doors[0].open).toBe(!was);
    await expect.poll(async()=>(await state(guest1)).doors[0].open).toBe(!was);
  }finally{await Promise.all(contexts.map(context=>context.close()));}
});
