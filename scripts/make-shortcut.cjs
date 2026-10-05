#!/usr/bin/env node
/**
 * make-shortcut.cjs —— 在 Windows 上创建一个 .lnk 快捷方式，并**读回校验**。
 *
 * 为什么不用 PowerShell 的 WScript.Shell：
 *   在受限环境（沙箱 / 无 WSH 的机器 / 被策略拦截的终端）里，
 *   New-Object -ComObject WScript.Shell 经常直接失败。这里改用 koffi
 *   直接调 ole32.dll 的 COM 接口，只要能拿到 koffi 就能用。
 *
 * 用法：
 *   node make-shortcut.cjs --name "DeepSeek Harness" \
 *     --target "%SystemRoot%\System32\cmd.exe" \
 *     --args "/c \"%USERPROFILE%\.dsh\bin\dsh-web.cmd\"" \
 *     --cwd "%USERPROFILE%\dsh-workspace" \
 *     --desc "启动 dsh web 界面" \
 *     --icon "%USERPROFILE%\.dsh\bin\dsh.ico"
 *
 * 全部路径支持 %VAR% 形式的环境变量，脚本会自行展开。
 * 不传 --out 时默认放到桌面。
 *
 * 依赖：npm i koffi
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

// ---------------- COM plumbing ----------------
const ole32 = koffi.load('ole32.dll');
const CoInitializeEx = ole32.func('int CoInitializeEx(void *pvReserved, uint32 dwCoInit)');
const CoCreateInstance = ole32.func('int CoCreateInstance(void *rclsid, void *pUnkOuter, uint32 dwClsContext, void *riid, void **ppv)');
const CoUninitialize = ole32.func('void CoUninitialize()');

const Guid = koffi.struct('Guid', {
  Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8),
});

const mkGuid = (d1, d2, d3, lastByte) => {
  const p = koffi.alloc('Guid', 1);
  koffi.encode(p, 'Guid', {
    Data1: d1, Data2: d2, Data3: d3,
    Data4: [0xC0, 0, 0, 0, 0, 0, 0, lastByte],
  });
  return p;
};

const CLSID_ShellLink = mkGuid(0x00021401, 0, 0, 0x46);
const IID_IShellLinkW = mkGuid(0x000214F9, 0, 0, 0x46);
const IID_IPersistFile = mkGuid(0x0000010b, 0, 0, 0x46);
const CLSCTX_INPROC_SERVER = 1;

const pSetPath = koffi.proto('int SetPath(void *this, str16 pszFile)');
const pSetWorkDir = koffi.proto('int SetWorkingDirectory(void *this, str16 pszDir)');
const pSetDesc = koffi.proto('int SetDescription(void *this, str16 pszName)');
const pSetIcon = koffi.proto('int SetIconLocation(void *this, str16 pszIconPath, int iIcon)');
const pSetArgs = koffi.proto('int SetArguments(void *this, str16 pszArgs)');
const pQI = koffi.proto('int QueryInterface(void *this, void *riid, void **ppvObject)');
const pSave = koffi.proto('int Save(void *this, str16 pszFileName, int fRemember)');
const pLoad = koffi.proto('int Load(void *this, str16 pszFileName, uint32 dwMode)');
const pGetPath = koffi.proto('int GetPath(void *this, void *pszFile, int cch, void *pfd, uint32 fFlags)');
const pGetArgs = koffi.proto('int GetArguments(void *this, void *pszArgs, int cch)');
const pGetDesc = koffi.proto('int GetDescription(void *this, void *pszName, int cch)');

// 虚表槽位。顺序按 IShellLinkW / IPersistFile 的声明顺序（含 IUnknown 的 3 个）。
const SLOT = {
  GetPath: 3,
  GetDescription: 6,
  SetDescription: 7,
  SetWorkingDirectory: 9,
  GetArguments: 10,
  SetArguments: 11,
  SetIconLocation: 17,
  SetPath: 20,
};
const PF_SLOT = { QueryInterface: 0, Load: 5, Save: 6 };

const slot = (vtbl, i) => koffi.decode(BigInt(vtbl) + BigInt(i) * 8n, 'void *');

function newShellLink() {
  const ppv = koffi.alloc('void *', 1);
  const hr = CoCreateInstance(CLSID_ShellLink, null, CLSCTX_INPROC_SERVER, IID_IShellLinkW, ppv);
  if (hr !== 0) throw new Error('CoCreateInstance hr=0x' + (hr >>> 0).toString(16));
  const pLink = koffi.decode(ppv, 'void *');
  return { pLink, vtbl: koffi.decode(pLink, 'void *') };
}

function asPersistFile(pLink, vtbl) {
  const ppv = koffi.alloc('void *', 1);
  const hr = koffi.call(slot(vtbl, PF_SLOT.QueryInterface), pQI, pLink, IID_IPersistFile, ppv);
  if (hr !== 0) throw new Error('QueryInterface hr=0x' + (hr >>> 0).toString(16));
  const pPF = koffi.decode(ppv, 'void *');
  return { pPF, vPF: koffi.decode(pPF, 'void *') };
}

function writeShortcut({ lnkPath, target, args, workDir, desc, icon }) {
  const { pLink, vtbl } = newShellLink();
  koffi.call(slot(vtbl, SLOT.SetPath), pSetPath, pLink, target);
  if (workDir) koffi.call(slot(vtbl, SLOT.SetWorkingDirectory), pSetWorkDir, pLink, workDir);
  if (desc) koffi.call(slot(vtbl, SLOT.SetDescription), pSetDesc, pLink, desc);
  if (args) koffi.call(slot(vtbl, SLOT.SetArguments), pSetArgs, pLink, args);
  if (icon) koffi.call(slot(vtbl, SLOT.SetIconLocation), pSetIcon, pLink, icon, 0);
  const { pPF, vPF } = asPersistFile(pLink, vtbl);
  const hr = koffi.call(slot(vPF, PF_SLOT.Save), pSave, pPF, lnkPath, 1);
  if (hr !== 0) throw new Error('Save hr=0x' + (hr >>> 0).toString(16));
}

/** 只读回属性，绝不启动被指向的程序。 */
function readBack(lnkPath) {
  const { pLink, vtbl } = newShellLink();
  const { pPF, vPF } = asPersistFile(pLink, vtbl);
  if (koffi.call(slot(vPF, PF_SLOT.Load), pLoad, pPF, lnkPath, 0) !== 0) return null;
  const b1 = Buffer.alloc(1024);
  koffi.call(slot(vtbl, SLOT.GetPath), pGetPath, pLink, b1, 1024, null, 0);
  const b2 = Buffer.alloc(2048);
  koffi.call(slot(vtbl, SLOT.GetArguments), pGetArgs, pLink, b2, 2048);
  const b3 = Buffer.alloc(1024);
  koffi.call(slot(vtbl, SLOT.GetDescription), pGetDesc, pLink, b3, 1024);
  // ⚠️ 不要读 GetIconLocation（槽位 16）—— 实测必 SIGSEGV。
  return {
    target: b1.toString('utf16le').split('\u0000')[0],
    args: b2.toString('utf16le').split('\u0000')[0],
    desc: b3.toString('utf16le').split('\u0000')[0],
  };
}

// ---------------- CLI ----------------
function expandEnv(s) {
  return s.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = val;
      i++;
    }
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.name) {
    console.log(`make-shortcut.cjs —— 创建并校验 Windows 快捷方式

必填：
  --name    <str>   快捷方式名（不含 .lnk）
可选：
  --target  <path>  默认 %SystemRoot%\\System32\\cmd.exe
  --args    <str>   传给 target 的参数
  --cwd     <path>  工作目录
  --desc    <str>   备注（鼠标悬停时显示）
  --icon    <path>  .ico 文件
  --out     <path>  完整 .lnk 路径，默认放到桌面
  --desktop <path>  覆盖桌面目录

示例：
  node make-shortcut.cjs --name "My App" --target "C:\\\\app\\\\run.cmd" \\
    --icon "C:\\\\app\\\\app.ico" --desc "我的应用"
`);
    return a.help ? 0 : 1;
  }

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const desktop = a.desktop ? expandEnv(a.desktop) : path.join(home, 'Desktop');

  const job = {
    lnkPath: a.out ? path.resolve(expandEnv(a.out)) : path.join(desktop, a.name + '.lnk'),
    target: expandEnv(a.target || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')),
    args: a.args ? expandEnv(a.args) : '',
    workDir: a.cwd ? expandEnv(a.cwd) : '',
    desc: a.desc || '',
    icon: a.icon ? expandEnv(a.icon) : '',
  };

  CoInitializeEx(null, 2); // COINIT_APARTMENTTHREADED
  let ok = true;
  try {
    console.log('将创建:', job.lnkPath);
    console.log('  target :', job.target, fs.existsSync(job.target) ? '' : '  <- 注意：文件不存在');
    if (job.args) console.log('  args   :', job.args);
    if (job.workDir) console.log('  cwd    :', job.workDir, fs.existsSync(job.workDir) ? '' : '  <- 注意：目录不存在');
    if (job.icon) console.log('  icon   :', job.icon, fs.existsSync(job.icon) ? '' : '  <- 注意：图标不存在');
    console.log();

    fs.mkdirSync(path.dirname(job.lnkPath), { recursive: true });
    writeShortcut(job);

    const size = fs.statSync(job.lnkPath).size;
    const back = readBack(job.lnkPath);
    const raw = fs.readFileSync(job.lnkPath);

    const checks = {
      'target 读回一致': !!back && back.target.toLowerCase() === job.target.toLowerCase(),
      'args 读回一致': !!back && back.args === job.args,
      'desc 读回一致': !!back && back.desc === job.desc,
      '文件非空': size > 0,
    };
    if (job.icon) {
      checks['图标路径已写入'] = raw.includes(Buffer.from(path.basename(job.icon), 'utf16le'));
    }

    console.log('--- 读回校验 ---');
    console.log('  target :', back && back.target);
    console.log('  args   :', back && back.args);
    console.log('  desc   :', back && back.desc);
    console.log('  体积   :', size, 'B');
    for (const [k, v] of Object.entries(checks)) {
      if (!v) ok = false;
      console.log((v ? '  [OK]   ' : '  [FAIL] ') + k);
    }
  } catch (e) {
    ok = false;
    console.log('  [FAIL] ' + e.message);
  } finally {
    CoUninitialize();
  }
  return ok ? 0 : 1;
}

process.exit(main());
