/* Renderer-independent pacing: atmosphere never teleports or damages a player. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.HollowHorror=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const RECORDS=Object.freeze({
    infirmary:{title:'NIGHT HANDOVER / 02:14',text:'The beds were empty at headcount. We could still hear breathing behind the curtains. Do not investigate alone.'},
    archive:{title:'EVACUATION ORDER / COPY 3',text:'Three reserve fuses were moved to Records, Generator and Treatment. The east loading shutter is the only working exit. Its release motor is painfully slow.'},
    generator:{title:'MAINTENANCE / DO NOT ISOLATE',text:'Emergency lighting is on a separate circuit. Removing a fuse trips the local relay. If you hear footsteps after the click, leave the room.'},
    laboratory:{title:'OBSERVATION / FINAL ENTRY',text:'It follows the light under the door. Lock the room. Crouch. Switch the torch off. Wait until the footsteps move away.'},
    'refuge-b':{title:'PENCIL ON THE WALL',text:'I counted four sets of steps. Then five. One stopped every time I stopped. I have been here since the lights went out.'}
  });
  function randomSource(seed){
    let value=Number(seed)|0;
    return ()=>{value=(Math.imul(value,1664525)+1013904223)|0;return (value>>>0)/4294967296;};
  }
  function create(seed){
    const random=randomSource(seed);
    let age=0,cooldown=22+random()*9,dip=0,lastFuses=0,lastKind=-1,events=0;
    function update(dt,input){
      input=input||{};
      if(!input.active||!Number.isFinite(dt)||dt<=0)return [];
      dt=Math.min(dt,.25);age+=dt;cooldown-=dt;dip=Math.max(0,dip-dt);
      if(input.effects===false)dip=0;
      const fuses=Math.max(0,Math.min(3,Math.floor(Number(input.fuses)||0)));
      const output=[];
      if(fuses>lastFuses){
        lastFuses=fuses;cooldown=18+random()*10;
        if(input.effects!==false)dip=6;
        output.push({kind:'relay',caption:'[A relay snaps. The ventilation winds down.]'});
      }
      // A refuge is genuine relief. Do not bury combat cues under manufactured scares.
      if(cooldown<=0){
        if(input.threat>.45||input.sheltered||input.powered){cooldown=7;return output;}
        const choices=['steps','scrape','pipe','breath'];
        let kind=Math.floor(random()*choices.length);
        if(kind===lastKind)kind=(kind+1)%choices.length;
        lastKind=kind;events++;
        cooldown=26+random()*20-fuses*3;
        if(input.effects!==false&&kind===2)dip=6;
        const captions=['[Footsteps, somewhere beyond the corridor.]','[Metal drags across tile.]','[Three knocks inside the pipes.]','[A slow breath through the ventilation.]'];
        output.push({kind:choices[kind],caption:captions[kind],bearing:random()*Math.PI*2,distance:9+random()*8});
      }
      return output;
    }
    function snapshot(){
      // One smooth six-second dip, never a rapid strobe or a complete blackout.
      const lighting=dip>0?1-.65*Math.pow(Math.sin(Math.PI*dip/6),2):1;
      return {age,cooldown,dip,lighting,events,fuses:lastFuses};
    }
    return Object.freeze({update,snapshot});
  }
  return Object.freeze({create,RECORDS,RELEASE_SECONDS:10});
});
