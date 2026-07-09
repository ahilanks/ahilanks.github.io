/* drafts.js — persistence surface: the drafts menu, per-draft scroll restore, and
 * cross-device server sync. Ported from the v1 editor's STATE/DRAFTS/AUTOSAVE +
 * SYNC + push-status blocks, adapted to the v2 module split (main.js owns the live
 * editor/doc; this module owns the LS.drafts / LS.current / LS.deleted / LS.scroll
 * stores, the menu UI, and the /api/drafts reconcile).
 *
 * *** SANDBOX SAFETY: every network path (the /api/drafts GET/PUT, the background
 * poll, and the /api/push backup UI) is gated behind `if (!SANDBOX)`. In sandbox
 * mode NOTHING hits the server — the menu, localStorage and scroll restore still
 * work, but sync is completely inert, so the real v1 drafts are never touched. ***
 *
 * The reconcile below is byte-for-byte the same policy as editor-server.py's merge():
 * per draft id the newest `updated` wins, deletes are tombstones (never a hard
 * delete), and content is never silently dropped unless a tombstone supersedes it.
 */

import { CONFIG, LS, SANDBOX } from './config.js'
import { $, debounce, uid } from './dom.js'

/* ------------------------------------------------------------- LS accessors */
function getDrafts() { try { return JSON.parse(localStorage.getItem(LS.drafts) || '{}') } catch (e) { return {} } }
function putDraftsLocal(d) { localStorage.setItem(LS.drafts, JSON.stringify(d)) }
// Tombstones: { id: deletedAtMs }. A delete is recorded here (never a bare hard
// delete) so it can propagate across devices without a stale device resurrecting
// the draft — while a genuinely newer edit (updated > deletedAt) still wins.
function getDeleted() { try { return JSON.parse(localStorage.getItem(LS.deleted) || '{}') } catch (e) { return {} } }
function putDeletedLocal(d) { localStorage.setItem(LS.deleted, JSON.stringify(d)) }

// A draft is considered tombstoned-away when a tombstone at/after its version exists.
// Mirrors merge() step 3, so a draft re-created by a newer edit is NOT hidden.
function isTombstoned(s, deleted) {
  const ts = deleted[s.id] || 0
  return ts && (s.updated || 0) <= ts
}

/* --------------------------------------------------------------- reconcile */
// Fold server drafts/tombstones into local LS. Same policy as editor-server.py merge().
function reconcile(serverDrafts, serverDeleted) {
  const drafts = getDrafts()
  const deleted = getDeleted()
  let changed = false
  // 1) merge tombstones (newest deletion wins)
  for (const id in serverDeleted) {
    const ts = +serverDeleted[id] || 0
    if (!(id in deleted) || ts > deleted[id]) { deleted[id] = ts; changed = true }
  }
  // 2) merge incoming drafts (newest edit wins), honoring tombstones
  for (const id in serverDrafts) {
    const incoming = serverDrafts[id]
    if (!incoming || typeof incoming !== 'object') continue
    const up = incoming.updated || 0
    const tomb = deleted[id] || 0
    if (tomb && up <= tomb) continue                                   // deleted at/after this version -> skip
    const cur = drafts[id]
    if (!cur || up > (cur.updated || 0)) { drafts[id] = incoming; changed = true }
    if (tomb && up > tomb) { delete deleted[id]; changed = true }      // re-created by a newer edit
  }
  // 3) apply tombstones to local drafts (a delete elsewhere removes it here too)
  for (const id in deleted) {
    if (drafts[id] && (drafts[id].updated || 0) <= deleted[id]) { delete drafts[id]; changed = true }
  }
  if (changed) { putDraftsLocal(drafts); putDeletedLocal(deleted) }
  return changed
}

/* -------------------------------------------------------------------- setup */
/**
 * Wire the drafts menu, scroll restore, and (non-sandbox) sync.
 *
 * @param {object} deps
 * @param {import('@tiptap/core').Editor} deps.editor  the live editor (unused directly today; kept for future hooks)
 * @param {() => object}     deps.currentSnapshot  snapshot of the live doc: {id,title,subtitle,body,footnotes,font,updated}
 * @param {(s:object)=>void} deps.applySnapshot   load a snapshot into the editor UI (title/subtitle/body/footnotes/placeholders/toolbar). Must NOT set doc.id and should use emitUpdate:false.
 * @param {() => string}     deps.getDocId        current doc id
 * @param {(id:string)=>void} deps.setDocId       set the current doc id
 * @returns {{ renderDraftsList:Function, openDraft:Function, newDraft:Function, deleteDraft:Function, schedulePush:Function, restoreScrollPos:Function }}
 */
export function setupDrafts({ editor, currentSnapshot, applySnapshot, getDocId, setDocId }) {
  const scrollArea = $('scrollArea')
  let didInitialRefresh = false // guards the one-time boot re-apply after the first server pull

  /* ---- persist the live draft to LS (used at switch/new boundaries; main.js
     also autosaves on edit — same shape, so either path is safe) ---- */
  function saveDraft() {
    const s = currentSnapshot()
    const drafts = getDrafts()
    drafts[s.id] = s
    putDraftsLocal(drafts)
    localStorage.setItem(LS.current, s.id)
    if (!SANDBOX) SYNC.schedulePush()
    return s
  }

  /* ---- per-draft scroll memory: keep you where you were on reload/switch ---- */
  const saveScrollPos = debounce(() => {
    if (!scrollArea) return
    try {
      const m = JSON.parse(localStorage.getItem(LS.scroll) || '{}')
      m[getDocId()] = scrollArea.scrollTop
      localStorage.setItem(LS.scroll, JSON.stringify(m))
    } catch (e) {}
  }, 150)
  function restoreScrollPos(id) {
    if (!scrollArea) return
    try {
      const m = JSON.parse(localStorage.getItem(LS.scroll) || '{}')
      const y = m[id || getDocId()] || 0
      requestAnimationFrame(() => { scrollArea.scrollTop = y })
    } catch (e) {}
  }
  if (scrollArea) scrollArea.addEventListener('scroll', saveScrollPos)

  /* ---- draft lifecycle ---- */
  function newDraft() {
    saveDraft() // flush the outgoing draft
    const id = uid()
    setDocId(id)
    applySnapshot({ id, title: '', subtitle: '', body: '<p></p>', footnotes: '', font: CONFIG.font, updated: Date.now() })
    saveDraft() // persist the blank draft (also sets LS.current = id)
    restoreScrollPos(id)
    const t = $('docTitle'); if (t) t.focus()
    renderDraftsList()
  }

  function openDraft(id) {
    const drafts = getDrafts()
    if (!drafts[id]) return
    saveDraft() // flush the outgoing draft under the CURRENT id first
    setDocId(id)
    applySnapshot(drafts[id])
    localStorage.setItem(LS.current, id)
    restoreScrollPos(id)
    renderDraftsList()
  }

  // Deletion writes a TOMBSTONE (never a bare hard delete) so it syncs and can't
  // be resurrected by a stale server copy; the local copy is dropped to match.
  function deleteDraft(id) {
    const drafts = getDrafts()
    delete drafts[id]
    putDraftsLocal(drafts)
    const deleted = getDeleted(); deleted[id] = Date.now(); putDeletedLocal(deleted)
    if (!SANDBOX) SYNC.schedulePush()
    if (id === getDocId()) {
      const remaining = Object.values(drafts).sort((a, b) => (b.updated || 0) - (a.updated || 0))
      if (remaining.length) {
        setDocId(remaining[0].id)
        applySnapshot(remaining[0])
        localStorage.setItem(LS.current, remaining[0].id)
        restoreScrollPos(remaining[0].id)
      } else {
        newDraft()
        return
      }
    }
    renderDraftsList()
  }

  /* ---- menu UI ---- */
  function renderDraftsList() {
    const list = $('draftsList')
    if (!list) return
    const drafts = getDrafts()
    const deleted = getDeleted()
    list.innerHTML = ''
    const items = Object.values(drafts)
      .filter((s) => s && s.id && !isTombstoned(s, deleted))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    if (!items.length) {
      list.innerHTML = '<div style="padding:0.6rem;color:var(--faint);font-size:0.85rem;">No drafts yet</div>'
      return
    }
    const curId = getDocId()
    items.forEach((s) => {
      const tmp = document.createElement('div')
      tmp.innerHTML = s.title || ''
      const title = (tmp.textContent || '').trim() || 'Untitled'
      const row = document.createElement('div')
      row.className = 'draft-item' + (s.id === curId ? ' active' : '')
      const d = new Date(s.updated || Date.now())
      row.innerHTML =
        '<span class="d-title"></span><span class="d-date">' +
        d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        '</span><button class="d-del" title="Delete">✕</button>'
      row.querySelector('.d-title').textContent = title
      row.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('d-del')) return
        openDraft(s.id)
        $('draftsMenu').classList.add('hidden')
      })
      // delete needs a confirming second click ("✕" -> "Delete?"); auto-reverts after 3s
      const del = row.querySelector('.d-del')
      del.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (del.dataset.armed === '1') { deleteDraft(s.id); return }
        list.querySelectorAll('.d-del').forEach((b) => {
          b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('confirm'); clearTimeout(b._t)
        })
        del.dataset.armed = '1'
        del.textContent = 'Delete?'
        del.classList.add('confirm')
        del._t = setTimeout(() => { del.dataset.armed = ''; del.textContent = '✕'; del.classList.remove('confirm') }, 3000)
      })
      list.appendChild(row)
    })
  }

  const draftsBtn = $('draftsBtn')
  const draftsMenu = $('draftsMenu')
  if (draftsBtn && draftsMenu) {
    draftsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      draftsMenu.classList.toggle('hidden')
      if (!draftsMenu.classList.contains('hidden')) renderDraftsList()
    })
  }
  const newDraftBtn = $('newDraftBtn')
  if (newDraftBtn) newDraftBtn.addEventListener('click', () => { newDraft(); draftsMenu && draftsMenu.classList.add('hidden') })
  // dismiss the menu on outside click (button uses 'click'; this uses 'mousedown')
  document.addEventListener('mousedown', (e) => {
    if (!draftsMenu || draftsMenu.classList.contains('hidden')) return
    if (draftsMenu.contains(e.target)) return
    if (draftsBtn && (e.target === draftsBtn || draftsBtn.contains(e.target))) return
    draftsMenu.classList.add('hidden')
  })

  /* -------------------------------------------------------- server SYNC ----
     ALL of this is inert while SANDBOX is true (see the guards). At cutover it
     becomes the cross-device merge: pull on load/focus/poll, push after edits,
     reconcile both directions with the server's identical merge(). */
  const SYNC = {
    url: '/api/drafts',
    pushTimer: null,
    started: false,
    async pull() {
      if (SANDBOX) return false
      try {
        const r = await fetch(this.url, { cache: 'no-store' })
        if (!r.ok) return false
        const data = await r.json()
        return reconcile(data.drafts || {}, data.deleted || {})
      } catch (e) { return false }
    },
    schedulePush() {
      if (SANDBOX) return
      clearTimeout(this.pushTimer)
      this.pushTimer = setTimeout(() => this.push(), 600)
    },
    async push() {
      if (SANDBOX) return
      try {
        const r = await fetch(this.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drafts: getDrafts(), deleted: getDeleted() }),
        })
        if (!r.ok) return
        const data = await r.json()
        if (reconcile(data.drafts || {}, data.deleted || {})) renderDraftsList()
      } catch (e) {}
    },
    start() {
      if (SANDBOX || this.started) return
      this.started = true
      const tick = async () => { if (await this.pull()) renderDraftsList() }
      setInterval(tick, CONFIG.syncPollMs)                              // catch other devices' edits
      document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
      window.addEventListener('focus', tick)
    },
  }

  /* ------ push-to-GitHub backup status (#pushBtn / #pushText) — also inert in
     sandbox so nothing hits the server ------ */
  function setupPushStatus() {
    const btn = $('pushBtn'), txt = $('pushText')
    if (SANDBOX) { if (txt) txt.textContent = ''; return }               // *** no server contact in sandbox ***
    const show = (msg, color) => { if (txt) { txt.textContent = msg; txt.style.color = color || '#999' } }
    const ago = (ts) => {
      const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))
      if (m < 1) return 'just now'
      if (m < 60) return m + 'm ago'
      const h = Math.floor(m / 60)
      if (h < 24) return h + 'h ago'
      return Math.floor(h / 24) + 'd ago'
    }
    let status = null
    const render = () => {
      if (!status) return
      const t = status.last_push_ts ? ago(status.last_push_ts) : 'not backed up'
      // cloud icon goes green when everything is pushed (up to date), gray otherwise
      if (btn) btn.classList.toggle('synced', status.ok !== false && !!status.synced)
      if (status.ok === false) show('⚠ ' + t, '#c0392b')
      else show(t, '#999') // just "6m ago", gray
    }
    const refresh = async () => {
      try { status = await (await fetch('/api/push', { cache: 'no-store' })).json() }
      catch (e) { return } // server may be old/offline — keep whatever we showed
      render()
    }
    if (btn) btn.onclick = async () => {
      show('Backing up…', '#999'); btn.disabled = true
      try { await fetch('/api/push', { method: 'POST' }) }
      catch (e) { show('⚠ backup error (is the server running?)', '#c0392b') }
      btn.disabled = false
      refresh()
    }
    refresh()
    setInterval(refresh, 30000) // server auto-pushes every ~5 min
    setInterval(render, 60000)  // keep the "Xm ago" aging between polls
  }

  /* -------------------------------------------------------------- init ---- */
  renderDraftsList()
  restoreScrollPos(getDocId())
  setupPushStatus()
  if (!SANDBOX) {
    // fold in other devices' drafts, then keep syncing in the background
    SYNC.pull().then((changed) => {
      if (changed) renderDraftsList()
      // First pull after boot only: main.js's load() painted the doc from LOCAL
      // storage, which can be stale (e.g. an old v1 copy left in this browser).
      // Refresh the visible doc to the server's reconciled version now, while
      // nothing has been edited yet, so a stale copy can't be re-saved over the
      // canonical one. Later background polls intentionally do NOT re-apply (that
      // would clobber an in-progress edit) — this runs exactly once.
      if (!didInitialRefresh) {
        didInitialRefresh = true
        const cur = getDrafts()[getDocId()]
        if (cur && !editor.isFocused) applySnapshot(cur)
      }
    })
    SYNC.start()
    SYNC.schedulePush() // seed this device's existing drafts up to the shared store
  }

  return { renderDraftsList, openDraft, newDraft, deleteDraft, schedulePush: () => SYNC.schedulePush(), restoreScrollPos }
}
