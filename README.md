# The Hollow: Blackwater Ward

A self-hosted first-person survival horror game for desktop and phone browsers. Beneath the manor, an abandoned hospital treatment wing has gone dark, and it goes down three floors. Start with a sidearm, find the other guns where their owners fell, creep past the bodies that are only sleeping, and climb out through the surface floodgate at the bottom of the Hollow. The game, rendering library, co-op connection, and community scoreboard are served locally; no third-party account or asset CDN is required.

## Run locally

Use Node.js 18 or newer; Node.js 22 LTS is recommended.

```bash
npm ci
npm start
```

Open <http://127.0.0.1:3077>. To try a phone on the same Wi-Fi, run `HOST=0.0.0.0 npm start` and open `http://YOUR_COMPUTER_LAN_IP:3077` on the phone. Allow that port through your local firewall. Use HTTPS for a public deployment.

Choose **Play** to enter the ward immediately, or **Multiplay** to play with a friend. Dying on B1 offers **Re-enter the ward**, a fresh run; dying deeper offers **Retry B2 · Records & Morgue** (or B3), which restarts that floor with what you carried down. Reaching B2 saves a checkpoint on the device, and the main menu then shows **Continue**. After escaping, **Play again** starts a fresh run. Both result screens also offer **Main menu**. A modern WebGL-capable browser is required.

## Ward navigation and escape

The 35 × 35 grid (105 m × 105 m) now forms a structured hospital wing, not a winding labyrinth. A central spine, broad cross-halls, and parallel service corridors provide alternate routes around enclosed rooms. Seeds vary secondary service routes while keeping room locations and objectives stable. Circulation does not require cutting through furnished rooms or locked shelters.

B1's ten labeled rooms include the infirmary, records archive, generator, armory, treatment room, supply store, and four lockable isolation shelters. Follow room labels and exit placards; press **M** to expand the floor plan. Amber diamonds mark fuses, green squares mark shelters, and red marks the exit. The HUD identifies the current room or wing and the next objective.

1. Recover the three fuses from **Records**, **Generator**, and **Treatment**. Fuse removal makes noise that attracts existing nearby monsters; do not linger after the relay clicks.
2. Reach the **east loading shutter** and press **E** to restore power. Collecting all three fuses alone does not open it.
3. Survive the **10-second simulation-time release**. The countdown is shown on the HUD, and the repeating alarm draws existing monsters toward the exit. The shutter remains blocked until release completes; then leave through the east exit, down to B2.

Run/score time (`elapsed`) uses raw frame delta, separately from the capped simulation step (`simulationTime`, at most 0.05 seconds per frame). Movement, the director, and shutter release use simulation time, so the release can take longer than ten real seconds at low frame rates. Solo pause freezes gameplay; co-op continues while paused.

## Three floors down

| Floor | Objective | Hunting / asleep | Ammo boxes | Exit opens in | Guns lying there |
|---|---|---|---|---|---|
| B1 · Blackwater Ward (10 rooms) | 3 power fuses | 8 / up to 5 | 16 | 10 s | AR-27 carbine (Armory) |
| B2 · Records & Morgue (12 rooms) | 3 lift keycards | 6 / up to 12 | 18 | 15 s | SG-8 shotgun (Security); carbine (Intake) |
| B3 · The Hollow (13 rooms) | 3 floodgate keys | 10 / up to 9 | 20 | 25 s | carbine (Guard post); shotgun (Cell block A) |

- A run starts with the M9 sidearm alone; it has unlimited ammunition (it still needs reloading). Other guns lie on gun cases in rooms; press **E** to take one. A gun you missed turns up again on a later floor. Ammunition picked up for a gun you have not found yet is kept for it.
- Health, guns, rounds, decoys and torch charge go down with you, and points from earlier floors stay banked. Each lower floor has a new seeded layout, its own case notes and a colder (B2) or redder (B3) light.
- **Sleepers.** Bodies lying along walls and between furniture are not dead. Each of these wakes one within a second or two: a torch beam on it (up to 15 m), walking within about 4 m, sprinting within about 9.5 m, or touching it. Lingering beside one wakes it more slowly. Chattering teeth mean it is about to wake. A gunshot wakes every sleeper within 70% of the gun's noise, nearest first: about 13 m for the sidearm, 22 m for the carbine and 31 m for the shotgun. A waking body roars, gets up off the floor and rouses other sleepers within 11 m. To slip past, crouch-walk at least 2 m away with the torch off. A shot that does not kill a sleeper wakes it at once.
- Taking an objective item wakes sleepers within 5 m and decoys wake those within 6 m. A Shrieker's scream wakes sleepers within 18 m of it. Starting the B1 shutter wakes sleepers within 18 m of the exit; calling the B2 lift or opening the B3 floodgate wakes them within 45 m. While the exit opens, its alarm keeps waking sleepers within 18 m of it.
- Hunting creatures howl across the floor when they lose your trail and snarl at arm's length. As they charge, Wardens and Shriekers scream; Stalkers and Crawlers growl.

## Atmosphere and case notes

- Procedural monsters have angular, asymmetric bodies, recessed non-glowing eyes, hooked fingers, distorted jaws, and torn clinical remnants. The Warden is hunched and restrained; Stalkers have mismatched elongated limbs, Crawlers move on contorted low limbs, and Shriekers have hanging split jaws. Room detail includes stained bedding, privacy curtains, water damage, discarded records, and abandoned belongings; corridor detail adds worn surfaces, rails, overhead services, and wayfinding signs.
- Sparse working corridor lights leave stretches of darkness. Nearby practical lights share a small pool (up to three, one on low quality), alongside the player's torch.
- **Five wall-mounted case notes** are placed in the Infirmary, Records, Generator, Treatment, and Isolation B. Approach a note and press **E** (touch **USE**) to show its readable title and text; notes can be read again.
- A seeded atmospheric director schedules captioned footsteps, scrapes, pipe knocks, ventilation breaths, and smooth six-second power dips. It holds back ambient events during high threat, in shelters, and after exit power is restored. It never spawns or teleports monsters and never damages the player. Fuse noise and the exit alarm are separate gameplay alerts, not director-spawned threats.

Models, surface textures, and atmospheric audio are generated procedurally. This is a grounded visual overhaul, not photorealistic scanned assets or a photogrammetry asset pack.

## Survival systems

- Four creature types: quiet flanking Stalkers, low ambushing Crawlers, alerting Shriekers, and the slow, durable Warden. Solo floors start with eight (B1), six (B2) or ten (B3) creatures hunting, plus the sleepers; co-op rounds are played on B1 with twelve hunting. Stalkers hesitate briefly when watched, then commit to a rush; staring never freezes them indefinitely. Breaking sight and hiding still work.
- Body-size-aware navigation routes creatures around furniture and closed doors. Shriekers call nearby threats; breaking sight, crouching, and noise decoys create opportunities to escape.
- Three switchable weapons with distinct ammunition, fire rate, reload, recoil, spread, and damage: carbine, sidearm, and shotgun. Runs start with the sidearm; the others must be found (empty slots are dimmed on the HUD). Only the selected gun appears in your hands; a shoulder torch provides light without a second hand-held prop.
- Accelerated movement, sprint stamina, jumping, low-obstacle traversal, crouching, sliding, aim-down-sights, and camera/weapon motion.
- Walk over ammunition boxes and supply packs to collect them automatically. Supply packs also replenish the battery and a decoy. Pickups require ground-level contact and a clear path; they cannot be collected through closed doors. An empty equipped weapon starts reloading when ammunition arrives. Fuses and medical kits still require **E / USE**.
- Monster hits reduce health without knockback, and body contact cannot shove the player through walls. Steady red screen corners intensify as health falls and recede when a medical kit heals you; the aiming area stays clear.
- Directional creature audio uses irregular whispers, claw scrapes, guttural bursts, heavy creaks, and Shrieker wails. Quiet stalks avoid an immediate warning roar. Walls muffle the sounds, with a bounded, volume-limited mix rather than a continuous breathing loop for every monster.
- Movement, gunfire, and light affect detection; the HUD reports noise and contextual interactions.

The Warden takes 28 carbine body hits at full health. Ammunition is limited: retreat into a shelter, close and lock its door, crouch, and turn off your torch. Standing in an open doorway is not hiding. Use the bottom-of-screen prompt to see the current door or object action.

## Controls

| Action | Keyboard / mouse |
|---|---|
| Move / look | W A S D / mouse |
| Sprint | Hold Shift or Alt |
| Jump / traverse low obstacles | Space |
| Crouch / slide while running | Hold C or Ctrl |
| Fire / aim down sights | Left mouse / hold right mouse |
| Reload | R |
| Switch weapon (guns found so far) | 1, 2, 3 or Q |
| Interact, read case note, use, close, lock, unlock | E; follow the contextual prompt |
| Toggle shoulder torch | F |
| Throw a decoy | V |
| Expand map | M |
| Pause / settings | Esc |

On phones and tablets, use the left virtual stick to move and drag the right side to look. Labeled buttons provide fire, aim, jump, crouch, sprint, reload, interaction, torch, weapon switching, map, decoy, and pause. Portrait and landscape layouts are supported; landscape gives you more room to see.

Hold Fire for the automatic carbine. The sidearm and shotgun fire once per press/tap. Sprint, aim, and crouch are hold actions; release them to return to your normal stance. The torch slowly recharges while switched off.

Pause settings include adaptive/performance/balanced/high graphics, look sensitivity, master volume, camera motion, and **Disturbing effects**. Settings persist on the device. Turning off Disturbing effects disables power dips, film grain, gunfire flashes, and danger/damage flashes, and softens sudden creature cries independently of camera motion. The steady red **health** corners remain visible, including with reduced motion enabled. It does not remove monsters, prevent damage, or disable fuse/alarm attraction; atmospheric sounds and readable captions remain. Both motion and effects default to the browser's reduced-motion preference unless a saved setting overrides them.

Adaptive quality measures frame time over about two seconds of play and, below roughly 48 FPS, steps down through detail tiers and render resolution (the FPS readout shows the current tier and any reduced scale, such as `MEDIUM 85%`). It remembers where it settled on the device and starts one step above that next time. Actual FPS depends on device, browser, screen resolution, and thermal limits. Real-hardware performance is unverified; no desktop or phone frame-rate guarantee is made. Headphones make directional monster sounds easier to locate.

## Play together

Choose **Multiplay**, create a game, and share the four-character room code. Up to four players can play together: the host and up to three guests join from the same game server. The lobby lists everyone in the room, and the host starts the round once every player present is ready (at least two).

Everyone explores the same seeded ward. The ward scales with the group: twelve creatures hunt a pair, fourteen hunt three players and sixteen hunt four, and B1's sleepers fill the remaining creature slots (up to twenty in all). A co-op round is played on B1 alone, and its east exit ends the round. Every player starts with the sidearm, and each takes their own carbine from the Armory. Pickups are claimed by whoever reaches them first; ammunition belongs to the player carrying it. Fuses are shared, and the host synchronizes exit power, the release countdown, and the gate's open state. A guest can request activation but cannot independently finish the release. Friendly fire is always on: a partner's rounds hurt about as much as a creature's bite (roughly 12 per rifle round, 16 per pistol round, up to 75 for a close shotgun blast), and it can kill. Each partner is drawn as a modelled survivor carrying their equipped weapon, with walk, crouch, aim, reload and firing animation. A fallen player spectates a living partner (press Space to switch between them). The round ends for everyone once every player is out or down. Pausing does **not** pause a co-op round or its shutter countdown. Each partner's result goes on the scoreboard, marked co-op, as soon as they get out or fall.

The WebSocket endpoint is `/ws`. The protocol permits up to four connections in a room (a host and up to three guests), two room subscriptions per connection, and 1,024 active rooms. Oversized messages and invalid protocol frames are isolated to the offending connection. Idle clients are checked by a heartbeat. This is a lightweight client/host-authoritative game, not an authoritative anti-cheat server.

Opening a connection retries once, with timeouts. An interrupted live round is reported instead of silently resuming with a new host/peer identity; return to the co-op menu to create or join a fresh session. Scoreboard polling recovers automatically when the connection returns, and local results remain on the device.

## Verification

```bash
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

`npm run test:all` runs the complete check sequence once the browser is installed. On a minimal Linux machine, `npx playwright install --with-deps chromium` also installs required browser system libraries.

The existing suites include:

- **Layout and navigation:** 250 deterministic ward seeds covering stable room geometry and objective locations, long main halls, enclosed rooms, shelter isolation, and independent service loops; 1,100 furnished navigation routes using actual room colliders and all four monster sizes; movement contacts and weapon/monster rules.
- **Procedural visuals and audio:** angular asymmetric creature models and additive animation poses, non-emissive eyes, bounded/disconnected spatial audio voices with occlusion and distinct creature cues, clinical room detail and clear navigation axes, deterministic surface maps, sparse corridor fixtures, route-aware exit signs, bounded geometry/draw counts, and resource disposal. These structural checks do not establish visual realism or real-device speed.
- **Server and bridge:** local asset MIME/cache handling, path traversal, score validation and persistence, WebSocket presence/room limits, malformed clients, heartbeat cleanup, and timeout/reconnection behavior. A live-server test exchanges co-op state between two independent bridge instances.
- **Campaign:** frozen floor rules, 250 connected and sealed seeds for each lower floor, furnished routes for all four monster sizes, and the sleeper and gunfire wake rules (`tests/floors.test.js`). In the browser (`tests/campaign.spec.js`): the sidearm-only start and weapon pickups; sleepers woken by walking, sprinting, the torch and gunfire (nearest first), chain wakes, and a crouch past in the dark that leaves them asleep; the B1 descent with the kit carried; retry and Continue from the B2 checkpoint; and the B3 escape that clears the save.
- **Browser UI and gameplay:** WebGL boot, menus/settings, movement, single-equipped-weapon rendering, automatic ammo/supply pickup and two-peer claim ownership, wall/door contact without hit knockback, persistent health corners, stalk-and-rush behavior, shelter concealment, medical aid, fuse-powered escape, two-peer world/fuse/door synchronization, and touch controls/layouts, using an isolated temporary scoreboard.

This is a coverage overview, not a claim that these commands have passed on the current build. Existing escape and co-op tests do not explicitly verify every new release/alarm condition. Dedicated verification is still needed for all five note interactions, director pacing and non-damaging behavior, fuse/alarm attraction, effects persistence and independence from motion, exact simulation-time release and host/guest gate agreement, and raw-delta elapsed time under slow frames.

Loopback-only `?qa=1` hooks let browser tests position players and monsters for individual mechanics; these mutation hooks are disabled on non-loopback hostnames. Tests are not a full human playthrough or a device benchmark. Mobile browser emulation is not a substitute for checking frame rate and touch comfort on real phones.

For a controlled renderer comparison, run `node scripts/profile-renderer.js`. It profiles the same seeded scene with rendering optimizations enabled and disabled through temporary browser responses, checks image equivalence, and writes results to `artifacts/performance.json`. It does not modify the game or production scores. Run it without other browser tests competing for the GPU. This compares rendering optimizations in the current build, not the original game, and software-renderer timings are not real-phone FPS measurements.

## Deploy

For production installs without the browser-testing packages:

```bash
npm ci --omit=dev
npm install -g pm2
pm2 start server.js --name hollow
pm2 save
pm2 startup
```

Run the startup command printed by PM2. Keep `DATA_DIR` on persistent storage and back up `scores.json`. Both SIGINT and SIGTERM flush pending scores before exit.

For a dedicated domain, point DNS to the server and proxy through nginx:

```nginx
server {
    server_name hollow.example.com;

    location / {
        proxy_pass http://127.0.0.1:3077;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 3600s;
    }
}
```

For `example.com/hollow/`, use this location instead. The trailing slashes matter:

```nginx
location = /hollow { return 301 /hollow/; }
location /hollow/ {
    proxy_pass http://127.0.0.1:3077/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
}
```

Validate/reload nginx, then configure HTTPS with your normal certificate tooling. Set `TRUST_PROXY=1` only when this controlled reverse proxy is the sole way to reach Node: it allows the score cooldown to identify separate player IPs. Without it, forwarded headers are deliberately ignored.

The supplied Docker Compose file uses an existing external Docker network named `web`, intended for a reverse-proxy deployment, and a persistent `hollow_data` volume. It does not expose a host port by default. Create/use that network and route the reverse proxy to `hollow:3077`, or add an appropriate local port mapping for your own setup.

## Server settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3077` | HTTP and WebSocket listening port |
| `HOST` | `127.0.0.1` | Bind address; `0.0.0.0` allows LAN/container access |
| `DATA_DIR` | `./data` | Directory containing persistent `scores.json` |
| `TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy that overwrites `X-Forwarded-For` |

`GET /health` returns `ok`. Public application assets revalidate through ETags; the pinned local Three.js file is cached for a day. API responses are never cached. Only files inside `public/` and the explicit Three.js vendor path can be served.

## Scoreboard and trust

Every finished run is submitted: solo or co-op, escaped or fallen, with its kill-streak score, time and kills. `data/scores.json` keeps one best run per browser identity, mode (solo or co-op) and player name, so players sharing a browser and both co-op partners each keep their own entries. Escapes rank above runs that ended in the ward, then higher score, then the faster escape (or the longer survival); the public board shows the top 100, and the menu lists the top ten plus the player's own best solo and co-op runs. Names are sanitized, escapes are bounded to 15–7,200 seconds and fallen runs to 0–7,200, scores to 0–1,000,000, kills to 0–12, request bodies are limited, and submissions have a three-second per-IP cooldown (the game retries when two co-op partners share a network). Files from older versions load as solo escapes. Scores are written through serialized temporary-file renames and flushed during graceful shutdown.

These checks prevent malformed data; they do **not** prove a run was legitimate. Scores and co-op state are reported by clients, identities are not authenticated, and deliberate cheating is possible. Do not use this board for prizes or security-sensitive rankings. To remove an entry, stop the server, back up the score file, edit that record, and restart. Clearing browser storage or changing browsers creates a new local identity.
