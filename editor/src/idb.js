/* idb.js — a tiny IndexedDB media store for uploaded video blobs.
 *
 * Video bytes are too big to keep in the draft body (which is base64-inlined HTML in
 * localStorage), so they live here keyed by a short id. The draft persists only the
 * `vid`; the blob is looked up on load and turned back into a blob: URL (those don't
 * survive a reload). Records are { blob, ext }. Promisified over the callback API.
 */

const DB_NAME = 'ahilan-editor-media'
const STORE = 'media'

let _dbPromise = null
function open() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _dbPromise
}

/** Store a media record. @param {string} id @param {{blob:Blob, ext:string}} rec */
export async function setMedia(id, rec) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Load a media record. @param {string} id @returns {Promise<{blob:Blob, ext:string}|undefined>} */
export async function getMedia(id) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const rq = tx.objectStore(STORE).get(id)
    rq.onsuccess = () => resolve(rq.result)
    rq.onerror = () => reject(rq.error)
  })
}
