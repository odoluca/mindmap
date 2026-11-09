import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../src/version.js';

test('version.json, package.json, index.html and src/version.js agree', () => {
  const vj = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
  const pj = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(vj, APP_VERSION);
  assert.equal(pj, APP_VERSION);
  assert.ok(html.includes(`src/main.js?v=${APP_VERSION}`));
});

test('api docs mention every operation', async () => {
  const M = await import('../src/model.js');
  const html = readFileSync(new URL('../api.html', import.meta.url), 'utf8');
  const txt = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
  for (const op of M.OP_NAMES) { assert.ok(html.includes(op), `api.html lacks ${op}`); assert.ok(txt.includes(op), `llms.txt lacks ${op}`); }
});
