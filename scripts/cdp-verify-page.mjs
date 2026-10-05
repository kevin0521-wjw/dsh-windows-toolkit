#!/usr/bin/env node
/**
 * cdp-verify-page.mjs —— 用真实浏览器（headless Edge/Chrome + CDP）验证一个
 * 本地 web 页面是不是真的能用，并落盘截图。
 *
 * 为什么不用 Playwright / Puppeteer：
 *   本机可能只装了 Edge，没有额外的浏览器二进制；CDP 直连零依赖，
 *   用内置的 fetch + WebSocket 就够了，不需要 npm install。
 *
 * 为什么必须发「真实鼠标事件」：
 *   el.click() 走的是 DOM 派发，会绕过命中测试(hit-testing)，因此可能点到
 *   完全不同的元素上 —— 也会绕过依赖 pointerdown 的自定义组件。
 *   实测：用 el.click() 点侧边栏「设置」，弹出来的却是旁边那个下拉菜单。
 *   必须用 Input.dispatchMouseEvent。
 *
 * 用法：
 *   node cdp-verify-page.mjs --url "http://127.0.0.1:3080/?token=..." \
 *     --shot out.png
 *   node cdp-verify-page.mjs --url URL --click-label "^设置$" --wait 4000
 *   node cdp-verify-page.mjs --url URL --click 480,300
 *
 * 参数：
 *   --url          必填
 *   --click        坐标 "X,Y"，直接点
 *   --click-label  CSS 选择器无关，按 aria-label / title / innerText 正则定位后点其中心
 *   --wait         点击后等待毫秒，默认 3500
 *   --shot         截图输出路径，默认 ./cdp-shot.png
 *   --timeout      页面加载上限毫秒，默认 40000
 *   --double       双击
 *   --browser      覆盖浏览器 exe 路径
 *   --use-system-proxy  允许走系统代理（默认禁用，见下）
 *
 * ⚠️ 默认传 --no-proxy-server。
 *    本机装了 Clash / V2Ray 之类时，系统代理会把 127.0.0.1 也代理走，
 *    页面直接变成「无法访问此网站」，但脚本只会报「label 未命中」，
 *    极易误判成按钮坏了。清环境变量不够 —— 浏览器还读注册表里的系统代理，
 *    必须从命令行层面关掉。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const PORT = Number(process.env.CDP_PORT || 9335)

/**
 * 把可能来自 Git Bash / MSYS 的 POSIX 路径转成 Windows 路径。
 * 在 Git Bash 里 "$PWD/x.png" 给的是 /c/Users/...，直接交给
 * path.resolve() 会被拼成 C:\c\Users\...（凭空多一层目录）。
 * 更阴的是文件照样"保存成功"，只是落在了别处，很难发现。
 */
function resolveOutputPath(p) {
  const s = String(p)
  const m = /^\/?([a-zA-Z])\/(.+)$/.exec(s)
  if (m && !/^[a-zA-Z]:/.test(s)) {
    return path.resolve(m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\'))
  }
  return path.resolve(s)
}

// ---------------- CLI ----------------
function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) o[k] = true
    else { o[k] = v; i++ }
  }
  return o
}
const A = parseArgs(process.argv.slice(2))

if (A.help || !A.url) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
  process.exit(A.help ? 0 : 1)
}

const URL_ = A.url
const WAIT = Number(A.wait || 3500)
const LOAD_TIMEOUT = Number(A.timeout || 40000)
const SHOT = resolveOutputPath(A.shot || 'cdp-shot.png')
const CLICKS = A.double ? 2 : 1

let X = null, Y = null, LABEL = null
if (A['click-label']) LABEL = String(A['click-label'])
if (A.click) {
  const [xs, ys] = String(A.click).split(',')
  X = Number(xs); Y = Number(ys)
  if (!Number.isFinite(X) || !Number.isFinite(Y)) {
    console.error('!! --click 需要 "X,Y" 形式')
    process.exit(2)
  }
}

const browserExe = A.browser || BROWSERS.find((p) => fs.existsSync(p))
if (!browserExe) {
  console.error('!! 找不到 Edge/Chrome，可用 --browser 指定')
  process.exit(2)
}

// 代理环境变量会让 headless 浏览器连不上 127.0.0.1，必须清掉
function cleanEnv() {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (/^(http|https|all|no)_proxy$/i.test(k)) delete e[k]
  return e
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpverify-'))

const child = spawn(browserExe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1600,1000',
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + PORT,
  ...(A['use-system-proxy'] ? [] : ['--no-proxy-server']),
  'about:blank',
], { detached: true, stdio: 'ignore', env: cleanEnv() })
child.unref()

let ws
let id = 0
const waiters = new Map()
const logs = []

function send(method, params = {}, timeoutMs = 15000) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((res) => {
    waiters.set(mid, res)
    setTimeout(() => { if (waiters.has(mid)) { waiters.delete(mid); res({ __timeout: true }) } }, timeoutMs)
  })
}

async function evaluate(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  if (r.__timeout) return '__ERR__:超时'
  if (r.result?.exceptionDetails) return '__ERR__:' + (r.result.exceptionDetails.text || '')
  return r.result?.result?.value
}

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP target 未就绪')
}

function killTree() {
  try { ws?.close() } catch {}
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

// ---------------- main ----------------
try {
  const t = await findPageTarget()
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.text || ''))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      logs.push('ERR: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
  await send('Page.enable'); await send('Runtime.enable')

  ws.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url: URL_ } }))
  const deadline = Date.now() + LOAD_TIMEOUT
  let loaded = false
  let lastProbe = null
  while (Date.now() < deadline) {
    await sleep(1000)
    // 注意用 indexOf 做子串判断，别用 ?.  之类的写法去 eval 一个布尔表达式：
    // 那样一旦表达式本身报错就会静默返回错误串，循环空转到超时，
    // 最后打印 loaded=false，看起来像页面没加载，实际上早加载好了。
    lastProbe = await evaluate(
      `(document.readyState || '?') + '|' + ((document.body && document.body.innerText) ? document.body.innerText.length : -1)`
    )
    if (typeof lastProbe === 'string' && !lastProbe.startsWith('__ERR__')) {
      const [state, lenStr] = lastProbe.split('|')
      const len = Number(lenStr)
      if (state === 'complete' && len > 20) { loaded = true; break }
    }
  }
  await sleep(5000)

  // ⚠️ --window-size 在 headless 下不可靠（实测请求 1440x900 与 1600x1000 都得到 1566 宽）。
  //    先读真实视口，别拿请求值当坐标依据。
  const vpRaw = await evaluate(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`)
  const vp = JSON.parse(vpRaw || '{}')
  console.log('页面加载完成:', loaded, '| 最后探测:', lastProbe, '| 真实视口:', vpRaw)
  if (!loaded) console.log('  (注意：加载判定未通过，但仍继续验证，页面内容见下方)')

  // 兜底诊断：如果落到的其实是浏览器的连接错误页，必须直说，
  // 否则后面只会报「找不到元素」，很容易误判成页面本身的问题。
  const probe = await evaluate(`JSON.stringify({
    title: document.title,
    hasErr: /ERR_|无法访问此网站|This site can.t be reached|检查代理|Check your proxy|DNS_PROBE/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 600)),
  })`)
  const pr = JSON.parse(probe || '{}')
  if (pr.hasErr) {
    console.error('\n!! 浏览器加载的是「连接失败」错误页，不是目标页面。')
    console.error('   标题:', pr.title)
    console.error('   常见原因：系统代理把 127.0.0.1 也代理走了（默认已传 --no-proxy-server，')
    console.error('   若是远程 URL 请改用 --use-system-proxy），或目标服务其实没在监听。')
    console.error('   先自查：curl -s -o /dev/null -w "%{http_code}" ' + URL_)
    process.exitCode = 1
    throw new Error('加载到错误页')
  }

  if (LABEL !== null) {
    const loc = await evaluate(`(() => {
      const els = [...document.querySelectorAll('button,[role=button],a,[role=tab],input,li,div[role=menuitem]')].filter((e) => {
        const b = e.getBoundingClientRect()
        return b.width > 0 && b.height > 0 && b.top >= 0 && b.left >= 0 &&
               b.bottom <= innerHeight && b.right <= innerWidth
      })
      const hit = els.find((e) =>
        new RegExp(${JSON.stringify(LABEL)}).test(e.getAttribute('aria-label') || e.getAttribute('title') || (e.innerText || '').trim()))
      if (!hit) return JSON.stringify({ found: false, candidates: els.map((e) => (e.getAttribute('aria-label') || (e.innerText || '').trim()).slice(0, 20)).slice(0, 40) })
      const b = hit.getBoundingClientRect()
      return JSON.stringify({ found: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), rect: [b.x, b.y, b.width, b.height].map(Math.round) })
    })()`)
    console.log('定位结果:', loc)
    const o = JSON.parse(loc || '{}')
    if (o.found) { X = o.x; Y = o.y }
    else { console.log('未找到匹配元素，候选:', o.candidates); throw new Error('label 未命中') }
  }

  if (X !== null) {
    // 先把鼠标移开，避免残留 hover 菜单挡住目标
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    await sleep(400)
    console.log(`\n=== 真实鼠标点击 (${X}, ${Y}) x${CLICKS} ===`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y })
    await sleep(250)
    for (let c = 1; c <= CLICKS; c++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: c })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: c })
      await sleep(80)
    }
    await sleep(WAIT)
  }

  const after = await evaluate(`(() => {
    const txt = document.body.innerText || ''
    return JSON.stringify({
      textLen: txt.length,
      text: txt.slice(0, 2000),
      dialogs: [...document.querySelectorAll('[role=dialog]')].filter((e) => e.offsetParent !== null || getComputedStyle(e).display !== 'none').length,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20),
    })
  })()`)
  console.log('\n=== 页面状态 ===')
  const st = JSON.parse(after || '{}')
  console.log('可见文本长度:', st.textLen, '| role=dialog 数:', st.dialogs)
  console.log('标题:', st.headings)
  console.log('--- 可见文本片段 ---')
  console.log((st.text || '').slice(0, 1200))

  console.log('\n=== 控制台 error / 未捕获异常 ===')
  console.log(logs.length ? [...new Set(logs)].join('\n') : '(无)')

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (shot.result?.data) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true })
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))
    console.log('\n截图:', SHOT, fs.statSync(SHOT).size + ' B')
  }
} catch (e) {
  console.error('!! ' + (e?.message || e))
  process.exitCode = 1
} finally {
  killTree()
  await sleep(800)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
}
