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
checkEqual(defaults, { enabled: true, opacity: 62, blur: 30, noise: 0.06 }, "the schema defaults are the documented ones");

const tuned = host.readSettings(host.Config({ enabled: false, opacity: 80, blur: 12, noise: 0.02 }));
checkEqual(tuned, { enabled: false, opacity: 80, blur: 12, noise: 0.02 }, "config values are read back verbatim");

let rejected = false;
try {
  host.Config({ opacity: 500 });
} catch {
  rejected = true;
}
check(rejected, "an out-of-range value is rejected by the schema");

console.log("host half — installing it");

const hostSink = { configured: [], effects: [], injected: [], listeners: [] };
host.apply({
  fiber: {},
  inject: (deps, callback) => {
    hostSink.injected.push(deps);
    callback({
      effect: (run, label) => {
        // Cordis runs an effect body immediately and keeps its return value as
        // the disposer; a stub that only recorded it would never observe the
        // configuration call the body is there to make.
        hostSink.effects.push(label);
        const dispose = run();
        return () => {
          if (typeof dispose === "function") dispose();
        };
      },
      settings: {
        configure: (options, fiber) => hostSink.configured.push({ options, fiber }),
      },
    });
  },
  on: (event, handler, options) => hostSink.listeners.push({ event, handler, options }),
}, host.Config({}));

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

console.log("host half — the stylesheet");

for (const [surface, needle] of Object.entries({
  "the sidebar column": '[class*="_sidebarCol"]',
  "the Windows title row": '[class*="_frame"]::before',
  "the opaque content column": '[class*="_centerCol"]',
  "the app frame": '[class*="_frame"]',
  "the Windows shell": "[data-windows-titlebar]",
  "the dark scheme": "body[data-ds-dark-theme]",
  "the frosted blur": "backdrop-filter:blur(",
  "the derived panel fill": "--dsw-specific-sidebar-fill:color-mix(in srgb,",
  "the host surface token": "var(--dsw-alias-bg-base)",
  "the film grain": "data:image/svg+xml,",
  "the sidebar's single-layer fix": '[class*="_sidebarCol"] [class*="_root"]',
})) {
  check(css.includes(needle), `the stylesheet styles ${surface}`);
}

// The load-bearing property of the whole design: if any rule escaped the gate,
// switching the material off would leave a piece of it behind.
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
const ungated = [];
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
  for (const selector of trimmed.slice(0, braceAt).split(",")) {
    const target = selector.trim();
    if (!target.startsWith('html[data-dsh-mica="on"]')) ungated.push(target);
  }
}
check(ruleCount > 10, `the stylesheet has real rules (${ruleCount})`);
checkEqual(ungated, [], "every selector is gated on the root attribute");

// The stylesheet is inlined into the document, so it must never be able to look
// like markup. The grain's angle brackets are percent-encoded for this reason.
check(!css.includes("<") && !css.includes(">"), "the stylesheet contains no markup characters");
check(!css.includes("</style"), "the stylesheet cannot close its own tag");

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

const soft = host.micaInjections({ ...defaults, opacity: 30, blur: 0, noise: 0 })[0].text;
check(soft.includes("color-mix(in srgb,var(--dsw-alias-bg-base) 30%,transparent)"), "the opacity knob reaches the fill");
check(soft.includes("blur(0px)"), "the blur knob reaches the backdrop filter");
check(!soft.includes("data:image/svg+xml,"), "a zero noise knob drops the grain layer entirely");

const secondTable = [];
hostSink.listeners[0].handler(secondTable);
check(secondTable !== firstTable && secondTable.length === 2, "every index render gets a fresh table");

console.log(
  failures === 0
    ? "\nsmoke: 0 failure(s) — both halves behave"
    : `\nsmoke: ${failures} failure(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
