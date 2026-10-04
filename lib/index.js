/**
 * dsh-ui-mica — host half.
 *
 * The whole material lives here, on the host, for one reason: the host can put
 * it into the served document *before the first frame*. `webserver/index-inject`
 * is asked for a fresh row set on every index render, so this half pushes
 *
 *   1. one `<style>` row carrying every declaration of the material, and
 *   2. one body `<script>` row that stamps `html[data-dsh-mica="on|off"]`
 *      before the shell mounts.
 *
 * Every selector below is scoped under `html[data-dsh-mica="on"]`. That single
 * fact is what the browser half leans on: switching the material off is one
 * attribute flip, with no re-injection, no flash of unmaterialed chrome, and
 * exactly one copy of the CSS in the document.
 *
 * The material is built out of the host's own alias tokens wherever a host
 * surface would have used them (`--dsw-alias-bg-base` in the panel fill,
 * `--dsw-alias-border-l3` for edges), so it stays correct in light mode, dark
 * mode, and under any theme that ships its own token set.
 */

import Schema from "@deepseek-ai/schemastery";

/** Settings namespace. Must equal the cordis row id in `cordis.patch.yml`. */
const NAMESPACE = "ui-mica";
/** Marks every node and every declaration this plugin owns. */
const STYLE_MARKER = "dsh-ui-mica";
/** Document attribute that gates the material. The browser half flips it. */
const ROOT_ATTRIBUTE = "data-dsh-mica";
/** The attribute value that turns every rule below on. */
const ROOT_ON = "on";
/** The attribute value that turns every rule below off. */
const ROOT_OFF = "off";
/** Reported in the generated stylesheet header; kept in step with package.json. */
const VERSION = "0.1.0";

const ENABLED_FIELD = "enabled";
const OPACITY_FIELD = "opacity";
const BLUR_FIELD = "blur";
const NOISE_FIELD = "noise";

const DEFAULT_ENABLED = true;

/** Percent of the host surface colour left in the panel fill. */
const DEFAULT_OPACITY = 62;
const OPACITY_MIN = 20;
const OPACITY_MAX = 92;

/** Backdrop blur, in px, applied to the two Mica surfaces. */
const DEFAULT_BLUR = 30;
const BLUR_MIN = 0;
const BLUR_MAX = 120;

/** Opacity of the film grain laid over the two Mica surfaces. */
const DEFAULT_NOISE = 0.06;
const NOISE_MIN = 0;
const NOISE_MAX = 0.3;

/** Edge length of one grain tile, in px. */
const GRAIN_TILE = 160;

/**
 * The window backdrop: one flat canvas plus four colour blooms.
 *
 * Read as "a desktop picture the panes can sample". The blooms are what make
 * the material legible as glass — with a flat backdrop a translucent panel is
 * indistinguishable from an opaque one, so the panels' own translucency would
 * buy nothing.
 */
const BLOOM_STACK = [
  "radial-gradient(58% 44% at 10% 4%,var(--dsh-mica-bloom-1) 0%,transparent 100%)",
  "radial-gradient(50% 38% at 92% 8%,var(--dsh-mica-bloom-2) 0%,transparent 100%)",
  "radial-gradient(54% 46% at 84% 94%,var(--dsh-mica-bloom-3) 0%,transparent 100%)",
  "radial-gradient(48% 42% at 4% 90%,var(--dsh-mica-bloom-4) 0%,transparent 100%)",
].join(",");

/** Light-scheme palette. */
const PALETTE_LIGHT = [
  "--dsh-mica-canvas:#e9edf8",
  "--dsh-mica-bloom-1:#8ea6ff",
  "--dsh-mica-bloom-2:#c0a8ff",
  "--dsh-mica-bloom-3:#7fd6ec",
  "--dsh-mica-bloom-4:#a79bff",
  "--dsh-mica-sheen:rgba(255,255,255,.34)",
  "--dsh-mica-edge:rgba(15,23,42,.07)",
].join(";");

/**
 * Dark-scheme palette.
 *
 * It rides `body[data-ds-dark-theme]`, which the host's theme presenter sets and
 * removes on every snapshot, so this needs no cooperation from the theme service.
 */
const PALETTE_DARK = [
  "--dsh-mica-canvas:#0a0c12",
  "--dsh-mica-bloom-1:#1c2f6d",
  "--dsh-mica-bloom-2:#3a2474",
  "--dsh-mica-bloom-3:#0d4a5f",
  "--dsh-mica-bloom-4:#2a2179",
  "--dsh-mica-sheen:rgba(255,255,255,.045)",
  "--dsh-mica-edge:rgba(255,255,255,.06)",
].join(";");

/**
 * One tile of film grain, as a data URI.
 *
 * `feTurbulence` at a high base frequency is the cheapest convincing noise there
 * is: no image asset, no network request, and it tiles seamlessly thanks to
 * `stitchTiles`. `#` is written `%23` because the markup is inside a URI, and
 * the angle brackets are percent-encoded so the whole thing can be dropped into
 * a `<style>` element without ever looking like markup.
 *
 * @param strength Opacity of the noise, 0 to disable the layer entirely.
 * @returns A CSS `url(...)` value, or `none` when the knob is at zero.
 */
function grainImage(strength) {
  if (!(strength > 0)) return "none";
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' width='${GRAIN_TILE}' height='${GRAIN_TILE}'>`,
    "<filter id='dsh-ui-mica-grain'>",
    "<feTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/>",
    "<feColorMatrix type='saturate' values='0'/>",
    "</filter>",
    `<rect width='${GRAIN_TILE}' height='${GRAIN_TILE}' filter='url(%23dsh-ui-mica-grain)' opacity='${strength}'/>`,
    "</svg>",
  ].join("");
  return `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
}

/**
 * Read the live config.
 *
 * Volatile fields are live references, not snapshots: this is called once per
 * index render, so an edited value is picked up by the next page load without
 * restarting anything.
 *
 * @param config Validated live plugin config.
 * @returns Plain settings object.
 */
function readSettings(config) {
  return {
    enabled: config[ENABLED_FIELD].get(),
    opacity: config[OPACITY_FIELD].get(),
    blur: config[BLUR_FIELD].get(),
    noise: config[NOISE_FIELD].get(),
  };
}

/**
 * Build the complete material stylesheet.
 *
 * @param settings Plain settings object from {@link readSettings}.
 * @returns CSS text in which every selector is gated on the root attribute.
 */
function materialCss(settings) {
  const scope = `html[${ROOT_ATTRIBUTE}="${ROOT_ON}"]`;
  const bloom = BLOOM_STACK;
  const grain = grainImage(settings.noise);
  // The grain sits under the sheen so the grain reads as being *inside* the
  // pane and the sheen as being on its surface, which is the order the eye
  // expects from real frosted glass.
  const paneLayers = grain === "none"
    ? "linear-gradient(to bottom,var(--dsh-mica-sheen),transparent 46%)"
    : `${grain},linear-gradient(to bottom,var(--dsh-mica-sheen),transparent 46%)`;
  const frost = `-webkit-backdrop-filter:blur(${settings.blur}px) saturate(180%);`
    + `backdrop-filter:blur(${settings.blur}px) saturate(180%)`;

  return [
    `/* ${STYLE_MARKER} ${VERSION} — Mica material for the sidebar and the title row. */`,
    "/* Generated from the live plugin config on every index render. */",
    "/* Every rule is gated on the root attribute, so the browser half can turn the */",
    "/* whole material off by flipping one attribute — no re-injection, no flash. */",

    // 1. The document gives up its own paint so the material can own the window.
    `${scope},${scope} body{background-color:transparent!important;background-image:none!important}`,
    `${scope} body{--dsh-boot-bg:transparent!important}`,
    `${scope} #root{background:transparent!important}`,

    // 2. Palette, per scheme.
    `${scope} body{${PALETTE_LIGHT}}`,
    `${scope} body[data-ds-dark-theme]{${PALETTE_DARK}}`,

    // 3. The window itself is the material. This is the layer the panes sample,
    //    and it is also the fallback for shells whose frame is translucent.
    `${scope}::before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;`
      + `background-color:var(--dsh-mica-canvas);background-image:${bloom}}`,

    // 4. The app frame paints the same material. Without this the frame's own
    //    `--dsw-alias-bg-base` would sit behind the panes, and a translucent
    //    sidebar would resolve to flat grey instead of to the backdrop.
    `${scope} [class*="_frame"]{background-color:var(--dsh-mica-canvas)!important;`
      + `background-image:${bloom}!important}`,

    // 5. Prose still needs an opaque page. The content column is the one surface
    //    that must *not* go translucent, and in the Windows shell it keeps the
    //    host's rounded top-left corner.
    `${scope} [class*="_centerCol"]{background:var(--dsw-alias-bg-base)!important}`,
    `${scope}[data-windows-titlebar] [class*="_centerCol"]{`
      + "border-radius:var(--dsh-windows-content-radius,16px) 0 0 0;corner-shape:round}",

    // 6. The panel fill is derived rather than hard-coded. `color-mix` against
    //    the host surface token means the same declaration is right in light
    //    mode, in dark mode, and under any third-party theme, with no per-scheme
    //    value to keep in sync.
    `${scope} body{--dsw-specific-sidebar-fill:`
      + `color-mix(in srgb,var(--dsw-alias-bg-base) ${settings.opacity}%,transparent)!important}`,

    // 7. The two Mica surfaces. Both the sidebar column and the Windows title row
    //    already paint `--dsw-specific-sidebar-fill`, so the fill itself is
    //    handled above; this adds what makes it read as Mica rather than as a
    //    tinted rectangle — grain, a top sheen, and a backdrop blur.
    `${scope} [class*="_sidebarCol"],`
      + `${scope}[data-windows-titlebar] [class*="_frame"]::before{`
      + `background-image:${paneLayers}!important;${frost}}`,

    // 8. The sidebar's inner root paints the same fill token a second time.
    //    Left alone the sidebar stacks two translucent layers while the title
    //    row stacks one, and the two panes visibly disagree; this collapses the
    //    sidebar back to a single layer so one `opacity` value reads the same
    //    on both surfaces.
    `${scope} [class*="_sidebarCol"] [class*="_root"]{background:transparent!important}`,

    // 9. Hairline edges, so the panes have an edge where the host's own border
    //    is removed (Windows drops the sidebar's right border).
    `${scope} [class*="_sidebarCol"]{box-shadow:inset -1px 0 0 var(--dsh-mica-edge)}`,
    `${scope}[data-windows-titlebar] [class*="_frame"]::before{`
      + "box-shadow:inset 0 -1px 0 var(--dsh-mica-edge)}",
    "",
  ].join("\n");
}

/**
 * Build the pre-mount body script.
 *
 * The material is gated on an attribute, so *something* has to set that
 * attribute before the first paint. The browser half cannot: it is loaded and
 * mounted long after the shell is on screen, and a material that appears one
 * frame late reads as a flash of unstyled chrome. A body script is the only
 * piece of this plugin that runs early enough.
 *
 * @param enabled Persisted switch state.
 * @returns Script source that stamps the root attribute.
 */
function bootScript(enabled) {
  const value = enabled ? ROOT_ON : ROOT_OFF;
  return `(()=>{document.documentElement.setAttribute(${JSON.stringify(ROOT_ATTRIBUTE)},`
    + `${JSON.stringify(value)})})()`;
}

/**
 * Build the injection rows for one index render.
 *
 * @param settings Plain settings object from {@link readSettings}.
 * @returns Row list for the `webserver/index-inject` table.
 */
function micaInjections(settings) {
  return [
    { kind: "style", text: materialCss(settings) },
    { kind: "script", placement: "body", text: bootScript(settings.enabled) },
  ];
}

/**
 * Live material settings.
 *
 * All four are `volatile()` so the settings store treats them as live
 * references that the UI may rewrite, rather than as fixed schema values.
 * `enabled` is the only one the browser half exposes; the three cosmetic knobs
 * are edited in `cordis.patch.yml` and take effect on the next page load.
 *
 * `description` strings are host-facing schema documentation (they end up in
 * `cordis.yml` tooling output), not user-facing UI copy — the Settings row draws
 * its own text through the locale service.
 */
const Config = Schema.object({
  [ENABLED_FIELD]: Schema.boolean()
    .default(DEFAULT_ENABLED)
    .description("Paint the sidebar and the title row with the Mica material.")
    .volatile(),
  [OPACITY_FIELD]: Schema.number()
    .min(OPACITY_MIN)
    .max(OPACITY_MAX)
    .default(DEFAULT_OPACITY)
    .description("Percent of the host surface colour kept in the panel fill.")
    .volatile(),
  [BLUR_FIELD]: Schema.number()
    .min(BLUR_MIN)
    .max(BLUR_MAX)
    .default(DEFAULT_BLUR)
    .description("Backdrop blur applied to the two Mica surfaces, in px.")
    .volatile(),
  [NOISE_FIELD]: Schema.number()
    .min(NOISE_MIN)
    .max(NOISE_MAX)
    .default(DEFAULT_NOISE)
    .description("Opacity of the film grain laid over the Mica surfaces.")
    .volatile(),
});

/**
 * Install the material.
 *
 * @param ctx Host plugin context.
 * @param config Validated live plugin config.
 */
function apply(ctx, config) {
  // The browser half draws its own Settings row, so the schema-generated page
  // for this plugin must be suppressed. Leaving it on would render a second,
  // uglier copy of the same switch.
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      `${STYLE_MARKER}: settings form policy`,
    );
  });

  ctx.on("webserver/index-inject", (table) => {
    table.push(...micaInjections(readSettings(config)));
  }, { prepend: true });
}

export {
  BLUR_FIELD,
  BLUR_MAX,
  BLUR_MIN,
  Config,
  DEFAULT_BLUR,
  DEFAULT_ENABLED,
  DEFAULT_NOISE,
  DEFAULT_OPACITY,
  ENABLED_FIELD,
  NAMESPACE,
  NOISE_FIELD,
  NOISE_MAX,
  NOISE_MIN,
  OPACITY_FIELD,
  OPACITY_MAX,
  OPACITY_MIN,
  ROOT_ATTRIBUTE,
  ROOT_OFF,
  ROOT_ON,
  STYLE_MARKER,
  VERSION,
  apply,
  bootScript,
  grainImage,
  materialCss,
  micaInjections,
  readSettings,
};
