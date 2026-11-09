import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import { computeSizes, computeLayout, estimateMeasure, wrapText, visibleNodes, bounds, STYLE } from '../src/layout.js';
import { routeEdge, shapePath, buildSvg, collectLinks } from '../src/render.js';

function demo(kind = 'mindmap') {
  const m = M.newMap({ kind, root: 'Root' });
  const parent = kind === 'mindmap' ? undefined : null;
  M.applyOps(m, [{ op: 'addTree', parent, nodes: [
    { text: 'Alpha', children: ['A one', 'A two with a somewhat longer label that wraps', { text: 'A three', children: ['deep 1', 'deep 2'] }] },
    { text: 'Beta', children: ['B one'] },
    { text: 'Gamma' }, { text: 'Delta', children: ['D1', 'D2', 'D3'] },
  ] }]);
  return m;
}

function overlaps(pos, sizes) {
  const ids = [...pos.keys()];
  let count = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = pos.get(ids[i]), as = sizes.get(ids[i]), b = pos.get(ids[j]), bs = sizes.get(ids[j]);
    if (a.x < b.x + bs.w && b.x < a.x + as.w && a.y < b.y + bs.h && b.y < a.y + as.h) count++;
  }
  return count;
}

test('wrapText respects the width and keeps explicit newlines', () => {
  const lines = wrapText('one two three four five six seven eight nine ten', 100, '500 14px x', estimateMeasure);
  assert.ok(lines.length > 2);
  for (const l of lines) assert.ok(estimateMeasure(l, '500 14px x') <= 100 || !l.includes(' '));
  assert.deepEqual(wrapText('a\nb', 500, '14px x', estimateMeasure), ['a', 'b']);
});

for (const mode of ['mindmap', 'right', 'down', 'radial', 'layered-down', 'layered-right']) {
  test(`${mode} layout places every visible node without overlaps`, () => {
    const m = demo();
    const sizes = computeSizes(m, estimateMeasure);
    const pos = computeLayout(m, mode, sizes);
    assert.equal(pos.size, m.nodes.length);
    for (const p of pos.values()) { assert.ok(Number.isFinite(p.x)); assert.ok(Number.isFinite(p.y)); }
    assert.equal(overlaps(pos, sizes), 0, `${mode} has overlapping nodes`);
    const b = bounds(pos, sizes);
    assert.ok(b.w > 100 && b.h > 50);
  });
}

test('mindmap layout puts children on both sides of the root', () => {
  const m = demo();
  const sizes = computeSizes(m, estimateMeasure);
  const pos = computeLayout(m, 'mindmap', sizes);
  const root = m.nodes[0];
  const rp = pos.get(root.id);
  const kids = M.childrenOf(m, root.id).map((k) => pos.get(k.id).x - rp.x);
  assert.ok(kids.some((x) => x > 0) && kids.some((x) => x < 0));
});

test('collapsed branches are hidden and free layout keeps coordinates', () => {
  const m = demo();
  const alpha = M.resolveNode(m, 'Alpha');
  M.applyOps(m, [{ op: 'updateNode', id: alpha.id, collapsed: true }]);
  const vis = visibleNodes(m);
  assert.equal(vis.length, m.nodes.length - 5);
  assert.ok(vis.some((n) => n.id === alpha.id));
  const sizes = computeSizes(m, estimateMeasure);
  const pos = computeLayout(m, 'free', sizes);
  assert.equal(pos.size, vis.length);
  for (const n of vis) assert.deepEqual(pos.get(n.id), { x: n.x, y: n.y });
});

test('layered layout handles cycles and floating nodes', () => {
  const m = demo('flowchart');
  const a = M.resolveNode(m, 'Alpha'), g = M.resolveNode(m, 'Gamma');
  M.applyOps(m, [{ op: 'addEdge', from: g.id, to: a.id }, { op: 'addEdge', from: 'deep 1', to: g.id }, { op: 'addNode', parent: null, text: 'floating' }]);
  const sizes = computeSizes(m, estimateMeasure);
  const pos = computeLayout(m, 'layered-down', sizes);
  assert.equal(pos.size, m.nodes.length);
  assert.equal(overlaps(pos, sizes), 0);
});

test('edges are routed in every style with finite geometry and arrow directions', () => {
  const m = demo();
  const sizes = computeSizes(m, estimateMeasure);
  const pos = computeLayout(m, 'right', sizes);
  const links = collectLinks(m, new Set(pos.keys()));
  assert.equal(links.length, m.nodes.length - 1);
  for (const style of ['curved', 'straight', 'orthogonal']) for (const l of links) {
    const r = routeEdge(l.from, l.to, style, pos, sizes, 'horizontal');
    assert.ok(r && /^M/.test(r.d) && !/NaN/.test(r.d), `${style} route`);
    assert.ok(Math.abs(Math.hypot(r.dir.x, r.dir.y) - 1) < 1e-6);
  }
  const self = routeEdge(links[0].from, links[0].from, 'curved', pos, sizes);
  assert.ok(self && !/NaN/.test(self.d));
});

test('shape paths and SVG export are well formed', () => {
  for (const s of M.SHAPES) { const d = shapePath(s, 120, 40); assert.ok(s === 'text' ? d === '' : /^M/.test(d) && !/NaN/.test(d), s); }
  const m = demo();
  M.applyOps(m, [{ op: 'addEdge', from: 'Gamma', to: 'B one', label: 'see & also <this>' }]);
  const sizes = computeSizes(m, estimateMeasure);
  const pos = computeLayout(m, 'mindmap', sizes);
  const svg = buildSvg(m, pos, sizes);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('see &amp; also &lt;this&gt;'));
  assert.equal((svg.match(/<text /g) || []).length, m.nodes.length + 1);
  assert.ok(!svg.includes('NaN'));
});

test('explicit node sizes are honoured', () => {
  const m = M.newMap();
  M.applyOps(m, [{ op: 'addNode', text: 'fixed', w: 300, h: 90 }]);
  const sizes = computeSizes(m, estimateMeasure);
  const s = sizes.get(M.resolveNode(m, 'fixed').id);
  assert.equal(s.w, 300); assert.equal(s.h, 90);
  assert.ok(STYLE.maxWidth > 0);
});
