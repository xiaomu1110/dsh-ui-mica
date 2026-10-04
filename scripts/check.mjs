#!/usr/bin/env node
/**
 * dsh-ui-mica — static bundle invariants.
 *
 * These are the checks the upstream build script performs for a plugin that is
 * compiled from TSX. This plugin ships the two halves as plain JS instead, so
 * nothing would catch a broken bundle at build time; this script is that
 * missing build step, and it runs in CI and before every push.
 *
 * It is intentionally dependency-free and does not import the plugin: see
 * `scripts/smoke.mjs` for the half that actually runs the code.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * The only specifiers the shell is guaranteed to have bundled. A third-party
 * browser half may `require` these and nothing else.
 */
const ALLOWED_REQUIRES = new Set([
  "react",
  "react/jsx-runtime",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-primitives",
]);

/** Packages a third-party plugin must not depend on, whatever the allowlist says. */
const FORBIDDEN_REQUIRES = [
  "react/jsx-dev-runtime",
  "@deepseek-ai/dsh-client-ui-primitives",
];

let failures = 0;

/**
 * Record the outcome of one assertion.
 *
 * @param condition Assertion result.
 * @param label What was being asserted.
 * @returns The condition, so callers can chain.
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
 * Read a project file.
 *
 * @param relative Path relative to the project root.
 * @returns File contents.
 */
function read(relative) {
  return readFile(join(root, relative), "utf8");
}

const pkg = JSON.parse(await read("package.json"));
const client = await read("lib/client.js");
const host = await read("lib/index.js");
const patch = await read("cordis.patch.yml");

console.log("package.json");

check(pkg.name === "dsh-ui-mica", "package name is dsh-ui-mica");
check(pkg.type === "module", "package is ESM, so the host half loads as a module");
check(pkg.main === "lib/index.js", "main points at the host half");
check(pkg.exports?.["."] === "./lib/index.js", "exports['.'] points at the host half");
check(pkg.exports?.["./client"] === "./lib/client.js", "exports['./client'] points at the browser half");
check(typeof pkg.engines?.node === "string", "engines.node is declared");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch points at the patch layer");
check(pkg.dsh?.client?.platform === "web", "dsh.client.platform is web");
check(
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
  "dsh.client.inject lists the client packages bundled into the shell",
);
check(
  pkg.files?.includes("cordis.patch.yml") && pkg.files?.includes("lib"),
  "files ships lib and the patch layer",
);
check(pkg.license === "MIT", "license is MIT");

console.log("files");

for (const file of [
  "lib/index.js",
  "lib/client.js",
  "cordis.patch.yml",
  "README.md",
  "README.zh.md",
  "LICENSE",
  ".gitignore",
]) {
  check(existsSync(join(root, file)), `${file} exists`);
}

console.log("cordis.patch.yml");

// The row id is not decoration: it is the namespace the browser half reads
// through `configForms`, and the namespace the host half's switch writes into.
// A rename on either side silently detaches the Settings row from the material.
const namespace = client.match(/NAMESPACE = "([^"]+)"/)?.[1];
check(typeof namespace === "string" && namespace.length > 0, "the row id is the namespace the browser half reads");
check(patch.includes(`- id: ${namespace}`), `patch layer inserts the ${namespace} row`);
check(patch.includes("name: dsh-ui-mica"), "patch layer row names this package");

// Comments are stripped first: the patch layer ships a long explanation, and an
// uncommented stray line there would change what the profile actually loads.
const patchBody = patch
  .replace(/^#.*$/gm, "")
  .split("\n")
  .map((line) => line.trimEnd())
  .filter((line) => line.trim() !== "");
check(
  JSON.stringify(patchBody) === JSON.stringify(["- insert:", `    - id: ${namespace}`, "      name: dsh-ui-mica"]),
  "the only live instruction in the patch layer is the one insert row",
);

console.log("lib/client.js");

// Parse the browser half. This catches a syntax error without executing the
// file, which is all a build step would have done for a hand-written bundle.
try {
  // eslint-disable-next-line no-new-func -- parse-only, never called.
  new Function("window", "require", "module", "exports", client);
  check(true, "the browser half parses");
} catch (error) {
  check(false, `the browser half parses (${error.message})`);
}

check(
  client.includes("window.__ModuleLoader__.load("),
  "the browser half registers through window.__ModuleLoader__.load",
);
check(
  /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: "dsh-ui-mica"/.test(client),
  "the loader id is the package name",
);
check(client.includes("module.exports"), "the browser half sets module.exports");
check(
  /module\.exports = \{ apply, inject \}/.test(client),
  "the browser half exports apply and inject",
);
check(client.includes('var inject = ["slots", "locale", "configForms"]'), "inject lists the services it needs");

const requires = [...client.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
check(requires.length > 0, "the browser half requires something");
for (const specifier of new Set(requires)) {
  check(
    ALLOWED_REQUIRES.has(specifier),
    `require("${specifier}") is on the shell allowlist`,
  );
}
for (const specifier of FORBIDDEN_REQUIRES) {
  check(
    !requires.includes(specifier),
    `the browser half does not require ${specifier}`,
  );
}
check(
  !/react\/jsx-dev-runtime/.test(client),
  "no React development runtime is referenced",
);
check(
  !/\bfrom ["']/.test(client),
  "the browser half uses no import statements",
);

// The plugin owns one document attribute and one <style> tag; both are named so
// a bug report can be traced back to this package.
check(client.includes('ROOT_ATTRIBUTE = "data-dsh-mica"'), "the root attribute is data-dsh-mica");
check(
  /NAMESPACE = "ui-mica"/.test(client) && /NAMESPACE = "ui-mica"/.test(host),
  "both halves agree on the settings namespace",
);
check(
  host.match(/ROOT_ATTRIBUTE = "data-dsh-mica"/) !== null,
  "both halves agree on the root attribute",
);

console.log("lib/index.js");

check(host.includes('from "@deepseek-ai/schemastery"'), "the host half imports schemastery");
check(/export \{\s*\n?\s*[A-Za-z]/.test(host) || host.includes("export {"), "the host half uses ESM exports");
check(/\bConfig,\n/.test(host), "the host half exports Config");
check(/\bapply,\n/.test(host), "the host half exports apply");
check(
  host.includes('ctx.on("webserver/index-inject"'),
  "the host half injects into the served index",
);
check(
  !host.match(/document\.(querySelector|createElement|body)/),
  "the host half never touches the DOM",
);

console.log(
  failures === 0
    ? `\ncheck: ${failures} failure(s) — all invariants hold`
    : `\ncheck: ${failures} failure(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
