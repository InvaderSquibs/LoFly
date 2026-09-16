# FX Chrome extension

Gherkin QA on **any** `http(s)` page: an animated fly nearest-neighbor searches candidates, evaluates / rejects / locks, then clicks, types, selects, or asserts.

This is the portable sibling of the console activity at `fly_console/activities/fx/`.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → choose this folder: `fx_extension/`
4. Pin **FX · Fly Experience**, then open the **side panel** (toolbar icon)

## Use

1. Navigate to any normal website tab (not `chrome://…`)
2. Edit the Gherkin in the side panel (saved in `chrome.storage.local`)
3. Click **▶ Run on this tab**
4. Watch the fly on the page; perception + step log stream into the panel

## Supported steps

| Step | Behavior |
| --- | --- |
| `I click "…"` | NN search among buttons/links → click |
| `I fill "…" with "…"` | Find text field → type |
| `I select "…" as "…"` | Select / radio / checkbox choice |
| `I should see "…"` | Assert visible text |
| `I am on / go to "…"` | Try nav link/button, else soft-assert text present |
| `I wait 2s` | Pause |
| `I submit` | Submit button / form |

## Layout

```
fx_extension/
  manifest.json          # MV3 · sidePanel + scripting
  background.js          # open side panel on action click
  sidepanel.html|css|js  # Gherkin UI + messaging
  content/
    perceive.js          # shared DOM perception (from console FX)
    runner.js            # Gherkin + fly + NN saccades
    fly.css
  assets/                # fly GIF + icons
  features/sample.feature
```

## Notes

- Restricted pages (`chrome://`, Chrome Web Store, etc.) cannot be scripted.
- v1 is **runner only** (no cascade / skeletons in the panel). Hex eyes can come later.
- Perception reuses the console’s `FxPerceive` nearest-neighbor pool.
