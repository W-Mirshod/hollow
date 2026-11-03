const {test,expect}=require('@playwright/test');

// Graphics contract on both backends and at both ends of the quality range: the ward's PBR surfaces, the viewmodels
// and the creatures render real frames with real normal/roughness maps, keep the game-facing userData contracts and
// stay within a sane draw budget, without console errors or GPU validation messages.
test.setTimeout(240000);
const GPU_VALIDATION=/GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)| - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]|WGSL|Tint|shader compilation/i;
const SEED=4242;

function watch(page){
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{const text=message.text();if(message.type()==='error'||GPU_VALIDATION.test(text))errors.push(text);});
  return errors;
}
async function boot(page,url,quality){
  await page.addInitScript(q=>{
    localStorage.setItem('hollow.playerName','Graphics QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:q,motion:false,sensitivity:1,volume:0,effects:true}));
  },quality);
  await page.goto(url);
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await expect(page.locator('#menu')).toBeVisible();
  // Test-only probe: remember every scene the game renders (world and viewmodel) so materials can be inspected.
  await page.evaluate(()=>{
    const r=window.HollowRenderer,render=r.render.bind(r);window.__scenes=new Set();
    r.render=(scene,camera)=>{window.__scenes.add(scene);return render(scene,camera);};
  });
}
async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function renderedFrames(page,count=3){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250]}).toBeGreaterThanOrEqual(count);
}
async function canvasDetail(page){
  const hide=await page.addStyleTag({content:'body > :not(#game){visibility:hidden !important}'});
  const png=await page.locator('#game').screenshot();
  await hide.evaluate(tag=>tag.remove());
  return page.evaluate(async source=>{
    const image=new Image();image.src=source;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const data=context.getImageData(0,0,canvas.width,canvas.height).data;let sum=0,squares=0,count=0,clipped=0;
    for(let i=0;i<data.length;i+=16){const luma=data[i]*.2126+data[i+1]*.7152+data[i+2]*.0722;sum+=luma;squares+=luma*luma;count++;if(luma>250)clipped++;}
    const mean=sum/count;
    return {mean:Math.round(mean*10)/10,deviation:Math.round(Math.sqrt(Math.max(0,squares/count-mean*mean))*10)/10,clipped:Math.round(clipped/count*1000)/10};
  },'data:image/png;base64,'+png.toString('base64'));
}
// A long straight corridor of the seeded maze, looking down it with the torch on.
async function corridor(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  return page.evaluate(seed=>{
    HollowTest.build(seed);HollowTest.silence();HollowTest.torch(true);
    const g=HollowTest.maze(),S=3,n=g.length,open=(x,z)=>g[z]&&g[z][x]===0;let best=null;
    for(let z=1;z<n-1;z++)for(let x=7;x<n-1;x++)for(const [dx,dz,yaw] of [[1,0,-Math.PI/2],[0,1,Math.PI],[-1,0,Math.PI/2],[0,-1,0]]){
      let len=0;while(open(x+dx*len,z+dz*len))len++;
      if(len>=4&&(!best||len>best.len))best={x,z,dx,dz,yaw,len};
    }
    const p={x:(best.x+.5)*S-best.dx*.6,z:(best.z+.5)*S-best.dz*.6,yaw:best.yaw,dx:best.dx,dz:best.dz};
    HollowTest.pose({x:p.x,z:p.z,yaw:p.yaw,pitch:-.05});return p;
  },SEED);
}
// Inspects the rendered scenes: ward surface materials, the visible viewmodel and every creature rig.
function inspect(page){
  return page.evaluate(()=>{
    const out={surfaces:[],weapons:[],monsters:[],decals:[]};
    for(const scene of window.__scenes)scene.traverse(o=>{
      const u=o.userData||{};
      if(o.isMesh&&o.material&&o.material.userData&&o.material.userData.hollowSurface==='decals'){
        const m=o.material,g=o.geometry;out.decals.push({triangles:(g.index?g.index.count:g.attributes.position.count)/3,alphaTest:m.alphaTest,map:!!(m.map&&m.map.image),normal:!!(m.normalMap&&m.normalMap.image),roughness:!!(m.roughnessMap&&m.roughnessMap.image),transparent:m.transparent});
      }
      if(o.isMesh&&!Array.isArray(o.material)&&o.material.userData&&o.material.userData.transitionMap){
        const m=o.material;
        out.surfaces.push({name:o.name||o.geometry.type,normal:!!(m.normalMap&&m.normalMap.image),roughness:!!(m.roughnessMap&&m.roughnessMap.image),
          normalNode:!!m.normalNode,roughnessNode:!!m.roughnessNode,colorNode:!!m.colorNode,emissiveNode:!!m.emissiveNode,lux:!!(m.userData.luxMaps&&m.userData.luxMaps.normal&&m.userData.luxMaps.roughness)});
      }
      if(['rifle','pistol','shotgun'].includes(u.kind)&&u.bolt){
        const meshes=[];o.traverse(c=>{if(c.isMesh&&c!==u.muzzleFlash)meshes.push(c);});
        const lit=meshes.filter(c=>c.material.isMeshStandardMaterial);
        out.weapons.push({kind:u.kind,magazine:!!(u.magazine&&u.magazine.isObject3D),flash:!!(u.muzzleFlash&&u.muzzleFlash.isMesh),
          muzzle:!!(u.muzzlePosition&&u.muzzlePosition.isVector3),bolt:!!(u.bolt&&u.bolt.isObject3D),restZ:typeof u.bolt.userData.restZ,
          run:typeof u.run,meshes:meshes.length,lit:lit.length,mapped:lit.filter(c=>c.material.normalMap&&c.material.roughnessMap).length});
      }
      if(u.restPose&&u.eyeMat){
        const parts=['legL','legR','armL','armR','neck','head'].filter(k=>u[k]&&u[k].isObject3D).length;let meshes=0,lights=0;
        o.traverse(c=>{if(c.isMesh)meshes++;if(c.isLight)lights++;});
        out.monsters.push({kind:u.kind,parts,meshes,lights,eye:!!(u.eyeMat&&u.eyeMat.color),eyeColor:typeof u.eyeColor,
          headHeight:u.headHeight,height:u.height,glow:typeof u.glow?.intensity,phase:typeof u.phase,speed:typeof u.speed,chasing:typeof u.chasing});
      }
    });
    return out;
  });
}

for(const backend of ['webgpu','webgl'])for(const quality of ['high','low']){
  test(`${backend} / ${quality}: PBR ward, viewmodels and creatures render cleanly`,async({page})=>{
    const errors=watch(page);
    await boot(page,'/?qa=1'+(backend==='webgl'?'&renderer=webgl':''),quality);
    expect(await page.evaluate(()=>window.HollowBackend)).toBe(backend==='webgl'?'webgl2':'webgpu');
    const spot=await corridor(page);
    await renderedFrames(page,4);
    let s=await snapshot(page);
    expect(s.performance.quality).toBe(quality);
    const ward=await canvasDetail(page);
    expect(ward.deviation).toBeGreaterThan(6);
    expect(ward.clipped).toBeLessThan(2);
    expect(s.performance.drawCalls).toBeGreaterThan(10);
    expect(s.performance.drawCalls).toBeLessThan(quality==='low'?240:280);

    // A creature in the torch beam: the rig must render with the viewmodel in front of it.
    await page.evaluate(p=>{HollowTest.enemy(1,{x:p.x+p.dx*3.2,z:p.z+p.dz*3.2,state:'wander',yaw:p.yaw+Math.PI});HollowTest.pose({x:p.x,z:p.z,yaw:p.yaw,pitch:-.04});},spot);
    await renderedFrames(page,4);
    const creature=await canvasDetail(page);
    expect(creature.deviation).toBeGreaterThan(6);
    expect(creature.clipped).toBeLessThan(2);
    s=await snapshot(page);
    expect(s.performance.drawCalls).toBeLessThan(quality==='low'?260:300);

    const info=await inspect(page);
    // floor, ceiling, wall instances, runner, both door leaves and the pedestal
    expect(info.surfaces.length).toBeGreaterThanOrEqual(6);
    // Low keeps the roughness maps but drops the relief, so the test tier costs about what flat albedo did.
    for(const surface of info.surfaces)expect(surface).toEqual(expect.objectContaining({normal:quality!=='low',roughness:true,normalNode:quality!=='low',roughnessNode:true,colorNode:true,emissiveNode:true,lux:true}));
    // Corridor blood, claw marks, footprints and hazard paint: one alpha-tested (unsorted) PBR decal batch.
    expect(info.decals.length).toBe(1);
    expect(info.decals[0]).toEqual(expect.objectContaining({map:true,normal:true,roughness:true,transparent:false}));
    expect(info.decals[0].alphaTest).toBeGreaterThan(0);
    expect(info.decals[0].triangles).toBeGreaterThan(40);
    expect(info.weapons.map(w=>w.kind).sort()).toEqual(['pistol','rifle','shotgun']);
    for(const weapon of info.weapons){
      expect(weapon).toEqual(expect.objectContaining({magazine:true,flash:true,muzzle:true,bolt:true,restZ:'number',run:'number'}));
      expect(weapon.lit).toBeGreaterThan(2);
      expect(weapon.mapped).toBe(weapon.lit);
    }
    expect(info.monsters.length).toBeGreaterThanOrEqual(4);
    for(const monster of info.monsters){
      expect(monster).toEqual(expect.objectContaining({parts:6,lights:0,eye:true,eyeColor:'number',glow:'number',phase:'number',speed:'number',chasing:'boolean'}));
      expect(monster.headHeight).toBeGreaterThan(.3);expect(monster.headHeight).toBeLessThan(monster.height);
    }
    expect(errors).toEqual([]);
    console.log(`${backend}/${quality}: ward`,ward,'creature',creature,'draw calls',s.performance.drawCalls,'triangles',s.performance.triangles);
  });
}
