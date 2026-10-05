# 第三方插件在宿主升级后静默失效：一次完整诊断

> 案例：`dsh-ui-status-label`（一个"运行状态文案"插件）在 DeepSeek Harness 从 `0.1.x-rc.1`
> 升到 `0.1.7-rc.2` 之后无法加载。本文记录**怎么从一句报错查到根因**，以及为什么不建议重写。

---

## 1. 症状

启动 `dsh web` 时刷出：

```
HARNESS
Failed to load plugins
dsh-ui-status-label
web boot: 1 entry did not activate
dsh-ui-status-label: import failed: client-modules:
  require("@deepseek-ai/dsh-client-runtime/client") missed the module table
  — not a platform seed word, not a materialized module, and no registered
  package factory (a build-time externals drift, or a dynamic dependency
  that did not arrive)
```

关键信息全在最后一段里，逐句拆：

| 报错片段 | 含义 |
|---|---|
| `web boot: 1 entry did not activate` | 客户端有 1 个插件条目没激活（服务端多半是好的） |
| `require("@deepseek-ai/dsh-client-runtime/client")` | 插件尝试 require 这个包 |
| `missed the module table` | 宿主的**客户端模块表**里没有它 |
| `a build-time externals drift` | 宿主判断这是**构建期外部依赖漂移** —— 说白了：版本对不上 |

---

## 2. 诊断路径

### ① 插件装在哪

它不在 `dsh` 自己的包里，而在 **profile 的 node_modules**：

```
%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-ui-status-label\
```

（注意：本机 `profiles\web\node_modules\@deepseek-ai` 是被"抬高"出来的依赖，
和插件本体在同一个 node_modules 里 —— 这一点后面很关键。）

### ② 它要求什么

```bash
grep -o 'require("[^"]*")' lib/client.js | sort -u
```

插件**只用到一个** API：

```js
require("@deepseek-ai/dsh-client-runtime/client").createSnapshotStore
```

### ③ 这个包还在吗

```bash
ls %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\ | grep client-runtime
```

**没有了。** 当前版本里提供 `createSnapshotStore` 的是 `@deepseek-ai/dsh-client-store`。

### ④ 其它依赖呢

把插件用到的宿主服务全列出来，一个个查：

```bash
grep -rl "settingsScope"        <dsh 安装目录>
grep -rl "conversationStatus"   <dsh 安装目录>
```

**两个都是空的。** 结论清晰了。

---

## 3. 根因：面向的那一代 API 整体消失了

| 插件依赖的东西（`0.1.x-rc.1` 世代） | `0.1.7-rc.2` 里的状态 |
|---|---|
| `@deepseek-ai/dsh-client-runtime/client` | **包整个没了**（`createSnapshotStore` 搬到 `dsh-client-store`） |
| 客户端服务 `settingsScope` | **没了**，对应机制改叫 `configForms` |
| 客户端服务 `conversationStatus` | **没了**，状态文字改成 ui-chat 自己的 i18n key（`chat.deepDiving`） |
| `@deepseek-ai/dsh-settings` 导出的 `settingsNamespace` | **不再导出** |

所以这**不是补个包就能救**的依赖缺失，而是插件所依赖的一整层抽象被重构掉了。

---

## 4. 顺带发现的第二个问题：旧依赖会"遮盖"新版本

排查时注意到启动日志里还有一条**看起来无关**的告警：

```
dsh: disabling profile plugin row "settings":
Plugin @deepseek-ai/dsh-settings@0.0.1-rc.1 is incompatible with dsh 0.1.7-rc.2
```

对照版本（实测读取各包 `package.json`）：

| 包 | profile 里（被抬高） | `dsh` 自带 |
|---|---|---|
| `@deepseek-ai/dsh-settings` | `0.0.1-rc.1` | `0.1.7-rc.2` |
| `@deepseek-ai/cosmokit` | `1.8.3` | `1.8.5` |
| `@deepseek-ai/schemastery` | `3.18.2` | `3.18.4` |

注意 `dsh-settings` 那一行：被抬高的版本号是 `0.0.1-rc.1`，而宿主自带的是 `0.1.7-rc.2`
—— **主版本号差了一档**，所以版本闸门直接判定不兼容。
`cosmokit` / `schemastery` 只差补丁位，属于"旧一点但没到被拦"的程度。
**版本号本身不重要，重要的是「profile 根目录的副本会优先命中」这个解析顺序。**

装插件时它把自己的依赖**抬高（hoist）到了 profile 根目录**，于是在模块解析时
**盖住了 `dsh` 自带的同名列** —— 宿主自己的 `settings` 行因此被版本闸门判定为不兼容而禁用。

**验证方法（可逆实验）**：把 `profiles\web\node_modules\@deepseek-ai` 临时改名，
`dsh` 自带版本立刻生效，启动日志**完全干净**，连这条 `settings` 告警也一起消失。

这说明它是**功能性改善**，不只是消错：被禁用掉的「设置」行恢复了。

---

## 5. 处置

### ① 禁用插件（可逆）

在 profile 的用户补丁层 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 加：

```yaml
- id: ui-status-label
  disabled: true
```

`disabled: true` 是 loader 支持的字段。**插件文件与依赖原样保留**，
等作者适配新版后删掉这两行即可恢复。示例见
[`../patches/cordis.patch.yml.example`](../patches/cordis.patch.yml.example)。

### ② 移开被抬高的旧依赖

把 `profiles\web\node_modules\@deepseek-ai` 挪到 **node_modules 之外**
（例如 `profiles\web\.disabled-deps-<日期>\`），这样既不再参与解析，也随时能还原。

> ⚠️ 补丁层文件（`cordis.patch.yml`）会被 `dsh` 运行时**追加写入**它自己的记录。
> 要手工编辑的话，**先退出 `dsh` 再改**，否则你的改动可能和它的写入交错。

---

## 6. 验证

| 阶段 | 启动日志 |
|---|---|
| 改前 | `Failed to load plugins` + `did not activate` + `disabling profile plugin row "settings"` |
| 改后（连测 4 次，不同端口） | 只剩一行 `dsh web: http://127.0.0.1:<port>/?token=...` |

**但日志干净≠界面能用。** 又做了一次真机渲染验证：

| 检查项 | 结果 |
|---|---|
| 浏览器启动载荷 `window.__DSH_BOOT__` | 64 个客户端条目，**全部是官方包**，`ui-status-label` 已不在其中，无 disabled/failed 标记 |
| 页面渲染 | 200，标题正常，侧边栏 / 欢迎页 / 输入框 / 模型选择器齐全 |
| 控制台 | error / warning / 未捕获异常 **均为 0** |
| 设置面板 | **完整打开** —— 证明移走旧依赖确实把被挤掉的行恢复了 |

工具就是本仓库的 `scripts/cdp-verify-page.mjs`。

---

## 7. 为什么不重写这个插件

评估过把功能做回来，结论是**没有干净的接法**：

- 上游把 `conversationStatus` 这个扩展点**删掉了**；
- 状态文字现在是 ui-chat 内部的 i18n 字符串；
- `locale.register` 对同名命名空间会直接抛错，也没有对应的插槽可挂。

硬做只能沿用旧插件那套「劫持 `[role=status]` DOM」的兜底手段，
而且配置没法持久化、随时可能再次被重构打碎。
**收益不抵风险，建议等作者适配。**

---

## 8. 可复用的排查清单

遇到「升级宿主后插件报 import failed」时：

1. **读报错的最后一段** —— 宿主通常已经告诉你它认为是外部依赖漂移。
2. **定位插件本体**：通常在 `~/.<宿主>/profiles/<profile>/node_modules/<插件名>`。
3. **列出插件的全部 require**：`grep -o 'require("[^"]*")' lib/*.js | sort -u`
4. **逐个确认这些包/服务在新宿主里是否还存在**（注意可能只是**改名**了）。
5. **若整代 API 都消失 → 禁用，别硬修**。用加载器的 `disabled` 字段，保持可逆。
6. **顺手查"旧依赖遮盖"**：对比 `profile/node_modules` 与宿主自带同名包的版本，
   被抬高的旧版本会盖住新的。移到 node_modules 外面即可。
7. **最后一定要做真机验证** —— 启动日志干净只说明"没报错"。
