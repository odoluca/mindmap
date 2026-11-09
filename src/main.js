// The editor: view, interaction, panels, persistence and export. Every edit goes through applyOps().
import { APP_VERSION } from './version.js?v=0.2.0';
import * as M from './model.js?v=0.2.0';
import { computeSizes, computeLayout, visibleNodes, bounds } from './layout.js?v=0.2.0';
import { createMeasure, renderNodes, renderEdges, buildSvg, routeEdge, PALETTE } from './render.js?v=0.2.0';
import { store, download, pickFile, prefs, channel } from './storage.js?v=0.2.0';
import { installApi } from './api.js?v=0.2.0';
import { sampleMap } from './sample.js?v=0.2.0';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); };

class Editor {
  constructor() {
    this.map = null;
    this.measure = createMeasure();
    this.sizes = new Map(); this.pos = new Map(); this.visible = new Set(); this.counts = new Map();
    this.selected = new Set(); this.selectedEdge = null; this.editing = null;
    this.matches = null;
    this.undoStack = []; this.redoStack = [];
    this.me = prefs.get('author', 'user');
    this.listeners = new Map();
    this.hoverLink = null;
    this.saveTimer = null;
    this.bc = channel((msg) => this.onRemoteChange(msg));
  }

  // ---------- lifecycle ----------
  async init() {
    this.els = { canvas: $('canvas'), viewport: $('viewport'), nodes: $('nodes'), edges: $('edges') };
    this.bindUI();
    installApi(this);
    const handled = await this.api.handleHash();
    if (!handled && !this.map) await this.openDefault();
    await this.refreshMapList();
    document.fonts?.ready.then(() => { this.measure = createMeasure(); this.relayout(); this.render(); });
    window.addEventListener('hashchange', () => this.api.handleHash());
    this.checkVersion();
  }

  async checkVersion() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { version } = await res.json();
      if (version && version !== APP_VERSION) {
        const t = $('toast'); t.innerHTML = `A newer version (${esc(version)}) is available. <button class="link" id="reloadBtn">Reload</button>`; t.hidden = false;
        $('reloadBtn').onclick = () => location.reload(true);
      }
    } catch { /* offline */ }
  }

  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); return () => this.listeners.get(event).delete(fn); }
  emit(event, data) { for (const fn of this.listeners.get(event) || []) { try { fn(data); } catch (e) { console.error(e); } } }

  // ---------- maps ----------
  async openDefault() {
    const last = prefs.get('lastMap', null);
    const list = await store.list();
    if (last && list.some((m) => m.id === last)) await this.openMap(last);
    else if (list.length) await this.openMap(list[0].id);
    else { const m = sampleMap(); await store.put(m); await this.openMap(m.id); }
  }
  async openMap(id) {
    const raw = await store.get(id);
    if (!raw) throw new Error(`No map with id ${id}`);
    this.loadMap(M.normalize(raw));
    return this.map;
  }
  loadMap(map) {
    this.finishEdit(false);
    this.map = map;
    this.undoStack = []; this.redoStack = [];
    this.selected = new Set(); this.selectedEdge = null; this.matches = null;
    $('search').value = '';
    prefs.set('lastMap', map.id);
    $('mapName').value = map.name;
    $('layoutSelect').value = map.settings.layout;
    this.relayout(); this.render();
    this.applyView(map.view);
    if (!map.view || (map.view.x === 0 && map.view.y === 0 && map.view.scale === 1)) this.fit();
    this.renderPanel(); this.refreshMapList();
    this.emit('open', { id: map.id });
    this.updateUndoButtons();
  }
  async createMap(opts = {}) {
    const map = M.newMap({ author: this.me, ...opts });
    await store.put(map);
    this.loadMap(map);
    return map;
  }
  async importMap(json, { open = true } = {}) {
    const map = M.normalize(typeof json === 'string' ? JSON.parse(json) : json);
    const existing = await store.get(map.id);
    if (existing) map.id = M.uid('m');
    await store.put(map);
    if (open) this.loadMap(map); else this.refreshMapList();
    return map;
  }
  async deleteMap(id) {
    await store.remove(id);
    if (this.map?.id === id) {
      const list = await store.list();
      if (list.length) await this.openMap(list[0].id); else await this.createMap({ name: 'Untitled map' });
    }
    await this.refreshMapList();
  }
  async refreshMapList() {
    const list = await store.list();
    const el = $('mapList');
    el.innerHTML = list.map((m) => `<button class="map-item${m.id === this.map?.id ? ' active' : ''}" data-id="${esc(m.id)}"><b>${esc(m.name)}</b><small>${m.kind === 'flowchart' ? 'Flowchart' : 'Mind map'} · ${m.nodes} node${m.nodes === 1 ? '' : 's'} · ${fmtTime(m.updatedAt)}</small></button>`).join('') || '<p class="info">No maps yet.</p>';
    for (const b of el.querySelectorAll('.map-item')) b.onclick = () => this.openMap(b.dataset.id);
    return list;
  }
  scheduleSave() {
    clearTimeout(this.saveTimer);
    $('saveStatus').textContent = 'Saving…';
    this.saveTimer = setTimeout(() => this.save(), 300);
  }
  async save() {
    if (!this.map) return;
    try { await store.put(M.clone(this.map)); $('saveStatus').textContent = 'Saved'; this.bc.post({ type: 'change', id: this.map.id }); this.refreshMapList(); }
    catch (e) { $('saveStatus').textContent = 'Save failed'; console.error(e); }
  }
  async onRemoteChange(msg) {
    if (msg?.type !== 'change') return;
    if (msg.id === this.map?.id && !this.editing) {
      const raw = await store.get(msg.id);
      if (raw && raw.updatedAt !== this.map.updatedAt) { const sel = this.selected; this.map = M.normalize(raw); this.selected = new Set([...sel].filter((id) => M.nodeById(this.map, id))); this.relayout(); this.render(); this.renderPanel(); this.emit('change', { id: this.map.id, remote: true }); }
    }
    this.refreshMapList();
  }

  // ---------- mutation ----------
  /** Apply operations with undo support. Returns the applyOps result. */
  apply(ops, { author = this.me, silent = false, undoable = true, fromPanel = false } = {}) {
    if (!this.map) return { ok: false, error: 'No map open' };
    const snapshot = M.clone(this.map);
    const r = M.applyOps(this.map, ops, { author, silent });
    if (!r.ok) return r;
    if (undoable) { this.undoStack.push(snapshot); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack.length = 0; this.updateUndoButtons(); }
    const relayout = r.results.find((x) => x?.relayout)?.relayout;
    if (relayout && this.map.settings.layout === 'free') this.applyLayoutOnce(relayout);
    if (this.map.settings.layout === 'free') { const list = Array.isArray(ops) ? ops : [ops]; list.forEach((op, i) => { if (op.op === 'addTree' && r.results[i]?.ids?.length > 1) this.placeSubtree(r.results[i].ids); }); }
    $('layoutSelect').value = this.map.settings.layout;
    $('mapName').value = this.map.name;
    this.selected = new Set([...this.selected].filter((id) => M.nodeById(this.map, id)));
    if (this.selectedEdge && !this.map.edges.some((e) => e.id === this.selectedEdge)) this.selectedEdge = null;
    this.relayout(); this.render();
    if (!fromPanel) this.renderPanel();
    this.scheduleSave();
    this.emit('change', { id: this.map.id, ops: Array.isArray(ops) ? ops : [ops], author, results: r.results });
    return r;
  }
  /** Snap a coordinate to the map's grid (identity when the grid is off). */
  snap(v) { const g = this.map?.settings.grid || 0; return g ? Math.round(v / g) * g : Math.round(v); }
  toggleGrid() { const g = this.map.settings.grid ? 0 : (prefs.get('grid', 20) || 20); if (g) prefs.set('grid', g); this.apply([{ op: 'setMap', settings: { grid: g } }], { silent: true }); this.toast(g ? `Snap to grid: ${g}px` : 'Snap to grid off'); }
  /** In free layout, arrange freshly added nodes as a tidy tree next to their parent (or below everything else). */
  placeSubtree(ids) {
    const set = new Set(ids);
    const top = ids.filter((id) => !set.has(M.nodeById(this.map, id)?.parent));
    if (!top.length) return;
    const parent = M.nodeById(this.map, M.nodeById(this.map, top[0]).parent);
    const sub = { ...this.map, nodes: this.map.nodes.filter((n) => set.has(n.id)).map((n) => (set.has(n.parent) ? n : { ...n, parent: null })), edges: [] };
    const sizes = computeSizes(this.map, this.measure);
    const pos = computeLayout(sub, this.map.kind === 'flowchart' ? 'down' : 'right', sizes);
    const b = bounds(pos, sizes);
    let ox, oy;
    if (parent) { const ps = sizes.get(parent.id); ox = parent.x + ps.w + 64 - b.x; oy = parent.y - b.y; }
    else { const rest = new Map([...this.map.nodes].filter((n) => !set.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }])); const rb = bounds(rest, sizes); ox = (rest.size ? rb.x : 0) - b.x; oy = (rest.size ? rb.y + rb.h + 60 : 0) - b.y; }
    for (const [id, p] of pos) { const n = M.nodeById(this.map, id); n.x = this.snap(p.x + ox); n.y = this.snap(p.y + oy); }
  }
  applyLayoutOnce(mode) {
    this.sizes = computeSizes(this.map, this.measure);
    const pos = computeLayout(this.map, mode, this.sizes);
    for (const [id, p] of pos) { const n = M.nodeById(this.map, id); if (n) { n.x = this.snap(p.x); n.y = this.snap(p.y); } }
  }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.finishEdit(false); this.redoStack.push(M.clone(this.map)); this.restore(s); this.toast('Undo'); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.finishEdit(false); this.undoStack.push(M.clone(this.map)); this.restore(s); this.toast('Redo'); }
  restore(snapshot) {
    const view = this.map.view;
    this.map = snapshot; this.map.view = view;
    this.selected = new Set([...this.selected].filter((id) => M.nodeById(this.map, id)));
    $('layoutSelect').value = this.map.settings.layout; $('mapName').value = this.map.name;
    this.relayout(); this.render(); this.renderPanel(); this.scheduleSave(); this.updateUndoButtons();
    this.emit('change', { id: this.map.id, undo: true });
  }
  updateUndoButtons() { $('btnUndo').disabled = !this.undoStack.length; $('btnRedo').disabled = !this.redoStack.length; }

  // ---------- layout & render ----------
  relayout() {
    const map = this.map;
    this.sizes = computeSizes(map, this.measure);
    const vis = visibleNodes(map);
    this.visible = new Set(vis.map((n) => n.id));
    this.pos = computeLayout(map, map.settings.layout, this.sizes);
    if (map.settings.layout !== 'free') for (const [id, p] of this.pos) { const n = M.nodeById(map, id); if (n) { n.x = Math.round(p.x); n.y = Math.round(p.y); } }
    this.counts = new Map();
    for (const n of map.nodes) if (M.childrenOf(map, n.id).length) this.counts.set(n.id, M.subtreeIds(map, n.id).length - 1);
  }
  render() {
    const view = { nodesEl: this.els.nodes, edgesEl: this.els.edges, map: this.map, pos: this.pos, sizes: this.sizes, visible: this.visible, selected: this.selected, selectedEdge: this.selectedEdge, editing: this.editing, matches: this.matches, me: this.me, showAuthors: this.map.settings.showAuthors !== false, counts: this.counts, hoverLink: this.hoverLink };
    renderNodes(view); renderEdges(view);
    this.applyView(this.map.view);
    $('statusInfo').textContent = `${this.map.nodes.length} nodes · ${this.map.edges.length} links · ${this.map.notes.length} notes`;
  }
  applyView(v) {
    const { x, y, scale } = v;
    this.els.viewport.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    const g = this.map?.settings.grid || 0;
    const cs = this.els.canvas.style;
    if (g) { const s = g * scale; cs.backgroundSize = `${s}px ${s}px`; cs.backgroundPosition = `${x}px ${y}px`; this.els.canvas.classList.toggle('grid-fine', s < 12); }
    else { cs.backgroundSize = ''; cs.backgroundPosition = ''; this.els.canvas.classList.remove('grid-fine'); }
    $('zoomLabel').textContent = Math.round(scale * 100) + '%';
  }
  setView(x, y, scale, persist = true) {
    scale = Math.min(4, Math.max(0.1, scale));
    this.map.view = { x, y, scale };
    this.applyView(this.map.view);
    if (persist) { clearTimeout(this.viewTimer); this.viewTimer = setTimeout(() => this.save(), 800); }
  }
  fit() {
    const b = bounds(this.pos, this.sizes);
    const rect = this.els.canvas.getBoundingClientRect();
    if (!b.w || !b.h) return this.setView(rect.width / 2, rect.height / 2, 1);
    const scale = Math.min(1.5, Math.max(0.1, Math.min((rect.width - 80) / b.w, (rect.height - 80) / b.h)));
    this.setView(rect.width / 2 - (b.x + b.w / 2) * scale, rect.height / 2 - (b.y + b.h / 2) * scale, scale);
  }
  zoomAt(factor, cx, cy) {
    const v = this.map.view;
    const s = Math.min(4, Math.max(0.1, v.scale * factor));
    const k = s / v.scale;
    this.setView(cx - (cx - v.x) * k, cy - (cy - v.y) * k, s);
  }
  centerOn(id) {
    const p = this.pos.get(id), s = this.sizes.get(id);
    if (!p) return;
    const rect = this.els.canvas.getBoundingClientRect(), v = this.map.view;
    this.setView(rect.width / 2 - (p.x + s.w / 2) * v.scale, rect.height / 2 - (p.y + s.h / 2) * v.scale, v.scale);
  }
  screenToWorld(clientX, clientY) {
    const rect = this.els.canvas.getBoundingClientRect(), v = this.map.view;
    return { x: (clientX - rect.left - v.x) / v.scale, y: (clientY - rect.top - v.y) / v.scale };
  }
  nodeAt(wx, wy, except) {
    for (let i = this.map.nodes.length - 1; i >= 0; i--) {
      const n = this.map.nodes[i];
      if (!this.visible.has(n.id) || except?.has(n.id)) continue;
      const p = this.pos.get(n.id), s = this.sizes.get(n.id);
      if (wx >= p.x && wx <= p.x + s.w && wy >= p.y && wy <= p.y + s.h) return n;
    }
    return null;
  }

  // ---------- selection & editing ----------
  select(ids, { edge = null, panel = true } = {}) {
    this.selected = new Set(ids);
    this.selectedEdge = edge;
    this.render();
    if (panel) this.renderPanel();
    this.emit('select', { nodes: [...this.selected], edge });
  }
  get primary() { return this.selected.size ? M.nodeById(this.map, [...this.selected][this.selected.size - 1]) : null; }
  startEdit(id) {
    if (this.editing === id) return;
    this.finishEdit(true);
    const n = M.nodeById(this.map, id);
    if (!n) return;
    this.editing = id;
    this.select([id], { panel: false });
    const el = this.els.nodes.querySelector(`.node[data-id="${CSS.escape(id)}"] .text`);
    if (!el) { this.editing = null; return; }
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.innerText = n.text;
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  finishEdit(commit) {
    if (!this.editing) return;
    const id = this.editing;
    const el = this.els.nodes.querySelector(`.node[data-id="${CSS.escape(id)}"] .text`);
    this.editing = null;
    const text = el ? el.innerText.replace(/\n+$/, '') : null;
    if (el) el.contentEditable = 'false';
    const n = M.nodeById(this.map, id);
    if (commit && n && text != null && text !== n.text) this.apply([{ op: 'updateNode', id, text }]);
    else this.render();
  }
  addChild(parentId, text = 'New node') {
    const r = this.apply([{ op: 'addNode', parent: parentId ?? null, text }]);
    if (r.ok) { const id = r.results[0].id; this.select([id]); this.centerIfOffscreen(id); this.startEdit(id); }
  }
  addSibling(id) {
    const n = M.nodeById(this.map, id);
    if (!n) return;
    if (n.parent == null) return this.addChild(n.id);
    const siblings = M.childrenOf(this.map, n.parent);
    const r = this.apply([{ op: 'addNode', parent: n.parent, text: 'New node', index: siblings.indexOf(n) + 1 }]);
    if (r.ok) { const nid = r.results[0].id; this.select([nid]); this.centerIfOffscreen(nid); this.startEdit(nid); }
  }
  centerIfOffscreen(id) {
    const p = this.pos.get(id), s = this.sizes.get(id); if (!p) return;
    const rect = this.els.canvas.getBoundingClientRect(), v = this.map.view;
    const sx = p.x * v.scale + v.x, sy = p.y * v.scale + v.y;
    if (sx < 0 || sy < 0 || sx + s.w * v.scale > rect.width || sy + s.h * v.scale > rect.height) this.centerOn(id);
  }
  deleteSelection() {
    if (this.selectedEdge) { const id = this.selectedEdge; this.selectedEdge = null; return this.apply([{ op: 'deleteEdge', id }]); }
    if (!this.selected.size) return;
    const ids = [...this.selected].filter((id) => !M.nodeById(this.map, id) || ![...this.selected].some((o) => o !== id && M.isDescendant(this.map, id, o)));
    const n = M.nodeById(this.map, ids[0]);
    const next = n?.parent ?? null;
    this.apply(ids.map((id) => ({ op: 'deleteNode', id })));
    this.select(next ? [next] : []);
  }
  navigate(dir) {
    const n = this.primary; if (!n) { const r = M.rootsOf(this.map)[0]; if (r) this.select([r.id]); return; }
    const p = this.pos.get(n.id), s = this.sizes.get(n.id);
    const cx = p.x + s.w / 2, cy = p.y + s.h / 2;
    let best = null, bestScore = Infinity;
    for (const o of this.map.nodes) {
      if (o.id === n.id || !this.visible.has(o.id)) continue;
      const q = this.pos.get(o.id), t = this.sizes.get(o.id);
      const dx = q.x + t.w / 2 - cx, dy = q.y + t.h / 2 - cy;
      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 4) continue;
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) { this.select([best.id]); this.centerIfOffscreen(best.id); }
  }

  // ---------- UI wiring ----------
  bindUI() {
    const { canvas } = this.els;
    $('mapName').onchange = (e) => this.apply([{ op: 'setMap', name: e.target.value.trim() || this.map.name }], { silent: true });
    $('layoutSelect').onchange = (e) => this.apply([{ op: 'layout', mode: e.target.value }]);
    $('btnUndo').onclick = () => this.undo();
    $('btnRedo').onclick = () => this.redo();
    $('btnMaps').onclick = () => { $('sidebar').classList.toggle('open'); };
    $('btnPanel').onclick = () => { $('panel').classList.toggle('open'); };
    $('zoomIn').onclick = () => { const r = canvas.getBoundingClientRect(); this.zoomAt(1.2, r.width / 2, r.height / 2); };
    $('zoomOut').onclick = () => { const r = canvas.getBoundingClientRect(); this.zoomAt(1 / 1.2, r.width / 2, r.height / 2); };
    $('zoomFit').onclick = () => this.fit();
    $('btnHelp').onclick = () => $('help').showModal();
    $('helpClose').onclick = () => $('help').close();
    this.bindMenu('btnNew', 'newMenu', {
      btnNewMind: () => this.createMap({ kind: 'mindmap', name: 'New mind map' }),
      btnNewFlow: () => this.createMap({ kind: 'flowchart', name: 'New flowchart' }),
      btnExample: async () => { const m = sampleMap(); await store.put(m); this.loadMap(m); },
      btnOpen: () => this.openFile(),
      btnImportMd: () => { $('panel').classList.add('open'); this.showTab('api'); $('pasteBox').focus(); },
    });
    this.bindMenu('btnExport', 'exportMenu', {
      btnJson: () => this.exportJson(), btnSvg: () => this.exportSvg(), btnPng: () => this.exportPng(), btnMd: () => this.exportMd(),
      btnCopyJson: () => this.copy(JSON.stringify(this.map, null, 2), 'Map JSON copied'),
      btnCopyMd: () => this.copy(M.toMarkdown(this.map), 'Outline copied'),
    });
    for (const t of document.querySelectorAll('.panel-tabs .tab')) t.onclick = () => this.showTab(t.dataset.tab);
    const search = $('search');
    search.oninput = () => { const q = search.value.trim(); this.matches = q ? new Set(M.findNodes(this.map, q).map((n) => n.id)) : null; this.render(); };
    search.onkeydown = (e) => {
      if (e.key === 'Enter' && this.matches?.size) { const ids = [...this.matches]; this.searchIdx = ((this.searchIdx ?? -1) + 1) % ids.length; this.select([ids[this.searchIdx]]); this.centerOn(ids[this.searchIdx]); }
      if (e.key === 'Escape') { search.value = ''; this.matches = null; this.render(); canvas.focus(); }
    };
    this.bindCanvas();
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('paste', (e) => this.onPaste(e));
    window.addEventListener('resize', () => this.render());
  }
  bindMenu(btnId, menuId, actions) {
    const btn = $(btnId), menu = $(menuId);
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
    for (const [id, fn] of Object.entries(actions)) $(id).onclick = async () => { close(); try { await fn(); } catch (err) { console.error(err); this.toast(err.message); } };
  }
  showTab(name) {
    for (const t of document.querySelectorAll('.panel-tabs .tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const s of document.querySelectorAll('.tab-body')) s.hidden = s.id !== 'tab-' + name;
    this.tab = name;
    this.renderPanel();
  }
  toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(this._toastT); this._toastT = setTimeout(() => (t.hidden = true), ms); }
  async copy(text, msg) { try { await navigator.clipboard.writeText(text); this.toast(msg || 'Copied'); } catch { this.toast('Clipboard unavailable'); } }

  bindCanvas() {
    const { canvas, nodes } = this.els;
    let drag = null;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX) && !e.deltaX && e.deltaMode === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50) {
        this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      } else {
        const v = this.map.view; this.setView(v.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), v.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY), v.scale);
      }
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && (e.target === canvas || e.target === this.els.viewport || e.target.closest('#edges') && !e.target.closest('.edge')))) {
        if (this.editing) this.finishEdit(true);
        drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.map.view.x, vy: this.map.view.y, moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const edge = e.target.closest('.edge');
      if (edge && e.button === 0) {
        const id = edge.dataset.id;
        if (this.editing) this.finishEdit(true);
        if (id.startsWith('tree:')) this.select([id.slice(5)]); else this.select([], { edge: id });
        return;
      }
      const port = e.target.closest('.port');
      const nodeEl = e.target.closest('.node');
      if (port && nodeEl) {
        const from = nodeEl.dataset.id; const p = this.pos.get(from), s = this.sizes.get(from);
        drag = { kind: 'link', from, start: { x: p.x + s.w / 2, y: p.y + s.h / 2 } };
        canvas.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
      if (e.target.closest('.toggle') && nodeEl) {
        const n = M.nodeById(this.map, nodeEl.dataset.id);
        this.apply([{ op: 'updateNode', id: n.id, collapsed: !n.collapsed }], { silent: true });
        return;
      }
      if (nodeEl && e.button === 0) {
        const id = nodeEl.dataset.id;
        if (this.editing === id) return; // typing inside
        if (this.editing) this.finishEdit(true);
        if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(this.selected); s.has(id) ? s.delete(id) : s.add(id); this.select([...s]); }
        else if (!this.selected.has(id)) this.select([id]);
        const w = this.screenToWorld(e.clientX, e.clientY);
        const ids = [...this.selected];
        const moving = new Set();
        for (const sid of ids) { if (this.map.settings.layout === 'free') for (const d of M.subtreeIds(this.map, sid)) moving.add(d); else moving.add(sid); }
        drag = { kind: 'node', id, sx: w.x, sy: w.y, moved: false, moving, origin: new Map([...moving].map((m) => [m, { ...this.pos.get(m) }])) };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        this.setView(drag.vx + dx, drag.vy + dy, this.map.view.scale, false);
      } else if (drag.kind === 'link') {
        const w = this.screenToWorld(e.clientX, e.clientY);
        const over = this.nodeAt(w.x, w.y);
        this.hoverLink = `M${drag.start.x} ${drag.start.y}L${w.x} ${w.y}`;
        drag.over = over?.id !== drag.from ? over : null;
        this.render();
        for (const el of nodes.children) el.classList.toggle('drop', el.dataset.id === drag.over?.id);
      } else if (drag.kind === 'node') {
        const w = this.screenToWorld(e.clientX, e.clientY);
        const dx = w.x - drag.sx, dy = w.y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 3 / this.map.view.scale) return;
        drag.moved = true;
        if (this.map.settings.layout === 'free') {
          const g = drag.origin.get(drag.id);
          const sdx = g ? this.snap(g.x + dx) - g.x : dx, sdy = g ? this.snap(g.y + dy) - g.y : dy;
          for (const [id, o] of drag.origin) { const p = this.pos.get(id); if (p) { p.x = o.x + sdx; p.y = o.y + sdy; } }
          this.render();
        } else {
          const el = nodes.querySelector(`.node[data-id="${CSS.escape(drag.id)}"]`);
          const o = drag.origin.get(drag.id);
          if (el) { el.style.left = o.x + dx + 'px'; el.style.top = o.y + dy + 'px'; el.classList.add('dragging'); }
          const over = this.nodeAt(w.x, w.y, drag.moving);
          drag.over = over && !M.isDescendant(this.map, over.id, drag.id) ? over : null;
          for (const n of nodes.children) n.classList.toggle('drop', n.dataset.id === drag.over?.id);
        }
      }
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      for (const n of nodes.children) n.classList.remove('drop', 'dragging');
      if (d.kind === 'pan') {
        if (!d.moved) this.select([]);
        else this.setView(this.map.view.x, this.map.view.y, this.map.view.scale);
      } else if (d.kind === 'link') {
        this.hoverLink = null;
        if (d.over) { const r = this.apply([{ op: 'addEdge', from: d.from, to: d.over.id, directed: true }]); if (r.ok) this.select([], { edge: r.results[0].id }); }
        else this.render();
      } else if (d.kind === 'node') {
        if (!d.moved) return;
        if (this.map.settings.layout === 'free') {
          const ops = [...d.origin.keys()].map((id) => ({ op: 'updateNode', id, x: Math.round(this.pos.get(id).x), y: Math.round(this.pos.get(id).y) }));
          this.apply(ops, { silent: true });
        } else if (d.over) {
          this.apply([{ op: 'moveNode', id: d.id, parent: d.over.id }]);
        } else this.render();
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl) { this.startEdit(nodeEl.dataset.id); return; }
      const edge = e.target.closest('.edge');
      if (edge && !edge.dataset.id.startsWith('tree:')) { const label = prompt('Link label', this.map.edges.find((x) => x.id === edge.dataset.id)?.label || ''); if (label != null) this.apply([{ op: 'updateEdge', id: edge.dataset.id, label }]); return; }
      if (e.target === canvas || e.target === this.els.viewport || e.target.closest('#edges')) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        const r = this.apply([{ op: 'addNode', parent: null, text: 'New node', x: this.snap(w.x - 50), y: this.snap(w.y - 20) }]);
        if (r.ok) { this.select([r.results[0].id]); this.startEdit(r.results[0].id); }
      }
    });
    nodes.addEventListener('keydown', (e) => {
      if (!this.editing) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.finishEdit(true); this.els.canvas.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.finishEdit(false); this.els.canvas.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); const id = this.editing; this.finishEdit(true); this.addChild(id); }
      e.stopPropagation();
    });
    nodes.addEventListener('focusout', (e) => { if (this.editing && e.target.classList.contains('text')) setTimeout(() => { if (this.editing && document.activeElement !== e.target) this.finishEdit(true); }, 0); });
  }

  onKey(e) {
    const target = e.target;
    const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing && !target.isContentEditable) return; e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.exportJson(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
    if (typing) return;
    const n = this.primary;
    switch (e.key) {
      case 'Tab': e.preventDefault(); this.addChild(n ? n.id : null); break;
      case 'Enter': e.preventDefault(); if (n) this.addSibling(n.id); else this.addChild(null); break;
      case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelection(); break;
      case 'F2': case ' ': if (n) { e.preventDefault(); this.startEdit(n.id); } break;
      case 'Escape': this.select([]); break;
      case 'ArrowLeft': e.preventDefault(); this.navigate('left'); break;
      case 'ArrowRight': e.preventDefault(); this.navigate('right'); break;
      case 'ArrowUp': e.preventDefault(); this.navigate('up'); break;
      case 'ArrowDown': e.preventDefault(); this.navigate('down'); break;
      case 'f': case 'F': if (!mod) this.fit(); break;
      case '+': case '=': { const r = this.els.canvas.getBoundingClientRect(); this.zoomAt(1.2, r.width / 2, r.height / 2); break; }
      case '-': case '_': { const r = this.els.canvas.getBoundingClientRect(); this.zoomAt(1 / 1.2, r.width / 2, r.height / 2); break; }
      case 'c': case 'C': if (n && !mod && this.counts.get(n.id)) this.apply([{ op: 'updateNode', id: n.id, collapsed: !n.collapsed }], { silent: true }); break;
      case 'l': case 'L': if (!mod && this.selected.size === 2) { const [a, b] = [...this.selected]; const r = this.apply([{ op: 'addEdge', from: a, to: b }]); if (r.ok) this.select([], { edge: r.results[0].id }); } break;
      case 'd': case 'D': if (mod && n) { e.preventDefault(); this.duplicate(n.id); } break;
      case 'g': case 'G': if (!mod) this.toggleGrid(); break;
      default: break;
    }
    if (mod && e.key.toLowerCase() === 'c' && n) { e.preventDefault(); this.copy(this.subtreeMarkdown(n.id), 'Branch copied as outline'); }
  }
  subtreeMarkdown(id) {
    const sub = { ...this.map, nodes: M.subtreeIds(this.map, id).map((i) => M.nodeById(this.map, i)), edges: [], notes: [] };
    sub.nodes = sub.nodes.map((n) => (n.id === id ? { ...n, parent: null } : n));
    return M.toMarkdown(sub).replace(/^# .*\n\n/, '');
  }
  duplicate(id) {
    const n = M.nodeById(this.map, id);
    const build = (nid) => { const x = M.nodeById(this.map, nid); return { text: x.text, notes: x.notes, shape: x.shape, color: x.color, tags: x.tags, children: M.childrenOf(this.map, nid).map((c) => build(c.id)) }; };
    const tree = build(id);
    const r = this.apply([{ op: 'addTree', parent: n.parent, nodes: [{ ...tree, x: n.x + 30, y: n.y + 30 }] }]);
    if (r.ok) this.select([r.results[0].ids[0]]);
  }
  onPaste(e) {
    const target = e.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    e.preventDefault();
    this.ingest(text, { author: this.me, parent: this.primary?.id });
  }
  /** Accept pasted text: a map JSON, an operations array, or an outline. */
  ingest(text, { author = this.me, parent } = {}) {
    text = text.trim();
    let parsed = null;
    if (text.startsWith('{') || text.startsWith('[')) { try { parsed = JSON.parse(text); } catch (err) { this.toast('Invalid JSON: ' + err.message); return false; } }
    if (parsed) {
      if (Array.isArray(parsed) || parsed.op) { const r = this.apply(parsed, { author }); if (!r.ok) { this.toast(r.error, 5000); return false; } this.toast(`Applied ${Array.isArray(parsed) ? parsed.length : 1} operation(s)`); return true; }
      if (Array.isArray(parsed.nodes)) { this.importMap(parsed).then((m) => this.toast(`Imported "${m.name}"`)).catch((err) => this.toast(err.message)); return true; }
      if (parsed.text || parsed.children) { const r = this.apply([{ op: 'addTree', parent: parent ?? undefined, nodes: [parsed] }], { author }); if (!r.ok) this.toast(r.error, 5000); return r.ok; }
      this.toast('JSON is neither a map, an operations list nor a node tree'); return false;
    }
    const o = M.parseOutline(text);
    if (!o.tree.length) { this.toast('Nothing to add'); return false; }
    const r = this.apply([{ op: 'addTree', parent: parent ?? undefined, nodes: o.tree }], { author });
    if (!r.ok) { this.toast(r.error, 5000); return false; }
    const extra = [];
    for (const l of o.links) { const a = M.resolveNode(this.map, l.from), b = M.resolveNode(this.map, l.to); if (a && b) extra.push({ op: 'addEdge', from: a.id, to: b.id, label: l.label, directed: l.directed }); }
    for (const t of o.notes) extra.push({ op: 'addNote', target: null, text: t });
    if (extra.length) this.apply(extra, { author, undoable: false });
    this.toast(`Added ${r.results[0].ids.length} node(s)${extra.length ? ` and ${extra.length} link(s)/note(s)` : ''}`);
    this.select([r.results[0].ids[0]]);
    return true;
  }

  // ---------- side panel ----------
  renderPanel() {
    if (!this.map) return;
    const tab = this.tab || 'node';
    if (tab === 'node') this.renderNodeTab();
    else if (tab === 'notes') this.renderNotesTab();
    else if (tab === 'log') this.renderLogTab();
    else if (tab === 'api') this.renderApiTab();
    $('panelTitle').textContent = this.selectedEdge ? 'Link' : this.selected.size > 1 ? `${this.selected.size} nodes` : this.selected.size ? 'Node' : 'Map';
  }
  field(label, control) { return `<div class="field"><label>${label}</label>${control}</div>`; }
  swatches(current, name) { return `<div class="swatches" data-name="${name}">${M.COLORS.map((c) => `<button class="swatch${c === current ? ' active' : ''}" data-color="${c}" title="${c}" style="--c:${c === 'default' ? '#fff' : PALETTE[c].fill};--s:${PALETTE[c].stroke}"></button>`).join('')}</div>`; }
  renderNodeTab() {
    const el = $('tab-node');
    const map = this.map;
    if (this.selectedEdge) {
      const e = map.edges.find((x) => x.id === this.selectedEdge); if (!e) { this.selectedEdge = null; return this.renderNodeTab(); }
      const a = M.nodeById(map, e.from), b = M.nodeById(map, e.to);
      el.innerHTML = `<p class="info">${esc(a?.text)} ${e.directed ? '→' : '–'} ${esc(b?.text)}</p>` +
        this.field('Label', `<input type="text" id="edgeLabel" value="${esc(e.label)}">`) +
        this.field('Style', `<select id="edgeStyle"><option value="">Map default</option>${M.EDGE_STYLES.map((s) => `<option value="${s}"${e.style === s ? ' selected' : ''}>${s}</option>`).join('')}</select>`) +
        `<div class="field check"><label><input type="checkbox" id="edgeDirected"${e.directed ? ' checked' : ''}> Arrow head</label></div>` +
        this.field('Colour', this.swatches(e.color, 'edge')) +
        `<div class="row"><button class="btn" id="edgeSwap">Reverse</button><button class="btn danger" id="edgeDelete">Delete</button></div>` +
        (e.author && e.author !== this.me ? `<p class="info">Added by ${esc(e.author)}</p>` : '');
      $('edgeLabel').onchange = (ev) => this.apply([{ op: 'updateEdge', id: e.id, label: ev.target.value }], { fromPanel: true });
      $('edgeStyle').onchange = (ev) => this.apply([{ op: 'updateEdge', id: e.id, style: ev.target.value || null }], { fromPanel: true });
      $('edgeDirected').onchange = (ev) => this.apply([{ op: 'updateEdge', id: e.id, directed: ev.target.checked }], { fromPanel: true });
      $('edgeSwap').onclick = () => this.apply([{ op: 'updateEdge', id: e.id, from: e.to, to: e.from }]);
      $('edgeDelete').onclick = () => this.deleteSelection();
      el.querySelectorAll('.swatch').forEach((s) => (s.onclick = () => this.apply([{ op: 'updateEdge', id: e.id, color: s.dataset.color }])));
      return;
    }
    const n = this.primary;
    if (!n) {
      el.innerHTML = this.field('Name', `<input type="text" id="mName" value="${esc(map.name)}">`) +
        this.field('Kind', `<select id="mKind">${M.KINDS.map((k) => `<option value="${k}"${map.kind === k ? ' selected' : ''}>${k === 'mindmap' ? 'Mind map' : 'Flowchart'}</option>`).join('')}</select>`) +
        this.field('Layout', `<select id="mLayout">${M.LAYOUTS.map((k) => `<option value="${k}"${map.settings.layout === k ? ' selected' : ''}>${k}</option>`).join('')}</select>`) +
        this.field('Link style', `<select id="mEdge">${M.EDGE_STYLES.map((k) => `<option value="${k}"${map.settings.edgeStyle === k ? ' selected' : ''}>${k}</option>`).join('')}</select>`) +
        this.field('Snap to grid', `<select id="mGrid">${[0, 10, 20, 25, 40, 50].map((g) => `<option value="${g}"${(map.settings.grid || 0) === g ? ' selected' : ''}>${g ? g + ' px' : 'Off'}</option>`).join('')}</select>`) +
        `<div class="field check"><label><input type="checkbox" id="mAuthors"${map.settings.showAuthors !== false ? ' checked' : ''}> Mark nodes added by others (AI)</label></div>` +
        this.field('Your author name', `<input type="text" id="mMe" value="${esc(this.me)}" placeholder="user">`) +
        `<h3 class="sec">Map</h3><div class="stat"><span>Nodes</span><b>${map.nodes.length}</b></div><div class="stat"><span>Links</span><b>${map.edges.length}</b></div><div class="stat"><span>Notes</span><b>${map.notes.length}</b></div><div class="stat"><span>Map id</span><b class="mono">${esc(map.id)}</b></div><div class="stat"><span>Updated</span><b>${fmtTime(map.updatedAt)}</b></div>` +
        `<div class="row"><button class="btn" id="mLayoutOnce">Tidy once</button><button class="btn danger" id="mDelete">Delete map</button></div>` +
        `<p class="info">Double-click the canvas to add a floating node. Select a node and press <kbd>Tab</kbd> for a child, <kbd>Enter</kbd> for a sibling.</p>`;
      $('mName').onchange = (ev) => this.apply([{ op: 'setMap', name: ev.target.value }], { silent: true, fromPanel: true });
      $('mKind').onchange = (ev) => this.apply([{ op: 'setMap', kind: ev.target.value }]);
      $('mLayout').onchange = (ev) => this.apply([{ op: 'layout', mode: ev.target.value }]);
      $('mEdge').onchange = (ev) => this.apply([{ op: 'setMap', settings: { edgeStyle: ev.target.value } }]);
      $('mGrid').onchange = (ev) => { const g = +ev.target.value; if (g) prefs.set('grid', g); this.apply([{ op: 'setMap', settings: { grid: g } }], { silent: true }); };
      $('mAuthors').onchange = (ev) => this.apply([{ op: 'setMap', settings: { showAuthors: ev.target.checked } }], { silent: true });
      $('mMe').onchange = (ev) => { this.me = ev.target.value.trim() || 'user'; prefs.set('author', this.me); this.render(); };
      $('mLayoutOnce').onclick = () => { const mode = map.settings.layout === 'free' ? (map.kind === 'flowchart' ? 'layered-down' : 'mindmap') : map.settings.layout; this.apply([{ op: 'layout', mode, once: true }]); };
      $('mDelete').onclick = () => { if (confirm(`Delete "${map.name}"? This cannot be undone.`)) this.deleteMap(map.id); };
      return;
    }
    const multi = this.selected.size > 1;
    el.innerHTML = (multi ? `<p class="info">${this.selected.size} nodes selected. Changes below apply to all of them.</p>` : '') +
      (!multi ? this.field('Text', `<textarea id="nText" rows="2">${esc(n.text)}</textarea>`) : '') +
      this.field('Shape', `<select id="nShape">${M.SHAPES.map((s) => `<option value="${s}"${n.shape === s ? ' selected' : ''}>${s}</option>`).join('')}</select>`) +
      this.field('Colour', this.swatches(n.color, 'node')) +
      (!multi ? this.field('Tags <span class="val">comma separated</span>', `<input type="text" id="nTags" value="${esc(n.tags.join(', '))}">`) : '') +
      (!multi ? this.field('Notes', `<textarea id="nNotes" rows="4" placeholder="Longer text shown on hover and in exports">${esc(n.notes)}</textarea>`) : '') +
      (!multi ? `<div class="row"><button class="btn" id="nChild">+ Child</button><button class="btn" id="nSibling">+ Sibling</button><button class="btn danger" id="nDelete">Delete</button></div>` : `<div class="row"><button class="btn danger" id="nDelete">Delete</button></div>`) +
      (!multi ? `<div class="row" style="margin-top:6px"><button class="btn" id="nDetach"${n.parent == null ? ' disabled' : ''}>Detach</button><button class="btn" id="nCenter">Centre</button></div>` : '') +
      (!multi ? `<p class="info">Added by <b>${esc(n.author)}</b> ${fmtTime(n.createdAt)}<br>id <span class="mono">${esc(n.id)}</span></p>` : '');
    const ids = [...this.selected];
    if (!multi) {
      $('nText').onchange = (ev) => this.apply([{ op: 'updateNode', id: n.id, text: ev.target.value }], { fromPanel: true });
      $('nTags').onchange = (ev) => this.apply([{ op: 'updateNode', id: n.id, tags: ev.target.value }], { fromPanel: true });
      $('nNotes').onchange = (ev) => this.apply([{ op: 'updateNode', id: n.id, notes: ev.target.value }], { fromPanel: true });
      $('nChild').onclick = () => this.addChild(n.id);
      $('nSibling').onclick = () => this.addSibling(n.id);
      $('nDetach').onclick = () => this.apply([{ op: 'moveNode', id: n.id, parent: null }]);
      $('nCenter').onclick = () => this.centerOn(n.id);
    }
    $('nShape').onchange = (ev) => this.apply(ids.map((id) => ({ op: 'updateNode', id, shape: ev.target.value })), { fromPanel: true });
    $('nDelete').onclick = () => this.deleteSelection();
    el.querySelectorAll('.swatch').forEach((s) => (s.onclick = () => this.apply(ids.map((id) => ({ op: 'updateNode', id, color: s.dataset.color })))));
  }
  renderNotesTab() {
    const el = $('tab-notes'); const map = this.map; const n = this.primary;
    const notes = n ? map.notes.filter((c) => c.target === n.id) : map.notes;
    el.innerHTML = `<p class="info">${n ? `Notes on <b>${esc(n.text)}</b>` : 'All notes on this map'}. Notes are comments attached to the map or a node, kept separate from node text so people and AI can annotate without rewriting.</p>` +
      `<div class="notes">${notes.map((c) => `<div class="note"><div class="note-meta"><b>${esc(c.author)}</b> · ${fmtTime(c.createdAt)}${!n && c.target ? ` · on ${esc(M.nodeById(map, c.target)?.text || '?')}` : ''}<button class="link" data-del="${esc(c.id)}">delete</button></div><div class="note-text">${esc(c.text)}</div></div>`).join('') || '<p class="info">No notes yet.</p>'}</div>` +
      `<textarea id="noteText" rows="3" placeholder="${n ? 'Add a note on this node…' : 'Add a note on the map…'}"></textarea><div class="row"><button class="btn primary" id="noteAdd">Add note</button></div>`;
    $('noteAdd').onclick = () => { const t = $('noteText').value.trim(); if (!t) return; this.apply([{ op: 'addNote', target: n?.id ?? null, text: t }]); };
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => this.apply([{ op: 'deleteNote', id: b.dataset.del }])));
  }
  renderLogTab() {
    const el = $('tab-log'); const log = this.map.log.slice(-150).reverse();
    el.innerHTML = `<p class="info">What changed and who did it. Entries by other authors (for example an AI) are highlighted.</p><div class="log">${log.map((l) => `<div class="log-item${l.author !== this.me ? ' other' : ''}"${l.id ? ` data-id="${esc(l.id)}"` : ''}><div class="note-meta"><b>${esc(l.author)}</b> · ${fmtTime(l.at)} · ${esc(l.op)}</div><div>${esc(l.summary)}</div></div>`).join('') || '<p class="info">Nothing yet.</p>'}</div><div class="row"><button class="btn" id="logClear">Clear log</button></div>`;
    $('logClear').onclick = () => { this.map.log = []; this.scheduleSave(); this.renderLogTab(); };
    el.querySelectorAll('.log-item[data-id]').forEach((d) => (d.onclick = () => { const id = d.dataset.id; if (M.nodeById(this.map, id)) { this.select([id]); this.centerOn(id); this.showTab('log'); } }));
  }
  renderApiTab() {
    const el = $('tab-api');
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = `<p class="info">This page is the API. An AI can read and edit the open map in three ways:</p>
      <ol class="info">
        <li><b>Paste</b>: copy the map (Export ▾ Copy JSON / outline), let an AI work on it, paste the result here or anywhere on the canvas.</li>
        <li><b>Link</b>: an AI can build a URL such as <code>#ops=[…]</code> or <code>#outline=…</code>; opening it applies the change.</li>
        <li><b>Script</b>: browser-driving agents call <code>window.mindmap</code> (<code>getMap()</code>, <code>apply(ops)</code>, …).</li>
      </ol>
      <p class="info"><a href="api.html" target="_blank">Full API reference ↗</a> · <a href="llms.txt" target="_blank">llms.txt</a></p>
      <div class="field"><label>Paste map JSON, an operations list, or a markdown outline</label><textarea id="pasteBox" rows="7" placeholder="- Idea&#10;  - Sub idea&#10;  - Another"></textarea></div>
      <div class="field"><label>Apply as author</label><input type="text" id="pasteAuthor" value="assistant"></div>
      <div class="row"><button class="btn primary" id="pasteApply">Apply</button><button class="btn" id="copyMap">Copy map JSON</button></div>
      <p class="info">Outlines are added under the selected node (or the root). Operation lists and map JSON are applied as-is.</p>`;
    $('pasteApply').onclick = () => { const ok = this.ingest($('pasteBox').value, { author: $('pasteAuthor').value.trim() || 'assistant', parent: this.primary?.id }); if (ok) $('pasteBox').value = ''; };
    $('copyMap').onclick = () => this.copy(JSON.stringify(this.map, null, 2), 'Map JSON copied');
  }

  // ---------- import / export ----------
  async openFile() {
    const file = await pickFile('.json,.md,.txt,application/json,text/markdown,text/plain');
    if (!file) return;
    const text = await file.text();
    try {
      if (file.name.endsWith('.json') || text.trim().startsWith('{')) { const m = await this.importMap(JSON.parse(text)); this.toast(`Opened "${m.name}"`); }
      else { const m = M.mapFromOutline(text, { author: this.me, name: file.name.replace(/\.[^.]+$/, '') }); await store.put(m); this.loadMap(m); this.toast(`Imported "${m.name}"`); }
    } catch (e) { this.toast('Could not open: ' + e.message, 5000); }
  }
  safeName() { return (this.map.name || 'map').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'map'; }
  exportJson() { download(`${this.safeName()}.mindmap.json`, new Blob([JSON.stringify(this.map, null, 2)], { type: 'application/json' })); }
  exportMd() { download(`${this.safeName()}.md`, new Blob([M.toMarkdown(this.map)], { type: 'text/markdown' })); }
  svgString() { return buildSvg(this.map, this.pos, this.sizes, { visible: this.visible }); }
  exportSvg() { download(`${this.safeName()}.svg`, new Blob([this.svgString()], { type: 'image/svg+xml' })); }
  exportPng() {
    const svg = this.svgString();
    const m = svg.match(/width="(\d+)" height="(\d+)"/);
    const W = +m[1], H = +m[2];
    const scale = Math.min(2, 4000 / Math.max(W, H));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => download(`${this.safeName()}.png`, blob), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); this.toast('PNG export failed'); };
    img.src = url;
  }
}

export const editor = new Editor();
editor.init().catch((e) => { console.error(e); document.getElementById('toast').textContent = 'Could not start: ' + e.message; document.getElementById('toast').hidden = false; });
