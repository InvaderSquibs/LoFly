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

Use the activity switcher in the header, or step through episodes with ← / →.

## Bug activities

Each activity lives under `fly_console/activities/<id>/`:

| Activity | ID | Idea |
| --- | --- | --- |
| LoFly | `lofly` | Hear a track, court the crate via multi-factor “pheromone” (Camelot / chroma / novelty) |
| Tic-tac-toe | `ttt` | Connectome-driven board play |
| Odor perception | `perception` | Stimulus → pathway → odor readout |

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
