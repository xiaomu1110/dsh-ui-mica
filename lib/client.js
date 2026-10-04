/**
 * dsh-ui-mica — browser half.
 *
 * Deliberately thin. The material itself is injected by the host half, so all
 * this half has to do is
 *
 *   1. keep `html[data-dsh-mica="on|off"]` in step with the persisted switch,
 *      which turns the material on and off instantly — the stylesheet is
 *      already in the document and needs no re-injection, and
 *   2. draw the switch itself, as one row in Settings -> General.
 *
 * Loading rules this file has to obey:
 *
 *   - It is fetched as a classic script and evaluated through
 *     `window.__ModuleLoader__.load`, so it must hand back CommonJS exports
 *     exposing `apply` and `inject`.
 *   - Only the four specifiers the shell already bundles may be `require`d.
 *     `scripts/check.mjs` enforces the allowlist.
 *   - It must not require `@deepseek-ai/dsh-client-ui-primitives`, or any other
 *     Harness client package. A third-party plugin draws its own controls and
 *     aligns them with the `--dsw-*` theme tokens instead, which is why the
 *     switch below is hand-built but token-for-token identical to the host's.
 */

window.__ModuleLoader__.load({
  id: "dsh-ui-mica",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var dshStore = require("@deepseek-ai/dsh-client-store");

    /** Settings namespace. Must equal the cordis row id in `cordis.patch.yml`. */
    var NAMESPACE = "ui-mica";
    /** Marks every node and every declaration this half owns. */
    var STYLE_MARKER = "dsh-ui-mica";
    /** Document attribute the host half gates the material on. */
    var ROOT_ATTRIBUTE = "data-dsh-mica";
    var ROOT_ON = "on";
    var ROOT_OFF = "off";
    /** The one config field this half exposes. */
    var ENABLED_FIELD = "enabled";
    /** Mirrors the schema default, so the switch reads correctly before the first sync. */
    var DEFAULT_ENABLED = true;
    /** Sits after the host's own appearance rows (10, 11) and the font rows (70, 71). */
    var ROW_ORDER = 80;
    /** `<style>` tag identity, so the tag can be found and removed again. */
    var ROW_STYLE_TAG_ID = STYLE_MARKER + "/settings-general-row.css";

    /**
     * The collapse glide, armed from here.
     *
     * The host means to animate the sidebar: `.BynINW_frame[data-animating]` has
     * a `grid-template-columns` transition, and `data-animating` is set from a
     * layout effect. But that effect runs *after* React committed the new width,
     * and a layout read in between forces the style recalculation — so the
     * transition is declared one recalc too late and never runs. Measured on the
     * real thing: the column crosses its whole range in 8ms.
     *
     * No rule can arm it from the far side of that commit. A capture-phase
     * listener can, because it runs before React's own: by the time the width
     * changes, the frame is already marked and the transition is live.
     *
     * These four must match the host half's `COLLAPSE_ATTRIBUTE`,
     * `TOGGLE_SELECTOR`, `FRAME_SELECTOR` and `COLLAPSE_ARM_DURATION`; the
     * checks assert that they do.
     */
    var COLLAPSE_ATTRIBUTE = "data-dsh-mica-collapse";
    var TOGGLE_SELECTOR = '[class*="_toggle"]';
    var FRAME_SELECTOR = '[class*="_frame"]';
    var COLLAPSE_ARM_DURATION = 700;

    /**
     * Settings row chrome.
     *
     * `-row`, `-rowText`, `-title` and `-desc` reproduce the measurements and
     * tokens of the host's own Settings rows so this row is indistinguishable
     * from a built-in one. The switch reproduces the host `Switch` exactly,
     * including the detail that its appearance is driven by `aria-checked`
     * rather than by a parallel class — the visual state cannot then disagree
     * with the state assistive technology reads.
     */
    var ROW_CSS = [
      "." + STYLE_MARKER + "-row{align-items:center;gap:8px;padding:16px 0;display:flex;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      "." + STYLE_MARKER + "-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
      "." + STYLE_MARKER + "-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      "." + STYLE_MARKER + "-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}",
      "." + STYLE_MARKER + "-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}",
      "." + STYLE_MARKER + "-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
      "." + STYLE_MARKER + "-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      "." + STYLE_MARKER + "-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease}",
      "." + STYLE_MARKER + "-switch[aria-checked='true'] ." + STYLE_MARKER + "-thumb{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}",
    ].join("");

    /**
     * Visible copy, as required for a Harness client plugin.
     *
     * Keys are flat strings — the locale service looks keys up literally, so a
     * dotted key would have to be spelled out in full on both sides. `zh` is the
     * fallback dictionary, and any locale without an entry falls back to it.
     */
    var DICTIONARIES = {
      en: {
        title: "Mica background",
        description: "Give the sidebar and the title bar the Mica material",
        stateOn: "On — click to turn off",
        stateOff: "Off — click to turn on",
      },
      zh: {
        title: "云母背景",
        description: "让侧边栏与顶部栏使用云母材质背景",
        stateOn: "已开启 — 点击关闭",
        stateOff: "已关闭 — 点击开启",
      },
    };

    /**
     * Decide the switch state from one config snapshot.
     *
     * Only an explicit `false` counts as off, so a snapshot that predates the
     * field (or a profile that never wrote it) keeps the schema default.
     *
     * @param snapshot Config form snapshot, `{ value, revision }`.
     * @returns `true` when the material should be on.
     */
    function readEnabled(snapshot) {
      return !snapshot || snapshot.value === undefined || snapshot.value[ENABLED_FIELD] !== false;
    }

    /**
     * Turn the material on or off by flipping the one attribute every injected
     * rule is gated on.
     *
     * @param enabled Whether the material should be on.
     */
    function setRootAttribute(enabled) {
      if (typeof document === "undefined") return;
      document.documentElement.setAttribute(ROOT_ATTRIBUTE, enabled ? ROOT_ON : ROOT_OFF);
    }

    /**
     * Install the row stylesheet, once, under this plugin's own lifetime.
     *
     * @param ctx Client plugin context.
     */
    function installRowStyles(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return;
        if (document.querySelector(`style[data-plugin-css="${ROW_STYLE_TAG_ID}"]`) !== null) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = STYLE_MARKER;
        tag.dataset.pluginCss = ROW_STYLE_TAG_ID;
        tag.textContent = ROW_CSS;
        document.head.append(tag);
        return () => {
          tag.remove();
        };
      }, `${STYLE_MARKER}: settings row styles`);
    }

    /**
     * Build the row's store.
     *
     * The revision guard is what keeps a slower write from overwriting a newer
     * one: this row can be told about the same state twice (once when the switch
     * is registered, once when the form publishes), and only the newest wins.
     *
     * @returns Store for the `enabled` row.
     */
    function createRowStore() {
      return dshStore.defineStore({
        init: () => ({ value: DEFAULT_ENABLED, revision: -1 }),
        actions: {
          sync: (draft, value, revision) => {
            if (revision <= draft.revision) return;
            draft.value = value;
            draft.revision = revision;
          },
        },
      });
    }

    /**
     * The Settings -> General row: a title, a description, and one switch.
     *
     * @param props Row props supplied by the settings slot.
     * @returns Row element.
     */
    function MicaRow(props) {
      const enabled = props.useStore((state) => state.value);
      return React.createElement(
        "div",
        { className: `${STYLE_MARKER}-row` },
        React.createElement(
          "div",
          { className: `${STYLE_MARKER}-rowText` },
          React.createElement("div", { className: `${STYLE_MARKER}-title` }, props.t("title")),
          React.createElement("div", { className: `${STYLE_MARKER}-desc` }, props.t("description")),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            role: "switch",
            className: `${STYLE_MARKER}-switch`,
            "aria-checked": enabled ? "true" : "false",
            "aria-label": props.t("title"),
            title: props.t(enabled ? "stateOn" : "stateOff"),
            onClick: () => {
              props.save(!enabled);
            },
          },
          React.createElement("span", { className: `${STYLE_MARKER}-thumb` }),
        ),
      );
    }

    /** Services this half cannot work without. */
    var inject = ["slots", "locale", "configForms"];

    /**
     * Arm the collapse glide when the sidebar toggle is pressed.
     *
     * Deliberately scoped to the toggle rather than to every layout change: a
     * blanket transition on the grid track would also animate the right-hand
     * panel during an ordinary window resize, which reads as lag. The toggle is
     * the only control that moves the sidebar track, and the sidebar track is
     * the only thing this softens.
     *
     * @param ctx Client plugin context.
     */
    function armCollapse(ctx) {
      ctx.effect(function () {
        if (typeof document === "undefined"
          || typeof document.addEventListener !== "function") return undefined;
        var timer = 0;
        var arm = function (event) {
          var target = event.target;
          if (!target || typeof target.closest !== "function") return;
          if (target.closest(TOGGLE_SELECTOR) === null) return;
          var frame = document.querySelector(FRAME_SELECTOR);
          if (!frame) return;
          // Refreshed rather than merely set: pressing the toggle again mid-glide
          // keeps the transition live instead of letting it expire underneath the
          // animation that is still running.
          frame.setAttribute(COLLAPSE_ATTRIBUTE, "");
          clearTimeout(timer);
          timer = setTimeout(function () {
            frame.removeAttribute(COLLAPSE_ATTRIBUTE);
          }, COLLAPSE_ARM_DURATION);
        };
        // Capture phase on `document`, which runs before the click handler
        // React attaches at the root — so the attribute is already true by the
        // time the state update commits, and the transition is armed in the
        // same frame the track changes. `click` rather than `pointerdown`
        // because it also covers Enter and Space on the focused toggle.
        document.addEventListener("click", arm, true);
        return function () {
          document.removeEventListener("click", arm, true);
          clearTimeout(timer);
          var frame = document.querySelector(FRAME_SELECTOR);
          if (frame) frame.removeAttribute(COLLAPSE_ATTRIBUTE);
        };
      }, STYLE_MARKER + ": collapse glide");
    }

    /**
     * Adopt the persisted switch state and register the Settings row.
     *
     * @param ctx Client plugin context.
     */
    function apply(ctx) {
      installRowStyles(ctx);
      armCollapse(ctx);

      const form = ctx.configForms.get(NAMESPACE);
      const report = (error) => {
        ctx.logger?.warn?.(`${STYLE_MARKER}: could not save the switch`, error);
      };

      let rowActions = null;
      const sync = () => {
        const snapshot = form.getSnapshot();
        if (snapshot === undefined || snapshot.value === undefined) return;
        const enabled = readEnabled(snapshot);
        if (rowActions !== null) rowActions.sync(enabled, snapshot.revision ?? 0);
        setRootAttribute(enabled);
      };

      // Adopt the state now, then follow every later change to it. This is also
      // what makes the switch take effect without a reload: the injected
      // stylesheet is already there, and this only flips the attribute it is
      // gated on.
      ctx.effect(() => form.subscribe(sync), `${STYLE_MARKER}: settings adoption`);
      sync();

      ctx.effect(
        () => ctx.locale.register(NAMESPACE, DICTIONARIES),
        `${STYLE_MARKER}: settings row dictionary`,
      );

      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: `${STYLE_MARKER}-${ENABLED_FIELD}`,
        order: ROW_ORDER,
        store: createRowStore(),
        locale: NAMESPACE,
        inject: (actions) => {
          rowActions = actions;
          sync();
          return {
            // The row calls this without awaiting it, so the rejection has to be
            // handled here rather than at the call site.
            save: (value) => {
              try {
                const pending = form.set(ENABLED_FIELD, value);
                if (pending !== undefined && pending !== null) pending.catch(report);
              } catch (error) {
                report(error);
              }
            },
          };
        },
      }, MicaRow));
    }

    module.exports = { apply, inject };
    return module.exports;
  },
});
