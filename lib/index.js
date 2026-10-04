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
 * The colour is the desktop wallpaper's, not this file's. Whenever a wallpaper
 * can be read, the pane is a composite of that wallpaper and the host's own
 * surface colour — which is exactly what DWM composites for real Mica — and the
 * bitmap is downscaled to a couple of hundred pixels and blurred before it is
 * inlined, so the whole sampled wallpaper costs about a kilobyte of the served
 * document. Nothing to read means the panes fall back to {@link BLOOMS}, a
 * painted field in the same palette, so a machine with no readable wallpaper
 * still gets a material rather than a flat fill.
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

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const VERSION = "0.4.0";

/**
 * Frame attribute that arms the collapse transition, written at pointerdown.
 *
 * The host intends the sidebar to glide: it ships
 * `.BynINW_frame[data-animating]{transition:grid-template-columns ...}` and sets
 * `data-animating` from a layout effect. But that effect runs *after* React has
 * committed the new track width, and a layout read in between forces the style
 * recalculation — so the declaration lands one recalc too late and the
 * transition never runs. Measured on the real instance: the column crosses its
 * whole range in 8ms.
 *
 * No rule can arm that from the far side of the commit, so the browser half
 * marks the frame itself, in a capture-phase listener that runs before React's.
 */
const COLLAPSE_ATTRIBUTE = "data-dsh-mica-collapse";
/** Selector for the host's sidebar toggle, which is what gets watched. */
const TOGGLE_SELECTOR = '[class*="_toggle"]';
/** Selector for the app frame, which is the element the grid track lives on. */
const FRAME_SELECTOR = '[class*="_frame"]';

/**
 * Duration of the collapse transition, in ms.
 *
 * Long enough to read as a glide rather than a jump; short enough to finish
 * inside the host's own 600ms safety timer, which drops `data-animating` on a
 * deadline whether or not the transition reported back.
 */
const COLLAPSE_DURATION = 460;
/** How long the arming attribute stays on the frame; must outlast the glide. */
const COLLAPSE_ARM_DURATION = 700;

const ENABLED_FIELD = "enabled";
const OPACITY_FIELD = "opacity";
const TINT_FIELD = "tint";
const NOISE_FIELD = "noise";
const WALLPAPER_FIELD = "wallpaper";
const WALLPAPER_PATH_FIELD = "wallpaperPath";

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

/** Whether the pane colour is sampled from the desktop wallpaper. */
const DEFAULT_WALLPAPER = true;
/** An explicit wallpaper file. Empty means "ask the platform". */
const DEFAULT_WALLPAPER_PATH = "";

/**
 * How the wallpaper is reduced before it is inlined.
 *
 * A 192x108 sample is roughly one pixel per 19 screen pixels on a 1920x1080
 * desktop, so the browser's own upscaling to viewport size does most of the
 * blurring and the blur applied here only has to hide the JPEG blocks that
 * `TranscodedWallpaper` carries. At WebP quality 80 that lands at about a
 * kilobyte, which is a fair price for a colour source that is real.
 */
const WALLPAPER_SAMPLE = { width: 192, height: 108 };
/** Gaussian blur radius, in px, applied at the sampled size. */
const WALLPAPER_BLUR = 6;
/** WebP quality of the sampled wallpaper. */
const WALLPAPER_QUALITY = 80;

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
 * Where the desktop keeps the wallpaper, most specific candidate first.
 *
 * Windows flattens whatever the user picked — a picture, the current frame of a
 * slideshow, a solid colour — into `TranscodedWallpaper`, a JPEG with no
 * extension, and that is the file the shell's own material is built from. macOS
 * is deliberately absent: a desktop picture there is recorded in a binary plist
 * of its own shape, and inventing a parser for it is not worth the code.
 * `wallpaperPath` covers that, and everything falls back to the painted field.
 *
 * @param options Candidate inputs, all overridable so tests touch no filesystem.
 * @returns Absolute paths to try, in order.
 */
function wallpaperCandidates(options = {}) {
  const {
    configured = DEFAULT_WALLPAPER_PATH,
    platform = process.platform,
    env = process.env,
  } = options;
  const files = [];
  if (configured) files.push(configured);
  if (platform === "win32" && env.APPDATA) {
    files.push(join(env.APPDATA, "Microsoft", "Windows", "Themes", "TranscodedWallpaper"));
  }
  return files;
}

/**
 * Identity of a wallpaper file, or `null` when there is nothing to sample.
 *
 * Size and modification time both take part, because a slideshow can swap in a
 * different image of exactly the same size while a resize can land inside the
 * same millisecond.
 *
 * @param file Candidate wallpaper file.
 * @returns An opaque identity string, or `null`.
 */
function wallpaperIdentity(file) {
  try {
    const stats = statSync(file);
    return stats.isFile() ? `${file}:${stats.mtimeMs}:${stats.size}` : null;
  } catch {
    return null;
  }
}

/**
 * Every directory from this module up to the filesystem root, nearest first.
 *
 * @param fromFile File URL of this module.
 * @returns Directories to start module resolution from.
 */
function ancestorDirectories(fromFile) {
  const directories = [];
  let directory = dirname(fileURLToPath(fromFile));
  for (;;) {
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
  }
}

/**
 * Directories to start `sharp` resolution from, best anchor first.
 *
 * Walking up from this module is not enough on its own. When a profile installs
 * a plugin from a local path, pnpm links it rather than copying it, Node resolves
 * the link, and this module's real path ends up somewhere no profile
 * `node_modules` will ever be found above — so the walk misses the host's own
 * copy of `sharp` and the material silently falls back. The profile is the one
 * anchor that holds for both layouts, which is why it goes first.
 *
 * @param options Anchors, all overridable so tests touch no real paths.
 * @returns Directories to resolve from.
 */
function sharpSearchRoots(options = {}) {
  const {
    fromFile = import.meta.url,
    env = process.env,
    cwd = process.cwd(),
  } = options;
  const roots = [];
  if (env.DSH_PROFILE_DIR) roots.push(env.DSH_PROFILE_DIR);
  roots.push(cwd);
  for (const directory of ancestorDirectories(fromFile)) {
    if (!roots.includes(directory)) roots.push(directory);
  }
  return roots;
}

/**
 * Load `sharp`, or `null` when this profile does not have it.
 *
 * `sharp` is not a dependency this plugin declares. It is a native module the
 * host already ships, and pulling a second copy of it into the profile to make a
 * one-kilobyte thumbnail would be rude; it is declared as an optional peer
 * dependency instead, resolved by hand so that a profile without it still
 * installs and still renders.
 *
 * @param options Resolution anchors; see {@link sharpSearchRoots}.
 * @returns The `sharp` function, or `null`.
 */
async function loadSharp(options = {}) {
  const fromFile = options.fromFile ?? import.meta.url;
  let resolved;
  try {
    resolved = createRequire(fromFile).resolve("sharp", { paths: sharpSearchRoots(options) });
  } catch {
    return null;
  }
  try {
    const module = await import(pathToFileURL(resolved).href);
    return module.default ?? module;
  } catch {
    return null;
  }
}

/**
 * Reduce a wallpaper file to a CSS value small enough to inline.
 *
 * @param sharp The loaded `sharp` function.
 * @param file Wallpaper file.
 * @returns A CSS `url(...)` value, or `null` when the file cannot be sampled.
 */
async function sampleWallpaper(sharp, file) {
  try {
    const buffer = await sharp(file)
      .resize(WALLPAPER_SAMPLE.width, WALLPAPER_SAMPLE.height, { fit: "cover", kernel: "lanczos3" })
      .blur(WALLPAPER_BLUR)
      .webp({ quality: WALLPAPER_QUALITY })
      .toBuffer();
    return `url("data:image/webp;base64,${buffer.toString("base64")}")`;
  } catch {
    return null;
  }
}

/**
 * A lazily refreshed sample of the current wallpaper.
 *
 * Sampling stays off the render path on purpose: `webserver/index-inject` is
 * synchronous, so it cannot wait for a decode. The first index render gets the
 * painted field, the sample lands a moment later, and the next page load gets
 * the wallpaper. Re-sampling is driven by the file's identity rather than a
 * clock, so an unchanged wallpaper costs one `stat` per render and nothing else.
 *
 * @param options Wiring, all overridable so the tests need no filesystem.
 * @returns `{ current, refresh }` — the last good sample and a re-check.
 */
function createWallpaperSource(options = {}) {
  const {
    fromFile = import.meta.url,
    load = loadSharp,
    sampler = sampleWallpaper,
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
  } = options;

  let image = null;
  let identity = null;
  let pending = false;

  const refresh = (configured) => {
    if (pending) return;
    const file = wallpaperCandidates({ configured, platform, env })
      .find((candidate) => wallpaperIdentity(candidate) !== null);
    const next = file === undefined ? null : wallpaperIdentity(file);
    if (next === identity) return;
    if (next === null) {
      // Nothing to sample. Forgetting the identity means a wallpaper that comes
      // back — a slideshow, a re-plugged drive — is picked up on the next render.
      identity = null;
      image = null;
      return;
    }
    identity = next;
    pending = true;
    load({ fromFile, env, cwd })
      .then((sharp) => (sharp === null ? null : sampler(sharp, file)))
      .then((sampled) => {
        image = sampled;
        // A failed sample must not look like a settled one, or a profile that
        // gains `sharp` later would keep the fallback until it is restarted.
        if (sampled === null) identity = null;
      })
      .catch(() => {
        image = null;
        identity = null;
      })
      .then(() => {
        pending = false;
      });
  };

  return { current: () => image, refresh };
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
    wallpaper: config[WALLPAPER_FIELD].get(),
    wallpaperPath: config[WALLPAPER_PATH_FIELD].get(),
  };
}

/** Alpha rounded to three places, so the emitted CSS is stable across runs. */
function alpha(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * The layer stack both panes are painted with.
 *
 * Order matters and reads top-down in the list: the first entry is the topmost
 * layer. Grain sits on top so it reads as being *inside* the pane, the sheen
 * below it so it reads as the pane's lit surface, and below both sits whatever
 * the pane's colour comes from.
 *
 * With a wallpaper, that colour source is the sampled wallpaper with the host's
 * own surface colour laid over it — wallpaper first, tint second, which is the
 * order DWM composites Mica in. It is also why a Mica pane never shows the
 * desktop through it: the wallpaper *is* the backdrop. With no wallpaper the
 * pane falls back to a painted field, and the same `opacity` knob that mutes the
 * wallpaper mutes the field, so the knob means one thing either way: how much of
 * the pane is the host's own surface colour rather than what the pane is made of.
 *
 * @param scheme `"light"` or `"dark"`.
 * @param options `{ fill, grain, tint, wallpaper }`.
 * @returns `{ image, size }` — two comma-separated CSS lists of equal length.
 */
function paneLayers(scheme, options) {
  const { fill, grain, tint, wallpaper } = options;
  const layers = [];
  const sizes = [];
  const add = (image, size) => {
    layers.push(image);
    sizes.push(size);
  };

  if (grain !== "none") add(grain, `${GRAIN_TILE}px ${GRAIN_TILE}px`);
  add(`linear-gradient(180deg,${SCHEMES[scheme].sheen} 0%,transparent 46%)`, "auto");

  if (wallpaper) {
    add(`linear-gradient(${fill},${fill})`, "auto");
    add(wallpaper, "cover");
  } else {
    for (const bloom of BLOOMS) {
      const rgb = bloom[scheme];
      add(
        `radial-gradient(${bloom.size} at ${bloom.at},`
        + `rgba(${rgb},${alpha(bloom.alpha * tint)}) 0%,rgba(${rgb},0) 100%)`,
        "auto",
      );
    }
  }

  return { image: layers.join(","), size: sizes.join(",") };
}

/**
 * Build the complete material stylesheet.
 *
 * @param settings Plain settings object from {@link readSettings}.
 * @param wallpaper A sampled wallpaper as a CSS `url(...)`, or `null`.
 * @returns CSS text in which every selector is gated on the root attribute.
 */
function materialCss(settings, wallpaper = null) {
  const scope = `html[${ROOT_ATTRIBUTE}="${ROOT_ON}"]`;
  const grain = grainImage(settings.noise);
  const tint = settings.tint / 100;
  // The fill is derived rather than hard-coded. Mixing the host's own surface
  // token means one declaration is right in light mode, in dark mode, and under
  // any third-party theme, with no per-scheme value to keep in sync.
  const fill = `color-mix(in srgb,var(--dsw-alias-bg-base) ${settings.opacity}%,transparent)`;

  const panes = (scheme, selectors) => {
    const layers = paneLayers(scheme, { fill, grain, tint, wallpaper });
    return `${selectors}{background-color:${fill}!important;`
      + `background-image:${layers.image}!important;`
      // Every layer carries its own size, so the list has to stay in step with
      // the layer list. The grain repeats at its natural size; the wallpaper
      // takes the viewport, for the reason `background-attachment` gives below.
      + `background-size:${layers.size}!important;`
      // The material is anchored to the viewport rather than to each box. The
      // title row and the sidebar column are two slices of one continuous
      // surface, but their boxes are 36px and ~700px tall, so a percentage-sized
      // field resolves to a different shape in each and the two panes visibly
      // disagree at the seam. `fixed` makes both boxes sample the same field —
      // and makes `cover` resolve against the viewport in both — so the seam
      // disappears and the noise keeps a single phase across it.
      + "background-attachment:fixed!important}";
  };

  // The colour source is recorded in the stylesheet because it is the one thing
  // about this plugin that cannot be seen from the CSS: whether the panes are
  // wearing the desktop's own wallpaper or the built-in fallback field.
  const source = wallpaper === null
    ? "/* Colour source: the painted fallback field — no wallpaper was readable. */"
    : "/* Colour source: the desktop wallpaper, sampled and blurred. */";

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
    "/* One rule reaches the app frame to arm the collapse transition; it paints */",
    "/* nothing and changes no track — it only says how a track change is drawn. */",
    source,

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

    // 4. The collapse glide the host asks for and never gets — see
    //    `COLLAPSE_ATTRIBUTE` for why it has to be armed from outside the frame.
    //
    //    Arming is deliberately keyed on states that are already true *before*
    //    the track changes: the right panel being closed, or the mark the browser
    //    half sets at pointerdown. Keying it on the host's `data-animating` is the
    //    obvious spelling and does nothing at all — that attribute arrives after
    //    the commit that changed the width, which is the whole bug.
    //
    //    Scoping it to those two states is also what keeps window resizing
    //    honest: with the right panel closed no track depends on the viewport, so
    //    nothing is transitional; with it open, neither key is present.
    `${scope} [class*="_frame"]:is([data-rightbar-collapsed],[${COLLAPSE_ATTRIBUTE}])`
      + `{transition:grid-template-columns ${COLLAPSE_DURATION}ms `
      + "var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}",

    //    ...but not while the sidebar handle is being dragged. There the track
    //    follows the pointer every frame and a transition would trail behind it.
    //    The host marks that state itself; the guard is repeated here because
    //    rule 4 outranks the host's own `[data-dragging]{transition:none}`.
    `${scope} [class*="_frame"][data-dragging]{transition:none}`,

    //    ...and not at all when the reader has asked for less motion.
    "@media (prefers-reduced-motion:reduce){"
      + `${scope} [class*="_frame"]:is([data-rightbar-collapsed],[${COLLAPSE_ATTRIBUTE}])`
      + "{transition:none}}",
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
 * @param wallpaper A sampled wallpaper as a CSS `url(...)`, or `null`.
 * @returns Row list for the `webserver/index-inject` table.
 */
function micaInjections(settings, wallpaper = null) {
  return [
    { kind: "style", text: materialCss(settings, wallpaper) },
    { kind: "script", placement: "body", text: bootScript(settings.enabled) },
  ];
}

/**
 * Live material settings.
 *
 * All of them are `volatile()` so the settings store treats them as live
 * references that the UI may rewrite, rather than as fixed schema values.
 * `enabled` is the only one the browser half exposes; the cosmetic knobs are
 * edited in `cordis.patch.yml` and take effect on the next page load.
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
    .description("Percent multiplier on the fallback tint. Ignored when a wallpaper is sampled.")
    .volatile(),
  [NOISE_FIELD]: Schema.number()
    .min(NOISE_MIN)
    .max(NOISE_MAX)
    .default(DEFAULT_NOISE)
    .description("Opacity of the film grain laid over the Mica surfaces.")
    .volatile(),
  [WALLPAPER_FIELD]: Schema.boolean()
    .default(DEFAULT_WALLPAPER)
    .description("Sample the pane colour from the desktop wallpaper.")
    .volatile(),
  [WALLPAPER_PATH_FIELD]: Schema.string()
    .default(DEFAULT_WALLPAPER_PATH)
    .description("Wallpaper file to sample, overriding the platform default.")
    .volatile(),
});

/**
 * Install the material.
 *
 * @param ctx Host plugin context.
 * @param config Validated live plugin config.
 * @param deps Overridable wallpaper source; cordis passes nothing here.
 */
function apply(ctx, config, deps = {}) {
  // The browser half draws its own Settings row, so the schema-generated page
  // for this plugin must be suppressed. Leaving it on would render a second,
  // uglier copy of the same switch.
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      `${STYLE_MARKER}: settings form policy`,
    );
  });

  // One sample is shared by every render. The first one cannot be ready in time
  // — the inject handler is synchronous and inline — so the opening render gets
  // the fallback field and the wallpaper arrives for the render after it.
  const wallpaper = deps.wallpaper ?? createWallpaperSource();

  ctx.on("webserver/index-inject", (table) => {
    const settings = readSettings(config);
    if (settings.wallpaper) wallpaper.refresh(settings.wallpaperPath);
    table.push(...micaInjections(settings, settings.wallpaper ? wallpaper.current() : null));
  }, { prepend: true });
}

export {
  Config,
  DEFAULT_ENABLED,
  DEFAULT_NOISE,
  DEFAULT_OPACITY,
  DEFAULT_TINT,
  DEFAULT_WALLPAPER,
  DEFAULT_WALLPAPER_PATH,
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
  WALLPAPER_FIELD,
  WALLPAPER_PATH_FIELD,
  WALLPAPER_SAMPLE,
  ancestorDirectories,
  apply,
  bootScript,
  createWallpaperSource,
  grainImage,
  loadSharp,
  materialCss,
  micaInjections,
  paneLayers,
  readSettings,
  sampleWallpaper,
  sharpSearchRoots,
  wallpaperCandidates,
  wallpaperIdentity,
};
