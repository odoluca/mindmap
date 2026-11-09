import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

test('newMap creates a mind map with a root', () => {
  const m = M.newMap({ name: 'T' });
  assert.equal(m.kind, 'mindmap');
  assert.equal(m.nodes.length, 1);
  assert.equal(m.nodes[0].parent, null);
  assert.equal(m.settings.layout, 'mindmap');
  const f = M.newMap({ kind: 'flowchart' });
  assert.equal(f.nodes.length, 0);
  assert.equal(f.settings.layout, 'free');
});

test('addNode defaults to the root parent in a mind map and accepts text references', () => {
  const m = M.newMap({ root: 'Root' });
  const r = M.applyOps(m, [{ op: 'addNode', text: 'A' }, { op: 'addNode', text: 'B', parent: 'A' }], { author: 'claude' });
  assert.ok(r.ok, r.error);
  const a = M.resolveNode(m, 'A'), b = M.resolveNode(m, 'B');
  assert.equal(a.parent, m.nodes[0].id);
  assert.equal(b.parent, a.id);
  assert.equal(b.author, 'claude');
  assert.equal(m.log.length, 2);
  assert.equal(m.log[1].author, 'claude');
});

test('applyOps is atomic: a failing op leaves the map unchanged', () => {
  const m = M.newMap();
  const before = JSON.stringify(m);
  const r = M.applyOps(m, [{ op: 'addNode', text: 'ok' }, { op: 'addNode', text: 'bad', parent: 'nope' }]);
  assert.equal(r.ok, false);
  assert.equal(r.index, 1);
  assert.match(r.error, /Unknown parent/);
  assert.equal(JSON.stringify(m), before);
});

test('addTree builds nested nodes and returns ids in order', () => {
  const m = M.newMap();
  const r = M.applyOps(m, [{ op: 'addTree', nodes: [{ text: 'A', children: ['A1', { text: 'A2', children: ['A2a'] }] }, 'B'] }]);
  assert.ok(r.ok);
  assert.equal(r.results[0].ids.length, 5);
  assert.equal(M.childrenOf(m, M.resolveNode(m, 'A').id).length, 2);
  assert.equal(M.resolveNode(m, 'A2a').parent, M.resolveNode(m, 'A2').id);
});

test('moveNode refuses cycles and reorders siblings', () => {
  const m = M.newMap();
  M.applyOps(m, [{ op: 'addTree', nodes: [{ text: 'A', children: ['A1', 'A2'] }, 'B'] }]);
  const a = M.resolveNode(m, 'A'), a1 = M.resolveNode(m, 'A1');
  const bad = M.applyOps(m, [{ op: 'moveNode', id: a.id, parent: a1.id }]);
  assert.equal(bad.ok, false);
  const ok = M.applyOps(m, [{ op: 'moveNode', id: 'A2', parent: a.id, index: 0 }]);
  assert.ok(ok.ok);
  assert.deepEqual(M.childrenOf(m, a.id).map((n) => n.text), ['A2', 'A1']);
  const up = M.applyOps(m, [{ op: 'updateNode', id: 'B', parent: 'A' }]);
  assert.ok(up.ok);
  assert.equal(M.resolveNode(m, 'B').parent, a.id);
});

test('deleteNode cascades by default and removes dangling edges and notes', () => {
  const m = M.newMap();
  M.applyOps(m, [{ op: 'addTree', nodes: [{ text: 'A', children: ['A1'] }, 'B'] }]);
  M.applyOps(m, [{ op: 'addEdge', from: 'A1', to: 'B', label: 'x' }, { op: 'addNote', target: 'A1', text: 'hello' }, { op: 'addNote', text: 'map note' }]);
  assert.equal(m.edges.length, 1); assert.equal(m.notes.length, 2);
  const r = M.applyOps(m, [{ op: 'deleteNode', id: 'A' }]);
  assert.ok(r.ok);
  assert.equal(r.results[0].ids.length, 2);
  assert.equal(m.edges.length, 0);
  assert.equal(m.notes.length, 1);
  // non-cascading delete reparents children
  M.applyOps(m, [{ op: 'addTree', nodes: [{ text: 'C', children: ['C1'] }] }]);
  M.applyOps(m, [{ op: 'deleteNode', id: 'C', cascade: false }]);
  assert.equal(M.resolveNode(m, 'C1').parent, m.nodes[0].id);
});

test('normalize repairs broken references and cycles', () => {
  const m = M.normalize({ nodes: [{ id: 'a', text: 'a', parent: 'b' }, { id: 'b', text: 'b', parent: 'a' }, { id: 'c', text: 'c', parent: 'zzz' }, { id: 'a', text: 'dup' }], edges: [{ from: 'a', to: 'nope' }, { from: 'a', to: 'b' }], notes: [{ target: 'q', text: 'x' }, { text: 'ok' }], kind: 'weird', settings: { layout: 'bogus' } });
  assert.equal(m.nodes.length, 4);
  assert.equal(m.kind, 'mindmap');
  assert.equal(m.settings.layout, 'mindmap');
  assert.equal(m.edges.length, 1);
  assert.equal(m.notes.length, 1);
  assert.ok(m.nodes.some((n) => n.parent == null));
  assert.equal(M.nodeById(m, 'c').parent, null);
  assert.equal(new Set(m.nodes.map((n) => n.id)).size, 4);
  assert.throws(() => M.normalize({ foo: 1 }), /nodes/);
  assert.throws(() => M.normalize({ app: 'atlas-studio', nodes: [] }), /Not a mindmap/);
});

test('markdown outline round trip keeps structure, notes, meta and links', () => {
  const m = M.newMap({ name: 'Plan', root: 'Plan' });
  M.applyOps(m, [{ op: 'addTree', nodes: [{ text: 'Work', color: 'blue', children: [{ text: 'Write', notes: 'two\nlines', tags: ['a', 'b'] }, { text: 'Test', shape: 'diamond' }] }, 'Rest'] }]);
  M.applyOps(m, [{ op: 'addEdge', from: 'Write', to: 'Test', label: 'then' }, { op: 'addEdge', from: 'Rest', to: 'Work', directed: false }, { op: 'addNote', text: 'overall' }]);
  const md = M.toMarkdown(m);
  assert.match(md, /^# Plan\n/);
  assert.match(md, /\n- Plan\n  - Work \{color=blue\}\n    - Write \{tags=a,b\}\n      > two\n      > lines\n    - Test \{shape=diamond\}\n  - Rest\n/);
  assert.match(md, /## Links\n\n- Write -> Test: then\n- Rest -- Work\n/);
  const back = M.mapFromOutline(md);
  assert.equal(back.name, 'Plan');
  assert.equal(back.nodes.length, 5);
  const w = M.resolveNode(back, 'Write');
  assert.equal(w.notes, 'two\nlines');
  assert.deepEqual(w.tags, ['a', 'b']);
  assert.equal(M.resolveNode(back, 'Test').shape, 'diamond');
  assert.equal(M.resolveNode(back, 'Work').color, 'blue');
  assert.equal(M.resolveNode(back, 'Work').parent, M.resolveNode(back, 'Plan').id);
  assert.equal(back.edges.length, 2);
  assert.equal(back.edges[0].label, 'then');
  assert.equal(back.edges[1].directed, false);
  assert.equal(back.notes.length, 1);
});

test('parseOutline accepts tab-indented plain text without bullets', () => {
  const o = M.parseOutline('Root\n\tChild 1\n\t\tGrand\n\tChild 2\n');
  assert.equal(o.tree.length, 1);
  assert.equal(o.tree[0].children.length, 2);
  assert.equal(o.tree[0].children[0].children[0].text, 'Grand');
});

test('geometry-only updates are not logged; silent applies skip the log', () => {
  const m = M.newMap();
  M.applyOps(m, [{ op: 'addNode', text: 'A' }]);
  const n = m.log.length;
  M.applyOps(m, [{ op: 'updateNode', id: 'A', x: 10, y: 20 }]);
  assert.equal(m.log.length, n);
  M.applyOps(m, [{ op: 'updateNode', id: 'A', color: 'red' }], { silent: true });
  assert.equal(m.log.length, n);
  M.applyOps(m, [{ op: 'updateNode', id: 'A', color: 'blue' }]);
  assert.equal(m.log.length, n + 1);
});

test('layout op sets the mode or reports a one-off relayout', () => {
  const m = M.newMap();
  const r1 = M.applyOps(m, [{ op: 'layout', mode: 'radial' }]);
  assert.ok(r1.ok); assert.equal(m.settings.layout, 'radial');
  const r2 = M.applyOps(m, [{ op: 'layout', mode: 'down', once: true }]);
  assert.ok(r2.ok); assert.equal(m.settings.layout, 'radial'); assert.equal(r2.results[0].relayout, 'down');
  assert.equal(M.applyOps(m, [{ op: 'layout', mode: 'nope' }]).ok, false);
  assert.equal(M.applyOps(m, [{ op: 'frobnicate' }]).ok, false);
});

test('setMap grid is clamped and normalized', () => {
  const m = M.newMap({ kind: 'flowchart' });
  assert.equal(m.settings.grid, 0);
  assert.ok(M.applyOps(m, [{ op: 'setMap', settings: { grid: 25 } }]).ok);
  assert.equal(m.settings.grid, 25);
  M.applyOps(m, [{ op: 'setMap', settings: { grid: 'abc' } }]);
  assert.equal(m.settings.grid, 0);
  M.applyOps(m, [{ op: 'setMap', settings: { grid: 9999 } }]);
  assert.equal(m.settings.grid, 200);
  const n = M.normalize({ nodes: [], settings: { grid: -5 } });
  assert.equal(n.settings.grid, 0);
});
