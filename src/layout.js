// Text wrapping, node sizing and the automatic layouts. Pure functions; the text measurer is injected
// so the same code runs in the browser (canvas measureText) and in Node tests (character estimate).

export const FONT_FAMILY = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
export const STYLE = {
  fontSize: 14, lineHeight: 20, padX: 14, padY: 9, maxWidth: 220,
  rootFontSize: 16, rootPadX: 18, rootPadY: 12, rootMaxWidth: 260,
  hGap: 64, vGap: 14, downGap: 56, sideGap: 22, ring: 190, treeGap: 60, layerGap: 70, layerSideGap: 40,
};

/** Approximate measurer used when no canvas is available. */
export function estimateMeasure(text, font) {
  const size = parseFloat(font) || 14;
  const bold = /bold|600|700/.test(font);
  let w = 0;
  for (const ch of text) w += /[A-Z]/.test(ch) ? 0.66 : /[mw]/.test(ch) ? 0.85 : /[ilj.,'|!:I]/.test(ch) ? 0.3 : /\s/.test(ch) ? 0.28 : 0.55;
  return w * size * (bold ? 1.06 : 1);
}

export function fontFor(node, isRoot) {
  return `${isRoot ? '600 ' + STYLE.rootFontSize : '500 ' + STYLE.fontSize}px ${FONT_FAMILY}`;
}

/** Wrap text to lines no wider than maxWidth. Explicit newlines are kept. */
export function wrapText(text, maxWidth, font, measure) {
  const lines = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const trial = line ? line + ' ' + word : word;
      if (line && measure(trial, font) > maxWidth) {
        lines.push(line); line = word;
      } else line = trial;
      // Break very long words that do not fit on their own line.
      while (measure(line, font) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), font) > maxWidth) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Size of a node box: { w, h, lines, font, textW, textH }. Respects explicit node.w / node.h. */
export function nodeSize(node, isRoot, measure) {
  const font = fontFor(node, isRoot);
  const padX = isRoot ? STYLE.rootPadX : STYLE.padX, padY = isRoot ? STYLE.rootPadY : STYLE.padY;
  const lh = STYLE.lineHeight * (isRoot ? 1.15 : 1);
  const maxW = node.w ? Math.max(30, node.w - padX * 2) : isRoot ? STYLE.rootMaxWidth : STYLE.maxWidth;
  const lines = wrapText(node.text || ' ', maxW, font, measure);
  const textW = Math.max(...lines.map((l) => measure(l, font)), 20);
  const textH = lines.length * lh;
  let w = textW + padX * 2, h = textH + padY * 2;
  switch (node.shape) {
    case 'diamond': w = textW * 1.9 + padX * 2; h = textH * 2.1 + padY; break;
    case 'ellipse': w = textW * 1.25 + padX * 2; h = textH * 1.35 + padY * 2; break;
    case 'parallelogram': w += 26; break;
    case 'hexagon': w += 30; break;
    case 'cylinder': h += 16; break;
    case 'stadium': w += 12; break;
    case 'sticky': w = Math.max(w, 140); h = Math.max(h, 100); break;
    default: break;
  }
  if (node.w) w = node.w;
  if (node.h) h = node.h;
  return { w: Math.round(w), h: Math.round(h), lines, font, lh, textW, textH };
}

/** The node drawn as the central idea: the first top-level node of a mind map. */
export function rootId(map) {
  if (map.kind !== 'mindmap') return null;
  return map.nodes.find((n) => n.parent == null)?.id ?? null;
}

/** Nodes that are not hidden below a collapsed ancestor. */
export function visibleNodes(map) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.nodes.filter((n) => {
    let p = n.parent;
    while (p != null) { const pn = byId.get(p); if (!pn) break; if (pn.collapsed) return false; p = pn.parent; }
    return true;
  });
}

export function computeSizes(map, measure) {
  const sizes = new Map();
  const root = rootId(map);
  for (const n of map.nodes) sizes.set(n.id, nodeSize(n, n.id === root, measure));
  return sizes;
}

/**
 * Compute positions (top-left corners) for every visible node under the given layout mode.
 * Returns a Map id -> {x, y}. For 'free', existing coordinates are returned unchanged.
 */
export function computeLayout(map, mode, sizes) {
  const vis = visibleNodes(map);
  const pos = new Map();
  if (mode === 'free' || !vis.length) { for (const n of vis) pos.set(n.id, { x: n.x, y: n.y }); return pos; }
  const visSet = new Set(vis.map((n) => n.id));
  const kids = new Map();
  for (const n of vis) { if (!kids.has(n.id)) kids.set(n.id, []); if (n.parent != null && visSet.has(n.parent)) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n.id); } }
  const sz = (id) => sizes.get(id);
  const roots = vis.filter((n) => n.parent == null || !visSet.has(n.parent)).map((n) => n.id);

  if (mode === 'layered-down' || mode === 'layered-right') return layered(map, vis, sizes, mode === 'layered-down');

  // Tree layouts: lay out each root separately and stack the results.
  const blocks = [];
  for (const r of roots) {
    const local = new Map();
    if (mode === 'radial') radial(r, kids, sz, local);
    else if (mode === 'mindmap') mindmap(r, kids, sz, local);
    else tree(r, kids, sz, local, mode);
    blocks.push(local);
  }
  let cursor = 0;
  for (const local of blocks) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, p] of local) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + sz(id).w); maxY = Math.max(maxY, p.y + sz(id).h); }
    const vertical = mode !== 'down';
    for (const [id, p] of local) pos.set(id, vertical ? { x: p.x - minX, y: p.y - minY + cursor } : { x: p.x - minX + cursor, y: p.y - minY });
    cursor += (vertical ? maxY - minY : maxX - minX) + STYLE.treeGap;
  }
  return pos;
}

// --- tidy tree in one direction ---
function tree(root, kids, sz, pos, dir) {
  const extent = new Map();
  const breadth = (id) => (dir === 'down' ? sz(id).w : sz(id).h);
  const gap = dir === 'down' ? STYLE.sideGap : STYLE.vGap;
  const measureExtent = (id) => {
    const ks = kids.get(id) || [];
    let total = 0;
    for (const k of ks) total += measureExtent(k) + gap;
    total = ks.length ? total - gap : 0;
    const e = Math.max(breadth(id), total);
    extent.set(id, e); return e;
  };
  measureExtent(root);
  const place = (id, along, across) => {
    // along: coordinate in growth direction (x for right/left, y for down); across: start of band.
    const e = extent.get(id);
    const ks = kids.get(id) || [];
    const total = ks.reduce((s, k) => s + extent.get(k), 0) + Math.max(0, ks.length - 1) * gap;
    const b = breadth(id);
    if (dir === 'down') pos.set(id, { x: across + (e - b) / 2, y: along });
    else pos.set(id, { x: dir === 'left' ? along - sz(id).w : along, y: across + (e - b) / 2 });
    let c = across + (e - total) / 2;
    for (const k of ks) {
      const next = dir === 'down' ? along + sz(id).h + STYLE.downGap : dir === 'left' ? along - sz(id).w - STYLE.hGap : along + sz(id).w + STYLE.hGap;
      place(k, next, c);
      c += extent.get(k) + gap;
    }
  };
  place(root, 0, 0);
}

// --- classic balanced mind map: children alternate right and left of the root ---
function mindmap(root, kids, sz, pos) {
  const ks = kids.get(root) || [];
  const right = [], left = [];
  // Compute extents of each child's subtree in 'right' direction to balance sides by height.
  const h = (id) => { const sub = new Map(); tree(id, kids, sz, sub, 'right'); let a = Infinity, b = -Infinity; for (const [i, p] of sub) { a = Math.min(a, p.y); b = Math.max(b, p.y + sz(i).h); } return b - a; };
  const hs = ks.map(h);
  let rh = 0, lh = 0;
  ks.forEach((k, i) => { if (rh <= lh) { right.push(k); rh += hs[i] + STYLE.vGap; } else { left.push(k); lh += hs[i] + STYLE.vGap; } });
  const r = sz(root);
  pos.set(root, { x: 0, y: 0 });
  const side = (list, dir) => {
    const subs = list.map((k) => { const sub = new Map(); tree(k, kids, sz, sub, dir); let a = Infinity, b = -Infinity; for (const [i, p] of sub) { a = Math.min(a, p.y); b = Math.max(b, p.y + sz(i).h); } return { sub, top: a, height: b - a, id: k }; });
    const total = subs.reduce((s, x) => s + x.height, 0) + Math.max(0, subs.length - 1) * STYLE.vGap;
    let c = r.h / 2 - total / 2;
    for (const s of subs) {
      const dx = dir === 'right' ? r.w + STYLE.hGap : -STYLE.hGap;
      for (const [i, p] of s.sub) pos.set(i, { x: p.x + dx, y: p.y - s.top + c });
      c += s.height + STYLE.vGap;
    }
  };
  side(right, 'right'); side(left, 'left');
}

// --- radial: rings by depth, angular span proportional to leaf count, ring radii sized so nodes fit ---
function radial(root, kids, sz, pos) {
  const leaves = new Map();
  const count = (id) => { const ks = kids.get(id) || []; const c = ks.length ? ks.reduce((s, k) => s + count(k), 0) : 1; leaves.set(id, c); return c; };
  count(root);
  // Pass 1: angular spans and depths.
  const span = new Map(), mid = new Map(), depth = new Map();
  const byDepth = [];
  const assign = (id, d, a0, a1) => {
    span.set(id, a1 - a0); mid.set(id, (a0 + a1) / 2); depth.set(id, d);
    (byDepth[d] ||= []).push(id);
    let a = a0;
    for (const k of kids.get(id) || []) { const s = (a1 - a0) * (leaves.get(k) / leaves.get(id)); assign(k, d + 1, a, a + s); a += s; }
  };
  assign(root, 0, -Math.PI / 2, Math.PI * 1.5);
  // Pass 2: radius per depth so every node fits inside its own angular span and rings do not touch.
  const diag = (id) => Math.hypot(sz(id).w, sz(id).h);
  const radii = [0];
  for (let d = 1; d < byDepth.length; d++) {
    const prevMax = Math.max(...byDepth[d - 1].map((id) => sz(id).h));
    const curMax = Math.max(...byDepth[d].map((id) => sz(id).h));
    let r = radii[d - 1] + (d === 1 ? diag(root) / 2 : prevMax / 2) + curMax / 2 + STYLE.vGap * 3;
    for (const id of byDepth[d]) r = Math.max(r, (diag(id) + STYLE.vGap) / Math.max(1e-6, Math.min(span.get(id), Math.PI)));
    radii[d] = r;
  }
  for (const [id, d] of depth) {
    const s = sz(id);
    if (d === 0) { pos.set(id, { x: -s.w / 2, y: -s.h / 2 }); continue; }
    pos.set(id, { x: Math.cos(mid.get(id)) * radii[d] - s.w / 2, y: Math.sin(mid.get(id)) * radii[d] - s.h / 2 });
  }
}

// --- layered (Sugiyama-style) layout for flowcharts ---
function layered(map, vis, sizes, down) {
  const ids = vis.map((n) => n.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const out = new Map(ids.map(() => []));
  const inn = new Map(ids.map(() => []));
  const links = [];
  for (const n of vis) if (n.parent != null && idx.has(n.parent)) links.push([n.parent, n.id]);
  for (const e of map.edges) if (idx.has(e.from) && idx.has(e.to) && e.from !== e.to) links.push([e.from, e.to]);
  // Break cycles with a DFS: edges that point to a node on the current stack are dropped for layering.
  const adj = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of links) adj.get(a).push(b);
  const state = new Map();
  const keep = [];
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u)) {
      if (state.get(v) === 1) continue;
      keep.push([u, v]);
      if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.has(id)) dfs(id);
  const succ = new Map(ids.map((id) => [id, []])), pred = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of keep) { succ.get(a).push(b); pred.get(b).push(a); }
  // Longest-path layering.
  const layer = new Map();
  const depth = (u) => { if (layer.has(u)) return layer.get(u); const ps = pred.get(u); const d = ps.length ? Math.max(...ps.map(depth)) + 1 : 0; layer.set(u, d); return d; };
  for (const id of ids) depth(id);
  const nLayers = Math.max(...layer.values()) + 1;
  const layers = Array.from({ length: nLayers }, () => []);
  for (const id of ids) layers[layer.get(id)].push(id);
  // Barycenter ordering sweeps.
  const order = new Map();
  const reindex = () => layers.forEach((L) => L.forEach((id, i) => order.set(id, i)));
  reindex();
  for (let sweep = 0; sweep < 4; sweep++) {
    const downward = sweep % 2 === 0;
    for (let li = downward ? 1 : nLayers - 2; downward ? li < nLayers : li >= 0; downward ? li++ : li--) {
      const L = layers[li];
      const bary = new Map(L.map((id) => { const ns = (downward ? pred : succ).get(id); return [id, ns.length ? ns.reduce((s, v) => s + order.get(v), 0) / ns.length : order.get(id)]; }));
      L.sort((a, b) => bary.get(a) - bary.get(b) || idx.get(a) - idx.get(b));
      reindex();
    }
  }
  // Coordinates.
  const pos = new Map();
  const sz = (id) => sizes.get(id);
  let along = 0;
  const widths = [];
  for (const L of layers) {
    const total = L.reduce((s, id) => s + (down ? sz(id).w : sz(id).h), 0) + Math.max(0, L.length - 1) * STYLE.layerSideGap;
    widths.push(total);
  }
  const maxTotal = Math.max(...widths);
  layers.forEach((L, li) => {
    let across = (maxTotal - widths[li]) / 2;
    const thick = Math.max(...L.map((id) => (down ? sz(id).h : sz(id).w)));
    for (const id of L) {
      const s = sz(id);
      if (down) pos.set(id, { x: across, y: along + (thick - s.h) / 2 });
      else pos.set(id, { x: along + (thick - s.w) / 2, y: across });
      across += (down ? s.w : s.h) + STYLE.layerSideGap;
    }
    along += thick + STYLE.layerGap;
  });
  return pos;
}

/** Bounding box of positioned nodes. */
export function bounds(pos, sizes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, p] of pos) { const s = sizes.get(id); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
