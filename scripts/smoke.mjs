#!/usr/bin/env node
/**
 * dsh-ui-mica — behavioural smoke test.
 *
 * A DSH plugin is normally only ever exercised by loading it into a running
 * harness, which makes "did I wire the settings row correctly" a question you
 * answer by restarting the app. This script answers it without a restart: it
 * evaluates both halves against stub contexts and asserts on what they actually
 * do — the attributes they set, the slots they register, the rows they inject.
 *
 * The stubs are deliberately dumb. `document` only remembers attributes,
 * `defineStore` returns its own config, and React is a five-line
 * `createElement`. That is enough because both halves touch a very small
 * surface, and it keeps this test honest about exactly which surface that is: if
 * the plugin ever starts reaching for something the shell does not guarantee,
 * these stubs stop satisfying it and the test fails.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failures = 0;

/**
 * Record the outcome of one assertion.
 *
 * @param condition Assertion result.
 * @param label What was being asserted.
 * @returns The condition, so callers can assert further.
 */
function check(condition, label) {
  if (condition) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${label}`);
  return false;
}

/**
 * Assert two values are deeply equal.
 *
 * @param actual Observed value.
 * @param expected Expected value.
 * @param label What was being asserted.
 */
function checkEqual(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    console.error(`        expected ${JSON.stringify(expected)}`);
    console.error(`        actual   ${JSON.stringify(actual)}`);
  }
  check(same, label);
}

/**
 * Locate the profile whose `node_modules` holds the Harness packages.
 *
 * @returns Absolute path to the profile directory.
 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "profiles", process.env.DSH_PROFILE || "desktop");
}

/**
 * Make `@deepseek-ai/schemastery` resolvable from this project.
 *
 * The host half imports it as a real dependency, but the only copy on a normal
 * machine lives in the profile, next to the harness that provides it. A junction
 * is enough to let Node resolve the bare specifier from here.
 */
function linkSchemastery() {
  const source = join(profileDir(), "node_modules", "@deepseek-ai", "schemastery");
  const scope = join(root, "node_modules", "@deepseek-ai");
  const target = join(scope, "schemastery");
  if (!existsSync(source)) {
    throw new Error(
      `@deepseek-ai/schemastery is not resolvable and no copy exists at ${source}.\n`
      + "Point DSH_PROFILE_DIR at the profile that holds the Harness packages.",
    );
  }
  mkdirSync(scope, { recursive: true });
  if (!existsSync(target)) symlinkSync(source, target, "junction");
}

/**
 * Import the host half, linking its one runtime dependency on first attempt.
 *
 * @returns The host half's exports.
 */
async function importHostHalf() {
  const entry = pathToFileURL(join(root, "lib/index.js")).href;
  try {
    return await import(entry);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !String(error?.message).includes("schemastery")) {
      throw error;
    }
    linkSchemastery();
    return import(entry);
  }
}

/**
 * A React stand-in whose elements are plain, walkable objects.
 *
 * @returns Object exposing `createElement`.
 */
function reactStub() {
  return {
    createElement(type, props, ...children) {
      const element = { type, props: { ...(props ?? {}) } };
      if (children.length === 1) element.props.children = children[0];
      else if (children.length > 1) element.props.children = children;
      return element;
    },
  };
}

/**
 * Load the browser half and capture what it registers.
 *
 * The half is a classic script whose only top-level act is to hand a definition
 * to `window.__ModuleLoader__.load`, so a fake window is the whole environment
 * it needs to load.
 *
 * @returns Captured definition plus the fake document it writes to.
 */
function loadClientHalf() {
  const attributes = new Map();
  const styleTags = [];
  const document = {
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      removeAttribute: (name) => attributes.delete(name),
    },
    head: { append: (tag) => styleTags.push(tag) },
    querySelector: () => null,
    createElement: (tagName) => ({ tagName, dataset: {}, textContent: "", remove: () => {} }),
  };

  let definition = null;
  const window = { __ModuleLoader__: { load: (next) => { definition = next; } } };
  const source = readFileSync(join(root, "lib/client.js"), "utf8");
  // eslint-disable-next-line no-new-func -- the shell evaluates this file the same way.
  new Function("window", "document", source)(window, document);

  return { attributes, definition, document, styleTags };
}

/**
 * Load the browser half's exports.
 *
 * @param definition Captured loader definition.
 * @returns The exported plugin face.
 */
function evaluateClientDefinition(definition) {
  const stubs = {
    "react": reactStub(),
    "react/jsx-runtime": {},
    "@deepseek-ai/dsh-client-store": { defineStore: (config) => config },
    "@deepseek-ai/dsh-client-ui-primitives": {},
  };
  const factoryRequire = (specifier) => {
    if (!Object.hasOwn(stubs, specifier)) throw new Error(`unexpected require: ${specifier}`);
    return stubs[specifier];
  };
  return definition.factory(factoryRequire);
}

/**
 * A config form stand-in that records writes and can publish new snapshots.
 *
 * @param initial Starting snapshot.
 * @returns Form stub.
 */
function makeForm(initial) {
  const listeners = new Set();
  const form = {
    published: [],
    setCalls: [],
    setImpl: null,
    getSnapshot: () => form.snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (field, value) => {
      form.setCalls.push({ field, value });
      if (form.setImpl) return form.setImpl(field, value);
      return Promise.resolve();
    },
    publish: (next) => {
      form.snapshot = next;
      form.published.push(next);
      for (const listener of listeners) listener();
    },
    snapshot: initial,
  };
  return form;
}

/**
 * A client plugin context stand-in.
 *
 * @param form The form `configForms.get` should hand back.
 * @param sink Collector for everything the plugin registers.
 * @returns Context stub.
 */
function makeClientContext(form, sink) {
  return {
    effect: (run) => {
      const dispose = run();
      sink.effects.push(dispose);
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    logger: { warn: (...args) => sink.warnings.push(args) },
    configForms: {
      get: (namespace) => {
        sink.formNamespaces.push(namespace);
        return form;
      },
    },
    locale: {
      register: (namespace, dictionaries) => {
        sink.locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject: (name, factory) => {
        sink.slotNames.push(name);
        sink.registration = factory();
        return () => {};
      },
      register: (config, component) => ({ config, component }),
    },
  };
}

console.log("browser half — loading");

const client = loadClientHalf();
check(client.definition !== null, "the half registers with the module loader");
check(client.definition?.id === "dsh-ui-mica", "the loader id is the package name");

const plugin = client.definition === null ? null : evaluateClientDefinition(client.definition);
check(typeof plugin?.apply === "function", "the half exports apply");
check(Array.isArray(plugin?.inject), "the half exports an inject list");
checkEqual(plugin?.inject, ["slots", "locale", "configForms"], "the half declares the services it needs");

console.log("browser half — applying it to a persisted 'off' switch");

const form = makeForm({ value: { enabled: false }, revision: 7 });
const sink = { effects: [], warnings: [], formNamespaces: [], locales: [], slotNames: [], registration: null };
const syncCalls = [];
const rowActions = { sync: (value, revision) => syncCalls.push({ value, revision }) };
plugin.apply(makeClientContext(form, sink));

checkEqual(sink.formNamespaces, ["ui-mica"], "it reads the ui-mica settings namespace");
checkEqual(client.attributes.get("data-dsh-mica"), "off", "a persisted 'off' keeps the material off");
check(client.styleTags.length === 1, "it installs exactly one stylesheet");
check(
  client.styleTags[0]?.dataset.pluginCss === "dsh-ui-mica/settings-general-row.css",
  "the stylesheet is tagged so it can be found and removed",
);
check(
  String(client.styleTags[0]?.textContent).includes("aria-checked"),
  "the row stylesheet drives the switch off aria-checked",
);
checkEqual(sink.slotNames, ["settings.general.item"], "it registers one row in Settings -> General");
checkEqual(sink.locales.map((entry) => entry.namespace), ["ui-mica"], "it registers its locale dictionary");
check(
  sink.locales[0]?.dictionaries?.zh?.title === "云母背景",
  "the dictionary carries the Chinese copy",
);
check(
  sink.locales[0]?.dictionaries?.en?.title === "Mica background",
  "the dictionary carries the English copy",
);

console.log("browser half — the registered row");

const registration = sink.registration;
check(registration?.config?.id === "dsh-ui-mica-enabled", "the row id is stable");
check(registration?.config?.locale === "ui-mica", "the row resolves copy through the plugin dictionary");
check(registration?.config?.order === 80, "the row sorts after the host's appearance and font rows");
check(registration?.config?.store !== undefined, "the row owns a store");
check(typeof registration?.component === "function", "the row has a component");

const rowProps = registration.config.inject(rowActions);
check(typeof rowProps?.save === "function", "inject hands the row a save action");
checkEqual(syncCalls.at(-1), { value: false, revision: 7 }, "the switch adopts the persisted state");

console.log("browser half — the switch");

/**
 * Render the row with a given store value.
 *
 * @param enabled Value the row's selector should observe.
 * @returns `{ tree, saved }` for assertions.
 */
function renderRow(enabled) {
  const saved = [];
  const tree = registration.component({
    useStore: (selector) => selector({ value: enabled, revision: 9 }),
    t: (key) => key,
    save: (value) => saved.push(value),
  });
  return { saved, tree };
}

const on = renderRow(true);
check(on.tree?.props?.className === "dsh-ui-mica-row", "the row uses the host row layout");
check(on.tree?.props?.children?.length === 2, "the row is a text block plus a control");
const switchOn = on.tree.props.children[1];
check(switchOn?.type === "button", "the control is a real button");
check(switchOn?.props?.role === "switch", "the control announces itself as a switch");
check(switchOn?.props?.["aria-checked"] === "true", "an on switch reports aria-checked=true");
check(
  switchOn?.props?.children?.props?.className === "dsh-ui-mica-thumb",
  "the switch has the host's capsule thumb",
);
check(switchOn?.props?.title === "stateOn", "the on switch says what a click will do");
switchOn.props.onClick();
checkEqual(on.saved, [false], "clicking an on switch asks to save false");

const off = renderRow(false);
const switchOff = off.tree.props.children[1];
check(switchOff?.props?.["aria-checked"] === "false", "an off switch reports aria-checked=false");
check(switchOff?.props?.title === "stateOff", "the off switch says what a click will do");
switchOff.props.onClick();
checkEqual(off.saved, [true], "clicking an off switch asks to save true");

console.log("browser half — turning it on");

form.publish({ value: { enabled: true }, revision: 8 });
checkEqual(client.attributes.get("data-dsh-mica"), "on", "a published 'on' turns the material on");
checkEqual(syncCalls.at(-1), { value: true, revision: 8 }, "the switch follows the published state");

console.log("browser half — saving");

rowProps.save(false);
await Promise.resolve();
checkEqual(form.setCalls.at(-1), { field: "enabled", value: false }, "save writes the enabled field");

form.setImpl = () => Promise.reject(new Error("disk on fire"));
rowProps.save(true);
await Promise.resolve();
await Promise.resolve();
check(sink.warnings.length === 1, "a rejected save is reported, not thrown");
check(sink.warnings[0]?.[0]?.includes("dsh-ui-mica"), "the warning names the plugin");

form.setImpl = () => {
  throw new Error("form is gone");
};
rowProps.save(true);
check(sink.warnings.length === 2, "a save that throws synchronously is reported too");
form.setImpl = null;

console.log("host half — config");

const host = await importHostHalf();
check(typeof host.apply === "function", "the host half exports apply");
check(typeof host.Config === "function", "the host half exports Config");

const defaults = host.readSettings(host.Config({}));
checkEqual(
  defaults,
  { enabled: true, opacity: 62, tint: 100, noise: 0.06, wallpaper: true, wallpaperPath: "" },
  "the schema defaults are the documented ones",
);

const tuned = host.readSettings(host.Config({
  enabled: false,
  opacity: 80,
  tint: 40,
  noise: 0.02,
  wallpaper: false,
  wallpaperPath: "C:/pictures/wall.jpg",
}));
checkEqual(
  tuned,
  { enabled: false, opacity: 80, tint: 40, noise: 0.02, wallpaper: false, wallpaperPath: "C:/pictures/wall.jpg" },
  "config values are read back verbatim",
);

let rejected = false;
try {
  host.Config({ opacity: 500 });
} catch {
  rejected = true;
}
check(rejected, "an out-of-range value is rejected by the schema");

console.log("host half — installing it");

/**
 * Build a stub host context that records everything `apply` does with it.
 *
 * @returns `{ ctx, sink }`.
 */
function stubHost() {
  const sink = { configured: [], effects: [], injected: [], listeners: [] };
  const ctx = {
    fiber: {},
    inject: (deps, callback) => {
      sink.injected.push(deps);
      callback({
        effect: (run, label) => {
          // Cordis runs an effect body immediately and keeps its return value as
          // the disposer; a stub that only recorded it would never observe the
          // configuration call the body is there to make.
          sink.effects.push(label);
          const dispose = run();
          return () => {
            if (typeof dispose === "function") dispose();
          };
        },
        settings: {
          configure: (options, fiber) => sink.configured.push({ options, fiber }),
        },
      });
    },
    on: (event, handler, options) => sink.listeners.push({ event, handler, options }),
  };
  return { ctx, sink };
}

// The wallpaper source is injected rather than discovered, so this test never
// reads the machine it runs on: a test that depended on the developer's own
// desktop picture would be a test that fails on somebody else's laptop.
const samples = [];
const stubWallpaper = {
  current: () => null,
  refresh: (configured) => samples.push(configured),
};

const { ctx: hostCtx, sink: hostSink } = stubHost();
host.apply(hostCtx, host.Config({}), { wallpaper: stubWallpaper });

checkEqual(hostSink.injected, [["settings"]], "it waits for the settings service");
checkEqual(hostSink.configured.map((entry) => entry.options), [{ auto: false }], "it suppresses the schema-generated settings page");
check(
  hostSink.configured[0]?.fiber !== undefined,
  "the suppression is scoped to this plugin's fiber",
);
checkEqual(
  hostSink.listeners.map((entry) => entry.event),
  ["webserver/index-inject"],
  "it injects into the served index",
);
check(hostSink.listeners[0]?.options?.prepend === true, "its rows are prepended, ahead of the boot payload");

console.log("host half — the injected rows");

const firstTable = [];
hostSink.listeners[0].handler(firstTable);
check(firstTable.length === 2, "one index render gets exactly two rows");
checkEqual(firstTable[0]?.kind, "style", "the first row is the stylesheet");
checkEqual(firstTable[1]?.kind, "script", "the second row is a script");
checkEqual(firstTable[1]?.placement, "body", "the script runs in the body, before the shell mounts");

const css = firstTable[0].text;
const script = firstTable[1].text;
checkEqual(samples, [""], "an index render asks for a fresh wallpaper sample");

console.log("host half — the stylesheet");

for (const [surface, needle] of Object.entries({
  "the sidebar column": '[class*="_sidebarCol"]',
  "the Windows title row": '[class*="_frame"]::before',
  "the Windows shell": "[data-windows-titlebar]",
  "the dark scheme": "body[data-ds-dark-theme]",
  "the derived panel fill": "background-color:color-mix(in srgb,var(--dsw-alias-bg-base)",
  "the host surface token": "var(--dsw-alias-bg-base)",
  "the film grain": "data:image/svg+xml,",
  "the viewport-anchored field": "background-attachment:fixed!important",
  "the single-layer fix for the sidebar": "--dsw-specific-sidebar-fill:transparent",
})) {
  check(css.includes(needle), `the stylesheet styles ${surface}`);
}

// The load-bearing property of the whole design: if any rule escaped the gate,
// switching the material off would leave a piece of it behind.
const stripped = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  // Unwrap at-rules so the rule inside a media query is judged by the same
  // gate as everything else, rather than the wrapper being read as a selector.
  .replace(/@media[^{]*\{/g, "");
const ungated = [];
const selectors = [];
const rules = [];
let ruleCount = 0;
for (const chunk of stripped.split("}")) {
  const trimmed = chunk.trim();
  if (trimmed === "") continue;
  const braceAt = trimmed.indexOf("{");
  if (braceAt <= 0) {
    ungated.push(trimmed);
    continue;
  }
  ruleCount += 1;
  const body = trimmed.slice(braceAt + 1);
  for (const selector of splitTopLevel(trimmed.slice(0, braceAt))) {
    const target = selector.trim();
    selectors.push(target);
    rules.push({ selector: target, body });
    if (!target.startsWith('html[data-dsh-mica="on"]')) ungated.push(target);
  }
}
check(ruleCount > 3, `the stylesheet has real rules (${ruleCount})`);
checkEqual(ungated, [], "every selector is gated on the root attribute");

// The two regressions that shipped in 0.1.0, pinned here so they cannot come back.
//
// 1. `backdrop-filter` on the sidebar column made that column a containing block
//    for `position: fixed` descendants. The sidebar toggle is the only fixed
//    element in the shell, so it stopped being anchored to the viewport and moved
//    down by the title row's height, landing on top of the brand logo. Mica does
//    not blur what is behind it either, so there is nothing to trade away here.
for (const trap of ["backdrop-filter", "filter:", "transform:", "contain:", "will-change", "perspective:"]) {
  check(!css.includes(trap), `the stylesheet avoids the containing-block trap "${trap}"`);
}

// 2. 0.1.0 also repainted `html`, `body`, `#root` and the whole app frame, which
//    tinted the conversation area. The material is allowed to reach exactly two
//    surfaces — the sidebar column and the title row — and nothing else.
check(!css.includes("_centerCol"), "the content column is never mentioned");
// The frame may be mentioned without `::before` for exactly one reason — to say
// how a track change is drawn, which is motion, not paint. Anything that reaches
// the frame and declares a real property is the 0.1.0 leak coming back.
for (const { selector, body } of rules) {
  if (!selector.includes("_frame") || selector.includes("::before")) continue;
  check(
    /^transition:[^;]*$/.test(body.trim()),
    `"${selector}" declares motion only (${body.trim()}), never paint`,
  );
}
check(
  !/body\s*\{/.test(stripped) && !/^html\s*\{/m.test(stripped),
  "the stylesheet never paints html or body themselves",
);
check(
  !css.includes("body{--dsw-specific-sidebar-fill"),
  "the host fill token is cleared on the sidebar column, not globally",
);

// The stylesheet is inlined into the document, so it must never be able to look
// like markup. The grain's angle brackets are percent-encoded for this reason.
check(!css.includes("<") && !css.includes(">"), "the stylesheet contains no markup characters");
check(!css.includes("</style"), "the stylesheet cannot close its own tag");

console.log("host half — the wallpaper");

/**
 * Split a comma-separated CSS list at top level only.
 *
 * Neither layer lists nor selector lists can be split on every comma.
 * `color-mix(in srgb,...)`, `rgba(...)` and `url("...")` carry commas of their
 * own, and so does `:is(a,b)` — splitting the latter naively invents a selector
 * that starts with a bare `[`, which then reads as an escape from the gate.
 *
 * @param value A CSS value list or selector list.
 * @returns Its top-level parts.
 */
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

const SAMPLE = 'url("data:image/webp;base64,AAAA")';
const withWallpaper = host.materialCss(defaults, SAMPLE);
const without = host.materialCss(defaults, null);

check(withWallpaper.includes(SAMPLE), "a sampled wallpaper reaches the stylesheet");
checkEqual(
  splitTopLevel(withWallpaper.match(/background-size:([^!]+)!important/)[1]).at(-1),
  "cover",
  "the wallpaper is sized to the viewport",
);
check(!withWallpaper.includes("radial-gradient"), "the painted field is dropped once there is a wallpaper");
check(
  withWallpaper.indexOf(SAMPLE) > withWallpaper.indexOf("linear-gradient(color-mix"),
  "the surface colour is laid over the wallpaper, which is the order DWM composites in",
);
check(
  withWallpaper.includes("desktop wallpaper, sampled and blurred"),
  "the stylesheet records that its colour came from the wallpaper",
);

check(!without.includes("data:image/webp"), "with no wallpaper the stylesheet carries no bitmap");
check(without.includes("radial-gradient"), "with no wallpaper the painted field is back");
check(without.includes("painted fallback field"), "and the stylesheet says which source it used");

// Every layer needs its own size, and a list shorter than the layer list makes
// the browser drop the whole declaration — silently, and only for the pane that
// has the mismatched count.
for (const [name, text] of [["wallpaper", withWallpaper], ["fallback", without]]) {
  const images = splitTopLevel(text.match(/background-image:([^!]+)!important/)[1]);
  const sizes = splitTopLevel(text.match(/background-size:([^!]+)!important/)[1]);
  check(
    images.length > 1 && images.length === sizes.length,
    `the ${name} stack carries one size per layer (${images.length})`,
  );
}

// The switch has to gate the sampler, not merely the stylesheet: a user who
// turns the wallpaper off is asking for their desktop picture not to be read.
const quiet = [];
const { ctx: offCtx, sink: offSink } = stubHost();
host.apply(offCtx, host.Config({ wallpaper: false, wallpaperPath: "C:/elsewhere.jpg" }), {
  wallpaper: { current: () => SAMPLE, refresh: (configured) => quiet.push(configured) },
});
const offTable = [];
offSink.listeners[0].handler(offTable);
checkEqual(quiet, [], "switching the wallpaper off stops the sampler being asked at all");
check(!offTable[0].text.includes("data:image/webp"), "and no wallpaper reaches the stylesheet");

console.log("host half — finding a wallpaper");

const appData = join("C:", "Users", "somebody", "AppData", "Roaming");
checkEqual(
  host.wallpaperCandidates({ platform: "win32", env: { APPDATA: appData } }),
  [join(appData, "Microsoft", "Windows", "Themes", "TranscodedWallpaper")],
  "on Windows the candidate is the file the shell flattens the wallpaper into",
);
checkEqual(
  host.wallpaperCandidates({ platform: "linux", env: { APPDATA: appData } }),
  [],
  "on a platform whose wallpaper this plugin cannot read there is no candidate",
);
checkEqual(
  host.wallpaperCandidates({ configured: "C:/mine.png", platform: "linux", env: {} }),
  ["C:/mine.png"],
  "an explicit wallpaper path is all it takes to sample one anyway",
);

const ancestors = host.ancestorDirectories(import.meta.url);
check(ancestors[0] === here, "sharp resolution starts at the plugin's own directory");
check(ancestors.at(-1) === dirname(ancestors.at(-1)), "…and walks up to the filesystem root");

// A profile that installs this plugin from a local path links it rather than
// copying it, and Node resolves that link — so this module's real path ends up
// outside the profile, and the walk above can never reach the host's `sharp`.
// The profile the host exports is the anchor that holds for both layouts.
const roots = host.sharpSearchRoots({
  fromFile: import.meta.url,
  env: { DSH_PROFILE_DIR: "C:/profile" },
  cwd: "C:/cwd",
});
checkEqual(roots[0], "C:/profile", "sharp is looked for in the profile the host exported, ahead of anywhere else");
checkEqual(roots[1], "C:/cwd", "then in the directory the process was started from");
check(roots.includes(here), "and along this module's own ancestors as the last resort");
checkEqual(
  host.sharpSearchRoots({ fromFile: import.meta.url, env: {}, cwd: here }).filter((each) => each === here).length,
  1,
  "an anchor that is also an ancestor is searched once, not twice",
);

console.log("host half — sampling it");

/** Let the sampler's promise chain run to completion. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// Any file that exists will do: this test is about when the sampler is asked,
// not about what it makes of a picture.
const fixture = join(root, "README.md");
const sampled = [];
const source = host.createWallpaperSource({
  platform: "linux",
  env: {},
  load: async () => ({ pretend: "sharp" }),
  sampler: async (sharp, file) => {
    sampled.push(file);
    return SAMPLE;
  },
});

source.refresh(fixture);
checkEqual(source.current(), null, "the render that starts a sample gets the fallback, not half a picture");
await settle();
checkEqual(source.current(), SAMPLE, "the sample is there for the render after it");
checkEqual(sampled, [fixture], "the sampler is handed the file that was found");

source.refresh(fixture);
await settle();
checkEqual(sampled.length, 1, "an unchanged wallpaper is never re-sampled");
source.refresh("");
checkEqual(source.current(), null, "a wallpaper that goes away is forgotten");

const absent = host.createWallpaperSource({
  platform: "linux",
  env: {},
  load: async () => ({ pretend: "sharp" }),
  sampler: async () => SAMPLE,
});
absent.refresh(join(root, "no-such-wallpaper.jpg"));
checkEqual(absent.current(), null, "a wallpaper file that is not there is never sampled");

const sharpLess = host.createWallpaperSource({
  platform: "linux",
  env: {},
  load: async () => null,
  sampler: async () => SAMPLE,
});
sharpLess.refresh(fixture);
await settle();
checkEqual(sharpLess.current(), null, "a profile without sharp falls back instead of failing");

const broken = host.createWallpaperSource({
  platform: "linux",
  env: {},
  load: async () => ({ pretend: "sharp" }),
  sampler: async () => { throw new Error("truncated jpeg"); },
});
broken.refresh(fixture);
await settle();
checkEqual(broken.current(), null, "a wallpaper that cannot be decoded falls back too");

// The regression that a linked install exposed: the anchors have to reach the
// loader, or resolution silently searches a tree that holds no `node_modules`.
const anchors = [];
const anchored = host.createWallpaperSource({
  platform: "linux",
  env: { DSH_PROFILE_DIR: "C:/profile" },
  cwd: "C:/cwd",
  load: async (options) => {
    anchors.push(options);
    return null;
  },
  sampler: async () => SAMPLE,
});
anchored.refresh(fixture);
await settle();
checkEqual(anchors.length, 1, "sharp is loaded once per sample");
checkEqual(anchors[0].env.DSH_PROFILE_DIR, "C:/profile", "the loader is handed the profile, not just this module's path");
checkEqual(anchors[0].cwd, "C:/cwd", "the loader is handed the process directory too");
check(String(anchors[0].fromFile).startsWith("file:"), "the loader is handed this module's own location as the anchor of last resort");

console.log("host half — the pre-mount stamp");

check(script.includes('setAttribute("data-dsh-mica","on")'), "the stamp turns the material on");
check(
  host.micaInjections({ ...defaults, enabled: false })[1].text.includes('setAttribute("data-dsh-mica","off")'),
  "the stamp honours a persisted 'off'",
);

// Turning the material off must not change the stylesheet at all: the switch is
// an attribute flip, so nothing is rewritten and nothing can flash.
checkEqual(
  host.micaInjections({ ...defaults, enabled: false })[0].text,
  host.micaInjections({ ...defaults, enabled: true })[0].text,
  "the switch never rewrites the stylesheet",
);

console.log("host half — tuning");

const soft = host.micaInjections({ ...defaults, opacity: 30, noise: 0 })[0].text;
check(soft.includes("color-mix(in srgb,var(--dsw-alias-bg-base) 30%,transparent)"), "the opacity knob reaches the fill");
check(!soft.includes("data:image/svg+xml,"), "a zero noise knob drops the grain layer entirely");

const untinted = host.micaInjections({ ...defaults, tint: 0 })[0].text;
check(untinted.includes("rgba(138,166,228,0)"), "a zero tint knob drops every wash to zero alpha");
const doubleTint = host.micaInjections({ ...defaults, tint: 200 })[0].text;
check(doubleTint.includes("rgba(138,166,228,0.48)"), "the tint knob scales every wash");

const secondTable = [];
hostSink.listeners[0].handler(secondTable);
check(secondTable !== firstTable && secondTable.length === 2, "every index render gets a fresh table");

console.log(
  failures === 0
    ? "\nsmoke: 0 failure(s) — both halves behave"
    : `\nsmoke: ${failures} failure(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;

