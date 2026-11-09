# Mindmap

Mind maps and flowcharts that run entirely in your browser, with an API that any AI can use. No account, no server, no build step, no dependencies.

Hosted copy: https://odoluca.github.io/mindmap/

## Features

- **Mind maps**: a central idea with branches. `Tab` adds a child, `Enter` a sibling, double-click edits. Balanced, right, down and radial auto-layouts; collapse branches; drag a node onto another to move it there.
- **Flowcharts**: rectangles, diamonds, stadiums, parallelograms, hexagons, cylinders, sticky notes and plain text, with labelled arrows (curved, straight or orthogonal) and free placement or a layered auto-layout.
- **Notes and a change log**: comments attached to nodes or the map, separate from node text, and a log of who changed what. Nodes added by someone else (for example an AI) carry a badge.
- **Saved in the browser** (IndexedDB), several maps per browser. Export and import JSON, export SVG, PNG and Markdown outlines, open Markdown or tab-indented outlines.
- **API for AI**: the page is the API. See [api.html](api.html) or [llms.txt](llms.txt).
  - Paste: copy the map as JSON or an outline, let any AI work on it, paste the answer back on the canvas.
  - Links: `#ops=[…]`, `#outline=…`, `#import=…`, `#open=id`, `#cmd={…}` apply a change when opened.
  - `window.mindmap`: `getMap()`, `apply(ops)`, `addTree()`, `link()`, `note()`, `find()`, `on('change')`… for browser-driving agents and the devtools console.

## Keyboard

| Key | Action |
|---|---|
| `Tab` / `Enter` | Add a child / a sibling of the selected node |
| `Space`, `F2`, double-click | Edit text (`Enter` saves, `Shift+Enter` new line, `Esc` cancels) |
| `Delete` | Delete the selection |
| Arrows | Move the selection between nodes |
| `Shift`+click, `L` | Select several nodes; link two selected nodes |
| `C` | Collapse or expand a branch |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (AI changes included) |
| `Ctrl+D` | Duplicate the selected branch |
| `Ctrl+C` / `Ctrl+V` | Copy the branch as an outline / paste an outline, JSON map or operations |
| `Ctrl+F` | Search; `Enter` jumps between matches |
| `F`, `+`, `-` | Fit, zoom in, zoom out |

Drag the background to pan, wheel to zoom. Drag a node's dot onto another node to draw a link; double-click a link to label it. Double-click the canvas to add a floating node.

## Project layout

- `index.html`, `styles.css` – shell and layout.
- `api.html`, `llms.txt` – the API reference for people and agents.
- `src/model.js` – the map document, validation, the operation set, markdown outline import/export.
- `src/layout.js` – text wrapping, node sizing and the automatic layouts.
- `src/render.js` – node shapes, edge routing, the DOM renderer and the SVG exporter.
- `src/storage.js` – IndexedDB persistence, downloads, preferences, cross-tab notifications.
- `src/api.js` – `window.mindmap` and the URL hash commands.
- `src/main.js` – the editor: view, interaction, panels, import/export.
- `src/sample.js` – the example map.

## Development

Open `index.html` through any static server (`run.bat` or `python scripts/serve.py 8080`), since ES modules do not load from `file://`. `npm test` runs the Node unit tests (Node 18+); `npm run check` syntax-checks the sources. No `npm install` is needed.

## Releasing

Run `python scripts/bump.py X.Y.Z` before pushing a user-visible change. It sets the version in `src/version.js`, `version.json`, `package.json` and stamps every module import with `?v=X.Y.Z` so browsers fetch a consistent set of files. The app compares its version with `version.json` on the server and offers a reload when a newer build is live.

## Licence

MIT.
