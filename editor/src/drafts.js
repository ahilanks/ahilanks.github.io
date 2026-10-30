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

/* ------------------------------------------------------------ folders + order
 * The menu's arrangement is ONE object, synced like a draft (newest `updated` wins):
 *   { folders: [{ id, name }], order: { folderId: [draftId…] }, updated }
 * A draft listed under a folder is in it (first listing wins); any other draft is
 * "Unsorted", newest first. The server files each draft under drafts/<folder id>/. */
const DEFAULT_FOLDERS = [{ id: 'technical', name: 'Technical' }, { id: 'non-technical', name: 'Non-technical' }]
function getLayout() {
  try {
    const l = JSON.parse(localStorage.getItem(LS.layout) || 'null')
    if (l && Array.isArray(l.folders)) return { folders: l.folders, order: l.order || {}, updated: +l.updated || 0 }
  } catch (e) {}
  return { folders: DEFAULT_FOLDERS.map((f) => ({ ...f })), order: {}, updated: 0 }
}
function putLayoutLocal(l) { localStorage.setItem(LS.layout, JSON.stringify(l)) }

/* --------------------------------------------------------------- reconcile */
// Fold server drafts/tombstones into local LS. Same policy as editor-server.py merge().
function reconcile(serverDrafts, serverDeleted, serverLayout) {
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
    if (!cur || up > (cur.updated || 0)) {
      if (cur && cur.created && !incoming.created) incoming.created = cur.created
      drafts[id] = incoming; changed = true
    } else if (incoming.created && !cur.created) { cur.created = incoming.created; changed = true } // `created` is sticky
    if (tomb && up > tomb) { delete deleted[id]; changed = true }      // re-created by a newer edit
  }
  // 3) apply tombstones to local drafts (a delete elsewhere removes it here too)
  for (const id in deleted) {
    if (drafts[id] && (drafts[id].updated || 0) <= deleted[id]) { delete drafts[id]; changed = true }
  }
  if (changed) { putDraftsLocal(drafts); putDeletedLocal(deleted) }
  // 4) the menu's folders + order: newest arrangement wins
  if (serverLayout && Array.isArray(serverLayout.folders) && (+serverLayout.updated || 0) > getLayout().updated) {
    putLayoutLocal(serverLayout); changed = true
  }
  return changed
}

/* -------------------------------------------------------------------- setup */
/**
 * Wire the drafts menu, scroll restore, and (non-sandbox) sync.
 *
 * @param {object} deps
 * @param {import('@tiptap/core').Editor} deps.editor  the live editor (unused directly today; kept for future hooks)
 * @param {() => object}     deps.currentSnapshot  snapshot of the live doc: {id,title,subtitle,body,footnotes,comments,closedComments,font,updated}
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
    if (!s.created && drafts[s.id]) s.created = drafts[s.id].created
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
    applySnapshot({ id, title: '', subtitle: '', body: '<p></p>', footnotes: '', font: CONFIG.font, created: Date.now(), updated: Date.now() })
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

  /* ---- menu UI: folders (collapsible), drag to file / reorder, ⌘/⇧-click to select several ---- */
  const COLLAPSED_KEY = 'editor.draftFoldersCollapsed' // per browser
  const getCollapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')) } catch (e) { return new Set() } }
  function setCollapsed(id, on) {
    const c = getCollapsed(); on ? c.add(id) : c.delete(id)
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...c])) } catch (e) {}
  }
  const selected = new Set() // draft ids picked with ⌘/⇧-click, dragged together
  let selAnchor = null       // the last plainly picked row, for ⇧-click ranges
  let drag = null            // { kind: 'drafts', ids } | { kind: 'folder', id }

  // the arrangement as shown: [{ id, name, ids }] — Unsorted (id '') first when it has drafts
  function sections() {
    const drafts = getDrafts(), deleted = getDeleted(), layout = getLayout()
    const alive = new Set(Object.values(drafts).filter((s) => s && s.id && !isTombstoned(s, deleted)).map((s) => s.id))
    const placed = new Set()
    const folders = layout.folders.map((f) => {
      const ids = (layout.order[f.id] || []).filter((id) => alive.has(id) && !placed.has(id))
      ids.forEach((id) => placed.add(id))
      return { id: f.id, name: f.name, ids }
    })
    const unsorted = [...alive].filter((id) => !placed.has(id)).sort((a, b) => (drafts[b].updated || 0) - (drafts[a].updated || 0))
    return unsorted.length ? [{ id: '', name: 'Unsorted', ids: unsorted }, ...folders] : folders
  }

  // Move draft `ids` into folder `to` ('' = Unsorted) just before draft `before` (null = at the end).
  function moveDrafts(ids, to, before) {
    const layout = getLayout()
    for (const f in layout.order) layout.order[f] = layout.order[f].filter((id) => !ids.includes(id))
    if (to) {
      const list = layout.order[to] || []
      const at = before ? list.indexOf(before) : -1
      list.splice(at < 0 ? list.length : at, 0, ...ids)
      layout.order[to] = list
    }
    saveLayout(layout)
  }
  function moveFolder(id, before) {
    const layout = getLayout()
    const f = layout.folders.find((x) => x.id === id)
    if (!f || id === before) return
    layout.folders = layout.folders.filter((x) => x.id !== id)
    const at = before ? layout.folders.findIndex((x) => x.id === before) : -1
    layout.folders.splice(at < 0 ? layout.folders.length : at, 0, f)
    saveLayout(layout)
  }
  function saveLayout(layout) {
    layout.updated = Date.now()
    putLayoutLocal(layout)
    if (!SANDBOX) SYNC.schedulePush()
    renderDraftsList()
  }

  function draftRow(s, curId, order) {
    const tmp = document.createElement('div')
    tmp.innerHTML = s.title || ''
    const title = (tmp.textContent || '').trim() || 'Untitled'
    const row = document.createElement('div')
    row.className = 'draft-item' + (s.id === curId ? ' active' : '') + (selected.has(s.id) ? ' selected' : '')
    row.dataset.id = s.id
    row.draggable = true
    const d = new Date(s.created || s.updated || Date.now())
    row.innerHTML =
      '<span class="d-title"></span><span class="d-date">' +
      d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) +
      '</span><button class="d-del" title="Delete">✕</button>'
    row.querySelector('.d-title').textContent = title
    row.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('d-del')) return
      if (ev.metaKey || ev.ctrlKey) { // pick / unpick without opening
        selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id)
        selAnchor = s.id
        renderDraftsList(); return
      }
      if (ev.shiftKey && selAnchor && order.includes(selAnchor)) { // a range, in menu order
        const [a, b] = [order.indexOf(selAnchor), order.indexOf(s.id)].sort((x, y) => x - y)
        order.slice(a, b + 1).forEach((id) => selected.add(id))
        renderDraftsList(); return
      }
      selected.clear(); selAnchor = s.id
      openDraft(s.id)
      $('draftsMenu').classList.add('hidden')
    })
    // delete needs a confirming second click ("✕" -> "Delete?"); auto-reverts after 3s
    const del = row.querySelector('.d-del')
    del.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (del.dataset.armed === '1') { deleteDraft(s.id); return }
      $('draftsList').querySelectorAll('.d-del').forEach((b) => {
        b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('confirm'); clearTimeout(b._t)
      })
      del.dataset.armed = '1'
      del.textContent = 'Delete?'
      del.classList.add('confirm')
      del._t = setTimeout(() => { del.dataset.armed = ''; del.textContent = '✕'; del.classList.remove('confirm') }, 3000)
    })
    row.addEventListener('dragstart', (e) => {
      // dragging a picked row takes every picked row along, in menu order
      const ids = selected.has(s.id) ? order.filter((id) => selected.has(id)) : [s.id]
      drag = { kind: 'drafts', ids }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', title)
      requestAnimationFrame(() => ids.forEach((id) => { const r = $('draftsList').querySelector('.draft-item[data-id="' + id + '"]'); if (r) r.classList.add('dragging') }))
    })
    return row
  }

  function renderDraftsList() {
    const list = $('draftsList')
    if (!list) return
    const drafts = getDrafts()
    const secs = sections()
    list.innerHTML = ''
    for (const id of [...selected]) if (!drafts[id]) selected.delete(id)
    const curId = getDocId()
    const collapsed = getCollapsed()
    const order = secs.flatMap((sec) => sec.ids) // menu order, for ⇧-click ranges
    secs.forEach((sec) => {
      const box = document.createElement('div')
      box.className = 'd-folder' + (sec.id ? '' : ' unsorted') + (collapsed.has(sec.id || '-') ? ' collapsed' : '')
      box.dataset.folder = sec.id
      const head = document.createElement('div')
      head.className = 'd-fhead'
      head.draggable = !!sec.id
      head.innerHTML = '<svg class="d-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="d-fname"></span><span class="d-count">' + (sec.ids.length || '') + '</span>'
      head.querySelector('.d-fname').textContent = sec.name
      head.addEventListener('click', () => { setCollapsed(sec.id || '-', !box.classList.contains('collapsed')); box.classList.toggle('collapsed') })
      head.addEventListener('dragstart', (e) => {
        drag = { kind: 'folder', id: sec.id }
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', sec.name)
        requestAnimationFrame(() => box.classList.add('dragging'))
      })
      box.appendChild(head)
      const rows = document.createElement('div')
      rows.className = 'd-frows'
      sec.ids.forEach((id) => rows.appendChild(draftRow(drafts[id], curId, order)))
      if (!sec.ids.length) rows.innerHTML = '<div class="d-empty">Drag drafts here</div>'
      box.appendChild(rows)
      list.appendChild(box)
    })
  }

  /* drop targets: a row (before/after it), a folder's heading or empty space (into it), or
     — while dragging a folder — another folder (before/after it) */
  function dropTarget(e) {
    const list = $('draftsList')
    const box = e.target.closest && e.target.closest('.d-folder')
    if (!drag || !box || !list.contains(box)) return null
    if (drag.kind === 'folder') {
      if (box.classList.contains('unsorted') || box.dataset.folder === drag.id) return null
      const r = box.getBoundingClientRect()
      const after = e.clientY > r.top + Math.min(r.height, 40) / 2
      const next = after ? box.nextElementSibling : box
      return { el: box, cls: after ? 'drop-after' : 'drop-before', apply: () => moveFolder(drag.id, next ? next.dataset.folder : null) }
    }
    const folder = box.dataset.folder
    const row = e.target.closest('.draft-item')
    if (row && !drag.ids.includes(row.dataset.id)) {
      const r = row.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      let next = after ? row.nextElementSibling : row
      while (next && drag.ids.includes(next.dataset.id)) next = next.nextElementSibling
      return { el: row, cls: after ? 'drop-after' : 'drop-before', apply: () => moveDrafts(drag.ids, folder, next && next.dataset.id ? next.dataset.id : null) }
    }
    if (row) return null
    // the heading puts them first; anywhere else in the folder, last
    const first = e.target.closest('.d-fhead') ? box.querySelector('.draft-item:not(.dragging)') : null
    return { el: box, cls: 'drop-into', apply: () => { if (folder) setCollapsed(folder, false); moveDrafts(drag.ids, folder, first ? first.dataset.id : null) } }
  }
  let shown = null
  const clearMark = () => { if (shown) shown.el.classList.remove(shown.cls); shown = null }
  const draftsListEl = $('draftsList')
  if (draftsListEl) {
    draftsListEl.addEventListener('dragover', (e) => {
      const t = dropTarget(e)
      if (!t) { clearMark(); return }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (shown && shown.el === t.el && shown.cls === t.cls) return
      clearMark(); t.el.classList.add(t.cls); shown = t
    })
    draftsListEl.addEventListener('dragleave', (e) => { if (!draftsListEl.contains(e.relatedTarget)) clearMark() })
    draftsListEl.addEventListener('drop', (e) => {
      const t = dropTarget(e)
      clearMark()
      if (!t) return
      e.preventDefault()
      t.apply()
      drag = null
    })
    draftsListEl.addEventListener('dragend', () => {
      clearMark(); drag = null
      draftsListEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
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
        return reconcile(data.drafts || {}, data.deleted || {}, data.layout)
      } catch (e) { return false }
    },
    schedulePush() {
      if (SANDBOX) return
      clearTimeout(this.pushTimer)
      this.pushTimer = setTimeout(() => this.push(), 600)
    },
    async push() {
      if (SANDBOX) return
      clearTimeout(this.pushTimer) // a direct push supersedes any scheduled one
      try {
        const r = await fetch(this.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drafts: getDrafts(), deleted: getDeleted(), layout: getLayout() }),
        })
        if (!r.ok) return
        const data = await r.json()
        if (reconcile(data.drafts || {}, data.deleted || {}, data.layout)) renderDraftsList()
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
  let lastBackupOk = false
  let backupBtn = null
  // Back up now (the cloud button's push), e.g. before restoring an old version → ok?
  async function backup() {
    if (SANDBOX || !backupBtn || !backupBtn.onclick) return false
    lastBackupOk = false
    await backupBtn.onclick()
    return lastBackupOk
  }
  function setupPushStatus() {
    const btn = $('pushBtn'), txt = $('pushText')
    backupBtn = btn
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
    let pushing = false // a manual backup is in flight → nothing may repaint the label until it resolves
    const render = () => {
      if (pushing || !status) return
      const t = status.last_push_ts ? ago(status.last_push_ts) : 'not backed up'
      // cloud icon goes green when everything is pushed (up to date), gray otherwise
      if (btn) btn.classList.toggle('synced', status.ok !== false && !!status.synced)
      if (txt) txt.title = status.detail || ''
      if (status.ok === false) show('⚠ ' + t, '#c0392b')
      else show(t, '#999') // just "6m ago", gray
    }
    const refresh = async () => {
      try { status = await (await fetch('/api/push', { cache: 'no-store' })).json() }
      catch (e) { return } // server may be old/offline — keep whatever we showed
      render()
    }
    if (btn) btn.onclick = async () => {
      if (pushing) return
      pushing = true
      btn.disabled = true
      show('Backing up…', '#999')
      try {
        // Flush the live doc all the way to the server FIRST, so the commit that's about
        // to happen contains what's on screen right now — not the state from the last
        // debounced sync. Skip the save when nothing changed since the last one: saving
        // anyway would bump `updated` for identical content, forcing a no-op commit and
        // resorting the drafts list under the user. Then POST /api/push, which runs
        // git add/commit/push synchronously and only responds when the push has actually
        // finished. "Backing up…" holds for that whole span: the 30s/60s interval
        // repaints are gated on `pushing`, so the label can't fall back to the previous
        // time mid-push.
        const s = currentSnapshot()
        const drafts = getDrafts()
        const cur = drafts[s.id]
        const dirty = !cur || cur.title !== s.title || cur.subtitle !== s.subtitle ||
                      cur.body !== s.body || cur.footnotes !== s.footnotes || cur.font !== s.font ||
                      JSON.stringify(cur.comments || {}) !== JSON.stringify(s.comments || {}) ||
                      JSON.stringify(cur.closedComments || []) !== JSON.stringify(s.closedComments || [])
        if (!s.created && cur) s.created = cur.created
        if (dirty) { drafts[s.id] = s; putDraftsLocal(drafts); localStorage.setItem(LS.current, s.id) }
        await SYNC.push()
        const res = await (await fetch('/api/push', { method: 'POST' })).json()
        if (res && res.ok === false) {
          show('⚠ backup failed', '#c0392b')
          if (txt) txt.title = res.detail || ''
        } else {
          lastBackupOk = true
          show('Backed up ✓', '#3e8e53')
          if (btn) btn.classList.add('synced')
        }
      } catch (e) {
        show('⚠ backup error (is the server running?)', '#c0392b')
      }
      await new Promise((r) => setTimeout(r, 1800)) // let the result register before it ages into "just now"
      btn.disabled = false
      pushing = false
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

  return { renderDraftsList, openDraft, newDraft, deleteDraft, schedulePush: () => SYNC.schedulePush(), restoreScrollPos, backup }
}
