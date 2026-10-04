# dsh-ui-mica

为 DeepSeek Harness 的**侧边栏**与**顶部栏**提供云母（Mica）材质背景，并在
**设置 → 通用** 里提供一个开关按钮。

![浅色主题下的侧边栏与顶部栏云母材质](docs/preview-desktop-light.png)

![深色主题下的同一材质](docs/preview-desktop-dark.png)

## 它做了什么

侧边栏列与 Windows 顶部栏行是本就已经共用同一个 token
（`--dsw-specific-sidebar-fill`）的两个表面。本插件把这个 token 换成半透明的
面板填充色，并在整个框架后面铺一层「桌面」底景——一个底色加四团色彩光晕，再叠
一层细颗粒。于是就有了 Windows 所说的云母观感：面板能透出背后的色彩，而文字依
然清晰。

中间栏——也就是对话所在的那一栏——被刻意保持**不透明**。半透明的面板是装饰，
半透明的正文墙是缺陷。

## 安装

```sh
dsh plugin --profile <profile> add dsh-ui-mica
```

安装后需要重启 Harness。运行中的 `dsh web` 只在启动时组合 bundles，所以插件要
等下次启动才会被加载。

## 设置

**设置 → 通用 → 云母背景**用于开关材质。开关即时生效：两个方向都不需要刷新，
也不会闪烁。

另外三个外观参数没有出现在界面里。在 profile 的 `cordis.patch.yml` 中设置，然后
刷新页面：

```yaml
- insert:
    - id: ui-mica
      name: dsh-ui-mica
      config:
        enabled: true   # 与设置界面里的开关是同一个值
        opacity: 62     # 20–92：面板填充色保留宿主表面色的百分比
        blur: 30        # 0–120：两个云母表面的背景模糊，单位 px
        noise: 0.06     # 0–0.3：颗粒层的透明度
```

如果觉得面板上的文字对比度不够，就调高 `opacity`；如果觉得底景透出来的太少，
就调低它。

## 实现方式

插件分两半，而 CSS 只有一半拥有。

**`lib/index.js` —— 宿主半。** 它声明四个 `volatile()` 配置字段，关掉 schema
自动生成的设置页（浏览器半自己画那一行），并挂上 `webserver/index-inject`，向每
次渲染的 `index.html` 推入两项内容：

- 一个 `<style>`，装着全部材质样式；
- 一个 `<script>`，在首帧之前就把 `data-dsh-mica` 写到 `<html>` 上。

第二项正是「不会闪一下未样式化的界面」的原因：浏览器半加载得远晚于首帧，晚到的
属性会表现为肉眼可见的跳动。

**`lib/client.js` —— 浏览器半。** 它通过 `configForms` 读取 `ui-mica` 设置命名
空间，把 `enabled` 映射到文档根元素上，并注册设置界面里的一行。它自己不带任何
CSS。

**所有选择器都被 `html[data-dsh-mica="on"]` 门控。** 这是整个设计的承重属性：
开关只是一次属性翻转，样式表每页只注入一次，关闭状态也不可能留下「卸了一半」的
材质。

还有两个值得一提的取舍：

- 面板填充色是**推导**出来的，而不是写死的：
  `color-mix(in srgb, var(--dsw-alias-bg-base) <opacity>%, transparent)`。
  因此它会跟随当前主题——浅色、深色，或任何第三方主题——不需要维护一张按配色分
  支的对照表。
- 材质靠 `!important` 胜过主题呈现器。呈现器把 token 写成 `<body>` 上的行内自
  定义属性，而这恰好是样式表能够覆盖的形态；这里没有任何地方依赖宿主「愿意」降
  低自己的特异性。

## 已知限制

- **纯浏览器文档里没有顶部栏。** Harness 只在 Windows 桌面端设置
  `data-windows-titlebar`；浏览器标签页里没有可绘制的顶部栏，因此那里只有侧边栏
  会变化。这是宿主的版式，不是插件的缺失。
- **三个外观参数需要刷新页面。** 它们在 index 被送出时读取，所以在 YAML 里改动
  影响的是下一次页面加载，而不是当前这一次。
- **材质假定宿主保留它的 `--dsw-*` token。** 它是在主题之上叠加，而不是替换主
  题；如果宿主改名了这些 token，面板会变得没有背景，而不会把界面弄坏。

## 开发

没有构建步骤。两半都以手写 JavaScript 形式发布，因此下面这些脚本就是 TSX 插件
的「编译并检查」阶段。

```sh
node scripts/check.mjs     # 静态 bundle 不变量（那个不存在的「构建」）
node scripts/smoke.mjs     # 用桩宿主真正运行两半代码
node scripts/preview.mjs   # 生成 preview/*.html —— 不用重启就能看到材质
```

`preview.mjs` 会生成真实的样式表，并把它渲染在一份复刻的宿主框架结构上——这是
迭代 UI 插件唯一现实的做法：不必先安装、再重启 Harness。你可以用浏览器打开生成
的页面，也可以无头截图：

```sh
msedge --headless=new --disable-gpu --window-size=1280,760 \
  --screenshot="preview/shot.png" "preview/desktop-light.html"
```

在预览页里按 <kbd>m</kbd> 可以切换材质开关。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
