# LoFly (Lord of Fly)

**LoFly** is a connectome playground: a fruit-fly brain console where shared MaleCNS pathway dynamics drive different **Bug activities** — games, perception tasks, and (for LoFly itself) courtship-as-DJ.

The fly experiences a stimulus, activity cascades through ALPN → Kenyon cell → MBON → DAN, and each activity reads that out as something you can watch: a tic-tac-toe move, an odor call, or a pheromone match to the next track in the crate.

## What’s in this repo

| Path | Role |
| --- | --- |
| `fly_console/` | Browser console — experience replay, cascade/raster, skeletons, eyemap |
| `fly_console/activities/` | Per-activity adapters + exported `experience.json` |
| Root `*.py` / subgraphs | Experiments and extractors that feed activities |

Raw MaleCNS dumps (full connectome feathers) are **not** committed — they’re too large. Place them next to this repo if you regenerate subgraphs.

## Quick start (console)

Serve the console over HTTP (browsers won’t `fetch` local JSON via `file://`):

```bash
cd fly_console
python3 -m http.server 8000
```

Open:

- [http://localhost:8000/?activity=lofly](http://localhost:8000/?activity=lofly) — **LoFly (Bug DJ)**
- [http://localhost:8000/?activity=ttt](http://localhost:8000/?activity=ttt) — tic-tac-toe
- [http://localhost:8000/?activity=perception](http://localhost:8000/?activity=perception) — odor perception
- [http://localhost:8000/?activity=fx](http://localhost:8000/?activity=fx) — **FX** (Gherkin form QA)
- [http://localhost:8000/?activity=fs-avatar](http://localhost:8000/?activity=fs-avatar) — **FS-Avatar** (Battlesnake pilot)

Use the activity switcher in the header, or step through episodes with ← / →.

## Bug activities

Each activity lives under `fly_console/activities/<id>/`:

| Activity | ID | Idea |
| --- | --- | --- |
| LoFly | `lofly` | Hear a track, court the crate via multi-factor “pheromone” (Camelot / chroma / novelty) |
| Tic-tac-toe | `ttt` | Connectome-driven board play |
| Odor perception | `perception` | Stimulus → pathway → odor readout |
| FX | `fx` | Gherkin → live DOM perception → act on FlyMart (click / type / select / assert); animated fly cursor |
| FS-Avatar | `fs-avatar` | Battlesnake pilot — policy `/move`, fly joystick theater, gold snake = YOU; signals for later neuron wiring |

### FS-Avatar (Battlesnake)

Real webhook + console theater — not a stub.

```bash
# terminal 1 — Battlesnake API
cd fly_console/activities/fs-avatar
python3 server.py          # http://127.0.0.1:8001

# terminal 2 — install CLI once, then play (or use console “Start real game”)
go install github.com/BattlesnakeOfficial/rules/cli/battlesnake@latest
./play.sh                  # solo game against your snake
```

Console: [http://localhost:8000/?activity=fs-avatar](http://localhost:8000/?activity=fs-avatar) — **Start real game** calls `POST /dev/play`; the fly joystick mirrors each live `/move`. Local sim remains available for offline tinkering.

For Funathon / play.battlesnake.com, deploy the same `server.py` (Replit etc.) and register the URL — display name must include your last name.

### LoFly extras

1. Drop audio into `fly_console/activities/lofly/library/` (gitignored — use your own files).
2. Catalogue tracks (BPM, key, chroma):

   ```bash
   cd fly_console && python3 activities/lofly/catalogue.py
   ```

3. Run sessions / brain trials and export console replay:

   ```bash
   python3 fly_console/activities/lofly/engine.py --n 20 --fresh
   python3 fly_console/activities/lofly/export_experience.py
   ```

## Adding a new Bug activity

1. Create `fly_console/activities/<id>/` with at least:
   - `activity.js` — registers `window.FlyActivity.mount` for the left-hand chrome
   - `experience.json` — ExperienceReplay payload (see `fly_console/experience_schema.py`)
2. Register it in `fly_console/js/console.js` under `ACTIVITIES`:

   ```js
   mybug: {
     data: "activities/mybug/experience.json",
     module: "activities/mybug/activity.js",
     label: "my bug",
   },
   ```

3. Optionally add an `export_experience.py` that writes the shared schema from your trial logs.
4. Open `?activity=mybug` and iterate.

Keep activity-specific UI in `activity_payload`; the shell owns cascade, raster, learning, skeletons, and eyemap.

## Regenerating shared viz data

From `fly_console/`:

```bash
python3 scripts/fetch_neuron_skeletons.py   # fills data/_swc_cache (gitignored)
python3 scripts/build_optic_lobe_hexmap.py
python3 activities/export_all.py            # refresh all activity experience.json files
```

## License / data

Experiment code is yours to extend. MaleCNS / FlyWire-derived data retain their upstream licenses — cite the original releases when publishing results. Audio in `library/` is not shipped with this repo.

## FX Chrome extension

Portable Gherkin + fly runner for any website:

- Folder: [`fx_extension/`](fx_extension/)
- Load unpacked from `chrome://extensions` (see that README)

