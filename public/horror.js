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
  // Case notes on the lower floors, by room id (systems.js FLOOR_PLANS).
  const FLOOR_RECORDS=Object.freeze({
    'm-records':{title:'LIFT ORDER / B2',text:'The freight lift keycards were split between Records, the Morgue and the Crematorium so nobody could leave alone. The lift is loud. Everything lying down here will hear it come.'},
    'm-morgue':{title:'MORTUARY LOG / 03:40',text:'The drawer count does not match the tags. Two of the bodies on the tables were facing the other way when I came back. Do not shine a light on them.'},
    'm-security':{title:'SECURITY / SIDEARM ONLY',text:'Night staff carry the M9 and nothing else. The breacher stays locked in here for a reason: one shot in these halls and every table sits up.'},
    'm-crematory':{title:'CREMATORIUM / UNFIRED',text:'The furnace never lit. They were stacked here to wait for power. They are still waiting. Crouch past them and keep the torch on the floor ahead, never on them.'},
    'm-vault-b':{title:'SCRATCHED INTO THE DOOR',text:'One woke when I ran. Then the one beside it. Then all of them. I counted to four hundred before they stopped walking.'},
    'h-guard':{title:'GUARD POST / ISSUE',text:'One carbine issued to this post. If it is not on the rack, the guard took it down with him. Look for him. Look carefully.'},
    'h-pump':{title:'PUMP ROOM / FLOOD LOG',text:'Three floodgate keys: the Pump Room, the Well and the Nest. The surface gate opens slowly, and the whole Hollow hears it grinding.'},
    'h-control':{title:'FLOODGATE CONTROL',text:'The gate motor needs twenty-five seconds. Do not stand at the gate while it opens. Find a door, hold it, and run the moment it is up.'},
    'h-well':{title:'THE WELL / DO NOT DESCEND',text:'They came up out of the water. Some are still lying around the rim as if they were sleeping. They are not sleeping.'},
    'h-nest':{title:'THE NEST',text:'Count them before you cross. If one stirs, back away slowly. If one screams, run, because the rest are getting up.'}
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
  return Object.freeze({create,RECORDS,FLOOR_RECORDS,RELEASE_SECONDS:10});
});
