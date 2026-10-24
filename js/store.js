/* NOTE TRANSIT — 端末内保存（IndexedDB）
 * 'project' : 路線図・編集・共有設定（本文なし）
 * 'private' : 本人用の本文テキスト（共有・書き出しには既定で含めない）
 * 'thumbs'  : 見出し画像候補の縮小画像（表示したものだけ） */
(function (NT) {
  'use strict';
  const DB = 'note-transit';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDBが使えません'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of ['project', 'private', 'thumbs']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('IndexedDBを開けません'));
      r.onblocked = () => reject(new Error('IndexedDBが他のタブで使用中です'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let res;
      const req = fn(s);
      if (req) req.onsuccess = () => { res = req.result; };
      t.oncomplete = () => resolve(res);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('保存に失敗しました（容量不足の可能性）'));
    });
  }

  const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
  const put = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
  const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
  const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

  async function persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ignore */ }
    return false;
  }

  NT.store = { get, put, del, clear, persist };
})(globalThis.NT = globalThis.NT || {});
