// Map document model, validation, and the operation set shared by the editor, the window API and the URL API.
// Pure data: no DOM. Everything that edits a map goes through applyOps().

export const FORMAT_VERSION = 1;
export const KINDS = ['mindmap', 'flowchart'];
export const SHAPES = ['rounded', 'rect', 'ellipse', 'diamond', 'parallelogram', 'stadium', 'hexagon', 'cylinder', 'sticky', 'text'];
export const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
export const LAYOUTS = ['mindmap', 'right', 'down', 'radial', 'layered-down', 'layered-right', 'free'];
export const EDGE_STYLES = ['curved', 'straight', 'orthogonal'];
export const LOG_LIMIT = 500;

export function uid(prefix = 'n') {
  let s = '';
  while (s.length < 7) s += Math.random().toString(36).slice(2);
  return prefix + s.slice(0, 7);
}
export const now = () => new Date().toISOString();

const str = (v, fallback = '') => (v == null ? fallback : String(v));
const num = (v, fallback = 0) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const tags = (v) => (Array.isArray(v) ? v.map((t) => str(t).trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((t) => t.trim()).filter(Boolean) : []);

export function defaultSettings(kind) {
  const flow = kind === 'flowchart';
  return { layout: flow ? 'free' : 'mindmap', edgeStyle: flow ? 'orthogonal' : 'curved', showAuthors: true };
}

export function newMap({ name = 'Untitled map', kind = 'mindmap', author = 'user', root = 'Central idea' } = {}) {
  kind = oneOf(kind, KINDS, 'mindmap');
  const t = now();
  const map = {
    app: 'mindmap', version: FORMAT_VERSION, id: uid('m'), name: str(name, 'Untitled map'), kind,
    createdAt: t, updatedAt: t, settings: defaultSettings(kind), nodes: [], edges: [], notes: [], log: [], view: { x: 0, y: 0, scale: 1 },
  };
  if (kind === 'mindmap' && root) map.nodes.push(makeNode({ text: root, parent: null, author }, map));
  return map;
}

export function makeNode(src, map) {
  const t = now();
  const flow = map?.kind === 'flowchart';
  return {
    id: str(src.id) || uid('n'),
    text: str(src.text, 'New node'),
    notes: str(src.notes),
    shape: oneOf(src.shape, SHAPES, flow ? 'rect' : 'rounded'),
    color: oneOf(src.color, COLORS, 'default'),
    parent: src.parent == null ? null : str(src.parent),
    x: num(src.x), y: num(src.y),
    w: src.w == null ? null : Math.max(40, num(src.w)), h: src.h == null ? null : Math.max(24, num(src.h)),
    collapsed: !!src.collapsed,
    tags: tags(src.tags),
    author: str(src.author, 'user'), createdAt: str(src.createdAt, t), updatedAt: str(src.updatedAt, t),
  };
}

export function makeEdge(src) {
  return {
    id: str(src.id) || uid('e'),
    from: str(src.from), to: str(src.to),
    label: str(src.label),
    directed: src.directed == null ? true : !!src.directed,
    style: src.style == null ? null : oneOf(src.style, EDGE_STYLES, null),
    color: oneOf(src.color, COLORS, 'default'),
    author: str(src.author, 'user'), createdAt: str(src.createdAt, now()),
  };
}

export function makeNote(src) {
  return { id: str(src.id) || uid('c'), target: src.target == null ? null : str(src.target), text: str(src.text), author: str(src.author, 'user'), createdAt: str(src.createdAt, now()) };
}

/** Validate and repair a parsed JSON document. Throws when it is not a map at all. */
export function normalize(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Not a map object');
  if (!Array.isArray(j.nodes)) throw new Error('A map needs a "nodes" array');
  if (j.app && j.app !== 'mindmap') throw new Error(`Not a mindmap file (app: ${j.app})`);
  if (typeof j.version === 'number' && j.version > FORMAT_VERSION) throw new Error(`This file needs a newer app version (format ${j.version})`);
  const kind = oneOf(j.kind, KINDS, 'mindmap');
  const map = {
    app: 'mindmap', version: FORMAT_VERSION, id: str(j.id) || uid('m'), name: str(j.name, 'Untitled map'), kind,
    createdAt: str(j.createdAt, now()), updatedAt: str(j.updatedAt, now()),
    settings: { ...defaultSettings(kind), ...(j.settings && typeof j.settings === 'object' ? j.settings : {}) },
    nodes: [], edges: [], notes: [], log: [], view: { x: num(j.view?.x), y: num(j.view?.y), scale: Math.min(4, Math.max(0.1, num(j.view?.scale, 1))) },
  };
  map.settings.layout = oneOf(map.settings.layout, LAYOUTS, defaultSettings(kind).layout);
  map.settings.edgeStyle = oneOf(map.settings.edgeStyle, EDGE_STYLES, defaultSettings(kind).edgeStyle);
  const seen = new Set();
  for (const n of j.nodes) {
    if (!n || typeof n !== 'object') continue;
    const node = makeNode(n, map);
    if (seen.has(node.id)) node.id = uid('n');
    seen.add(node.id); map.nodes.push(node);
  }
  for (const n of map.nodes) if (n.parent != null && !seen.has(n.parent)) n.parent = null;
  breakParentCycles(map);
  if (Array.isArray(j.edges)) for (const e of j.edges) {
    if (!e || typeof e !== 'object') continue;
    const edge = makeEdge(e);
    if (seen.has(edge.from) && seen.has(edge.to)) map.edges.push(edge);
  }
  if (Array.isArray(j.notes)) for (const c of j.notes) {
    if (!c || typeof c !== 'object') continue;
    const note = makeNote(c);
    if (note.target == null || seen.has(note.target)) map.notes.push(note);
  }
  if (Array.isArray(j.log)) map.log = j.log.filter((l) => l && typeof l === 'object').slice(-LOG_LIMIT);
  return map;
}

function breakParentCycles(map) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  for (const n of map.nodes) {
    const trail = new Set([n.id]);
    let p = n.parent;
    while (p != null) {
      if (trail.has(p)) { n.parent = null; break; }
      trail.add(p); p = byId.get(p)?.parent ?? null;
    }
  }
}

export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- queries ----------

export function nodeById(map, id) { return map.nodes.find((n) => n.id === id) || null; }
export function childrenOf(map, id) { return map.nodes.filter((n) => n.parent === id); }
export function rootsOf(map) { return map.nodes.filter((n) => n.parent == null); }
export function isDescendant(map, id, ancestorId) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  let p = byId.get(id)?.parent;
  while (p != null) { if (p === ancestorId) return true; p = byId.get(p)?.parent; }
  return false;
}
export function subtreeIds(map, id) {
  const out = [id]; const stack = [id];
  while (stack.length) { const cur = stack.pop(); for (const c of map.nodes) if (c.parent === cur) { out.push(c.id); stack.push(c.id); } }
  return out;
}
export function depthOf(map, id) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  let d = 0, p = byId.get(id)?.parent;
  while (p != null) { d++; p = byId.get(p)?.parent; }
  return d;
}
/** Text search over nodes: substring match on text, notes and tags (case-insensitive). */
export function findNodes(map, query) {
  const q = str(query).trim().toLowerCase();
  if (!q) return map.nodes.slice();
  return map.nodes.filter((n) => n.text.toLowerCase().includes(q) || n.notes.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)));
}

/** Resolve a node reference: an id, or (if unique) a node's exact text. */
export function resolveNode(map, ref) {
  if (ref == null) return null;
  const id = str(ref);
  const byId = nodeById(map, id);
  if (byId) return byId;
  const byText = map.nodes.filter((n) => n.text === id);
  if (byText.length === 1) return byText[0];
  const ci = map.nodes.filter((n) => n.text.toLowerCase() === id.toLowerCase());
  if (ci.length === 1) return ci[0];
  return null;
}

// ---------- operations ----------

function need(map, ref, what = 'node') {
  const n = resolveNode(map, ref);
  if (!n) throw new Error(`Unknown ${what}: ${JSON.stringify(ref)}`);
  return n;
}
function log(map, ctx, op, summary, id) {
  if (ctx.silent) return;
  map.log.push({ at: now(), author: ctx.author, op, id: id ?? null, summary });
  if (map.log.length > LOG_LIMIT) map.log.splice(0, map.log.length - LOG_LIMIT);
}
function insertNode(map, node, index) {
  if (index == null || !Number.isFinite(+index)) { map.nodes.push(node); return; }
  const siblings = map.nodes.filter((n) => n.parent === node.parent);
  const target = siblings[Math.max(0, Math.min(siblings.length, Math.floor(+index)))];
  const at = target ? map.nodes.indexOf(target) : map.nodes.length;
  map.nodes.splice(at, 0, node);
}
function placeNear(map, node, parent) {
  if (parent) { node.x = parent.x + 220; node.y = parent.y + 60 * childrenOf(map, parent.id).length; }
  else { const n = map.nodes.length; node.x = 40 + (n % 5) * 40; node.y = 40 + n * 24; }
}
function defaultParent(map, op) {
  if (op.parent === undefined) return map.kind === 'mindmap' ? (rootsOf(map)[0] || null) : null;
  if (op.parent === null || op.parent === '') return null;
  return need(map, op.parent, 'parent');
}

const OPS = {
  addNode(map, op, ctx) {
    const parent = defaultParent(map, op);
    const node = makeNode({ ...op, parent: parent?.id ?? null, author: ctx.author }, map);
    if (op.id && nodeById(map, node.id)) throw new Error(`Node id already exists: ${node.id}`);
    if (op.x == null && op.y == null) placeNear(map, node, parent);
    insertNode(map, node, op.index);
    log(map, ctx, 'addNode', `Added "${node.text}"${parent ? ` under "${parent.text}"` : ''}`, node.id);
    return { id: node.id };
  },
  addTree(map, op, ctx) {
    const parent = defaultParent(map, op);
    const items = Array.isArray(op.nodes) ? op.nodes : op.tree ? [op.tree] : [];
    const ids = [];
    const walk = (items, parentNode) => {
      for (const item of items) {
        const src = typeof item === 'string' ? { text: item } : item || {};
        const node = makeNode({ ...src, id: undefined, parent: parentNode?.id ?? null, author: ctx.author }, map);
        if (src.x == null && src.y == null) placeNear(map, node, parentNode);
        map.nodes.push(node); ids.push(node.id);
        if (Array.isArray(src.children)) walk(src.children, node);
      }
    };
    walk(items, parent);
    log(map, ctx, 'addTree', `Added ${ids.length} node${ids.length === 1 ? '' : 's'}${parent ? ` under "${parent.text}"` : ''}`, parent?.id);
    return { ids };
  },
  updateNode(map, op, ctx) {
    const n = need(map, op.id);
    const before = n.text;
    if (op.text != null) n.text = str(op.text);
    if (op.notes != null) n.notes = str(op.notes);
    if (op.shape != null) n.shape = oneOf(op.shape, SHAPES, n.shape);
    if (op.color != null) n.color = oneOf(op.color, COLORS, n.color);
    if (op.tags != null) n.tags = tags(op.tags);
    if (op.collapsed != null) n.collapsed = !!op.collapsed;
    if (op.x != null) n.x = num(op.x, n.x);
    if (op.y != null) n.y = num(op.y, n.y);
    if (op.w !== undefined) n.w = op.w == null ? null : Math.max(40, num(op.w));
    if (op.h !== undefined) n.h = op.h == null ? null : Math.max(24, num(op.h));
    if (op.parent !== undefined) OPS.moveNode(map, { id: n.id, parent: op.parent, index: op.index }, { ...ctx, silent: true });
    else if (op.index != null) OPS.moveNode(map, { id: n.id, parent: n.parent, index: op.index }, { ...ctx, silent: true });
    n.updatedAt = now();
    const changed = Object.keys(op).filter((k) => !['op', 'id'].includes(k));
    const onlyGeometry = changed.length && changed.every((k) => ['x', 'y', 'w', 'h', 'collapsed'].includes(k));
    if (!onlyGeometry) log(map, ctx, 'updateNode', op.text != null && op.text !== before ? `Renamed "${before}" to "${n.text}"` : `Updated "${n.text}" (${changed.join(', ')})`, n.id);
    return { id: n.id };
  },
  moveNode(map, op, ctx) {
    const n = need(map, op.id);
    const parent = op.parent == null || op.parent === '' ? null : need(map, op.parent, 'parent');
    if (parent && (parent.id === n.id || isDescendant(map, parent.id, n.id))) throw new Error('Cannot move a node under its own descendant');
    map.nodes.splice(map.nodes.indexOf(n), 1);
    n.parent = parent?.id ?? null;
    insertNode(map, n, op.index);
    n.updatedAt = now();
    if (!ctx.silent) log(map, ctx, 'moveNode', `Moved "${n.text}"${parent ? ` under "${parent.text}"` : ' to top level'}`, n.id);
    return { id: n.id };
  },
  deleteNode(map, op, ctx) {
    const n = need(map, op.id);
    const cascade = op.cascade == null ? true : !!op.cascade;
    const ids = cascade ? subtreeIds(map, n.id) : [n.id];
    if (!cascade) for (const c of map.nodes) if (c.parent === n.id) c.parent = n.parent;
    const gone = new Set(ids);
    map.nodes = map.nodes.filter((x) => !gone.has(x.id));
    map.edges = map.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    map.notes = map.notes.filter((c) => c.target == null || !gone.has(c.target));
    log(map, ctx, 'deleteNode', `Deleted "${n.text}"${ids.length > 1 ? ` and ${ids.length - 1} descendants` : ''}`, n.id);
    return { ids };
  },
  addEdge(map, op, ctx) {
    const a = need(map, op.from), b = need(map, op.to);
    const edge = makeEdge({ ...op, from: a.id, to: b.id, author: ctx.author });
    if (op.id && map.edges.some((e) => e.id === edge.id)) throw new Error(`Edge id already exists: ${edge.id}`);
    map.edges.push(edge);
    log(map, ctx, 'addEdge', `Linked "${a.text}" ${edge.directed ? '->' : '--'} "${b.text}"${edge.label ? ` (${edge.label})` : ''}`, edge.id);
    return { id: edge.id };
  },
  updateEdge(map, op, ctx) {
    const e = map.edges.find((x) => x.id === str(op.id));
    if (!e) throw new Error(`Unknown edge: ${JSON.stringify(op.id)}`);
    if (op.label != null) e.label = str(op.label);
    if (op.directed != null) e.directed = !!op.directed;
    if (op.style !== undefined) e.style = op.style == null ? null : oneOf(op.style, EDGE_STYLES, e.style);
    if (op.color != null) e.color = oneOf(op.color, COLORS, e.color);
    if (op.from != null) e.from = need(map, op.from).id;
    if (op.to != null) e.to = need(map, op.to).id;
    log(map, ctx, 'updateEdge', `Updated link${e.label ? ` "${e.label}"` : ''}`, e.id);
    return { id: e.id };
  },
  deleteEdge(map, op, ctx) {
    const i = map.edges.findIndex((x) => x.id === str(op.id));
    if (i < 0) throw new Error(`Unknown edge: ${JSON.stringify(op.id)}`);
    const [e] = map.edges.splice(i, 1);
    log(map, ctx, 'deleteEdge', 'Removed a link', e.id);
    return { id: e.id };
  },
  addNote(map, op, ctx) {
    const target = op.target == null || op.target === '' ? null : need(map, op.target).id;
    const note = makeNote({ ...op, target, author: ctx.author });
    if (!note.text.trim()) throw new Error('A note needs text');
    map.notes.push(note);
    log(map, ctx, 'addNote', `Note${target ? ` on "${nodeById(map, target).text}"` : ''}: ${note.text.slice(0, 80)}`, note.id);
    return { id: note.id };
  },
  updateNote(map, op, ctx) {
    const c = map.notes.find((x) => x.id === str(op.id));
    if (!c) throw new Error(`Unknown note: ${JSON.stringify(op.id)}`);
    if (op.text != null) c.text = str(op.text);
    log(map, ctx, 'updateNote', 'Edited a note', c.id);
    return { id: c.id };
  },
  deleteNote(map, op, ctx) {
    const i = map.notes.findIndex((x) => x.id === str(op.id));
    if (i < 0) throw new Error(`Unknown note: ${JSON.stringify(op.id)}`);
    map.notes.splice(i, 1);
    log(map, ctx, 'deleteNote', 'Removed a note', str(op.id));
    return { id: str(op.id) };
  },
  setMap(map, op, ctx) {
    if (op.name != null) map.name = str(op.name) || map.name;
    if (op.kind != null) map.kind = oneOf(op.kind, KINDS, map.kind);
    if (op.settings && typeof op.settings === 'object') {
      const s = { ...map.settings, ...op.settings };
      s.layout = oneOf(s.layout, LAYOUTS, map.settings.layout);
      s.edgeStyle = oneOf(s.edgeStyle, EDGE_STYLES, map.settings.edgeStyle);
      map.settings = s;
    }
    if (op.view && typeof op.view === 'object') map.view = { x: num(op.view.x, map.view.x), y: num(op.view.y, map.view.y), scale: Math.min(4, Math.max(0.1, num(op.view.scale, map.view.scale))) };
    log(map, ctx, 'setMap', 'Changed map settings');
    return { id: map.id };
  },
  layout(map, op, ctx) {
    const mode = oneOf(op.mode, LAYOUTS, null);
    if (!mode) throw new Error(`Unknown layout mode: ${JSON.stringify(op.mode)}; use one of ${LAYOUTS.join(', ')}`);
    if (!op.once) map.settings.layout = mode;
    log(map, ctx, 'layout', op.once ? `Applied ${mode} layout once` : `Layout set to ${mode}`);
    return { relayout: mode };
  },
  replaceMap(map, op, ctx) {
    const src = normalize(op.map);
    for (const k of ['name', 'kind', 'settings', 'nodes', 'edges', 'notes', 'view']) map[k] = src[k];
    log(map, ctx, 'replaceMap', `Replaced the whole map (${map.nodes.length} nodes)`);
    return { id: map.id };
  },
};

export const OP_NAMES = Object.keys(OPS);

/**
 * Apply a list of operations atomically. Returns { ok: true, results } or { ok: false, error, index }.
 * The map is mutated only when every operation succeeds.
 */
export function applyOps(map, ops, { author = 'user', silent = false } = {}) {
  if (!Array.isArray(ops)) ops = [ops];
  const work = clone(map);
  const ctx = { author: str(author, 'user') || 'user', silent: !!silent };
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fn = op && OPS[op.op];
    if (!fn) return { ok: false, error: `Unknown operation at index ${i}: ${JSON.stringify(op?.op)}. Known: ${OP_NAMES.join(', ')}`, index: i };
    try { results.push(fn(work, op, ctx)); }
    catch (e) { return { ok: false, error: `${op.op} (index ${i}): ${e.message}`, index: i }; }
  }
  work.updatedAt = now();
  for (const k of Object.keys(work)) map[k] = work[k];
  return { ok: true, results };
}

// ---------- markdown outline ----------

export function toMarkdown(map) {
  const lines = [`# ${map.name}`, ''];
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const defShape = map.kind === 'flowchart' ? 'rect' : 'rounded';
  const walk = (parent, depth) => {
    for (const n of map.nodes) if (n.parent === parent) {
      const pad = '  '.repeat(depth);
      const meta = [];
      if (n.shape !== defShape) meta.push(`shape=${n.shape}`);
      if (n.color !== 'default') meta.push(`color=${n.color}`);
      if (n.tags.length) meta.push(`tags=${n.tags.join(',')}`);
      lines.push(`${pad}- ${n.text.replace(/\r?\n/g, ' ')}${meta.length ? ` {${meta.join(' ')}}` : ''}`);
      if (n.notes) for (const l of n.notes.split(/\r?\n/)) lines.push(`${pad}  > ${l}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  if (map.edges.length) {
    lines.push('', '## Links', '');
    for (const e of map.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (a && b) lines.push(`- ${a.text} ${e.directed ? '->' : '--'} ${b.text}${e.label ? `: ${e.label}` : ''}`);
    }
  }
  const mapNotes = map.notes.filter((c) => c.target == null);
  if (mapNotes.length) { lines.push('', '## Notes', ''); for (const c of mapNotes) lines.push(`- ${c.text} (${c.author})`); }
  return lines.join('\n') + '\n';
}

/** Parse a markdown or tab-indented outline into { name, tree, links, notes }. */
export function parseOutline(text) {
  const out = { name: null, tree: [], links: [], notes: [] };
  const stack = []; // { depth, item }
  let section = 'tree';
  let last = null;
  for (const raw of str(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const h = raw.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      const t = h[1].trim();
      if (/^links?$/i.test(t)) section = 'links';
      else if (/^notes?$/i.test(t)) section = 'notes';
      else if (out.name == null && !out.tree.length) { out.name = t; section = 'tree'; }
      else section = 'tree';
      continue;
    }
    const depth = raw.match(/^(\s*)/)[1].replace(/\t/g, '  ').length;
    const body = raw.trim();
    if (section === 'links') {
      const m = body.replace(/^[-*+]\s+/, '').match(/^(.+?)\s*(->|--|→|—)\s*(.+?)(?::\s*(.+))?$/);
      if (m) out.links.push({ from: m[1].trim(), to: m[3].trim(), label: (m[4] || '').trim(), directed: m[2] !== '--' && m[2] !== '—' });
      continue;
    }
    if (section === 'notes') { out.notes.push(body.replace(/^[-*+]\s+/, '').replace(/\s*\([^)]*\)$/, '')); continue; }
    if (body.startsWith('>')) { if (last) last.notes = (last.notes ? last.notes + '\n' : '') + body.replace(/^>\s?/, ''); continue; }
    const textPart = body.replace(/^([-*+]|\d+[.)])\s+/, '');
    const item = { text: textPart, notes: '', children: [] };
    const meta = textPart.match(/\s*\{([^}]*)\}\s*$/);
    if (meta) {
      item.text = textPart.slice(0, meta.index).trim();
      for (const kv of meta[1].split(/\s+/)) { const [k, v] = kv.split('='); if (k === 'shape') item.shape = v; else if (k === 'color') item.color = v; else if (k === 'tags') item.tags = v.split(','); }
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : out.tree).push(item);
    stack.push({ depth, item });
    last = item;
  }
  return out;
}

/** Build a complete map from an outline (markdown or indented text). */
export function mapFromOutline(text, { kind = 'mindmap', author = 'user', name } = {}) {
  const o = parseOutline(text);
  if (!o.tree.length) throw new Error('No outline items found');
  const map = newMap({ name: name || o.name || o.tree[0]?.text || 'Imported map', kind, author, root: null });
  const r = applyOps(map, [{ op: 'addTree', parent: null, nodes: o.tree }], { author });
  if (!r.ok) throw new Error(r.error);
  const ops = [];
  for (const l of o.links) { const a = resolveNode(map, l.from), b = resolveNode(map, l.to); if (a && b) ops.push({ op: 'addEdge', from: a.id, to: b.id, label: l.label, directed: l.directed }); }
  for (const t of o.notes) ops.push({ op: 'addNote', target: null, text: t });
  if (ops.length) applyOps(map, ops, { author });
  map.log = [];
  return map;
}

/** One-line summary of a map. */
export function describe(map) {
  return `${map.name} (${map.kind}, ${map.nodes.length} nodes, ${map.edges.length} links, ${map.notes.length} notes, id ${map.id})`;
}
