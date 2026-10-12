/* LaunchPad 前端逻辑 */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  projects: [],
  system: null,
  filter: 'all',
  search: '',
  drawerId: null,
  drawerTab: 'ov', // 抽屉页签：ov 概览 / log 日志 / hist 履历（偏好持久化）
  logFilter: '', // 日志行过滤（抽屉内）
  autoscroll: true,
  firstRender: true,
  booted: false,
  enterFast: false, // 同一会话内刷新页面：跳过冗长入场动画（speed-up）
  view: 'grid',
  sort: 'smart',
  collapsed: { live: false, lib: false },
  selectMode: false,
  selected: new Set(),
  selAnchor: null, // 批量模式 Shift 范围勾选的锚点索引
  events: [], // 运行动态（事件流，本地持久化近 7 天）
};

const TYPE_META = {
  node: { icon: 'box', label: 'Node.js' },
  python: { icon: 'terminal', label: 'Python' },
  java: { icon: 'coffee', label: 'Java' },
  dotnet: { icon: 'layers', label: '.NET' },
  static: { icon: 'globe', label: '静态站' },
  desktop: { icon: 'monitor', label: '桌面' },
  unknown: { icon: 'wrench', label: '未识别' },
};
const TOOL_ICON = { node: 'box', npm: 'package', python: 'terminal', pip: 'download', java: 'coffee', maven: 'wrench', git: 'gitBranch', dotnet: 'layers' };
const STATUS_TEXT = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', crashed: '异常退出', installing: '安装依赖' };

/* ---------------------------------------------------------------- utils */

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  if (d) return `${d}天${h}时`;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  if (m) return `${m}:${String(ss).padStart(2, '0')}`;
  return `${ss}s`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期（运行履历用） */
function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - Number(ts);
  if (d < 60000) return '刚刚';
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** 转义并高亮搜索命中片段（cardHTML 标题/简介用）：多关键词空格分词，命中任一词即高亮 */
function escHl(s) {
  const raw = String(s ?? '');
  const terms = state.search.split(/\s+/).filter(Boolean);
  if (!terms.length) return esc(raw);
  const rx = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '', last = 0, m;
  while ((m = rx.exec(raw)) !== null) {
    out += esc(raw.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (!m[0].length) rx.lastIndex++;
  }
  return out + esc(raw.slice(last));
}

/** 搜索命中判定：多关键词 AND（全部词都出现才算命中） */
function searchHit(hay) {
  const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const low = String(hay).toLowerCase();
  return terms.every((t) => low.includes(t));
}

/** 复制文本到剪贴板（clipboard API 优先，execCommand 兜底）；label 可自定义成功提示文案 */
async function copyText(s, label) {
  let ok = false;
  try { await navigator.clipboard.writeText(s); ok = true; } catch { /* 权限或非安全上下文，走兜底 */ }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  toast(ok ? (label || '已复制：' + (s.length > 42 ? s.slice(0, 42) + '…' : s)) : '复制失败——请手动复制', ok ? 'ok' : 'err');
}

/** 入场动画：WAAPI 驱动 + finish() 兜底，动画被节流时也能保证元素最终可见 */
function animateIn(els, baseDelay = 0, step = 55, dist = 16) {
  const list = [...els];
  if (!list.length) return;
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of list) {
    const i = list.indexOf(el);
    let anim;
    try {
      anim = el.animate(
        [{ opacity: 0, transform: `translateY(${dist}px)` }, { opacity: 1, transform: 'none' }],
        { duration: 480, delay: baseDelay + i * step, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' },
      );
    } catch { return; }
    setTimeout(() => { try { anim.finish(); } catch { /* already finished */ } }, baseDelay + i * step + 560);
  }
}

function toast(msg, type = 'info', dur = 3400) {
  const icons = { ok: 'check', err: 'alert', info: 'zap' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status'); // 屏幕阅读器可感知
  el.innerHTML = `${icon(icons[type] || icons.info, 16)}<span>${esc(msg)}</span><i class="t-bar"${dur !== 3400 ? ` style="animation-duration:${dur}ms"` : ''} aria-hidden="true"></i>`;
  el.onclick = () => el.remove(); // 点击任意处立即关闭
  $('#toasts').appendChild(el);
  try {
    const a = el.animate([{ opacity: 0, transform: 'translateX(60px) scale(.95)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
    setTimeout(() => { try { a.finish(); } catch {} }, 480);
  } catch { /* 无动画环境直接显示 */ }
  setTimeout(() => {
    try {
      const b = el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(60px) scale(.95)' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      b.finished.then(() => el.remove()).catch(() => el.remove());
    } catch { el.remove(); }
  }, dur);
}

/* ---------------------------------------------------------------- 主题 */

function applyTheme(light, persist = true, anim = true) {
  // 主题柔和过渡：短暂开启全局色彩过渡（450ms），避免深浅切换瞬间跳变。
  // 圆形展开（View Transitions）路径下传 anim=false——快照需即时定格，渐变交给 clip-path。
  if (anim) {
    document.body.classList.add('theme-anim');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => document.body.classList.remove('theme-anim'), 450);
  }
  document.body.classList.toggle('light', light);
  if (persist) { try { localStorage.setItem('lp-theme', light ? 'light' : 'dark'); } catch { /* ignore */ } }
  const b = $('#btn-theme');
  if (b) {
    b.innerHTML = icon(light ? 'moon' : 'sun', 15); b.title = light ? '切换到深色模式' : '切换到浅色模式';
    try {
      const a = b.animate([{ transform: 'rotate(-150deg) scale(.5)', opacity: .3 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
      setTimeout(() => { try { a.finish(); } catch { /* already finished */ } }, 460);
    } catch { /* 无动画环境 */ }
  }
}
/* 主题切换：支持 View Transitions 的浏览器从按钮处圆形展开过渡，否则退回全局柔和渐变 */
function toggleTheme() {
  const light = !document.body.classList.contains('light');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) { applyTheme(light); return; }
  const btn = $('#btn-theme');
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const maxR = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(() => applyTheme(light, true, false));
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }
    );
  }).catch(() => { /* 过渡被打断时忽略 */ });
}
$('#btn-theme').onclick = toggleTheme;

/* ---------------------------------------------------------------- 主题色板（accent 四色循环） */

const ACCENTS = [
  { id: 'indigo', label: '靛蓝', dark: '#6e82f0', rgb: [110, 130, 240], rgbL: [79, 110, 247] },
  { id: 'teal', label: '青碧', dark: '#45c4b1', rgb: [69, 196, 177], rgbL: [15, 148, 136] },
  { id: 'sunset', label: '落日', dark: '#e0885a', rgb: [224, 136, 90], rgbL: [192, 95, 33] },
  { id: 'mono', label: '石墨', dark: '#9aa8c0', rgb: [154, 168, 192], rgbL: [95, 113, 140] },
];
let ACCENT_NOW = ACCENTS[0]; // 画布（灯笼/极光）实时读取的当前色板
const accentRgbStr = (light) => (light ? ACCENT_NOW.rgbL : ACCENT_NOW).join(', ');
/** 应用色板：body[data-accent] 驱动 CSS 变量（靛蓝为默认，不挂属性）；favicon 待机色联动 */
function applyAccent(id) {
  const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
  ACCENT_NOW = a;
  if (a.id === 'indigo') document.body.removeAttribute('data-accent');
  else document.body.setAttribute('data-accent', a.id);
  try { localStorage.setItem('lp-accent', a.id); } catch { /* ignore */ }
  const btn = $('#btn-accent');
  if (btn) btn.title = `主题色：${a.label}（点击切换）`;
  favSig = ''; renderFavicon();
  return a;
}
$('#btn-accent').onclick = () => {
  const cur = document.body.getAttribute('data-accent') || 'indigo';
  const next = ACCENTS[(ACCENTS.findIndex((x) => x.id === cur) + 1) % ACCENTS.length];
  const a = applyAccent(next.id);
  toast(`主题色：${a.label}`, 'info');
};

/* ---------------------------------------------------------------- 急救中心（全部停止 / 全部重启） */

function openRescue() {
  if (!$('#modal-rescue').classList.contains('open')) lockScroll(true);
  $('#modal-rescue').classList.add('open');
  $('#modal-rescue').setAttribute('aria-hidden', 'false');
  const live = state.projects.filter((p) => ['running', 'starting'].includes((p.runtime || {}).status));
  const crashed = state.projects.filter((p) => (p.runtime || {}).status === 'crashed');
  $('#rescue-summary').textContent = `当前 ${state.projects.length} 个项目：${live.length} 个运行中${crashed.length ? ` · ${crashed.length} 个异常` : ''}。操作只影响运行中的项目。`;
  $('#rescue-stop').disabled = !live.length;
  $('#rescue-restart').disabled = !live.length;
  $('#rescue-stop-txt').textContent = live.length ? `全部停止 (${live.length})` : '全部停止';
  $('#rescue-restart-txt').textContent = live.length ? `全部重启 (${live.length})` : '全部重启';
}
function closeRescue() {
  if (!$('#modal-rescue').classList.contains('open')) return;
  lockScroll(false);
  $('#modal-rescue').classList.remove('open');
  $('#modal-rescue').setAttribute('aria-hidden', 'true');
}
async function rescueRun(action) {
  const ids = state.projects
    .filter((p) => ['running', 'starting'].includes((p.runtime || {}).status))
    .map((p) => p.id);
  if (!ids.length) { toast('没有运行中的项目', 'info'); return; }
  try {
    const label = action === 'stop' ? '停止' : '重启';
    toast(`正在批量${label} ${ids.length} 个项目…`, 'info');
    closeRescue();
    const r = await post('/api/batch', { action, ids });
    const okN = (r.results || []).filter((x) => x.ok).length;
    const fails = (r.results || []).filter((x) => !x.ok);
    toast(`全部${label}: 成功 ${okN} 项${fails.length ? ` · 失败 ${fails.length} 项(${fails[0].error})` : ''}`, fails.length ? 'info' : 'ok');
  } catch (err) { toast(err.message, 'err'); }
}
$('#btn-rescue').onclick = openRescue;
$$('#modal-rescue [data-close]').forEach((el) => { el.onclick = closeRescue; });
$('#rescue-stop').onclick = () => rescueRun('stop');
$('#rescue-restart').onclick = () => rescueRun('restart');

/* ---------------------------------------------------------------- 端口管理面板 */

const portState = { list: [], sel: new Set() };

/* 弹层打开期间锁定背景滚动（对称计数，多弹层叠加安全） */
let scrollLocks = 0;
function lockScroll(on) {
  scrollLocks = Math.max(0, scrollLocks + (on ? 1 : -1));
  document.body.style.overflow = scrollLocks > 0 ? 'hidden' : '';
}

function openPortsModal() {
  if (!$('#modal-ports').classList.contains('open')) lockScroll(true);
  $('#modal-ports').classList.add('open');
  $('#modal-ports').setAttribute('aria-hidden', 'false');
  portState.sel.clear();
  loadPortList();
}
function closePortsModal() {
  if ($('#modal-ports').classList.contains('open')) lockScroll(false);
  $('#modal-ports').classList.remove('open');
  $('#modal-ports').setAttribute('aria-hidden', 'true');
}

async function loadPortList() {
  const body = $('#port-body');
  body.innerHTML = '<div class="port-empty">扫描中…</div>';
  try {
    const d = await api('/api/ports/list');
    portState.list = d.list || [];
    $('#pt-summary').textContent = `${d.summary.ports} 个端口 · ${d.summary.procs} 个进程`;
    renderPortTable();
  } catch (err) { body.innerHTML = `<div class="port-empty">查询失败: ${esc(err.message)}</div>`; }
}

function renderPortTable() {
  const q = ($('#pt-filter').value || '').trim().toLowerCase();
  const rows = portState.list.filter((x) =>
    !q || String(x.port).includes(q) || String(x.pid).includes(q) || x.name.toLowerCase().includes(q) || (x.projectName || '').toLowerCase().includes(q));
  const body = $('#port-body');
  if (!rows.length) { body.innerHTML = '<div class="port-empty">没有匹配的端口</div>'; return; }
  body.innerHTML = rows.map((x) => {
    const key = x.port + ':' + x.pid;
    const sel = portState.sel.has(key);
    const protectedRow = x.isPanel;
    let proj = '';
    if (x.isProject) proj += `<span class="tag ok">本项目</span>`;
    if (x.projectName && !x.isProject) proj += `<span class="tag hl">端口归属</span>`;
    proj += x.projectName ? esc(x.projectName) : '';
    return `<div class="port-row ${sel ? 'sel' : ''} ${protectedRow ? 'protected' : ''}" data-key="${key}" data-port="${x.port}" data-pid="${x.pid}">
      <span class="pcheck ${sel ? 'on' : ''}">${icon('check', 12)}</span>
      <span class="p-port">:${x.port}</span>
      <span class="p-pid">${x.pid}</span>
      <span class="p-name" title="${esc(x.name)}">${esc(x.name)}</span>
      <span class="p-proj">${proj || '<span style="opacity:.4">—</span>'}</span>
      <span class="pc-act">${protectedRow ? '<span class="tag">面板</span>' : `<button class="btn danger sm" data-rel="${key}">释放</button>`}</span>
    </div>`;
  }).join('');
  $('#pt-sel').textContent = portState.sel.size;
}

function resetReleaseBtn() {
  const b = $('#pt-release');
  if (b) { b.dataset.confirm = ''; $('#pt-rel-txt').textContent = '释放所选'; }
}

$('#btn-ports').onclick = openPortsModal;
$$('#modal-ports [data-close]').forEach((el) => el.onclick = closePortsModal);
$('#pt-refresh').onclick = loadPortList;
$('#pt-filter').addEventListener('input', renderPortTable);

$('#port-table').addEventListener('click', async (e) => {
  const relBtn = e.target.closest('[data-rel]');
  const row = e.target.closest('.port-row');
  if (relBtn && row) {
    relBtn.disabled = true; relBtn.textContent = '…';
    await releaseTargets([{ port: Number(row.dataset.port), pid: Number(row.dataset.pid) }]);
    return;
  }
  if (!row || e.target.closest('button')) return;
  const key = row.dataset.key;
  if (portState.sel.has(key)) portState.sel.delete(key); else portState.sel.add(key);
  row.classList.toggle('sel', portState.sel.has(key));
  row.querySelector('.pcheck').classList.toggle('on', portState.sel.has(key));
  $('#pt-sel').textContent = portState.sel.size;
  resetReleaseBtn();
});

$('#pt-all').onclick = () => {
  const q = ($('#pt-filter').value || '').trim().toLowerCase();
  const rows = portState.list.filter((x) => !x.isPanel && (!q || String(x.port).includes(q) || String(x.pid).includes(q) || x.name.toLowerCase().includes(q) || (x.projectName || '').toLowerCase().includes(q)));
  const keys = rows.map((x) => x.port + ':' + x.pid);
  const allSel = keys.length > 0 && keys.every((k) => portState.sel.has(k));
  if (allSel) keys.forEach((k) => portState.sel.delete(k));
  else keys.forEach((k) => portState.sel.add(k));
  renderPortTable();
};

$('#pt-release').onclick = async function () {
  if (!portState.sel.size) { toast('请先勾选要释放的端口', 'info'); return; }
  if (this.dataset.confirm !== '1') {
    this.dataset.confirm = '1';
    $('#pt-rel-txt').textContent = `确认释放 ${portState.sel.size} 项？`;
    setTimeout(() => { if (this.isConnected) resetReleaseBtn(); }, 3200);
    return;
  }
  const targets = [...portState.sel].map((k) => { const [port, pid] = k.split(':'); return { port: Number(port), pid: Number(pid) }; });
  this.dataset.confirm = '';
  await releaseTargets(targets);
};

async function releaseTargets(targets) {
  try {
    const r = await post('/api/ports/release', { targets });
    const killedN = (r.killed || []).length, failedN = (r.failed || []).length;
    targets.forEach((t) => portState.sel.delete(t.port + ':' + t.pid));
    renderPortTable();
    toast(`已结束 ${killedN} 个进程` + (failedN ? `，${failedN} 个失败` : '') + '，端口已释放', failedN ? 'info' : 'ok');
    if (state.drawerId) loadPortInfo(state.drawerId);
    loadPortList();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------------------------------------------------------------- background canvas */

function startBackground() {
  const cv = $('#bg'), ctx = cv.getContext('2d');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cv.remove(); return; }
  let W, H, stars = [], brights = [], orbits = [], meteors = [], nextMeteor = 480;
  /* 星尘着色：基色蓝白 + 少量青 / 紫 / 亮白 */
  const STAR_TINTS = [['185, 201, 232', .6], ['143, 216, 222', .2], ['185, 168, 242', .13], ['232, 240, 255', .07]];
  const pickTint = () => {
    let r = Math.random(), acc = 0;
    for (const [c, w] of STAR_TINTS) { acc += w; if (r <= acc) return c; }
    return STAR_TINTS[0][0];
  };
  const resize = () => {
    W = cv.width = innerWidth * devicePixelRatio; H = cv.height = innerHeight * devicePixelRatio;
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    stars = Array.from({ length: Math.min(120, innerWidth / 10) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: (Math.random() * 1.3 + .3) * devicePixelRatio,
      a: Math.random() * .38 + .1, tw: Math.random() * Math.PI * 2, sp: Math.random() * .4 + .08,
      c: pickTint(), z: .4 + Math.random(), // z=视差深度（0.4-1.4，星体越大位移越大）
    }));
    /* 亮星：稀疏的衍射星（十字光芒），星空的摄影感层次 */
    brights = Array.from({ length: Math.max(4, Math.round(innerWidth / 420)) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: (Math.random() * 1.1 + 1.4) * devicePixelRatio,
      len: (Math.random() * 7 + 8) * devicePixelRatio,
      tw: Math.random() * Math.PI * 2, sp: Math.random() * .5 + .3,
    }));
    /* 轨道弧：圆心在屏外的大圆虚线弧，卫星点沿弧缓慢推进并拖曳光尾 */
    const hyp = Math.hypot(W, H);
    orbits = [
      { fx: 1.12, fy: -.18, fr: .92, dir: 1, speed: .00009, ph: 2.2, col: '86, 211, 218', colL: '8, 145, 165' },
      { fx: -.18, fy: 1.12, fr: .88, dir: -1, speed: .00007, ph: 5.1, col: '154, 139, 242', colL: '109, 79, 224' },
      { fx: .5, fy: 1.42, fr: .78, dir: 1, speed: .000055, ph: .6, col: '111, 168, 242', colL: '31, 111, 235' },
    ].map((o) => ({ ...o, cx: o.fx * W, cy: o.fy * H, r: o.fr * hyp }));
  };
  /* 时段氛围：极光色随时段微调（清晨=金粉 / 黄昏=琥珀紫 / 其余为经典青蓝），alpha 不变不扰眼 */
  const AMBIENCE = {
    dawn:  ['232, 178, 120', '111, 140, 255', '224, 123, 164', '86, 211, 218'],
    noon:  ['86, 211, 218', '111, 168, 242', '154, 139, 242', '79, 211, 154'],
    day:   ['86, 211, 218', '111, 140, 255', '164, 122, 240', '79, 211, 154'],
    dusk:  ['230, 181, 102', '164, 122, 240', '240, 126, 149', '111, 168, 242'],
    night: ['86, 211, 218', '111, 140, 255', '164, 122, 240', '79, 211, 154'],
  };
  const daypartNow = () => {
    const h = new Date().getHours();
    return h < 5 ? 'night' : h < 11 ? 'dawn' : h < 13 ? 'noon' : h < 18 ? 'day' : 'dusk';
  };
  const blobs = [
    { slot: 0, x: .18, y: .22, r: .42, dx: .00006, dy: .00004, ph: 0, al: .06 },
    { slot: 1, x: .82, y: .3, r: .46, dx: -.00005, dy: .00005, ph: 2.1, al: .06 },
    { slot: 2, x: .5, y: .88, r: .5, dx: .000045, dy: -.00004, ph: 4.2, al: .06 },
    { slot: 3, x: .08, y: .8, r: .4, dx: -.00004, dy: .00005, ph: 1.2, al: .045 },
  ];
  let part = daypartNow();
  setInterval(() => { part = daypartNow(); }, 600000); // 每 10 分钟校准时段
  addEventListener('resize', resize); resize();
  /* 事件流星：项目成功点火时划过一颗（SSE 状态变迁调用） */
  window.lpMeteor = () => {
    if (document.hidden) return;
    const sp = (Math.random() * .35 + .5) * devicePixelRatio;
    meteors.push({ x: W * (Math.random() * .7 + .12), y: H * (Math.random() * .25 + .04), vx: sp * 2.4, vy: sp, life: 1 });
  };
  /* 火箭发射：批量点火的仪式彩蛋 + 低频自发；尾焰粒子 + 轻微摇摆爬升 */
  let rocket = null, nextRocket = 1200 + Math.random() * 2400;
  window.lpRocket = () => {
    if (document.hidden || rocket) return;
    rocket = {
      x: W * (.18 + Math.random() * .64), y: H * .94,
      vx: (Math.random() * .3 - .15) * devicePixelRatio,
      vy: -(1.5 + Math.random() * .5) * devicePixelRatio,
      sway: Math.random() * Math.PI * 2, parts: [],
    };
  };
  let rings = []; // 卫星信号涟漪（声纳圈）
  let dust = []; // 点击星尘粒子
  /* 鼠标层：视差 + 灯笼（rAF 内 lerp 平滑）；点击空白 → window.lpPuff 星尘涟漪 */
  const mouse = { tx: .5, ty: .5, x: .5, y: .5 };
  addEventListener('mousemove', (e) => { mouse.tx = e.clientX / innerWidth; mouse.ty = e.clientY / innerHeight; }, { passive: true });
  window.lpPuff = (cx, cy) => {
    if (document.hidden) return;
    const x = cx * devicePixelRatio, y = cy * devicePixelRatio;
    rings.push({ x, y, r: 3 * devicePixelRatio, life: .9, col: document.body.classList.contains('light') ? '65, 89, 143' : '185, 201, 232' });
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2, sp = (.3 + Math.random() * .5) * devicePixelRatio;
      dust.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - .2 * devicePixelRatio, life: 1, c: pickTint() });
    }
    if (dust.length > 40) dust.splice(0, dust.length - 40);
  };
  let t = 0;
  (function frame() {
    t += 1;
    const light = document.body.classList.contains('light');
    ctx.clearRect(0, 0, W, H);
    // 鼠标层：目标点 lerp 平滑，视差与灯笼共用
    mouse.x += (mouse.tx - mouse.x) * .05;
    mouse.y += (mouse.ty - mouse.y) * .05;
    const px = (mouse.x - .5) * devicePixelRatio, py = (mouse.y - .5) * devicePixelRatio;
    // 极光色块（色相随时段氛围表 + 鼠标视差；slot1 为主品牌槽，随主题色板联动）
    for (const b of blobs) {
      const x = (b.x + Math.sin(t * b.dx * 1000 + b.ph) * .06) * W - px * 18;
      const y = (b.y + Math.cos(t * b.dy * 1000 + b.ph) * .05) * H - py * 14;
      const r = b.r * Math.min(W, H) * (1 + Math.sin(t * .004 + b.ph) * .08);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const col = b.slot === 1 ? accentRgbStr(light) : AMBIENCE[part][b.slot];
      g.addColorStop(0, `rgba(${col}, ${light ? b.al * .8 : b.al})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    // 地平线辉光：底部大气弧（品牌槽），随氛围色缓慢呼吸
    {
      const hA = (light ? .07 : .055) * (1 + Math.sin(t * .003) * .18);
      const hg = ctx.createRadialGradient(W * .5, H * 1.28, 0, W * .5, H * 1.28, H * .55);
      hg.addColorStop(0, `rgba(${accentRgbStr(light)}, ${hA.toFixed(3)})`);
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, H * .5, W, H * .5 + 2);
    }
    // 光标灯笼：柔和光晕随鼠标缓动，像提灯巡视星空（灯色随主题色板）
    {
      const lx = mouse.x * W, ly = mouse.y * H, lr = 150 * devicePixelRatio;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
      lg.addColorStop(0, `rgba(${accentRgbStr(light)}, ${light ? .05 : .06})`);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(lx, ly, lr, 0, 7); ctx.fill();
    }
    // 轨道弧：虚线大弧 + 卫星点拖尾（轨道色、低亮度不扰眼）
    ctx.save();
    ctx.setLineDash([2 * devicePixelRatio, 8 * devicePixelRatio]);
    ctx.lineWidth = devicePixelRatio;
    for (const o of orbits) {
      const ocx = o.cx - px * 8, ocy = o.cy - py * 6; // 轨道层视差（位移最小，像最远的深空）
      ctx.strokeStyle = light ? 'rgba(65, 89, 143, .1)' : 'rgba(158, 190, 255, .08)';
      ctx.beginPath(); ctx.arc(ocx, ocy, o.r, 0, 7); ctx.stroke();
      const th = o.ph + t * o.speed * o.dir;
      for (let i = 6; i >= 1; i--) {
        const a2 = th - i * .01 * o.dir;
        ctx.fillStyle = `rgba(${light ? o.colL : o.col}, ${(0.3 * (1 - i / 7)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(ocx + Math.cos(a2) * o.r, ocy + Math.sin(a2) * o.r, Math.max(.4, (2 - i * .22)) * devicePixelRatio, 0, 7); ctx.fill();
      }
      const sx = ocx + Math.cos(th) * o.r, sy = ocy + Math.sin(th) * o.r;
      ctx.shadowBlur = 9 * devicePixelRatio; ctx.shadowColor = `rgba(${light ? o.colL : o.col}, .9)`;
      ctx.fillStyle = `rgba(${light ? o.colL : o.col}, .85)`;
      ctx.beginPath(); ctx.arc(sx, sy, 2.1 * devicePixelRatio, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      // 卫星偶发信号涟漪（同时最多 3 圈，极低频）
      if (rings.length < 3 && Math.random() < 0.0009) {
        rings.push({ x: sx, y: sy, r: 4 * devicePixelRatio, life: 1, col: light ? o.colL : o.col });
      }
    }
    ctx.restore();
    // 信号涟漪：从发射点向外扩散并渐隐
    for (let i = rings.length - 1; i >= 0; i--) {
      const rg = rings[i];
      rg.r += .55 * devicePixelRatio; rg.life -= .007;
      if (rg.life <= 0 || rg.r > 90 * devicePixelRatio) { rings.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(${rg.col}, ${(rg.life * .22).toFixed(3)})`;
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath(); ctx.arc(rg.x, rg.y, rg.r, 0, 7); ctx.stroke();
    }
    // 点击星尘：粒子四散上浮渐隐
    for (let i = dust.length - 1; i >= 0; i--) {
      const p = dust[i];
      p.x += p.vx; p.y += p.vy; p.vy -= .004 * devicePixelRatio; p.life -= .022;
      if (p.life <= 0) { dust.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(${p.c}, ${(p.life * .5).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, (1.2 * p.life + .3) * devicePixelRatio, 0, 7); ctx.fill();
    }
    // 星尘（含鼠标视差：星体越大视差越明显，制造纵深）
    for (const s of stars) {
      s.tw += .02 * s.sp;
      ctx.globalAlpha = s.a * (.6 + Math.sin(s.tw) * .4) * (light ? .5 : 1);
      ctx.fillStyle = light ? '#41598f' : `rgb(${s.c})`;
      ctx.beginPath(); ctx.arc(s.x - px * 14 * s.z, s.y - py * 10 * s.z, s.r, 0, 7); ctx.fill();
      s.y -= s.sp * devicePixelRatio * .06;
      if (s.y < -4) { s.y = H + 4; s.x = Math.random() * W; }
    }
    ctx.globalAlpha = 1;
    // 亮星：十字光芒缓慢明灭（同为视差层）
    for (const b of brights) {
      b.tw += .008 * b.sp;
      const a = .3 + Math.sin(b.tw) * .22;
      const col = light ? '65, 89, 143' : '214, 228, 255';
      ctx.strokeStyle = `rgba(${col}, ${(a * .55).toFixed(3)})`;
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(b.x - b.len - px * 12, b.y - py * 9); ctx.lineTo(b.x + b.len - px * 12, b.y - py * 9);
      ctx.moveTo(b.x - px * 12, b.y - b.len - py * 9); ctx.lineTo(b.x - px * 12, b.y + b.len - py * 9);
      ctx.stroke();
      ctx.fillStyle = `rgba(${col}, ${Math.min(1, a + .3).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(b.x - px * 12, b.y - py * 9, b.r, 0, 7); ctx.fill();
    }
    // 火箭：低频自发爬升；批量点火时由 lpRocket 触发
    if (!rocket && t > nextRocket) { nextRocket = t + 2700 + Math.random() * 2700; if (window.lpRocket) window.lpRocket(); }
    if (rocket) {
      const rc = rocket;
      rc.sway += .02;
      rc.x += rc.vx + Math.sin(rc.sway) * .25 * devicePixelRatio;
      rc.y += rc.vy;
      rc.vy -= .0012 * devicePixelRatio; // 缓缓加速
      for (let k = 0; k < 2; k++) {
        rc.parts.push({ x: rc.x + (Math.random() - .5) * 2.5 * devicePixelRatio, y: rc.y + 5.5 * devicePixelRatio, vy: (.3 + Math.random() * .5) * devicePixelRatio, life: 1 });
      }
      for (let i = rc.parts.length - 1; i >= 0; i--) {
        const p = rc.parts[i];
        p.y += p.vy; p.life -= .035;
        if (p.life <= 0) { rc.parts.splice(i, 1); continue; }
        ctx.fillStyle = `rgba(230, 181, 102, ${(p.life * .45).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, (1.5 * p.life + .4) * devicePixelRatio, 0, 7); ctx.fill();
      }
      ctx.save();
      ctx.translate(rc.x, rc.y);
      ctx.rotate(Math.sin(rc.sway) * .08);
      ctx.shadowBlur = 8 * devicePixelRatio; ctx.shadowColor = 'rgba(232, 240, 255, .8)';
      ctx.fillStyle = light ? 'rgba(65, 89, 143, .9)' : 'rgba(232, 240, 255, .92)';
      ctx.beginPath();
      ctx.moveTo(0, -6 * devicePixelRatio);
      ctx.lineTo(2.4 * devicePixelRatio, 4 * devicePixelRatio);
      ctx.lineTo(-2.4 * devicePixelRatio, 4 * devicePixelRatio);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(240, 126, 149, .95)'; // 舷灯
      ctx.beginPath(); ctx.arc(0, -.5 * devicePixelRatio, .9 * devicePixelRatio, 0, 7); ctx.fill();
      ctx.restore();
      if (rc.y < -12 * devicePixelRatio) rocket = null;
    }
    // 流星：低频划过 + 事件触发；页面隐藏时不生成
    if (t > nextMeteor) {
      nextMeteor = t + 380 + Math.random() * 800;
      if (!document.hidden) {
        const sp = (Math.random() * .35 + .5) * devicePixelRatio;
        meteors.push({ x: W * Math.random() * .75, y: H * Math.random() * .38, vx: sp * 2.4, vy: sp, life: 1 });
      }
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.x += m.vx; m.y += m.vy; m.life -= .015;
      if (m.life <= 0 || m.x > W + 80 || m.y > H + 80) { meteors.splice(i, 1); continue; }
      const tail = 26 * devicePixelRatio, len = Math.hypot(m.vx, m.vy) || 1;
      const tx = m.x - m.vx / len * tail, ty = m.y - m.vy / len * tail;
      const g2 = ctx.createLinearGradient(m.x, m.y, tx, ty);
      const a = (light ? .35 : .55) * Math.max(0, m.life);
      g2.addColorStop(0, light ? `rgba(65, 89, 143, ${a})` : `rgba(216, 231, 255, ${a})`);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.strokeStyle = g2; ctx.lineWidth = 1.4 * devicePixelRatio; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke();
    }
    requestAnimationFrame(frame);
  })();
}

/* ---------------------------------------------------------------- rendering */

/* 卡片跟随光晕 + 3D 微倾斜：mousemove 只采样，rAF 帧里统一写 CSS 变量，降低高频 getBoundingClientRect 开销 */
const tiltOK = matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const glow = { card: null, x: 0, y: 0, queued: false };
function queueGlow(card, e) {
  glow.card = card; glow.x = e.clientX; glow.y = e.clientY;
  if (glow.queued) return;
  glow.queued = true;
  requestAnimationFrame(() => {
    glow.queued = false;
    const c = glow.card;
    if (!c || !c.isConnected) return;
    const b = c.getBoundingClientRect();
    const nx = (glow.x - b.left) / b.width, ny = (glow.y - b.top) / b.height; // 0..1
    c.style.setProperty('--mx', (nx * 100) + '%');
    c.style.setProperty('--my', (ny * 100) + '%');
    // 倾斜角与内部视差系数（仅精确指针设备；reduced-motion 已在 tiltOK 排除）
    if (tiltOK) {
      c.style.setProperty('--ry', ((nx - .5) * 4.4).toFixed(2) + 'deg');
      c.style.setProperty('--rx', ((.5 - ny) * 3.6).toFixed(2) + 'deg');
      c.style.setProperty('--gx', (nx - .5).toFixed(3));
      c.style.setProperty('--gy', (ny - .5).toFixed(3));
    }
  });
}

function statusOf(p) {
  const r = p.runtime || {};
  const st = r.status || 'stopped';
  return { st, text: STATUS_TEXT[st] || st, cls: st === 'installing' ? 'installing' : st };
}

function cardHTML(p, i) {
  const tm = TYPE_META[p.type] || TYPE_META.unknown;
  const display = p.title || p.name;
  const { st, text, cls } = statusOf(p);
  const r = p.runtime || {};
  const isLive = ['running', 'starting'].includes(st);
  // 端口冲突：项目未运行，但配置端口已被其他进程占用 → 琥珀警示
  const pw = p.portWatch || { occupied: false, procs: [] };
  const conflict = !isLive && pw.occupied && pw.procs.length > 0;
  const conflictTag = conflict
    ? `<span class="tag conflict" data-act="conflict" title="端口 :${p.port} 被以下进程占用：${esc(pw.procs.map((x) => `${x.name} (PID ${x.pid})${x.isPanel ? ' · 面板自身，不可释放' : ''}`).join('、'))} — 点击打开详情查看并释放">${icon('alert', 12)} 端口 :${p.port} 被占用 · ${esc(pw.procs[0].name)}${pw.procs.length > 1 ? ` +${pw.procs.length - 1}` : ''}</span>`
    : '';
  const fw = p.meta && p.meta.framework ? `<span class="tag">${esc(p.meta.framework)}</span>` : '';
  const kindLabel = { web: 'Web 服务', static: '静态站点', desktop: '桌面应用', cli: '脚本/工具', service: '服务' }[p.kind] || '';
  // 降噪：健康的环境项不再逐个贴牌，只保留异常项与缺依赖提示
  const envTags = (p.env || []).filter((e) => !e.ok).map((e) =>
    `<span class="tag bad" title="${esc(e.tool)} 未检测到 · 需要 ${esc(e.req || '任意版本')}">${icon(TOOL_ICON[e.tool] || 'wrench', 12)} ${esc(e.tool)} ${icon('x', 11)}</span>`).join('');
  const depTag = p.missingDeps
    ? `<span class="tag action" data-act="install" title="点击安装依赖 (npm install)">${icon('download', 12)} 缺依赖 · 点击安装</span>`
    : (p.type === 'python' && p.meta.hasReq ? `<span class="tag" title="requirements.txt">${icon('package', 12)} pip 依赖</span>` : '');
  const portHtml = p.port && isLive
    ? `<a href="http://127.0.0.1:${p.port}" target="_blank" data-noclick="1">:${p.port} ${icon('externalLink', 10)}</a>`
    : '';
  const ready = isLive && r.health === 'ready';
  const sel = state.selected.has(p.id);
  // 运行履历：非运行态展示「上次运行 x 前」，异常卡片同时保留退出码
  const lastRunTxt = p.lastRunAt ? `上次运行 ${relTime(p.lastRunAt)}` : '';
  const footInfo = isLive
    ? `${icon('activity', 11)} 运行 ${fmtUptime(r.uptime)}`
    : (st === 'crashed'
      ? `${icon('alert', 11)} 退出码 ${r.exitCode ?? '—'}${lastRunTxt ? ' · ' + lastRunTxt : ''}`
      : lastRunTxt);
  const longrun = isLive && r.uptime >= 86400000 ? ' longrun' : '';
  return `
  <article class="card glow type-${esc(p.type)} ${st === 'running' ? 'running' : ''} ${st === 'crashed' ? 'crashed' : ''} ${st === 'starting' ? 'starting' : ''} ${st === 'stopping' ? 'stopping' : ''} ${conflict ? 'port-conflict' : ''} ${sel ? 'selected' : ''}" data-id="${p.id}" tabindex="0" style="--i:${i}">
    <i class="corners" aria-hidden="true"></i>
    <span class="card-check ${sel ? 'on' : ''}" data-act="select" title="选择该项目">${icon('check', 13)}</span>
    <div class="card-head">
      <div class="type-badge">${icon(tm.icon, 20)}</div>
      <div class="card-title">
        <h3 title="${esc(display)}">${escHl(display)}</h3>
        <div class="path" title="${esc(p.root)}（点击复制路径）">${icon('folder', 11)}${escHl(shortPath(p.root))}</div>
        <div class="desc" title="${esc(p.desc || '')}">${escHl(p.desc || '')}</div>
      </div>
      <span class="status-tag ${cls}"><span class="dot"></span>${text}${ready ? ' · 已就绪' : ''}</span>
    </div>
    <div class="chips">
      ${p.pinned ? `<span class="tag pin" title="已置顶，显示在分区最前">${icon('pin', 12)} 置顶</span>` : ''}
      ${fw}<span class="tag">${icon(tm.icon, 12)} ${tm.label}</span>
      ${kindLabel && p.kind !== 'static' ? `<span class="tag">${kindLabel}</span>` : ''}
      ${envTags}${depTag}${conflictTag}
    </div>
    <div class="card-foot">
      <span class="uptime${longrun}">${portHtml}${footInfo}</span>
      <button class="cbtn mact ${isLive ? 'halt arm' : 'go'}" data-act="${isLive ? 'stop' : 'start'}" title="${isLive ? '停止运行' : '启动项目'}" ${(!isLive && (st === 'installing' || !p.runCmd)) ? 'disabled' : ''}>${icon(isLive ? 'square' : 'play', 15)}</button>
      <button class="cbtn re" data-act="restart" title="重启" ${st === 'installing' ? 'disabled' : ''}>${icon('rotateCw', 14)}</button>
      <button class="cbtn pin ${p.pinned ? 'pinned' : ''}" data-act="pin" title="${p.pinned ? '取消置顶' : '置顶显示'}">${icon('pin', 14)}</button>
      <button class="cbtn" data-act="logs" title="日志 / 详情">${icon('logs', 14)}</button>
      <button class="cbtn" data-act="folder" title="打开目录">${icon('folderOpen', 14)}</button>
    </div>
  </article>`;
}

function shortPath(root) {
  const base = (state.system && state.system.baseDir) || '';
  let s = root || '';
  if (base && s.toLowerCase().startsWith(String(base).toLowerCase())) s = s.slice(base.length).replace(/^[\\/]/, '');
  return s;
}

function renderStats() {
  const ps = state.projects;
  const run = ps.filter((p) => ['running', 'starting'].includes(p.runtime && p.runtime.status)).length;
  const crashed = ps.filter((p) => p.runtime && p.runtime.status === 'crashed').length;
  const ports = ps.filter((p) => p.port).length;
  const box = $('#stats');
  // 首次构建仪表集群骨架；之后原地更新数字，避免 SSE 高频重建打断 countUp
  if (!box.querySelector('.cluster')) {
    const cell = (cls, jump, label) =>
      `<button class="m-cell ${cls}" data-jump="${jump}" type="button" title="点击筛选">
        <b data-count="0">0</b><span>${label}</span></button>`;
    box.innerHTML = `
      <div class="cluster">
        <div class="gauge-wrap" id="hero-gauge" title="运行占比">
          <svg class="gauge-svg" viewBox="0 0 120 120" aria-hidden="true">
            <g class="g-ticks" id="g-ticks"></g>
            <circle class="g-track" cx="60" cy="60" r="50"></circle>
            <circle class="g-bar" id="g-bar" cx="60" cy="60" r="50"></circle>
          </svg>
          <div class="gauge-in"><b id="gauge-n">0</b><span>运行中</span></div>
        </div>
        <div class="stat-mini">
          ${cell('m-all', 'all', '项目')}
          ${cell('m-run', 'running', '运行中')}
          ${cell('m-port', 'ports', '可访问')}
          ${cell('m-crash', 'crashed', '异常')}
        </div>
      </div>
      <div class="ratio-bar" id="ratio-bar"></div>`;
    buildGaugeTicks();
    animateIn($$('#stats .m-cell'), state.enterFast ? 0 : 150, state.enterFast ? 16 : 60, 8);
  }
  const nums = { all: ps.length, running: run, ports, crashed };
  $$('#stats .m-cell').forEach((c) => {
    const n = nums[c.dataset.jump] || 0;
    countUp(c.querySelector('b'), n);
    c.classList.toggle('hot', n > 0); // 语义色仅在非零时点亮
  });
  renderRatio();
}

/** 运行环刻度：60 细刻度（每 6°）+ 12 主刻度（每 30°），自 12 点方向起针 */
function buildGaugeTicks() {
  const g = $('#g-ticks'); if (!g) return;
  let out = '';
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 - 90) * Math.PI / 180;
    const major = i % 5 === 0;
    const r1 = major ? 54.4 : 56.4, r2 = 59.4;
    const c = Math.cos(a), s = Math.sin(a);
    out += `<line ${major ? 'class="maj" ' : ''}x1="${(60 + c * r1).toFixed(2)}" y1="${(60 + s * r1).toFixed(2)}" x2="${(60 + c * r2).toFixed(2)}" y2="${(60 + s * r2).toFixed(2)}"/>`;
  }
  g.innerHTML = out;
}

function renderRatio() {
  const bar = $('#ratio-bar'); if (!bar) return;
  const c = { g: 0, a: 0, s: 0, r: 0 };
  for (const p of state.projects) {
    const st = (p.runtime && p.runtime.status) || 'stopped';
    if (st === 'running') c.g++;
    else if (st === 'starting' || st === 'installing') c.a++;
    else if (st === 'crashed') c.r++;
    else c.s++;
  }
  const t = state.projects.length || 1;
  bar.innerHTML = [['g', c.g], ['a', c.a], ['s', c.s], ['r', c.r]]
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="rb ${k}" style="width:${(n / t * 100).toFixed(2)}%"></span>`).join('');
  bar.title = `运行中 ${c.g} · 启动中 ${c.a} · 已停止 ${c.s} · 异常 ${c.r}`;
  // SVG 运行环：进度弧平滑生长（dashoffset）+ 中心数字滚动
  const gbar = $('#g-bar'), gn = $('#gauge-n'), gw = $('#hero-gauge');
  if (gbar) {
    const C = 2 * Math.PI * 50;
    gbar.style.strokeDasharray = String(C);
    gbar.style.strokeDashoffset = String(+(C * (1 - c.g / t)).toFixed(2));
  }
  if (gn) countUp(gn, c.g);
  if (gw) gw.title = `运行占比 ${c.g}/${state.projects.length} · ${Math.round((c.g / t) * 100)}%`;
}
function countUp(el, target) {
  const from = +(el.dataset.cur || 0);
  el.dataset.cur = target;
  // 页面不可见时 rAF 冻结，直接落地最终值
  if (from === target || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = target; return; }
  const t0 = performance.now(), dur = 600;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step); else el.textContent = target;
  })(t0);
}

function visibleProjects() {
  return state.projects.filter((p) => {
    const st = (p.runtime && p.runtime.status) || 'stopped';
    if (state.filter === 'running' && !['running', 'starting'].includes(st)) return false;
    if (state.filter === 'stopped' && ['running', 'starting', 'crashed', 'installing'].includes(st)) return false;
    if (state.filter === 'crashed' && st !== 'crashed') return false;
    if (state.search && !searchHit(`${p.name} ${p.title || ''} ${p.desc || ''} ${p.root}`)) return false;
    return true;
  });
}

function sectionHead(cls, label, n, ic) {
  return `<div class="section-head ${cls}" role="button" tabindex="0" title="点击折叠 / 展开分区">
    <h2>${icon(ic, 14)}${label}</h2><span class="cnt">${n}</span><span class="rule"></span><span class="chev">${icon('chevronDown', 14)}</span></div>`;
}

const STATUS_ORDER = { running: 0, starting: 1, installing: 2, crashed: 3, stopping: 4, stopped: 5 };
/** 排序：smart 保持「运行中分区 + 置顶优先」；其余按选定键平铺 */
function applySort(list) {
  if (state.sort === 'smart') return list;
  const byName = (a, b) => (a.title || a.name).localeCompare(b.title || b.name, 'zh-Hans-CN');
  const s = [...list];
  if (state.sort === 'name') return s.sort(byName);
  if (state.sort === 'status') return s.sort((a, b) => (STATUS_ORDER[(a.runtime || {}).status] ?? 9) - (STATUS_ORDER[(b.runtime || {}).status] ?? 9) || byName(a, b));
  if (state.sort === 'type') return s.sort((a, b) => String(a.type).localeCompare(String(b.type)) || byName(a, b));
  return s;
}

function renderGrid() {
  const list = applySort(visibleProjects());
  const grid = $('#grid');
  // 渲染签名：状态未变化的 SSE 事件不重建卡片，避免打断交互与动画
  const sig = list.map((p) => {
    const r = p.runtime || {};
    const pw = p.portWatch || { occupied: false, procs: [] };
    return [p.id, r.status, r.health, r.pid, p.missingDeps ? 1 : 0, p.title || '', p.desc || '', p.pinned ? 1 : 0, (p.env || []).map((e) => (e.ok ? 1 : 0)).join(''), pw.occupied ? 1 : 0, pw.procs.map((x) => x.pid).join('-'), p.lastRunAt || 0, p.runCount || 0].join(':');
  }).join('|');
  if (!state.firstRender && grid.dataset.sig === sig) { renderCounts(); if (state.drawerId) renderDrawer(); return; }
  const wasFirst = state.firstRender;
  state.firstRender = false;
  grid.dataset.sig = sig;
  // 分区：运行中的项目置顶展示；分区内再按「置顶优先」排序
  const isLive = (p) => ['running', 'starting', 'installing'].includes((p.runtime || {}).status);
  const byPinned = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  const live = list.filter(isLive).sort(byPinned);
  const rest = list.filter((p) => !isLive(p)).sort(byPinned);
  const sec = (key, head, cards) =>
    `<div class="sec ${state.collapsed[key] ? 'collapsed' : ''}" data-sec="${key}">${head}<div class="sec-cards">${cards}</div></div>`;
  let html = '';
  if (state.sort === 'smart') {
    // 智能排序：运行中分区置顶；有新项目转入运行时自动展开运行中分区
    if (live.length > Number(grid.dataset.liveN || 0)) state.collapsed.live = false;
    grid.dataset.liveN = live.length;
    if (live.length) html += sec('live', sectionHead('live', '运行中', live.length, 'zap'), live.map(cardHTML).join(''));
    if (rest.length) html += sec('lib', sectionHead('lib', live.length ? '项目库' : '全部项目', rest.length, 'folder'), rest.map(cardHTML).join(''));
  } else {
    // 名称 / 状态 / 类型排序：平铺单列，不做分区
    grid.dataset.liveN = 0;
    html = list.map(cardHTML).join('');
  }
  grid.innerHTML = html;
  // 卡片集合(增删/筛选/排序)变化时重放入场；仅状态变化的重建不打扰视线
  const seq = list.map((p) => p.id).join(',');
  const seqChanged = grid.dataset.seq !== seq;
  grid.dataset.seq = seq;
  $$('#grid .card').forEach((card) => {
    card.addEventListener('mousemove', (e) => queueGlow(card, e));
  });
  if (wasFirst) animateIn($$('#grid .card'), state.enterFast ? 0 : 200, state.enterFast ? 14 : 55, 18);
  else if (seqChanged) animateIn($$('#grid .card'), 0, 24, 10);
  $('#empty').hidden = state.projects.length > 0 || !state.booted;
  $('#noresult').hidden = !(state.booted && state.projects.length > 0 && list.length === 0);
  renderCounts();
  updateBatchBar();
  if (state.drawerId) renderDrawer(); // 保持抽屉实时
}
function renderCounts() {
  const ps = state.projects;
  const c = { all: ps.length, running: 0, stopped: 0, crashed: 0 };
  ps.forEach((p) => {
    const st = (p.runtime && p.runtime.status) || 'stopped';
    if (['running', 'starting'].includes(st)) c.running++;
    else if (st === 'crashed') c.crashed++;
    else if (st !== 'installing') c.stopped++;
  });
  $('#c-all').textContent = c.all; $('#c-running').textContent = c.running;
  $('#c-stopped').textContent = c.stopped; $('#c-crashed').textContent = c.crashed;
  // 标签页标题带上运行数
  const t = (c.running ? `(${c.running}) ` : '') + 'LaunchPad · 项目启动面板';
  if (document.title !== t) document.title = t;
  renderFavicon();
}

/* 状态化 favicon：异常=玫瑰 · 有项目运行=绿 · 全部空闲=品牌靛蓝 */
let favSig = '';
function renderFavicon() {
  let crashed = false, live = false;
  for (const p of state.projects) {
    const st = (p.runtime && p.runtime.status) || 'stopped';
    if (st === 'crashed') crashed = true;
    else if (st === 'running' || st === 'starting') live = true;
  }
  const sig = crashed ? 'crashed' : live ? 'live' : 'idle';
  if (sig === favSig) return;
  favSig = sig;
  const curAccent = ACCENTS.find((x) => x.id === (document.body.getAttribute('data-accent') || 'indigo')) || ACCENTS[0];
  const color = { crashed: 'f07e95', live: '4fd39a', idle: curAccent.dark.slice(1) }[sig];
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='15' fill='%23${color}'/%3E%3Cpath d='M36 8 L17 35 H29 L25 56 L47 27 H34 Z' fill='white'/%3E%3C/svg%3E`;
}

/* ---------------------------------------------------------------- 运行动态（事件流） */

/** 值得入账的状态：starting/stopping 属瞬时过渡，不记录以免刷屏 */
const EV_TEXT = { running: '运行', stopped: '停止', crashed: '异常退出', installing: '装依赖', added: '加入', removed: '移出' };
const EV_CLS = { running: 'running', stopped: 'stopped', crashed: 'crashed', installing: 'installing', added: 'added', removed: 'removed' };

function renderEvents() {
  const box = $('#ev-list'); if (!box) return;
  const evs = state.events.slice(0, 6);
  box.innerHTML = evs.length
    ? evs.map((e, i) => `
      <button class="ev-row" data-ev="${i}" data-id="${esc(e.id)}" title="${esc(e.name)} · ${EV_TEXT[e.st] || e.st}">
        <span class="ev-dot ${EV_CLS[e.st] || ''}"></span>
        <span class="ev-name">${esc(e.name)}</span>
        <span class="ev-st">${EV_TEXT[e.st] || e.st}</span>
        <span class="ev-t">${relTime(e.t)}</span>
      </button>`).join('')
    : '<div class="ev-empty">暂无动态 — 启动 / 停止项目后这里会记录</div>';
  const ec = $('#ev-count');
  if (ec) ec.textContent = state.events.length ? String(state.events.length) : '';
}

/** 事件入账：最新在前，持久化 24 条（boot 时清理 7 天前的旧账） */
function recordEvent(e) {
  state.events.unshift({ t: Date.now(), ...e });
  state.events = state.events.slice(0, 24);
  try { localStorage.setItem('lp-events', JSON.stringify(state.events)); } catch { /* 隐私模式等，忽略 */ }
  renderEvents();
}

/* 点击动态条目 → 直达项目详情（项目已移除时提示并跳过） */
$('#ev-list').addEventListener('click', (e) => {
  const row = e.target.closest('.ev-row'); if (!row) return;
  const p = state.projects.find((x) => x.id === row.dataset.id);
  if (!p) { toast('该项目已不在面板中', 'info'); return; }
  openDrawer(p.id);
});

let envMissingOpen = false; // 导航栏「N 未装」展开状态

function renderEnvChips() {
  const tools = (state.system && state.system.tools) || {};
  const order = ['node', 'npm', 'python', 'pip', 'java', 'maven', 'dotnet', 'git'];
  const SHORT = { node: 'node', npm: 'npm', python: 'py', pip: 'pip', java: 'java', maven: 'mvn', dotnet: '.NET', git: 'git' };
  // 版本紧凑化：去掉补丁位（22.21.0 → 22.21，1.8.0_442 → 1.8）
  const shortVer = (v) => {
    if (!v) return '';
    const segs = String(v).split('.');
    return segs.length >= 3 ? segs.slice(0, 2).join('.') : String(v);
  };
  const pill = (t) => {
    const v = tools[t];
    const full = v ? `${t} v${v}` : `${t} 未安装`;
    return `<span class="env-pill ${v ? '' : 'off'}" title="${esc(full)}">
      ${icon(TOOL_ICON[t] || 'wrench', 12)} ${SHORT[t] || t} ${v ? `<b>${esc(shortVer(v))}</b>` : icon('x', 11)}</span>`;
  };
  const names = order.filter((t) => tools[t] !== undefined);
  const missing = names.filter((t) => !tools[t]);
  // 「N 未装」放行首：状态优先，窄窗口右侧渐隐时也不会被遮住
  let html = '';
  if (missing.length) {
    const list = missing.map((t) => SHORT[t] || t).join('、');
    html += `<span class="env-pill miss" data-miss-toggle title="未检测到：${esc(list)} — 点击${envMissingOpen ? '收起' : '展开'}">
      <span class="tdot"></span>${missing.length} 未装 <span class="chev" style="transform:rotate(${envMissingOpen ? 180 : 0}deg)">${icon('chevronDown', 11)}</span></span>`;
    if (envMissingOpen) html += missing.map(pill).join('');
  }
  html += names.filter((t) => tools[t]).map(pill).join('');
  const box = $('#env-chips');
  const first = !box.dataset.sig;
  if (box.dataset.sig === html) { syncChipsOverflow(); return; } // 内容未变不重建，避免动画重放
  box.dataset.sig = html;
  box.innerHTML = html;
  // 折叠标题右侧的「已装引擎数」徽标（折叠时信息不丢）
  const ec = $('#env-count');
  if (ec) { const n = names.filter((t) => tools[t]).length; ec.textContent = n ? String(n) : ''; }
  syncChipsOverflow();
  if (first) animateIn($$('#env-chips .env-pill'), state.enterFast ? 0 : 400, state.enterFast ? 16 : 60, -6);
}

/* 渐隐遮罩只在内容真正溢出时启用，避免最后一个 pill 被永久洗白 */
function syncChipsOverflow() {
  const box = $('#env-chips');
  if (!box) return;
  box.classList.toggle('scrollable', box.scrollWidth > box.clientWidth + 1);
}
addEventListener('resize', syncChipsOverflow);
$('#env-chips').addEventListener('click', (e) => {
  if (e.target.closest('[data-miss-toggle]')) { envMissingOpen = !envMissingOpen; renderEnvChips(); }
});

/* ---------------------------------------------------------------- card actions */

/* 批量选择 */
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  syncCardSel(id);
  updateBatchBar();
}
function syncCardSel(id) {
  const card = $(`.card[data-id="${id}"]`);
  if (!card) return;
  const on = state.selected.has(id);
  card.classList.toggle('selected', on);
  card.querySelector('.card-check')?.classList.toggle('on', on);
}
function setSelectMode(on) {
  state.selectMode = on;
  $('#btn-manage').classList.toggle('active', on);
  $('#grid').classList.toggle('select-mode', on);
  if (!on) {
    state.selected.clear();
    state.selAnchor = null;
    $$('#grid .card').forEach((c) => { c.classList.remove('selected'); c.querySelector('.card-check')?.classList.remove('on'); });
  }
  $('#batchbar').classList.toggle('show', on);
  updateBatchBar();
}

/* 批量模式 Shift 范围勾选：按当前 DOM 卡片顺序（= 用户所见顺序），从锚点勾到当前项。
   注意不能用 visibleProjects 的索引——分区重排（运行中置顶+置顶优先）会使其与视觉顺序脱节 */
function domCardIds() { return $$('#grid .card').map((c) => c.dataset.id); }
function visibleIdx(id) { return domCardIds().indexOf(id); }
function rangeSelect(a, b) {
  const ids = domCardIds();
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) {
    if (!ids[i] || state.selected.has(ids[i])) continue;
    state.selected.add(ids[i]);
    syncCardSel(ids[i]);
  }
  updateBatchBar();
}
function updateBatchBar() {
  const n = state.selected.size;
  $('#b-n').textContent = n;
  const visible = visibleProjects().map((p) => p.id);
  const allSel = visible.length > 0 && visible.every((id) => state.selected.has(id));
  $('#b-all-txt').textContent = allSel ? '取消全选' : '全选';
  ['b-start', 'b-stop', 'b-restart', 'b-del'].forEach((bid) => { $('#' + bid).disabled = n === 0; });
  const delBtn = $('#b-del');
  if (delBtn.dataset.confirm === '1' && n > 0) delBtn.dataset.confirm = ''; // 数量变化后重置确认态
  $('#b-del-txt').textContent = delBtn.dataset.confirm === '1' ? `确认移除 ${n} 项` : '移除';
}
async function batchAction(action, label) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const r = await post('/api/batch', { action, ids });
    const okN = (r.results || []).filter((x) => x.ok).length;
    const fails = (r.results || []).filter((x) => !x.ok);
    if (action === 'delete') {
      const gone = new Set((r.results || []).filter((x) => x.ok).map((x) => x.id));
      state.projects = state.projects.filter((p) => !gone.has(p.id));
      gone.forEach((id) => state.selected.delete(id));
      renderStats(); renderGrid();
    }
    toast(`批量${label}: 成功 ${okN} 项${fails.length ? ` · 失败 ${fails.length} 项(${fails[0].error})` : ''}`, fails.length ? 'info' : 'ok');
    if (action === 'start' && okN > 0 && window.lpRocket) window.lpRocket(); // 批量点火 → 火箭升空
    updateBatchBar();
  } catch (err) { toast(err.message, 'err'); }
}

document.addEventListener('click', async (e) => {
  const check = e.target.closest('.card-check');
  if (check) {
    const card = check.closest('.card');
    if (card) {
      // 非批量管理状态下点击勾选框：自动进入批量管理模式
      if (!state.selectMode) setSelectMode(true);
      const idx = visibleIdx(card.dataset.id);
      if (e.shiftKey && state.selAnchor != null && idx >= 0) rangeSelect(state.selAnchor, idx); // Shift 范围勾选
      else { toggleSelect(card.dataset.id); state.selAnchor = idx; }
    }
    return;
  }
  // 点击卡片路径 = 复制完整路径（批量模式下不拦截，保持选中行为）
  const pathEl = e.target.closest('.card-title .path');
  if (pathEl && !state.selectMode) {
    const pc = pathEl.closest('.card');
    const pp = pc && state.projects.find((x) => x.id === pc.dataset.id);
    if (pp) copyText(pp.root);
    return;
  }
  const card = e.target.closest('.card');
  const btn = e.target.closest('[data-act]');
  if (e.target.closest('[data-noclick]')) return; // 端口链接
  if (!btn) {
    if (card && !e.target.closest('button, a')) {
      // 批量管理模式下：点击卡片任意处即选中/取消（Shift 范围勾选），不打开详情
      if (state.selectMode) {
        const idx = visibleIdx(card.dataset.id);
        if (e.shiftKey && state.selAnchor != null && idx >= 0) rangeSelect(state.selAnchor, idx);
        else { toggleSelect(card.dataset.id); state.selAnchor = idx; }
        return;
      }
      openDrawer(card.dataset.id);
    }
    return;
  }
  if (!card) return;
  const id = card.dataset.id, act = btn.dataset.act;
  try {
    if (act === 'start') { btn.disabled = true; await post(`/api/projects/${id}/start`); toast('启动指令已发送', 'ok'); }
    else if (act === 'stop') { await post(`/api/projects/${id}/stop`); toast('正在停止…', 'info'); }
    else if (act === 'restart') { await post(`/api/projects/${id}/restart`); toast('重启中…', 'info'); }
    else if (act === 'install') { await post(`/api/projects/${id}/install`); toast('依赖安装已开始，可在日志中查看进度', 'info'); }
    else if (act === 'conflict') openDrawer(id); // 端口冲突标签：直达详情查看占用并释放
    else if (act === 'logs') openDrawer(id);
    else if (act === 'folder') await post(`/api/projects/${id}/open-folder`);
    else if (act === 'pin') {
      const p = state.projects.find((x) => x.id === id);
      await api(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !(p && p.pinned) }) });
      await refresh();
      toast(p && p.pinned ? '已取消置顶' : '已置顶，将显示在分区最前', 'ok');
    }
  } catch (err) { toast(err.message, 'err'); }
});

/* 视图切换：卡片 / 列表（偏好持久化） */
function setView(v) {
  state.view = v === 'list' ? 'list' : 'grid';
  $('#grid').classList.toggle('list', state.view === 'list');
  $$('#view-toggle .vt-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  try { localStorage.setItem('lp-view', state.view); } catch { /* ignore */ }
}
$('#view-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('.vt-btn');
  if (b) setView(b.dataset.view);
});

/* 概览迷你格点击直达：筛选 / 端口面板 */
$('#stats').addEventListener('click', (e) => {
  const c = e.target.closest('.m-cell'); if (!c) return;
  if (c.dataset.jump === 'ports') { openPortsModal(); return; }
  const chip = $(`.chip.filter[data-f="${c.dataset.jump}"]`);
  if (chip && !chip.classList.contains('active')) chip.click();
  scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------------------------------------------------------------- drawer */

function openDrawer(id) {
  state.drawerId = id;
  const p = state.projects.find((x) => x.id === id);
  if (!$('#drawer').classList.contains('open')) lockScroll(true);
  $('.drawer-panel').className = `drawer-panel type-${p ? p.type : 'unknown'}`; // 头部类型色氛围
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  // 每次打开重置日志过滤（跨项目保留过滤词容易困惑）
  state.logFilter = '';
  const lfi = $('#d-log-filter');
  if (lfi) lfi.value = '';
  syncLogFilterClear();
  setDrawerTab(state.drawerTab, true); // 恢复上次页签（静默，不重复落盘）
  renderDrawer(true);
  syncAutoscrollBtn();
  hydrateDrawerLogs(id); // 历史日志回填（服务端保留运行中进程最近 900 行）
}
function closeDrawer() {
  state.drawerId = null;
  if ($('#drawer').classList.contains('open')) lockScroll(false);
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

/** 抽屉页签切换（ov 概览 / log 日志 / hist 履历）；偏好持久化；切换时重置正文滚动（防止上一页签的滚动位置截断新页签） */
function setDrawerTab(tab, silent) {
  if (!['ov', 'log', 'hist'].includes(tab)) tab = 'ov';
  state.drawerTab = tab;
  $$('#d-tabs .d-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('#drawer .d-pane').forEach((pn) => pn.classList.toggle('on', pn.dataset.pane === tab));
  const body = $('.drawer-body');
  if (body) body.scrollTop = 0;
  if (!silent) { try { localStorage.setItem('lp-drawer-tab', tab); } catch { /* ignore */ } }
  if (tab === 'log') refreshTerm();
  if (tab === 'hist') {
    const p = state.projects.find((x) => x.id === state.drawerId);
    if (p) renderHistory(p);
  }
}

function renderDrawer(full) {
  const p = state.projects.find((x) => x.id === state.drawerId);
  if (!p) { closeDrawer(); return; }
  const r = p.runtime || {};
  const pw = p.portWatch || { occupied: false, procs: [] };
  const { st, text, cls } = statusOf(p);
  const display = p.title || p.name;
  const live = ['running', 'starting'].includes(st);
  const panel = $('.drawer-panel');
  panel.className = `drawer-panel type-${esc(p.type)} ${st === 'running' || st === 'crashed' ? 'live' : ''} ${st === 'crashed' ? 'crashed' : ''}`;

  /* 头部铭牌：类型徽标（点亮）+ 名称 + 状态签 + 路径副行（点击复制） */
  $('#d-badge').innerHTML = icon((TYPE_META[p.type] || TYPE_META.unknown).icon, 22);
  $('#d-name').textContent = display;
  const stEl = $('#d-status');
  stEl.className = `status-tag ${cls}`;
  $('#d-status-txt').textContent = text + (r.health === 'ready' ? ' · 已就绪' : '');
  const sub = $('#d-sub');
  sub.dataset.copy = p.root;
  sub.title = p.root + '（点击复制路径）';
  sub.innerHTML = `${tm2label(p)}${p.meta && p.meta.framework ? `<span class="d-sub-sep">·</span>${esc(p.meta.framework)}` : ''}<span class="d-sub-sep">·</span>${esc(shortPath(p.root))}`;

  /* 仪表条：端口（就绪可直达）/ PID / 运行时长（每秒跳）/ 累计启动 */
  const portCell = $('#d-m-port');
  portCell.className = 'd-cell';
  portCell.removeAttribute('title');
  if (!p.port) { portCell.innerHTML = '<label>端口</label><b><span class="dim">未设置</span></b>'; }
  else if (r.health === 'ready') {
    portCell.classList.add('ok');
    portCell.title = '点击打开项目地址';
    portCell.innerHTML = `<label>端口</label><b><a href="http://127.0.0.1:${p.port}" target="_blank" rel="noopener noreferrer">:${p.port} ${icon('externalLink', 11)}</a></b>`;
  } else if (pw.occupied && pw.procs.length && !live) {
    portCell.classList.add('warn');
    portCell.title = '端口被占用 — 见「概览」页签的端口占用一节';
    portCell.innerHTML = `<label>端口</label><b>:${p.port} ⚠</b>`;
  } else {
    portCell.innerHTML = `<label>端口</label><b>:${p.port}</b>`;
  }
  $('#d-m-pid').innerHTML = `<label>PID</label><b>${r.pid || '—'}</b>`;
  $('#d-m-up').innerHTML = `<label>运行时长</label><b>${live && r.uptime ? fmtUptime(r.uptime) : '—'}</b>`;
  $('#d-m-runs').innerHTML = `<label>累计启动</label><b>${p.runCount || 0}<span class="u">次</span></b>`;

  /* 运行档案：上次运行 / 退出码 / 路径（启动命令与目录在下方配置表单中编辑） */
  $('#d-kv').innerHTML = `
    <div class="k"><label>上次运行</label><b>${p.lastRunAt ? `${relTime(p.lastRunAt)} <span style="opacity:.5;font-size:11px">· ${esc(new Date(p.lastRunAt).toLocaleString('zh-CN', { hour12: false }))}</span>` : '—'}</b></div>
    <div class="k"><label>退出码</label><b class="${st === 'crashed' ? 'bad' : ''}">${r.exitCode ?? '—'}</b></div>
    <div class="k wide"><label>项目路径</label><b class="hl"><span class="copyable" data-copy="${esc(p.root)}" title="点击复制完整路径">${esc(p.root)}</span></b></div>`;

  /* 运行环境 + 依赖安装按钮按需显示 */
  const needInstall = !!(p.missingDeps || (p.type === 'python' && p.meta && p.meta.hasReq));
  $('#d-env').innerHTML = (p.env || []).map((e) => `
    <div class="env-row ${e.ok ? 'ok' : 'bad'}">
      ${icon(TOOL_ICON[e.tool] || 'wrench', 15)}
      <b>${esc(e.tool)}</b>
      <span class="req">需要 ${esc(e.req || '任意版本')}</span>
      <span class="ver">${e.installed ? 'v' + esc(e.installed) + ' ✓' : '未检测到 ✗'}</span>
    </div>`).join('') + (needInstall ? `
    <div class="env-row bad">${icon('package', 15)}<b>项目依赖</b>
      <span class="req">${p.type === 'node' ? 'node_modules 未安装' : 'requirements.txt 待校验'}</span>
      <button class="btn ghost sm" data-dact="install" style="margin-left:auto">${icon('download', 13)} 一键安装</button></div>` : '');
  const instBtn = $('#d-install');
  if (instBtn) instBtn.hidden = !needInstall;

  /* 日志页签行数徽标 */
  updateLogBadge();

  if (full) {
    $('#d-title').value = display;
    $('#d-desc').value = p.desc || '';
    $('#d-cmd').value = p.runCmd || '';
    $('#d-cwd').value = p.runCwd || '';
    $('#d-port').value = p.port || '';
    loadPortInfo(p.id);
    refreshTerm();
  }

  /* footer 状态 */
  $('#d-start').disabled = live || st === 'installing';
  $('#d-start').classList.toggle('live', live); // 运行中:实心绿转幽灵绿
  $('#d-stop').disabled = !live;
  $('#d-start').innerHTML = live ? '● ' + esc(text) + '…' : icon('play', 14) + ' 启动';
  $('#d-pin').classList.toggle('pinned', !!p.pinned);
  $('#d-pin').innerHTML = icon('pin', 14) + (p.pinned ? ' 取消置顶' : ' 置顶');
}
function tm2label(p) {
  const tm = TYPE_META[p.type] || TYPE_META.unknown;
  return `${icon(tm.icon, 13)} ${tm.label}`;
}

/* 端口占用查询与释放 */
function loadPortInfo(id) {
  if (state.drawerId !== id) return;
  const box = $('#d-port-info');
  if (!box) return;
  box.innerHTML = '<span class="dim">查询中…</span>';
  api(`/api/projects/${id}/port-info`).then((d) => {
    if (state.drawerId !== id) return;
    if (!d.port) { box.innerHTML = '<span class="dim">该项目未设置端口</span>'; return; }
    if (!d.occupied) { box.innerHTML = `<b class="mono">:${d.port}</b> <span class="ok-text">空闲 ✓</span>`; return; }
    const items = d.procs.map((x) => {
      let label = `PID ${x.pid} · ${esc(x.name)}`;
      if (x.isProject) label += '（本项目运行中）';
      if (x.isPanel) label += '（面板自身，不可释放）';
      const warn = !x.isPanel && !x.isProject ? '⚠ ' : '';
      return `<div>${warn}${label}</div>`;
    }).join('');
    const canRelease = d.procs.some((x) => !x.isPanel && !x.isProject);
    box.innerHTML = `<b class="mono">:${d.port}</b> 被占用：<div class="proc-list">${items}</div>` +
      (canRelease ? `<button class="btn danger sm" id="d-release">${icon('alert', 13)} 释放端口（结束占用进程）</button>` : '');
    const btn = $('#d-release');
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '释放中…';
      try {
        const r = await post('/api/ports/release', { port: d.port });
        toast(`已结束 ${r.killed.length} 个占用进程` + (r.failed.length ? `，${r.failed.length} 个失败` : ''), r.failed.length ? 'info' : 'ok');
        setTimeout(() => loadPortInfo(id), 1500);
      } catch (err) { toast(err.message, 'err'); loadPortInfo(id); }
    };
  }).catch(() => { if (state.drawerId === id) box.innerHTML = '<span class="dim">查询失败</span>'; });
}

/** 日志行内 URL 自动链接化：输入须为已转义文本；尾部标点不并入链接 */
const URL_RE = /https?:\/\/[^\s'"<>（）【】，。；、]+/gi;
function linkify(escaped) {
  return escaped.replace(URL_RE, (m) => {
    let href = m;
    while (/[.,;:)\]]$/.test(href)) href = href.slice(0, -1);
    if (!href) return m;
    return `<a class="log-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${m.slice(href.length)}`;
  });
}

function lineHTML(l, q = '') {
  const t = new Date(l.t);
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  // 过滤命中：琥珀左缘高亮条（不做标记内插，避免与 URL 链接嵌套冲突）
  const hit = q && String(l.x || '').toLowerCase().includes(q);
  return `<div class="tl ${esc(l.s)}${hit ? ' hit' : ''}"><span class="ts">${ts}</span><span class="x">${linkify(esc(l.x))}</span></div>`;
}

const logsCache = {};
/* 日志页签行数徽标（缓存行数，900 封顶） */
function updateLogBadge() {
  const lb = $('#d-log-n');
  if (!lb) return;
  const n = (logsCache[state.drawerId] || []).length;
  lb.hidden = !n;
  lb.textContent = String(n);
}
/** 按过滤词重渲染终端（过滤空=全量；命中行 .hit 高亮；含占位态判定） */
function refreshTerm() {
  const term = $('#d-terminal');
  if (!term || !state.drawerId) return;
  const logs = logsCache[state.drawerId] || [];
  const q = state.logFilter.trim().toLowerCase();
  const lines = q ? logs.filter((l) => String(l.x || '').toLowerCase().includes(q)) : logs;
  const p = state.projects.find((x) => x.id === state.drawerId);
  const liveNow = p && ['running', 'starting'].includes((p.runtime || {}).status);
  term.innerHTML = lines.map((l) => lineHTML(l, q)).join('')
    || (logs.length
      ? '<div class="term-placeholder">没有命中的日志行 — 试试其他关键词</div>'
      : (liveNow
        ? '<div class="term-placeholder">正在回填历史日志…</div>'
        : '<div class="term-placeholder">日志为空 — 点击「启动」查看输出</div>'));
  if (state.autoscroll) term.scrollTop = term.scrollHeight;
}
/* 向抽屉终端追加日志行（自动滚动跟随 + 900 行上限；过滤激活时走全量重渲染保证命中判定） */
function appendTermLines(id, lines) {
  if (id !== state.drawerId || !lines.length) return;
  updateLogBadge();
  if (state.logFilter.trim()) { refreshTerm(); return; }
  const term = $('#d-terminal');
  const ph = term.querySelector('.term-placeholder'); if (ph) ph.remove();
  const stick = state.autoscroll && (term.scrollTop + term.clientHeight >= term.scrollHeight - 30);
  term.insertAdjacentHTML('beforeend', lines.map(lineHTML).join(''));
  while (term.children.length > 900) term.firstElementChild.remove();
  if (stick) term.scrollTop = term.scrollHeight;
}
function appendDrawerLog(id, lines) {
  if (id !== state.drawerId) return;
  appendTermLines(id, lines);
}

/** 履历页签：项目汇总（累计启动 / 上次运行）+ 24h 时序色带 + 本项目事件账（本地近 7 天、上限 24 条） */
function renderHistory(p) {
  const sum = $('#d-hist-sum'), box = $('#d-hist');
  if (!sum || !box) return;
  const lastStr = p.lastRunAt ? new Date(p.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  sum.innerHTML = `
    <div class="d-hsum"><label>累计启动</label><b>${p.runCount || 0}<span class="u">次</span></b></div>
    <div class="d-hsum"><label>上次运行</label><b style="font-size:13px;line-height:1.5">${esc(lastStr)}</b></div>`;
  loadHistory().then((pts) => renderTimeline(p, pts)).catch(() => {});
  const evs = state.events.filter((e) => e.id === p.id);
  box.innerHTML = evs.length
    ? evs.map((e) => `
      <div class="d-hrow h-${esc(EV_CLS[e.st] || '')}">
        <span class="ev-dot ${esc(EV_CLS[e.st] || '')}"></span>
        <span class="h-st">${EV_TEXT[e.st] || esc(e.st)}</span>
        <span class="h-note">${esc(new Date(e.t).toLocaleString('zh-CN', { hour12: false }))}</span>
        <span class="h-t">${esc(relTime(e.t))}</span>
      </div>`).join('')
    : '<div class="d-empty">暂无本项目的事件记录 — 启动 / 停止 / 异常都会在这里留档（本地保存近 7 天）。</div>';
}

/* ---------------------------------------------------------------- 24h 运行时序（履历页签色带） */

const ST_TEXT = { running: '运行中', stopped: '已停止', crashed: '异常', installing: '安装依赖' };
let historyCache = { points: [], at: 0 };
/** 拉取状态历史（/api/history，60s 缓存） */
async function loadHistory(force) {
  if (!force && Date.now() - historyCache.at < 60000) return historyCache.points;
  try {
    const data = await api('/api/history?hours=24');
    historyCache = { points: data.points || [], at: Date.now() };
  } catch { /* 面板旧版本或离线：保持上次缓存 */ }
  return historyCache.points;
}
/** 渲染单项目 24h 时序色带：记录序列 + 当前状态虚拟点（延伸到 now） */
function renderTimeline(p, points) {
  const wrap = $('#d-timeline'), track = $('#d-tl-track');
  if (!wrap || !track || !p) return;
  const now = Date.now(), SPAN = 24 * 3600 * 1000, start = now - SPAN;
  const norm = (st) => (st === 'starting' ? 'running' : st === 'stopping' ? 'stopped' : st);
  const mine = points.filter((x) => x.id === p.id && x.t >= start).sort((a, b) => a.t - b.t);
  const curSt = norm((p.runtime || {}).status || 'stopped');
  if (!mine.length || norm(mine[mine.length - 1].st) !== curSt) mine.push({ id: p.id, t: now, st: curSt });
  const pct = (t) => Math.max(0, Math.min(100, ((t - start) / SPAN) * 100));
  const segs = [];
  for (let i = 0; i < mine.length; i++) {
    const s = mine[i].t, e = i + 1 < mine.length ? mine[i + 1].t : now;
    if (e > s) segs.push({ s, e, st: norm(mine[i].st) });
  }
  const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  track.innerHTML = segs.map((g) => {
    const l = pct(g.s), w = pct(g.e) - l;
    return `<div class="d-tl-seg ${g.st}" style="left:${l}%;width:${Math.max(w, 0.35)}%" title="${ST_TEXT[g.st] || g.st} · ${fmt(g.s)} → ${fmt(g.e)}"></div>`;
  }).join('') || '<div class="d-tl-empty">暂无记录 — 状态变迁将逐步填满色带</div>';
  wrap.hidden = false;
}

/* 历史日志回填：抽屉打开 / SSE 重连时从服务端拉取增量（服务端为运行中进程保留最近 900 行）。
   after 取缓存末行时间戳——与 SSE 行时间戳同源，天然去重衔接；
   覆盖场景：先启动后刷新页面、面板重启接管运行中项目后查看等 */
async function hydrateDrawerLogs(id) {
  try {
    const cache = logsCache[id] || [];
    const after = cache.length ? cache[cache.length - 1].t : 0;
    const d = await api(`/api/projects/${id}/logs?after=${after}`);
    const lines = (d.logs || []).filter((l) => l && typeof l.x === 'string');
    if (!lines.length) {
      // 服务端也无账可回：按运行状态给出准确提示
      if (!cache.length && state.drawerId === id) {
        const p = state.projects.find((x) => x.id === id);
        const liveNow = p && ['running', 'starting'].includes((p.runtime || {}).status);
        const term = $('#d-terminal');
        if (term && !term.querySelector('.tl')) {
          term.innerHTML = liveNow
            ? '<div class="term-placeholder">暂无输出 — 进程尚未产生日志，或产生于面板接管之前；重启项目后可完整记录</div>'
            : '<div class="term-placeholder">日志为空 — 点击「启动」查看输出</div>';
        }
      }
      return;
    }
    logsCache[id] = [...cache, ...lines].slice(-900);
    appendTermLines(id, lines);
  } catch { /* 静默：回填失败不影响抽屉其余功能 */ }
}

/* drawer 内动作 */
$('#drawer').addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) { closeDrawer(); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyText(cp.dataset.copy); return; }
  const b = e.target.closest('[data-dact]');
  if (!b) return;
  const id = state.drawerId;
  try {
    if (b.dataset.dact === 'install') { await post(`/api/projects/${id}/install`); toast('依赖安装已开始', 'info'); }
  } catch (err) { toast(err.message, 'err'); }
});
/* 启动 / 重启后自动切到日志页签看输出（已在该页签则不动） */
function drawerWatchOutput() {
  if (state.drawerId && state.drawerTab !== 'log') setDrawerTab('log');
}
$('#d-start').onclick = () => { act('start'); drawerWatchOutput(); };
$('#d-stop').onclick = () => act('stop');
$('#d-restart').onclick = () => { act('restart'); drawerWatchOutput(); };
$('#d-pin').onclick = async () => {
  const id = state.drawerId; if (!id) return;
  const p = state.projects.find((x) => x.id === id);
  try {
    await api(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !(p && p.pinned) }) });
    await refresh();
    toast(p && p.pinned ? '已取消置顶' : '已置顶，将显示在分区最前', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
async function act(name) {
  const id = state.drawerId; if (!id) return;
  try { await post(`/api/projects/${id}/${name}`); toast(name === 'stop' ? '正在停止…' : '指令已发送', 'ok'); setTimeout(() => loadPortInfo(id), 1500); }
  catch (err) { toast(err.message, 'err'); }
}
$('#d-save').onclick = async () => {
  const id = state.drawerId; if (!id) return;
  try {
    await api(`/api/projects/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('#d-title').value.trim(),
        desc: $('#d-desc').value.trim(),
        runCmd: $('#d-cmd').value.trim() || null,
        runCwd: $('#d-cwd').value.trim(),
        port: $('#d-port').value.trim() ? Number($('#d-port').value.trim()) : null,
      }),
    });
    await refresh();
    toast('配置已保存', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
$('#d-reanalyze').onclick = async () => {
  const id = state.drawerId; if (!id) return;
  try { await post(`/api/projects/${id}/analyze`); await refresh(); toast('已重新分析项目', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
};
$('#d-open-folder').onclick = () => { const id = state.drawerId; if (id) post(`/api/projects/${id}/open-folder`).catch(() => {}); };
$('#d-remove').onclick = async (e) => {
  const id = state.drawerId; if (!id) return;
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'; btn.textContent = '确认删除？';
    setTimeout(() => { btn.dataset.confirm = ''; btn.innerHTML = icon('trash', 14) + ' 删除'; }, 2600);
    return;
  }
  try { await api(`/api/projects/${id}`, { method: 'DELETE' }); toast('已移除项目（不删除文件）', 'ok'); closeDrawer(); await refresh(); }
  catch (err) { toast(err.message, 'err'); }
};
/* 自动滚动按钮状态化：开启时点亮 */
function syncAutoscrollBtn() {
  const b = $('#d-autoscroll');
  if (b) b.classList.toggle('active', state.autoscroll);
}
$('#d-autoscroll').onclick = () => { state.autoscroll = !state.autoscroll; syncAutoscrollBtn(); };

/* 复制日志（带时间戳与流前缀，走剪贴板兜底链路）；过滤激活时仅复制命中行 */
$('#d-copylog').onclick = () => {
  const all = logsCache[state.drawerId] || [];
  if (!all.length) { toast('暂无日志可复制', 'info'); return; }
  const q = state.logFilter.trim().toLowerCase();
  const lines = q ? all.filter((l) => String(l.x || '').toLowerCase().includes(q)) : all;
  if (!lines.length) { toast('没有命中的日志行可复制', 'info'); return; }
  copyText(lines.map((l) => {
    const d = new Date(l.t);
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const tag = l.s === 'err' ? '[ERR] ' : l.s === 'sys' ? '[SYS] ' : '';
    return `${ts} ${tag}${l.x}`;
  }).join('\n'), q ? `已复制过滤结果 ${lines.length} 行（共 ${all.length} 行）` : `已复制全部日志 ${all.length} 行`);
};
$('#d-port-refresh').onclick = () => { const id = state.drawerId; if (id) loadPortInfo(id); };

/* 页签切换（点击 + 偏好持久化在 setDrawerTab 内） */
$('#d-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.d-tab');
  if (b) setDrawerTab(b.dataset.tab);
});

/* 日志行过滤：输入即过滤，命中行琥珀高亮 */
$('#d-log-filter').addEventListener('input', (e) => {
  state.logFilter = e.target.value;
  syncLogFilterClear();
  refreshTerm();
});
$('#d-log-filter-clear').onclick = () => {
  state.logFilter = '';
  $('#d-log-filter').value = '';
  syncLogFilterClear();
  refreshTerm();
  $('#d-log-filter').focus();
};
function syncLogFilterClear() {
  const b = $('#d-log-filter-clear');
  if (b) b.hidden = !state.logFilter;
}

/* 清屏：过滤激活时先清过滤再清屏（语义一致：清空当前视图） */
$('#d-clear').onclick = () => {
  if (state.logFilter) {
    state.logFilter = '';
    $('#d-log-filter').value = '';
    syncLogFilterClear();
  }
  $('#d-terminal').innerHTML = '<div class="term-placeholder">日志为空 — 点击「启动」查看输出</div>';
};

/* 安装依赖（v1.1.20 修复：原按钮从未绑定事件）——安装后自动切到日志页签看进度 */
$('#d-install').onclick = async () => {
  const id = state.drawerId; if (!id) return;
  try {
    await post(`/api/projects/${id}/install`);
    toast('依赖安装已开始 — 已切到日志页签', 'info');
    setDrawerTab('log');
  } catch (err) { toast(err.message, 'err'); }
};
$('#d-terminal').addEventListener('scroll', (e) => {
  const t = e.target;
  state.autoscroll = t.scrollTop + t.clientHeight >= t.scrollHeight - 30;
});

/* ---------------------------------------------------------------- add modal */

async function openAddModal() {
  if (!$('#modal-add').classList.contains('open')) lockScroll(true);
  $('#modal-add').classList.add('open');
  $('#modal-add').setAttribute('aria-hidden', 'false');
  renderScanList('idle'); // 不自动扫描：打开即扫慢且常无新项目，改为手动触发
  $('#set-basedir').value = (state.system && state.system.baseDir) || '';
}
function closeAddModal() {
  if ($('#modal-add').classList.contains('open')) lockScroll(false);
  $('#modal-add').classList.remove('open');
  $('#modal-add').setAttribute('aria-hidden', 'true');
}
/* 弹窗内手动扫描（「扫描」按钮触发；保存根目录后也走这里） */
async function runScanInModal() {
  renderScanList(null);
  try {
    const data = await post('/api/scan', {});
    renderScanList(data);
    if (state.system) state.system.lastScanAt = Date.now();
    renderHeroSub();
    toast(`扫描完成 · 发现 ${data.discovered} 个候选${data.added && data.added.length ? '，新增 ' + data.added.length + ' 个' : ''}`, 'ok');
  } catch (err) { toast(err.message, 'err'); renderScanList('idle'); }
}
function renderScanList(data) {
  const box = $('#scan-list');
  if (data === 'idle') { box.innerHTML = `<div class="scan-row"><span class="pt">点「扫描」查找根目录下的新项目，或直接在下方输入路径添加</span></div>`; return; }
  if (!data) { box.innerHTML = `<div class="scan-row"><span class="pt">扫描中…</span></div>`; return; }
  const existing = new Set(state.projects.map((p) => String(p.root).toLowerCase()));
  const rows = [];
  for (const p of data.projects || []) {
    rows.push(`<div class="scan-row"><span class="nm">${esc(p.title || p.name)}</span><span class="pt">${esc(shortPath(p.root))} · ${p.type}</span><span class="tag ok">已注册 ✓</span></div>`);
  }
  box.innerHTML = rows.join('') || '<div class="scan-row"><span class="pt">未发现新项目 — 根目录下没有可识别的清单文件</span></div>';
}
$('#btn-add').onclick = openAddModal;
$('#btn-scan').onclick = async (e) => {
  const b = e.currentTarget; b.classList.add('loading');
  try {
    const data = await post('/api/scan', {});
    await refresh();
    toast(data.added && data.added.length ? `发现并添加 ${data.added.length} 个新项目` : '扫描完成，没有新项目', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  b.classList.remove('loading');
};
$('#btn-scan-empty').onclick = () => $('#btn-scan').click();
$('#add-path-btn').onclick = async () => {
  const v = $('#add-path').value.trim();
  if (!v) return;
  try {
    const data = await post('/api/projects', { root: v });
    $('#add-path').value = '';
    await refresh();
    toast(`已添加项目「${data.project.name}」`, 'ok');
    closeAddModal();
  } catch (err) { toast(err.message, 'err'); }
};
$('#add-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#add-path-btn').click(); });
$$('#modal-add [data-close]').forEach((el) => el.onclick = closeAddModal);

/* 根目录设置：保存后立即重新扫描新目录 */
$('#btn-rescan').onclick = () => runScanInModal();
$('#set-basedir-btn').onclick = async () => {
  const v = $('#set-basedir').value.trim();
  if (!v) { toast('请输入根目录路径', 'err'); return; }
  const btn = $('#set-basedir-btn');
  btn.disabled = true;
  try {
    const d = await post('/api/settings', { baseDir: v });
    state.system.baseDir = d.baseDir;
    $('#set-basedir').value = d.baseDir;
    renderHeroSub();
    toast('根目录已保存，正在扫描新目录…', 'ok');
    const data = await post('/api/scan', {});
    state.system.lastScanAt = Date.now();
    await refresh();
    renderScanList(data);
    toast(`扫描完成 · 发现 ${data.discovered} 个候选${data.added && data.added.length ? '，新增 ' + data.added.length + ' 个' : ''}`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
  btn.disabled = false;
};
$('#set-basedir').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#set-basedir-btn').click(); });

/* ---------------------------------------------------------------- 命令面板 Ctrl+K */

const pal = { items: [], idx: 0 };

function palOpen() {
  $('#modal-palette').classList.add('open');
  $('#modal-palette').setAttribute('aria-hidden', 'false');
  const inp = $('#pal-input');
  inp.value = '';
  palRender('');
  setTimeout(() => inp.focus(), 40);
}
function palClose() {
  $('#modal-palette').classList.remove('open');
  $('#modal-palette').setAttribute('aria-hidden', 'true');
}
function palToggle() { $('#modal-palette').classList.contains('open') ? palClose() : palOpen(); }

function palData(q) {
  const ql = q.trim().toLowerCase();
  const terms = ql.split(/\s+/).filter(Boolean);
  const hit = (s) => {
    if (!terms.length) return true;
    const low = String(s).toLowerCase();
    return terms.every((t) => low.includes(t));
  };
  const projs = state.projects
    .filter((p) => hit(`${p.name} ${p.title || ''} ${p.desc || ''} ${p.root}`))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map((p) => {
      const st = (p.runtime && p.runtime.status) || 'stopped';
      return {
        kind: 'proj', id: p.id, st,
        live: ['running', 'starting'].includes(st),
        icon: (TYPE_META[p.type] || TYPE_META.unknown).icon,
        label: p.title || p.name,
        sub: shortPath(p.root),
      };
    });
  const acts = [
    { kind: 'act', icon: 'scanLine', label: '扫描项目', sub: '在根目录发现新项目', run: () => { palClose(); $('#btn-scan').click(); } },
    { kind: 'act', icon: 'plus', label: '添加项目', sub: '手动路径 / 扫描面板', run: () => { palClose(); openAddModal(); } },
    { kind: 'act', icon: 'network', label: '端口管理', sub: '查看与释放系统端口', run: () => { palClose(); openPortsModal(); } },
    { kind: 'act', icon: 'check', label: state.selectMode ? '退出批量管理' : '批量管理', sub: '多选项目批量启停', run: () => { palClose(); setSelectMode(!state.selectMode); } },
    { kind: 'act', icon: 'rows', label: '切换密度', sub: '舒适 / 紧凑 / 极简 · 自动记忆', run: () => { palClose(); setDensity(DENSITY[(DENSITY.indexOf(densityNow()) + 1) % DENSITY.length]); } },
    { kind: 'act', icon: 'sun', label: '切换主题', sub: '浅色 / 深色 · 圆形过渡', run: () => { palClose(); toggleTheme(); } },
    { kind: 'act', icon: 'helpCircle', label: '操作指南', sub: '鼠标 / 快捷键 / 技巧', run: () => { palClose(); openHelp(); } },
  ].filter((a) => hit(a.label + ' ' + a.sub));
  return { projs, acts };
}

function palRender(q) {
  const { projs, acts } = palData(q);
  pal.items = [...projs, ...acts];
  pal.idx = 0;
  const list = $('#pal-list');
  if (!pal.items.length) { list.innerHTML = '<div class="pal-empty">没有匹配的项目或命令</div>'; return; }
  let html = '';
  if (projs.length) html += '<div class="pal-group">项目</div>';
  html += projs.map((it, i) => palItemHTML(it, i)).join('');
  if (acts.length) html += '<div class="pal-group">命令</div>';
  html += acts.map((it, i) => palItemHTML(it, projs.length + i)).join('');
  list.innerHTML = html;
  palSyncSel();
}
function palItemHTML(it, i) {
  const dot = { running: 'g', starting: 'a', crashed: 'r', installing: 'b' }[it.st] || '';
  return `<div class="pal-item ${i === pal.idx ? 'sel' : ''}" data-idx="${i}">
    <span class="pi-ic">${icon(it.icon, 14)}</span>
    <span class="pi-main"><b>${esc(it.label)}</b><span>${esc(it.sub || '')}</span></span>
    ${it.kind === 'proj' ? `<span class="pi-dot ${dot}"></span>
      <button class="pi-act ${it.live ? 'halt' : 'go'}" data-pact="${it.live ? 'stop' : 'start'}" data-pid="${it.id}" title="${it.live ? '停止' : '启动'}">${icon(it.live ? 'square' : 'play', 12)}</button>` : ''}
  </div>`;
}
function palSyncSel() {
  $$('#pal-list .pal-item').forEach((el) => el.classList.toggle('sel', +el.dataset.idx === pal.idx));
  const sel = $('#pal-list .pal-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function palRun(i) {
  const it = pal.items[i]; if (!it) return;
  if (it.kind === 'proj') { palClose(); openDrawer(it.id); }
  else it.run();
}

$('#pal-input').addEventListener('input', (e) => palRender(e.target.value));
$('#pal-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.idx = Math.min(pal.idx + 1, pal.items.length - 1); palSyncSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.idx = Math.max(pal.idx - 1, 0); palSyncSel(); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(pal.idx); }
  else if (e.key === 'Escape') { e.stopPropagation(); palClose(); }
});
$('#pal-list').addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-pact]');
  if (actBtn) {
    e.stopPropagation();
    try { await post(`/api/projects/${actBtn.dataset.pid}/${actBtn.dataset.pact}`); toast(actBtn.dataset.pact === 'stop' ? '正在停止…' : '启动指令已发送', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    return;
  }
  const item = e.target.closest('.pal-item');
  if (item) palRun(+item.dataset.idx);
});
$('#pal-list').addEventListener('mousemove', (e) => {
  const item = e.target.closest('.pal-item');
  if (item && +item.dataset.idx !== pal.idx) { pal.idx = +item.dataset.idx; palSyncSel(); }
});
$$('#modal-palette [data-close]').forEach((el) => el.onclick = palClose);
$('#btn-palette').onclick = palOpen;

/* ---------------------------------------------------------------- filters / search */

/** 统一的筛选切换：同步 chips 高亮 + 本地记忆偏好 */
function setFilter(f) {
  if (!['all', 'running', 'stopped', 'crashed'].includes(f) || state.filter === f) return;
  state.filter = f;
  $$('.chip.filter').forEach((c) => c.classList.toggle('active', c.dataset.f === f));
  try { localStorage.setItem('lp-filter', f); } catch { /* ignore */ }
  renderGrid();
}

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip.filter'); if (!chip || chip.classList.contains('active')) return;
  try { chip.animate([{ transform: 'scale(1)' }, { transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }); } catch { /* ignore */ }
  setFilter(chip.dataset.f);
});

/* 排序方式：smart=运行中分区；名称/状态/类型=平铺排序（偏好持久化） */
function setSort(s) {
  if (!['smart', 'name', 'status', 'type'].includes(s)) s = 'smart';
  if (state.sort === s) return;
  state.sort = s;
  try { localStorage.setItem('lp-sort', s); } catch { /* ignore */ }
  renderGrid();
}
$('#sort-sel').addEventListener('change', (e) => setSort(e.target.value));

/* 密度三档循环：舒适 cozy → 紧凑 compact → 极简 minimal（偏好持久化） */
const DENSITY = ['cozy', 'compact', 'minimal'];
const DENSITY_LABEL = { cozy: '舒适', compact: '紧凑', minimal: '极简' };
function setDensity(mode, silent) {
  if (!DENSITY.includes(mode)) mode = 'cozy';
  document.body.classList.toggle('compact', mode === 'compact');
  document.body.classList.toggle('density-minimal', mode === 'minimal');
  const b = $('#btn-density');
  if (b) {
    b.classList.toggle('active', mode !== 'cozy');
    b.title = `密度：${DENSITY_LABEL[mode]}（点击切换）`;
  }
  try { localStorage.setItem('lp-density', mode); } catch { /* ignore */ }
  if (!silent) toast(`密度：${DENSITY_LABEL[mode]}`, 'info');
}
function densityNow() {
  return document.body.classList.contains('density-minimal') ? 'minimal'
    : document.body.classList.contains('compact') ? 'compact' : 'cozy';
}
$('#btn-density').onclick = () => setDensity(DENSITY[(DENSITY.indexOf(densityNow()) + 1) % DENSITY.length]);
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  $('#search-wrap').classList.toggle('has-val', !!state.search);
  renderGrid();
});
/* 搜索框一键清除：有内容时替代 Ctrl K 徽标出现 */
$('#btn-search-clear').onclick = () => {
  const inp = $('#search');
  inp.value = ''; state.search = '';
  $('#search-wrap').classList.remove('has-val');
  renderGrid();
  inp.focus();
};

/* 分区折叠：点击标题切换；支持键盘 Enter/空格 */
$('#grid').addEventListener('click', (e) => {
  const head = e.target.closest('.section-head');
  if (!head) return;
  const sec = head.closest('.sec'); if (!sec) return;
  const key = sec.dataset.sec;
  state.collapsed[key] = !state.collapsed[key];
  sec.classList.toggle('collapsed', state.collapsed[key]);
});
$('#grid').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('section-head')) {
    e.preventDefault(); e.target.click();
    return;
  }
  /* 卡片键盘可达：Tab 聚焦后 Enter/空格 打开详情；批量模式下为勾选切换 */
  if (e.key === 'Enter' || e.key === ' ') {
    const card = e.target.closest && e.target.closest('.card');
    if (!card || e.target !== card) return;
    e.preventDefault();
    if (state.selectMode) toggleSelect(card.dataset.id);
    else openDrawer(card.dataset.id);
  }
});

/* 无结果：一键清除搜索与筛选 */
$('#btn-clear-filter').onclick = () => {
  $('#search').value = ''; state.search = '';
  $('#search-wrap').classList.remove('has-val');
  setFilter('all');
};

/* 全局快捷键：Ctrl+K 命令面板；/ 聚焦搜索；1-4 快速筛选；G 切换视图；Esc 自上而下关闭弹窗→抽屉 */
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); palToggle(); return; }
  const ae = document.activeElement;
  const inField = ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName);
  /* 数字键：抽屉打开时 1/2/3 切页签（概览/日志/履历）、↑↓ 切换上/下一个项目；否则 1-4 切筛选（输入框聚焦或带修饰键时不触发） */
  if (!inField && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if ($('#drawer').classList.contains('open')) {
      const tabMap = { 1: 'ov', 2: 'log', 3: 'hist' };
      if (tabMap[e.key]) { e.preventDefault(); setDrawerTab(tabMap[e.key]); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // 按当前网格同款排序（筛选+搜索+排序方式）取相邻项目，抽屉内容平滑切换、页签保持
        const list = applySort(visibleProjects());
        const i = list.findIndex((x) => x.id === state.drawerId);
        if (i < 0) return;
        const to = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (to >= 0 && to < list.length) openDrawer(list[to].id);
        else toast(e.key === 'ArrowDown' ? '已经是最后一个项目' : '已经是第一个项目', 'info');
        return;
      }
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      setFilter(['all', 'running', 'stopped', 'crashed'][Number(e.key) - 1]); return;
    }
    if (e.key === 'g' || e.key === 'G') { setView(state.view === 'grid' ? 'list' : 'grid'); return; }
    if (e.key === 'r' || e.key === 'R') { refresh().then(() => toast('数据已刷新', 'ok')).catch(() => {}); return; }
    if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  }
  if (e.key === '/' && !inField) {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  } else if (e.key === 'Escape') {
    if (ctxOpen) { closeCtxMenu(); return; } // 右键菜单最优先关闭
    if (inField && ae.id === 'search' && $('#search').value) {
      $('#search').value = ''; state.search = '';
      $('#search-wrap').classList.remove('has-val');
      renderGrid();
      return;
    }
    if ($('#modal-palette').classList.contains('open')) { palClose(); return; }
    if ($('#modal-rescue').classList.contains('open')) { closeRescue(); return; }
    if ($('#modal-ports').classList.contains('open')) { closePortsModal(); return; }
    if ($('#modal-add').classList.contains('open')) { closeAddModal(); return; }
    if ($('#modal-help').classList.contains('open')) { closeHelp(); return; }
    if ($('#drawer').classList.contains('open')) closeDrawer();
    else if (state.selectMode) { setSelectMode(false); toast('已退出批量管理', 'info'); } // 无弹层时 Esc 退出批量
  }
});

/* 方向键导航：↑↓←→ 在卡片间移动焦点（网格感知跨行/列），Home/End 跳首尾；
   输入框聚焦、弹层/抽屉打开、右键菜单悬浮时不接管 */
addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const nav = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'first', End: 'last' }[e.key];
  if (!nav) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  if (document.querySelector('.modal.open, .drawer.open') || ctxOpen) return;
  const cards = $$('#grid .card');
  if (!cards.length) return;
  const focusCard = (c) => { c.focus(); c.scrollIntoView({ block: 'nearest' }); };
  const cur = cards.indexOf(ae);
  if (nav === 'first') { e.preventDefault(); return focusCard(cards[0]); }
  if (nav === 'last') { e.preventDefault(); return focusCard(cards[cards.length - 1]); }
  if (cur < 0) {
    // 焦点不在卡片上：↑/↓ 进入首/尾卡片；←/→ 不接管（保留页面滚动）
    if (nav !== 'up' && nav !== 'down') return;
    e.preventDefault();
    return focusCard(nav === 'down' ? cards[0] : cards[cards.length - 1]);
  }
  e.preventDefault();
  // 列数按卡片 offsetLeft 去重推算（列表视图=1 列，网格=实际列数）
  const cols = Math.max(1, new Set(cards.map((c) => c.offsetLeft)).size);
  let to = cur;
  if (nav === 'left') to = Math.max(0, cur - 1);
  else if (nav === 'right') to = Math.min(cards.length - 1, cur + 1);
  else if (nav === 'up') to = Math.max(0, cur - cols);
  else to = Math.min(cards.length - 1, cur + cols);
  if (to !== cur) focusCard(cards[to]);
});

/* 回到顶部 */
const toTopBtn = $('#to-top');
addEventListener('scroll', () => toTopBtn.classList.toggle('show', scrollY > 420), { passive: true });
toTopBtn.onclick = () => scrollTo({ top: 0, behavior: 'smooth' });

/* 粘贴即添加：在页面空白处粘贴 Windows 绝对路径时，自动打开「添加项目」并填入 */
const WIN_PATH_RE = /^[A-Za-z]:[\\/][^\\/\r\n]*$/;
addEventListener('paste', (e) => {
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return; // 输入框内正常粘贴
  if ($('#modal-add').classList.contains('open')) return;
  const raw = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  const text = raw.split(/\r?\n/)[0].trim().replace(/^"|"$/g, ''); // 资源管理器多选/带引号时取首行
  if (!text || !WIN_PATH_RE.test(text)) return;
  openAddModal();
  $('#add-path').value = text;
  toast('检测到路径，已填入 — 点「分析并添加」完成', 'info');
});

/* 点击空白处：星尘涟漪小彩蛋（仅限非交互区域；交互元素上点击不触发） */
document.addEventListener('click', (e) => {
  if (!window.lpPuff) return;
  if (e.target.closest('.card, button, a, input, textarea, select, label, .side, .topbar, .modal, .drawer, .ctx-menu, .batchbar, .toasts, .to-top, .shutdown-fab, .section-head, .stat-mini, .ev-list, .filters')) return;
  window.lpPuff(e.clientX, e.clientY);
});

/* 按钮波纹：按下交互控件时从指针处扩散一圈同色涟漪（语义色 currentColor，减动效环境跳过） */
document.addEventListener('pointerdown', (e) => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const b = e.target.closest('.btn, .cbtn, .chip, .d-tab, .vt-btn');
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const s = document.createElement('i');
  s.className = 'ripple';
  const d = Math.max(r.width, r.height) * 2.2;
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px;`;
  b.appendChild(s);
  setTimeout(() => s.remove(), 700);
});

/* ---------------------------------------------------------------- 操作指南 */

const HELP_DATA = {
  mouse: [
    ['移动鼠标', '背景视差 + 光标灯笼，星空随你转动'],
    ['悬停卡片', '跟随光晕 + 3D 微倾斜 + 徽标视差'],
    ['点击空白处', '星尘涟漪小彩蛋（非交互区域）'],
    ['单击卡片', '打开详情抽屉：概览 / 日志 / 履历 三页签'],
    ['主按钮', '卡片左下大按钮一键 启动 / 停止'],
    ['右键卡片', '快捷菜单：启动 / 停止 / 重启 / 目录 / 置顶'],
    ['勾选框', '选中项目，自动进入批量管理'],
    ['Shift + 点击', '批量模式下从上次勾选处范围选择'],
    ['点击路径', '复制项目完整路径'],
    ['点击端口', '新标签页打开项目地址（就绪时）'],
    ['长按右下角 ⊗', '关闭启动器，运行中项目不受影响'],
  ],
  keys: [
    ['Ctrl K', '命令面板：搜项目 / 执行命令'],
    ['/', '聚焦搜索框（支持空格分词多关键词）'],
    ['1 - 4', '筛选：全部 / 运行中 / 已停止 / 异常'],
    ['1 / 2 / 3', '抽屉打开时切换页签：概览 / 日志 / 履历'],
    ['↑ ↓ ← →', '卡片间移动焦点；抽屉内 ↑↓ 切上/下一个项目'],
    ['G', '切换 卡片 / 列表 视图'],
    ['R', '手动刷新面板数据'],
    ['Home / End', '跳到首 / 尾卡片'],
    ['Tab + ↵', '聚焦卡片后打开详情 / 勾选'],
    ['Esc', '逐层关闭：搜索 → 弹窗 → 抽屉 → 批量模式'],
    ['?', '打开本指南'],
  ],
  tips: [
    ['粘贴即添加', '页面空白处 Ctrl+V 路径，自动填入添加框'],
    ['抽屉指挥舱', '头部仪表条一目了然；端口就绪时点击数字直达项目地址'],
    ['三页签工作台', '概览 / 日志 / 履历分区清晰，日志独占全高，页签偏好自动记忆'],
    ['抽屉内巡览', '↑↓ 直接切换上/下一个项目，页签保持不动；边界自动提示'],
    ['日志行过滤', '日志页签顶部输入关键词，命中行琥珀高亮，新行持续跟进'],
    ['异常守护', '项目异常退出立即弹提醒（含退出码），不会无声挂掉'],
    ['主题色板', '侧栏调色盘按钮循环切换 靛蓝 / 青碧 / 落日 / 石墨，favicon 联动'],
    ['24h 运行时序', '履历页签色带回看一天运行区间，悬停读时刻，每分钟自动延展'],
    ['急救中心', '侧栏救生圈一键 全部停止 / 全部重启，只影响运行中项目'],
    ['精密细节', '悬停取景框锁定、状态轨生长、按钮波纹 — 仪器感藏在细节里'],
    ['运行履历', '履历页签回看本项目启动 / 停止 / 异常账本（本地近 7 天）'],
    ['仪表集群', '左舱运行环 + 概览 + 比例尺；语义色仅在非零时点亮'],
    ['运行动态', '启动 / 停止 / 异常实时入账，点击条目直达详情'],
    ['点火流星', '单个项目启动流星划过，批量点火火箭升空'],
    ['深空细节', '卫星信号涟漪、火箭爬升、地平线辉光，静置亦有生命'],
    ['时段氛围', '极光色随清晨 / 黄昏 / 深夜微调，时间看得见'],
    ['状态一眼辨', '左缘状态轨：绿=运行 · 玫瑰=异常 · 琥珀=端口冲突'],
    ['点火动效', '启动瞬间卡片泛起绿色扫光，熄火对应玫瑰余晖'],
    ['密度三档', '筛选行可循环切换 舒适 / 紧凑 / 极简，偏好自动记忆'],
    ['运行中分区', '智能排序下运行中的项目自动置顶并实时计时，≥24h 琥珀提醒'],
    ['端口冲突', '未运行但端口被占时卡片亮琥珀警示，点击直达释放'],
    ['断线自愈', '连接断开自动退避重连，日志与运行数据不丢'],
  ],
};
let helpRendered = false;

function renderHelp() {
  if (helpRendered) return;
  const fill = (sel, rows) => {
    $(sel).innerHTML = rows.map(([k, v]) => `<div class="h-row"><span class="h-k">${esc(k)}</span><span class="h-v">${esc(v)}</span></div>`).join('');
  };
  fill('#help-mouse', HELP_DATA.mouse);
  fill('#help-keys', HELP_DATA.keys);
  fill('#help-tips', HELP_DATA.tips);
  helpRendered = true;
}

function openHelp() {
  renderHelp();
  if (!$('#modal-help').classList.contains('open')) lockScroll(true);
  $('#modal-help').classList.add('open');
  $('#modal-help').setAttribute('aria-hidden', 'false');
}
function closeHelp() {
  if (!$('#modal-help').classList.contains('open')) return;
  lockScroll(false);
  $('#modal-help').classList.remove('open');
  $('#modal-help').setAttribute('aria-hidden', 'true');
  try { localStorage.setItem('lp-help-seen', '1'); } catch { /* ignore */ }
}
$('#btn-help').onclick = () => openHelp();
$$('#modal-help [data-close]').forEach((el) => { el.onclick = closeHelp; });

/* ---------------------------------------------------------------- 卡片右键菜单 */

const ctxMenu = $('#ctx-menu');
let ctxOpen = false;

function closeCtxMenu() {
  if (!ctxOpen) return;
  ctxOpen = false;
  ctxMenu.hidden = true;
}

/** 按项目状态生成菜单：启动/停止/重启随状态禁用，运行中可直达端口 */
function openCtxMenu(x, y, p) {
  const st = (p.runtime && p.runtime.status) || 'stopped';
  const live = ['running', 'starting'].includes(st);
  const canStart = !live && st !== 'installing' && !!p.runCmd;
  const items = [
    { ic: 'logs', label: '打开详情', act: 'detail' },
    { ic: 'play', label: '启动', act: 'start', cls: 'go', disabled: !canStart },
    { ic: 'square', label: '停止', act: 'stop', cls: 'halt', disabled: !live },
    { ic: 'rotateCw', label: '重启', act: 'restart', cls: 're', disabled: st === 'installing' },
    live && p.port ? { ic: 'externalLink', label: `打开 :${p.port}`, act: 'open-port' } : null,
    'sep',
    { ic: 'folderOpen', label: '打开目录', act: 'folder' },
    { ic: 'copy', label: '复制路径', act: 'copy-path' },
    { ic: 'pin', label: p.pinned ? '取消置顶' : '置顶', act: 'pin', cls: p.pinned ? 'pinned' : 'pinc' },
  ].filter(Boolean);
  ctxMenu.innerHTML = items.map((it) => it === 'sep'
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item ${it.cls || ''} ${it.disabled ? 'disabled' : ''}" role="menuitem" data-ctx="${it.act}">${icon(it.ic, 14)} ${esc(it.label)}</div>`).join('');
  ctxMenu.dataset.pid = p.id;
  ctxMenu.hidden = false;
  ctxOpen = true;
  // 视口边界内收，避免菜单被裁切
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 10)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 10)) + 'px';
}

async function ctxRun(act, p) {
  const id = p.id;
  try {
    if (act === 'detail') openDrawer(id);
    else if (act === 'start') { await post(`/api/projects/${id}/start`); toast('启动指令已发送', 'ok'); }
    else if (act === 'stop') { await post(`/api/projects/${id}/stop`); toast('正在停止…', 'info'); }
    else if (act === 'restart') { await post(`/api/projects/${id}/restart`); toast('重启中…', 'info'); }
    else if (act === 'open-port') window.open(`http://127.0.0.1:${p.port}`, '_blank');
    else if (act === 'folder') await post(`/api/projects/${id}/open-folder`);
    else if (act === 'copy-path') copyText(p.root);
    else if (act === 'pin') {
      await api(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !p.pinned }) });
      await refresh();
      toast(p.pinned ? '已取消置顶' : '已置顶，将显示在分区最前', 'ok');
    }
  } catch (err) { toast(err.message, 'err'); }
}

ctxMenu.addEventListener('click', (e) => {
  const it = e.target.closest('[data-ctx]');
  if (!it) return;
  const p = state.projects.find((x) => x.id === ctxMenu.dataset.pid);
  closeCtxMenu();
  if (it.classList.contains('disabled') || !p) return;
  ctxRun(it.dataset.ctx, p);
});
$('#grid').addEventListener('contextmenu', (e) => {
  if (e.target.closest('a')) return; // 链接保留浏览器默认菜单
  const card = e.target.closest('.card');
  if (!card) return;
  const p = state.projects.find((x) => x.id === card.dataset.id);
  if (!p) return;
  e.preventDefault();
  openCtxMenu(e.clientX, e.clientY, p);
});
// 点击外部 / Esc / 窗口失焦 / 改变尺寸时关闭菜单
addEventListener('pointerdown', (e) => { if (ctxOpen && !e.target.closest('#ctx-menu')) closeCtxMenu(); }, true);
addEventListener('blur', closeCtxMenu);
addEventListener('resize', closeCtxMenu);

/* 「上次运行 x 前」相对时间低频校准（30s 一次，页面隐藏时跳过） */
setInterval(() => {
  if (document.hidden) return;
  $$('#grid .card').forEach((card) => {
    const p = state.projects.find((x) => x.id === card.dataset.id);
    if (!p || !p.lastRunAt) return;
    const st = (p.runtime && p.runtime.status) || 'stopped';
    if (['running', 'starting'].includes(st)) return;
    const el = card.querySelector('.uptime');
    if (!el || !el.lastChild) return;
    const target = (st === 'crashed' && p.runtime ? `退出码 ${p.runtime.exitCode ?? '—'} · ` : '') + `上次运行 ${relTime(p.lastRunAt)}`;
    if (el.lastChild.textContent !== target) el.lastChild.textContent = target;
  });
}, 30000);

/* ---------------------------------------------------------------- 关闭启动器（右下角圆形按钮） */

let byeShown = false;
function showBye() {
  if (byeShown) return;
  byeShown = true;
  try { if (es) es.close(); } catch { /* ignore */ }
  const b = $('#bye');
  if (b) { b.hidden = false; requestAnimationFrame(() => b.classList.add('show')); }
}

const shutdownBtn = $('#btn-shutdown');
const HOLD_MS = 1500; // 长按时长
let holdTimer = null, hintTimer = null, firing = false;

function showHint() {
  const h = $('#sf-hint');
  if (!h) return;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('show'), 2400);
}

// 按住开始：进度环 1.5s 填满后关闭
shutdownBtn.addEventListener('pointerdown', (e) => {
  if (firing || e.button > 0) return;
  shutdownBtn.classList.add('holding');
  clearTimeout(holdTimer);
  holdTimer = setTimeout(async () => {
    firing = true;
    shutdownBtn.classList.add('firing');
    try { await post('/api/shutdown'); } catch { /* 服务可能已直接退出 */ }
    setTimeout(showBye, 400);
  }, HOLD_MS);
});
// 提前松手：复位进度环并提示操作方式
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => shutdownBtn.addEventListener(ev, () => {
  if (firing) return;
  clearTimeout(holdTimer);
  if (shutdownBtn.classList.contains('holding')) {
    shutdownBtn.classList.remove('holding');
    showHint();
  }
}));
shutdownBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // 防长按弹菜单

/* ---------------------------------------------------------------- 批量操作栏 */

$('#btn-manage').onclick = () => setSelectMode(!state.selectMode);
$('#b-exit').onclick = () => setSelectMode(false);
$('#b-all').onclick = () => {
  const visible = visibleProjects().map((p) => p.id);
  const allSel = visible.length > 0 && visible.every((id) => state.selected.has(id));
  if (allSel) visible.forEach((id) => state.selected.delete(id));
  else visible.forEach((id) => state.selected.add(id));
  $$('#grid .card').forEach((c) => syncCardSel(c.dataset.id));
  updateBatchBar();
};
$('#b-start').onclick = () => batchAction('start', '启动');
$('#b-stop').onclick = () => batchAction('stop', '停止');
$('#b-restart').onclick = () => batchAction('restart', '重启');
$('#b-del').onclick = function () {
  if (this.dataset.confirm !== '1') {
    this.dataset.confirm = '1';
    $('#b-del-txt').textContent = `确认移除 ${state.selected.size} 项`;
    setTimeout(() => { if (this.isConnected) { this.dataset.confirm = ''; updateBatchBar(); } }, 3000);
    return;
  }
  this.dataset.confirm = '';
  batchAction('delete', '移除');
};

/* ---------------------------------------------------------------- SSE + polling */

let es = null, sseRetry = 3000, sseTimer = null;
function connectSSE() {
  try {
    es = new EventSource('/api/events');
    es.onopen = () => {
      sseRetry = 3000;
      const b = $('#sse-badge'); if (b) b.hidden = true;
      if (state.drawerId) hydrateDrawerLogs(state.drawerId); // 重连补拉断线期间错过的日志
    };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'status' && msg.project) {
          const idx = state.projects.findIndex((p) => p.id === msg.project.id);
          if (msg.project.removed) {
            if (idx >= 0) {
              const gone = state.projects[idx];
              recordEvent({ id: msg.project.id, name: gone.title || gone.name, st: 'removed' });
              state.projects.splice(idx, 1);
            }
            state.selected.delete(msg.project.id);
            updateBatchBar();
          }
          else if (idx >= 0) {
            const prevSt = (state.projects[idx].runtime && state.projects[idx].runtime.status) || 'stopped';
            const rt = msg.project.runtime; delete msg.project.runtime;
            state.projects[idx] = Object.assign(state.projects[idx], msg.project, { runtime: rt });
            // 状态变迁入账（瞬时过渡 starting/stopping 不记录）
            const nextSt = (rt && rt.status) || prevSt;
            if (nextSt !== prevSt && EV_TEXT[nextSt]) {
              recordEvent({ id: msg.project.id, name: msg.project.title || msg.project.name || state.projects[idx].title || state.projects[idx].name, st: nextSt });
            }
            // 点火彩蛋：项目进入运行态，一颗流星划过背景
            if (nextSt !== prevSt && nextSt === 'running' && window.lpMeteor) window.lpMeteor();
            // 异常守护：项目异常退出立即提醒（手动停止走 stopping→stopped，不会误报）
            if (nextSt !== prevSt && nextSt === 'crashed') {
              const nm = msg.project.title || msg.project.name || state.projects[idx].title || state.projects[idx].name || '项目';
              toast(`「${nm}」异常退出${rt && rt.exitCode != null ? `（退出码 ${rt.exitCode}）` : ''}`, 'err', 6000);
            }
          } else {
            state.projects.push(msg.project);
            recordEvent({ id: msg.project.id, name: msg.project.title || msg.project.name || '', st: 'added' });
          }
          renderStats(); renderGrid();
        } else if (msg.type === 'log' && msg.id) {
          (logsCache[msg.id] = logsCache[msg.id] || []).push(...msg.lines);
          if (logsCache[msg.id].length > 900) logsCache[msg.id].splice(0, logsCache[msg.id].length - 900);
          appendDrawerLog(msg.id, msg.lines);
        } else if (msg.type === 'shutdown') {
          showBye(); // 面板即将退出：展示告别屏并停止重连
        }
      } catch {}
    };
    es.onerror = () => {
      const b = $('#sse-badge'); if (b) b.hidden = false;
      es.close();
      clearTimeout(sseTimer);
      sseTimer = setTimeout(connectSSE, sseRetry);
      sseRetry = Math.min(Math.round(sseRetry * 1.6), 15000); // 指数退避：3s → 15s 封顶，成功后重置
    };
  } catch { /* SSE 不可用时靠轮询 */ }
}

async function refresh() {
  const [sys, proj] = await Promise.all([api('/api/system'), api('/api/projects')]);
  state.system = sys;
  state.projects = proj.projects;
  renderEnvChips(); renderStats(); renderGrid(); renderHeroSub(); renderHeroMeta(); renderFoot();
}

function renderHeroSub() {
  const el = $('#hero-sub');
  if (!el || !state.system) return;
  const run = state.projects.filter((p) => ['running', 'starting'].includes((p.runtime || {}).status)).length;
  const scan = state.system.lastScanAt ? ` · 上次扫描 ${new Date(state.system.lastScanAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
  el.innerHTML = `${state.projects.length} 个项目 · ${run} 个运行中 <span class="mono" style="opacity:.7">· 根目录 ${esc(state.system.baseDir || '')}${scan}</span>`;
}

/* 问候语 + 日期（每分钟校准一次即可） */
function greetText() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
let heroMetaSig = '';
function renderHeroMeta() {
  const g = $('#hero-greet'), d = $('#hero-date');
  if (!g || !d) return;
  g.textContent = greetText();
  const n = new Date();
  const dateStr = `${n.getFullYear()}/${String(n.getMonth() + 1).padStart(2, '0')}/${String(n.getDate()).padStart(2, '0')} · 周${'日一二三四五六'[n.getDay()]}`;
  if (heroMetaSig === dateStr) return; // 日期未变不重写
  heroMetaSig = dateStr;
  d.textContent = dateStr;
}

function renderFoot() {
  const fv = $('#foot-ver');
  if (fv && state.system) fv.textContent = 'v' + (state.system.version || '—');
  const fi = $('#foot-info');
  if (fi) {
    const run = state.projects.filter((p) => ['running', 'starting'].includes((p.runtime || {}).status)).length;
    fi.textContent = `${state.projects.length} 个项目 · ${run} 运行中 · 数据存储于 data/projects.json`;
  }
}

/* 时钟（冒号拆分以便 CSS 呼吸；顺带低频校准问候/日期） */
setInterval(() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#clock').innerHTML = `${pad(d.getHours())}<i>:</i>${pad(d.getMinutes())}<i>:</i>${pad(d.getSeconds())}`;
  if (d.getSeconds() === 0) renderHeroMeta();
}, 1000);

/* 实时刷新运行时长（仅更新文本，不重建卡片） */
setInterval(() => {
  for (const p of state.projects) {
    const r = p.runtime;
    if (r && ['running', 'starting'].includes(r.status) && r.startedAt) r.uptime = Date.now() - r.startedAt;
  }
  $$('#grid .card').forEach((card) => {
    const p = state.projects.find((x) => x.id === card.dataset.id);
    if (!p || !p.runtime || !['running', 'starting'].includes(p.runtime.status)) return;
    const el = card.querySelector('.uptime');
    if (el && el.lastChild) {
      el.lastChild.textContent = '运行 ' + fmtUptime(p.runtime.uptime);
      el.classList.toggle('longrun', p.runtime.uptime >= 86400000); // 运行 ≥24h：琥珀提示
    }
  });
  if (state.drawerId) {
    const p = state.projects.find((x) => x.id === state.drawerId);
    if (p && p.runtime && p.runtime.uptime) {
      // 仪表条「运行时长」每秒跳动（仅运行/启动中态）
      if (['running', 'starting'].includes(p.runtime.status)) {
        const up = $('#d-m-up b');
        if (up) up.textContent = fmtUptime(p.runtime.uptime);
      }
    }
    // 履历页签的时序色带每 60s 自动刷新（新状态区间延展到「现在」）
    if (p && state.drawerTab === 'hist' && Date.now() - (renderTimeline._at || 0) > 60000) {
      renderTimeline._at = Date.now();
      loadHistory().then((pts) => renderTimeline(p, pts)).catch(() => {});
    }
  }
}, 1000);

/* 兜底轮询（SSE 正常时服务器推送足够，10s 一次校准） */
setInterval(() => refresh().catch(() => {}), 10000);

/* ---------------------------------------------------------------- boot */

$('#btn-add-empty').onclick = () => openAddModal();

(async function boot() {
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('lp-theme') || 'dark'; } catch { /* ignore */ }
  applyTheme(savedTheme === 'light', false);
  try { setView(localStorage.getItem('lp-view') || 'grid'); } catch { setView('grid'); }
  // 恢复排序与密度偏好
  let savedSort = 'smart';
  try { savedSort = localStorage.getItem('lp-sort') || 'smart'; } catch { /* ignore */ }
  state.sort = ['smart', 'name', 'status', 'type'].includes(savedSort) ? savedSort : 'smart';
  const sortSel = $('#sort-sel'); if (sortSel) sortSel.value = state.sort;
  let savedDensity = 'cozy';
  try { savedDensity = localStorage.getItem('lp-density') || 'cozy'; } catch { /* ignore */ }
  setDensity(savedDensity, true);
  // 恢复抽屉页签偏好（打开抽屉时回到上次停留的页签）
  try {
    const t = localStorage.getItem('lp-drawer-tab');
    if (['ov', 'log', 'hist'].includes(t)) state.drawerTab = t;
  } catch { /* ignore */ }
  // 恢复主题色板（靛蓝为默认）
  try {
    const a = localStorage.getItem('lp-accent');
    if (a && ACCENTS.some((x) => x.id === a)) applyAccent(a);
  } catch { /* ignore */ }
  // 左侧「运行环境」：默认折叠，点击标题展开（记忆用户选择）
  const envSec = $('#side-env-sec'), envToggle = $('#side-env-toggle');
  if (envSec && envToggle) {
    let envOpen = false;
    try { envOpen = localStorage.getItem('lp-env-open') === '1'; } catch { /* ignore */ }
    const applyEnv = () => {
      envSec.classList.toggle('env-closed', !envOpen);
      try { localStorage.setItem('lp-env-open', envOpen ? '1' : '0'); } catch { /* ignore */ }
    };
    envToggle.onclick = () => { envOpen = !envOpen; applyEnv(); if (envOpen) syncChipsOverflow(); };
    applyEnv();
  }
  // 恢复上次筛选偏好（chips 高亮在 setFilter 内同步）
  let savedFilter = 'all';
  try { savedFilter = localStorage.getItem('lp-filter') || 'all'; } catch { /* ignore */ }
  state.filter = ['all', 'running', 'stopped', 'crashed'].includes(savedFilter) ? savedFilter : 'all';
  $$('.chip.filter').forEach((c) => c.classList.toggle('active', c.dataset.f === state.filter));
  // 运行动态：恢复近 7 天事件账本（上限 24 条，过期清理）
  try {
    state.events = (JSON.parse(localStorage.getItem('lp-events')) || [])
      .filter((e) => e && e.t && Date.now() - e.t < 7 * 86400000);
  } catch { state.events = []; }
  renderEvents();
  hydrateIcons();
  startBackground();
  try { state.enterFast = sessionStorage.getItem('lp-entered') === '1'; } catch { state.enterFast = false; }
  const sk = $('#skeleton');
  if (sk) sk.hidden = false; // 数据到达前先展示骨架屏
  try {
    await refresh();
    try { sessionStorage.setItem('lp-entered', '1'); } catch { /* ignore */ } // 同会话后续刷新走快速入场
    if (state.system) $('#empty-basedir').textContent = state.system.baseDir || '';
  } catch (err) {
    toast('无法连接服务: ' + err.message, 'err');
  } finally {
    state.booted = true;
    if (sk) sk.hidden = true;
  }
  connectSSE();
  // 首次访问自动展示一次操作指南（之后可随时按 ? 或右上角 ? 按钮 打开）
  let seenHelp = true;
  try { seenHelp = !!localStorage.getItem('lp-help-seen'); } catch { /* ignore */ }
  if (!seenHelp) setTimeout(() => { if (state.booted && !$('#drawer').classList.contains('open')) openHelp(); }, 900);
})();
