# dsh-ui-mica

Mica material for the DeepSeek Harness **sidebar** and **title row**, with an
on/off switch in **Settings → General**.

![The sidebar and title row painted with the Mica material, light theme](docs/preview-desktop-light.png)

![The same material in the dark theme](docs/preview-desktop-dark.png)

## What it does

The sidebar column and the Windows title row are the two surfaces the harness
already paints from a single token, `--dsw-specific-sidebar-fill`. This plugin
replaces that token with a translucent panel fill and puts a desktop-like
backdrop — a base colour plus four colour blooms and a fine grain — behind the
whole frame. The result is the layered, slightly frosted look Windows calls
Mica: the panels show the colour behind them, while the text stays crisp.

The middle column, where the conversation is, is deliberately left **opaque**.
A translucent panel is a decoration; a translucent wall of text is a bug.

## Install

```sh
dsh plugin --profile <profile> add dsh-ui-mica
```

Restart the harness afterwards. A running `dsh web` composes its bundles at
startup, so the plugin is only picked up on the next launch.

## Settings

**Settings → General → Mica background** turns the material on and off. The
switch takes effect immediately: no reload, and no flicker in either direction.

Three cosmetic knobs are not in the UI. Set them in the profile's
`cordis.patch.yml` and reload the page:

```yaml
- insert:
    - id: ui-mica
      name: dsh-ui-mica
      config:
        enabled: true   # same switch as the Settings row
        opacity: 62     # 20–92: percent of the host surface colour kept in the panel fill
        blur: 30        # 0–120: backdrop blur on the two Mica surfaces, in px
        noise: 0.06     # 0–0.3: opacity of the film grain
```

Raise `opacity` if text over the panels ever feels low-contrast; lower it if the
backdrop is not showing through enough.

## How it works

The plugin has two halves, and only one of them owns the CSS.

**`lib/index.js` — the host half.** It declares the four `volatile()` config
fields, suppresses the schema-generated settings page (the browser half draws
its own row), and hooks `webserver/index-inject` to push two entries into every
served `index.html`:

- one `<style>` with the whole material, and
- one `<script>` that sets `data-dsh-mica` on `<html>` before the first paint.

That second entry is why there is no flash of unstyled chrome: the browser half
loads well after the first frame, and an attribute that arrives late would show
as a visible jump.

**`lib/client.js` — the browser half.** It reads the `ui-mica` settings
namespace through `configForms`, mirrors `enabled` onto the document element,
and registers the Settings row. It ships no CSS of its own.

**Every selector is gated on `html[data-dsh-mica="on"]`.** That is the load
bearing property of the design: the switch is a single attribute flip, the
stylesheet is injected exactly once per page, and the off state cannot leave a
half-applied material behind.

Two smaller decisions worth knowing about:

- The panel fill is derived, not hard-coded:
  `color-mix(in srgb, var(--dsw-alias-bg-base) <opacity>%, transparent)`. It
  therefore follows the active theme — light, dark, or any third-party theme —
  without a per-scheme table to keep in sync.
- The material wins against the theme presenter by `!important`. The presenter
  writes its tokens as inline custom properties on `<body>`, which is exactly
  what a stylesheet can override; nothing here depends on the host agreeing to
  lower its own specificity.

## Known limitations

- **No title row in a plain browser document.** The harness only sets
  `data-windows-titlebar` in the Windows desktop shell; a browser tab has no
  title row to paint, so only the sidebar changes there. This is the host's
  layout, not a gap in the plugin.
- **The three cosmetic knobs need a page reload.** They are read when the index
  is served, so editing the YAML changes the next page load, not the current one.
- **The material assumes the host keeps its `--dsw-*` tokens.** It layers on top
  of the theme rather than replacing it; a host that renames those tokens would
  leave the panels unpainted rather than broken.

## Development

There is no build step. Both halves ship as hand-written JavaScript, so the
scripts below stand in for the compile-and-check stage a TSX plugin would have.

```sh
node scripts/check.mjs     # static bundle invariants (the "build" that isn't)
node scripts/smoke.mjs     # runs both halves against a stubbed host
node scripts/preview.mjs   # writes preview/*.html — the material, without a restart
```

`preview.mjs` generates the real stylesheet and renders it against a
reproduction of the host's frame markup, which is the only practical way to
iterate on a UI plugin without installing it and restarting the harness. Open
the generated pages in a browser, or screenshot them headlessly:

```sh
msedge --headless=new --disable-gpu --window-size=1280,760 \
  --screenshot="preview/shot.png" "preview/desktop-light.html"
```

Press <kbd>m</kbd> in a preview page to flip the material on and off.

## License

MIT — see [LICENSE](LICENSE).
