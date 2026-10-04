/* ai-context.js — notes the writer attaches for Review to read alongside the draft: a
 * Google Doc (e.g. a research journal) or pasted text. Review uses them to understand
 * what the author means and has been reading, and to suggest linking a phrase to a
 * source the notes link to — only URLs that literally appear in the notes are accepted
 * (see toItem in ai-suggest.js), so a link can never be made up.
 *
 * Sources apply to every draft; each can be switched off. They live in this browser's
 * IndexedDB — never in a draft, never pushed anywhere — and are sent to OpenAI only as
 * part of a Review. A Google Doc is fetched through the local server (/api/gdoc;
 * browsers can't read Google Docs cross-origin), which needs it shared "Anyone with the
 * link" or published to the web. It's refetched before a Review once it's 10 min old.
 *
 * A long journal doesn't go to every Review whole: past WHOLE_CHARS, Review gets the
 * excerpts most relevant to the passage being reviewed (keyword scoring, BM25), each
 * under the journal heading (e.g. the date) it sits beneath.
 */

import { $, uid, escapeHtml } from './dom.js'

const DB_NAME = 'ahilan-editor-context'
const STORE = 'kv'
const STALE_MS = 10 * 60 * 1000
const WHOLE_CHARS = 120000  // notes this short go to Review whole (~30k tokens)
const PICK_CHARS = 100000   // longer ones: the most relevant excerpts, up to this much in total
const CHUNK_CHARS = 1500

/* ------------------------------------------------------------------ storage */
let _db = null
function db() {
  if (_db) return _db
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _db
}
async function idbGet(k) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const rq = d.transaction(STORE, 'readonly').objectStore(STORE).get(k)
    rq.onsuccess = () => resolve(rq.result)
    rq.onerror = () => reject(rq.error)
  })
}
async function idbSet(k, v) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// [{ id, kind: 'gdoc'|'text', name, url, text, fetched, enabled, error }]
let sources = []
let loading = null
function load() {
  if (!loading) loading = idbGet('sources').then((v) => { sources = Array.isArray(v) ? v : [] }).catch((e) => console.warn('[context] load failed', e))
  return loading
}
const save = () => idbSet('sources', sources).catch((e) => console.warn('[context] save failed', e))

/* ------------------------------------------------------------ Google Docs */
// docs.google.com/url?q=<real> → <real> (Google wraps every link in its exported HTML)
function unwrapGoogle(href) {
  try {
    const u = new URL(href)
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) return u.searchParams.get('q')
  } catch (e) {}
  return href
}

// An exported/published Google Doc's HTML → compact text: headings as #, list items as
// "- ", tables as "a | b", links as [text](url). Images and styling are dropped.
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, title, meta').forEach((e) => e.remove())
  const inline = (node) => {
    let s = ''
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) { s += c.nodeValue; return }
      if (c.nodeType !== 1) return
      if (c.tagName === 'A' && c.getAttribute('href')) {
        const href = unwrapGoogle(c.getAttribute('href'))
        const t = inline(c).trim()
        s += !/^https?:/.test(href) ? t : t && t !== href ? '[' + t + '](' + href + ')' : href
      } else if (c.tagName === 'BR') s += '\n'
      else if (c.tagName !== 'IMG') s += inline(c)
    })
    return s.replace(/ /g, ' ')
  }
  const lines = []
  const walk = (el) => {
    for (const c of el.children) {
      const tag = c.tagName
      if (tag === 'TABLE') { c.querySelectorAll('tr').forEach((tr) => lines.push(Array.from(tr.cells, (td) => inline(td).trim()).join(' | '))); continue }
      if (/^H[1-6]$/.test(tag)) { lines.push('', '#'.repeat(+tag[1]) + ' ' + inline(c).trim()); continue }
      if (tag === 'LI') { lines.push('- ' + inline(c).trim()); continue }
      if (tag === 'P' || tag === 'PRE' || tag === 'BLOCKQUOTE') { lines.push(inline(c).trim()); continue }
      walk(c) // div, ul, ol, body…
    }
  }
  walk(doc.body)
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Google's Markdown export → the same compact text: inline images (already stripped by
// the server) and markdown backslash-escapes removed, redirect-wrapped links unwrapped.
export function mdToText(md) {
  return md
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*<?data:[^\n]*$/gm, '')
    .replace(/!\[[^\]\n]*\](\[[^\]\n]*\]|\([^)\n]*\))/g, '')
    .replace(/\]\((https?:\/\/(?:www\.)?google\.com\/url\?[^)\s]+)\)/g, (m, u) => '](' + unwrapGoogle(u) + ')')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>=])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchGdoc(url) {
  const res = await fetch('/api/gdoc?url=' + encodeURIComponent(url), { cache: 'no-store' })
  const j = await res.json().catch(() => ({}))
  // a plain 404 page (no JSON) means the server predates /api/gdoc
  if (res.status === 404 && !j.error) throw new Error('The editor server needs a restart to fetch Google Docs — double-click run-editor.command, then try again.')
  if (!res.ok) throw new Error(j.error || 'Couldn’t fetch the doc (' + res.status + ')')
  const text = j.markdown != null ? mdToText(j.markdown) : htmlToText(j.html || '')
  if (!text) throw new Error('The doc came back empty')
  return { title: j.title || '', text }
}

async function refresh(src) {
  try {
    const { text } = await fetchGdoc(src.url)
    Object.assign(src, { text, fetched: Date.now(), error: '' })
  } catch (e) {
    src.error = e.message
    throw e
  } finally {
    await save()
  }
}

/* ------------------------------------------------------------- for Review */
// picking the relevant part of a long journal
const STOP = new Set(('the and for that this with from are was were has have had not but you your our their its into ' +
  'than then them they will would can could should also more most such some any all one two each which what when ' +
  'where who how why use used using via per about over under between both only very just like make made does did ' +
  'being been may might much many other these those there here out get got new way ways see seems think thing things').split(' '))
function terms(s) {
  const out = []
  for (const t of s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]/gu) || []) {
    if (t.length >= 3 && !STOP.has(t)) out.push(t)
    if (t.includes('-')) for (const part of t.split('-')) if (part.length >= 3 && !STOP.has(part)) out.push(part)
  }
  return out
}

// Split notes into ~CHUNK_CHARS excerpts that never straddle a heading; each remembers
// the heading above it (in a journal, usually the date) so the model can cite it.
function chunk(text) {
  const chunks = []
  let lines = [], len = 0, heading = ''
  const flush = () => { if (lines.join('').trim()) chunks.push({ heading, text: lines.join('\n'), i: chunks.length }); lines = []; len = 0 }
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line.replace(/^#+\s*/, '').trim(); continue }
    if (len + line.length > CHUNK_CHARS && len > 0) flush()
    lines.push(line)
    len += line.length + 1
  }
  flush()
  return chunks
}

// The excerpts of `text` most relevant to `query`, best-first up to `budget` chars, then
// put back in document order. Okapi BM25 over the excerpts.
function pickRelevant(text, query, budget) {
  const chunks = chunk(text)
  const q = [...new Set(terms(query))]
  const docs = chunks.map((c) => { const tf = new Map(); const ts = terms(c.heading + ' ' + c.text); ts.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1)); return { tf, dl: ts.length } })
  const avgdl = docs.reduce((n, d) => n + d.dl, 0) / Math.max(1, docs.length)
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]))
  const k1 = 1.2, b = 0.75, N = docs.length
  const scored = chunks.map((c, i) => {
    let score = 0
    for (const t of q) {
      const f = docs[i].tf.get(t)
      if (!f) continue
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docs[i].dl / avgdl))
    }
    return { c, score }
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  const picked = []
  let used = 0
  for (const { c } of scored) {
    if (used + c.text.length > budget) continue
    picked.push(c)
    used += c.text.length
  }
  return picked.sort((a, b) => a.i - b.i)
    .map((c) => (c.heading ? '## ' + c.heading + '\n' : '') + c.text.trim())
    .join('\n\n[…]\n\n')
}

export const extractUrls = (text) =>
  new Set((text.match(/https?:\/\/[^\s<>()[\]"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))

/** The enabled sources for a Review of `query` (the passage). Stale Google Docs are
 *  refetched first (a failed refetch falls back to the last copy); short sources go whole,
 *  long ones as their most relevant excerpts. → { parts: [{ name, text }], urls: Set } */
export async function freshContext(query) {
  await load()
  const on = sources.filter((s) => s.enabled)
  const stale = on.filter((s) => s.kind === 'gdoc' && Date.now() - (s.fetched || 0) > STALE_MS)
  await Promise.all(stale.map((s) => refresh(s).catch((e) => console.warn('[context] refresh failed:', s.name, e.message))))
  const total = on.reduce((n, s) => n + (s.text || '').length, 0)
  const parts = []
  for (const s of on) {
    if (!s.text) continue
    if (total <= WHOLE_CHARS) { parts.push({ name: s.name, text: s.text }); continue }
    const share = Math.max(8000, Math.round(PICK_CHARS * s.text.length / total))
    const text = s.text.length <= share ? s.text : pickRelevant(s.text, query || '', share)
    if (text) parts.push({ name: s.name + (text === s.text ? '' : ' (excerpts relevant to the passage)'), text })
  }
  const urls = new Set()
  parts.forEach((p) => extractUrls(p.text).forEach((u) => urls.add(u)))
  return { parts, urls }
}

/* ------------------------------------------------------------------- UI */
const ago = (t) => {
  if (!t) return 'not fetched'
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'
}
const size = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : n) + ' chars'

/** The menu's "Context for Review" list + the Add-context dialog. → { render, openAdd } */
export function setupContextUI() {
  const list = $('sgCtxList')
  const overlay = $('ctxOverlay')
  if (!list || !overlay) return { render() {}, openAdd() {} }
  load().then(() => render())

  function render() {
    list.textContent = ''
    for (const s of sources) {
      const row = document.createElement('div')
      row.className = 'sg-ctx-row' + (s.enabled ? '' : ' off')
      const meta = s.error ? '<span class="sg-ctx-err" title="' + escapeHtml(s.error) + '">couldn’t refresh</span>'
        : size((s.text || '').length) + (s.kind === 'gdoc' ? ' · ' + ago(s.fetched) : '') +
          ((s.text || '').length > WHOLE_CHARS ? ' · excerpts' : '')
      row.innerHTML =
        '<label><input type="checkbox"' + (s.enabled ? ' checked' : '') + ' /><span class="sg-ctx-name"></span></label>' +
        '<span class="sg-ctx-meta">' + meta + '</span>' +
        (s.kind === 'gdoc' ? '<button type="button" class="sg-ctx-btn" data-act="refresh" title="Fetch again">↻</button>' : '') +
        '<button type="button" class="sg-ctx-btn" data-act="remove" title="Remove">✕</button>'
      row.querySelector('.sg-ctx-name').textContent = s.name
      row.querySelector('input').addEventListener('change', (e) => { s.enabled = e.target.checked; save(); render() })
      const rb = row.querySelector('[data-act="refresh"]')
      if (rb) rb.addEventListener('click', async () => {
        rb.disabled = true
        rb.classList.add('spin')
        try { await refresh(s) } catch (e) {}
        render()
      })
      let armed = false // two clicks to remove (the first arms it)
      const xb = row.querySelector('[data-act="remove"]')
      xb.addEventListener('click', () => {
        if (!armed) { armed = true; xb.textContent = 'Remove?'; xb.classList.add('confirm'); return }
        sources = sources.filter((x) => x !== s)
        save()
        render()
      })
      list.appendChild(row)
    }
  }

  const msg = (text, cls) => { const m = $('ctxMsg'); m.textContent = text || ''; m.className = 'modal-msg' + (cls ? ' ' + cls : '') }
  function openAdd() {
    $('ctxName').value = ''
    $('ctxUrl').value = ''
    $('ctxText').value = ''
    msg('')
    overlay.classList.remove('hidden')
    $('ctxUrl').focus()
  }
  const close = () => overlay.classList.add('hidden')

  $('ctxCancel').addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close() })
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  $('ctxSave').addEventListener('click', async () => {
    const url = $('ctxUrl').value.trim()
    const text = $('ctxText').value.trim()
    let name = $('ctxName').value.trim()
    if (!url && !text) { msg('Paste a Google Doc link or some notes.', 'err'); return }
    if (url && !/^https:\/\/docs\.google\.com\/document\//.test(url)) { msg('That isn’t a Google Doc link (docs.google.com/document/…).', 'err'); return }
    const btn = $('ctxSave')
    btn.disabled = true
    try {
      const src = { id: uid(), kind: url ? 'gdoc' : 'text', name: name || 'Notes', url, text, fetched: 0, enabled: true, error: '' }
      if (url) {
        msg('Fetching…')
        const doc = await fetchGdoc(url)
        Object.assign(src, { text: doc.text, fetched: Date.now(), name: name || doc.title || 'Google Doc' })
      }
      sources.push(src)
      await save()
      render()
      msg('Added · ' + size(src.text.length) + ' · ' + extractUrls(src.text).size + ' links', 'ok')
      setTimeout(close, 900)
    } catch (e) {
      msg(e.message, 'err')
    } finally {
      btn.disabled = false
    }
  })

  return { render, openAdd }
}
