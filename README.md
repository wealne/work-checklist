# work-checklist

Embed a DingTalk AI Table (alidocs) document as a full-page Harness panel, so it
can be browsed, extended and edited with DingTalk's own UI.

The panel is an `iframe` pointed at a small reverse proxy that this plugin runs on
its own loopback port, with a server-side cookie jar so the browser never needs
third-party cookies for DingTalk.

```
/            -> https://alidocs.dingtalk.com
/__login/... -> https://login.dingtalk.com
```

Two upstreams are required because signing in redirects to `login.dingtalk.com`
and back to `alidocs`.

## Requirements

- DeepSeek Harness with the plugin manager (`plugin_manager` tool or the 插件 page).
- A DingTalk account that can open the target document.
- Node 18+ on the machine running DSH (the Host half uses `fetch` and
  `node:http`).

## Installation

Install through the plugin manager with the absolute path of a checkout of this
repository, then enable the resulting row (its entry id is `include:work-checklist`).

This is a linked local bundle: after editing the sources, disable/enable the row
to reload instead of reinstalling.

Run `npm install` in the checkout first — the Host half imports
`@deepseek-ai/schemastery` at module load, so a missing `node_modules/` fails
activation.

### Updating

`git pull` in the checkout, then disable/enable the row. The bundle is linked,
so there is nothing to reinstall.

## First run

The bundle ships **without a table address**, because every DingTalk document is
private to its workspace. Open the panel once; it unfolds the settings form and
asks for an address.

1. Open the document in a browser and copy the URL from the address bar. Either
   of these forms works:
   - `https://alidocs.dingtalk.com/i/nodes/<id>?...` — the document shell
   - `https://alidocs.dingtalk.com/iframe/notable?...` — the editor itself
2. Paste it into **表格地址** (Table address) and save.
3. Scan the DingTalk QR code that the panel renders. The session cookies are
   stored in the jar; the sheet appears.

Nothing leaves the machine — the proxy only ever talks to
`alidocs.dingtalk.com` and `login.dingtalk.com`, and only binds loopback.

## Configuration

Two ways in, both editing the same two values:

1. **From the panel** — click 设置 in the panel toolbar. The form unfolds over the
   sheet, so the address is one click away while you are working.
2. **From the plugin manager** — 插件 → 查看 工作清单. The form sits below the
   README, so it needs a scroll; it is easy to miss.

Edits are written to the profile's `cordis.patch.yml` and picked up live — the
proxy restarts on the new settings without a reload.

| key | default | meaning |
| --- | --- | --- |
| `url` | *(empty)* | the alidocs document to embed |
| `port` | `0` | loopback port; `0` picks a free one |

The `/i/nodes/<id>` form is the document shell; its HTML carries the editor URL,
which is resolved on startup. `sheetId` / `viewId` from the shell URL's
`iframeQuery` are carried over, so the panel opens on the same sheet and view.

The schema lives in `lib/index.js` and is exported as `Config`. Its fields are
`.volatile()`, which is what makes them show up in the settings form at all:
`dsh-settings` only publishes namespaces whose schema has at least one volatile
field, and returns nothing otherwise.

## How it works

### The proxy

The proxy needs its own listener rather than a `ctx.webServer` prefix route: the
SPA router reads `location.pathname` and sends anything that is not a document
route back to `/i/desktop`, so it only works mounted at `/`.

It serves:

- `GET /work-checklist/config` -> `{ url, port, cookies, configured, error }`,
  where `url` is the embed URL on the live proxy port and `configured` is `false`
  on first run.

The UI registers these slots under the id `work-checklist`:

- `sidebar.panellist` — the sidebar rail icon
- `main` — an empty seat that reserves the panel's box
- `shell.overlay` — the live sheet, positioned over the seat
- `plugins.bundle.config` / `plugins.row.config` — the settings form

### Why the sheet lives in `shell.overlay`

The `main` slot is swapped out whenever another panel — or the conversation —
takes over, and an unmounted `iframe` starts over on the next visit, losing the
signed-in editor state and reloading DingTalk's whole SPA.

`shell.overlay` is rendered by the frame itself and never unmounts, so the sheet
is hosted there instead. `main` contributes a seat (an empty element marked
`data-work-checklist-seat`), and a `requestAnimationFrame` loop keeps the overlay
aligned to that seat's `getBoundingClientRect()` relative to
`[data-shell-overlay]`. Leaving the panel removes the seat, which hides the
overlay with `display: none`; returning restores it.

Moving an `iframe` between parents reloads it, hiding it does not — that is the
whole trick. Switching panels therefore costs no reload at all.

### The sheet's own navigator

The sheet opens its left navigator expanded on every load and does not remember
being collapsed. `lib/index.js` injects a small script into the document shell
that clicks `[data-role="Catalog_Expand"]` once, as soon as it exists.

## Sharing it

This bundle carries **no credentials**. The DingTalk session lives outside the
package, at `~/.dsh/work-checklist/cookies.json`, resolved per machine from
`homedir()`. A recipient starts with an empty jar and signs in themselves.

`npm pack` produces the published file set. Do **not** ship `node_modules/` —
it only holds a local copy of `@deepseek-ai/schemastery` used to satisfy this
machine's module resolution; `.npmignore` and the `files` field both exclude it,
and the recipient installs its own. Never ship `~/.dsh/` either — that is profile
state, not part of the bundle.

## Caveats

- The proxy strips upstream `content-security-policy`, `x-frame-options` and
  `strict-transport-security` headers, because they would block the embed.
- Cookie attributes are normalised to `Path=/; SameSite=Lax` so the proxy origin
  can hold them.
- Only the loopback interface is bound; nothing is exposed to the network.
- The session expires like any browser session. When the sheet starts rendering
  DingTalk's login page again, sign in once inside the panel.
- `@deepseek-ai/schemastery` is pinned to the version DSH ships (3.18.5). If a
  future DSH changes the schema shape, bump that dependency.

## License

[MIT](LICENSE)
