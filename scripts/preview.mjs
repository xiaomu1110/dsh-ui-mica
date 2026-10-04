#!/usr/bin/env node
/**
 * dsh-ui-mica — offline preview.
 *
 * A UI plugin is the one kind of plugin you cannot trust a unit test about: the
 * smoke test can prove every selector is gated on the root attribute, but not
 * that the result looks like Mica rather than like a grey rectangle. Checking
 * that normally means installing the plugin and restarting the harness.
 *
 * This script removes the restart from the loop. It generates the exact
 * stylesheet the host half injects, drops it into a page that reproduces the
 * host's own AppFrame and sidebar markup and module CSS, and writes the result
 * to `preview/`. Open one of those files, or screenshot it headlessly, and you
 * are looking at the real material against the real host geometry.
 *
 * The host CSS below is transcribed from the host's own CSS modules
 * (`dsh-client-ui-layout/AppFrame.module.css` and
 * `dsh-client-ui-sidebar/...`). It is preview scaffolding, not shipped code, so
 * it only needs to be faithful in the parts the material touches: the class
 * names, the fill token each surface paints, and the frame geometry.
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "preview");

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
 */
function linkSchemastery() {
  const source = join(profileDir(), "node_modules", "@deepseek-ai", "schemastery");
  const scope = join(root, "node_modules", "@deepseek-ai");
  const target = join(scope, "schemastery");
  if (!existsSync(source)) {
    throw new Error(`no @deepseek-ai/schemastery at ${source}; set DSH_PROFILE_DIR`);
  }
  mkdirSync(scope, { recursive: true });
  if (!existsSync(target)) symlinkSync(source, target, "junction");
}

/**
 * Import the host half, linking its dependency on first attempt.
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

const host = await importHostHalf();

/**
 * Host module CSS, transcribed.
 *
 * The two hash prefixes are the ones the installed build happens to use; the
 * material never refers to them, which is the point of matching on the stable
 * `_frame` / `_sidebarCol` / `_centerCol` / `_root` suffixes instead.
 */
const HOST_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
#root{height:100%}

/* dsh-client-ui-layout / AppFrame.module.css */
.BynINW_frame{background:var(--dsw-alias-bg-base);grid-template-rows:100%;height:100%;display:grid;position:relative;overflow:hidden}
.BynINW_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}
.BynINW_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}
.BynINW_frame{grid-template-columns:280px minmax(0,1fr)}
[data-windows-titlebar] .BynINW_frame{--dsh-windows-content-radius:16px;box-sizing:border-box;padding-top:var(--dsh-windows-titlebar-height);background:var(--dsw-specific-sidebar-fill);grid-template-rows:minmax(0,1fr)}
[data-windows-titlebar] .BynINW_centerCol{background:var(--dsw-alias-bg-base);border-radius:var(--dsh-windows-content-radius) 0 0 0;corner-shape:round}
[data-windows-titlebar] .BynINW_frame:before{content:"";height:var(--dsh-windows-titlebar-height);background:var(--dsw-specific-sidebar-fill);-webkit-app-region:drag;position:absolute;inset:0 0 auto}
[data-windows-titlebar] .BynINW_sidebarCol{border-right:none}
html[data-windows-titlebar]{--dsh-frame-top-clearance:var(--dsh-windows-titlebar-height)}

/* dsh-client-ui-sidebar */
._2H3hWW_root{--dsh-sidebar-inline-padding:12px;height:100%;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);flex-direction:column;font-size:14px;display:flex}

/* preview-only chrome for the sample content */
.navTitle{padding:10px 8px 6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.navItem{padding:7px 8px;border-radius:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.navItem.active{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))}
.brand{display:flex;align-items:center;gap:8px;padding:8px;font-weight:600}
.brand .dot{width:18px;height:18px;border-radius:6px;background:var(--dsw-alias-brand-primary,#4d6bfe)}
.newSession{margin:8px;padding:8px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.chrome{height:36px;display:flex;align-items:center;padding:0 14px;color:var(--dsw-alias-label-secondary);font-size:13px}
.doc{padding:28px 36px;max-width:760px;line-height:1.75;font-size:14px}
.doc h1{font-size:22px;margin:0 0 4px}
.doc p{color:var(--dsw-alias-label-secondary);margin:12px 0}
.doc code{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.14));padding:1px 5px;border-radius:5px}
`;

/**
 * Body-level token values, as the host's theme presenter writes them: inline
 * custom properties on `<body>`, with no `!important`. The material has to win
 * against these from a stylesheet, which is why the preview sets them here
 * rather than in a rule.
 */
const TOKENS = {
  light: [
    "--dsw-alias-bg-base:#ffffff",
    "--dsw-specific-sidebar-fill:#f5f6f8",
    "--dsw-alias-border-l3:#e5e7eb",
    "--dsw-alias-border-l2:#eef0f3",
    "--dsw-alias-label-primary:#0f172a",
    "--dsw-alias-label-secondary:#475569",
    "--dsw-alias-label-tertiary:#94a3b8",
    "--dsw-alias-brand-primary:#4d6bfe",
    "--dsw-alias-interactive-bg-hover:rgba(15,23,42,.06)",
    "--dsw-alias-bg-module-platform:rgba(15,23,42,.06)",
  ].join(";"),
  dark: [
    "--dsw-alias-bg-base:#151517",
    "--dsw-specific-sidebar-fill:#1c1c1f",
    "--dsw-alias-border-l3:#2a2a2e",
    "--dsw-alias-border-l2:#242427",
    "--dsw-alias-label-primary:#f5f5f6",
    "--dsw-alias-label-secondary:#a1a1aa",
    "--dsw-alias-label-tertiary:#71717a",
    "--dsw-alias-brand-primary:#6b83ff",
    "--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08)",
    "--dsw-alias-bg-module-platform:rgba(255,255,255,.08)",
  ].join(";"),
};

/**
 * The host markup the material attaches to.
 *
 * @param windows Whether to reproduce the Windows Electron shell, which is the
 *   only case that has a title row.
 * @returns Frame markup.
 */
function frameMarkup(windows) {
  const chrome = windows
    ? '<div class="chrome" style="padding-left:76px">DeepSeek Harness — 云母背景插件预览</div>'
    : "";
  return `
<div class="BynINW_frame">
  <div class="BynINW_sidebarCol">
    <div class="_2H3hWW_root">
      ${windows ? "" : '<div class="chrome">DeepSeek Harness</div>'}
      <div class="brand"><span class="dot"></span>DeepSeek Harness</div>
      <div class="newSession">＋ 新建会话</div>
      <div class="navTitle">最近</div>
      <div class="navItem active">云母背景插件</div>
      <div class="navItem">侧边栏毛玻璃方案</div>
      <div class="navItem">顶部栏标题行对齐</div>
      <div class="navItem">通用设置开关按钮</div>
      <div class="navItem">插件打包与发布</div>
    </div>
  </div>
  <div class="BynINW_centerCol">
    ${chrome}
    <div class="doc">
      <h1>云母背景</h1>
      <p>侧边栏与顶部栏现在使用云母（Mica）材质背景：半透明的面板叠在带色彩光晕的底景之上，
      面板本身再覆盖一层细微颗粒与顶部高光，从而得到毛玻璃的观感。</p>
      <p>正文所在的中间栏保持不透明，因此在任何配色下都保持可读性——面板可以透明，文字不可以。</p>
      <p>面板的填充色由 <code>color-mix()</code> 从宿主的 <code>--dsw-alias-bg-base</code> 推导，
      所以浅色、深色与第三方主题都能自动适配，不需要为每种配色单独写值。</p>
      <p>下方这段文字用于检查对比度与行距：云母材质的重点是让界面有层次，而不是让文字变得难以辨认。
      如果你能看清这一行，那么默认的 62% 面板不透明度就是合适的。</p>
    </div>
  </div>
</div>`;
}

/**
 * Write one preview page.
 *
 * @param name Output file basename.
 * @param options Page options.
 * @param options.windows Reproduce the Windows Electron shell.
 * @param options.scheme `light` or `dark`.
 * @param options.settings Material settings to generate the stylesheet from.
 */
function writePage(name, { windows, scheme, settings }) {
  const css = host.materialCss(settings);
  const bodyAttributes = [
    `style="${TOKENS[scheme]}"`,
    scheme === "dark" ? "data-ds-dark-theme" : "",
  ].filter(Boolean).join(" ");
  const htmlAttributes = [
    `data-dsh-mica="${settings.enabled ? "on" : "off"}"`,
    windows ? "data-windows-titlebar" : "",
    windows ? 'style="--dsh-windows-titlebar-height:36px"' : "",
  ].filter(Boolean).join(" ");

  const page = `<!doctype html>
<html lang="zh-CN" ${htmlAttributes}>
<head>
<meta charset="utf-8">
<title>${name} — dsh-ui-mica preview</title>
<style>${HOST_CSS}</style>
<!-- Exactly what the host half pushes into the served index. -->
<style data-plugin="dsh-ui-mica" data-plugin-css="preview">${css}</style>
</head>
<body ${bodyAttributes}>
<div id="root">${frameMarkup(windows)}</div>
<script>
// The same attribute flip the browser half performs, so the off state can be
// checked without opening devtools.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'm') return;
  const html = document.documentElement;
  html.setAttribute('data-dsh-mica', html.getAttribute('data-dsh-mica') === 'on' ? 'off' : 'on');
});
</script>
</body>
</html>
`;

  writeFileSync(join(out, `${name}.html`), page, "utf8");
  return `${name}.html`;
}

mkdirSync(out, { recursive: true });

const defaults = host.readSettings(host.Config({}));
const written = [];
for (const scheme of ["light", "dark"]) {
  // The Windows Electron shell is the one that has a title row, so it is the
  // case worth looking at first; the plain-browser geometry is checked next.
  written.push(writePage(`desktop-${scheme}`, { windows: true, scheme, settings: defaults }));
  written.push(writePage(`browser-${scheme}`, { windows: false, scheme, settings: defaults }));
}
written.push(writePage("desktop-light-off", {
  windows: true,
  scheme: "light",
  settings: { ...defaults, enabled: false },
}));

console.log(`preview: wrote ${written.length} page(s) to ${out}`);
for (const file of written) console.log(`  ${file}`);
console.log("\nOpen them, or screenshot them headlessly:");
console.log('  msedge --headless=new --disable-gpu --window-size=1280,760 '
  + `--screenshot="preview/shot.png" "preview/${written[0]}"`);
