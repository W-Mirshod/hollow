const {test,expect}=require('@playwright/test');
let diagnosticPages=[];
test.beforeEach(()=>{diagnosticPages=[];});
test.afterEach(()=>{expect(diagnosticPages.flatMap(page=>page.hollowErrors||[]),'No uncaught game or shader errors').toEqual([]);});

// Every message the page sends or is sent on its game connection is kept in window.__wire (the last 600 each way).
async function ready(page,name){
  page.hollowErrors=[];diagnosticPages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0}));
    const wire=window.__wire={sent:[],got:[]},keep=(list,text)=>{try{list.push([performance.now(),JSON.parse(text)]);if(list.length>600)list.shift();}catch(e){}};
    const Native=window.WebSocket;
    window.WebSocket=class extends Native{
      constructor(...a){super(...a);this.addEventListener('message',event=>keep(wire.got,event.data));}
      send(data){keep(wire.sent,data);return super.send(data);}
    };
  },name);
  await page.goto('/?qa=1');await page.waitForFunction(()=>!!window.HollowTest);
}
const state=page=>page.evaluate(()=>HollowGame.snapshot());
const pose=(page,position)=>page.evaluate(position=>HollowTest.pose(position),position);
const sent=(page,type)=>page.evaluate(type=>__wire.sent.filter(([,m])=>m.t===type).map(([at,m])=>({at,m})),type);
const near=(a,b,by)=>Math.hypot(a.x-b.x,a.z-b.z)<by;

test('co-op motion: pose frames beside state, partners and creatures drawn where the host has them, a guest\'s door answers at once',async({browser})=>{
  test.setTimeout(600000);
  const contexts=await Promise.all([0,1].map(()=>browser.newContext({viewport:{width:480,height:300}})));
  const [host,guest]=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await ready(host,'Host');await ready(guest,'Guest');
    await host.locator('#coopBtn').click();await host.locator('#coopCreate').click();await expect(host.locator('#coopLobby')).toBeVisible();
    const code=await host.locator('#coopCode').textContent();
    await guest.locator('#coopBtn').click();await guest.locator('#coopCodeIn').fill(code);await guest.locator('#coopJoinForm button').click();
    await expect(host.locator('#coopStart')).toBeEnabled();await host.locator('#coopStart').click();
    for(const page of [host,guest])await expect.poll(async()=>(await state(page)).state,{timeout:60000}).toBe('play');
    await host.evaluate(()=>{HollowTest.silence();HollowTest.freezeAI(true);});
    await expect.poll(async()=>(await state(guest)).network.avatars,{timeout:60000}).toBe(1);

    // The wire: pose frames as passing events, state as presence. Both are stamped with the sender's clock.
    // Headless software rendering can draw well under one frame a second, and a frame sends at most one of each.
    await expect.poll(async()=>(await sent(host,'emit')).length,{timeout:60000}).toBeGreaterThan(3);
    await expect.poll(async()=>(await sent(guest,'emit')).length,{timeout:60000}).toBeGreaterThan(3);
    const hostFrames=await sent(host,'emit'),guestFrames=await sent(guest,'emit'),last=hostFrames[hostFrames.length-1].m;
    expect(last.e).toBe('s');expect(last.d).toHaveLength(12);expect(Array.isArray(last.d[11])).toBe(true);
    expect(last.d[11]).toHaveLength((await state(host)).enemies.length);
    expect(guestFrames[guestFrames.length-1].m.d).toHaveLength(11);
    expect(hostFrames.every((f,i)=>i===0||f.m.d[0]>hostFrames[i-1].m.d[0]),'frame stamps only go forward').toBe(true);
    const hostState=await sent(host,'presence'),newest=hostState[hostState.length-1].m.pr;
    expect(newest.v).toBe(4);expect(Number.isFinite(newest.ts)).toBe(true);expect(newest.p).toHaveLength(13);expect(newest.mon.every(Array.isArray)).toBe(true);
    // Nothing is moving and nothing is changing: creatures lying still are sent as 0, and state goes at most five
    // times a second however fast the frames go.
    await expect.poll(async()=>{const frames=await sent(host,'emit');return frames[frames.length-1].m.d[11].every(v=>v===0);},{timeout:90000}).toBe(true);
    {const from=await host.evaluate(()=>performance.now());await host.waitForTimeout(5000);
      const frames=(await sent(host,'emit')).filter(f=>f.at>from),states=(await sent(host,'presence')).filter(f=>f.at>from),seconds=(await host.evaluate(()=>performance.now())-from)/1000;
      expect(frames.length).toBeGreaterThanOrEqual(states.length);
      expect(states.length).toBeLessThanOrEqual(Math.ceil(seconds*5)+2);expect(states.length).toBeGreaterThanOrEqual(1);
      expect(frames.length).toBeLessThanOrEqual(Math.ceil(seconds*34)+2);}

    // A partner is drawn where they are: after a teleport (a cut, not a slide) and after a short step. "Where they
    // are" is where the host's own game puts them (a pose against a wall is pushed out of it).
    const hostAt=async()=>{await host.waitForTimeout(600);return (await state(host)).position;};
    const drawnAt=async()=>(await state(guest)).network.partners[0];
    const start=(await state(host)).position;
    await pose(host,{x:start.x+9,z:start.z,yaw:1});
    {const at=await hostAt();await expect.poll(async()=>near(await drawnAt(),at,.05),{timeout:60000}).toBe(true);}
    {const at=await hostAt();await pose(host,{x:at.x+.6,z:at.z+.4,yaw:1});const to=await hostAt();
      expect(Math.hypot(to.x-at.x,to.z-at.z)).toBeGreaterThan(.1);
      await expect.poll(async()=>near(await drawnAt(),to,.05),{timeout:60000}).toBe(true);}
    const link=(await state(guest)).network.partners[0].link;
    expect(link.held).toBeGreaterThanOrEqual(2);expect(link.delay).toBeGreaterThanOrEqual(.04);expect(link.delay).toBeLessThanOrEqual(.3+1e-6);
    expect((await state(host)).network.partners[0].link.held,'the host draws the guest from the same frames').toBeGreaterThanOrEqual(2);

    // The host's creatures: one stood up near the guest is drawn where the host has it, follows a step, and cuts on a jump.
    const g=(await state(guest)).position;
    const creature=async()=>{await host.waitForTimeout(600);return (await state(host)).enemies[0];};
    for(const [dx,dz] of [[3,6],[3.6,6.4],[3,18]]){
      await host.evaluate(p=>HollowTest.enemy(0,p),{x:g.x+dx,z:g.z+dz,state:'wander'});
      const at=await creature();
      await expect.poll(async()=>{const e=(await state(guest)).enemies[0];return !e.dead&&near(e,at,.05);},{timeout:60000}).toBe(true);
    }
    // Moving again, it is sent in full again.
    {const frames=await sent(host,'emit');expect(frames.slice(-40).some(f=>Array.isArray(f.m.d[11][0]))).toBe(true);}

    // A guest's door answers in the same instant, before the host can have heard of it; the host then agrees, and
    // its agreement does not undo the guess on the way.
    const d=(await state(guest)).doors[0];await pose(guest,{x:d.x,z:d.z-2,yaw:Math.PI});
    await expect.poll(async()=>near((await state(host)).network.partners[0],{x:d.x,z:d.z-2},.3),{timeout:60000}).toBe(true);
    const flips=await guest.evaluate(()=>{const before=HollowGame.snapshot().doors[0].open;HollowTest.action('interact',true);return [before,HollowGame.snapshot().doors[0].open];});
    expect(flips[1]).toBe(!flips[0]);
    await expect.poll(async()=>(await state(host)).doors[0].open,{timeout:60000}).toBe(flips[1]);
    await guest.waitForTimeout(1200);
    expect((await state(guest)).doors[0].open).toBe(flips[1]);expect((await state(host)).doors[0].open).toBe(flips[1]);
    // A door the host works is still the host's to say.
    await host.evaluate(i=>{const s=HollowGame.snapshot().doors[i];HollowTest.pose({x:s.x,z:s.z-2,yaw:Math.PI});HollowTest.action('interact',true);},0);
    const after=(await state(host)).doors[0];
    await expect.poll(async()=>{const mine=(await state(guest)).doors[0];return mine.open===after.open&&mine.locked===after.locked;},{timeout:60000}).toBe(true);
  }finally{await Promise.all(contexts.map(context=>context.close()));}
});
