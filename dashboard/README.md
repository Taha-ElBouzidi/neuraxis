# The map

Your memories as one live picture, grouped by topic: every memory a node coloured by its topic, every wikilink an
edge, and a current that runs to a memory each time your AI recalls it.

```
node tools/dashboard.mjs --open
```

<p align="center"><img src="../docs/dashboard.jpg" width="900"
     alt="The map with one memory open: its description, its facts, its links and what it connects to, the memories coloured by topic."></p>

That is the whole install. No build step, no npm install, no framework. The server reads `memory/`,
`index/topics.json` and the recall log directly, and tells the open page when one of them changes (server-sent
events from `fs.watch`, no polling).

**Topics** come from `index/topics.json`, which `node tools/build-index.mjs` builds from your links and from what
the memories mean. **Without the meaning model** (a keyword-only install) there are no topics: the map groups the
memories by kind (identity, projects, rules, reference) and says in one line why and how to get topics.

**With an empty `memory/`** the page says there are no memories yet, and draws the first one the moment it is saved.

To try it on an invented brain: `node tools/map-sample.mjs <folder>` (add `--keyword-only` for the view without
topics), then `node tools/dashboard.mjs --brain <folder> --open`.

## Options

| | |
|---|---|
| `--port 8492` | which port, or set `BRAIN_DASHBOARD_PORT` |
| `--host 127.0.0.1` | loopback by default, on purpose. A picture of your own memory is not something to put on every interface by accident |
| `--brain <folder>` | draw another brain folder (one with `memory/`) instead of this one |
| `--open` | open a browser as well |

## Making it yours

`dashboard/config.json` holds your settings. Edit, save, reload the page.

```json
{
  "name": "Orbit",
  "tagline": "second brain",
  "colors": { "void": "#101820", "accent": "#F6A21E", "pulse": "#4FC3F7" },
  "links": [{ "label": "My notes", "url": "https://example.com", "note": "notes" }]
}
```

| key | what it changes |
|---|---|
| `name`, `tagline` | the wordmark, the browser tab, and the letter on the core |
| `colors` | the palette; anything you leave out keeps its default |
| `links` | your own shortcuts in the side rail (`http`, `https` or a path on the same server). Left empty, that section does not appear. Nothing is probed |

| colour key | what it paints |
|---|---|
| `void` | the background |
| `ink`, `ink2`, `ink3` | text, from brightest to faintest |
| `accent`, `accent2` | the core, the active control, the creation animation |
| `pulse`, `pulse2` | the current that runs on a recall |
| `up`, `down` | the live and the unreachable status |

`regions` and `showMachines` belonged to the old dashboard and are ignored: topics replace the four bands, and the
map draws no machine nodes. They can stay in the file; they do nothing.

## What you are looking at

| | |
|---|---|
| **Sphere** | each topic a band of the sphere, links routed through it so the middle stays readable |
| **Constellation** | positioned by what links to what, so a visible cluster is a subject your brain keeps together |
| colour | the topic, named in the legend |
| gold | a memory being created, and its links drawing themselves in |
| blue | a recall, running to the memory it used |
| red | a memory being deleted |
| bigger and brighter | more facts and more links |

Drag to turn it, scroll or pinch to zoom, click a memory to open it and see its facts. The Names toggle hides every
label, and the eye (or H) hides everything but the map.

## On a phone

Add it to your home screen and it runs full screen. The controls become one row of icons along the bottom.
