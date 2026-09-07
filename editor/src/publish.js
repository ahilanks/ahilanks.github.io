/* publish.js — one-click publish to the static site's writings/ folder.
 *
 * Opens #publishOverlay, then on confirm builds a standalone article HTML from the
 * current doc and hands the files to the local editor server (POST /api/publish), which
 * writes them into the project it serves, then commits + pushes them to GitHub
 * (POST /api/site-push) — no folder picker, no manual git step. Inline data-URI images
 * are split out into media/ files (named by content hash, so older versions keep pointing
 * at the bytes they were published with); the writings.html index list is optionally updated.
 *
 * Two modes:
 *   publish — writings/<slug>.html + a frozen copy writings/<slug>.v<N>.html (byte-identical
 *             to the live page). The frozen file is SHA-256 hashed and the fingerprint is
 *             anchored in the Bitcoin blockchain via OpenTimestamps by the local editor
 *             server (POST /api/stamp → provenance.py), which records every version in
 *             writings/proofs/<slug>/manifest.json (+ v<N>.ots). Re-publishing an edited
 *             article adds v<N+1>; the article's small provenance widget (above the title)
 *             lists every version, its proof status, and opens any older version.
 *   draft   — an UNLISTED copy at writings/p/<token>.html (token = 32 random hex chars,
 *             stable per draft so re-sharing overwrites the same URL). Not added to the
 *             index, robots-noindexed, no versioning, no timestamp.
 *
 * NOTE: v2's editor.getHTML() serialises math as <span class="math-inline" data-tex>$..$</span>
 * / <div class="math-block" data-tex>$$..$$</div> and footnote refs as <sup class="fn-ref"
 * data-fn>•</sup> (the number is NOT in the serialised form), so this module re-numbers the
 * refs in document order and pulls the footnote bodies (already numbered) from the live #fnList.
 *
 * This writes to writings/ (the public site), NOT to the drafts store or the server sync,
 * so it is safe to run in SANDBOX mode.
 */

import { $, escapeHtml, slugify, todayLong, toast } from './dom.js'
import { CONFIG } from './config.js'

/* ------------------------------------------------------------ file sink (server) */
// Files are collected here during a publish and sent to the local server in one request.
// The server only accepts the site's publish paths (writings/, writings/media/, writings/p/,
// media/, writings.html) — see PUBLISH_PATH_RE in editor-server.py.
function makeSink() {
  const files = []
  return {
    files,
    add(path, data) {
      if (data instanceof Blob) return data.arrayBuffer().then((buf) => { files.push({ path, b64: bytesToB64(new Uint8Array(buf)) }) })
      if (data instanceof Uint8Array) { files.push({ path, b64: bytesToB64(data) }); return Promise.resolve() }
      files.push({ path, text: String(data) })
      return Promise.resolve()
    },
    async flush() {
      if (!files.length) return []
      const r = await apiJson('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) })
      return r.written || []
    },
  }
}
function bytesToB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
// Commit + push the given site paths. Returns the server's git summary.
async function sitePush(paths, message) {
  const r = await apiJson('/api/site-push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, message }) })
  return r.git || {}
}
function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',')
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/png'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
const utf8 = (s) => new TextEncoder().encode(s)
async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}
function randomToken() {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/* --------------------------------------------------------------- sanitisation */
// Allowlist sanitiser — nothing attacker-controlled that got pasted from a third-party page
// should reach the public static site. Runs on the detached publish clone.
const SANITIZE_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'SVG', 'MATH'])
const SANITIZE_ALLOW = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'SUP', 'SUB', 'HR', 'FIGURE', 'IMG', 'FIGCAPTION', 'SPAN', 'DIV', 'VIDEO'])
const SANITIZE_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt'], VIDEO: ['src', 'controls', 'playsinline', 'preload', 'loop', 'muted', 'poster', 'width', 'height'], SPAN: ['data-tex', 'data-display'], DIV: ['data-tex', 'data-display'], SUP: ['data-fn'], FIGURE: ['data-w'] }
function sanitizeNode(root) {
  root.querySelectorAll('*').forEach((el) => {
    // root.contains (not isConnected): the tree is detached, so isConnected is always false
    if (!root.contains(el)) return // removed already via a dropped ancestor
    const tag = el.tagName
    if (SANITIZE_DROP.has(tag)) { el.remove(); return }
    if (!SANITIZE_ALLOW.has(tag)) { el.replaceWith(...el.childNodes); return }
    const allow = SANITIZE_ATTRS[tag] || []
    Array.from(el.attributes).forEach((a) => {
      const name = a.name.toLowerCase()
      if (name === 'id' || name === 'class') return // safe to keep
      if (name.startsWith('on')) { el.removeAttribute(a.name); return }
      if (!allow.includes(name)) el.removeAttribute(a.name)
    })
    if (tag === 'A') {
      const href = el.getAttribute('href') || ''
      if (/^\s*(javascript|vbscript|data):/i.test(href)) el.removeAttribute('href')
    }
    if (tag === 'IMG') {
      const src = el.getAttribute('src') || ''
      if (!/^(https?:|data:image\/|media\/|\.\.?\/|\/)/i.test(src)) el.removeAttribute('src')
    }
    if (tag === 'VIDEO') {
      const src = el.getAttribute('src') || ''
      if (!/^(https?:|media\/|\.\.?\/|\/)/i.test(src)) el.removeAttribute('src')
    }
  })
}

// Footnote bodies stay footnote-sized: inline formatting plus images, matching the editor's
// own footnote normaliser (footnote.js, which isn't exported — re-implemented small here).
const FN_ALLOW = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'SUP', 'SUB', 'IMG'])
const FN_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt'] }
function normalizeFnBody(root) {
  root.querySelectorAll('*').forEach((el) => {
    if (!root.contains(el)) return
    if (!FN_ALLOW.has(el.tagName)) { el.replaceWith(...el.childNodes); return }
    const keep = FN_ATTRS[el.tagName] || []
    Array.from(el.attributes).forEach((a) => { if (!keep.includes(a.name.toLowerCase())) el.removeAttribute(a.name) })
  })
}

/* ------------------------------------------------------------- body → article */
function htmlToText(html) {
  const d = document.createElement('div')
  d.innerHTML = html || ''
  return (d.textContent || '').trim()
}

// The first <img> in the body (data URI, media/ path or absolute URL) — the default
// thumbnail for the writings list. Null when the article has no image.
function firstImageSrc(bodyHtml) {
  const d = document.createElement('div')
  d.innerHTML = bodyHtml || ''
  const img = Array.from(d.querySelectorAll('img')).find((i) => (i.getAttribute('src') || '').trim())
  return img ? img.getAttribute('src').trim() : null
}

// Stable, readable anchor for a heading: "sec-" + slugified text, deduped with a counter.
function headingId(text, used) {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
  let id = 'sec-' + base
  for (let i = 2; used.has(id); i++) id = 'sec-' + base + '-' + i
  used.add(id)
  return id
}

// Turn a detached clone of the serialised body into clean published HTML:
// math nodes -> $..$ / $$..$$ text for KaTeX auto-render, footnote refs -> numbered anchors.
// Also gives every non-empty H2/H3 an id and returns the contents-panel entries
// ({ id, text, level, n }, where n is the §-number counted over H2s only).
function bodyToPublishHtml(clone) {
  // inline math -> literal $tex$ text
  clone.querySelectorAll('.math-inline').forEach((m) => m.replaceWith(document.createTextNode('$' + (m.dataset.tex || '') + '$')))
  // block math -> a centred (or aligned) paragraph carrying $$tex$$
  clone.querySelectorAll('.math-block').forEach((m) => {
    const p = document.createElement('p')
    p.className = 'math-block' + (m.dataset.align ? ' align-' + m.dataset.align : '')
    p.textContent = '$$' + (m.dataset.tex || '') + '$$'
    m.replaceWith(p)
  })
  // footnote refs -> superscript anchors, numbered in document order (getHTML stores only '•')
  let refN = 0
  clone.querySelectorAll('.fn-ref').forEach((r) => {
    const n = ++refN
    const sup = document.createElement('sup')
    sup.id = 'fnref-' + n
    sup.innerHTML = '<a href="#fn-' + n + '">' + n + '</a>'
    r.replaceWith(sup)
  })
  // figure cleanup: drop empty captions, strip editor-only attributes
  clone.querySelectorAll('figure').forEach((f) => {
    const cap = f.querySelector('figcaption')
    if (cap && !cap.textContent.trim()) cap.remove()
    else if (cap) { cap.removeAttribute('contenteditable'); cap.removeAttribute('data-placeholder') }
    f.removeAttribute('contenteditable')
  })
  sanitizeNode(clone) // strip anything unsafe before it reaches the public page
  // resized figures: convert the validated data-w (kept through sanitise) into an inline width
  clone.querySelectorAll('figure[data-w]').forEach((f) => {
    const w = Math.max(20, Math.min(100, parseFloat(f.getAttribute('data-w')) || 100))
    f.removeAttribute('data-w')
    if (w < 100) f.setAttribute('style', 'width:' + w + '%;margin-left:auto;margin-right:auto;')
  })
  // contents panel: anchor + collect every non-empty H2/H3/H4 (ids survive sanitizeNode
  // above). Depth comes from the distinct levels actually used (a doc written all in H3s
  // still gets §-numbered sections; H4s directly under H2s still nest one step): depth 0
  // (level 2) is §-numbered, depths 1/2 (levels 3/4) are sub-entries the page script
  // progressively discloses while their parent section / sub-section is being read.
  const hs = []
  clone.querySelectorAll('h2, h3, h4').forEach((h) => {
    const text = (h.textContent || '').trim()
    if (text) hs.push({ h, text, lvl: +h.tagName[1] })
  })
  const lvls = Array.from(new Set(hs.map((e) => e.lvl))).sort()
  const toc = []
  const usedIds = new Set()
  let secN = 0
  hs.forEach((e) => {
    const depth = lvls.indexOf(e.lvl)
    if (depth === 0) secN++
    e.h.id = headingId(e.text, usedIds)
    toc.push({ id: e.h.id, text: e.text, level: depth + 2, n: depth === 0 ? secN : 0 })
  })
  return { html: clone.innerHTML, toc }
}

// Rewrite every data-URI <img> under `root` to <mediaPrefix><prefix>-<hash12>.<ext>, pushing
// the bytes onto `files`. Names carry a content hash so a re-publish never overwrites an
// image an older frozen version still references (and identical images are written once).
async function extractDataImages(root, prefix, files, mediaPrefix) {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('data:')) continue
    const ext = (src.substring(5, src.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg')
    const blob = dataUrlToBlob(src)
    const hash = (await sha256Hex(await blob.arrayBuffer())).slice(0, 12)
    const name = prefix + '-' + hash + '.' + ext
    if (!files.some((f) => f.name === name)) files.push({ name, blob })
    img.setAttribute('src', mediaPrefix + name)
  }
}

// Split inline data-URI images out to media/ files and drop unresolvable videos, then
// return { html, files, toc } ready for buildArticleHtml + writeFile.
async function buildBody(bodyHtml, slug, mediaPrefix) {
  const clone = document.createElement('div')
  clone.innerHTML = bodyHtml || ''
  const files = []
  await extractDataImages(clone, slug, files, mediaPrefix)
  // v2 doesn't yet resolve uploaded video bytes (no src in getHTML) — don't ship broken players.
  clone.querySelectorAll('figure.video-block').forEach((f) => {
    const v = f.querySelector('video')
    if (!v || !v.getAttribute('src')) f.remove()
  })
  const { html, toc } = bodyToPublishHtml(clone)
  return { html, files, toc }
}

// Pull the numbered footnote bodies from the live (already reconciled) #fnList.
// Orphaned bodies (ref deleted in the text) are editor-only and never published.
// Images embedded in footnotes are split out to media/<slug>-fn-<hash>.<ext> like body images;
// returns { html, files }.
async function buildFootnotesHtml(fnListEl, slug, mediaPrefix) {
  const items = fnListEl ? Array.from(fnListEl.children).filter((li) => !li.classList.contains('fn-orphan')) : []
  const files = []
  if (!items.length) return { html: '', files }
  const wrap = document.createElement('div')
  items.forEach((li) => {
    const bodyEl = li.querySelector('.fn-body') || li
    const bodyClone = bodyEl.cloneNode(true)
    sanitizeNode(bodyClone)
    normalizeFnBody(bodyClone)
    wrap.appendChild(bodyClone)
  })
  await extractDataImages(wrap, slug + '-fn', files, mediaPrefix)
  let html = '\n      <hr class="fn-divider" />\n      <ol class="footnotes">\n'
  Array.from(wrap.children).forEach((bodyClone, idx) => {
    const n = idx + 1 // index order matches the re-numbered body refs above
    html += '        <li id="fn-' + n + '">' + bodyClone.innerHTML + '</li>\n'
  })
  html += '      </ol>\n'
  return { html, files }
}

/* ------------------------------------------------------ provenance widget (page) */
// Runs INSIDE the published article (embedded via provWidget.toString(), so keep it
// self-contained: no imports, no closures over this module, no "</script>" literals).
// Reads writings/proofs/<slug>/manifest.json at runtime and renders, above the title:
//   ● v3 · Sep 6, 2026 · timestamped in Bitcoin ▾
// Expanding lists every version (click → opens that frozen file), each proof's status,
// the SHA-256 fingerprint, a live in-browser re-hash of the frozen file, the .ots proof
// and how to verify independently. Old version pages announce they are superseded.
function provWidget() {
  var root = document.getElementById('prov')
  if (!root) return
  var slug = root.getAttribute('data-slug')
  var here = parseInt(root.getAttribute('data-v') || '0', 10)
  var m = (location.pathname || '').match(/\.v(\d+)\.html$/)
  var viewingOld = !!m // a frozen copy (…/<slug>.v<N>.html) rather than the live page
  var line = root.querySelector('.prov-line')
  var text = root.querySelector('.prov-text')
  var dot = root.querySelector('.prov-dot')
  var panel = root.querySelector('.prov-panel')
  var manifest = null
  var opened = false

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
  function day(iso) {
    var d = new Date(iso); if (isNaN(d)) return String(iso || '')
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  function dayTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return String(iso || '')
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  function utc(sec) {
    var d = new Date(sec * 1000)
    return d.toUTCString().replace(/:\d\d GMT$/, ' UTC').replace(/^\w+, /, '')
  }
  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }
  function statusOf(v) {
    if (v.status === 'verified') return { k: 'ok', s: 'Bitcoin block ' + num(v.block) + ' · mined ' + utc(v.blockTime) }
    if (v.status === 'confirmed') return { k: 'ok', s: 'Bitcoin block ' + num(v.block) + ' · header check pending' }
    if (v.status === 'invalid') return { k: 'bad', s: 'proof does not match block ' + num(v.block) }
    return { k: 'wait', s: 'awaiting Bitcoin confirmation · submitted ' + dayTime(v.submitted || v.date) }
  }

  function summarize() {
    var vs = manifest && manifest.versions ? manifest.versions : []
    var latest = vs.length ? vs[vs.length - 1] : null
    var mine = null
    for (var i = 0; i < vs.length; i++) if (vs[i].n === here) mine = vs[i]
    var parts = []
    if (viewingOld && latest && here < latest.n) {
      parts.push('v' + here + ' of ' + latest.n)
      parts.push(day(mine ? mine.date : root.getAttribute('data-date')))
      parts.push('superseded')
      dot.className = 'prov-dot old'
    } else {
      parts.push('v' + here + (latest && latest.n > 1 ? ' · ' + day(mine ? mine.date : root.getAttribute('data-date')) : ' · ' + day(root.getAttribute('data-date'))))
      var st = mine ? statusOf(mine) : null
      if (st && st.k === 'ok') { parts.push('timestamped in Bitcoin'); dot.className = 'prov-dot ok' }
      else if (st && st.k === 'wait') { parts.push('timestamp pending'); dot.className = 'prov-dot wait' }
      else if (st && st.k === 'bad') { parts.push('timestamp invalid'); dot.className = 'prov-dot bad' }
    }
    text.textContent = parts.join(' · ')
    if (viewingOld && latest && here < latest.n) {
      var cur = document.createElement('a')
      cur.className = 'prov-current'
      cur.href = slug + '.html'
      cur.textContent = 'read the current version →'
      root.insertBefore(cur, panel)
    }
  }

  function render() {
    var vs = manifest && manifest.versions ? manifest.versions.slice().reverse() : []
    var h = ''
    h += '<p class="prov-intro">Each version of this essay is frozen as a file, and the SHA-256 fingerprint of that file is anchored in the Bitcoin blockchain via <a href="https://opentimestamps.org" rel="noopener" target="_blank">OpenTimestamps</a>. Change one character and the fingerprint changes completely — so a fingerprint in a block mined on a given date proves this exact text existed by then. Nobody, including the author, can backdate or quietly rewrite it.</p>'
    if (!vs.length) {
      h += '<p class="prov-empty">Version list unavailable (proofs/' + esc(slug) + '/manifest.json could not be loaded).</p>'
    } else {
      h += '<ol class="prov-list">'
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i]
        var st = statusOf(v)
        var isLatest = i === 0
        var isHere = v.n === here
        h += '<li class="prov-v' + (isHere ? ' here' : '') + '" data-n="' + v.n + '" data-file="' + esc(v.file) + '" data-sha="' + esc(v.sha256) + '">'
        h += '<div class="prov-row">'
        h += '<a class="prov-vlink" href="' + esc(isLatest ? slug + '.html' : v.file) + '">v' + v.n + '</a>'
        h += '<span class="prov-when">' + esc(dayTime(v.date)) + '</span>'
        if (isLatest) h += '<span class="prov-tag">current</span>'
        if (isHere && !isLatest) h += '<span class="prov-tag">you are reading this one</span>'
        if (v.words) h += '<span class="prov-words">' + num(v.words) + ' words</span>'
        h += '</div>'
        h += '<div class="prov-st ' + st.k + '"><span class="prov-dot ' + (st.k === 'wait' ? 'wait' : st.k === 'bad' ? 'bad' : 'ok') + '"></span>' + esc(st.s) + '</div>'
        h += '<div class="prov-fp"><span class="prov-fplabel">sha256</span> <code title="' + esc(v.sha256) + '">' + esc(v.sha256.slice(0, 12)) + '…' + esc(v.sha256.slice(-8)) + '</code>'
        h += ' <span class="prov-check" data-n="' + v.n + '">checking file…</span>'
        h += ' <a class="prov-ots" href="proofs/' + esc(slug) + '/' + esc(v.ots) + '" download>proof (.ots)</a>'
        if (v.blockHash) h += ' <a class="prov-blk" href="https://mempool.space/block/' + esc(v.blockHash) + '" rel="noopener" target="_blank">block ↗</a>'
        h += '</div>'
        h += '</li>'
      }
      h += '</ol>'
    }
    h += '<details class="prov-how"><summary>How to verify this yourself</summary><ol>'
    h += '<li>Save the version file (the <b>vN</b> link above, “Save page as… → HTML only”, or <code>curl -O</code> its URL) and its <b>proof (.ots)</b>.</li>'
    h += '<li>Check the file’s fingerprint: <code>shasum -a 256 &lt;file&gt;</code> should print the sha256 shown above. Your browser also re-hashes each frozen file when this panel opens (the “file matches” mark).</li>'
    h += '<li>Drop both files at <a href="https://opentimestamps.org" rel="noopener" target="_blank">opentimestamps.org</a>, or run <code>ots verify &lt;file&gt;.ots</code>. The proof leads from the fingerprint to a Bitcoin block header; the block’s date is the latest the text could have been written.</li>'
    h += '</ol><p>A fresh proof shows “awaiting Bitcoin confirmation” until the calendar’s commitment is mined (usually a few hours); the completed proof is then published here.</p></details>'
    panel.innerHTML = h
    checkFiles()
  }

  // Re-hash every frozen file in the browser and compare with the manifest fingerprint.
  function checkFiles() {
    var items = panel.querySelectorAll('.prov-v')
    Array.prototype.forEach.call(items, function (li) {
      var out = li.querySelector('.prov-check')
      var file = li.getAttribute('data-file'), sha = li.getAttribute('data-sha')
      if (!out || !file || !window.crypto || !crypto.subtle) { if (out) out.textContent = ''; return }
      fetch(file, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer() })
        .then(function (buf) { return crypto.subtle.digest('SHA-256', buf) })
        .then(function (d) {
          var hex = Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
          out.className = 'prov-check ' + (hex === sha ? 'ok' : 'bad')
          out.textContent = hex === sha ? '✓ file matches' : '✗ file differs from fingerprint'
        })
        .catch(function () { out.className = 'prov-check'; out.textContent = '' })
    })
  }

  line.addEventListener('click', function () {
    opened = !opened
    panel.hidden = !opened
    line.setAttribute('aria-expanded', opened ? 'true' : 'false')
    root.classList.toggle('open', opened)
    if (opened && !panel.innerHTML) render()
  })

  fetch('proofs/' + slug + '/manifest.json', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json() })
    .then(function (j) { manifest = j; summarize() })
    .catch(function () { manifest = null; summarize() })
}

const PROV_CSS = [
  '      .prov { margin:-1.1rem 0 1rem; font-family:system-ui, -apple-system, sans-serif; font-size:0.74rem; color:var(--muted); line-height:1.5; }',
  '      .prov-line { display:inline-flex; align-items:center; gap:0.45rem; padding:0; border:0; background:none; font:inherit; color:inherit; cursor:pointer; letter-spacing:0.01em; }',
  '      .prov-line:hover .prov-text { color:var(--text-color); }',
  '      .prov-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:rgba(107,114,128,0.55); flex:none; }',
  '      .prov-dot.ok { background:#4a9a5a; } .prov-dot.wait { background:#d9a441; } .prov-dot.bad { background:#c0392b; } .prov-dot.old { background:#9aa1ab; }',
  '      .prov-caret { display:inline-flex; align-items:center; transition:transform 0.15s; opacity:0.7; }',
  '      .prov.open .prov-caret { transform:rotate(180deg); }',
  '      .prov-current { display:block; margin:0.15rem 0 0 0.95rem; color:var(--text-color); text-decoration:none; }',
  '      .prov-current:hover { text-decoration:underline; }',
  '      .prov-panel { margin:0.7rem 0 0; padding:0.1rem 0 0.1rem 0.9rem; border-left:2px solid rgba(39,50,63,0.12); max-width:560px; }',
  '      .prov-intro { margin:0 0 0.8rem; }',
  '      .prov-empty { margin:0 0 0.6rem; font-style:italic; }',
  '      .prov-list { list-style:none; margin:0 0 0.6rem; padding:0; display:flex; flex-direction:column; gap:0.6rem; }',
  '      .prov-v.here { background:rgba(39,50,63,0.04); margin:0 -0.4rem; padding:0.35rem 0.4rem; border-radius:6px; }',
  '      .prov-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.35rem 0.6rem; }',
  '      .prov-vlink { color:var(--text-color); font-weight:600; text-decoration:none; }',
  '      .prov-vlink:hover { text-decoration:underline; }',
  '      .prov-tag { font-size:0.66rem; text-transform:uppercase; letter-spacing:0.08em; padding:0.05rem 0.35rem; border:1px solid rgba(39,50,63,0.2); border-radius:4px; }',
  '      .prov-words { opacity:0.8; }',
  '      .prov-st { display:flex; align-items:center; gap:0.4rem; margin-top:0.1rem; }',
  '      .prov-fp { margin-top:0.1rem; display:flex; flex-wrap:wrap; gap:0.2rem 0.55rem; align-items:baseline; }',
  '      .prov-fplabel { opacity:0.7; }',
  '      .prov-fp code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:0.7rem; }',
  '      .prov-check.ok { color:#4a9a5a; } .prov-check.bad { color:#c0392b; }',
  '      .prov-fp a { color:var(--muted); }',
  '      .prov-fp a:hover { color:var(--text-color); }',
  '      .prov-how { margin-top:0.3rem; }',
  '      .prov-how summary { cursor:pointer; }',
  '      .prov-how ol { margin:0.4rem 0; padding-left:1.2rem; }',
  '      .prov-how li { margin:0 0 0.3rem; }',
  '      .prov-how p { margin:0.3rem 0 0; }',
  '      .prov-how code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:0.7rem; }',
  '      .prov a { color:var(--muted); }',
  '      .prov a:hover { color:var(--text-color); }',
  '      .draft-note { margin:-1.1rem 0 1rem; font-family:system-ui, -apple-system, sans-serif; font-size:0.74rem; color:var(--muted); letter-spacing:0.01em; }',
]

function longDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Build a full standalone article that matches the published site's aesthetic.
// `version` ({ n, date }) adds the provenance widget; `draft` marks an unlisted preview
// (noindex, no widget, relative paths one level deeper via `pathPrefix`).
function buildArticleHtml({ titleText, subtitleText, dateStr, minutes, font, bodyHtml, footHtml, toc, slug, version, draft }) {
  const title = escapeHtml(titleText)
  const subtitle = escapeHtml(subtitleText)
  const hasToc = !!(toc && toc.length)
  const up = draft ? '../../' : '../'

  // Contents panel: fixed top-left, §-numbered H2s + indented H3s/H4s (sub-entries only
  // shown while their parent section / sub-section is being read), active entry tracked
  // by the tiny scrollspy script below. Hidden entirely when the viewport is too narrow.
  const tocHtml = hasToc
    ? '    <nav class="toc" aria-label="Contents">\n' +
      '      <div class="toc-label">Contents</div>\n' +
      '      <div class="toc-list">\n' +
      toc.map((t) =>
        '        <a class="toc-item lvl-' + t.level + '" href="#' + t.id + '">' +
        (t.level === 2 ? '§' + t.n + ' · ' : '') + escapeHtml(t.text) + '</a>').join('\n') + '\n' +
      '      </div>\n' +
      '    </nav>'
    : ''

  const tocScript = hasToc
    ? '    <script>\n' +
      '      (function () {\n' +
      '        var items = Array.prototype.slice.call(document.querySelectorAll(".toc-item"));\n' +
      '        if (!items.length) return;\n' +
      '        // parent links by document order: lvl-2 = section, lvl-3 = sub, lvl-4 = sub-sub\n' +
      '        var meta = [], sec = -1, sub = -1;\n' +
      '        for (var m = 0; m < items.length; m++) {\n' +
      '          var c = items[m].className;\n' +
      '          var d = c.indexOf("lvl-4") >= 0 ? 2 : c.indexOf("lvl-3") >= 0 ? 1 : 0;\n' +
      '          if (d === 0) { sec = m; sub = -1; }\n' +
      '          if (d === 1) sub = m;\n' +
      '          meta.push({ d: d, sec: sec, sub: d === 0 ? -1 : sub });\n' +
      '          // a clicked entry stays disclosed even when the page is too short to scroll it to the top\n' +
      '          items[m].addEventListener("click", (function (i) { return function () { pinned = i; update(); }; })(m));\n' +
      '        }\n' +
      '        var pinned = -1;\n' +
      '        var ticking = false;\n' +
      '        function update() {\n' +
      '          ticking = false;\n' +
      '          var active = 0;\n' +
      '          for (var i = 0; i < items.length; i++) {\n' +
      '            var h = document.getElementById(items[i].getAttribute("href").slice(1));\n' +
      '            if (h && h.getBoundingClientRect().top <= 110) active = i;\n' +
      '          }\n' +
      '          // subs show only inside an open section, sub-subs only inside an open\n' +
      '          // sub-section — open = being read (scroll) or last clicked (pinned)\n' +
      '          var secs = [meta[active].sec], subs = [meta[active].sub];\n' +
      '          if (pinned >= 0) { secs.push(meta[pinned].sec); subs.push(meta[pinned].sub); }\n' +
      '          for (var j = 0; j < items.length; j++) {\n' +
      '            items[j].classList.toggle("active", j === active);\n' +
      '            var show = true;\n' +
      '            if (meta[j].d === 1) show = meta[j].sec === -1 || secs.indexOf(meta[j].sec) >= 0;\n' +
      '            else if (meta[j].d === 2) show = (meta[j].sec === -1 || secs.indexOf(meta[j].sec) >= 0) && (meta[j].sub === -1 || subs.indexOf(meta[j].sub) >= 0);\n' +
      '            items[j].classList.toggle("hide", !show);\n' +
      '          }\n' +
      '        }\n' +
      '        addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });\n' +
      '        addEventListener("load", update);\n' + // re-check once KaTeX/images have shifted the layout
      '        update();\n' +
      '      })();\n' +
      '    </script>'
    : ''
  const fontFamily =
    font === 'serif' ? '"Newsreader", Georgia, serif'
      : font === 'mono' ? '"JetBrains Mono", monospace'
        : '"Inter", sans-serif'
  const fontParam =
    font === 'serif' ? 'Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;0,6..72,700;1,6..72,400'
      : font === 'mono' ? 'JetBrains+Mono:wght@400;500'
        : 'Inter:wght@400;600;700'

  // Provenance line above the title (publish) / draft label (draft). The static text is
  // what shows before (or without) the manifest fetch; provWidget() enriches it.
  const provHtml = version
    ? '      <div class="prov" id="prov" data-slug="' + escapeHtml(slug) + '" data-v="' + version.n + '" data-date="' + escapeHtml(version.date) + '">\n' +
      '        <button class="prov-line" type="button" aria-expanded="false" title="Version history &amp; Bitcoin timestamp proof"><span class="prov-dot"></span><span class="prov-text">v' + version.n + ' · ' + escapeHtml(longDate(version.date)) + '</span><span class="prov-caret"><svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>\n' +
      '        <div class="prov-panel" hidden></div>\n' +
      '      </div>'
    : draft
      ? '      <p class="draft-note">Draft preview · unlisted · ' + escapeHtml(longDate(new Date().toISOString())) + '</p>'
      : ''
  const provScript = version ? '    <script>(' + provWidget.toString() + ')();</script>' : ''

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    draft ? '    <meta name="robots" content="noindex, nofollow, noarchive" />' : '',
    '    <title>' + title + '</title>',
    '    <link href="https://fonts.googleapis.com/css2?family=' + fontParam + '&display=swap" rel="stylesheet" />',
    '    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" integrity="sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+" crossorigin="anonymous" />',
    '    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js" integrity="sha384-7zkQWkzuo3B5mTepMUcHkMB5jZaolc2xDwL6VFqjFALcbeS9Ggm/Yr2r3Dy4lfFg" crossorigin="anonymous"></script>',
    '    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" integrity="sha384-43gviWU0YVjaDtb/GhzOouOXtZMP/7XUzwPTstBeZFe/+rCMvRwr4yROQP43s0Xk" crossorigin="anonymous" onload="renderMathInElement(document.body,{delimiters:[{left:\'$$\',right:\'$$\',display:true},{left:\'$\',right:\'$\',display:false},{left:\'\\\\(\',right:\'\\\\)\',display:false},{left:\'\\\\[\',right:\'\\\\]\',display:true}],throwOnError:false,macros:{\'\\\\differentialD\':\'d\',\'\\\\exponentialE\':\'e\',\'\\\\imaginaryI\':\'i\',\'\\\\imaginaryJ\':\'j\'}});"></script>',
    '    <style>',
    '      :root { --text-color:#27323f; --link-color:#0f7ae5; --bg-color:#f1ebdf; --muted:#6b7280; --accent:#e8743b; }',
    '      body { margin:0; padding:0 1.5rem; font-family:' + fontFamily + '; color:var(--text-color); background:var(--bg-color); line-height:1.7; }',
    '      .container { max-width:820px; margin:4rem auto 6rem; }',
    '      .back { display:inline-block; margin-bottom:2rem; color:#000; text-decoration:none; font-size:0.95rem; }',
    '      .back:hover { text-decoration:underline; }',
    '      h1 { text-align:left; font-size:1.6rem; font-weight:700; line-height:1.18; margin:0 0 0.8rem; letter-spacing:-0.01em; }',
    '      .subtitle { text-align:left; font-size:1.3rem; color:var(--muted); margin:0 0 1rem; }',
    '      .meta { text-align:left; color:var(--muted); font-size:0.95rem; margin:0 0 3rem; }',
    '      .math-block { text-align:center; margin:1.6rem 0; overflow-x:auto; overflow-y:hidden; }',
    '      .math-block .katex-display { margin:0; }',
    '      .math-block.align-left, .math-block.align-left .katex-display { text-align:left; }',
    '      .math-block.align-right, .math-block.align-right .katex-display { text-align:right; }',
    '      .katex { font-size: 1em; }',
    '      p, ul, ol { margin:0 0 1.25rem; }',
    '      li { margin:0; }',
    '      li > p, li > ul, li > ol { margin:0; }',
    '      ul { list-style-type:disc; }',
    '      ul ul { list-style-type:circle; }',
    '      ul ul ul { list-style-type:square; }',
    '      h2 { font-size:1.7rem; margin:2rem 0 0.8rem; letter-spacing:-0.01em; }',
    '      h3 { font-size:1.32rem; margin:1.7rem 0 0.6rem; }',
    '      blockquote { margin:1.5rem 0; padding:0.2rem 0 0.2rem 1.2rem; position:relative; }',
    '      blockquote::before { content:""; position:absolute; left:0; top:0.4rem; bottom:0.4rem; width:3px; border-radius:2px; background:var(--accent); }',
    '      a { color:var(--text-color); text-decoration:underline; text-decoration-skip-ink:none; }',
    '      figure { margin:1.8rem auto; text-align:center; }',
    '      figure img, figure video { max-width:100%; border-radius:10px; }',
    '      figure[style] img, figure[style] video { width:100%; }',
    '      figcaption { margin-top:0.5rem; font-size:0.9rem; color:var(--muted); }',
    '      hr { border:none; border-top:1px solid rgba(39,50,63,0.15); margin:2.2rem auto; width:40%; }',
    '      sup a { text-decoration:none; color:var(--text-color); font-weight:600; }',
    '      .fn-divider { width:100%; margin:3rem 0 1.2rem; }',
    '      ol.footnotes { font-size:0.92rem; line-height:1.5; color:var(--text-color); padding-left:1.2rem; }',
    '      ol.footnotes li { margin-bottom:0.7rem; }',
    '      ol.footnotes p, ol.footnotes div { margin:0 0 0.4rem; }',
    '      ol.footnotes p:last-child, ol.footnotes div:last-child { margin-bottom:0; }',
    '      ol.footnotes img { display:block; max-width:100%; height:auto; border-radius:8px; margin:0.5rem 0; }',
    ...(version || draft ? PROV_CSS : []),
    hasToc ? '      html { scroll-behavior:smooth; }' : '',
    hasToc ? '      h2[id], h3[id], h4[id] { scroll-margin-top:1.4rem; }' : '',
    hasToc ? '      .toc { position:fixed; top:6.5rem; left:2rem; width:220px; max-height:calc(100vh - 9rem); overflow-y:auto; scrollbar-width:none; }' : '',
    hasToc ? '      .toc::-webkit-scrollbar { display:none; }' : '',
    hasToc ? '      .toc-label { font-family:system-ui, sans-serif; font-size:0.68rem; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--text-color); margin:0 0 0.9rem 2px; }' : '',
    hasToc ? '      .toc-list { border-left:2px solid rgba(39,50,63,0.14); padding:0.2rem 0; display:flex; flex-direction:column; gap:0.3rem; }' : '',
    hasToc ? '      .toc-item { position:relative; display:block; padding:0.22rem 0.4rem 0.22rem 0.95rem; font-size:0.92rem; line-height:1.35; color:rgba(39,50,63,0.75); text-decoration:none; transition:color 0.12s; }' : '',
    hasToc ? '      .toc-item:hover { color:var(--text-color); }' : '',
    hasToc ? '      .toc-item.lvl-3 { padding-left:1.8rem; font-size:0.85rem; }' : '',
    hasToc ? '      .toc-item.lvl-4 { padding-left:2.6rem; font-size:0.8rem; }' : '',
    hasToc ? '      .toc-item.hide { display:none; }' : '',
    hasToc ? '      .toc-item.active { color:var(--text-color); font-weight:700; }' : '',
    hasToc ? '      .toc-item.active::before { content:""; position:absolute; left:-2px; top:0.18rem; bottom:0.18rem; width:3px; background:var(--text-color); border-radius:2px; }' : '',
    hasToc ? '      @media (max-width:1250px) { .toc { display:none; } }' : '',
    '    </style>',
    '  </head>',
    '  <body>',
    tocHtml,
    '    <main class="container">',
    '      <a class="back" href="' + up + 'writings.html">← Writings</a>',
    provHtml,
    '      <h1>' + title + '</h1>',
    subtitle ? '      <p class="subtitle">' + subtitle + '</p>' : '',
    '      <p class="meta">' + escapeHtml(dateStr) + ' · ' + minutes + ' min</p>',
    '      ' + bodyHtml,
    footHtml,
    '    </main>',
    tocScript,
    provScript,
    '  </body>',
    '</html>',
    '',
  ].filter((l) => l !== '').join('\n')
}

// Insert a new <li> into writings.html's post list (or fail loudly if the layout is missing).
// Returns true when the index changed (the new text is queued on `sink`).
async function updateWritingsIndex(sink, post) {
  const r = await fetch('/writings.html', { cache: 'no-store' })
  if (!r.ok) throw new Error('writings.html not found at the project root.')
  let text = await r.text()

  const liId = 'post-' + post.slug
  if (text.includes('id="' + liId + '"')) return false // already listed

  const thumbInner = post.thumb
    ? '<img src="' + post.thumb + '" alt="" onerror="this.parentNode.classList.add(\'no-img\');this.remove();" />'
    : ''
  const li =
    '\n        <li class="post" id="' + liId + '">\n' +
    '          <a class="post-thumb" href="writings/' + post.slug + '.html">' + thumbInner + '</a>\n' +
    '          <div class="post-info">\n' +
    '            <a class="post-title" href="writings/' + post.slug + '.html">' + escapeHtml(post.title) + '</a>\n' +
    '            <p class="post-meta">' + escapeHtml(post.date) + ' · ' + post.minutes + ' min</p>\n' +
    '          </div>\n' +
    '        </li>'

  if (text.includes('class="post-list"')) {
    // function replacer inserts `li` verbatim ($ in the title can't act as a special pattern)
    text = text.replace(/(<ul class="post-list"[^>]*>)/, (m) => m + li)
  } else {
    throw new Error('No <ul class="post-list"> in writings.html — open it once so the new layout is in place.')
  }
  await sink.add('writings.html', text)
  return true
}

/* -------------------------------------------------------- server (stamp / state) */
// The local editor server (editor-server.py) writes the files, does the OpenTimestamps
// work, keeps the private per-draft share tokens, and commits + pushes the site repo.
async function apiJson(url, opts) {
  const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}))
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) throw new Error(j.error || ('server ' + r.status))
  return j
}
// Manifest as it exists on disk (source of truth for the next version number).
async function readManifest(slug) {
  try {
    const m = await apiJson('/api/proofs?slug=' + encodeURIComponent(slug))
    if (m && Array.isArray(m.versions)) return m
  } catch (e) { /* no manifest yet / server down */ }
  return { slug, versions: [] }
}
// Stable unlisted token for a draft id, kept privately by the server (drafts/.publish-state.json).
async function shareTokenFor(docId) {
  const state = await apiJson('/api/publish-state')
  let token = state.shares && state.shares[docId]
  if (!token) {
    token = randomToken()
    await apiJson('/api/publish-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shares: { [docId]: token } }) })
  }
  return token
}

/* --------------------------------------------------------------------- wire up */
function setMsg(el, html, kind) {
  if (!el) return
  el.className = 'modal-msg' + (kind ? ' ' + kind : '')
  el.innerHTML = html
}

/**
 * setupPublish — wire the Publish button + modal.
 * @param {{ editor: import('../vendor/lib.bundle.js').Editor, currentSnapshot: () => object }} deps
 * @returns {{ open: () => void, publish: () => Promise<void> }}
 */
export function setupPublish({ editor, currentSnapshot }) {
  let pendingThumb = null   // { dataUrl, ext } | { path } | null
  let mode = 'publish'      // 'publish' | 'draft'
  let busy = false

  const readingMinutes = () => {
    const words = ((editor.state.doc.textContent || '').trim().match(/\S+/g) || []).length
    return Math.max(1, Math.round(words / 200))
  }
  const wordCount = () => ((editor.state.doc.textContent || '').trim().match(/\S+/g) || []).length

  function setMode(m) {
    mode = m
    document.querySelectorAll('#pubMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m))
    $('pubPublishFields').hidden = m !== 'publish'
    $('pubDraftFields').hidden = m !== 'draft'
    $('publishConfirm').textContent = m === 'draft' ? 'Create draft link' : 'Publish'
    $('pubSub').textContent = m === 'draft'
      ? 'Pushes an unlisted copy you can send to a few readers. Not in the writings list, not indexed, no version or timestamp. Re-running overwrites the same link.'
      : 'Publishes to writings/, freezes a numbered version, anchors its SHA-256 fingerprint in the Bitcoin blockchain (OpenTimestamps), and pushes to GitHub.'
    setMsg($('publishMsg'), '', '')
  }

  // Default thumbnail = the article's first image. The user can still pick another.
  function seedThumbFromBody(bodyHtml) {
    const src = firstImageSrc(bodyHtml)
    const drop = $('thumbDrop')
    pendingThumb = null
    if (!src) { drop.textContent = 'Click to choose an image'; drop.classList.remove('has-img'); return }
    if (src.startsWith('data:')) {
      const ext = ((src.substring(5, src.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg'))
      pendingThumb = { dataUrl: src, ext }
    } else {
      pendingThumb = { path: src }
    }
    drop.innerHTML = '<img src="' + src.replace(/"/g, '&quot;') + '" alt="thumb"/><span class="thumb-hint">first image in the article · click to change</span>'
    drop.classList.add('has-img')
  }

  async function showVersionInfo(slug) {
    const el = $('pubVersionInfo')
    if (!el) return
    el.textContent = ''
    try {
      const m = await apiJson('/api/proofs?slug=' + encodeURIComponent(slug))
      const vs = m.versions || []
      if (!vs.length) { el.textContent = 'First publish → v1.'; return }
      const last = vs[vs.length - 1]
      const pending = vs.filter((v) => v.status === 'pending').length
      el.textContent = 'Published before: v' + last.n + ' on ' + longDate(last.date) + '. Text changes publish as v' + (last.n + 1) + '; unchanged text re-uses v' + last.n + '.'
        + (pending ? ' ' + pending + ' proof' + (pending > 1 ? 's' : '') + ' still awaiting Bitcoin confirmation.' : '')
    } catch (e) {
      el.textContent = 'Editor server not reachable — start run-editor.command to publish.'
    }
  }

  function openPublish() {
    const snap = currentSnapshot()
    const titleText = htmlToText(snap.title)
    if (!titleText) { toast('Add a title first'); return }
    $('pubSlug').value = slugify(titleText)
    $('pubDate').value = todayLong()
    seedThumbFromBody(snap.body)
    setMode('publish')
    showVersionInfo(slugify(titleText))
    $('publishOverlay').classList.remove('hidden')
  }
  const closePublish = () => { if (!busy) $('publishOverlay').classList.add('hidden') }

  function chooseThumb() {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/*'
    inp.onchange = () => {
      const f = inp.files[0]
      if (!f) return
      const r = new FileReader()
      r.onload = () => {
        pendingThumb = { dataUrl: r.result, ext: (f.name.split('.').pop() || 'png').toLowerCase() }
        $('thumbDrop').innerHTML = '<img src="' + r.result + '" alt="thumb"/>'
        $('thumbDrop').classList.add('has-img')
      }
      r.readAsDataURL(f)
    }
    inp.click()
  }

  // Thumbnail → top-level media/<slug>-thumb.<ext> (site convention); returns the path
  // relative to writings.html, or '' when there is none.
  async function writeThumb(sink, slug) {
    if (!pendingThumb) return ''
    if (pendingThumb.dataUrl) {
      const name = slug + '-thumb.' + pendingThumb.ext
      await sink.add('media/' + name, dataUrlToBlob(pendingThumb.dataUrl))
      return 'media/' + name
    }
    const p = pendingThumb.path || ''
    if (/^https?:/i.test(p)) return p
    if (p.startsWith('media/')) return 'writings/' + p        // article-relative → index-relative
    if (p.startsWith('../media/')) return 'writings/' + p.slice(3)
    return p.startsWith('/') ? p.slice(1) : p
  }

  async function doPublish() {
    if (busy) return
    const msg = $('publishMsg')
    const snap = currentSnapshot()
    const titleText = htmlToText(snap.title)
    if (!titleText) { setMsg(msg, 'Add a title before publishing.', 'err'); return }
    const slug = slugify($('pubSlug').value)
    if (!slug) { setMsg(msg, 'Add a slug before publishing.', 'err'); return }
    const dateStr = ($('pubDate').value || '').trim() || todayLong()
    const draft = mode === 'draft'
    busy = true
    $('publishConfirm').disabled = true
    setMsg(msg, draft ? 'Creating draft link…' : 'Publishing…', '')
    try {
      const sink = makeSink()
      const mediaPrefix = draft ? '../media/' : 'media/'

      // 1) split inline data-URI images out to writings/media/<slug>-<hash>.<ext>
      //    (footnote images likewise, as <slug>-fn-<hash>.<ext>)
      const { html: bodyHtml, files, toc } = await buildBody(snap.body, slug, mediaPrefix)
      const { html: footHtml, files: fnFiles } = await buildFootnotesHtml($('fnList'), slug, mediaPrefix)
      files.push(...fnFiles)
      for (const f of files) await sink.add('writings/media/' + f.name, f.blob)

      const minutes = readingMinutes()
      const subtitleText = htmlToText(snap.subtitle)
      const common = { titleText, subtitleText, dateStr, minutes, font: snap.font, bodyHtml, footHtml, toc, slug }
      const site = (CONFIG.siteUrl || '').replace(/\/$/, '')

      /* ---------------------------------------------------------- draft link */
      if (draft) {
        const token = await shareTokenFor(snap.id || 'doc')
        const html = buildArticleHtml(Object.assign({}, common, { draft: true }))
        const rel = 'writings/p/' + token + '.html'
        await sink.add(rel, html)
        const url = site + '/' + rel
        $('draftUrl').value = url
        setMsg(msg, 'Writing files…', '')
        const written = await sink.flush()
        setMsg(msg, 'Committing &amp; pushing…', '')
        const git = await sitePush(written, 'Draft preview: ' + titleText)
        setMsg(msg, 'Draft link pushed (' + escapeHtml(git.detail || 'done') + '). Live in about a minute at <a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>.', 'ok')
        toast('Draft link pushed')
        return
      }

      /* ------------------------------------------------- versioned publish */
      // Version = a change to the TEXT (title/subtitle/body/footnotes). Date/font-only edits
      // don't mint a new version; identical text re-uses the existing one (idempotent).
      const contentSha = await sha256Hex(utf8([titleText, subtitleText, bodyHtml, footHtml].join('\n \n')))
      const manifest = await readManifest(slug)
      const versions = manifest.versions || []
      const same = versions.find((v) => v.contentSha256 === contentSha)
      const maxN = versions.reduce((a, v) => Math.max(a, v.n || 0), 0)
      const n = same ? same.n : maxN + 1
      const versionDate = same ? same.date : new Date().toISOString()

      let stampNote = ''
      let sha = null
      if (same && same.ots) {
        stampNote = 'Text unchanged since v' + n + ' (' + longDate(same.date) + ') — no new version or timestamp.'
      } else {
        // 2) frozen copy + live page, byte-identical (the frozen file is what gets hashed)
        const html = buildArticleHtml(Object.assign({}, common, { version: { n, date: versionDate } }))
        const bytes = utf8(html)
        sha = await sha256Hex(bytes)
        await sink.add('writings/' + slug + '.v' + n + '.html', bytes)
        await sink.add('writings/' + slug + '.html', bytes)
      }

      // 3) thumbnail (default: first image) → media/<slug>-thumb.<ext>
      const thumbPath = await writeThumb(sink, slug)

      // 4) update the writings.html index list
      if ($('pubUpdateList').checked) {
        await updateWritingsIndex(sink, { slug, title: titleText, date: dateStr, minutes, thumb: thumbPath })
      }

      setMsg(msg, 'Writing files…', '')
      const written = await sink.flush()

      // 5) anchor the fingerprint in Bitcoin (server → OpenTimestamps calendars)
      if (sha) {
        setMsg(msg, 'Timestamping…', '')
        try {
          const r = await apiJson('/api/stamp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, n, sha256: sha, contentSha256: contentSha, date: versionDate, title: titleText, words: wordCount() }),
          })
          const cals = (r.entry && r.entry.calendars || []).length
          stampNote = 'v' + n + ' fingerprint <code>' + sha.slice(0, 12) + '…</code> submitted to ' + cals + ' OpenTimestamps calendar' + (cals === 1 ? '' : 's') +
            '; Bitcoin confirmation usually lands within a few hours and is pushed automatically.'
        } catch (e) {
          stampNote = '<b>Not timestamped:</b> ' + escapeHtml(e.message || 'server error') + '. Run Publish again (same text re-uses v' + n + ') to retry.'
        }
      }

      // 6) commit + push everything this publish touched (proofs included)
      setMsg(msg, 'Committing &amp; pushing…', '')
      const git = await sitePush(written.concat(['writings/proofs']), 'Publish: ' + titleText + ' (v' + n + ')')
      const url = site + '/writings/' + slug + '.html'
      setMsg(msg, 'Published v' + n + ' — ' + escapeHtml(git.detail || 'pushed') + '. Live in about a minute at <a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>. ' + stampNote, 'ok')
      toast('Published v' + n + ' ✓')
      showVersionInfo(slug)
    } catch (err) {
      setMsg(msg, escapeHtml(err.message || 'Publish failed.'), 'err')
    } finally {
      busy = false
      $('publishConfirm').disabled = false
    }
  }

  $('publishBtn').addEventListener('click', openPublish)
  $('publishClose').addEventListener('click', closePublish)
  $('publishConfirm').addEventListener('click', doPublish)
  $('thumbDrop').addEventListener('click', chooseThumb)
  document.querySelectorAll('#pubMode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))
  $('draftCopy').addEventListener('click', async () => {
    const v = $('draftUrl').value
    if (!v) return
    try { await navigator.clipboard.writeText(v); toast('Link copied') } catch (e) { $('draftUrl').select() }
  })
  // click the dark backdrop (not the modal) to dismiss
  $('publishOverlay').addEventListener('mousedown', (e) => { if (e.target === $('publishOverlay')) closePublish() })

  return { open: openPublish, publish: doPublish }
}
