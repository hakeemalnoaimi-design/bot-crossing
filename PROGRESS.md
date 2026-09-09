# BotsBay World — progress and handover

Written for a session picking this up cold. It says what the project is, what has been done
and why, what is known to be wrong, and what is left. Where a decision was made against an
obvious alternative, the reason is here rather than in a commit nobody will read.

Companion documents, all still current and worth reading before changing anything:

- `BOTSBAY-WORLD-TASKS.md` — the original brief, Tasks 1 to 5.
- `DECISIONS.md` — settled rules inherited from upstream. **Read this first.** A change that
  argues with one of them needs to argue with the reason, not route around it.
- `server/harnesses/README.md` — the adapter contract and the thread shape.
- `.claude/skills/agent-session-world/references/rendering-traps.md` — the graphics problems
  this project has already hit, with the reasoning. Read before touching the renderer.
- `.claude/skills/agent-session-world/references/making-it-feel-alive.md` — the ambience
  catalogue Part B was built from.

---

## What this is

**BotsBay World** is a live 3D island showing every AI agent working for BotsBay. One thread
is one builder; one project is one hex zone; what a thread is genuinely doing decides what its
builder does. It reads each harness's own files and API **on this machine** and never writes to
any of them. `data/colony.json` is the only file it writes, anywhere.

It is a fork of **[Bot Crossing](https://github.com/jarrenrocks/bot-crossing)** by Jarren Rocks
(MIT), which drew the same idea as a moon colony. The upstream structure — the layout rule, the
instanced crew, the buildings, the camera — is his. This fork adds the Windows port, the Bahrain
island and its light, the ambient life, the n8n adapter, the per-thread dormancy rule and the
profiling tools.

**Repository root is `bot-crossing/`** (the folder keeps its upstream name; only the product was
renamed). The parent folder `Botsbay-world/` is not a git repository.

---

## How to run it

```bash
npm install
npm run dev          # the whole thing: the API runs inside the Vite dev server, port 5274
npm test             # 63 tests, all passing
npm run smoke        # draws every preset/world/time/distance and reads the pixels back
npm run profile      # GPU timer-query profile of a frame, feature by feature
npm run shot -- --out=shots --preset=high --time=0.42,0.94 --views=overview,wide,pad
npm start            # build + serve the built app instead
```

Node 22.13+. `npm run dev` binds to `127.0.0.1` and answers only its own page.

`npm run smoke`, `npm run profile` and `npm run shot` all drive a headless browser against a
**synthetic 40–65 thread roster** (`tools/profile-server.mjs`). They never touch a real harness,
the real colony file, or `.env`. Screenshots land as PNGs you can open with the Read tool, which
is the only way to actually judge a visual change.

### Rules that are not negotiable

- The server stays bound to `127.0.0.1`, and the Host and Origin checks in
  `isLocalRequest` (`server/api.mjs`) stay intact.
- Secrets live in `.env` only. **Never print `N8N_API_KEY`**, and never let it reach anything
  the browser downloads. It is read by the Node server and nowhere else.
- New data sources go in `server/harnesses/` only. Do not edit `src/` to support a source.
- Nothing is ever written to a harness. See `DECISIONS.md`.

---

## Commits

Each part is a separate commit so any one of them can be reverted on its own.

| Hash | What |
| --- | --- |
| `a497242` | Upstream baseline (Bot Crossing, Codex/Cursor support) |
| `2f53ae4` | Tasks 1–4 as found: Windows port, Bahrain world, Bahrain clock, n8n adapter, per-thread dormancy |
| `a939df8` | **Part A** — profile the frame and fix what it actually costs |
| `14ba8e8` | **Part B** — ambient life |
| `6289f01` | **Part C** — lighting |
| `b6dc3fa` | **Part D** — identity rename |
| `f87aa3f` | Fix a black canvas on the High and Ultra presets |

---

## Task status

### Task 1 — Run on Windows — **done** (`2f53ae4`)

`server/lib/opener.mjs` is the one place a URL, folder or deep link is opened.

Windows goes through **`rundll32 url.dll,FileProtocolHandler`** first, not `cmd /c start`. This
looks like the wrong way round and is not: `cmd` performs percent expansion and caret removal on
the argument line *before* `start` sees it, so a folder legitimately named `%USERPROFILE% backup`
opens the wrong directory and one named `report^v2` opens `reportv2`. No escaping recovers them.
A wrong folder opening silently is worse than none opening, so `cmd /c start ""` is kept only as
the fallback for a machine whose policy blocks `rundll32`. `explorer.exe` was rejected outright:
it silently drops any URL with a query string, which is every `code/new?folder=…` deep link.

macOS `open`, Linux `xdg-open`. Claude Code paths use `path.join` and `os.homedir()`.

### Task 2 — Bahrain world preset — **done** (`2f53ae4`, retuned in `6289f01`)

`bahrain` in `src/world/planet.js`, first in `PLANETS` so `Tab` starts there. Pale sand,
turquoise shallows, deep Gulf blue at night, indigo night sky, warm haze, sparse palms from
Terra's tree models tinted olive, pearl-white zone palette.

The palette is spread across **value as well as hue** — pearl through champagne, greige, oyster
— because pearl is a narrow band and twelve tints of one lightness are twelve zones nobody can
tell apart. Measured, the closest pair is ΔE 9.0 against ΔE 1.0 for the default palette; there is
a test asserting it stays more separable than the palette it replaces.

`deckColor` gained a lightness cap: the deck is derived by desaturating the zone accent, which
quietly assumed a mid-lightness accent. Pearl produced a near-white slab that buildings
disappeared into.

The sea level is **below every dune** (-3.6), not at zero. The hollows between dunes reach about
-3, so a waterline at zero puts the sea *above* them — sand sitting in a basin with water
standing over it, which reads as a hole in the world. Part B moved the shore in from 100 to 74
because from the resting camera the sea was out of frame entirely and the island read as a
desert with palms in it. The colony stops at 46, so nothing built is ever near the water.

### Task 3 — Automatic day and night — **done** (`2f53ae4`)

Setting **Follow local clock**, default on, in `src/world/sky.js`. Time comes from the wall clock
in `Asia/Bahrain` via `Intl.DateTimeFormat`, read once a minute.

The mapping is **piecewise-linear through four anchors** (05:30 dawn, 12:00 noon, 17:45 dusk,
19:30 night), not `seconds / 86400`. A straight fraction of the day is defensible on an invented
planet and wrong on a real one: it puts the sun down at 22:30, so the evening stays bright and
the lights come on around bedtime. Both the table and the lookup work in **whole minutes** rather
than fractions of a day, because through a fraction `1065 / 1440 * 1440` is `1064.9999999999998`
and 17:45 misses dusk by 4e-16 — the same answer to fifteen places, and a boundary that reads as
broken to anyone testing the spec it was written from.

`L` or the scrubber turns it off; Settings turns it back on. Tests pin the four anchors exactly,
assert the sun is up between dawn and dusk, that noon is the day's highest, that no minute moves
the sky by more than a slider notch (including across midnight), and that the answer does not
move when the machine is in New York or Tokyo.

### Task 4 — n8n adapter — **done** (`2f53ae4`)

`server/harnesses/n8n.mjs`, registered in `server/harnesses/index.mjs`. `.env` keys:
`N8N_BASE_URL`, `N8N_API_KEY`, `N8N_POLL_SECONDS`, `N8N_WORKFLOW_PAGES`, `N8N_EXECUTION_PAGES`.
One thread per workflow, `id` = `n8n:<workflowId>`, `zone` = first tag or `Internal`. Deep-links
to `<base>/workflow/<id>/executions/<execId>`, or to the workflow when there is no run left on
record. 14 tests.

Two findings from the live instance changed the mapping, and both matter:

- **Switched off is dormant however recently it ran.** `lastActivityAt` is pushed to the far
  side of the three-day line. A switched-off workflow pottering about its plot looks exactly
  like a working one, which is the single most misleading thing this map could do.
- **Switched on with no execution on record is idle, not asleep.** 40 of 58 active workflows had
  no execution left to read — n8n prunes history, and a webhook that fires when somebody uses it
  can be perfectly healthy with nothing in the window. Falling back to `updatedAt` dated those
  from when the workflow was last *edited* and put most of a working instance to sleep. They are
  floated to just inside the line instead: awake, sorted below anything with a real run.

`sizeBytes` stands in for how built-up a structure looks. A workflow has no transcript, so
`triggerCount` scales into the same range, on the principle that a two-node webhook should not
look like a fifty-node pipeline.

**Retry widened the adapter seam, deliberately.** Nothing in the project could change anything in
a harness before this; `DECISIONS.md` says opening a thread is the only place a subprocess is
allowed. Retry is a genuine exception, so it was made a *narrow, named* one rather than folded
into `openThread`:

- Optional `retry(ref)` on an adapter. An adapter without it answers honestly that it cannot.
- Per-thread opt-in via `canRetry`, which n8n sets only where the last run actually failed and
  the execution id is real.
- One greppable path: `/api/retry` → `retryThread(harness, ref)` → `harness.retry(ref)`. The
  browser never learns what a retryable thing is; the HUD draws the button from `canRetry` alone.
- Archive still never touches n8n. Hiding is `data/colony.json` bookkeeping as for every harness.

### Task 5 — Hosted mode — **NOT STARTED**

Nothing exists for this. See below.

---

## Parts A to D

### Part A — Performance (`a939df8`)

Measured with GPU timer queries against a synthetic 65-thread roster (`tools/profile.mjs`, new).

**The first finding is not in the code.** The browser draws on the **Intel UHD 630**, not the
GeForce GTX 1050 Ti beside it. Windows hands a browser the power-saving GPU unless a per-app
preference says otherwise, and a page cannot choose. On that chip the balanced chain cost 35 ms a
frame at full scale and 16 ms at 55%, so the governor was reporting honestly — the render scale
settling in the fifties was the wrong GPU, not the island. The HUD now names the chip once when
the governor has had to back off on an integrated part, and the README says which Windows setting
fixes it (Settings → System → Display → Graphics).

Inside the frame the largest cost was the **crew, not the buildings**: 65 mannequins of 5,950
triangles each, drawn twice with the shadow pass, at twenty pixels tall — fifteen micro-triangles
per pixel, each shaded as a whole 2×2 quad. Buildings were worth 2.5 ms.

- Crew LOD: a clustered far body at a fifth of the triangles plus coarse helmet/visor/face,
  chosen per builder by distance with hysteresis (`LOD_NEAR` 26, `LOD_FAR` 30). The gap stops a
  builder on the line flickering. Clustering happens **at load** (`clusterDecimate` in
  `crew.js`) rather than offline because the raw asset packs are not checked in.
- Sky drawn **last and depth-tested** at the far plane, instead of first with the test off, which
  shaded every pixel of the frame and then had the ground painted over most of it.
- Tilt-shift rewritten: half-resolution blur into its own targets, taps sized to the radius.
- Bloom buffers at 70% of the frame; scatter on a Lambert material.
- Governor floor raised from 45 fps to 55. At 45 a machine could sit at fifty for as long as the
  window was open and the governor would call that settled — on a 60 Hz panel that is a doubled
  frame every few, which reads as stutter rather than slowness.

35.0 → 24.4 ms at full scale, 1.26 M → 0.57 M triangles.

**One bug was fixed inside the baseline commit `2f53ae4`**: the per-thread dormancy change had
renamed `dormant` to `folded` but left one reference in `Colony.setThreads`, so every poll threw
a ReferenceError and the island stayed empty. No test reaches that function — it needs a renderer.

### Part B — Ambient life (`14ba8e8`)

The map was frozen whenever nothing was running, which is most of the time. None of this carries
information; it is scenery, and it is confined so it never talks over a status animation.

- **Errands.** Every minute or two an idle builder walks — routed through the nav grid like any
  other walk — to another idle builder, usually on a different plot, waves, and the two stand and
  talk for ten seconds or so taking turns to gesture, before the visitor walks home. **Only the
  idle state takes part**: working, waiting, stuck, celebrating and asleep builders are *saying*
  something and are never interrupted, and a dormant one is never visited (dormant things stay
  put). At most a fifth of the idle crew is out at once. No new draw calls.
- **Gulls** (`src/world/gulls.js`) — three flocks, one instanced draw, only on a world with air.
- **Boats** (`src/world/boats.js`) — three dhows lapping the island, only on a world with a sea.
- **Sand** on the wind, all moving the same way, low over the ground. `weather` on the preset now
  names it; Mars keeps dust, Terra pollen.
- **Palms sway** in the vertex shader, phase taken from where they stand so a stand moves as a
  stand.
- **Dusk is an event.** Each plot has its own moment when its lamps strike, one after another,
  stuttering like tubes, throwing a pool of light on the deck; each building lights its windows
  at a moment of its own. The lights come on a plot at a time through golden hour rather than the
  island fading up together.

Verified in a headless run: forced errands had five builders walking and six reach a partner and
talk within 45 seconds, and a later 4-minute watch showed 8–12 out and up to 8 talking with the
frame loop healthy throughout. Cost ~0.1 ms.

### Part C — Lighting (`6289f01`)

- **One directional light, not two.** The key is the warm sun by day and swings through dusk to a
  cool moon from where the moon actually hangs, so night has its own key and shadow direction and
  the water has a moon path on it. The old night kept the sun on at a tenth strength shining *up*
  from under the ground and hid it with a fill light from nowhere. Removing the fill also removes
  a second lighting evaluation from every lit pixel, all day.
- **Contact shadows.** The shadow map is soft-edged now (two texels of dithered disc), but at a
  texel every six centimetres it cannot draw the crease where a wall meets the deck, and that
  crease is most of what makes a thing look set down. So the lowest half-unit of every building
  shades toward the ground in the shader, and every builder stands in a soft dark disc that stays
  on the ground when it hops.
- **Water moves.** Three sine waves tilt the normal in world space, breaking the key light into
  drifting glints.
- Windows amber rather than the accent at full blast; kerbs a runway edge rather than a neon
  sign; fog follows the night sky after dark instead of staying sand-coloured.

**A bug that was most of the washed-out look:** a building's rise eased toward finished but never
arrived, and the per-frame step fell below the update threshold at about 98% — where the shader
still counts the structure as *under construction* and lights a glowing accent band round its
foot, for as long as the page is open. Every finished building on the map had one. The rise now
lands on its target.

The engine's resize-and-draw path was not touched, so the inherited black-frame fix stands.

### Part D — Identity (`b6dc3fa`)

Everything a person reads: page title and favicon, boot screen, HUD brand, help sheet, hints,
toasts, button titles, settings labels, the server's console line and its 403, and the docs.
Bot Crossing → BotsBay World, astronauts → builders, colony → island, ship → boat, crew →
builders, planet → world, repos → zones in the sidebar. "BotsBay" is painted across the landing
pad, on the near half so the boat does not stand on the letters, turned to read upright from the
resting camera.

**Deliberately not renamed**, and this is load-bearing:

- **File names and class names** (`Astronauts`, `Colony`, `Ship`, `astronauts.js`, `colony.js`,
  `ship.js`). Renaming them would have produced a diff nobody could review for a cosmetic gain.
- **`data/colony.json`** — renaming it orphans every saved map and archive list.
- **`BOT_CROSSING_*` environment variables** (`BOT_CROSSING_DATA`, `BOT_CROSSING_HOST`,
  `BOT_CROSSING_ENV`, `BOT_CROSSING_CURSOR_PROJECTS`) — renaming breaks anyone's existing setup.

`localStorage` keys **did** move (`botsbay.settings.v1`, `botsbay.seen-help`) and the old keys are
read as a fallback, so nobody loses their settings. `window.botsBay` is the console handle and
`window.botCrossing` still answers.

### The black-canvas fix (`f87aa3f`)

Reported after Part D: HUD fine, 3D canvas completely black. **It only affected the High and
Ultra presets**, which is why every screenshot taken while building A to D looked right — all of
them were Balanced.

The tilt-shift rewritten in Part A tone-maps and encodes in its own composite, saving a second
full-frame pass, and it switched the composer's output pass off whenever it was enabled. That is
only valid while the tilt-shift is the **last** pass.

Three decides per compile whether a material tone maps at all: it does when the material draws to
the screen and it does not when it draws into a render target
(`WebGLPrograms.js:180`), and **only in the first case does it emit the tone-mapping functions
into the shader** (`WebGLProgram.js:772`). The composite named `ACESFilmicToneMapping` behind a
define of its own, so the moment anything followed it in the chain its fragment shader failed to
compile — and a pass that will not compile draws nothing.

Antialiasing is what follows it, and antialiasing is on in exactly two presets. GL error 1282, no
exception thrown anywhere, frame loop running at full speed, HUD perfectly healthy.

Fix: the composite uses three's own `<tonemapping_fragment>` and `<colorspace_fragment>` chunks,
which expand to whatever three actually compiled the material for, so it is now impossible for
this shader to name a function three did not emit. `Engine._syncOutputPass` keeps the output pass
on unless the tilt-shift really is last. Verified the frame is tone mapped exactly once either
way: the same pixels come back under Balanced and High to within 2/255.

**`npm run smoke` exists because of this bug.** Nothing short of drawing a frame and reading the
pixels back could have caught it. Run it after any renderer change.

---

## Known issues

1. **Steady 60 fps at full render scale is not reached on the integrated GPU.** Part A's target
   was not fully met and this is the honest state: a clean profile is ~30 ms/frame at Balanced,
   so the governor settles around 75–80% rather than the 55% it used to. On the GeForce the whole
   chain fits in a frame several times over. The single highest-value fix is not code: set the
   browser to High performance in Windows Settings → System → Display → Graphics. There is no
   per-app GPU preference set on this machine (`HKCU:\Software\Microsoft\DirectX\UserGpuPreferences`
   does not exist), so the browser is on the Intel chip.
2. **Profiler numbers are only meaningful on an otherwise idle machine.** A dev server plus an
   open tab rendering the island on the same integrated GPU roughly doubles them. `tools/headless.mjs`
   now kills the browser *process tree* — it previously killed only the process it spawned, and 29
   strays had accumulated and were doubling every later measurement.
3. **The Cursor adapter reads agent transcripts only**; composer/sidebar threads are not read.
   Inherited from upstream.
4. **`npm run smoke` and friends need Chrome or Edge** on the machine. They find it automatically
   on Windows/macOS/Linux; `CHROME=<path>` overrides.
5. **Crew decimation happens at load, not offline.** `assets-src` (the raw KayKit packs) is not
   checked in, so `clusterDecimate` runs in the browser at boot. Costs a few milliseconds. If the
   packs are ever restored, doing it in `tools/build-crew.mjs` with a real simplifier would give a
   better silhouette for the same triangle count.
6. **The upstream README still carries Jarren's status note and support expectations.** Fine for
   a fork, but if this is ever published under BotsBay's own name that section needs rewriting.

---

## What is left

### Task 5 — Hosted mode (not started)

The brief in `BOTSBAY-WORLD-TASKS.md` is complete and should be followed as written. In outline:

1. Supabase schema `world` with `world.agent_status`, realtime publication and RLS — the SQL is
   in the task file. **Only do this after Task 4 has been confirmed passing against the live
   instance**, which was the stated precondition.
2. `server/harnesses/supabase.mjs` reading `world.agent_status` in the standard thread shape.
3. A build mode `hosted` where the browser reads Supabase directly with `supabase-js` and the
   anon key and subscribes to realtime, with no Node API in the loop.
4. Routes: `/` requires login and shows everything; `/demo/<slug>` sets the `x-demo-slug` header
   and shows only that client's rows.
5. Vercel: framework Vite, output `dist/`, env `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_MODE=hosted`, domain `world.botsbay.app`.

The n8n side of it — a sub-workflow upserting a row per agent, called at the start and end of
each production workflow and from an Error Trigger — **the user is building themselves**. Do not
build it.

Two things to think about before starting, neither of which is settled:

- **Hosted mode breaks an invariant.** Today the page only ever answers on the machine the server
  is on, which is what `isLocalRequest` enforces and what most of the security posture rests on.
  A hosted build has no Node server at all, so that check does not apply and RLS is the only
  thing standing between a visitor and other clients' rows. The demo-slug policy in the task file
  is the whole access control; it deserves testing as such.
- **`data/colony.json` has no equivalent hosted.** Archive lists, hidden projects and the zone
  layout are local-only state written by exactly one writer. Hosted mode needs an answer for
  where that lives, or to accept that the map re-lays itself out per browser.

### Smaller things worth doing

- The ambient life has no sound. `making-it-feel-alive.md` argues for it, off by default.
- No "fly to the next one waiting" beacon column — the `N` key cycles but nothing is visible
  through geometry from across the map, which that reference calls the highest-value feature.
- `npm run smoke` is not wired into anything. It is a manual gate; there is no CI here.
