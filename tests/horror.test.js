'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const horror = require('../public/horror');

const STEP = .25;
const ACTIVE = Object.freeze({ active: true, threat: 0, sheltered: false, powered: false, fuses: 0 });
const CAPTIONS = {
  relay: '[A relay snaps. The ventilation winds down.]',
  steps: '[Footsteps, somewhere beyond the corridor.]',
  scrape: '[Metal drags across tile.]',
  pipe: '[Three knocks inside the pipes.]',
  breath: '[A slow breath through the ventilation.]'
};

function nextEvent(director, input = ACTIVE) {
  for (let frame = 0; frame < 200; frame++) {
    const events = director.update(STEP, input);
    if (events.length) {
      assert.equal(events.length, 1, 'Scares must not arrive in a burst');
      return events[0];
    }
  }
  assert.fail('Expected an event within 50 seconds of active, safe play');
}

function trace(seed) {
  const director = horror.create(seed);
  const events = [];
  for (let frame = 0; frame < 3200; frame++) {
    const input = {
      ...ACTIVE,
      fuses: Math.min(3, Math.floor(frame / 800)),
      sheltered: frame >= 400 && frame < 600,
      threat: frame >= 1000 && frame < 1200 ? .8 : 0,
      effects: frame % 300 >= 40
    };
    for (const event of director.update(STEP, input)) {
      events.push({ ...event, state: director.snapshot() });
    }
  }
  return { events, state: director.snapshot() };
}

test('equal seeds reproduce complete event payloads, timing and state; different seeds vary', () => {
  for (const seed of [0, 1, -1, 0x12345678, 0x7fffffff, 0xffffffff]) {
    const first = trace(seed);
    assert.ok(first.state.events > 10, `seed ${seed}: exercise ambient events`);
    assert.equal(first.events.filter(event => event.kind === 'relay').length, 3);
    assert.deepEqual(trace(seed), first, `seed ${seed}`);
  }
  assert.notDeepEqual(trace(123).events, trace(124).events);
});

test('ambient scares have long cooldowns and never repeat consecutive event types', () => {
  for (const seed of [0, 1, 42, 77, -1, 0x12345678]) {
    for (let fuses = 0; fuses <= 3; fuses++) {
      const director = horror.create(seed);
      const input = { ...ACTIVE, fuses };
      const initial = director.snapshot();
      assert.ok(initial.cooldown >= 22 && initial.cooldown < 31);
      let previousAge = 0;
      let previousKind;
      let minimum = 22;
      let maximum = 31;
      if (fuses) {
        assert.equal(director.update(STEP, input)[0].kind, 'relay');
        previousAge = director.snapshot().age;
        minimum = 18;
        maximum = 28;
      }
      for (let index = 0; index < 20; index++) {
        const event = nextEvent(director, input);
        const state = director.snapshot();
        const elapsed = state.age - previousAge;
        const label = `seed ${seed}, fuses ${fuses}, event ${index}`;
        assert.ok(elapsed >= minimum && elapsed < maximum + STEP, `${label}: spacing ${elapsed}`);
        assert.ok(['steps', 'scrape', 'pipe', 'breath'].includes(event.kind), label);
        assert.notEqual(event.kind, previousKind, `${label}: repeated ambient type`);
        assert.equal(state.events, index + 1, 'Relay events do not count as ambient scares');
        minimum = 26 - fuses * 3;
        maximum = 46 - fuses * 3;
        assert.ok(state.cooldown >= minimum && state.cooldown < maximum, label);
        previousAge = state.age;
        previousKind = event.kind;
      }
    }
  }
});

test('inactive or missing input neither emits events nor advances scheduler state', () => {
  for (const input of [undefined, null, {}, { active: false, fuses: 3 }, { active: 0, fuses: 3 }]) {
    const director = horror.create(12);
    const control = horror.create(12);
    for (const instance of [director, control]) {
      instance.update(STEP, { ...ACTIVE, fuses: 1 });
      instance.update(STEP, { ...ACTIVE, fuses: 1 });
    }
    const before = director.snapshot();
    assert.ok(before.dip > 0);
    for (let frame = 0; frame < 200; frame++) {
      assert.deepEqual(director.update(STEP, input), []);
    }
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(nextEvent(director), nextEvent(control), 'Ignoring updates must not consume randomness');
    assert.deepEqual(director.snapshot(), control.snapshot());
  }
});

test('invalid dt cannot emit a pending fuse relay or change any state', () => {
  for (const dt of [0, -.25, -100, NaN, Infinity, -Infinity, undefined, null, '0.25', {}, []]) {
    const director = horror.create(88);
    const control = horror.create(88);
    director.update(STEP, { ...ACTIVE, fuses: 1 });
    control.update(STEP, { ...ACTIVE, fuses: 1 });
    const before = director.snapshot();
    assert.deepEqual(director.update(dt, { ...ACTIVE, fuses: 2 }), [], `dt ${String(dt)}`);
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses: 2 }), control.update(STEP, { ...ACTIVE, fuses: 2 }));
    assert.deepEqual(director.snapshot(), control.snapshot());
  }
});

test('large finite dt is capped at a quarter second rather than fast-forwarding scares', () => {
  for (const dt of [1, 60, Number.MAX_VALUE]) {
    const director = horror.create(4);
    const control = horror.create(4);
    for (let frame = 0; frame < 400; frame++) {
      assert.deepEqual(director.update(dt, ACTIVE), control.update(STEP, ACTIVE));
      assert.deepEqual(director.snapshot(), control.snapshot());
    }
    assert.equal(director.snapshot().age, 100);
    assert.ok(director.snapshot().events > 0);
  }
});

for (const [label, condition] of [
  ['shelter', { sheltered: true }],
  ['combat', { threat: .450001 }],
  ['high threat', { threat: 1 }],
  ['powered exit', { powered: true }]
]) {
  test(`${label} suppresses ambient scares across repeated cooldowns but permits fuse relays`, () => {
    const director = horror.create(123);
    for (let frame = 0; frame < 1600; frame++) {
      const fuses = Math.min(3, Math.floor(frame / 400));
      const events = director.update(STEP, { ...ACTIVE, ...condition, fuses });
      const increment = frame > 0 && frame <= 1200 && frame % 400 === 0;
      assert.deepEqual(events, increment ? [{ kind: 'relay', caption: CAPTIONS.relay }] : []);
      assert.equal(director.snapshot().events, 0);
    }
    assert.equal(director.snapshot().fuses, 3);
    assert.notEqual(nextEvent(director, { ...ACTIVE, fuses: 3 }).kind, 'relay');
    assert.equal(director.snapshot().events, 1, 'Ambient pacing resumes after suppression ends');
  });
}

test('the threat threshold itself still permits ambient events', () => {
  const director = horror.create(9);
  assert.notEqual(nextEvent(director, { ...ACTIVE, threat: .45 }).kind, 'relay');
  assert.equal(director.snapshot().events, 1);
});

test('each new fuse high-water mark emits one relay, with no repeats on stale or lower counts', () => {
  const director = horror.create(7);
  for (const fuses of [1, 2, 3]) {
    assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses }), [{ kind: 'relay', caption: CAPTIONS.relay }]);
    const state = director.snapshot();
    assert.equal(state.fuses, fuses);
    assert.equal(state.events, 0);
    assert.equal(state.dip, 6);
    assert.ok(state.cooldown >= 18 && state.cooldown < 28);
    for (const stale of [fuses, fuses, 0, fuses - 1, fuses]) {
      assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses: stale }), []);
      assert.equal(director.snapshot().fuses, fuses);
    }
  }
  assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses: 99 }), []);
  assert.equal(director.snapshot().fuses, 3);
});

test('fuse counts are normalized and a multi-fuse jump produces only one relay', () => {
  const director = horror.create(7);
  for (const fuses of [undefined, null, NaN, 'invalid', -2, .9]) {
    assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses }), []);
    assert.equal(director.snapshot().fuses, 0);
  }
  assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses: '2.9' }), [{ kind: 'relay', caption: CAPTIONS.relay }]);
  assert.equal(director.snapshot().fuses, 2);
  assert.deepEqual(director.update(STEP, { ...ACTIVE, fuses: 2.99 }), []);
  const jumped = horror.create(7);
  assert.deepEqual(jumped.update(STEP, { ...ACTIVE, fuses: 100 }), [{ kind: 'relay', caption: CAPTIONS.relay }]);
  assert.equal(jumped.snapshot().fuses, 3);
  assert.deepEqual(jumped.update(STEP, { ...ACTIVE, fuses: 3 }), []);
});

function assertSmoothDip(director, input) {
  assert.equal(director.snapshot().dip, 6);
  assert.equal(director.snapshot().lighting, 1);
  let previous = 1;
  for (let frame = 1; frame <= 24; frame++) {
    assert.deepEqual(director.update(STEP, input), []);
    const { dip, lighting } = director.snapshot();
    assert.equal(dip, 6 - frame * STEP);
    assert.ok(Number.isFinite(lighting) && lighting >= .35 - 1e-12 && lighting <= 1);
    assert.ok(lighting > 0, 'Emergency lighting never goes fully black');
    assert.ok(Math.abs(lighting - previous) <= .086, 'No abrupt flashes between quarter-second frames');
    if (frame <= 12) assert.ok(lighting <= previous, 'The first half dims gradually');
    else assert.ok(lighting >= previous, 'The second half recovers gradually');
    if (frame === 12) assert.ok(Math.abs(lighting - .35) < 1e-12, 'Dip reaches its bounded midpoint');
    previous = lighting;
  }
  assert.equal(previous, 1);
  assert.deepEqual(director.update(STEP, input), []);
  assert.equal(director.snapshot().lighting, 1);
}

test('relay and pipe dips are smooth six-second envelopes, bounded above blackout', () => {
  const relay = horror.create(17);
  const input = { ...ACTIVE, fuses: 1 };
  assert.equal(relay.update(STEP, input)[0].kind, 'relay');
  assertSmoothDip(relay, input);

  const pipe = horror.create(17);
  let found = false;
  for (let index = 0; index < 30; index++) {
    if (nextEvent(pipe).kind === 'pipe') {
      found = true;
      assertSmoothDip(pipe, ACTIVE);
      break;
    }
    assert.equal(pipe.snapshot().dip, 0, 'Other ambient kinds do not start a dip');
  }
  assert.ok(found, 'Exercise an actual pipe event');
});

test('effects:false immediately clears an in-progress dip and prevents relay and pipe dips', () => {
  const director = horror.create(17);
  const input = { ...ACTIVE, fuses: 1 };
  director.update(STEP, input);
  for (let frame = 0; frame < 12; frame++) director.update(STEP, input);
  assert.ok(director.snapshot().lighting < .36);
  assert.deepEqual(director.update(.001, { ...input, effects: false }), []);
  assert.equal(director.snapshot().dip, 0);
  assert.equal(director.snapshot().lighting, 1);
  director.update(.001, input);
  assert.equal(director.snapshot().dip, 0, 'Re-enabling effects must not resurrect a cancelled dip');

  const disabled = horror.create(42);
  const enabled = horror.create(42);
  const seen = new Set();
  for (let frame = 0; frame < 3200; frame++) {
    const current = { ...ACTIVE, fuses: Math.min(3, Math.floor(frame / 800)) };
    const events = disabled.update(STEP, { ...current, effects: false });
    assert.deepEqual(events, enabled.update(STEP, current), 'Disabling lighting effects preserves captions and event pacing');
    events.forEach(event => seen.add(event.kind));
    assert.equal(disabled.snapshot().dip, 0);
    assert.equal(disabled.snapshot().lighting, 1);
  }
  assert.ok(seen.has('relay') && seen.has('pipe'), 'Both dip triggers must be exercised while disabled');
});

test('every event has its matching accessible caption and ambient cues have bounded positions', () => {
  const director = horror.create(42);
  const input = { ...ACTIVE, fuses: 1 };
  assert.deepEqual(director.update(STEP, input), [{ kind: 'relay', caption: CAPTIONS.relay }]);
  const seen = new Set(['relay']);
  for (let index = 0; index < 40; index++) {
    const event = nextEvent(director, input);
    assert.equal(event.caption, CAPTIONS[event.kind]);
    assert.match(event.caption, /^\[.+\]$/);
    assert.ok(Number.isFinite(event.bearing) && event.bearing >= 0 && event.bearing < Math.PI * 2);
    assert.ok(Number.isFinite(event.distance) && event.distance >= 9 && event.distance < 17);
    seen.add(event.kind);
  }
  assert.deepEqual([...seen].sort(), Object.keys(CAPTIONS).sort());
});

test('case notes retain their room IDs, titles, survival clues and ten-second release contract', () => {
  assert.equal(horror.RELEASE_SECONDS, 10);
  assert.equal(Object.isFrozen(horror), true);
  assert.equal(Object.isFrozen(horror.RECORDS), true);
  const expected = {
    infirmary: ['NIGHT HANDOVER / 02:14', /breathing behind the curtains/i, /do not investigate alone/i],
    archive: ['EVACUATION ORDER / COPY 3', /three reserve fuses.*Records, Generator and Treatment/i, /east loading shutter.*only working exit/i, /release motor.*slow/i],
    generator: ['MAINTENANCE / DO NOT ISOLATE', /emergency lighting.*separate circuit/i, /removing a fuse.*local relay/i, /footsteps.*leave the room/i],
    laboratory: ['OBSERVATION / FINAL ENTRY', /follows the light/i, /lock the room.*crouch.*switch the torch off.*wait until the footsteps move away/i],
    'refuge-b': ['PENCIL ON THE WALL', /four sets of steps.*five/i, /one stopped every time I stopped/i]
  };
  assert.deepEqual(Object.keys(horror.RECORDS).sort(), Object.keys(expected).sort());
  for (const [id, [title, ...clues]] of Object.entries(expected)) {
    const record = horror.RECORDS[id];
    assert.deepEqual(Object.keys(record).sort(), ['text', 'title']);
    assert.equal(record.title, title);
    assert.equal(typeof record.text, 'string');
    for (const clue of clues) assert.match(record.text, clue, `${id}: missing case-note clue`);
  }
});
