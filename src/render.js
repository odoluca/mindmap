// Drawing: node shapes, edge routing, the live DOM renderer (HTML nodes over an SVG edge layer)
// and a standalone SVG builder used for SVG and PNG export.
import { STYLE, estimateMeasure, rootId } from './layout.js?v=0.2.0';

export const PALETTE = {
  default: { fill: '#ffffff', stroke: '#c9ced6', text: '#1f2328' },
  red: { fill: '#fde8e8', stroke: '#e05b5b', text: '#7a1f1f' },
  orange: { fill: '#ffe9d6', stroke: '#ef8a3c', text: '#7a3d0f' },
  yellow: { fill: '#fff6c2', stroke: '#d9b100', text: '#6b5600' },
  green: { fill: '#e0f5e4', stroke: '#3cab5c', text: '#1d5a2e' },
  teal: { fill: '#d9f3f1', stroke: '#2aa7a0', text: '#115955' },
  blue: { fill: '#e3eefc', stroke: '#3b82e0', text: '#17417a' },
  purple: { fill: '#ece4fb', stroke: '#8b5cf6', text: '#44248a' },
  pink: { fill: '#fce4f0', stroke: '#e0529a', text: '#7a1f4f' },
  gray: { fill: '#eceef1', stroke: '#8a929c', text: '#3a3f47' },
};
export const ROOT_STYLE = { fill: '#1f7ae0', stroke: '#1763b8', text: '#ffffff' };
export const STICKY_STYLE = { fill: '#fff3a3', stroke: '#e3c93a', text: '#4a3f00' };
const EDGE_DEFAULT = '#6b7280', TREE_DEFAULT = '#aab2bd';

export function nodeColors(node, isRoot) {
  if (node.shape === 'sticky' && node.color === 'default') return STICKY_STYLE;
  if (isRoot && node.color === 'default') return ROOT_STYLE;
  return PALETTE[node.color] || PALETTE.default;
}

/** SVG path for a node shape of the given size (origin at top-left). */
export function shapePath(shape, w, h) {
  const r = Math.min(10, h / 2);
  switch (shape) {
    case 'rect': return `M0 0H${w}V${h}H0Z`;
    case 'stadium': { const rr = h / 2; return `M${rr} 0H${w - rr}A${rr} ${rr} 0 0 1 ${w - rr} ${h}H${rr}A${rr} ${rr} 0 0 1 ${rr} 0Z`; }
    case 'ellipse': { const rx = w / 2, ry = h / 2; return `M0 ${ry}A${rx} ${ry} 0 1 0 ${w} ${ry}A${rx} ${ry} 0 1 0 0 ${ry}Z`; }
    case 'diamond': return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case 'parallelogram': { const k = Math.min(18, w / 4); return `M${k} 0H${w}L${w - k} ${h}H0Z`; }
    case 'hexagon': { const k = Math.min(16, w / 4); return `M${k} 0H${w - k}L${w} ${h / 2}L${w - k} ${h}H${k}L0 ${h / 2}Z`; }
    case 'cylinder': { const ry = 7, rx = w / 2; return `M0 ${ry}A${rx} ${ry} 0 0 1 ${w} ${ry}V${h - ry}A${rx} ${ry} 0 0 1 0 ${h - ry}Z M0 ${ry}A${rx} ${ry} 0 0 0 ${w} ${ry}`; }
    case 'sticky': { const f = 16; return `M0 0H${w}V${h - f}L${w - f} ${h}H0Z`; }
    case 'text': return '';
    default: return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
  }
}

// ---------- edge routing ----------

function box(id, pos, sizes) { const p = pos.get(id), s = sizes.get(id); return { x: p.x, y: p.y, w: s.w, h: s.h, cx: p.x + s.w / 2, cy: p.y + s.h / 2 }; }

/** Point where the ray from the box centre toward (tx,ty) leaves the box. */
function exitPoint(b, tx, ty) {
  const dx = tx - b.cx, dy = ty - b.cy;
  if (!dx && !dy) return { x: b.cx, y: b.cy };
  const sx = Math.abs(dx) > 1e-6 ? (b.w / 2) / Math.abs(dx) : Infinity, sy = Math.abs(dy) > 1e-6 ? (b.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: b.cx + dx * t, y: b.cy + dy * t };
}

/** Pick anchor sides for a pair of boxes based on their relative position. */
function sides(a, b, preferHorizontal) {
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const horizontal = preferHorizontal == null ? Math.abs(dx) * 1.2 > Math.abs(dy) : preferHorizontal;
  if (horizontal) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}
function sidePoint(b, side) {
  switch (side) {
    case 'right': return { x: b.x + b.w, y: b.cy, nx: 1, ny: 0 };
    case 'left': return { x: b.x, y: b.cy, nx: -1, ny: 0 };
    case 'top': return { x: b.cx, y: b.y, nx: 0, ny: -1 };
    default: return { x: b.cx, y: b.y + b.h, nx: 0, ny: 1 };
  }
}

/**
 * Route an edge. Returns { d, start, end, dir (unit vector at end), mid } or null when a node is missing.
 * `style`: curved | straight | orthogonal. `layout` hints the preferred axis for tree links.
 */
export function routeEdge(fromId, toId, style, pos, sizes, layoutHint, offset = 0) {
  if (!pos.has(fromId) || !pos.has(toId)) return null;
  const a = box(fromId, pos, sizes), b = box(toId, pos, sizes);
  if (fromId === toId) {
    const x = a.x + a.w - 10, y = a.y;
    return { d: `M${x} ${y}C${x + 40} ${y - 50} ${x + 70} ${y + 20} ${a.x + a.w} ${a.cy}`, start: { x, y }, end: { x: a.x + a.w, y: a.cy }, dir: { x: -1, y: 0.3 }, mid: { x: x + 45, y: y - 25 } };
  }
  if (style === 'straight') {
    const s = exitPoint(a, b.cx, b.cy), e = exitPoint(b, a.cx, a.cy);
    if (offset) { const L = Math.hypot(e.x - s.x, e.y - s.y) || 1, px = -(e.y - s.y) / L * offset, py = (e.x - s.x) / L * offset; s.x += px; s.y += py; e.x += px; e.y += py; }
    const len = Math.hypot(e.x - s.x, e.y - s.y) || 1;
    return { d: `M${s.x} ${s.y}L${e.x} ${e.y}`, start: s, end: e, dir: { x: (e.x - s.x) / len, y: (e.y - s.y) / len }, mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 } };
  }
  const prefer = layoutHint === 'horizontal' ? true : layoutHint === 'vertical' ? false : null;
  const [sa, sb] = sides(a, b, prefer);
  const s = sidePoint(a, sa), e = sidePoint(b, sb);
  if (offset) { // shift both anchors along their side so parallel links do not coincide
    s.x += -s.ny * offset; s.y += s.nx * offset;
    e.x += -e.ny * offset; e.y += e.nx * offset;
  }
  if (style === 'orthogonal') {
    let d, mid;
    if (s.nx) { // horizontal departure: go half way, turn, go the rest
      const mx = (s.x + e.x) / 2;
      if (e.nx) { d = `M${s.x} ${s.y}H${mx}V${e.y}H${e.x}`; mid = { x: mx, y: (s.y + e.y) / 2 }; }
      else { d = `M${s.x} ${s.y}H${e.x}V${e.y}`; mid = { x: (s.x + e.x) / 2, y: s.y }; }
    } else {
      const my = (s.y + e.y) / 2;
      if (e.ny) { d = `M${s.x} ${s.y}V${my}H${e.x}V${e.y}`; mid = { x: (s.x + e.x) / 2, y: my }; }
      else { d = `M${s.x} ${s.y}V${e.y}H${e.x}`; mid = { x: s.x, y: (s.y + e.y) / 2 }; }
    }
    return { d, start: s, end: e, dir: { x: -e.nx, y: -e.ny }, mid };
  }
  // curved
  const dist = Math.hypot(e.x - s.x, e.y - s.y);
  const k = Math.max(30, Math.min(140, dist / 2));
  const c1 = { x: s.x + s.nx * k, y: s.y + s.ny * k }, c2 = { x: e.x + e.nx * k, y: e.y + e.ny * k };
  const mid = bez(s, c1, c2, e, 0.5);
  const dl = Math.hypot(e.x - c2.x, e.y - c2.y) || 1;
  return { d: `M${s.x} ${s.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${e.x} ${e.y}`, start: s, end: e, dir: { x: (e.x - c2.x) / dl, y: (e.y - c2.y) / dl }, mid };
}
function bez(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
}
export function arrowPoints(end, dir, size = 10) {
  const px = -dir.y, py = dir.x;
  const bx = end.x - dir.x * size, by = end.y - dir.y * size;
  return `${end.x},${end.y} ${bx + px * size * 0.45},${by + py * size * 0.45} ${bx - px * size * 0.45},${by - py * size * 0.45}`;
}

/** All drawable links: implicit parent links plus explicit edges. */
export function collectLinks(map, visibleIds) {
  const links = [];
  const flow = map.kind === 'flowchart';
  for (const n of map.nodes) if (n.parent != null && visibleIds.has(n.id) && visibleIds.has(n.parent)) {
    links.push({ id: 'tree:' + n.id, tree: true, from: n.parent, to: n.id, directed: flow, label: '', color: n.color !== 'default' ? PALETTE[n.color].stroke : TREE_DEFAULT, style: null, nodeId: n.id });
  }
  for (const e of map.edges) if (visibleIds.has(e.from) && visibleIds.has(e.to)) {
    links.push({ id: e.id, tree: false, from: e.from, to: e.to, directed: e.directed, label: e.label, color: e.color !== 'default' ? PALETTE[e.color].stroke : EDGE_DEFAULT, style: e.style, author: e.author });
  }
  // Links that share a pair of nodes are spread apart so they do not overlap.
  const groups = new Map();
  for (const l of links) { const key = l.from < l.to ? l.from + '|' + l.to : l.to + '|' + l.from; (groups.get(key) || groups.set(key, []).get(key)).push(l); }
  for (const g of groups.values()) if (g.length > 1) g.forEach((l, i) => { const o = (i - (g.length - 1) / 2) * 18; l.offset = l.from < l.to ? o : -o; });
  return links;
}

export function layoutHint(mode) {
  if (mode === 'down' || mode === 'layered-down') return 'vertical';
  if (mode === 'right' || mode === 'mindmap' || mode === 'layered-right') return 'horizontal';
  return null;
}

// ---------- canvas text measurer ----------

export function createMeasure() {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d');
  if (!ctx) return estimateMeasure;
  const cache = new Map();
  return (text, font) => {
    const key = font + '\u0000' + text;
    let w = cache.get(key);
    if (w == null) { ctx.font = font; w = ctx.measureText(text).width; if (cache.size > 20000) cache.clear(); cache.set(key, w); }
    return w;
  };
}

// ---------- live DOM renderer ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Render the map into the layers. `view` = { nodesEl, edgesEl, pos, sizes, map, visible (Set), selected (Set of node ids),
 * selectedEdge, editing (node id), matches (Set), me (author name), showAuthors, counts (Map id -> hidden descendant count) }.
 */
export function renderNodes(view) {
  const { nodesEl, map, pos, sizes, visible, selected, editing, matches, showAuthors, me, counts } = view;
  const existing = new Map();
  for (const el of nodesEl.children) existing.set(el.dataset.id, el);
  const root = rootId(map);
  for (const n of map.nodes) {
    if (!visible.has(n.id)) { const el = existing.get(n.id); if (el) el.remove(); existing.delete(n.id); continue; }
    let el = existing.get(n.id);
    if (!el) { el = document.createElement('div'); el.className = 'node'; el.dataset.id = n.id; el.innerHTML = '<svg class="shape"><path/></svg><div class="text"></div><span class="badge"></span><button class="toggle" tabindex="-1"></button><span class="port port-r"></span><span class="port port-l"></span><span class="port port-t"></span><span class="port port-b"></span>'; nodesEl.appendChild(el); }
    existing.delete(n.id);
    const s = sizes.get(n.id), p = pos.get(n.id);
    const isRoot = n.id === root;
    const col = nodeColors(n, isRoot);
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = s.w + 'px'; el.style.height = s.h + 'px';
    el.className = `node s-${n.shape} c-${n.color}${isRoot ? ' root' : ''}${selected.has(n.id) ? ' selected' : ''}${matches && matches.size ? (matches.has(n.id) ? ' match' : ' dim') : ''}${editing === n.id ? ' editing' : ''}${n.collapsed ? ' collapsed' : ''}`;
    el.style.setProperty('--fill', col.fill); el.style.setProperty('--stroke', col.stroke); el.style.setProperty('--text', col.text);
    const svg = el.firstElementChild;
    svg.setAttribute('width', s.w); svg.setAttribute('height', s.h);
    svg.firstElementChild.setAttribute('d', shapePath(n.shape, s.w, s.h));
    const textEl = el.children[1];
    textEl.style.font = s.font; textEl.style.lineHeight = s.lh + 'px';
    if (editing !== n.id) {
      const html = s.lines.map(esc).join('<br>');
      if (textEl.innerHTML !== html) textEl.innerHTML = html;
      textEl.contentEditable = 'false';
    }
    const badge = el.children[2];
    const foreign = showAuthors && n.author && n.author !== me;
    badge.hidden = !foreign; if (foreign) { badge.textContent = n.author.slice(0, 2).toUpperCase(); badge.title = `Added by ${n.author}`; }
    const toggle = el.children[3];
    const kids = counts.get(n.id) || 0;
    toggle.hidden = !kids;
    if (kids) { toggle.textContent = n.collapsed ? String(kids) : '–'; toggle.title = n.collapsed ? `Expand ${kids} hidden node${kids > 1 ? 's' : ''}` : 'Collapse'; }
    if (n.notes) el.title = n.notes; else el.removeAttribute('title');
  }
  for (const el of existing.values()) el.remove();
}

export function renderEdges(view) {
  const { edgesEl, map, pos, sizes, visible, selectedEdge, hoverLink } = view;
  const links = collectLinks(map, visible);
  const hint = layoutHint(map.settings.layout);
  const frag = document.createDocumentFragment();
  for (const l of links) {
    const style = l.style || (l.tree && map.settings.layout === 'radial' ? 'straight' : map.settings.edgeStyle);
    const r = routeEdge(l.from, l.to, style, pos, sizes, l.tree ? hint : null, l.offset || 0);
    if (!r) continue;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `edge${l.tree ? ' tree' : ' link'}${selectedEdge === l.id ? ' selected' : ''}`);
    g.dataset.id = l.id;
    const hit = document.createElementNS(SVG_NS, 'path'); hit.setAttribute('class', 'hit'); hit.setAttribute('d', r.d); g.appendChild(hit);
    const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('class', 'line'); path.setAttribute('d', r.d); path.setAttribute('stroke', l.color); g.appendChild(path);
    if (l.directed) { const a = document.createElementNS(SVG_NS, 'polygon'); a.setAttribute('points', arrowPoints(r.end, r.dir)); a.setAttribute('fill', l.color); g.appendChild(a); }
    if (l.label) { const t = document.createElementNS(SVG_NS, 'text'); t.setAttribute('x', r.mid.x); t.setAttribute('y', r.mid.y); t.setAttribute('class', 'label'); t.textContent = l.label; g.appendChild(t); }
    frag.appendChild(g);
  }
  if (hoverLink) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('class', 'draft'); p.setAttribute('d', hoverLink); frag.appendChild(p); }
  edgesEl.replaceChildren(frag);
}

// ---------- standalone SVG for export ----------

export function buildSvg(map, pos, sizes, { padding = 40, background = '#ffffff', visible } = {}) {
  const ids = visible || new Set(pos.keys());
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) { const p = pos.get(id), s = sizes.get(id); if (!p) continue; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
  const W = Math.ceil(maxX - minX + padding * 2), H = Math.ceil(maxY - minY + padding * 2);
  const ox = padding - minX, oy = padding - minY;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, system-ui, sans-serif">`];
  out.push(`<rect width="${W}" height="${H}" fill="${background}"/>`);
  out.push(`<g transform="translate(${ox} ${oy})">`);
  const hint = layoutHint(map.settings.layout);
  for (const l of collectLinks(map, ids)) {
    const style = l.style || (l.tree && map.settings.layout === 'radial' ? 'straight' : map.settings.edgeStyle);
    const r = routeEdge(l.from, l.to, style, pos, sizes, l.tree ? hint : null, l.offset || 0);
    if (!r) continue;
    out.push(`<path d="${r.d}" fill="none" stroke="${l.color}" stroke-width="${l.tree ? 2 : 1.8}" stroke-linecap="round" stroke-linejoin="round"/>`);
    if (l.directed) out.push(`<polygon points="${arrowPoints(r.end, r.dir)}" fill="${l.color}"/>`);
    if (l.label) out.push(`<text x="${r.mid.x}" y="${r.mid.y}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="#3a3f47" stroke="${background}" stroke-width="4" paint-order="stroke" font-weight="500">${esc(l.label)}</text>`);
  }
  const root = rootId(map);
  for (const n of map.nodes) {
    if (!ids.has(n.id)) continue;
    const p = pos.get(n.id), s = sizes.get(n.id);
    const isRoot = n.id === root;
    const col = nodeColors(n, isRoot);
    out.push(`<g transform="translate(${p.x} ${p.y})">`);
    if (n.shape !== 'text') out.push(`<path d="${shapePath(n.shape, s.w, s.h)}" fill="${col.fill}" stroke="${col.stroke}" stroke-width="${isRoot ? 2 : 1.5}"/>`);
    const fontSize = isRoot ? STYLE.rootFontSize : STYLE.fontSize;
    const top = s.h / 2 - (s.lines.length * s.lh) / 2 + s.lh / 2;
    out.push(`<text x="${s.w / 2}" y="${top}" font-size="${fontSize}" font-weight="${isRoot ? 600 : 500}" fill="${col.text}" text-anchor="middle" dominant-baseline="middle">`);
    s.lines.forEach((line, i) => out.push(`<tspan x="${s.w / 2}" dy="${i ? s.lh : 0}">${esc(line) || ' '}</tspan>`));
    out.push('</text></g>');
  }
  out.push('</g></svg>');
  return out.join('\n');
}
