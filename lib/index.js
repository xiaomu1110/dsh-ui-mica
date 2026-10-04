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
 * The material is built out of the host's own alias token wherever a host
 * surface would have used it (`--dsw-alias-bg-base` in the panel fill), so it
 * stays correct in light mode, dark mode, and under any theme that ships its own
 * token set.
 *
 * Two rules govern every declaration here, and both are load-bearing:
 *
 *   1. Only the two requested surfaces are repainted. The document, the app
 *      frame, the root container and the content column are left exactly as the
 *      host painted them, so nothing outside the sidebar and the title row can
 *      change appearance. Auditing the live DOM reports four elements whose
 *      computed style differs, and all four are inside those two surfaces.
 *   2. No property that establishes a containing block. `filter`,
 *      `backdrop-filter`, `transform` and `contain` each re-anchor every
 *      `position: fixed` descendant to the element carrying them. The sidebar
 *      toggle is a fixed-position child of the sidebar column, so a
 *      `backdrop-filter` there silently drags the toggle down by the height of
 *      the title row and lands it on the brand mark. The frosted read therefore
 *      comes from the pane's own layer stack, never from a backdrop filter.
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
const VERSION = "0.2.1";

const ENABLED_FIELD = "enabled";
const OPACITY_FIELD = "opacity";
const TINT_FIELD = "tint";
const NOISE_FIELD = "noise";

const DEFAULT_ENABLED = true;

/** Percent of the host surface colour left in the panel fill. */
const DEFAULT_OPACITY = 62;
const OPACITY_MIN = 20;
const OPACITY_MAX = 92;

/**
 * Percent multiplier on the blooms' alpha: how much *tint* the panes carry.
 *
 * Windows Mica is a wallpaper-derived wash rather than a saturated gradient, so
 * the blooms are already weak at 100 and the useful range sits around 40-140.
 */
const DEFAULT_TINT = 100;
const TINT_MIN = 0;
const TINT_MAX = 200;

/** Opacity of the film grain laid over the two Mica surfaces. */
const DEFAULT_NOISE = 0.06;
const NOISE_MIN = 0;
const NOISE_MAX = 0.3;

/** Edge length of one grain tile, in px. */
const GRAIN_TILE = 160;

/**
 * The colour washes that tint the two panes.
 *
 * These are wide, weak and low-chroma on purpose. Mica is not acrylic: it does
 * not blur the content behind the pane, it lays a barely-there tint over it, so
 * a handful of broad washes reads far closer to the real thing than a strong
 * gradient does. Alpha is carried separately from the colour because
 * {@link paneLayers} scales it by the `tint` knob.
 *
 * Every wash is deliberately larger than the viewport and they overlap, so the
 * four of them sum to one continuous field rather than four corner glows. A
 * corner-anchored gradient that fades out well inside the panel looks like a
 * highlight; Mica looks like a whole surface that happens to be tinted, and
 * only overlapping washes give that. The field is viewport-anchored (see
 * {@link paneLayers}), so a narrow sidebar shows the left slice of one wallpaper
 * and the title row shows its top edge — the seam between them disappears.
 */
const BLOOMS = [
  { at: "4% 0%", size: "130% 118%", light: "138,166,228", dark: "92,124,214", alpha: 0.24 },
  { at: "100% 6%", size: "124% 112%", light: "168,156,226", dark: "122,102,204", alpha: 0.19 },
  { at: "80% 102%", size: "132% 120%", light: "140,186,220", dark: "56,128,182", alpha: 0.15 },
  { at: "0% 100%", size: "122% 116%", light: "182,174,234", dark: "100,90,180", alpha: 0.17 },
];

/**
 * Per-scheme values that are not part of the bloom set.
 *
 * The dark half rides `body[data-ds-dark-theme]`: the host's theme presenter
 * sets that attribute on every dark snapshot and removes it on every light one,
 * so it is a reliable hook that needs no cooperation from the theme service.
 */
const SCHEMES = {
  light: { sheen: "rgba(255,255,255,.42)" },
  dark: { sheen: "rgba(255,255,255,.05)" },
};

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
    tint: config[TINT_FIELD].get(),
    noise: config[NOISE_FIELD].get(),
  };
}

/** Alpha rounded to three places, so the emitted CSS is stable across runs. */
function alpha(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * The layer stack both panes are painted with.
 *
 * Order matters and reads bottom-up in the list: the first entry is the topmost
 * layer. Grain sits on top so it reads as being *inside* the pane, the sheen
 * below it so it reads as the pane's lit surface, and the washes below both so
 * they read as the tint the pane is made of.
 *
 * @param scheme `"light"` or `"dark"`.
 * @param tint Alpha multiplier from the `tint` knob, as a fraction.
 * @param grain A CSS `url(...)` value, or `"none"` when grain is switched off.
 * @returns A `background-image` value.
 */
function paneLayers(scheme, tint, grain) {
  const layers = [];
  if (grain !== "none") layers.push(grain);
  layers.push(`linear-gradient(180deg,${SCHEMES[scheme].sheen} 0%,transparent 46%)`);
  for (const bloom of BLOOMS) {
    const rgb = bloom[scheme];
    layers.push(`radial-gradient(${bloom.size} at ${bloom.at},`
      + `rgba(${rgb},${alpha(bloom.alpha * tint)}) 0%,rgba(${rgb},0) 100%)`);
  }
  return layers.join(",");
}

/**
 * Build the complete material stylesheet.
 *
 * @param settings Plain settings object from {@link readSettings}.
 * @returns CSS text in which every selector is gated on the root attribute.
 */
function materialCss(settings) {
  const scope = `html[${ROOT_ATTRIBUTE}="${ROOT_ON}"]`;
  const grain = grainImage(settings.noise);
  const tint = settings.tint / 100;
  // The fill is derived rather than hard-coded. Mixing the host's own surface
  // token means one declaration is right in light mode, in dark mode, and under
  // any third-party theme, with no per-scheme value to keep in sync.
  const fill = `color-mix(in srgb,var(--dsw-alias-bg-base) ${settings.opacity}%,transparent)`;

  const panes = (scheme, selectors) =>
    `${selectors}{background-color:${fill}!important;`
    + `background-image:${paneLayers(scheme, tint, grain)}!important;`
    // The field is anchored to the viewport rather than to each box. The title
    // row and the sidebar column are two slices of one continuous surface, but
    // their boxes are 36px and ~700px tall, so a percentage-sized gradient
    // resolves to a different shape in each and the two panes visibly disagree
    // at the seam. `fixed` makes both boxes sample the same field, so the seam
    // disappears and the noise keeps a single phase across it.
    + "background-attachment:fixed!important}";

  // The sidebar column and the Windows title row, and nothing else. Deliberately
  // absent: any rule touching `html`, `body`, `#root`, the app frame or the
  // content column. Those are what made the material leak into the conversation
  // area, and leaving them alone is what keeps the plugin's reach to the two
  // surfaces it was asked to paint.
  const lightPanes = `${scope} [class*="_sidebarCol"],`
    + `${scope}[data-windows-titlebar] [class*="_frame"]::before`;
  const darkPanes = `${scope} body[data-ds-dark-theme] [class*="_sidebarCol"],`
    + `${scope}[data-windows-titlebar] body[data-ds-dark-theme] [class*="_frame"]::before`;

  return [
    `/* ${STYLE_MARKER} ${VERSION} — Mica material for the sidebar and the title row. */`,
    "/* Generated from the live plugin config on every index render. */",
    "/* Every rule is gated on the root attribute, so the browser half can turn the */",
    "/* whole material off by flipping one attribute — no re-injection, no flash. */",
    "/* Only the sidebar column and the title row are repainted, and no rule here */",
    "/* sets filter/transform/contain, which would re-anchor fixed descendants. */",

    // 1. The material itself, once per scheme. Everything a pane needs — fill,
    //    tint, grain and sheen — is in these two rules.
    panes("light", lightPanes),
    panes("dark", darkPanes),

    // 2. The column's own children paint the host fill token again, on top of it:
    //    the sidebar's inner root carries `background:var(--dsw-specific-sidebar-fill)`,
    //    and that fill is opaque, so left alone it hides the material completely
    //    while the title row — which has no such child — shows it. Clearing the
    //    token on the column collapses the sidebar to a single painted layer, so
    //    one `opacity` reads identically on both surfaces.
    //
    //    Clearing the token rather than neutralising the elements that read it is
    //    deliberate: the inner root is a grandchild, not a child, of the column,
    //    so a child combinator misses it, while `[class*="_root"]` also matches
    //    `_9lTDKa_root`, `_root_4ub78_1`, `_root_38jqx_3` and friends all over the
    //    sidebar. Inheritance needs no selector and cannot be wrong about depth.
    `${scope} [class*="_sidebarCol"]{--dsw-specific-sidebar-fill:transparent}`,

    // 3. No edges. The two panes are meant to read as one continuous piece of
    //    material, so the hairlines this plugin used to draw along the sidebar's
    //    right side and under the title row are gone.
    //
    //    In the Windows shell that is the whole story: the host already ships
    //    `[data-windows-titlebar] .BynINW_sidebarCol{border-right:none}` and the
    //    title row has no border of its own. In a plain browser tab the host does
    //    draw `.5px solid var(--dsw-alias-border-l3)`, so its colour is cleared
    //    here too. Colour rather than `border-right:none` on purpose: keeping the
    //    0.5px box means switching the material off shifts nothing by a subpixel.
    `${scope} [class*="_sidebarCol"]{border-right-color:transparent}`,
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
  [TINT_FIELD]: Schema.number()
    .min(TINT_MIN)
    .max(TINT_MAX)
    .default(DEFAULT_TINT)
    .description("Percent multiplier on the colour tint the two panes carry.")
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
  Config,
  DEFAULT_ENABLED,
  DEFAULT_NOISE,
  DEFAULT_OPACITY,
  DEFAULT_TINT,
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
  TINT_FIELD,
  TINT_MAX,
  TINT_MIN,
  VERSION,
  apply,
  bootScript,
  grainImage,
  materialCss,
  micaInjections,
  paneLayers,
  readSettings,
};
