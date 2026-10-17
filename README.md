# Design notes

Point at what looks wrong on your running site, write a note, press **Submit** - Claude Code gets the notes and fixes the code.

- Numbered overlay of every gap on the page (space between blocks, padding inside blocks, space between side-by-side items) with its size in px.
- Click a number, or **Alt + click** anything, to leave a note. Notes stay in the browser until you submit them.
- **Submit** sends them to your Claude Code session, which finds the elements in the code and changes them. **Copy** gives you the notes as text instead.
- Works in same-origin iframes (Storybook and the like). Cross-origin iframes can't be reached by a bookmarklet.

## Install

Needs Node 18+ and Chrome (or any browser with a bookmarks bar).

In Claude Code (older versions: `/plugin marketplace add craghagBg/design-notes`, then `/plugin install design-notes@design-notes`):

```
/plugin install design-notes --marketplace craghagBg/design-notes
```

## Use

1. In Claude Code, in your project: `/design-notes:start` (or `/design-notes:notes` - same thing). It starts a small local server (port 8787) and waits for notes.
2. First time only: open http://localhost:8787/ and drag **📏 Design notes** to the bookmarks bar.
3. Open your site, click the bookmark, leave notes, press **Submit**. Claude picks them up and keeps listening for the next batch.

`/design-notes:start stop` (or `/design-notes:notes stop`) stops listening.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `DESIGN_NOTES_PORT` | `8787` | port of the local server |
| `DESIGN_NOTES_ORIGINS` | - | extra sites allowed to submit: comma separated exact origins (`https://staging.example.com`), or `*` for any site. `localhost`, `127.0.0.1`, `*.localhost` and `*.test` are always allowed. |

The overlay itself works on any site you open; the list only decides which sites may **Submit**. It exists so that some other page open in your browser can't send "notes" to Claude, which edits your code with them. `*` turns that off - fine while you only browse your own sites.

## How it works

`server/server.mjs` listens on `127.0.0.1` only. It serves the install page and `overlay.js` (the bookmark just loads that script, so updating the plugin updates the overlay), accepts `POST /notes` only from allowed origins, and hands the notes to `server/wait.mjs`, which Claude runs in the background - its exit is what wakes Claude up.

Tests: `npm test`.
