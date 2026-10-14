/**
 * LaunchPad · 项目启动面板
 * 零依赖 Node.js 后端：项目扫描 / 启动方式分析 / 进程管理 / 状态与日志推送
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync, execSync } = require('child_process');
const crypto = require('crypto');

const APP_NAME = 'LaunchPad · 项目启动面板';
const APP_VERSION = '1.1.28';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'projects.json');
const PANEL_PORT = Number(process.env.PANEL_PORT || 7788);

/* ---------------------------------------------------------------- utils */

const log = (...a) => console.log('[launchpad]', ...a);

function crc32(str) {
  let h = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) h = (h >>> 1) ^ (0xedb88320 & -(h & 1));
  }
  return ((h ^ 0xffffffff) >>> 0);
}
const slugOf = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'p';

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/* ------------------------------------------------------------- platform */

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_UNIX = !IS_WIN; // macOS / Linux
/** 用系统默认方式打开目录或 URL（Windows: explorer / macOS: open / Linux: xdg-open） */
function openWithSystem(target) {
  try {
    if (IS_WIN) spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref();
    else if (IS_MAC) spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

/* ---------------------------------------------------------------- config */

const DEFAULT_BASE_DIR = IS_WIN ? 'D:\\@DevCode\\002-project' : os.homedir();
let config = { baseDir: DEFAULT_BASE_DIR, port: PANEL_PORT, projects: [], removedRoots: [] };

function loadConfig() {
  const c = readJsonSafe(CONFIG_FILE, null);
  if (c && Array.isArray(c.projects)) config = Object.assign(config, c);
  else saveConfig();
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ensureDir(DATA_DIR);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }, 120);
}

/* --------------------------------------------------- system toolchain detection */

const toolCache = {}; // tool -> version string | null
const TOOL_CMDS = {
  node: 'node -v',
  npm: 'npm -v',
  python: 'python --version',
  python3: 'python3 --version',
  pip: 'pip --version',
  java: 'java -version',
  maven: 'mvn -v',
  git: 'git --version',
  dotnet: 'dotnet --version',
};
// 探测输出是 shell 报错（命令不存在等）→ 视为未安装，避免把报错文本缓存成"版本号"
const TOOL_FAIL_RE = /command not found|not recognized|unable to locate|no such file|operation not permitted/i;

function detectTool(name) {
  if (toolCache[name] !== undefined) return toolCache[name];
  const cmd = TOOL_CMDS[name];
  if (!cmd) return (toolCache[name] = null);
  const grab = (text) => {
    if (!text || TOOL_FAIL_RE.test(String(text))) return null;
    const t = String(text).replace(/,/g, '.');
    const m = t.match(/(\d+\.\d+(\.\d+)?(_\d+)?)/);
    return m ? m[1] : (String(text).trim().split(/\r?\n/)[0] || null);
  };
  // 策略 1：spawnSync + shell；策略 2：execSync（2>&1 合并 stderr，java -version 等走 stderr 的也能取到）
  try {
    const r = spawnSync(`${cmd} 2>&1`, { shell: true, encoding: 'utf8', timeout: 8000, windowsHide: true });
    const v = grab(`${r.stdout || ''}\n${r.stderr || ''}`);
    if (v) return (toolCache[name] = v);
  } catch { /* fallthrough */ }
  try {
    return (toolCache[name] = grab(execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })));
  } catch { return (toolCache[name] = null); }
}
function detectAllTools() {
  const out = {};
  for (const t of Object.keys(TOOL_CMDS)) out[t] = detectTool(t);
  return out;
}

/** 单工具异步探测（并行预热用）：spawn + shell，超时 6s。失败不写缓存，留给同步 detectTool 兜底 */
function detectToolAsync(name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; if (v == null) delete toolCache[name]; else toolCache[name] = v; resolve(v); } };
    try {
      const c = spawn(`${TOOL_CMDS[name]} 2>&1`, { shell: true, windowsHide: true });
      let out = '';
      const t = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } finish(null); }, 6000);
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('close', () => { clearTimeout(t); finish(grabVer(out)); });
      c.on('error', () => { clearTimeout(t); finish(null); });
    } catch { finish(null); }
  });
}
function grabVer(text) {
  if (!text || TOOL_FAIL_RE.test(String(text))) return null;
  const t = String(text).replace(/,/g, '.');
  const m = t.match(/(\d+\.\d+(\.\d+)?(_\d+)?)/);
  return m ? m[1] : (String(t).trim().split(/\r?\n/)[0] || null);
}

const TOOLS_TTL = 10 * 60 * 1000; // 工具缓存 10 分钟后台刷新：新装工具无需重启面板
let toolsWarmed = false;
/** 后台并行预热工具缓存：面板秒起，首屏请求不再被串行探测阻塞 */
async function warmTools() {
  const names = Object.keys(TOOL_CMDS);
  try { await Promise.all(names.map((n) => detectToolAsync(n))); } catch { /* ignore */ }
  toolsWarmed = true;
  log(`工具链探测完成：${names.filter((n) => toolCache[n]).length}/${names.length} 可用`);
  setTimeout(() => { warmTools().catch(() => {}); }, TOOLS_TTL).unref?.();
}

/** required: ">=22.5.0" | ">=18.17" | null ; installed: "22.21.0" */
function versionSatisfied(required, installed) {
  if (!required) return !!installed;
  if (!installed) return false;
  const m = String(required).match(/([\d.]+)/);
  if (!m) return !!installed;
  const req = m[1].split('.').map((n) => parseInt(n, 10) || 0);
  const ins = String(installed).split(/[._]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = ins[i] || 0, b = req[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

/* ---------------------------------------------------------------- analyzer */

const IGNORE_DIRS = new Set(['node_modules', '__pycache__', '.git', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv', 'coverage', '.idea', '.vscode', 'data', 'uploads', 'samples', 'test_output', 'output', 'img-bak']);
const MANIFESTS = ['package.json', 'pom.xml', 'build.gradle', 'requirements.txt', 'pyproject.toml'];

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readTextSafe(p, max = 400 * 1024) {
  try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return ''; }
}
function readJsonFile(p) { return readJsonSafe(p, null); }

/** 在项目根目录中嗅探服务端口号 */
function sniffPort(root, extraTexts = []) {
  const texts = [];
  for (const f of ['run.bat', 'start.bat', 'start.cmd', 'run.cmd', 'serve.bat', 'run.sh', 'start.sh', 'serve.sh']) {
    if (exists(path.join(root, f))) texts.push(readTextSafe(path.join(root, f), 20 * 1024));
  }
  // 常见入口 + server/ 目录下的直接文件
  const candidates = ['server.js', 'app.js', 'index.js', 'main.js', 'server/index.js', 'server/index.mjs', 'server/main.mjs', 'server/config.js', 'server/config.mjs', 'config.js', 'config.mjs', 'src/index.js', 'src/app.js', 'server/app.js'];
  try {
    const sdir = path.join(root, 'server');
    if (isDir(sdir)) {
      for (const f of fs.readdirSync(sdir)) {
        if (/\.(js|mjs|cjs|ts)$/.test(f) && candidates.length < 40) candidates.push('server/' + f);
      }
    }
  } catch { /* ignore */ }
  let scanned = 0;
  for (const rel of [...new Set(candidates)]) {
    if (scanned > 26) break;
    const abs = path.join(root, rel);
    if (exists(abs)) { texts.push(readTextSafe(abs, 200 * 1024)); scanned++; }
  }
  // package.json scripts / 静态命令中的端口
  const pkg = readJsonFile(path.join(root, 'package.json'));
  if (pkg && pkg.scripts) texts.push(JSON.stringify(pkg.scripts));
  texts.push(...extraTexts);
  for (const t of texts) {
    if (!t) continue;
    let m = t.match(/--port[= ](\d{2,5})/) || t.match(/PORT\s*\|\|\s*(\d{2,5})/) ||
            t.match(/http\.server\s+(\d{2,5})/) || t.match(/listen\([^)]*?(\d{4,5})/) ||
            t.match(/localhost:(\d{4,5})/);
    if (m) return Number(m[1]);
  }
  return null;
}

const FRAMEWORK_PORT = { next: 3000, vite: 5173, 'react-scripts': 3000, nuxt: 3000, webpack: 8080 };

/** 从 README H1 / package.json 提取项目标题与一句话描述 */
function extractMeta(root) {
  let title = '', desc = '';
  for (const f of ['README.md', 'readme.md', 'README.txt', 'readme.txt']) {
    const t = readTextSafe(path.join(root, f), 8 * 1024);
    if (!t) continue;
    const h1 = t.split(/\r?\n/).find((l) => /^#\s+\S/.test(l));
    if (!h1) continue;
    let s = h1.replace(/^#+\s+/, '').trim();
    s = s.replace(/^[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]+\s*/u, '').trim();
    if (!s) continue;
    const segs = s.split(/\s+·\s+/);
    title = segs[0].trim();
    if (segs.length > 1) desc = segs.slice(1).join(' · ');
    break;
  }
  const pkg = readJsonFile(path.join(root, 'package.json'));
  const pd = pkg && pkg.description ? String(pkg.description).trim() : '';
  if (pd) {
    const main = pd.split(/\s*[—–]\s*/)[0].trim();
    const after = pd.slice(main.length).replace(/^[—–\s]+/, '').trim();
    if (!title) {
      const segs = main.split(/\s+·\s+/);
      title = segs[0].trim();
      if (!desc && segs.length > 1) desc = segs.slice(1).join(' · ');
    }
    // 合成描述：主句(去掉与标题重复的前缀) + 破折号后的补充说明
    const strip = (s) => title && s.toLowerCase().startsWith(title.toLowerCase()) ? s.slice(title.length).replace(/^\s*·\s*/, '') : s;
    const parts = [];
    if (main && main !== title) { const m = strip(main); if (m) parts.push(m); }
    if (after) parts.push(after);
    const candidate = parts.join(' · ');
    if (candidate) desc = (desc && desc.length > 16) ? `${desc} · ${candidate}` : candidate;
  }
  title = title.replace(/\s*[（(][^（）()]*[)）]\s*$/, '').trim();
  // "英文名 / 中文名"形式：中文部分并入描述
  if (title.includes(' / ')) {
    const segs = title.split(/\s+\/\s+/);
    const cjkSeg = segs.find((s) => /[\u4e00-\u9fff]/.test(s));
    if (cjkSeg && segs[0] !== cjkSeg) {
      title = segs[0].trim();
      desc = cjkSeg + (desc ? ' · ' + desc : '');
    }
  }
  // 描述以标题前缀开头时去冗余（如标题 IDENTIFY 2.0，描述 "IDENTIFY · …"）
  if (desc && title && desc.toLowerCase().startsWith(title.toLowerCase().split(' ')[0])) {
    const stripped = desc.slice(title.split(' ')[0].length).replace(/^\s*·\s*/, '');
    if (stripped && stripped !== desc) desc = stripped;
  }
  if (desc.length > 72) desc = desc.slice(0, 71).replace(/[，,、\s]+$/, '') + '…';
  return { title, desc };
}


function analyzeProject(rootAbs) {
  const res = analyzeProjectBase(rootAbs);
  if (res) Object.assign(res, extractMeta(path.resolve(rootAbs)));
  return res;
}

function analyzeProjectBase(rootAbs) {
  const root = path.resolve(rootAbs);
  const res = {
    root,
    type: 'unknown',           // node | python | java | dotnet | static | desktop | unknown
    kind: '',                  // web | desktop | static | cli | service
    name: '',
    runCmd: null,
    runCwd: '',
    port: null,
    requiredEnv: [],
    meta: {},
  };
  if (!isDir(root)) return null;

  const topName = path.basename(root);

  /* ---- Node ---- */
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJsonFile(pkgPath);
  if (pkg && typeof pkg === 'object') {
    res.type = 'node';
    res.name = (pkg.name && String(pkg.name)) || topName;
    const scripts = pkg.scripts || {};
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const depStr = Object.keys(deps).join(' ') + ' ' + JSON.stringify(scripts);
    // 启动脚本选择：Next/Vite 等框架优先 dev；dev 是 watch/build 任务且有 serve 时避开 dev
    const devIsWatch = scripts.dev && /--watch|\bwatch\b|\bbuild\b/.test(scripts.dev);
    const devPreferred = /next|vite|nuxt|webpack-dev/.test(depStr);
    const order = devPreferred ? ['dev', 'start', 'serve'] : ['start', 'serve', 'dev'];
    const script = order.find((s) => scripts[s] && !(s === 'dev' && devIsWatch && scripts.serve))
      || (devIsWatch && scripts.serve ? 'serve' : null);
    res.meta.script = script || null;
    res.meta.hasDeps = Object.keys(deps).length > 0;
    res.meta.depsMissing = res.meta.hasDeps && !exists(path.join(root, 'node_modules'));
    // 框架识别
    const fw = [['next', 'Next.js'], ['nuxt', 'Nuxt'], ['vite', 'Vite'], ['nest', 'NestJS'], ['express', 'Express'], ['react-scripts', 'React']];
    for (const [k, label] of fw) { if (depStr.includes(k)) { res.meta.framework = label; break; } }
    // 端口
    let port = sniffPort(root);
    if (!port && res.meta.framework) {
      for (const [k, p] of Object.entries(FRAMEWORK_PORT)) if (depStr.includes(k)) { port = p; break; }
    }
    res.port = port;
    res.runCmd = script ? `npm run ${script}` : (pkg.main && exists(path.join(root, pkg.main)) ? `node "${pkg.main}"` : null);
    res.kind = res.runCmd ? 'web' : '';
    // 没有 npm script 也无 main 入口、但存在 index.html → 按静态站点处理
    if (!res.runCmd && exists(path.join(root, 'index.html'))) {
      res.type = 'static'; res.kind = 'static';
      delete res.meta.framework; // 类型徽标已表达，避免标签重复
      res.runCmd = null; res.requiredEnv = [{ tool: 'python', req: null }];
      return res;
    }
    res.requiredEnv = [{ tool: 'node', req: (pkg.engines && pkg.engines.node) || null }];
    if (res.meta.hasDeps) res.requiredEnv.push({ tool: 'npm', req: null });
    return res;
  }

  /* ---- Python ---- */
  const reqTxt = path.join(root, 'requirements.txt');
  const hasReq = exists(reqTxt);
  const hasPy = hasReq || exists(path.join(root, 'pyproject.toml')) ||
    fs.readdirSync(root).some((f) => f.endsWith('.py'));
  if (hasPy) {
    res.type = 'python';
    res.requiredEnv = [{ tool: 'python', req: null }];
    res.meta.hasReq = hasReq;
    const reqText = hasReq ? readTextSafe(reqTxt, 40 * 1024).toLowerCase() : '';
    const isWeb = /flask|fastapi|uvicorn|django|tornado|waitress|gunicorn/.test(reqText);
    // 启动脚本优先（按平台选择脚本类型）
    const bat = (IS_WIN
      ? ['run.bat', 'start.bat', 'start.cmd', 'run.cmd']
      : ['run.sh', 'start.sh', 'serve.sh']).find((f) => exists(path.join(root, f)));
    if (bat) {
      const batText = readTextSafe(path.join(root, bat), 20 * 1024);
      if (IS_WIN) {
        const cd = batText.match(/cd\/d\s+"?%~dp0([^"\r\n]*)"?/i);
        if (cd && cd[1].trim()) res.runCwd = path.join(root, cd[1].trim());
        res.runCmd = `cmd /c "${bat}"`;
      } else {
        res.runCmd = `sh "${bat}"`;
      }
      const p = batText.match(/--port[= ](\d{2,5})/) || batText.match(/:(\d{4,5})/);
      if (p) res.port = Number(p[1]);
      res.kind = isWeb || res.port ? 'web' : 'cli';
      res.meta.entry = bat;
      return res;
    }
    if (exists(path.join(root, 'manage.py'))) {
      res.runCmd = 'python manage.py runserver';
      res.port = res.port || 8000;
      res.kind = 'web';
      res.meta.framework = 'Django';
      return res;
    }
    const entryCandidates = ['app.py', 'src/app.py', 'main.py', 'server.py', 'webui.py', 'run.py'];
    const entry = entryCandidates.find((f) => exists(path.join(root, f)));
    if (entry && isWeb) {
      const mod = path.basename(entry, '.py');
      res.runCwd = path.dirname(path.join(root, entry)) !== root ? path.dirname(path.join(root, entry)) : '';
      res.runCmd = `python -m uvicorn ${mod}:app --host 0.0.0.0 --port ${res.port || 8000}`;
      res.port = res.port || 8000;
      res.kind = 'web';
      res.meta.framework = /fastapi/.test(reqText) ? 'FastAPI' : 'Flask/WSGI';
      res.meta.entry = entry;
      return res;
    }
    if (entry) {
      res.runCmd = `python "${entry}"`;
      res.meta.entry = entry;
      // tkinter / PyQt 等 GUI 程序
      const code = readTextSafe(path.join(root, entry), 300 * 1024);
      if (/import\s+tkinter|from\s+tkinter|PyQt|PySide/.test(code)) {
        res.kind = 'desktop';
        res.meta.framework = '桌面 GUI (Python)';
      } else { res.kind = 'cli'; }
      return res;
    }
    res.kind = isWeb ? 'web' : 'cli';
    return res; // runCmd 为空 → 未配置
  }

  /* ---- Java / Maven ---- */
  if (exists(path.join(root, 'pom.xml'))) {
    res.type = 'java';
    res.kind = 'web';
    res.meta.framework = 'Maven';
    res.runCmd = 'mvn spring-boot:run';
    res.requiredEnv = [{ tool: 'java', req: null }, { tool: 'maven', req: null }];
    res.port = sniffPort(root, [readTextSafe(path.join(root, 'src/main/resources/application.properties'), 20 * 1024), readTextSafe(path.join(root, 'src/main/resources/application.yml'), 20 * 1024)]);
    return res;
  }
  if (fs.readdirSync(root).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
    res.type = 'dotnet';
    res.kind = 'web';
    res.runCmd = 'dotnet run';
    res.requiredEnv = [{ tool: 'dotnet', req: null }];
    return res;
  }

  /* ---- 静态站点 ---- */
  if (exists(path.join(root, 'index.html'))) {
    res.type = 'static';
    res.kind = 'static';
    res.meta.framework = '静态站点';
    return res; // port/runCmd 由注册时统一分配
  }

  return res;
}

function suggestStaticPort(p) {
  const used = new Set(config.projects.map((x) => x.port).filter(Boolean));
  let port = 8100 + (crc32(p.root) % 800);
  while (used.has(port)) port++;
  return port;
}

/** 静态站点启动命令：python 缺失时回退 python3（现代 macOS 默认无裸 python 命令，否则启动即 127 崩溃） */
function staticServeCmd(port) {
  const bin = detectTool('python') ? 'python' : (detectTool('python3') ? 'python3' : 'python');
  return `${bin} -m http.server ${port} --bind 0.0.0.0`;
}

function finalizeStatic(p) {
  p.port = p.port || suggestStaticPort(p);
  p.runCmd = staticServeCmd(p.port);
  p.requiredEnv = [{ tool: p.runCmd.startsWith('python3') ? 'python3' : 'python', req: null }];
}

/* ---------------------------------------------------------------- discovery / scan */

function findProjectRoots(baseDir) {
  const found = [];
  let tops = [];
  // 顶层同样跳过隐藏目录：根目录设在用户主目录时，避免把 .Trash/.npm/.nvm/.cursor 等当项目扫进来
  try { tops = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return found; }
  for (const top of tops) {
    if (/^000-/.test(top)) continue; // 跳过工具目录
    const topAbs = path.join(baseDir, top);
    let entries = [];
    try { entries = fs.readdirSync(topAbs, { withFileTypes: true }); } catch { continue; }
    const dirs = entries.filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name) && !d.name.startsWith('.')).map((d) => d.name);
    const files = entries.filter((d) => d.isFile()).map((d) => d.name);
    const topHasManifest = files.some((f) => MANIFESTS.includes(f)) || files.includes('index.html') ||
      files.some((f) => f.endsWith('.py') || f.endsWith('.csproj') || f.endsWith('.sln'));
    if (topHasManifest) found.push(topAbs);
    for (const d of dirs) {
      const sub = path.join(topAbs, d);
      let subFiles = [];
      try { subFiles = fs.readdirSync(sub).filter((f) => { try { return fs.statSync(path.join(sub, f)).isFile(); } catch { return false; } }); } catch { continue; }
      if (subFiles.some((f) => MANIFESTS.includes(f)) || subFiles.includes('index.html')) { found.push(sub); continue; }
      // 第三层：如 004-blog/Blog/1 —— 子目录本身无清单但其下级有
      let subDirs = [];
      try { subDirs = fs.readdirSync(sub, { withFileTypes: true }).filter((x) => x.isDirectory() && !IGNORE_DIRS.has(x.name) && !x.name.startsWith('.')).map((x) => x.name); } catch { continue; }
      for (const sd of subDirs) {
        const deep = path.join(sub, sd);
        let deepFiles = [];
        try { deepFiles = fs.readdirSync(deep).filter((f) => { try { return fs.statSync(path.join(deep, f)).isFile(); } catch { return false; } }); } catch { continue; }
        if (deepFiles.some((f) => MANIFESTS.includes(f)) || deepFiles.includes('index.html')) found.push(deep);
      }
    }
  }
  return found;
}

function stripPrefix(s) { return s.replace(/^(\d{3})-/, ''); }

/** 是否位于当前根目录之外（含跨盘符的绝对路径） */
function isOutsideBase(rootAbs) {
  const rel = path.relative(path.resolve(config.baseDir), path.resolve(rootAbs));
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

/** 项目显示名：根目录下 → 目录名；嵌套 → 顶层名 · 末级名(不同时) */
function projectNameFor(root) {
  const base = path.resolve(config.baseDir);
  const rel = path.relative(base, root);
  // 根目录之外（含跨盘符的绝对路径）→ 直接用目录名
  if (!rel || rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) return stripPrefix(path.basename(root));
  const segs = rel.split(/[\\/]+/).filter(Boolean).map(stripPrefix);
  if (segs.length === 1) return segs[0];
  const last = segs[segs.length - 1];
  return last !== segs[0] ? `${segs[0]} · ${last}` : segs[0];
}

function registerProject(rootAbs, opts = {}) {
  const root = path.resolve(rootAbs);
  if (config.projects.some((p) => path.resolve(p.root) === root)) return null; // 已存在
  // 用户显式移除过的项目：扫描不再自动添加，仅手动添加（force）可恢复
  const rootKey = root.toLowerCase();
  if (!opts.force && (config.removedRoots || []).includes(rootKey)) return null;
  if (opts.force) config.removedRoots = (config.removedRoots || []).filter((k) => k !== rootKey);
  const a = analyzeProject(root);
  if (!a || a.type === 'unknown' && !opts.force) return null;
  if (a.type === 'static') finalizeStatic(a);
  const id = 'p' + crc32(root).toString(36);
  const proj = {
    id,
    name: opts.name || projectNameFor(root),
    title: '',
    desc: '',
    root,
    manual: !!opts.manual, // 手动添加：即使位于根目录外也保留展示
    type: a.type,
    kind: a.kind,
    runCmd: a.runCmd,
    runCwd: a.runCwd || '',
    port: a.port || null,
    requiredEnv: a.requiredEnv || [],
    meta: a.meta || {},
    createdAt: Date.now(),
  };
  // 展示标题：来自 README/描述；重复时追加目录名区分
  proj.title = (a.title || '').trim();
  proj.desc = a.desc || '';
  if (proj.title) {
    const dup = config.projects.some((x) => x.title === proj.title);
    if (dup) proj.title = `${proj.title} · ${stripPrefix(path.basename(root))}`;
  }
  config.projects.push(proj);
  saveConfig();
  return proj;
}

/** 清理根目录外的扫描项目：切换根目录/重新扫描后，旧根目录扫进来的项目不再保留（手动添加的不受影响） */
function pruneOutsideProjects() {
  const stale = config.projects.filter((p) => !p.manual && isOutsideBase(p.root));
  if (!stale.length) return 0;
  for (const p of stale) { try { stopProject(p.id); } catch { /* ignore */ } }
  const staleIds = new Set(stale.map((p) => p.id));
  config.projects = config.projects.filter((p) => !staleIds.has(p.id));
  saveConfig();
  for (const p of stale) pushStatus(p.id); // 广播移除，前端即时清掉对应卡片
  return stale.length;
}

/* ---------------------------------------------------------------- runtime management */

/** id -> { proc, status, pid, startedAt, exitCode, stoppedByUser, health, adopted, logs:[], clients:Set } */
const runtime = new Map();

function getRT(id, create = true) {
  let rt = runtime.get(id);
  if (!rt && create) {
    rt = { proc: null, status: 'stopped', pid: null, startedAt: null, exitCode: null, stoppedByUser: false, health: 'unknown', adopted: false, logs: [], pending: [], flushTimer: null, task: null };
    runtime.set(id, rt);
  }
  return rt;
}

const sseClients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { sseClients.delete(res); } }
}

function publicStatus(id) {
  const p = config.projects.find((x) => x.id === id);
  const rt = getRT(id, false) || { status: 'stopped', pid: null, startedAt: null, exitCode: null, health: 'unknown' };
  return {
    id, status: rt.status, pid: rt.pid, startedAt: rt.startedAt, exitCode: rt.exitCode,
    health: rt.health, adopted: !!rt.adopted, task: rt.task || null,
    uptime: rt.startedAt && (rt.status === 'running' || rt.status === 'starting') ? Date.now() - rt.startedAt : 0,
  };
}
function pushStatus(id) {
  noteStatus(id);
  const p = config.projects.find((x) => x.id === id);
  broadcast({ type: 'status', project: p ? Object.assign({}, p, { runtime: publicStatus(id), portWatch: watchInfo(id) }) : { id, removed: true }, system: { tools: toolCache } });
}

/* ------------------------------------------------- 状态历史（时序图数据源）
   所有状态变迁最终都会走 pushStatus → noteStatus 记账：
   starting 归并为 running、stopping 归并为 stopped（瞬时过渡不产生独立区间）；
   lastNoted 去重使重复 pushStatus 无副作用；持久化 data/status-history.json（上限 5000 条，7 天自然衰减）。 */
const HISTORY_FILE = path.join(DATA_DIR, 'status-history.json');
const DAY = 24 * 3600 * 1000;
let history = readJsonSafe(HISTORY_FILE, [])
  .filter((x) => x && x.id && x.t && x.st && Date.now() - x.t < 7 * DAY)
  .slice(-5000);
let historySaveTimer = null;
function scheduleHistorySave() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8'); } catch { /* ignore */ }
  }, 500);
}
const lastNoted = new Map();
const normSt = (st) => (st === 'starting' ? 'running' : st === 'stopping' ? 'stopped' : st);
function noteStatus(id) {
  const rt = getRT(id, false);
  const st = normSt(rt ? rt.status : 'stopped');
  if (lastNoted.get(id) === st) return;
  lastNoted.set(id, st);
  history.push({ id, t: Date.now(), st });
  if (history.length > 5000) history.splice(0, history.length - 5000);
  scheduleHistorySave();
}

function appendLog(id, stream, text) {
  const rt = getRT(id);
  const line = { t: Date.now(), s: stream, x: text };
  rt.logs.push(line);
  if (rt.logs.length > 900) rt.logs.splice(0, rt.logs.length - 900);
  rt.pending.push(line);
  if (!rt.flushTimer) {
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      if (rt.pending.length) {
        broadcast({ type: 'log', id, lines: rt.pending });
        rt.pending = [];
      }
    }, 150);
  }
}

function procAlive(pid) {
  if (!pid) return false;
  // EPERM = 信号 0 探测被权限拒绝，但进程存在（macOS/Linux 上常见于系统进程）
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/* ---------------- 服务进程识别与按端口接管 ----------------
 * 背景:Windows 上 spawn(shell:true) 的 child.pid 是 cmd 包装进程,
 * 实测包装 cmd 可能先于真实服务进程退出(如面板被关、控制台回收)。
 * 若只按包装 PID 判存活,重启面板后会误判"项目已停止"而端口仍在服务。
 * 因此:接管/判停均支持降级到「按端口找到真实监听进程」。 */

/** 归一化进程名：取 basename、统一小写（Windows tasklist 带 .exe，macOS/Linux ps 的 comm 可能是全路径） */
function normProcName(nm) {
  return String(nm || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

/** 视为服务运行时的进程名(小写):按端口接管时避免误绑无关进程 */
const SERVICE_PROC_NAMES = new Set([
  // Windows
  'node.exe', 'python.exe', 'pythonw.exe', 'python3.exe', 'python313.exe', 'python312.exe', 'python311.exe',
  'java.exe', 'javaw.exe', 'dotnet.exe', 'deno.exe', 'bun.exe', 'php.exe', 'ruby.exe',
  // macOS / Linux
  'node', 'python', 'python3', 'pythonw', 'python3.13', 'python3.12', 'python3.11', 'python3.10',
  'java', 'dotnet', 'deno', 'bun', 'php', 'ruby',
]);

/** 从监听端口的 PID 中挑选可接管的服务进程(排除面板自身/系统进程/已被其他项目认领的 PID) */
function pickServicePid(pids, takenPids, names) {
  for (const pid of pids) {
    if (!pid || pid === process.pid || pid <= 4 || takenPids.has(pid)) continue;
    const nm = names.get(pid);
    if (nm && SERVICE_PROC_NAMES.has(normProcName(nm))) return pid;
  }
  return null;
}

/** 单端口便捷查询:返回可接管的服务 PID(内部查端口表 + 进程名表) */
function pickPortServicePid(port, extraExclude = []) {
  if (!port) return null;
  const pids = portPids(port).filter((x) => !extraExclude.includes(x));
  if (!pids.length) return null;
  return pickServicePid(pids, new Set(), allProcessNames());
}

/* ------------------------------------------------- 端口占用查询与释放 */

const SYNC_EXEC_OPTS = { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };

/** Windows: netstat -ano 解析 LISTENING 行 → 端口对应 PID 列表 */
function portPidsWin(port, out) {
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === Number(port)) pids.add(Number(m[2]));
  }
  return [...pids];
}

/** macOS/Linux: lsof -nP -iTCP -sTCP:LISTEN 输出解析
 *  列: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME —— NAME 形如 *:3000 / 127.0.0.1:3000 / [::]:3000 */
function parseLsofListen(out) {
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9 || cols[1] === 'PID') continue;
    const m = cols[8].match(/:(\d+)$/);
    if (m && /^TCP$/i.test(cols[7])) rows.push({ port: Number(m[1]), pid: Number(cols[1]) });
  }
  return rows;
}

/** 返回正在监听指定端口的 PID 列表（Windows: netstat / macOS·Linux: lsof） */
function portPids(port) {
  try {
    if (IS_WIN) return portPidsWin(port, execSync('netstat -ano -p tcp', SYNC_EXEC_OPTS));
    const pids = new Set();
    for (const r of parseLsofListen(execSync('lsof -nP -iTCP -sTCP:LISTEN', SYNC_EXEC_OPTS))) {
      if (r.port === Number(port)) pids.add(r.pid);
    }
    return [...pids];
  } catch { return []; }
}

/** 进程名（Windows: tasklist / macOS·Linux: ps -o comm=，取 basename） */
function pidName(pid) {
  if (IS_WIN) {
    try {
      const out = execSync(`tasklist /fo csv /nh /fi "PID eq ${pid}"`, SYNC_EXEC_OPTS);
      const line = out.split(/\r?\n/).find((l) => l.trim());
      const parts = line && line.match(/"([^"]+)"/g);
      return parts && parts[0] ? parts[0].replace(/"/g, '') : 'unknown';
    } catch { return 'unknown'; }
  }
  try {
    const out = execSync(`ps -p ${Number(pid)} -o comm=`, SYNC_EXEC_OPTS);
    const s = (out.trim().split(/\r?\n/)[0] || '').trim();
    return s ? s.split('/').pop() : 'unknown';
  } catch { return 'unknown'; }
}

function portOccupants(port) {
  return portPids(port).map((pid) => ({
    pid,
    name: pidName(pid),
    isPanel: pid === process.pid,
  }));
}

/** 系统全部 TCP LISTENING 端口 → port: Set(pid) */
function allListeningPorts() {
  const map = new Map();
  try {
    if (IS_WIN) {
      const out = execSync('netstat -ano -p tcp', SYNC_EXEC_OPTS);
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m) {
          const port = Number(m[1]), pid = Number(m[2]);
          if (!map.has(port)) map.set(port, new Set());
          map.get(port).add(pid);
        }
      }
    } else {
      for (const r of parseLsofListen(execSync('lsof -nP -iTCP -sTCP:LISTEN', SYNC_EXEC_OPTS))) {
        if (!map.has(r.port)) map.set(r.port, new Set());
        map.get(r.port).add(r.pid);
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** 全量进程表 pid → 进程名（一次 tasklist / ps，避免逐 PID 查询） */
function allProcessNames() {
  const map = new Map();
  try {
    if (IS_WIN) {
      const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const line of out.split(/\r?\n/)) {
        const cols = line.match(/"([^"]*)"/g);
        if (cols && cols.length >= 2) map.set(Number(cols[1].replace(/"/g, '')), cols[0].replace(/"/g, ''));
      }
    } else {
      const out = execSync('ps -axo pid=,comm=', SYNC_EXEC_OPTS);
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m) map.set(Number(m[1]), m[2].trim().split('/').pop());
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** 跨平台强制终止进程（树）：返回是否执行成功 */
function killTree(pid) {
  if (IS_WIN) {
    try { return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }).status === 0; }
    catch { return false; }
  }
  // Unix：优先整组 SIGKILL（配合 detached 进程组），组不存在则单杀
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } }
}

function startProject(id) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) return { error: '项目不存在' };
  const rt = getRT(id);
  if (rt.status === 'running' || rt.status === 'starting') return { error: '项目已在运行中' };
  if (rt.status === 'installing') return { error: '依赖安装中，请稍候' };
  if (!p.runCmd) return { error: '未配置启动命令，请先在详情中设置' };

  const cwd = p.runCwd || p.root;
  if (!isDir(cwd)) return { error: '工作目录不存在: ' + cwd };

  rt.status = 'starting'; rt.exitCode = null; rt.stoppedByUser = false; rt.startedAt = Date.now();
  pushStatus(id);
  appendLog(id, 'sys', `▶ 启动: ${p.runCmd}   (cwd: ${cwd})`);

  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
  if (p.port && ['node', 'python', 'java', 'dotnet', 'static'].includes(p.type)) env.PORT = String(p.port);

  // 端口占用预警：帮助定位"启动即退出"的端口冲突问题
  if (p.port) {
    const occ = portOccupants(p.port).filter((x) => !x.isPanel && x.pid !== rt.pid);
    if (occ.length) appendLog(id, 'sys', `⚠ 端口 ${p.port} 已被 PID ${occ[0].pid} (${occ[0].name}) 占用 — 若启动失败，可在详情「端口占用」中释放端口`);
  }

  try {
    // Unix 下 detached 使子进程成为独立会话/进程组长（组长 PID = 进程组 ID），
    // 停止时 kill(-pid) 可终止整棵进程树，面板退出也不连带项目 —— 与 Windows taskkill /T 行为对齐
    const child = spawn(p.runCmd, { shell: true, cwd, env, windowsHide: true, detached: IS_UNIX });
    rt.proc = child; rt.pid = child.pid;
    appendLog(id, 'sys', `进程已创建 · PID ${child.pid}`);
    p.runtimePid = child.pid; p.startedAt = rt.startedAt;
    // 运行履历：累计启动次数 + 最近一次启动时间（持久化，卡片/抽屉展示）
    p.runCount = (p.runCount || 0) + 1; p.lastRunAt = rt.startedAt; saveConfig();

    const pipe = (streamName) => (chunk) => {
      String(chunk).split(/\r?\n/).filter((l) => l.length).forEach((l) => appendLog(id, streamName, l));
    };
    child.stdout && child.stdout.on('data', pipe('out'));
    child.stderr && child.stderr.on('data', pipe('err'));
    child.on('error', (e) => { appendLog(id, 'err', '进程错误: ' + e.message); });

    child.on('exit', (code, signal) => {
      if (rt.proc !== child) return;
      rt.proc = null;
      const wasUser = rt.stoppedByUser;
      // 包装 cmd 可能先于真实服务退出:服务已确认监听过(health ready)且非用户停止 → 升级为端口监控,保持运行
      if (!wasUser && rt.health === 'ready' && p.port) {
        const pid = pickPortServicePid(p.port, [child.pid]);
        if (pid) {
          rt.pid = pid; rt.adopted = true; rt.adoptDeadline = null; rt.exitCode = null;
          rt.status = 'running';
          p.runtimePid = pid; saveConfig();
          appendLog(id, 'sys', `启动器包装进程退出 (code=${code})，但端口 ${p.port} 仍在服务 (PID ${pid})，已切换为端口监控`);
          pushStatus(id);
          return;
        }
      }
      rt.exitCode = code;
      rt.pid = null;
      rt.health = 'unknown';
      rt.status = wasUser ? 'stopped' : (code === 0 ? 'stopped' : 'crashed');
      p.runtimePid = null; saveConfig();
      appendLog(id, 'sys', wasUser ? `■ 已停止 (退出码 ${code})` : `● 进程退出 · code=${code} ${signal || ''}`);
      pushStatus(id);
    });

    // 启动确认：500ms 存活即转 running（原固定等 1.5s，反馈偏慢）；死亡复检一次再判崩溃
    const confirmStart = (delay, recheck) => setTimeout(() => {
      if (rt.proc !== child || rt.status !== 'starting') return;
      if (procAlive(child.pid)) { rt.status = 'running'; pushStatus(id); return; }
      if (!recheck) { confirmStart(300, true); return; }
      rt.status = 'crashed';
      appendLog(id, 'err', '进程启动后立即退出，请查看日志');
      pushStatus(id);
    }, delay);
    confirmStart(500, false);
  } catch (e) {
    rt.status = 'crashed';
    appendLog(id, 'err', '启动失败: ' + e.message);
    pushStatus(id);
    return { error: e.message };
  }
  return { ok: true };
}

function stopProject(id) {
  const rt = getRT(id, false);
  if (!rt || (rt.status !== 'running' && rt.status !== 'starting')) return { ok: true };
  rt.stoppedByUser = true;
  rt.status = 'stopping';
  pushStatus(id);
  const pid = rt.pid;
  appendLog(id, 'sys', `■ 正在停止进程 ${pid} …`);
  if (IS_WIN) {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  } else {
    // detached 进程组：整组 SIGTERM；组不存在（接管 PID 非组长）降级单杀
    try { process.kill(-pid, 'SIGTERM'); }
    catch { try { process.kill(pid, 'SIGTERM'); } catch { try { rt.proc && rt.proc.kill('SIGTERM'); } catch { /* ignore */ } } }
  }
  // 停止确认：轮询进程消失即标记（接管型进程无 exit 管道，原固定等满 2.5s 偏慢）；2.5s 兜底
  const markStopped = () => {
    if (rt.status !== 'stopping') return;
    rt.status = 'stopped'; rt.proc = null; rt.pid = null;
    const p = config.projects.find((x) => x.id === id);
    if (p) { p.runtimePid = null; saveConfig(); }
    pushStatus(id);
  };
  const stopWatch = setInterval(() => {
    if (rt.status !== 'stopping') { clearInterval(stopWatch); return; }
    if (!pid || !procAlive(pid)) { clearInterval(stopWatch); markStopped(); }
  }, 250);
  setTimeout(() => { clearInterval(stopWatch); markStopped(); }, 2500);
  return { ok: true };
}

function restartProject(id) {
  const rt = getRT(id, false);
  if (rt && (rt.status === 'running' || rt.status === 'starting')) {
    stopProject(id);
    // 停稳即启（原固定等 1.6s 偏慢）：轮询停止确认后稍作喘息再启动，3s 兜底强行启动
    const t0 = Date.now();
    const tryStart = () => {
      const st = (getRT(id, false) || {}).status;
      if (st === 'stopped' || st === 'crashed') { setTimeout(() => startProject(id), 200); return; }
      if (Date.now() - t0 > 3000) { startProject(id); return; }
      setTimeout(tryStart, 150);
    };
    tryStart();
    return { ok: true, restarting: true };
  }
  return startProject(id);
}

function installDeps(id) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) return { error: '项目不存在' };
  const rt = getRT(id);
  if (rt.status === 'running' || rt.status === 'starting' || rt.status === 'installing') return { error: '项目忙碌中' };
  let cmd = null;
  if (p.type === 'node' && p.meta.hasDeps) cmd = 'npm install';
  else if (p.type === 'python' && p.meta.hasReq) cmd = 'pip install -r requirements.txt';
  else if (p.type === 'node') cmd = 'npm install';
  if (!cmd) return { error: '该项目没有需要安装的依赖清单' };
  rt.status = 'installing'; rt.task = cmd; rt.exitCode = null;
  pushStatus(id);
  appendLog(id, 'sys', `📦 安装依赖: ${cmd}`);
  const child = spawn(cmd, { shell: true, cwd: p.runCwd || p.root, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }), windowsHide: true, detached: IS_UNIX });
  rt.proc = child; rt.pid = child.pid;
  const pipe = (s) => (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((l) => appendLog(id, s, l));
  child.stdout && child.stdout.on('data', pipe('out'));
  child.stderr && child.stderr.on('data', pipe('err'));
  child.on('exit', (code) => {
    if (rt.proc !== child) return;
    rt.proc = null; rt.pid = null; rt.task = null; rt.exitCode = code;
    rt.status = 'stopped';
    appendLog(id, 'sys', code === 0 ? '✅ 依赖安装完成' : `❌ 依赖安装失败 (code=${code})`);
    if (p.type === 'node' && p.meta) p.meta.depsMissing = p.meta.hasDeps && !exists(path.join(p.root, 'node_modules'));
    saveConfig();
    pushStatus(id);
  });
  return { ok: true };
}

/* --------------------------------------------------------------- health checks */

const healthTimer = setInterval(() => {
  for (const p of config.projects) {
    const rt = getRT(p.id, false);
    if (!rt || (rt.status !== 'running' && rt.status !== 'starting')) continue;
    /* 接管项目:不依赖管道 exit 事件,按进程存活自愈/判停。
       修复:原实现 adoptDeadline 过期后不清除,导致宽限期判定条件永久有效——
       端口一次探测抖动就会把运行中的项目误标为停止。 */
    if (rt.adopted) {
      // a) 管理进程消失:包装 cmd 可能先于服务退出 → 优先升级为端口监听进程
      if (!rt.pid || !procAlive(rt.pid)) {
        const pid = p.port ? pickPortServicePid(p.port) : null;
        if (pid) {
          rt.pid = pid; p.runtimePid = pid; rt.adoptDeadline = null; saveConfig();
          appendLog(p.id, 'sys', `管理进程退出，端口 ${p.port} 仍在服务，切换为监控 PID ${pid}`);
          pushStatus(p.id);
        } else {
          rt.status = 'stopped'; rt.pid = null; rt.adopted = false; rt.adoptDeadline = null;
          p.runtimePid = null; saveConfig();
          appendLog(p.id, 'sys', '接管进程已退出，已标记为停止');
          pushStatus(p.id);
          continue;
        }
      }
      // b) 宽限期校验(接管后 9s 一次性):端口必须有监听者,否则视为 PID 被复用
      if (rt.adoptDeadline && Date.now() > rt.adoptDeadline) {
        rt.adoptDeadline = null; // 到期即清除,判定只发生在窗口末端一次
        const pid = p.port ? pickPortServicePid(p.port) : null;
        if (pid && pid !== rt.pid) {
          rt.pid = pid; p.runtimePid = pid; saveConfig();
          appendLog(p.id, 'sys', `接管校验:原 PID 未监听端口，已切换为监听进程 PID ${pid}`);
          pushStatus(p.id);
        } else if (!pid) {
          rt.status = 'stopped'; rt.pid = null; rt.adopted = false;
          p.runtimePid = null; saveConfig();
          appendLog(p.id, 'sys', '接管校验失败(端口未监听，原进程已退出)，已标记为停止');
          pushStatus(p.id);
          continue;
        }
      }
    }
    if (!p.port) { if (rt.health !== 'noport') { rt.health = 'noport'; pushStatus(p.id); } continue; }
    const sock = net.connect({ host: '127.0.0.1', port: Number(p.port) });
    const done = (ok) => { sock.destroy(); const next = ok ? 'ready' : 'waiting'; if (rt.health !== next) { rt.health = next; pushStatus(p.id); } };
    sock.setTimeout(900);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  }
}, 3000);

/* ------------------------------------------------- 未运行项目的端口冲突监控 */

// id -> { sig, occupied, procs:[{pid,name,isPanel}] }：项目未启动但其配置端口被其他进程占用
const portWatch = new Map();

/** 对外下发的占用信息 */
function watchInfo(id) {
  const w = portWatch.get(id);
  return w ? { occupied: w.occupied, procs: w.procs } : { occupied: false, procs: [] };
}

const watchTimer = setInterval(() => {
  try {
    const watching = config.projects.filter((p) => {
      if (!p.port) return false;
      const rt = getRT(p.id, false);
      const st = rt ? rt.status : 'stopped';
      return st === 'stopped' || st === 'crashed';
    });
    if (!watching.length) {
      if (portWatch.size) { portWatch.clear(); config.projects.forEach((p) => pushStatus(p.id)); }
      return;
    }
    const listening = allListeningPorts();
    // 有冲突才查询全量进程名表（省一次 tasklist）
    const names = watching.some((p) => listening.has(Number(p.port))) ? allProcessNames() : null;
    for (const p of watching) {
      const pidSet = listening.get(Number(p.port));
      const procs = pidSet && names ? [...pidSet].map((pid) => ({ pid, name: names.get(pid) || 'unknown', isPanel: pid === process.pid })) : [];
      const sig = procs.map((x) => x.pid).join(',');
      const prev = portWatch.get(p.id);
      if (!prev || prev.sig !== sig) {
        portWatch.set(p.id, { sig, occupied: procs.length > 0, procs });
        pushStatus(p.id); // 占用状态变化时才推送，避免打扰
      }
    }
    for (const id of [...portWatch.keys()]) {
      if (!watching.some((p) => p.id === id)) { portWatch.delete(id); pushStatus(id); }
    }
  } catch { /* ignore */ }
}, 6000);

/* --------------------------------------------------------------- boot adoption */

/**
 * 面板启动时接管既有进程。三级策略:
 *  1) 记录的 runtimePid 仍存活 → 直接接管(带端口项目设 9s 宽限校验,防 PID 复用)
 *  2) 记录进程已亡/无记录,但项目端口正被运行时进程监听 → 按端口接管真实服务
 *     (覆盖:包装 cmd 先于服务退出、上次面板退出后的遗留服务、外部手动启动的服务)
 *  3) 均不满足 → 清理失效记录(保持 stopped,端口监控照常提示冲突)
 * 同一 PID 只归一个项目,避免同端口多项目重复认领。
 */
function adoptRunning() {
  const names = allProcessNames();
  const listening = allListeningPorts();
  const taken = new Set();
  for (const p of config.projects) {
    const rt = getRT(p.id);
    if (rt.status === 'running' || rt.status === 'starting') { if (rt.pid) taken.add(rt.pid); continue; }
    const claim = (pid, why, startedAt) => {
      rt.status = 'running'; rt.pid = pid; rt.startedAt = startedAt || p.startedAt || Date.now();
      rt.adopted = true; rt.health = 'unknown'; rt.adoptDeadline = null; rt.exitCode = null;
      p.runtimePid = pid; // 回填为真实服务进程:下次重启直接命中,链条自愈
      if (!p.lastRunAt || rt.startedAt > p.lastRunAt) { p.lastRunAt = rt.startedAt; saveConfig(); }
      appendLog(p.id, 'sys', `↗ ${why} (PID ${pid})，已接管监控`);
      taken.add(pid);
      pushStatus(p.id);
    };
    // 1) 记录进程仍存活 → 按 PID 接管
    if (p.runtimePid && procAlive(p.runtimePid)) {
      claim(p.runtimePid, '检测到既有进程');
      if (p.port) rt.adoptDeadline = Date.now() + 9000; // 宽限期内端口必须可访问,否则视为 PID 被复用
      continue;
    }
    // 2) 按端口接管:端口正被服务进程监听
    if (p.port) {
      const pidSet = listening.get(Number(p.port));
      const pid = pidSet ? pickServicePid([...pidSet], taken, names) : null;
      if (pid) {
        claim(pid, p.runtimePid ? `原进程包装已退出，端口 ${p.port} 仍在服务` : `检测到端口 ${p.port} 存活服务`, Date.now());
        p.startedAt = rt.startedAt;
        saveConfig();
        continue;
      }
    }
    // 3) 无可接管:清理失效记录
    if (p.runtimePid) { p.runtimePid = null; p.startedAt = null; saveConfig(); }
  }
}

/* --------------------------------------------------------------- HTTP server */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) { try { req.destroy(); } catch { /* ignore */ } resolve({}); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function projectPayload(p) {
  const tools = detectAllTools();
  const env = (p.requiredEnv || []).map((r) => ({
    tool: r.tool, req: r.req || null,
    installed: tools[r.tool] || null,
    ok: versionSatisfied(r.req, tools[r.tool]),
  }));
  const missingDeps = p.type === 'node' && p.meta.hasDeps && p.meta.depsMissing;
  return Object.assign({}, p, { runtime: publicStatus(p.id), env, missingDeps, portWatch: watchInfo(p.id) });
}

function listProjects() {
  // 只展示当前根目录内的项目；手动添加的（可能在根目录外）始终保留
  return config.projects.filter((p) => p.manual || !isOutsideBase(p.root)).map(projectPayload);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const parts = u.pathname.split('/').filter(Boolean);
  try {
    /* SSE */
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      broadcast({ type: 'hello' });
      req.on('close', () => sseClients.delete(res));
      return;
    }
    /* 状态历史（时序图数据源）：?hours=1-168，默认 24 */
    if (u.pathname === '/api/history' && req.method === 'GET') {
      const hours = Math.min(168, Math.max(1, Number(u.searchParams.get('hours')) || 24));
      const cut = Date.now() - hours * 3600 * 1000;
      return send(res, 200, { points: history.filter((x) => x.t >= cut) });
    }
    /* 静态文件：ETag 协商缓存 —— 代码未变时 304 零传输，改动即生效（GET/HEAD 均支持） */
    if ((req.method === 'GET' || req.method === 'HEAD') && !u.pathname.startsWith('/api/')) {
      let rel = u.pathname === '/' ? '/index.html' : u.pathname;
      const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([.][.][\\/])+/, ''));
      if (file.startsWith(PUBLIC_DIR) && exists(file) && fs.statSync(file).isFile()) {
        const st = fs.statSync(file);
        const etag = `W/"${st.size}-${st.mtimeMs}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Content-Length': st.size,
          ETag: etag,
          'Last-Modified': st.mtime.toUTCString(),
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
        return;
      }
      return send(res, 404, { error: 'not found' });
    }

    /* ---- API ---- */
    if (u.pathname === '/api/system' && req.method === 'GET') {
      return send(res, 200, {
        app: APP_NAME, version: APP_VERSION, baseDir: config.baseDir,
        lastScanAt: config.lastScanAt || null,
        tools: detectAllTools(), platform: process.platform,
      });
    }
    /* 关闭面板自身：先广播 shutdown 让页面展示告别屏并停止重连，随后退出。
       运行中的项目进程不受影响（独立进程），下次启动时按 PID 自动接管。 */
    if (u.pathname === '/api/shutdown' && req.method === 'POST') {
      log('收到页面关闭请求，面板即将退出…');
      broadcast({ type: 'shutdown' });
      setTimeout(() => process.exit(0), 500);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/projects' && req.method === 'GET') {
      return send(res, 200, { projects: listProjects() });
    }
    if (u.pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.baseDir && isDir(body.baseDir)) { config.baseDir = body.baseDir; saveConfig(); }
      const roots = findProjectRoots(config.baseDir);
      const pruned = pruneOutsideProjects();
      if (pruned) log(`已从列表清理 ${pruned} 个根目录之外的旧项目（根目录: ${config.baseDir}）`);
      const added = [];
      for (const r of roots) {
        const p = registerProject(r);
        if (p) added.push(p);
      }
      config.lastScanAt = Date.now(); saveConfig();
      return send(res, 200, { added: added.map((p) => p.id), discovered: roots.length, pruned, projects: listProjects() });
    }
    /* 批量操作 */
    if (u.pathname === '/api/batch' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const action = String(body.action || '');
      const results = [];
      for (const id of ids) {
        const p = config.projects.find((x) => x.id === id);
        if (!p) { results.push({ id, ok: false, error: '项目不存在' }); continue; }
        let r;
        try {
          if (action === 'start') r = startProject(id);
          else if (action === 'stop') r = stopProject(id);
          else if (action === 'restart') r = restartProject(id);
          else if (action === 'install') r = installDeps(id);
          else if (action === 'delete') {
            stopProject(id);
            config.removedRoots = [...new Set([...(config.removedRoots || []), path.resolve(p.root).toLowerCase()])];
            config.projects = config.projects.filter((x) => x.id !== id);
            pushStatus(id);
            r = { ok: true };
          } else r = { error: '未知操作: ' + action };
        } catch (e) { r = { error: e.message }; }
        results.push(Object.assign({ id }, r));
      }
      if (action === 'delete') saveConfig();
      return send(res, 200, { results });
    }
    /* 设置：项目根目录等 */
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.baseDir !== undefined) {
        if (!isDir(body.baseDir)) return send(res, 400, { error: '目录不存在: ' + body.baseDir });
        config.baseDir = path.resolve(body.baseDir);
        saveConfig();
        log('根目录已切换 →', config.baseDir);
      }
      return send(res, 200, { baseDir: config.baseDir, lastScanAt: config.lastScanAt || null });
    }
    /* 端口管理面板：全部监听端口及占用进程 */
    if (u.pathname === '/api/ports/list' && req.method === 'GET') {
      const names = allProcessNames();
      const listening = allListeningPorts();
      const rtByPid = {}, portOwner = {};
      for (const p of config.projects) {
        const rt = getRT(p.id, false);
        if (rt && rt.pid) rtByPid[rt.pid] = p;
        if (p.port) portOwner[Number(p.port)] = p;
      }
      const list = [];
      for (const [port, pids] of listening) {
        for (const pid of pids) {
          const proj = rtByPid[pid] || portOwner[port];
          list.push({
            port: Number(port),
            pid,
            name: names.get(pid) || 'unknown',
            isPanel: pid === process.pid,
            isProject: !!rtByPid[pid],
            projectName: proj ? (proj.title || proj.name) : null,
          });
        }
      }
      list.sort((a, b) => ((b.isProject || b.projectName ? 1 : 0) - (a.isProject || a.projectName ? 1 : 0)) || (a.port - b.port));
      return send(res, 200, { list, summary: { ports: listening.size, procs: list.length } });
    }
    /* 释放端口：支持 {port} 整端口 或 {targets:[{port,pid}]} 精确目标 */
    if (u.pathname === '/api/ports/release' && req.method === 'POST') {
      const body = await readBody(req);
      const protect = new Set([process.pid, 0, 4]);
      let targets = [];
      if (Array.isArray(body.targets)) {
        targets = body.targets
          .map((t) => ({ port: Number(t.port), pid: Number(t.pid) }))
          .filter((t) => t.port >= 1 && t.port <= 65535 && t.pid > 0 && !protect.has(t.pid));
      } else if (body.port !== undefined && body.port !== null && body.port !== '') {
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: '端口无效' });
        targets = portOccupants(port).filter((x) => !x.isPanel && x.pid > 4).map((x) => ({ port, pid: x.pid }));
      }
      const killed = [], failed = [];
      for (const t of targets) {
        const nm = pidName(t.pid);
        // 同步执行以获得真实结果：taskkill /F / kill -9 通常 <1s，避免"报告已终止但实际失败"
        (killTree(t.pid) ? killed : failed).push(Object.assign({ name: nm }, t));
      }
      log(`释放端口: 终止 ${killed.map((x) => x.pid + '(' + x.name + ')').join(', ') || '无目标'}`);
      return send(res, 200, { killed, failed });
    }
    /* 手动添加项目（POST /api/projects，无 id） */
    if (u.pathname === '/api/projects' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.root || !isDir(body.root)) return send(res, 400, { error: '路径无效或目录不存在: ' + (body.root || '') });
      const proj = registerProject(body.root, { name: body.name, force: true, manual: true });
      if (!proj) return send(res, 400, { error: '未能识别该项目（缺少 package.json / requirements.txt / pom.xml / index.html 等，可先在详情中手填启动命令）' });
      config.lastScanAt = config.lastScanAt || null;
      return send(res, 200, { project: projectPayload(proj) });
    }
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
      const id = parts[2];
      const p = config.projects.find((x) => x.id === id);
      const sub = parts[3] || '';
      if (!p && !(sub === '' && req.method === 'POST')) return send(res, 404, { error: '项目不存在' });

      if (sub === '' && req.method === 'GET') return send(res, 200, projectPayload(p));
      if (sub === '' && req.method === 'DELETE') {
        stopProject(id);
        // 记入移除名单：之后的扫描不再自动重新添加
        config.removedRoots = [...new Set([...(config.removedRoots || []), path.resolve(p.root).toLowerCase()])];
        config.projects = config.projects.filter((x) => x.id !== id);
        saveConfig();
        pushStatus(id);
        return send(res, 200, { ok: true });
      }
      if (sub === '' && req.method === 'PATCH') {
        const body = await readBody(req);
        for (const k of ['name', 'runCmd', 'runCwd']) {
          if (k in body) p[k] = String(body[k] ?? '');
        }
        if ('port' in body) {
          // 端口强校验：null/'' 表示清空；其余必须为 1-65535 整数，防止污染配置与端口监控
          if (body.port === null || body.port === '') p.port = null;
          else {
            const n = Number(body.port);
            if (!Number.isInteger(n) || n < 1 || n > 65535) return send(res, 400, { error: '端口无效：应为 1-65535 的整数，或留空' });
            p.port = n;
          }
        }
        if ('enabled' in body) p.enabled = !!body.enabled;
        if ('title' in body) {
          p.title = String(body.title || '').trim();
          p.titleLocked = !!p.title; // 用户命名后不再被自动分析覆盖
        }
        if ('desc' in body) {
          p.desc = String(body.desc || '').trim();
          p.descLocked = !!p.desc;
        }
        if ('pinned' in body) p.pinned = !!body.pinned;
        if (p.type === 'static' && body.port && p.runCmd) {
          p.runCmd = staticServeCmd(p.port);
        }
        saveConfig();
        pushStatus(id);
        return send(res, 200, projectPayload(p));
      }
      if (sub === 'start' && req.method === 'POST') return send(res, 200, startProject(id));
      if (sub === 'stop' && req.method === 'POST') return send(res, 200, stopProject(id));
      if (sub === 'restart' && req.method === 'POST') return send(res, 200, restartProject(id));
      if (sub === 'install' && req.method === 'POST') return send(res, 200, installDeps(id));
      if (sub === 'port-info' && req.method === 'GET') {
        if (!p.port) return send(res, 200, { port: null, occupied: false, procs: [] });
        const rt = getRT(id, false);
        const procs = portOccupants(p.port).map((x) => Object.assign(x, { isProject: !!(rt && rt.pid === x.pid) }));
        return send(res, 200, { port: p.port, occupied: procs.length > 0, procs });
      }
      if (sub === 'logs' && req.method === 'GET') {
        const rt = getRT(id, false);
        const after = Number(u.searchParams.get('after') || 0);
        const logs = rt ? rt.logs.filter((l) => l.t > after) : [];
        return send(res, 200, { logs });
      }
      if (sub === 'analyze' && req.method === 'POST') {
        const a = analyzeProject(p.root);
        if (a) {
          if (a.type === 'static') finalizeStatic(a);
          p.type = a.type; p.kind = a.kind; p.runCmd = a.runCmd; p.runCwd = a.runCwd || '';
          p.port = a.port || null; p.requiredEnv = a.requiredEnv || []; p.meta = a.meta || {};
          if (!p.titleLocked) p.title = a.title || '';
          if (!p.descLocked) p.desc = a.desc || '';
          saveConfig(); pushStatus(id);
        }
        return send(res, 200, projectPayload(p));
      }
      if (sub === 'open-folder' && req.method === 'POST') {
        openWithSystem(p.root);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log('API error:', e);
    return send(res, 500, { error: e.message });
  }
});

/* --------------------------------------------------------------- boot */

function pickPanelPort(port, tries = 12) {
  if (tries <= 0) { log(`⚠ 连续 ${12} 个端口均被占用，尝试直接绑定 ${port}（若失败请检查端口占用）`); return Promise.resolve(port); }
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(pickPanelPort(port + 1, tries - 1)));
    probe.once('listening', () => probe.close(() => resolve(port)));
    probe.listen(port, '0.0.0.0');
  });
}

(async () => {
  loadConfig();
  if (!isDir(config.baseDir)) config.baseDir = DEFAULT_BASE_DIR;
  // 旧配置回填标题/描述
  for (const p of config.projects) {
    if (p.title === undefined || p.desc === undefined) {
      try { const a = analyzeProject(p.root); if (a) { if (p.title === undefined) p.title = a.title || ''; if (p.desc === undefined) p.desc = a.desc || ''; } } catch { /* ignore */ }
    }
  }
  // 静态项目自愈：python 不可用而 python3 可用时改写启动命令（现代 macOS 无裸 python，原命令启动即崩）
  if (!detectTool('python') && detectTool('python3')) {
    let healed = 0;
    for (const p of config.projects) {
      if (p.type === 'static' && /^python -m http\.server /.test(p.runCmd || '')) {
        p.runCmd = `python3 -m http.server ${p.port} --bind 0.0.0.0`;
        p.requiredEnv = [{ tool: 'python3', req: null }];
        healed++;
      }
    }
    if (healed) { saveConfig(); log(`静态项目自愈：${healed} 个启动命令已切换为 python3`); }
  }
  const port = await pickPanelPort(Number(config.port) || PANEL_PORT);
  config.port = port;
  // 首次启动自动扫描
  if (config.projects.length === 0) {
    const roots = findProjectRoots(config.baseDir);
    for (const r of roots) registerProject(r);
    log(`首启扫描完成，发现 ${config.projects.length} 个项目`);
  }
  warmTools(); // 后台并行预热工具链（不阻塞启动；10 分钟 TTL 自动刷新）
  adoptRunning();
  for (const p of config.projects) noteStatus(p.id); // 时序起点：面板启动时刻的各项目状态
  server.listen(port, '0.0.0.0', () => {
    try { ensureDir(DATA_DIR); fs.writeFileSync(path.join(DATA_DIR, 'panel-url.txt'), `http://127.0.0.1:${port}`); } catch { /* ignore */ }
    log(`${APP_NAME} v${APP_VERSION} → http://127.0.0.1:${port}`);
    log(`项目根目录: ${config.baseDir} · 已注册 ${config.projects.length} 个项目`);
    // 启动脚本（start.bat / start.sh / start.command）设置 LP_OPEN=1：服务就绪后自动用默认浏览器打开面板
    if (process.env.LP_OPEN) {
      try {
        openWithSystem(`http://127.0.0.1:${port}`);
        log('已调用系统浏览器打开面板');
      } catch { /* ignore */ }
    }
  });
})();
