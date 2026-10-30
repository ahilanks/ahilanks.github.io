/* versions.js — History → Versions: the draft as it was at each push to the private
 * drafts repo (the cloud button, plus the server's auto-backups), and what changed since.
 *
 * The list comes from GET /api/versions (git log of the draft's file, following renames).
 * Picking one opens a diff view against the draft as it is now: paragraphs compared as
 * blocks, changed ones word by word — struck red for what's gone since, green for what's
 * new — with unchanged stretches folded. Restore backs up the current draft first (a
 * push, so it is itself a version), then loads the old one in its place.
 */

import { $, toast, escapeHtml } from './dom.js'

/* ------------------------------------------------------------------ text model */
// A link travels through the text model as one token, LS text LM href LE (private-use
// sentinels), so adding, removing or re-pointing a link counts as a change, and linkify()
// turns it back into a link once the diff is rendered.
const LS = '\uE000', LM = '\uE001', LE = '\uE002'
const linksToText = (root) => root.querySelectorAll('a[href]').forEach((a) => {
  a.replaceWith(LS + a.textContent.replace(/[\uE000-\uE002]/g, '') + LM + a.getAttribute('href').replace(/[\uE000-\uE002]/g, '') + LE)
})
// rendered (already escaped) diff HTML → real links: web links open in a new tab, others
// (in-page #section links) just show where they point on hover
const linkify = (html) => html.replace(/\uE000([^\uE001]*)\uE001([^\uE002]*)\uE002/g, (_, text, href) => {
  const h = href.replace(/"/g, '&quot;')
  return /^(https?:|mailto:)/i.test(href)
    ? '<a class="vd-link" href="' + h + '" target="_blank" rel="noopener" title="' + h + '">' + text + '</a>'
    : '<span class="vd-link" title="' + h + '">' + text + '</span>'
})

// A draft's HTML → its blocks as { kind, text }: paragraphs, headings, list items, quotes,
// equations and figures, with inline math as $tex$, footnote markers as [n] and links as tokens.
function blocksOf(html, footnotes) {
  const d = new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html')
  d.querySelectorAll('span.math-inline').forEach((el) => { el.textContent = '$' + (el.getAttribute('data-tex') || '') + '$' })
  linksToText(d.body)
  let n = 0
  d.querySelectorAll('sup.fn-ref').forEach((el) => { el.textContent = '[' + (++n) + ']' })
  const out = []
  const clean = (t) => t.replace(/\s+/g, ' ').trim()
  const walk = (el, ctx) => {
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase()
      if (/^h[1-6]$/.test(tag)) out.push({ kind: tag, text: clean(c.textContent) })
      else if (tag === 'p') { const t = clean(c.textContent); if (t) out.push({ kind: ctx || 'p', text: t }) }
      else if (tag === 'li') { if (c.querySelector('p')) walk(c, 'li'); else out.push({ kind: 'li', text: clean(c.textContent) }) }
      else if (tag === 'blockquote') walk(c, 'quote')
      else if (tag === 'ul' || tag === 'ol') walk(c, ctx)
      else if (tag === 'pre') out.push({ kind: 'pre', text: c.textContent.trim() })
      else if (c.classList.contains('math-block')) out.push({ kind: 'eq', text: '$$' + (c.getAttribute('data-tex') || '') + '$$' })
      else if (tag === 'figure') {
        const cap = c.querySelector('figcaption')
        out.push({ kind: 'fig', text: (c.querySelector('video') ? '[Video]' : '[Image]') + (cap && clean(cap.textContent) ? ' ' + clean(cap.textContent) : '') })
      } else if (tag === 'hr') out.push({ kind: 'hr', text: '———' })
      else walk(c, ctx)
    }
  }
  walk(d.body, '')
  if (footnotes) {
    const f = new DOMParser().parseFromString('<ol>' + footnotes + '</ol>', 'text/html')
    const items = [...f.querySelectorAll('li')].filter((li) => !li.classList.contains('fn-orphan'))
    if (items.length) out.push({ kind: 'h3', text: 'Footnotes' })
    items.forEach((li, i) => {
      li.querySelectorAll('span.math-inline').forEach((el) => { el.textContent = '$' + (el.getAttribute('data-tex') || '') + '$' })
      linksToText(li)
      const body = li.querySelector('.fn-body') || li
      out.push({ kind: 'fn', text: '[' + (i + 1) + '] ' + clean(body.textContent) })
    })
  }
  return out.filter((b) => b.text)
}
const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/\s+/g, ' ').trim() }

/* ------------------------------------------------------------------ diff */
// Longest-common-subsequence alignment of two sequences under `eq` → ops in order:
// { op: '=', a, b } | { op: '-', a } | { op: '+', b }
function align(A, B, eq) {
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = eq(A[i], B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const ops = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && eq(A[i], B[j])) { ops.push({ op: '=', a: A[i], b: B[j] }); i++; j++ }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { ops.push({ op: '+', b: B[j] }); j++ }
    else { ops.push({ op: '-', a: A[i] }); i++ }
  }
  return ops
}
const TOKEN = /\uE000[^\uE002]*\uE002|\$[^$]*\$|[\p{L}\p{N}'’]+|\s+|[^\s\p{L}\p{N}]/gu
const words = (t) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))
function similar(a, b) {
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return false
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.max(A.size, B.size) >= 0.4
}
// one block's words: old → new, as HTML with <del>/<ins>
function wordDiff(a, b) {
  const ops = align(a.match(TOKEN) || [], b.match(TOKEN) || [], (x, y) => x === y)
  let html = '', del = '', ins = ''
  const flush = () => {
    if (del) html += '<del>' + escapeHtml(del) + '</del>'
    if (ins) html += '<ins>' + escapeHtml(ins) + '</ins>'
    del = ins = ''
  }
  for (const o of ops) {
    if (o.op === '=') {
      // a lone space between two changes stays inside them, so edits read as phrases
      if (/^\s+$/.test(o.a) && (del || ins)) { del += o.a; ins += o.a; continue }
      flush(); html += escapeHtml(o.a)
    } else if (o.op === '-') del += o.a
    else ins += o.b
  }
  flush()
  return html
}

// old blocks vs new → rows { kind, html, changed }
function diffRows(oldB, newB) {
  const ops = align(oldB, newB, (x, y) => x.kind === y.kind && x.text === y.text)
  const rows = []
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === '=') { rows.push({ kind: ops[k].b.kind, html: escapeHtml(ops[k].b.text), changed: false }); k++; continue }
    // a run of removed + added blocks: pair up the ones that are the same paragraph, edited
    const dels = [], adds = []
    while (k < ops.length && ops[k].op !== '=') { (ops[k].op === '-' ? dels : adds).push(ops[k].op === '-' ? ops[k].a : ops[k].b); k++ }
    let d = 0
    for (const b of adds) {
      const at = dels.findIndex((x, i) => i >= d && similar(x.text, b.text))
      if (at >= 0) {
        for (; d < at; d++) rows.push({ kind: dels[d].kind, html: '<del>' + escapeHtml(dels[d].text) + '</del>', changed: true, gone: true })
        rows.push({ kind: b.kind, html: wordDiff(dels[at].text, b.text), changed: true })
        d = at + 1
      } else rows.push({ kind: b.kind, html: '<ins>' + escapeHtml(b.text) + '</ins>', changed: true, added: true })
    }
    for (; d < dels.length; d++) rows.push({ kind: dels[d].kind, html: '<del>' + escapeHtml(dels[d].text) + '</del>', changed: true, gone: true })
  }
  return rows
}

/* ------------------------------------------------------------------ UI */
const KIND = { manual: 'Pushed', auto: 'Auto-backup' }
function when(ts) {
  const d = new Date(ts * 1000)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/**
 * @param o.getDocId, o.currentSnapshot, o.applySnapshot, o.scheduleSave  from main.js
 * @param o.backup   drafts.backup — push the current draft (→ ok)
 */
export function setupVersions({ getDocId, currentSnapshot, applySnapshot, scheduleSave, backup }) {
  const view = $('versionView')
  let showAuto = false
  let cache = { id: null, at: 0, list: [] }
  let current = null // the version on screen

  async function list(force) {
    const id = getDocId()
    if (!force && cache.id === id && Date.now() - cache.at < 30000) return cache.list
    const r = await fetch('/api/versions?draft=' + encodeURIComponent(id), { cache: 'no-store' })
    if (!r.ok) throw new Error('Couldn’t load versions (' + r.status + ')')
    cache = { id, at: Date.now(), list: (await r.json()).versions || [] }
    return cache.list
  }

  // History's Versions tab
  async function renderInto(el, onPick) {
    el.innerHTML = '<div class="cl-empty">Loading versions…</div>'
    let all
    try { all = await list() } catch (e) { el.innerHTML = '<div class="cl-empty">' + escapeHtml(e.message) + ' — is the editor server running?</div>'; return }
    el.textContent = ''
    const manual = all.filter((v) => v.kind === 'manual')
    const autos = all.length - manual.length
    const shown = showAuto || !manual.length ? all : manual
    if (!all.length) { el.innerHTML = '<div class="cl-empty">No versions yet. Each time you back up (the cloud button) — and every few minutes automatically — a version is saved.</div>'; return }
    if (autos) {
      const t = document.createElement('label')
      t.className = 'vr-toggle'
      t.innerHTML = '<input type="checkbox"' + (showAuto || !manual.length ? ' checked' : '') + (manual.length ? '' : ' disabled') + '> Show auto-backups (' + autos + ')'
      t.querySelector('input').addEventListener('change', (e) => { showAuto = e.target.checked; renderInto(el, onPick) })
      t.addEventListener('mousedown', (e) => e.stopPropagation())
      el.appendChild(t)
    }
    let day = ''
    shown.forEach((v, i) => {
      const d = new Date(v.ts * 1000).toDateString()
      if (d !== day) {
        day = d
        const h = document.createElement('div')
        h.className = 'cl-section'
        h.textContent = new Date(v.ts * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
        el.appendChild(h)
      }
      const row = document.createElement('div')
      row.className = 'cl-row cl-open vr-row'
      row.innerHTML = '<div class="cl-top"><span class="cl-kind vr-kind-' + v.kind + '">' + (KIND[v.kind] || 'Saved') + '</span>' +
        '<span class="cl-when">' + new Date(v.ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
        (all[0] === v ? ' · latest' : '') + '</span><span class="cl-jump">Compare</span></div>'
      row.addEventListener('click', () => { onPick(); open(v) })
      el.appendChild(row)
    })
  }

  async function fetchVersion(v, full) {
    const r = await fetch('/api/version?draft=' + encodeURIComponent(getDocId()) + '&sha=' + v.sha + (full ? '&full=1' : ''), { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'Couldn’t load that version')
    return j
  }

  function rowHTML(r) {
    const cls = 'vd-b vd-' + r.kind + (r.changed ? ' vd-ch' : '') + (r.gone ? ' vd-gone' : '') + (r.added ? ' vd-added' : '')
    return '<div class="' + cls + '">' + r.html + '</div>'
  }
  function render(old, onlyChanges) {
    const snap = currentSnapshot()
    const rows = diffRows(blocksOf(old.body, old.footnotes), blocksOf(snap.body, snap.footnotes))
    const nChanged = rows.filter((r) => r.changed).length
    const body = view.querySelector('.vd-body')
    const oldTitle = plain(old.title), newTitle = plain(snap.title)
    let html = '<div class="vd-b vd-title' + (oldTitle !== newTitle ? ' vd-ch' : '') + '">' + (oldTitle !== newTitle ? wordDiff(oldTitle, newTitle) : escapeHtml(newTitle)) + '</div>'
    if (!nChanged) html += '<div class="vd-same">The text is the same as now.</div>'
    else if (!onlyChanges) html += rows.map(rowHTML).join('')
    else {
      // changed blocks with one paragraph of context either side; the rest folded
      const keep = rows.map((r, i) => r.changed || (rows[i - 1] && rows[i - 1].changed) || (rows[i + 1] && rows[i + 1].changed))
      for (let i = 0; i < rows.length;) {
        if (keep[i]) { html += rowHTML(rows[i]); i++; continue }
        let j = i
        while (j < rows.length && !keep[j]) j++
        html += '<div class="vd-fold">⋯ ' + (j - i) + ' unchanged ' + (j - i === 1 ? 'paragraph' : 'paragraphs') + '</div>'
        i = j
      }
    }
    body.innerHTML = linkify(html)
    const added = rows.filter((r) => r.added).length, gone = rows.filter((r) => r.gone).length
    view.querySelector('.vd-stats').textContent = !nChanged ? 'No changes'
      : nChanged + ' ' + (nChanged === 1 ? 'paragraph' : 'paragraphs') + ' differ' +
        (added || gone ? ' (' + [added && added + ' new since', gone && gone + ' removed since'].filter(Boolean).join(', ') + ')' : '')
  }

  async function open(v) {
    current = { v, data: null, only: true }
    view.classList.remove('hidden')
    view.querySelector('.vd-when').textContent = (KIND[v.kind] || 'Saved') + ' · ' + when(v.ts)
    view.querySelector('.vd-stats').textContent = ''
    view.querySelector('.vd-body').innerHTML = '<div class="vd-same">Loading…</div>'
    view.querySelector('.vd-only').checked = true
    resetRestore()
    try {
      const data = await fetchVersion(v, false)
      if (!current || current.v !== v) return
      current.data = data
      render(data, true)
    } catch (e) { view.querySelector('.vd-body').innerHTML = '<div class="vd-same">' + escapeHtml(e.message) + '</div>' }
  }
  function close() { view.classList.add('hidden'); current = null }

  function resetRestore() {
    const b = view.querySelector('.vd-restore')
    b.textContent = 'Restore this version'
    b.classList.remove('confirm')
    b.disabled = false
  }
  async function restore() {
    const b = view.querySelector('.vd-restore')
    if (!current || !current.data) return
    if (!b.classList.contains('confirm')) { b.textContent = 'Click again to restore (backs up now first)'; b.classList.add('confirm'); return }
    b.disabled = true
    b.textContent = 'Backing up now…'
    const id = getDocId()
    const ok = await backup()
    if (!ok) { toast('Backup failed, so nothing was restored'); resetRestore(); return }
    b.textContent = 'Restoring…'
    let full
    try { full = await fetchVersion(current.v, true) } catch (e) { toast(e.message); resetRestore(); return }
    if (getDocId() !== id) { toast('You switched drafts — nothing was restored'); resetRestore(); return }
    applySnapshot({ ...full, id })
    scheduleSave()
    cache.at = 0
    toast('Restored the version from ' + when(current.v.ts) + ' — the one before it is in Versions')
    close()
  }

  view.querySelector('.vd-close').addEventListener('click', close)
  view.querySelector('.vd-restore').addEventListener('click', restore)
  view.querySelector('.vd-only').addEventListener('change', (e) => { if (current && current.data) render(current.data, e.target.checked) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !view.classList.contains('hidden')) close() })

  return { renderInto, open, close, _internal: { blocksOf, diffRows, wordDiff } }
}
