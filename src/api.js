// The programmatic surface: window.mindmap for scripts and browser-driving agents, and the URL hash commands.
import { APP_VERSION } from './version.js?v=0.2.0';
import * as M from './model.js?v=0.2.0';
import { store } from './storage.js?v=0.2.0';

function decodeValue(raw) {
  // Accept URL-encoded text/JSON, or base64url (optionally prefixed with "b64:").
  let s = raw;
  try { s = decodeURIComponent(raw); } catch { /* keep raw */ }
  const tryJson = (t) => { try { return { json: JSON.parse(t) }; } catch { return null; } };
  const j = tryJson(s);
  if (j) return { json: j.json, text: s };
  const b = s.startsWith('b64:') ? s.slice(4) : s;
  if (/^[A-Za-z0-9_\-+/=]+$/.test(b)) {
    try {
      const bin = atob(b.replace(/-/g, '+').replace(/_/g, '/'));
      const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      const jj = tryJson(text);
      return { json: jj?.json, text };
    } catch { /* not base64 */ }
  }
  return { json: undefined, text: s };
}

export function encodeForUrl(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return 'b64:' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const HELP = `mindmap API (window.mindmap) v${APP_VERSION}
Maps live in this browser. The open map is the one all calls act on unless an id is given.
  listMaps() -> Promise<[{id,name,kind,nodes,updatedAt}]>
  getMap() -> map JSON (nodes, edges, notes, log)      getMapById(id) -> Promise<map>
  openMap(id), createMap({name, kind:'mindmap'|'flowchart', root}), importMap(json), deleteMap(id)   (all Promises)
  apply(ops, {author}) -> {ok, results} | {ok:false, error}   atomic; ops is an array of {op, ...}
  Operations: addNode{text,parent,shape,color,notes,tags,index,x,y}  addTree{parent,nodes:[{text,children:[...]}]}
              updateNode{id,...fields}  moveNode{id,parent,index}  deleteNode{id,cascade}
              addEdge{from,to,label,directed,style,color}  updateEdge{id,...}  deleteEdge{id}
              addNote{target,text}  updateNote{id,text}  deleteNote{id}
              setMap{name,kind,settings:{layout,edgeStyle,grid}}  layout{mode,once}  replaceMap{map}
  Node refs (parent, from, to, id, target) accept an id or a unique node text.
  Shortcuts: addNode(text, parent, extra), addTree(parent, nodes), link(from, to, label), note(text, target),
             getNode(ref), find(query), children(ref), roots(), outline() -> markdown, addOutline(text, parent),
             describe(), select(ids), centerOn(id), fit(), undo(), redo(), on('change'|'open'|'select', fn)
  Shapes: ${M.SHAPES.join(', ')}.  Colours: ${M.COLORS.join(', ')}.  Layouts: ${M.LAYOUTS.join(', ')}.
URL commands (one per link, value may be URL-encoded JSON/text or b64:<base64url>):
  #ops=[...]  #outline=<markdown>  #import=<map json>  #open=<map id>  #cmd={"ops":[...],"author":"claude"}
Full reference: api.html`;

export function installApi(editor) {
  let defaultAuthor = 'assistant';
  const need = () => { if (!editor.map) throw new Error('No map is open'); return editor.map; };
  const apply = (ops, opts = {}) => editor.apply(ops, { author: opts.author || defaultAuthor, silent: !!opts.silent });
  const first = (r) => { if (!r.ok) throw new Error(r.error); return r.results[0]; };
  const api = {
    version: APP_VERSION,
    get author() { return defaultAuthor; }, set author(v) { defaultAuthor = String(v || 'assistant'); },
    help() { return HELP; },
    listMaps: () => store.list(),
    getMap: () => M.clone(need()),
    getMapById: async (id) => { const m = await store.get(id); return m ? M.normalize(m) : null; },
    currentMapId: () => editor.map?.id ?? null,
    openMap: (id) => editor.openMap(id).then(M.clone),
    createMap: (opts = {}) => editor.createMap({ author: defaultAuthor, ...opts }).then(M.clone),
    importMap: (json, opts) => editor.importMap(json, opts).then(M.clone),
    deleteMap: (id) => editor.deleteMap(id),
    apply,
    addNode: (text, parent, extra = {}) => first(apply([{ op: 'addNode', text, parent, ...extra }], extra)).id,
    addTree: (parent, nodes, opts) => first(apply([{ op: 'addTree', parent, nodes }], opts)).ids,
    updateNode: (id, fields, opts) => first(apply([{ op: 'updateNode', id, ...fields }], opts)).id,
    deleteNode: (id, cascade = true, opts) => first(apply([{ op: 'deleteNode', id, cascade }], opts)).ids,
    link: (from, to, label = '', extra = {}) => first(apply([{ op: 'addEdge', from, to, label, ...extra }], extra)).id,
    note: (text, target = null, opts) => first(apply([{ op: 'addNote', text, target }], opts)).id,
    getNode: (ref) => { const n = M.resolveNode(need(), ref); return n ? M.clone(n) : null; },
    find: (query) => M.clone(M.findNodes(need(), query)),
    children: (ref) => { const n = M.resolveNode(need(), ref); return n ? M.clone(M.childrenOf(need(), n.id)) : []; },
    roots: () => M.clone(M.rootsOf(need())),
    notes: (ref) => { const m = need(); if (ref == null) return M.clone(m.notes); const n = M.resolveNode(m, ref); return n ? M.clone(m.notes.filter((c) => c.target === n.id)) : []; },
    log: (limit = 50) => M.clone(need().log.slice(-limit)),
    outline: () => M.toMarkdown(need()),
    addOutline: (text, parent, opts) => { const o = M.parseOutline(text); return first(apply([{ op: 'addTree', parent, nodes: o.tree }], opts)).ids; },
    describe: () => M.describe(need()),
    select: (ids) => editor.select(Array.isArray(ids) ? ids : [ids]),
    selection: () => ({ nodes: [...editor.selected], edge: editor.selectedEdge }),
    centerOn: (id) => editor.centerOn(M.resolveNode(need(), id)?.id),
    fit: () => editor.fit(),
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    on: (event, fn) => editor.on(event, fn),
    encodeForUrl,
    linkFor: (command, value) => `${location.origin}${location.pathname}#${command}=${encodeForUrl(value)}`,
    ops: M.OP_NAMES, shapes: M.SHAPES, colors: M.COLORS, layouts: M.LAYOUTS, edgeStyles: M.EDGE_STYLES,

    /** Process location.hash. Returns true when a map was opened or created by the command. */
    async handleHash() {
      const hash = location.hash.slice(1);
      if (!hash) return false;
      const eq = hash.indexOf('=');
      const key = (eq < 0 ? hash : hash.slice(0, eq)).toLowerCase();
      const raw = eq < 0 ? '' : hash.slice(eq + 1);
      const known = ['ops', 'outline', 'import', 'map', 'json', 'open', 'cmd', 'md'];
      if (!known.includes(key)) return false;
      history.replaceState(null, '', location.pathname + location.search);
      const { json, text } = decodeValue(raw);
      let opened = false;
      try {
        let cmd = key === 'cmd' ? json : key === 'ops' ? { ops: json } : key === 'open' ? { open: text } : key === 'outline' || key === 'md' ? { outline: text } : { map: json };
        if (!cmd || typeof cmd !== 'object') throw new Error('Could not decode the command in the URL');
        const author = cmd.author || 'link';
        if (cmd.open) { await editor.openMap(String(cmd.open)); opened = true; }
        if (cmd.map) { const m = await editor.importMap(cmd.map); editor.toast(`Imported "${m.name}" from link`); opened = true; }
        if (cmd.outline) {
          if (cmd.parent !== undefined || (editor.map && cmd.append)) { if (!editor.map) await editor.openDefault(); api.addOutline(cmd.outline, cmd.parent, { author }); editor.toast('Outline added from link'); }
          else { const m = M.mapFromOutline(cmd.outline, { author, kind: cmd.kind, name: cmd.name }); await store.put(m); editor.loadMap(m); editor.toast(`Created "${m.name}" from link`); opened = true; }
        }
        if (cmd.ops) {
          if (!editor.map) await editor.openDefault();
          const r = apply(cmd.ops, { author });
          if (!r.ok) throw new Error(r.error);
          editor.toast(`Applied ${Array.isArray(cmd.ops) ? cmd.ops.length : 1} operation(s) from link`);
        }
      } catch (e) { console.error(e); editor.toast('Link command failed: ' + e.message, 6000); }
      return opened;
    },
  };
  window.mindmap = api;
  editor.api = api;
  return api;
}
