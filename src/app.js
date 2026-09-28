'use strict';
/* ============================================================================
   线框画布 — 渲染进程
   两种模式：
     app    : 主界面（多画板 + 拖框 + 标注 + 截图）
     export : 离屏渲染单个画板，1:1 设备像素，供货给主进程截图
   ========================================================================== */
(function () {
  const api = window.api || browserStub();

  /* 直接在浏览器打开时的兜底：界面可用，截图/文件功能提示需用桌面客户端 */
  function browserStub() {
    const no = () => Promise.reject(new Error('浏览器预览模式：截图与文件功能需要在桌面客户端中使用'));
    return {
      mode: 'app',
      captureArtboards: no, copyImage: no, savePng: no,
      saveProject: no, openProject: no,
      setTitle() {}, reportLayout() {}, exportReady() {},
    };
  }

  /* ==========================================================================
     常量
     ======================================================================== */
  const DEVICES = [
    { key: 'd1920', name: '桌面 1920', w: 1920, h: 1080 },
    { key: 'd1440', name: '桌面 1440', w: 1440, h: 900  },
    { key: 'd1366', name: '桌面 1366', w: 1366, h: 768  },
    { key: 'd1280', name: '笔记本 1280', w: 1280, h: 800 },
    { key: 't1024', name: '平板横屏 1024', w: 1024, h: 768 },
    { key: 't768',  name: '平板竖屏 768',  w: 768,  h: 1024 },
    { key: 'm430',  name: '手机 430',  w: 430, h: 932 },
    { key: 'm390',  name: '手机 390',  w: 390, h: 844 },
    { key: 'm375',  name: '手机 375',  w: 375, h: 812 },
    { key: 'm360',  name: '安卓 360',  w: 360, h: 800 },
  ];
  const LV = ['h1', 'h2', 'h3', 'p', 'box'];
  const LV_LABEL = { h1: 'h1', h2: 'h2', h3: 'h3', p: 'p', box: 'box' };
  const LV_NAME  = { h1: '一级标题', h2: '二级标题', h3: '三级标题', p: '正文', box: '容器/其他' };
  /* 每个框的左下角编号：a1 / a2 / a3 …（画板内按顺序自动编号，永远连续） */
  const ID_PREFIX = 'a';
  const MIN_W = 24, MIN_H = 16;
  const LS_KEY = 'wireframe-canvas.project.v1';
  const STRIP_H = 30;

  /* ==========================================================================
     小工具
     ======================================================================== */
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rnd = Math.round;
  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  const $ = (s) => document.querySelector(s);

  /* ==========================================================================
     导出模式：早退
     ======================================================================== */
  if (api && api.mode === 'export') {
    document.body.dataset.mode = 'export';
    runExport();
    return;
  }

  /* ==========================================================================
     状态
     ======================================================================== */
  let project = null;
  let selected = null;      // box id
  let editing  = null;      // box id
  let zoom     = 1;
  let spaceDown = false;
  let history = [], hIdx = -1;
  let dirty = false;

  const D = {               // 当前拖拽会话
    kind: null, boardEl: null, boxEl: null, dir: null,
    sx: 0, sy: 0, scale: 1, orig: null, moved: false, preview: null,
  };

  /* ---------- DOM ---------- */
  const viewport = $('#viewport');
  const workspace = $('#workspace');
  const guides = $('#guides');
  const emptyState = $('#empty');
  const toastEl = $('#toast');

  /* ==========================================================================
     数据
     ======================================================================== */
  function devOf(key) { return DEVICES.find((d) => d.key === key) || { key: 'custom', name: '自定义', w: 0, h: 0 }; }

  function mkArtboard(devKey, name) {
    const d = devOf(devKey);
    return { id: uid('a'), name: name || d.name, device: d.key, w: d.w, h: d.h, boxes: [] };
  }

  function newProject() {
    return {
      version: 1,
      name: '未命名工程',
      artboards: [mkArtboard('d1440', '首页 · 桌面'), mkArtboard('m390', '首页 · 手机')],
    };
  }

  const findAB  = (id) => project.artboards.find((a) => a.id === id);
  const findBox = (ab, id) => ab.boxes.find((b) => b.id === id);
  function boardOf(boxId) { return project.artboards.find((a) => a.boxes.some((b) => b.id === boxId)); }
  function boxById(boxId) { const ab = boardOf(boxId); return ab ? findBox(ab, boxId) : null; }

  /* ---------- 框编号：a1 / a2 / a3 … ---------- */
  function labelOf(boxId) {
    const ab = boardOf(boxId);
    if (!ab) return '';
    const i = ab.boxes.findIndex((b) => b.id === boxId);
    return i < 0 ? '' : ID_PREFIX + (i + 1);
  }
  /* 增删框之后，把界面上所有编号刷一遍（保证连续） */
  function refreshLabels() {
    workspace.querySelectorAll('.artboard').forEach((be) => {
      const ab = findAB(be.dataset.id);
      if (!ab) return;
      be.querySelectorAll('.box').forEach((d) => {
        const chip = d.querySelector('.oid');
        if (!chip) return;
        const i = ab.boxes.findIndex((b) => b.id === d.dataset.id);
        chip.textContent = i < 0 ? '' : ID_PREFIX + (i + 1);
      });
    });
  }
  function currentBoard() {
    if (selected) { const ab = boardOf(selected); if (ab) return ab; }
    const vr = viewport.getBoundingClientRect();
    const cy = vr.top + vr.height / 2;
    let best = null, bestD = Infinity;
    workspace.querySelectorAll('.artboard').forEach((be) => {
      const r = be.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - cy) + Math.abs(r.left + r.width / 2 - (vr.left + vr.width / 2)) * 0.4;
      if (d < bestD) { bestD = d; best = findAB(be.dataset.id); }
    });
    return best || project.artboards[0];
  }

  /* ==========================================================================
     Toast
     ======================================================================== */
  let toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => { toastEl.hidden = true; }, 200);
    }, 1900);
  }

  /* ==========================================================================
     历史 / 存盘
     ======================================================================== */
  function pushHistory() {
    const s = JSON.stringify(project);
    if (history[hIdx] === s) return;
    history = history.slice(0, hIdx + 1);
    history.push(s);
    if (history.length > 150) history.shift();
    hIdx = history.length - 1;
    refreshUndoButtons();
    scheduleSave();
  }
  function restore(snap) {
    project = JSON.parse(snap);
    if (selected && !boxById(selected)) selected = null;
    editing = null;
    render();
    refreshUndoButtons();
  }
  function undo() { if (hIdx > 0) { hIdx--; restore(history[hIdx]); } }
  function redo() { if (hIdx < history.length - 1) { hIdx++; restore(history[hIdx]); } }
  function canUndo() { return hIdx > 0; }
  function canRedo() { return hIdx < history.length - 1; }
  function refreshUndoButtons() {
    $('#btnUndo').disabled = !canUndo();
    $('#btnRedo').disabled = !canRedo();
  }

  let saveTimer = null;
  function scheduleSave() {
    if (!dirty) { dirty = true; $('#dirty').hidden = false; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (_) {}
    }, 400);
    updateTitle();
  }
  function markClean() { dirty = false; $('#dirty').hidden = true; updateTitle(); }
  function updateTitle() {
    const t = `${project.name}${dirty ? ' •' : ''} — 线框画布`;
    document.title = t;
    if (api.setTitle) api.setTitle(t);
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.artboards) && p.artboards.length) return p;
    } catch (_) {}
    return null;
  }

  /* ==========================================================================
     渲染
     ======================================================================== */
  function render() {
    const keepScroll = { l: viewport.scrollLeft, t: viewport.scrollTop };
    workspace.innerHTML = '';
    project.artboards.forEach((a) => workspace.appendChild(buildArtboard(a)));
    emptyState.hidden = project.artboards.length > 0;
    refreshLabels();
    $('#projName').value = project.name;
    viewport.scrollLeft = keepScroll.l;
    viewport.scrollTop = keepScroll.t;
    refreshStatus();
    updateTitle();
  }

  function buildArtboard(a) {
    const wrap = el('div', 'artboard-wrap');
    wrap.dataset.id = a.id;

    const head = el('div', 'ab-head');
    head.dataset.id = a.id;
    const dev = devOf(a.device);
    head.append(el('span', 'nm', a.name), el('span', 'dim', `${a.w} × ${a.h}`));
    if (!a.name.includes(dev.name)) head.append(el('span', 'badge', dev.name));
    head.title = '点击：画板设置';

    const board = el('div', 'artboard');
    board.dataset.id = a.id;
    board.style.width = a.w + 'px';
    board.style.height = a.h + 'px';
    a.boxes.forEach((b) => board.appendChild(buildBox(b)));

    wrap.append(head, board);
    return wrap;
  }

  function buildBox(b) {
    const d = el('div', 'box');
    d.dataset.id = b.id;
    applyBoxGeom(d, b);
    d.dataset.lv = b.level || 'p';
    d.classList.toggle('selected', selected === b.id);
    d.classList.toggle('editing', editing === b.id);

    const t = el('div', 'txt');
    t.dataset.ph = '写这个区域要放什么…';
    t.textContent = b.text || '';

    const tag = el('div', 'tag', LV_LABEL[b.level] || 'p');
    tag.title = '点击切换层级：h1 → h2 → h3 → p → box';

    /* 左下角编号 a1 / a2 … */
    const oid = el('div', 'oid', labelOf(b.id));
    oid.title = `这个框的引用编号：${labelOf(b.id)}`;

    const hs = el('div', 'handles');
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((k) => {
      const h = el('div', 'hd');
      h.dataset.d = k;
      hs.appendChild(h);
    });

    d.append(t, tag, oid, hs);
    return d;
  }

  function applyBoxGeom(d, b) {
    d.style.left = b.x + 'px';
    d.style.top = b.y + 'px';
    d.style.width = b.w + 'px';
    d.style.height = b.h + 'px';
  }

  function refreshStatus() {
    const total = project.artboards.reduce((n, a) => n + a.boxes.length, 0);
    $('#countInfo').textContent = `${project.artboards.length} 画板 · ${total} 框`;
    const b = selected ? boxById(selected) : null;
    $('#selInfo').textContent = b ? `${b.w}×${b.h} @ ${b.x},${b.y} · ${LV_NAME[b.level] || ''}` : '';
    $('#btnZoomVal').textContent = Math.round(zoom * 100) + '%';
  }

  function select(id) {
    if (selected === id) return;
    const prev = selected ? workspace.querySelector(`.box[data-id="${selected}"]`) : null;
    if (prev) prev.classList.remove('selected');
    selected = id;
    if (id) {
      const cur = workspace.querySelector(`.box[data-id="${id}"]`);
      if (cur) cur.classList.add('selected');
    }
    refreshStatus();
  }

  /* ==========================================================================
     缩放 / 平移
     ======================================================================== */
  function setZoom(z, anchor) {
    const next = clamp(z, 0.1, 4);
    const vr = viewport.getBoundingClientRect();
    let cx = anchor ? anchor.x - vr.left : vr.width / 2;
    let cy = anchor ? anchor.y - vr.top : vr.height / 2;
    const old = zoom;
    const sx = (viewport.scrollLeft + cx) / old;
    const sy = (viewport.scrollTop + cy) / old;
    zoom = next;
    workspace.style.zoom = zoom;
    viewport.scrollLeft = sx * zoom - cx;
    viewport.scrollTop = sy * zoom - cy;
    refreshStatus();
  }

  function fitView() {
    if (!project.artboards.length) return;
    const vr = viewport.getBoundingClientRect();
    const gap = 64, padX = 72, padY = 96;
    const totalW = project.artboards.reduce((s, a) => s + a.w, 0) + gap * (project.artboards.length - 1) + padX * 2;
    const maxH = Math.max(...project.artboards.map((a) => a.h)) + padY * 2;
    const z = clamp(Math.min((vr.width - 8) / totalW, (vr.height - 8) / maxH), 0.1, 1);
    zoom = 1;
    workspace.style.zoom = 1;
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
    setZoom(z);
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }

  /* ==========================================================================
     指针交互
     ======================================================================== */
  function boardScaleOf(boardEl) {
    const a = findAB(boardEl.dataset.id);
    const r = boardEl.getBoundingClientRect();
    return r.width / (a ? a.w : r.width) || 1;
  }
  function toLocal(boardEl, clientX, clientY) {
    const r = boardEl.getBoundingClientRect();
    const s = boardScaleOf(boardEl);
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s, s };
  }
  function locate(node) {
    const boxEl = node.closest('.box');
    const boardEl = node.closest('.artboard');
    return { boxEl, boardEl };
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || spaceDown) { startPan(e); return; }
    if (e.button !== 0) return;

    const { boxEl, boardEl } = locate(e.target);

    /* 层级标签 → 切换 */
    const tag = e.target.closest('.tag');
    if (tag && boxEl) {
      e.preventDefault();
      if (editing) commitEdit();
      select(boxEl.dataset.id);
      cycleLevel(boxEl.dataset.id, e.shiftKey ? -1 : 1);
      return;
    }

    /* 缩放手柄 */
    const hd = e.target.closest('.hd');
    if (hd && boxEl && boardEl) { e.preventDefault(); startResize(e, boardEl, boxEl, hd.dataset.d); return; }

    /* 框体 */
    if (boxEl && boardEl) {
      if (editing === boxEl.dataset.id) return;      // 编辑中：交给浏览器做文本选择
      if (editing) commitEdit();
      select(boxEl.dataset.id);
      startMove(e, boardEl, boxEl);
      return;
    }

    /* 画板标题栏 → 交给 click 处理，不要取消选择 */
    if (e.target.closest('.ab-head')) return;

    /* 画板空白 → 拉新框 */
    if (boardEl && !e.target.closest('.ab-head')) {
      if (editing) commitEdit();
      select(null);
      startCreate(e, boardEl);
      return;
    }

    /* 其它空白 → 取消选择 */
    if (editing) commitEdit();
    select(null);
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!D.kind) return;
    if (D.kind === 'move')    doMove(e);
    else if (D.kind === 'resize') doResize(e);
    else if (D.kind === 'create') doCreate(e);
    else if (D.kind === 'pan')    doPan(e);
  });

  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('dblclick', (e) => {
    const { boxEl, boardEl } = locate(e.target);
    if (boxEl) { enterEdit(boxEl.dataset.id); return; }
    if (boardEl) {
      const a = findAB(boardEl.dataset.id);
      const p = toLocal(boardEl, e.clientX, e.clientY);
      const w = Math.min(220, a.w - 20), h = 40;
      const nb = {
        id: uid('b'), level: 'p', text: '',
        x: clamp(rnd(p.x - w / 2), 0, a.w - w), y: clamp(rnd(p.y - h / 2), 0, a.h - h),
        w, h,
      };
      a.boxes.push(nb);
      boardEl.appendChild(buildBox(nb));
      select(nb.id);
      pushHistory();
      enterEdit(nb.id);
    }
  });

  /* ---------- 创建 ---------- */
  function startCreate(e, boardEl) {
    const a = findAB(boardEl.dataset.id);
    const p = toLocal(boardEl, e.clientX, e.clientY);
    const ghost = el('div', 'box');
    ghost.style.borderStyle = 'solid';
    ghost.style.borderColor = 'var(--accent)';
    ghost.style.background = 'rgba(47,110,243,.10)';
    ghost.style.pointerEvents = 'none';
    boardEl.appendChild(ghost);
    D.kind = 'create'; D.boardEl = boardEl; D.boxEl = null;
    D.sx = p.x; D.sy = p.y; D.scale = p.s; D.moved = false; D.preview = ghost;
    boardEl.classList.add('drag-create');
    viewport.setPointerCapture(e.pointerId);
  }
  function doCreate(e) {
    const p = toLocal(D.boardEl, e.clientX, e.clientY);
    const a = findAB(D.boardEl.dataset.id);
    const x = clamp(Math.min(D.sx, p.x), 0, a.w), y = clamp(Math.min(D.sy, p.y), 0, a.h);
    const w = clamp(Math.abs(p.x - D.sx), 0, a.w - x), h = clamp(Math.abs(p.y - D.sy), 0, a.h - y);
    if (w > 2 || h > 2) D.moved = true;
    Object.assign(D.preview.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    D.last = { x: rnd(x), y: rnd(y), w: rnd(w), h: rnd(h) };
  }

  /* ---------- 移动 ---------- */
  function startMove(e, boardEl, boxEl) {
    const b = findBox(findAB(boardEl.dataset.id), boxEl.dataset.id);
    const p = toLocal(boardEl, e.clientX, e.clientY);
    D.kind = 'move'; D.boardEl = boardEl; D.boxEl = boxEl; D.scale = p.s;
    D.sx = e.clientX; D.sy = e.clientY; D.orig = { x: b.x, y: b.y }; D.moved = false;
    viewport.setPointerCapture(e.pointerId);
  }
  function doMove(e) {
    const a = findAB(D.boardEl.dataset.id);
    const b = findBox(a, D.boxEl.dataset.id);
    if (!b) return;
    const dx = (e.clientX - D.sx) / D.scale;
    const dy = (e.clientY - D.sy) / D.scale;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) D.moved = true;
    let nx = clamp(rnd(D.orig.x + dx), 0, a.w - b.w);
    let ny = clamp(rnd(D.orig.y + dy), 0, a.h - b.h);

    const snap = computeSnap(a, b, nx, ny, e.altKey ? 0 : 5);
    nx = snap.x; ny = snap.y;
    showGuides(a, D.boardEl, snap.v, snap.h);

    b.x = nx; b.y = ny;
    applyBoxGeom(D.boxEl, b);
    showSizeChip(D.boardEl, b);
    refreshStatus();
  }

  /* ---------- 缩放框 ---------- */
  function startResize(e, boardEl, boxEl, dir) {
    const b = findBox(findAB(boardEl.dataset.id), boxEl.dataset.id);
    const p = toLocal(boardEl, e.clientX, e.clientY);
    D.kind = 'resize'; D.boardEl = boardEl; D.boxEl = boxEl; D.dir = dir; D.scale = p.s;
    D.sx = e.clientX; D.sy = e.clientY;
    D.orig = { x: b.x, y: b.y, w: b.w, h: b.h };
    D.moved = false;
    viewport.setPointerCapture(e.pointerId);
  }
  function doResize(e) {
    const a = findAB(D.boardEl.dataset.id);
    const b = findBox(a, D.boxEl.dataset.id);
    if (!b) return;
    const dx = (e.clientX - D.sx) / D.scale;
    const dy = (e.clientY - D.sy) / D.scale;
    let { x, y, w, h } = D.orig;
    const d = D.dir;
    if (d.includes('e')) w = D.orig.w + dx;
    if (d.includes('s')) h = D.orig.h + dy;
    if (d.includes('w')) { x = D.orig.x + dx; w = D.orig.w - dx; }
    if (d.includes('n')) { y = D.orig.y + dy; h = D.orig.h - dy; }
    if (w < MIN_W) { if (d.includes('w')) x = D.orig.x + D.orig.w - MIN_W; w = MIN_W; }
    if (h < MIN_H) { if (d.includes('n')) y = D.orig.y + D.orig.h - MIN_H; h = MIN_H; }
    x = clamp(rnd(x), 0, a.w - MIN_W);
    y = clamp(rnd(y), 0, a.h - MIN_H);
    w = clamp(rnd(w), MIN_W, a.w - x);
    h = clamp(rnd(h), MIN_H, a.h - y);
    D.moved = true;
    b.x = x; b.y = y; b.w = w; b.h = h;
    applyBoxGeom(D.boxEl, b);
    showSizeChip(D.boardEl, b);
    refreshStatus();
  }

  /* ---------- 平移 ---------- */
  function startPan(e) {
    D.kind = 'pan'; D.sx = e.clientX; D.sy = e.clientY;
    D.orig = { l: viewport.scrollLeft, t: viewport.scrollTop };
    viewport.classList.add('panning');
    viewport.setPointerCapture(e.pointerId);
  }
  function doPan(e) {
    viewport.scrollLeft = D.orig.l - (e.clientX - D.sx);
    viewport.scrollTop  = D.orig.t - (e.clientY - D.sy);
  }

  /* ---------- 结束 ---------- */
  function endDrag(e) {
    if (!D.kind) return;
    const kind = D.kind;
    clearGuides();
    removeSizeChip();
    if (D.boardEl) D.boardEl.classList.remove('drag-create');
    viewport.classList.remove('panning');
    try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}

    if (kind === 'create') {
      if (D.preview) D.preview.remove();
      const a = D.boardEl ? findAB(D.boardEl.dataset.id) : null;
      if (a && D.moved && D.last && D.last.w >= MIN_W / 2 && D.last.h >= MIN_H / 2) {
        const nb = { id: uid('b'), level: 'p', text: '', x: D.last.x, y: D.last.y, w: Math.max(D.last.w, MIN_W), h: Math.max(D.last.h, MIN_H) };
        a.boxes.push(nb);
        D.boardEl.appendChild(buildBox(nb));
        select(nb.id);
        pushHistory();
        enterEdit(nb.id);
      }
    } else if (kind === 'move' || kind === 'resize') {
      if (D.moved) pushHistory();
    }

    D.kind = null; D.boardEl = null; D.boxEl = null; D.orig = null; D.preview = null; D.last = null;
  }

  /* ---------- 对齐吸附 ---------- */
  function computeSnap(a, b, nx, ny, thr) {
    const out = { x: nx, y: ny, v: [], h: [] };
    if (!thr) return out;
    const vC = [0, a.w], hC = [0, a.h];
    a.boxes.forEach((o) => {
      if (o.id === b.id) return;
      vC.push(o.x, o.x + o.w);
      hC.push(o.y, o.y + o.h);
    });
    let bestX = null, bestY = null;
    [nx, nx + b.w].forEach((edge) => vC.forEach((c) => {
      const d = c - edge;
      if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, c };
    }));
    [ny, ny + b.h].forEach((edge) => hC.forEach((c) => {
      const d = c - edge;
      if (Math.abs(d) <= thr && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, c };
    }));
    if (bestX) { out.x = clamp(nx + bestX.d, 0, a.w - b.w); out.v.push(bestX.c); }
    if (bestY) { out.y = clamp(ny + bestY.d, 0, a.h - b.h); out.h.push(bestY.c); }
    return out;
  }

  function showGuides(a, boardEl, vs, hs) {
    const r = boardEl.getBoundingClientRect();
    const s = boardScaleOf(boardEl);
    guides.innerHTML = '';
    const cw = boardEl.offsetWidth * s;
    vs.forEach((pos) => {
      const g = el('div', 'gl v');
      g.style.left = (r.left + pos * s) + 'px';
      g.style.top = r.top + 'px';
      g.style.height = (boardEl.offsetHeight * s) + 'px';
      guides.appendChild(g);
    });
    hs.forEach((pos) => {
      const g = el('div', 'gl h');
      g.style.top = (r.top + pos * s) + 'px';
      g.style.left = r.left + 'px';
      g.style.width = (boardEl.offsetWidth * s) + 'px';
      guides.appendChild(g);
    });
    guides.hidden = guides.childElementCount === 0;
  }
  function clearGuides() { guides.innerHTML = ''; guides.hidden = true; }

  let chipEl = null;
  function showSizeChip(boardEl, b) {
    if (!chipEl) { chipEl = el('div', 'size-chip'); document.body.appendChild(chipEl); }
    const r = boardEl.getBoundingClientRect();
    const s = boardScaleOf(boardEl);
    chipEl.textContent = `${b.w} × ${b.h}`;
    chipEl.style.left = (r.left + (b.x + b.w / 2) * s) + 'px';
    chipEl.style.top  = (r.top + (b.y + b.h) * s + 10) + 'px';
  }
  function removeSizeChip() { if (chipEl) { chipEl.remove(); chipEl = null; } }

  /* ==========================================================================
     文本编辑
     ======================================================================== */
  function boxElOf(id) { return workspace.querySelector(`.box[data-id="${id}"]`); }

  function enterEdit(id) {
    const b = boxById(id);
    const d = boxElOf(id);
    if (!b || !d) return;
    select(id);
    editing = id;
    d.classList.add('editing');
    const t = d.querySelector('.txt');
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.spellcheck = false;
    t.focus();
    const rng = document.createRange();
    rng.selectNodeContents(t);
    rng.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    t._blur = onEditBlur;
    t.addEventListener('blur', onEditBlur);
  }

  function onEditBlur(e) {
    const t = e.currentTarget;
    t.removeEventListener('blur', onEditBlur);
    t._blur = null;
    setTimeout(() => {
      if (editing && document.activeElement !== t) commitEdit();
    }, 0);
  }

  function commitEdit() {
    if (!editing) return;
    const id = editing;
    const d = boxElOf(id);
    const b = boxById(id);
    editing = null;
    if (d) d.classList.remove('editing');
    if (!d || !b) return;
    const t = d.querySelector('.txt');
    if (t._blur) { t.removeEventListener('blur', t._blur); t._blur = null; }
    const next = (t.innerText || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    t.contentEditable = 'false';
    const changed = next !== (b.text || '');
    b.text = next;
    t.textContent = next;
    if (changed) pushHistory();
  }

  /* ==========================================================================
     层级
     ======================================================================== */
  function setLevel(id, lv) {
    const b = boxById(id); const d = boxElOf(id);
    if (!b || !d) return;
    b.level = lv;
    d.dataset.lv = lv;
    d.querySelector('.tag').textContent = LV_LABEL[lv];
    pushHistory();
    refreshStatus();
  }
  function cycleLevel(id, step) {
    const b = boxById(id);
    if (!b) return;
    const i = LV.indexOf(b.level || 'p');
    setLevel(id, LV[(i + (step || 1) + LV.length) % LV.length]);
  }

  /* ==========================================================================
     增删改
     ======================================================================== */
  function deleteSelected() {
    if (!selected) return;
    const ab = boardOf(selected);
    const d = boxElOf(selected);
    if (!ab) return;
    ab.boxes = ab.boxes.filter((b) => b.id !== selected);
    if (d) d.remove();
    selected = null;
    refreshLabels();
    pushHistory();
    refreshStatus();
  }
  function duplicateSelected() {
    if (!selected) return;
    const ab = boardOf(selected);
    const b = boxById(selected);
    if (!ab || !b) return;
    const nb = { ...b, id: uid('b'), x: clamp(b.x + 16, 0, ab.w - b.w), y: clamp(b.y + 16, 0, ab.h - b.h) };
    ab.boxes.push(nb);
    const d = boxElOf(selected).closest('.artboard');
    if (d) d.appendChild(buildBox(nb));
    select(nb.id);
    pushHistory();
  }
  function nudge(dx, dy) {
    if (!selected) return;
    const ab = boardOf(selected), b = boxById(selected), d = boxElOf(selected);
    if (!ab || !b) return;
    b.x = clamp(b.x + dx, 0, ab.w - b.w);
    b.y = clamp(b.y + dy, 0, ab.h - b.h);
    if (d) applyBoxGeom(d, b);
    pushHistory();
    refreshStatus();
  }
  function clearBoard(ab) {
    ab.boxes = [];
    selected = null;
    pushHistory();
    render();
  }
  function addArtboard(devKey, custom) {
    const a = custom
      ? { id: uid('a'), name: `自定义 ${custom.w}`, device: 'custom', w: custom.w, h: custom.h, boxes: [] }
      : (() => { const d = devOf(devKey); return { id: uid('a'), name: d.name, device: d.key, w: d.w, h: d.h, boxes: [] }; })();
    if (custom) a.device = 'custom';
    project.artboards.push(a);
    workspace.appendChild(buildArtboard(a));
    emptyState.hidden = true;
    pushHistory();
    refreshStatus();
    scrollToBoard(a.id);
    return a;
  }
  function scrollToBoard(id) {
    const be = workspace.querySelector(`.artboard[data-id="${id}"]`);
    if (!be) return;
    const vr = viewport.getBoundingClientRect();
    const r = be.getBoundingClientRect();
    viewport.scrollLeft += (r.left - vr.left) - 40;
  }

  /* ==========================================================================
     键盘
     ======================================================================== */
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    if (e.code === 'Space' && !typing) { spaceDown = true; viewport.style.cursor = 'grab'; }

    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 's') { e.preventDefault(); saveToFile(); return; }
      if (k === 'o') { e.preventDefault(); openFromFile(); return; }
      if (k === 'd' && !typing) { e.preventDefault(); duplicateSelected(); return; }
      if (k === '0') { e.preventDefault(); fitView(); return; }
      if (k === '=' || k === '+') { e.preventDefault(); setZoom(zoom * 1.2); return; }
      if (k === '-' || k === '_') { e.preventDefault(); setZoom(zoom / 1.2); return; }
      if (e.shiftKey && k === 'c') { e.preventDefault(); capture('current'); return; }
      if (e.shiftKey && k === 'a') { e.preventDefault(); capture('all'); return; }
      if (!typing && ['1', '2', '3', '4', '5'].includes(e.key)) {
        e.preventDefault(); setLevel(selected, LV[+e.key - 1]); return;
      }
    }

    if (typing) { if (e.key === 'Escape') { e.preventDefault(); commitEdit(); } return; }

    if (e.key === 'Escape') { if (editing) commitEdit(); else select(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (!selected) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); nudge(-step, 0); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); nudge(0, -step); }
    if (e.key === 'ArrowDown')  { e.preventDefault(); nudge(0, step); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; viewport.style.cursor = ''; }
  });
  window.addEventListener('blur', () => { spaceDown = false; viewport.style.cursor = ''; });

  /* 滚轮：Ctrl 缩放，其余交给原生滚动 */
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.0016), { x: e.clientX, y: e.clientY });
    }
  }, { passive: false });

  /* ==========================================================================
     菜单
     ======================================================================== */
  let floatMenu = null;
  function closeMenus() {
    $('#deviceMenu').hidden = true;
    $('#shotMenu').hidden = true;
    if (floatMenu) { floatMenu.remove(); floatMenu = null; }
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.menu-wrap') || e.target.closest('.menu')) return;
    if (floatMenu && floatMenu.contains(e.target)) return;
    closeMenus();
  }, true);

  function openFloatMenu(x, y, items) {
    closeMenus();
    const m = el('div', 'menu');
    m.style.position = 'fixed';
    m.style.left = '0px'; m.style.top = '0px';
    items.forEach((it) => {
      if (it.sep) { m.appendChild(el('div', 'm-sep')); return; }
      if (it.head) { m.appendChild(el('div', 'm-head', it.head)); return; }
      const b = el('button', it.danger ? 'danger' : '', it.label);
      b.addEventListener('click', () => { closeMenus(); it.run(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    m.style.top  = clamp(y, 8, innerHeight - r.height - 8) + 'px';
    floatMenu = m;
  }

  /* ---------- 新建画板菜单 ---------- */
  function buildDeviceMenu() {
    const m = $('#deviceMenu');
    m.innerHTML = '';
    m.appendChild(el('div', 'm-head', '按设备尺寸新建画板'));
    DEVICES.forEach((d) => {
      const b = el('button');
      b.append(el('span', 'dev-ico', '▭'), el('span', '', d.name), el('span', 'dev-meta', `${d.w}×${d.h}`));
      b.addEventListener('click', () => { closeMenus(); addArtboard(d.key); });
      m.appendChild(b);
    });
    m.appendChild(el('div', 'm-sep'));
    const c = el('button');
    c.append(el('span', 'dev-ico', '✎'), el('span', '', '自定义尺寸…'));
    c.addEventListener('click', () => {
      closeMenus();
      const s = prompt('输入宽 × 高（像素），例如 1024x600', '1024x600');
      if (!s) return;
      const m2 = s.match(/(\d+)\s*[x×,\s]\s*(\d+)/i);
      if (!m2) { toast('格式不对，请用 1024x600', true); return; }
      addArtboard(null, { w: clamp(+m2[1], 120, 4000), h: clamp(+m2[2], 120, 4000) });
    });
    m.appendChild(c);
  }

  /* ---------- 画板设置菜单 ---------- */
  function openBoardMenu(ab, x, y) {
    const dev = devOf(ab.device);
    const items = [
      { head: `${ab.name} · ${ab.w}×${ab.h}` },
      { label: '重命名画板…', run: () => { const n = prompt('画板名称', ab.name); if (n && n.trim()) { ab.name = n.trim(); pushHistory(); render(); } } },
      { label: '切换设备尺寸…', run: () => openDeviceSwap(ab, x, y) },
      { label: '复制画板', run: () => {
          const c = JSON.parse(JSON.stringify(ab));
          c.id = uid('a'); c.name = ab.name + ' 副本';
          c.boxes.forEach((b) => { b.id = uid('b'); });
          project.artboards.push(c); render(); pushHistory();
        } },
      { label: '清空所有框', run: () => clearBoard(ab) },
      { sep: true },
      { label: '删除画板', danger: true, run: () => {
          project.artboards = project.artboards.filter((a) => a.id !== ab.id);
          selected = null; render(); pushHistory();
        } },
    ];
    openFloatMenu(x, y, items);
  }
  function openDeviceSwap(ab, x, y) {
    const items = [{ head: '选择设备尺寸' }].concat(DEVICES.map((d) => ({
      label: `${d.name}   ${d.w}×${d.h}`,
      run: () => { ab.device = d.key; ab.w = d.w; ab.h = d.h; ab.boxes = []; selected = null; render(); pushHistory(); toast('已切换尺寸，原有框已清空'); },
    })));
    openFloatMenu(x, y, items);
  }

  /* ==========================================================================
     截图
     ======================================================================== */
  function jobFor(ab, stripH) {
    return {
      project: JSON.parse(JSON.stringify(project)),
      artboardId: ab.id,
      width: ab.w,
      height: ab.h,
      bg: '#ffffff',
      stripH: stripH || 0,
      stripText: `${ab.name} · ${devOf(ab.device).name} · ${ab.w} × ${ab.h}`,
      showLegend: $('#chkLegend').checked,
      label: `${ab.name} · ${devOf(ab.device).name} · ${ab.w}×${ab.h}`,
    };
  }

  async function capture(which) {
    if (editing) commitEdit();
    if (!project.artboards.length) { toast('还没有画板', true); return; }
    const withDim = $('#chkDim').checked;

    let jobs, single = false;
    if (which === 'current') {
      const ab = currentBoard();
      if (!ab) { toast('还没有画板', true); return; }
      jobs = [jobFor(ab, withDim ? STRIP_H : 0)];
      single = true;
    } else {
      jobs = project.artboards.map((a) => jobFor(a, 0));
    }

    toast('正在渲染画板…');
    let shots;
    try {
      shots = await api.captureArtboards(jobs);
    } catch (err) {
      toast('截图失败：' + (err && err.message ? err.message : err), true);
      return;
    }
    if (!shots || !shots.length) { toast('截图失败', true); return; }

    const dataUrl = shots.length === 1 ? shots[0].dataUrl : await compose(shots);
    const res = await api.copyImage(dataUrl);
    if (res && res.ok) {
      toast(`已复制到剪贴板 · ${shots.length === 1 ? `${shots[0].width}×${shots[0].height}` : shots.length + ' 个画板拼接'} · 直接 Ctrl+V 粘贴给大模型`);
    } else {
      toast('复制失败：' + ((res && res.error) || '未知错误'), true);
    }
  }

  async function captureSave(which) {
    if (editing) commitEdit();
    const withDim = $('#chkDim').checked;
    const jobs = which === 'current'
      ? [jobFor(currentBoard(), withDim ? STRIP_H : 0)]
      : project.artboards.map((a) => jobFor(a, 0));
    toast('正在渲染画板…');
    let shots;
    try { shots = await api.captureArtboards(jobs); }
    catch (err) { toast('截图失败：' + err.message, true); return; }
    const dataUrl = shots.length === 1 ? shots[0].dataUrl : await compose(shots);
    const nm = which === 'current' ? (currentBoard() ? currentBoard().name : 'wireframe') : project.name;
    const r = await api.savePng(dataUrl, `${nm}.png`);
    if (r && r.ok) toast('已保存：' + r.filePath);
  }

  function loadImg(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
  }

  async function compose(shots) {
    const gap = 40, pad = 32, headH = 34;
    const rawW = shots.reduce((s, x) => s + x.width, 0) + gap * (shots.length - 1) + pad * 2;
    const maxH = Math.max(...shots.map((s) => s.height));
    const rawH = pad * 2 + headH + maxH;
    const k = rawW > 7200 ? 7200 / rawW : 1;

    const cv = document.createElement('canvas');
    cv.width = Math.ceil(rawW * k);
    cv.height = Math.ceil(rawH * k);
    const ctx = cv.getContext('2d');
    ctx.scale(k, k);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rawW, rawH);
    ctx.textBaseline = 'alphabetic';

    let x = pad;
    for (const s of shots) {
      ctx.fillStyle = '#111827';
      ctx.font = '600 15px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(s.label, x, pad + 16);
      const img = await loadImg(s.dataUrl);
      ctx.drawImage(img, x, pad + headH, s.width, s.height);
      ctx.strokeStyle = 'rgba(30,36,47,.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, pad + headH + 0.5, s.width - 1, s.height - 1);
      x += s.width + gap;
    }
    return cv.toDataURL('image/png');
  }

  /* ==========================================================================
     工程文件
     ======================================================================== */
  async function saveToFile() {
    if (editing) commitEdit();
    const r = await api.saveProject(JSON.stringify(project, null, 2), `${project.name}.wire.json`);
    if (r && r.ok) {
      if (r.name) project.name = r.name;
      $('#projName').value = project.name;
      markClean();
      try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (_) {}
      toast('已保存：' + r.filePath);
    }
  }
  async function openFromFile() {
    const r = await api.openProject();
    if (!r || !r.ok) return;
    try {
      const p = JSON.parse(r.json);
      if (!p || !Array.isArray(p.artboards)) throw new Error('文件格式不对');
      project = p;
      if (r.name) project.name = r.name;
      selected = null; editing = null;
      history = []; hIdx = -1;
      render(); pushHistory(); markClean();
      fitView();
      toast('已打开：' + r.filePath);
    } catch (err) { toast('打开失败：' + err.message, true); }
  }

  /* ==========================================================================
     工具栏绑定
     ======================================================================== */
  function bindToolbar() {
    $('#btnAdd').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#deviceMenu'); const was = m.hidden; closeMenus(); m.hidden = !was; });
    $('#btnAddEmpty').addEventListener('click', () => { const m = $('#deviceMenu'); closeMenus(); m.hidden = false; });
    buildDeviceMenu();

    $('#btnZoomIn').addEventListener('click', () => setZoom(zoom * 1.2));
    $('#btnZoomOut').addEventListener('click', () => setZoom(zoom / 1.2));
    $('#btnZoomVal').addEventListener('click', () => setZoom(1));
    $('#btnFit').addEventListener('click', fitView);

    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);

    $('#btnSave').addEventListener('click', saveToFile);
    $('#btnOpen').addEventListener('click', openFromFile);

    $('#btnShot').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.ic.sm')) { const m = $('#shotMenu'); const was = m.hidden; closeMenus(); m.hidden = !was; return; }
      closeMenus(); capture('current');
    });
    $('#shotMenu').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      closeMenus();
      const a = b.dataset.act;
      if (a === 'copy-current') capture('current');
      if (a === 'copy-all') capture('all');
      if (a === 'save-current') captureSave('current');
      if (a === 'save-all') captureSave('all');
    });

    const pn = $('#projName');
    pn.addEventListener('change', () => { const v = pn.value.trim() || '未命名工程'; project.name = v; pn.value = v; scheduleSave(); });
    pn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { pn.blur(); } if (e.key === 'Escape') { pn.value = project.name; pn.blur(); } });

    /* 画板头部点击 */
    workspace.addEventListener('click', (e) => {
      const head = e.target.closest('.ab-head');
      if (!head) return;
      const ab = findAB(head.dataset.id);
      if (ab) openBoardMenu(ab, e.clientX, e.clientY + 8);
    });

    /* 框体右键 */
    viewport.addEventListener('contextmenu', (e) => {
      const boxEl = e.target.closest('.box');
      if (!boxEl) return;
      e.preventDefault();
      if (editing && editing !== boxEl.dataset.id) commitEdit();
      select(boxEl.dataset.id);
      const b = boxById(boxEl.dataset.id);
      openFloatMenu(e.clientX, e.clientY, [
        { head: `${labelOf(b.id)} · 层级：${LV_NAME[b.level]}` },
        ...LV.map((lv) => ({ label: `${LV_LABEL[lv]} · ${LV_NAME[lv]}`, run: () => setLevel(b.id, lv) })),
        { sep: true },
        { label: '编辑文字', run: () => enterEdit(b.id) },
        { label: '复制框 (Ctrl+D)', run: duplicateSelected },
        { sep: true },
        { label: '删除框 (Delete)', danger: true, run: deleteSelected },
      ]);
    });
  }

  /* ==========================================================================
     启动
     ======================================================================== */
  function boot() {
    project = loadSaved() || newProject();
    bindToolbar();
    render();
    history = []; hIdx = -1;
    pushHistory();
    markClean();
    requestAnimationFrame(fitView);
  }

  /* ==========================================================================
     导出模式
     ======================================================================== */
  async function runExport() {
    const spec = await api.getExportPayload();
    const a = spec.project.artboards.find((x) => x.id === spec.artboardId);
    const strip = spec.stripH || 0;

    const root = document.createElement('div');
    root.id = 'export-root';
    root.style.width = a.w + 'px';
    document.body.appendChild(root);

    /* 顶部规格条 */
    if (strip) {
      const s = document.createElement('div');
      s.textContent = spec.stripText || '';
      s.style.cssText = `width:${a.w}px;height:${strip}px;box-sizing:border-box;` +
        'display:flex;align-items:center;padding:0 12px;' +
        'font:600 13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#20262f;' +
        'background:#fff;border-bottom:1px solid rgba(30,36,47,.14);';
      root.appendChild(s);
    }

    /* 画板本体（1:1 设备像素） */
    const board = document.createElement('div');
    board.className = 'exp-board';
    board.style.width = a.w + 'px';
    board.style.height = a.h + 'px';
    a.boxes.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'box';
      d.dataset.lv = b.level || 'p';
      d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;`;
      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = b.text || '';
      const tg = document.createElement('div');
      tg.className = 'tag';
      tg.textContent = LV_LABEL[b.level] || 'p';
      const oid = document.createElement('div');
      oid.className = 'oid';
      oid.textContent = ID_PREFIX + (i + 1);
      d.append(t, tg, oid);
      board.appendChild(d);
    });
    root.appendChild(board);

    /* 文字清单（可选，给大模型提供零 OCR 误差的原文 + 框编号） */
    if (spec.showLegend) {
      const items = a.boxes.map((b, i) => [b, i]).filter(([b]) => (b.text || '').trim());
      if (items.length) {
        const L = document.createElement('div');
        L.style.cssText = `width:${a.w}px;box-sizing:border-box;padding:12px 2px 4px;` +
          'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#20262f;';
        L.innerHTML =
          '<div style="font-weight:700;font-size:12px;margin:0 0 5px">区域清单</div>' +
          items.map(([b, i]) =>
            '<div style="display:flex;gap:8px;border-top:1px solid rgba(30,36,47,.09);padding:3px 0">' +
            `<span style="font-family:ui-monospace,Consolas,monospace;font-size:10px;font-weight:700;color:#2f6ef3;flex:0 0 24px;padding-top:2px">${ID_PREFIX}${i + 1}</span>` +
            `<span style="font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#7b8595;flex:0 0 26px;padding-top:2px">${LV_LABEL[b.level] || 'p'}</span>` +
            `<span style="white-space:pre-wrap;flex:1">${escapeHtml(b.text)}</span></div>`
          ).join('');
        root.appendChild(L);
      }
    }

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const needH = Math.ceil(root.getBoundingClientRect().height);
    api.reportLayout(a.w, needH);
    await new Promise((r) => setTimeout(r, 180));
    api.exportReady();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (!api || api.mode !== 'export') boot();
})();
