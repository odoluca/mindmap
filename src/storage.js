// IndexedDB persistence for many maps, plus download/open helpers and preferences.
const DB = 'mindmap', STORE = 'maps';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function withStore(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const store = {
  async put(map) { return withStore('readwrite', (s) => s.put(map)); },
  async get(id) { const r = await withStore('readonly', (s) => s.get(id)); return r || null; },
  async remove(id) { return withStore('readwrite', (s) => s.delete(id)); },
  async all() { const r = await withStore('readonly', (s) => s.getAll()); return r || []; },
  async list() { return (await this.all()).map((m) => ({ id: m.id, name: m.name, kind: m.kind, nodes: m.nodes.length, updatedAt: m.updatedAt, createdAt: m.createdAt })).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)); },
};

export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

export const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem('mindmap:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('mindmap:' + key, JSON.stringify(value)); } catch { /* ignore */ } },
};

/** Cross-tab notifications so another tab (or an agent driving one) sees changes. */
export function channel(onMessage) {
  if (!('BroadcastChannel' in globalThis)) return { post() {} };
  const bc = new BroadcastChannel('mindmap');
  bc.onmessage = (ev) => onMessage(ev.data);
  return { post: (msg) => bc.postMessage(msg) };
}
