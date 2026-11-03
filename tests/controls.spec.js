const {test,expect}=require('@playwright/test');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');

const controlsPath=resolve(__dirname,'../public/controls.js');
const stylesPath=resolve(__dirname,'../public/styles.css');
const markup=readFileSync(resolve(__dirname,'../public/index.html'),'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');

async function setup(page,{forceTouch,hybrid=false}={}){
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><canvas id="game"></canvas>');
  await page.addStyleTag({path:stylesPath});
  if(hybrid)await page.evaluate(()=>{
    Object.defineProperty(navigator,'maxTouchPoints',{value:5,configurable:true});
    const native=window.matchMedia.bind(window);
    window.matchMedia=query=>{
      const result=native(query);
      if(query==='(pointer: coarse)')Object.defineProperty(result,'matches',{value:false});
      if(query==='(any-pointer: fine)')Object.defineProperty(result,'matches',{value:true});
      return result;
    };
  });
  await page.addScriptTag({path:controlsPath});
  await page.evaluate(forceTouch=>{
    window.inputLog={actions:[],moves:[],looks:[],pointers:[]};
    window.makeControls=()=>HollowControls.create({
      canvas:document.getElementById('game'),
      onAction:(action,pressed)=>inputLog.actions.push([action,pressed]),
      onMove:(x,y)=>inputLog.moves.push([x,y]),
      onLook:(dx,dy)=>inputLog.looks.push([dx,dy])
    });
    window.testControls=makeControls();
    testControls.update({active:true,state:'play',...(typeof forceTouch==='boolean'?{touch:forceTouch}:{})});
    document.addEventListener('pointerdown',event=>{
      const control=event.target.closest('#touchMove,#touchLook,.touch-button');
      if(control)inputLog.pointers.push({id:event.pointerId,selector:control.id?'#'+control.id:'.touch-'+control.dataset.action});
    },{capture:true});
  },forceTouch);
}

async function center(page,selector){
  const r=await page.locator(selector).boundingBox();
  return {x:r.x+r.width/2,y:r.y+r.height/2};
}

async function touch(cdp,type,points=[]){
  await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(point=>({...point,radiusX:4,radiusY:4,force:1}))});
}

test('desktop and hybrid devices keep mouse input available, then detect real touch',async({page})=>{
  await setup(page,{hybrid:true});
  expect(await page.evaluate(()=>navigator.maxTouchPoints)).toBe(5);
  expect(await page.evaluate(()=>testControls.touch)).toBe(false);
  await expect(page.locator('#touchControls')).toBeHidden();
  await page.locator('#game').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:51,bubbles:true});
  expect(await page.evaluate(()=>testControls.touch)).toBe(true);
  await expect(page.locator('#touchControls')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/touch-mode/);
  await page.evaluate(()=>testControls.update({active:false}));
  await expect(page.locator('#touchControls')).toBeHidden();
  await page.evaluate(()=>testControls.destroy());
  await expect(page.locator('#touchControls')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/touch-mode/);
  await page.locator('#game').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:52,bubbles:true});
  await expect(page.locator('body')).not.toHaveClass(/touch-mode/);
  // Optional callbacks really are optional, including repeated lifecycle cleanup.
  await page.evaluate(()=>{const c=HollowControls.create({});c.update({active:true,touch:true});c.destroy();c.destroy();c.update({active:true});});
  await expect(page.locator('#touchControls')).toHaveCount(0);
});

test.describe('touch controls',()=>{
  test.use({hasTouch:true,isMobile:true,viewport:{width:844,height:390},deviceScaleFactor:1});

  test('phone detection shows every play action',async({page})=>{
    await setup(page);
    expect(await page.evaluate(()=>testControls.touch)).toBe(true);
    await expect(page.locator('.touch-button:visible')).toHaveCount(12);
    await page.evaluate(()=>testControls.update({state:'play'}));
    await expect(page.locator('.touch-button:visible')).toHaveCount(12);
    await expect(page.locator('.touch-jump')).toHaveAccessibleName('Jump');
  });

  test('real simultaneous move, look and fire capture separate pointers and clamp diagonal speed',async({page,context,browserName})=>{
    test.skip(browserName!=='chromium','Real multi-touch injection uses Chromium CDP.');
    await setup(page);
    const cdp=await context.newCDPSession(page),stick=await center(page,'#touchMove'),fire=await center(page,'.touch-fire');
    const points=[{id:1,...stick},{id:2,x:460,y:180},{id:3,...fire}];
    await touch(cdp,'touchStart',points);
    expect(await page.evaluate(()=>inputLog.pointers.every(p=>document.querySelector(p.selector).hasPointerCapture(p.id)))).toBe(true);
    points[0].y-=36;points[1].x+=29;points[1].y-=11;
    await touch(cdp,'touchMove',points);
    let log=await page.evaluate(()=>inputLog);
    expect(log.moves.at(-1)[1]).toBeGreaterThan(.5);
    expect(log.looks.at(-1)).toEqual([29,-11]);
    expect(log.actions).toEqual([['fire',true]]);
    // Both held touches leave their original hit areas. Capture must retain ownership.
    points[0].x+=210;points[0].y-=130;points[2].x-=180;points[2].y-=130;
    await touch(cdp,'touchMove',points);
    log=await page.evaluate(()=>inputLog);
    expect(Math.hypot(...log.moves.at(-1))).toBeCloseTo(1,6);
    expect(log.actions).toEqual([['fire',true]]);
    expect(log.looks).toHaveLength(1);
    await touch(cdp,'touchEnd');
    log=await page.evaluate(()=>inputLog);
    expect(log.moves.at(-1)).toEqual([0,0]);
    expect(log.actions).toEqual([['fire',true],['fire',false]]);
    await expect(page.locator('.touch-fire')).toHaveAttribute('aria-pressed','false');
  });

  test('cancel, blur, visibility, resize, state change, deactivate and destroy release every held input',async({page,context,browserName})=>{
    test.skip(browserName!=='chromium','Real multi-touch injection uses Chromium CDP.');
    await setup(page);const cdp=await context.newCDPSession(page);
    for(const cause of ['cancel','blur','pagehide','visibility','resize','state','inactive','destroy']){
      await test.step(cause,async()=>{
        await page.evaluate(()=>{
          testControls.destroy();inputLog={actions:[],moves:[],looks:[],pointers:[]};
          testControls=makeControls();testControls.update({active:true,state:'play'});
        });
        const stick=await center(page,'#touchMove'),fire=await center(page,'.touch-fire'),crouch=await center(page,'.touch-crouch');
        await touch(cdp,'touchStart',[{id:1,x:stick.x,y:stick.y-35},{id:2,...fire},{id:3,...crouch}]);
        expect((await page.evaluate(()=>inputLog.moves)).at(-1)[1]).toBeGreaterThan(.5);
        if(cause==='cancel')await touch(cdp,'touchCancel');
        else await page.evaluate(cause=>{
          if(cause==='inactive')testControls.update({active:false});
          else if(cause==='state')testControls.update({state:'pause'});
          else if(cause==='destroy')testControls.destroy();
          else if(cause==='visibility'){
            Object.defineProperty(document,'hidden',{value:true,configurable:true});
            document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;
          }else window.dispatchEvent(new Event(cause));
        },cause);
        const log=await page.evaluate(()=>inputLog);
        expect(log.moves.at(-1),cause).toEqual([0,0]);
        for(const action of ['fire','crouch'])expect(log.actions.filter(e=>e[0]===action),cause).toEqual([[action,true],[action,false]]);
        if(cause!=='cancel')await touch(cdp,'touchEnd');
      });
    }
  });

  test('two fingers sharing fire cannot release each other’s held action',async({page})=>{
    await setup(page);
    await page.locator('.touch-fire').dispatchEvent('pointerdown',{pointerId:101,pointerType:'touch',bubbles:true});
    await page.locator('.touch-fire').dispatchEvent('pointerdown',{pointerId:102,pointerType:'touch',bubbles:true});
    await page.locator('.touch-fire').dispatchEvent('pointerup',{pointerId:101,pointerType:'touch',bubbles:true});
    expect(await page.evaluate(()=>inputLog.actions)).toEqual([['fire',true]]);
    await expect(page.locator('.touch-fire')).toHaveAttribute('aria-pressed','true');
    await page.locator('.touch-fire').dispatchEvent('lostpointercapture',{pointerId:102,pointerType:'touch',bubbles:true});
    expect(await page.evaluate(()=>inputLog.actions)).toEqual([['fire',true],['fire',false]]);
  });

  test('assistive activation sustains frame-based actions and torch reports its actual toggle state',async({page})=>{
    await setup(page);
    await page.locator('.touch-fire').focus();await page.keyboard.press('Enter');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(await page.evaluate(()=>inputLog.actions)).toEqual([['fire',true]]);
    await expect(page.locator('.touch-fire')).toHaveAttribute('aria-pressed','true');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(()=>inputLog.actions)).toEqual([['fire',true],['fire',false]]);
    await page.locator('.touch-aim').focus();await page.keyboard.press('Enter');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    expect((await page.evaluate(()=>inputLog.actions)).slice(-2)).toEqual([['aim',true],['aim',false]]);
    await page.evaluate(()=>testControls.update({torchOn:true}));
    await page.locator('.touch-torch').tap();
    await expect(page.locator('.touch-torch')).toHaveAttribute('aria-pressed','true');
    await page.evaluate(()=>testControls.update({torchOn:false}));
    await expect(page.locator('.touch-torch')).toHaveAttribute('aria-pressed','false');
  });

  test('all phone and tablet control targets are on-screen, at least 44px and non-overlapping',async({page})=>{
    await setup(page);
    for(const [width,height] of [[320,568],[390,844],[568,320],[844,390],[768,1024]]){
      await page.setViewportSize({width,height});
      const bounds=await page.locator('.touch-button,#touchMove').evaluateAll(nodes=>nodes.filter(n=>!n.hidden).map(n=>({name:n.id||n.dataset.action,...n.getBoundingClientRect().toJSON()})));
      for(const r of bounds){
        const note=r.name+' at '+width+'×'+height;
        expect(r.width,note).toBeGreaterThanOrEqual(44);expect(r.height,note).toBeGreaterThanOrEqual(44);
        expect(r.x,note).toBeGreaterThanOrEqual(0);expect(r.y,note).toBeGreaterThanOrEqual(0);
        expect(r.right,note).toBeLessThanOrEqual(width);expect(r.bottom,note).toBeLessThanOrEqual(height);
      }
      for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
        const a=bounds[i],b=bounds[j],overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
        expect(overlapX>2&&overlapY>2,a.name+' overlaps '+b.name+' at '+width+'×'+height).toBe(false);
      }
    }
  });
});

test('menus retain unique required IDs, remain horizontally contained and fit compact landscape pause',async({page})=>{
  await page.setContent(markup);await page.addStyleTag({path:stylesPath});
  const ids=await page.locator('[id]').evaluateAll(nodes=>nodes.map(n=>n.id));
  expect(new Set(ids).size).toBe(ids.length);
  for(const id of ['healthBar','healthText','stanceText','noiseBar','objectiveText','interactionPrompt','controlsHint','weaponName','weaponSlots','reticleHit','fpsText','settingsQuality','settingsSensitivity','settingsVolume','settingsMotion','startDarkBtn','coopBtn','resumeBtn','pauseMenuBtn'])expect(ids).toContain(id);
  for(const [width,height] of [[320,568],[390,340],[568,320],[844,390],[1280,800]]){
    await page.setViewportSize({width,height});
    for(const id of ['name','menu','coop','coopEnd','pause','dead','win']){
      const bounds=await page.evaluate(id=>{
        for(const screen of document.querySelectorAll('.screen'))screen.hidden=screen.id!==id;
        const screen=document.getElementById(id);screen.scrollTop=0;
        return {scrollWidth:screen.scrollWidth,clientWidth:screen.clientWidth,scrollHeight:screen.scrollHeight,clientHeight:screen.clientHeight};
      },id);
      expect(bounds.scrollWidth,id+' horizontal overflow at '+width+'×'+height).toBeLessThanOrEqual(bounds.clientWidth);
      if(id==='pause'&&width>height&&height<=520)expect(bounds.scrollHeight,'compact pause at '+width+'×'+height).toBeLessThanOrEqual(bounds.clientHeight);
    }
  }
});

test('context prompts never cover phone movement or action buttons',async({page})=>{
  await page.setContent(markup);await page.addStyleTag({path:stylesPath});await page.addScriptTag({path:controlsPath});
  await page.evaluate(()=>{
    document.querySelectorAll('.screen').forEach(n=>n.hidden=true);
    document.getElementById('hud').hidden=false;
    window.promptControls=HollowControls.create({canvas:document.getElementById('game')});
    promptControls.update({active:true,state:'play',touch:true});
  });
  for(const [width,height] of [[320,568],[390,844],[568,320],[844,390],[768,1024]]){
    await page.setViewportSize({width,height});
    for(const message of ['MAP · amber diamonds = fuses · green squares = shelters · red = exit','USE Lock door · crouch + torch OFF to hide','USE Unlock & open · lock integrity 100%']){
      const geometry=await page.evaluate(message=>{
        const prompt=document.getElementById('interactionPrompt');prompt.textContent=message;
        return {prompt:prompt.getBoundingClientRect().toJSON(),buttons:[...document.querySelectorAll('.touch-button,#touchMove')].filter(n=>!n.hidden).map(n=>({name:n.id||n.dataset.action,...n.getBoundingClientRect().toJSON()}))};
      },message);
      const a=geometry.prompt;expect(a.x).toBeGreaterThanOrEqual(0);expect(a.y).toBeGreaterThanOrEqual(0);expect(a.right).toBeLessThanOrEqual(width);expect(a.bottom).toBeLessThanOrEqual(height);
      for(const b of geometry.buttons){const overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
        expect(overlapX>2&&overlapY>2,`Prompt overlaps ${b.name} at ${width}×${height}`).toBe(false);
      }
    }
  }
});
