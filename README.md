# dsh-windows-toolkit

给 **DeepSeek Harness（`dsh`）** 这类「只存在于 npx 缓存、没有全局命令」的 CLI 做 Windows 桌面快捷方式，
外加一整套**真机验证**与**过期插件排查**的方法。

不是只有 `dsh` 能用 —— 脚本都是通用的，换成任何 npx / 局部安装的 CLI 都行。

> Tooling + notes for putting a desktop shortcut on a Windows CLI that only lives in the
> npm npx cache, for verifying a local web UI with a real browser over CDP, and for
> diagnosing a third-party plugin that broke after a host upgrade.
> All scripts are generic; `dsh` is just the case study.

---

## 目录

- [它解决了什么问题](#它解决了什么问题)
- [快速开始](#快速开始)
- [脚本清单](#脚本清单)
- [踩坑速查表](#踩坑速查表)
- [验证过程](#验证过程)
- [环境与依赖](#环境与依赖)
- [许可](#许可)

---

## 它解决了什么问题

四件事，每一件都有真实的坑：

### 1. npx 缓存路径不能写死

`dsh` 没有全局命令，入口在 npx 缓存里：

```
%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js
```

那个 `<hash>` **会变**（版本升级、缓存重建都会换），而且 `_npx` 目录是**多个包共用**的 ——
本机就同时躺着 `1e7f6d9597241db0`（装的是 dsh）和 `4e5c24d7baa062b3`（装的是 Capacitor/Ionic），
无脑扫目录会挑错。

**可靠做法**：优先用 `dsh` 自己维护的符号链接
`%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js`，
它的解引用结果就是 `dsh` 当前实际解析到的副本。实在没有再退到逐个探测 npx 缓存。

### 2. 快捷方式要指向 cmd.exe，而不是指向目标

`.lnk` 直接指向 `bin.js` 的话，出错时黑窗一闪而过、什么也看不到。
所以快捷方式指向 `cmd.exe /c dsh-web.cmd`，由启动器负责解析路径、打印诊断、失败时 `pause` 留住窗口。

### 3. `dsh web` 的 UI 地址带一次性 token

```
dsh web: http://127.0.0.1:3080/?token=<一次性 token>
```

裸地址 `http://127.0.0.1:3080/` 会返回 **401**。token 是**内存生成、不落盘**的，
会换成一个 HttpOnly cookie，之后裸地址才通。

> **不要手敲 `127.0.0.1:3080`**，用 `dsh` 自己打开的那个链接。
> 启动器里那句「已在运行」的提示也是因此写成「去用另一个窗口打印的 URL」。

### 4. 第三方插件会随宿主升级而静默失效

本机真实现象：启动时刷

```
Failed to load plugins
dsh-ui-status-label
web boot: 1 entry did not activate
```

根因是插件按旧版 API 编译，而宿主升级后**整套接口被移除**（不是缺个包就能救）。
完整诊断过程见 [`docs/plugin-compat.md`](docs/plugin-compat.md)，
可复用的禁用补丁见 [`patches/cordis.patch.yml.example`](patches/cordis.patch.yml.example)。

---

## 快速开始

假设你已经能用 `npx @deepseek-ai/dsh` 跑起来（至少要跑过一次，让缓存被填上）。

```bash
git clone https://github.com/kevin0521-wjw/dsh-windows-toolkit
cd dsh-windows-toolkit
npm install                 # 只为 koffi，用来调 COM 建快捷方式
```

**① 放启动器**（改好里面的 `DSH_CWD` / `DSH_PORT`）：

```cmd
mkdir "%USERPROFILE%\.dsh\bin"
copy scripts\dsh-web.cmd "%USERPROFILE%\.dsh\bin\dsh-web.cmd"
```

**② 做图标**（从你本地那份 dsh 自带的官方 favicon 渲染，仓库不附图标文件）：

```bash
python scripts/svg-to-ico.py \
  --svg "$LOCALAPPDATA/npm-cache/_npx/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon-dark.svg" \
  --out "%USERPROFILE%\.dsh\bin\dsh.ico" \
  --bg "linear-gradient(150deg,#6B87FF 0%,#4D6BFE 48%,#2F49D6 100%)"
```

> 深色底要用 **`favicon-dark.svg`**（白色鲸鱼）。浅色版是黑鲸鱼，放蓝底上会看不见。

**③ 建快捷方式**：

```cmd
node scripts\make-shortcut.cjs ^
  --name "DeepSeek Harness" ^
  --target "%SystemRoot%\System32\cmd.exe" ^
  --args "/c \"%USERPROFILE%\.dsh\bin\dsh-web.cmd\"" ^
  --cwd  "%USERPROFILE%\dsh-workspace" ^
  --desc "启动 dsh web 界面" ^
  --icon "%USERPROFILE%\.dsh\bin\dsh.ico"
```

**④ 验证** —— 别只看「启动日志干净」，那证明不了界面能用：

```bash
node scripts/cdp-verify-page.mjs --url "http://127.0.0.1:3080/?token=..." --shot ui.png
```

---

## 脚本清单

| 文件 | 作用 | 已验证 |
|---|---|---|
| `scripts/dsh-web.cmd` | 启动器。自动定位 node 与 dsh 入口，**ASCII-only**，失败时给可读诊断 | 3 条路径（成功 / 缺入口 / 缺 node）dry-run 全过 |
| `scripts/make-shortcut.cjs` | 用 koffi 直调 `ole32.dll` 建 `.lnk`，**写回后读回校验** | target/args/desc/icon 四项读回一致 |
| `scripts/svg-to-ico.py` | SVG → 多尺寸 `.ico`（16/32/48/64/128/256），headless 浏览器渲染，**两级自校验**（结构 + 像素） | 6 档尺寸 + 像素内容校验通过 |
| `scripts/cdp-verify-page.mjs` | headless Edge/Chrome + CDP 真机验证页面，**真实鼠标事件**点击，出文本 + 截图 | 定位→点击→面板打开，控制台零报错 |

### 为什么 `make-shortcut.cjs` 不用 PowerShell

`New-Object -ComObject WScript.Shell` 在受限环境（沙箱 / WSH 被策略禁用）里经常直接失败。
这里改用 koffi 调 `ole32.dll` 的 `CoCreateInstance` 拿 `IShellLinkW`，
只要能有 koffi 就能用。

访问虚表是手工按槽位号取的（`IShellLinkW` 的 `SetPath`=20、`SetArguments`=11、`SetIconLocation`=17…）。
**不要读 `GetIconLocation`（槽位 16）—— 实测必 SIGSEGV。**

### 为什么 `cdp-verify-page.mjs` 要点真实鼠标

`el.click()` 走 DOM 派发，**绕过命中测试**，可能点到完全不同的元素上。
实测：用 `el.click()` 点侧边栏「设置」，弹出来的却是旁边那个「访问模式」下拉。
必须用 `Input.dispatchMouseEvent` 发 `mousePressed` / `mouseReleased`。

---

## 踩坑速查表

这些都是实测踩出来的，不是推测。

| # | 坑 | 症状 | 解法 |
|---|---|---|---|
| 1 | **`if ( ... )` 块里的裸圆括号** | cmd 块解析错乱：条件为假时块内容照跑，还有整行凭空消失 | 别用括号块，改用 `goto` 标签跳转 |
| 2 | **`.cmd` 里有非 ASCII 字节** | 解析器被字节打乱，报错莫名其妙 | `.cmd` 一律纯 ASCII（含注释） |
| 3 | **Python 给 `cmd` 传列表参数** | 含引号的命令全被解析坏，报 `The filename, directory name, or volume label syntax is incorrect.`，极易误判成「沙箱拦了」 | `subprocess.run("cmd /c " + 命令字符串)` —— **传字符串**，Windows 才会原样交给 CreateProcess |
| 4 | **`dir /s "a\*\b"`** | 路径中间的 `*` 不展开，直接报错 | cmd 的 `dir` 通配符只对**末级**有效。要遍历中间层用 `for /d`，或先 `dir /b /ad /o-d <目录>` 再逐个 `if exist` |
| 5 | **`--window-size` 在 headless 下不可靠** | 请求 1440×900 和 1600×1000，实测 `innerWidth` **都是 1566** | 先读真实视口，只点完全落在视口内的元素 |
| 6 | **本机代理劫持 `127.0.0.1`** | 页面变成「无法访问此网站」，脚本却只报「找不到元素」，误判成按钮坏了 | 起浏览器时加 **`--no-proxy-server`**。只清环境变量不够，浏览器还会读系统代理 |
| 7 | **Git Bash 的 `/c/...` 路径喂给 Node** | `path.resolve('/c/Users/x')` → `C:\c\Users\x`，凭空多一层目录；文件"保存成功"但落在别处 | 脚本内做 POSIX→Windows 转换，或直接传 `C:\...` |
| 8 | **`grep`/`findstr` 在本机沙箱里时灵时不灵** | 明明有匹配却返回空 | 别把探测结果当作唯一真相；用 `if exist` / 直接读文件复核 |
| 9 | **拿正常 UI 词汇当错误断言** | 页面本来就有个叫「插件」的侧边栏项，拿 `插件` 当关键字会虚报错误 | 断言用具体错误串：`Failed to load plugins`、`did not activate` |
| 10 | **SVG→PNG 的模板里占位符没加引号** | `icon.style.background = {bg};` → JS 语法错误 → 整段 `<script>` 静默失效，底色和尺寸全丢，但 PNG 依然"合法"、尺寸依然正确 | 占位符一律加引号，并加**像素级**守门校验，不要只看体积 |

---

## 验证过程

「启动日志干净」**不等于**「界面能用」。这个包里的每样东西都做了独立验证：

| 检查项 | 手段 | 结果 |
|---|---|---|
| 启动器路径解析 | dry-run 变体（把真正调用 dsh 的行换成 `echo`） | node / entry / workspace 全部解析正确 |
| 启动器错误分支 | 把环境变量指向不存在的盘符，强制走异常路径 | 缺 node、缺入口、端口占用三条都给出可读提示 |
| 入口正确性 | 与已知可用入口做 md5 比对 | `e55471a3dcb472b76c10b53980ca860a` 完全一致 |
| 快捷方式 | COM 读回 target / args / desc + 图标字符串字节 | 4 项全部一致 |
| 图标 | 逐档解 PNG，统计实心率 / 圆角透明 / 前景像素 | 6 档尺寸全对 |
| Web UI | headless Edge + CDP 渲染 + 截图 + 控制台监听 | 界面正常、零报错、设置面板可打开 |

截图（`assets/`）：主界面与设置面板。

---

## 环境与依赖

本机实测环境：

- Windows 11（`win32`），Git Bash
- Node.js 22 / 24
- Python 3.13（`svg-to-ico.py` 只用标准库；装了 Pillow 会额外做像素校验，**强烈建议装**）
- Microsoft Edge（`svg-to-ico.py` 和 `cdp-verify-page.mjs` 都靠它做 headless 渲染；Chrome 也行）
- npm 包：`koffi`（仅 `make-shortcut.cjs` 需要）

没有 Windows 的话，`svg-to-ico.py` 和 `cdp-verify-page.mjs` 的原理仍然通用，
但里面的浏览器路径和 `.lnk` 那套 COM 调用是 Windows 专属的。

---

## 一个说明

仓库里**不包含 DeepSeek 的 logo 文件**。图标是用你本机那份 `dsh` 安装包里自带的
favicon 现渲染的（见「快速开始 ②」），商标归各自所有者。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
