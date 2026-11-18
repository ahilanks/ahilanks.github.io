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
// PRIVATE: a draft snapshot also carries `notes` (the editor's sticky note) and comments.
// Neither may ever reach a published page or draft link — build only from title,
// subtitle, body and the footnote list.
import { CONFIG, LS } from './config.js'
import { normalizeStyle, styleKey } from './style.js'
import { levelsFor } from './equation-levels.js'
import { CANVAS_CSS, canvasForPublish, canvasPlace } from './nodes/canvas.js'
import { extractEmbeds, embedsForPublish, EMBED_CSS, embedResize } from './nodes/embed.js'

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
const DRAFT_MEDIA = '/drafts/media/'
async function fetchDraftMedia(src) {
  const r = await fetch(src, { cache: 'no-store' })
  if (!r.ok) throw new Error('Missing image ' + src.split('/').pop() + ' — publish stopped')
  return r.blob()
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
const SANITIZE_ALLOW = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'SUP', 'SUB', 'HR', 'FIGURE', 'IMG', 'FIGCAPTION', 'SPAN', 'DIV', 'VIDEO', 'DETAILS', 'SUMMARY'])
const SANITIZE_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt', 'width', 'height', 'style'], VIDEO: ['src', 'controls', 'playsinline', 'preload', 'loop', 'muted', 'poster', 'width', 'height'], SPAN: ['data-tex', 'data-display'], DIV: ['data-tex', 'data-display', 'data-h', 'data-x', 'data-y', 'data-w', 'data-fs', 'data-left', 'data-width', 'data-dy', 'data-embed'], P: ['data-levels', 'data-anchor'], SUP: ['data-fn'], H2: ['data-anchor'], H3: ['data-anchor'], H4: ['data-anchor'], SUMMARY: ['data-level', 'data-anchor'], FIGURE: ['data-w', 'data-pair', 'data-crop'] }
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
      // only the blurred stand-in that extractDataImages sets (see optimizeImage)
      if (el.hasAttribute('style') && !LQIP_STYLE.test(el.getAttribute('style'))) el.removeAttribute('style')
      for (const d of ['width', 'height']) if (el.hasAttribute(d) && !/^\d{1,5}$/.test(el.getAttribute(d))) el.removeAttribute(d)
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

// Sections marked "In progress" reach readers as the heading and this note. Everything else in
// them is cut here, before media and footnotes are worked out, so none of it (text, images,
// videos, notes) ends up in the public files. A section ends at the next heading of the same
// or a higher level, so a marked section takes its subsections with it.
const IN_PROGRESS_NOTE = 'This section is in progress.'
function holdBackSections(bodyHtml) {
  const d = document.createElement('div')
  d.innerHTML = bodyHtml || ''
  const titles = []
  const cutAnchors = new Set()
  const isHeading = (el) => /^H[1-6]$/.test(el.tagName)
  Array.from(d.querySelectorAll(':scope > [data-in-progress], .collapsible-body > [data-in-progress]')).forEach((h) => {
    if (!d.contains(h)) return // inside a marked section above it, already gone
    h.removeAttribute('data-in-progress')
    titles.push((h.textContent || '').trim())
    const level = +h.tagName[1]
    let next = h.nextElementSibling
    while (next && !(isHeading(next) && +next.tagName[1] <= level)) {
      const el = next
      next = next.nextElementSibling
      el.querySelectorAll('[data-anchor]').forEach((a) => cutAnchors.add(a.getAttribute('data-anchor')))
      if (el.hasAttribute('data-anchor')) cutAnchors.add(el.getAttribute('data-anchor'))
      el.remove()
    }
    const note = document.createElement('p')
    note.className = 'in-progress'
    note.textContent = IN_PROGRESS_NOTE
    h.after(note)
  })
  // a link to something cut would lead nowhere: keep its words, drop the link
  let deadLinks = 0
  d.querySelectorAll('a[href^="#"]').forEach((a) => {
    if (cutAnchors.has(a.getAttribute('href').slice(1))) { a.replaceWith(...a.childNodes); deadLinks++ }
  })
  return { html: d.innerHTML, titles, deadLinks }
}

// Turn a detached clone of the serialised body into clean published HTML:
// math nodes -> $..$ / $$..$$ text for KaTeX auto-render, footnote refs -> numbered anchors.
// Also gives every non-empty H2/H3 an id and returns the contents-panel entries
// ({ id, text, level, n }, where n is the §-number counted over H2s only).
function bodyToPublishHtml(clone, { sliders = true, poemDates = false } = {}) {
  // a poem's own date (Style → Dates → Under each poem) → a line under its heading
  clone.querySelectorAll('[data-date]').forEach((h) => {
    const date = (h.getAttribute('data-date') || '').trim()
    h.removeAttribute('data-date')
    if (!poemDates || !date || !/^H[1-6]$/.test(h.tagName)) return
    const p = document.createElement('p')
    p.className = 'poem-date'
    p.textContent = date
    h.after(p)
  })
  // review comments are editor-only: unwrap their anchor spans, keep the words
  clone.querySelectorAll('span[data-comment]').forEach((s) => s.replaceWith(...s.childNodes))
  // inline math -> literal $tex$ text
  clone.querySelectorAll('.math-inline').forEach((m) => m.replaceWith(document.createTextNode('$' + (m.dataset.tex || '') + '$')))
  // block math -> a centred (or aligned) paragraph carrying $$tex$$
  clone.querySelectorAll('.math-block').forEach((m) => {
    const p = document.createElement('p')
    p.className = 'math-block' + (m.dataset.align ? ' align-' + m.dataset.align : '')
    p.textContent = '$$' + (m.dataset.tex || '') + '$$'
    const levels = sliders ? levelsFor(m.dataset.tex || '', m.getAttribute('data-levels')) : null
    if (levels) p.setAttribute('data-levels', JSON.stringify({ labeled: levels.labeled, simplified: levels.simplified, full: levels.full, why: levels.why }))
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
  // the first picture is wanted at once; the rest load as the reader nears them
  clone.querySelectorAll('img').forEach((img, i) => {
    img.setAttribute('decoding', 'async')
    if (i === 0) img.setAttribute('fetchpriority', 'high')
    else img.setAttribute('loading', 'lazy')
  })
  canvasForPublish(clone) // canvas boxes: saved geometry → inline styles
  embedsForPublish(clone) // diagram slots → sandboxed frames
  // resized figures: convert the validated data-w (kept through sanitise) into an inline width
  clone.querySelectorAll('figure[data-w]').forEach((f) => {
    const w = Math.max(20, Math.min(100, parseFloat(f.getAttribute('data-w')) || 100))
    f.removeAttribute('data-w')
    if (w < 100) f.setAttribute('style', 'width:' + w + '%;margin-left:auto;margin-right:auto;')
  })
  // cropped videos: the kept box "x y w h" (fractions) → object-view-box on the player
  clone.querySelectorAll('figure[data-crop]').forEach((f) => {
    const n = f.getAttribute('data-crop').split(/\s+/).map(Number)
    f.removeAttribute('data-crop')
    const v = f.querySelector('video')
    if (!v || n.length !== 4 || !n.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) return
    const pct = (x) => +(x * 100).toFixed(3) + '%'
    v.setAttribute('style', 'object-view-box:inset(' + pct(n[1]) + ' ' + pct(1 - n[0] - n[2]) + ' ' + pct(1 - n[1] - n[3]) + ' ' + pct(n[0]) + ');')
  })
  // contents panel: anchor + collect every non-empty H2/H3/H4 (ids survive sanitizeNode
  // above). Depth comes from the distinct levels actually used (a doc written all in H3s
  // still gets §-numbered sections; H4s directly under H2s still nest one step): depth 0
  // (level 2) is §-numbered, depths 1/2 (levels 3/4) are sub-entries the page script
  // progressively discloses while their parent section / sub-section is being read.
  const hs = []
  clone.querySelectorAll('h2, h3, h4').forEach((h) => {
    const text = (h.textContent || '').trim()
    // inside a collapsible section it gets an id but stays out of the contents panel
    if (text) hs.push({ h, text, lvl: +h.tagName[1], folded: !!h.closest('details') })
  })
  const lvls = Array.from(new Set(hs.filter((e) => !e.folded).map((e) => e.lvl))).sort()
  const toc = []
  const usedIds = new Set()
  // a collapsible section's title: the anchor links use, and something for readers to click
  clone.querySelectorAll('summary').forEach((s) => {
    const anchor = s.getAttribute('data-anchor')
    s.removeAttribute('data-anchor')
    if (anchor && /^[\w-]+$/.test(anchor) && !usedIds.has(anchor)) { usedIds.add(anchor); s.id = anchor }
    if (!s.textContent.trim() && !s.querySelector('img')) s.textContent = 'More'
  })
  let secN = 0
  hs.forEach((e) => {
    const depth = lvls.indexOf(e.lvl)
    if (depth === 0) secN++
    // a heading something links to keeps its stable anchor (section-links.js) as its id
    const anchor = e.h.getAttribute('data-anchor')
    e.h.removeAttribute('data-anchor')
    if (anchor && /^[\w-]+$/.test(anchor) && !usedIds.has(anchor)) { usedIds.add(anchor); e.h.id = anchor }
    else e.h.id = headingId(e.text, usedIds)
    if (e.folded) return
    toc.push({ id: e.h.id, text: e.text, level: depth + 2, n: depth === 0 ? secN : 0 })
  })
  clone.querySelectorAll('h2[data-anchor], h3[data-anchor], h4[data-anchor]').forEach((h) => h.removeAttribute('data-anchor'))
  // a paragraph something links to (section-links.js): its anchor becomes its id
  clone.querySelectorAll('p[data-anchor]').forEach((p) => {
    const anchor = p.getAttribute('data-anchor')
    p.removeAttribute('data-anchor')
    if (/^[\w-]+$/.test(anchor) && !usedIds.has(anchor)) { usedIds.add(anchor); p.id = anchor }
  })
  // links to a section of this article stay in the tab
  clone.querySelectorAll('a[href^="#"]').forEach((a) => { a.removeAttribute('target'); a.removeAttribute('rel') })
  return { html: clone.innerHTML, toc }
}

// Rewrite every data-URI <img> under `root` to <mediaPrefix><prefix>-<hash12>.<ext>, pushing
// the bytes onto `files`. Names carry a content hash so a re-publish never overwrites an
// image an older frozen version still references (and identical images are written once).
// Images the editor stored as files on the local server (GIFs: figures.js → /api/gif) are
// copied out the same way.
// Pictures are published at the size the page can show — the 820px column at 2x for retina —
// and recompressed (a 4096px photo straight off the web is ~2 MB; this makes it ~200 KB).
// Each also gets its width/height (so the page keeps its place while it loads) and a tiny
// blurred copy as its background, seen until the real picture arrives. No animation.
const IMG_MAX_W = 1640
const LQIP_STYLE = /^background:#[0-9a-f]{6} url\(data:image\/jpeg;base64,[A-Za-z0-9+\/=]+\) center\/cover no-repeat$/
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
async function optimizeImage(blob, ext, maxW = IMG_MAX_W) {
  let bmp
  try { bmp = await createImageBitmap(blob) } catch (e) { return { blob, ext } }
  const w0 = bmp.width, h0 = bmp.height
  if (ext === 'gif' || ext === 'svg' || !w0 || !h0) return { blob, ext, w: w0, h: h0 } // animated / vector: as is
  const k = Math.min(1, maxW / w0)
  const w = Math.round(w0 * k), h = Math.round(h0 * k)
  // transparency? (a PNG with a see-through background stays a PNG, without a stand-in)
  const probe = canvasOf(48, Math.max(1, Math.round(48 * h0 / w0)))
  const pg = probe.getContext('2d', { willReadFrequently: true })
  pg.drawImage(bmp, 0, 0, probe.width, probe.height)
  const px = pg.getImageData(0, 0, probe.width, probe.height).data
  let alpha = false
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { alpha = true; break }
  let out = blob, outExt = ext
  if (k < 1 || blob.size > 350 * 1024) {
    const c = canvasOf(w, h)
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(bmp, 0, 0, w, h)
    const type = alpha ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const b = await new Promise((r) => c.toBlob(r, type, 0.84))
    if (b && (b.size < blob.size || k < 1)) { out = b; outExt = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg' }
  }
  let lqip = ''
  if (!alpha) {
    const t = canvasOf(32, Math.max(1, Math.round(32 * h / w)))
    const tg = t.getContext('2d')
    tg.drawImage(bmp, 0, 0, t.width, t.height)
    const d = tg.getImageData(0, 0, t.width, t.height).data // its average colour, under the blur
    let r = 0, gg = 0, bb = 0, n = 0
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++ }
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0')
    lqip = 'background:#' + hex(r) + hex(gg) + hex(bb) + ' url(' + t.toDataURL('image/jpeg', 0.5) + ') center/cover no-repeat'
  }
  return { blob: out, ext: outExt, w, h, lqip }
}

async function extractDataImages(root, prefix, files, mediaPrefix) {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    let ext, blob
    if (src.startsWith('data:')) {
      ext = (src.substring(5, src.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg')
      blob = dataUrlToBlob(src)
    } else if (src.startsWith(DRAFT_MEDIA)) {
      ext = src.split('.').pop().toLowerCase()
      blob = await fetchDraftMedia(src)
    } else continue
    const o = await optimizeImage(blob, ext)
    blob = o.blob
    ext = o.ext
    if (img.closest('figure.img-block')) { // canvas pictures size themselves
      if (o.w && o.h) { img.setAttribute('width', String(o.w)); img.setAttribute('height', String(o.h)) }
      if (o.lqip) img.setAttribute('style', o.lqip)
    }
    const hash = (await sha256Hex(await blob.arrayBuffer())).slice(0, 12)
    const name = prefix + '-' + hash + '.' + ext
    if (!files.some((f) => f.name === name)) files.push({ name, blob })
    img.setAttribute('src', mediaPrefix + name)
  }
}

// Uploaded videos carry only a vid in the saved HTML; their bytes sit behind the live
// editor's <video> (a blob: URL from IndexedDB, or the drafts/media disk backup). Copy each
// to <mediaPrefix><prefix>-<hash12>.<ext> like images. A video that can't be loaded, or is
// over GitHub's file cap, is left out (a player with no file would just be a black box).
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv' }
const VIDEO_MAX_BYTES = 95 * 1024 * 1024
async function extractVideos(root, prefix, files, mediaPrefix) {
  const skipped = []
  for (const fig of Array.from(root.querySelectorAll('figure.video-block'))) {
    const v = fig.querySelector('video')
    const vid = fig.getAttribute('data-vid')
    const live = vid && document.querySelector('.ProseMirror figure.video-block[data-vid="' + CSS.escape(vid) + '"] video')
    const src = live && (live.currentSrc || live.getAttribute('src'))
    let blob = null
    try { if (src) { const r = await fetch(src); if (r.ok) blob = await r.blob() } } catch (e) { /* skipped below */ }
    if (!v || !blob || !blob.size || blob.size > VIDEO_MAX_BYTES) {
      skipped.push(blob && blob.size > VIDEO_MAX_BYTES ? 'a video over 95 MB' : 'a video that hasn\'t loaded')
      fig.remove(); continue
    }
    const ext = VIDEO_EXT[blob.type] || (src.match(/\.(mp4|webm|mov|ogv)(?:[?#]|$)/i) || [, 'mp4'])[1].toLowerCase()
    const hash = (await sha256Hex(await blob.arrayBuffer())).slice(0, 12)
    const name = prefix + '-' + hash + '.' + ext
    if (!files.some((f) => f.name === name)) files.push({ name, blob })
    v.setAttribute('src', mediaPrefix + name)
  }
  if (skipped.length) toast('Left out ' + skipped.join(', '))
}

// Split inline data-URI images and uploaded videos out to media/ files, then
// return { html, files, toc } ready for buildArticleHtml + writeFile.
async function buildBody(bodyHtml, slug, mediaPrefix, opts) {
  const clone = document.createElement('div')
  clone.innerHTML = bodyHtml || ''
  const files = []
  await extractDataImages(clone, slug, files, mediaPrefix)
  await extractVideos(clone, slug, files, mediaPrefix)
  await extractEmbeds(clone, slug, files, mediaPrefix)
  const { html, toc } = bodyToPublishHtml(clone, opts)
  return { html, files, toc }
}

// Pull the numbered footnote bodies from the live (already reconciled) #fnList.
// Orphaned bodies (ref deleted in the text) are editor-only and never published.
// Images embedded in footnotes are split out to media/<slug>-fn-<hash>.<ext> like body images;
// returns { html, files }.
async function buildFootnotesHtml(fnListEl, slug, mediaPrefix, bodyHtml) {
  // only notes whose marker made it into the published text: the numbering then matches
  const probe = document.createElement('div')
  probe.innerHTML = bodyHtml || ''
  const kept = new Set(Array.from(probe.querySelectorAll('.fn-ref'), (r) => r.getAttribute('data-fn')))
  const items = fnListEl ? Array.from(fnListEl.children).filter((li) => !li.classList.contains('fn-orphan') && kept.has(li.dataset.fn)) : []
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
  let html = '\n      <hr class="fn-divider" />\n      <div class="fn-label">Footnotes</div>\n      <ol class="footnotes">\n'
  Array.from(wrap.children).forEach((bodyClone, idx) => {
    const n = idx + 1 // index order matches the re-numbered body refs above
    // The note's number is its link back to the marker (no trailing ↩ glyph).
    html += '        <li id="fn-' + n + '"><a class="fn-back" href="#fnref-' + n + '" aria-label="Back to text">' + n + '.</a><div class="fn-text">' + bodyClone.innerHTML + '</div></li>\n'
  })
  html += '      </ol>\n'
  return { html, files }
}

/* ------------------------------------------------------------ copy for Substack */
// The published article's body as rich HTML for Substack's editor: images and links made
// absolute (Substack copies the images in on paste), editor/page-only parts dropped, folds
// opened, footnote markers as plain superscripts with the notes listed at the end. Title and
// subtitle go in Substack's own fields. Math stays as LaTeX text (Substack can't take it).
async function substackHtml(slug) {
  const site = (CONFIG.siteUrl || '').replace(/\/$/, '')
  const r = await fetch('/writings/' + encodeURIComponent(slug) + '.html', { cache: 'no-store' })
  if (!r.ok) throw new Error('Publish it first: Substack needs the images online.')
  const page = new DOMParser().parseFromString(await r.text(), 'text/html')
  const main = page.querySelector('main') || page.body
  main.querySelectorAll('script, style, nav, h1, .subtitle, .meta, .prov, .draft-note, .back, .home, .end-home, .fn-divider, .fn-label, .fn-back, .canvas-item, button').forEach((el) => el.remove())
  const base = site + '/writings/' + slug + '.html'
  // diagrams can't run on Substack: a link to see them on the site
  main.querySelectorAll('figure.embed').forEach((f) => { const c = f.querySelector('figcaption'); f.outerHTML = '<p><em><a href="' + base + '">Interactive diagram: see it on the site</a></em></p>' + (c ? '<p><em>' + c.innerHTML + '</em></p>' : '') })
  main.querySelectorAll('img[src]').forEach((img) => { img.src = new URL(img.getAttribute('src'), base).href })
  main.querySelectorAll('a[href]').forEach((a) => {
    const h = a.getAttribute('href')
    if (h.startsWith('#')) { if (a.closest('sup')) a.replaceWith(...a.childNodes); else a.removeAttribute('href') }
    else a.href = new URL(h, base).href
  })
  // folds: their title as a heading, their text in the open
  main.querySelectorAll('details').forEach((d) => {
    const sum = d.querySelector('summary')
    const h = page.createElement('h3')
    if (sum) { h.innerHTML = sum.innerHTML; sum.remove() }
    d.replaceWith(h, ...d.childNodes)
  })
  main.querySelectorAll('ol.footnotes').forEach((ol) => {
    const h = page.createElement('h3'); h.textContent = 'Notes'
    ol.before(h)
    ol.querySelectorAll('.fn-text').forEach((t) => t.replaceWith(...t.childNodes))
  })
  // a poem: each stanza one paragraph, its lines joined by line breaks (Substack spaces paragraphs apart)
  if (page.body.classList.contains('poem')) {
    const kids = Array.from(main.children)
    let stanza = null
    for (const el of kids) {
      const line = el.tagName === 'P' && !el.className
      if (!line) { stanza = null; continue }
      if (!el.textContent.trim() && !el.querySelector('img')) { el.remove(); stanza = null; continue }
      if (stanza) { stanza.append(page.createElement('br'), ...el.childNodes); el.remove() } else stanza = el
    }
  }
  main.querySelectorAll('[id], [class], [style], [data-levels], [data-dy]').forEach((el) => {
    ;['id', 'class', 'style', 'data-levels', 'data-dy'].forEach((a) => el.removeAttribute(a))
  })
  // where it came from: the writings page (not this one article)
  const home = '<p><em>Originally published at <a href="' + site + '/writings.html">' + site.replace(/^https?:\/\//, '') + '</a>.</em></p>'
  return { html: main.innerHTML.trim() + home, math: /\$[^$\s][^$]*\$/.test(main.textContent || '') }
}

/* ------------------------------------------------------ footnote round trip (page) */
// Runs INSIDE the published article (embedded via fnTrip.toString(), same rules as
// provWidget below). A footnote marker glides to its note and raises a floating
// "Back to reading" pill that returns to the exact spot the reader left — the jump is a
// history entry, so the browser's Back does the same. A note's number makes the same trip home,
// or, when the reader scrolled down to the notes on their own, centres its marker. The
// pill drops away if the reader scrolls back up by hand.
function fnTrip() {
  var pill = document.getElementById('fnReturn')
  if (!pill) return
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  var trip = null // { y, ref, n, left } while the reader is away at note n

  // Lights up as the glide comes in to land — once the target nears the middle of the
  // screen, or the page stops — not at the click, so it's lit when the reader arrives; then
  // holds a while after the page comes to rest before fading. Shows which note (or, on the
  // way back, which marker) they landed on.
  function flash(el) {
    var token = el._fnFlash = {}
    var lit = false
    el.classList.remove('fn-flash', 'fn-flash-fade')
    function light() {
      if (lit || el._fnFlash !== token) return
      lit = true
      void el.offsetWidth // restart, if it was already lit
      el.classList.add('fn-flash')
    }
    function near() {
      var r = el.getBoundingClientRect()
      return Math.abs(r.top + r.height / 2 - window.innerHeight / 2) < window.innerHeight * 0.25
    }
    var last = window.scrollY, still = 0, t0 = Date.now()
    function tick() {
      if (near()) light()
      var y = window.scrollY
      still = y === last ? still + 1 : 0
      last = y
      if (still < 8 && Date.now() - t0 < 3000) { requestAnimationFrame(tick); return }
      light()
      setTimeout(function () {
        if (el._fnFlash !== token) return
        el.classList.add('fn-flash-fade')
        setTimeout(function () { if (el._fnFlash === token) el.classList.remove('fn-flash', 'fn-flash-fade') }, 1200)
      }, 1800)
    }
    requestAnimationFrame(tick)
  }
  // focus without a second scroll, so Tab carries on from here
  function land(el) { el.focus({ preventScroll: true }) }
  function restore(mode) { if ('scrollRestoration' in history) history.scrollRestoration = mode }
  function end() { trip = null; pill.hidden = true }
  function home() {
    var t = trip
    end()
    if (!t) return
    window.scrollTo({ top: t.y, behavior: motion })
    flash(t.ref)
    land(t.ref.querySelector('a') || t.ref)
  }
  function goHome() {
    // pop the #fn-n entry pushed on the way out; popstate (below) then brings the reader home
    if (history.state && history.state.fnTrip) history.back()
    else home()
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    var a = e.target.closest && e.target.closest('a[href^="#fn"]')
    if (!a) return
    var href = a.getAttribute('href')
    var out = /^#fn-(\d+)$/.exec(href)
    var back = /^#fnref-(\d+)$/.exec(href)
    if (out) {
      var li = document.getElementById('fn-' + out[1])
      var ref = a.closest('sup')
      if (!li || !ref) return
      e.preventDefault()
      if (document.body.classList.contains('fn-side')) { // already beside its marker (fnSide)
        li.setAttribute('tabindex', '-1')
        li.scrollIntoView({ block: 'nearest', behavior: motion })
        flash(li)
        land(li)
        return
      }
      trip = { y: window.scrollY, ref: ref, n: out[1], left: false }
      // One entry per trip, however many markers are followed before coming back. The entry
      // left behind is 'manual': Chrome restores scroll AFTER popstate, so its remembered
      // spot (stale if the reader wandered back up and took another marker) would win over
      // home() and cut its glide short.
      if (history.state && history.state.fnTrip) history.replaceState({ fnTrip: true }, '', href)
      else { restore('manual'); history.pushState({ fnTrip: true }, '', href); restore('auto') }
      li.setAttribute('tabindex', '-1')
      li.scrollIntoView({ block: 'center', behavior: motion })
      flash(li)
      land(li)
      pill.hidden = false
    } else if (back) {
      e.preventDefault()
      if (trip && trip.n === back[1]) { goHome(); return }
      end()
      var sup = document.getElementById('fnref-' + back[1])
      if (!sup) return
      sup.scrollIntoView({ block: document.body.classList.contains('fn-side') ? 'nearest' : 'center', behavior: motion })
      flash(sup)
      land(sup.querySelector('a') || sup)
    }
  })
  pill.addEventListener('click', goHome)
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.fnTrip) return
    restore('auto') // back on the reading entry: reloads restore normally again
    if (trip) home()
  })
  window.addEventListener('scroll', function () {
    if (!trip) return
    if (Math.abs(window.scrollY - trip.y) > window.innerHeight * 0.6) trip.left = true
    else if (trip.left) end() // back at the text on their own
  }, { passive: true })
}

/* ------------------------------------------------------ footnote peek (page) */
// Runs INSIDE the published article (embedded via fnPeek.toString(), like fnTrip). Hovering
// a footnote marker shows its note in a small card beside it, in the text; the card stays
// while the pointer is on the marker or the card (a short grace period covers the gap, so
// its links can be clicked) and goes when it leaves both. On touch screens a tap on a marker
// opens the same card in place (no trip down to the notes); a tap anywhere outside it, or on
// the marker again, closes it.
// Runs INSIDE the published article. A link to something folded inside a collapsible section
// (a footnote's way home, a section link, an address with a #) opens it first, so there's
// somewhere to land. Capturing, so it happens before anything scrolls.
function collapsibleReveal() {
  function reveal(id) {
    var el = id && document.getElementById(id)
    for (var d = el && el.closest('details'); d; d = d.parentElement.closest('details')) d.open = true
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]')
    if (a) reveal(a.getAttribute('href').slice(1))
  }, true)
  function fromHash() { reveal(decodeURIComponent(location.hash.slice(1))) }
  window.addEventListener('hashchange', fromHash)
  fromHash()
}

function fnPeek() {
  var hover = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  var card = document.createElement('div')
  card.className = 'fn-peek'
  card.setAttribute('role', 'tooltip')
  card.id = 'fnPeek'
  card.hidden = true
  document.body.appendChild(card)
  var ref = null      // the marker the card is for
  var openT = 0, closeT = 0

  function markerOf(el) {
    var a = el && el.closest && el.closest('sup[id^="fnref-"] a[href^="#fn-"]')
    return a ? a.closest('sup') : null
  }
  function place() {
    var r = ref.getBoundingClientRect()
    var gutter = 16
    var w = Math.min(380, window.innerWidth - gutter * 2)
    card.style.width = w + 'px'
    var h = card.offsetHeight
    var below = window.innerHeight - r.bottom, above = r.top
    var up = below < h + 14 && above > below // flip above when it doesn't fit below
    var left = Math.max(gutter, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - gutter))
    card.style.left = (left + window.scrollX) + 'px'
    card.style.top = (up ? r.top - h - 8 : r.bottom + 8) + window.scrollY + 'px'
    card.classList.toggle('up', up)
  }
  function show(sup) {
    if (document.body.classList.contains('fn-side')) return // the note is already beside it (fnSide)
    var n = /^fnref-(\d+)$/.exec(sup.id)
    var li = n && document.getElementById('fn-' + n[1])
    if (!li) return
    ref = sup
    var body = li.cloneNode(true)
    body.removeAttribute('id')
    var backs = body.querySelectorAll('.fn-back')
    for (var i = 0; i < backs.length; i++) backs[i].remove()
    var ids = body.querySelectorAll('[id]')
    for (var k = 0; k < ids.length; k++) ids[k].removeAttribute('id')
    card.innerHTML = '<span class="fn-peek-n">' + n[1] + '</span><div class="fn-peek-body"></div>'
    card.lastChild.innerHTML = body.innerHTML
    card.hidden = false
    sup.setAttribute('aria-describedby', 'fnPeek')
    place()
  }
  function hide() {
    clearTimeout(openT); clearTimeout(closeT)
    if (ref) ref.removeAttribute('aria-describedby')
    ref = null
    card.hidden = true
  }
  function keep() { clearTimeout(closeT) }
  function leaveSoon() { clearTimeout(openT); clearTimeout(closeT); closeT = setTimeout(hide, 150) }

  if (!hover) {
    // capturing, so it runs before fnTrip's click handler (which skips a prevented click)
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('fn-side')) return // notes beside the text: fnTrip as usual
      var sup = markerOf(e.target)
      if (sup) {
        e.preventDefault()
        if (sup === ref && !card.hidden) hide()
        else show(sup)
        return
      }
      if (!card.hidden && !card.contains(e.target)) { e.preventDefault(); e.stopPropagation(); hide() }
    }, true)
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide() })
    window.addEventListener('resize', function () { if (ref) place() })
    return
  }

  document.addEventListener('mouseover', function (e) {
    if (card.contains(e.target)) { keep(); return }
    var sup = markerOf(e.target)
    if (!sup) return
    keep()
    if (sup === ref && !card.hidden) return
    clearTimeout(openT)
    openT = setTimeout(function () { show(sup) }, ref ? 0 : 60) // moving between markers: switch at once
  })
  document.addEventListener('mouseout', function (e) {
    var from = markerOf(e.target) || (card.contains(e.target) ? card : null)
    if (!from) return
    var to = e.relatedTarget
    if (to && (card.contains(to) || (ref && ref.contains(to)) || markerOf(to) === from)) return
    leaveSoon()
  })
  document.addEventListener('click', function (e) { if (markerOf(e.target)) hide() }, true) // off on the trip to the note
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide() })
  window.addEventListener('resize', function () { if (ref) place() })
}

/* ------------------------------------------------------ paragraph links (page) */
// Runs INSIDE the published article (embedded via paraPeek.toString(), like fnTrip). A link to
// a paragraph of the article (href "#p-…", section-links.js) shows that paragraph in a small
// card, like a footnote's: on hover with a mouse, on a tap on a touch screen (a tap outside
// closes it). Clicking the card (or, with a mouse, the link itself) goes to the paragraph and
// lights it up briefly; the browser's Back returns to where the reader was.
function paraPeek() {
  var hover = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  var card = document.createElement('div')
  card.className = 'fn-peek para-peek'
  card.setAttribute('role', 'tooltip')
  card.id = 'paraPeek'
  card.hidden = true
  document.body.appendChild(card)
  var link = null
  var openT = 0, closeT = 0

  function target(a) {
    var href = a.getAttribute('href') || ''
    var el = /^#p-[\w-]+$/.test(href) && document.getElementById(href.slice(1))
    return el && el.tagName === 'P' ? el : null
  }
  function linkOf(el) {
    var a = el && el.closest && el.closest('a[href^="#p-"]')
    return a && !card.contains(a) && target(a) ? a : null
  }
  function place() {
    var r = link.getBoundingClientRect()
    var gutter = 16
    var w = Math.min(420, window.innerWidth - gutter * 2)
    card.style.width = w + 'px'
    var h = card.offsetHeight
    var below = window.innerHeight - r.bottom, above = r.top
    var up = below < h + 14 && above > below
    var left = Math.max(gutter, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - gutter))
    card.style.left = (left + window.scrollX) + 'px'
    card.style.top = (up ? r.top - h - 8 : r.bottom + 8) + window.scrollY + 'px'
    card.classList.toggle('up', up)
  }
  function show(a) {
    var p = target(a)
    if (!p) return
    link = a
    var body = p.cloneNode(true)
    body.removeAttribute('id')
    body.classList.remove('fn-flash', 'fn-flash-fade')
    var ids = body.querySelectorAll('[id]')
    for (var k = 0; k < ids.length; k++) ids[k].removeAttribute('id')
    var above = p.getBoundingClientRect().top < a.getBoundingClientRect().top
    card.innerHTML = '<div class="fn-peek-body"></div><span class="para-peek-go">Go to this paragraph ' + (above ? '\u2191' : '\u2193') + '</span>'
    card.firstChild.innerHTML = body.innerHTML
    card.hidden = false
    a.setAttribute('aria-describedby', 'paraPeek')
    place()
  }
  function hide() {
    clearTimeout(openT); clearTimeout(closeT)
    if (link) link.removeAttribute('aria-describedby')
    link = null
    card.hidden = true
  }
  function go(a) {
    var p = a && target(a)
    hide()
    if (!p) return
    for (var d = p.closest('details'); d; d = d.parentElement.closest('details')) d.open = true
    if (location.hash !== '#' + p.id) history.pushState(null, '', '#' + p.id)
    p.scrollIntoView({ block: 'center', behavior: motion })
    p.classList.remove('fn-flash', 'fn-flash-fade')
    void p.offsetWidth
    p.classList.add('fn-flash')
    var token = p._paraFlash = {}
    setTimeout(function () {
      if (p._paraFlash !== token) return
      p.classList.add('fn-flash-fade')
      setTimeout(function () { if (p._paraFlash === token) p.classList.remove('fn-flash', 'fn-flash-fade') }, 1200)
    }, 2200)
  }

  card.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('a')) return // a link inside the paragraph
    go(link)
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide() })
  window.addEventListener('resize', function () { if (link) place() })

  if (!hover) {
    // capturing, like fnPeek: a tap on the link opens the card instead of jumping
    document.addEventListener('click', function (e) {
      var a = linkOf(e.target)
      if (a) {
        e.preventDefault()
        if (a === link && !card.hidden) hide()
        else show(a)
        return
      }
      if (!card.hidden && !card.contains(e.target)) { e.preventDefault(); e.stopPropagation(); hide() }
    }, true)
    return
  }

  document.addEventListener('mouseover', function (e) {
    if (card.contains(e.target)) { clearTimeout(closeT); return }
    var a = linkOf(e.target)
    if (!a) return
    clearTimeout(closeT)
    if (a === link && !card.hidden) return
    clearTimeout(openT)
    openT = setTimeout(function () { show(a) }, link ? 0 : 60)
  })
  document.addEventListener('mouseout', function (e) {
    var from = linkOf(e.target) || (card.contains(e.target) ? card : null)
    if (!from) return
    var to = e.relatedTarget
    if (to && (card.contains(to) || (link && link.contains(to)) || linkOf(to) === from)) return
    clearTimeout(openT); clearTimeout(closeT)
    closeT = setTimeout(hide, 150)
  })
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    var a = linkOf(e.target)
    if (!a) return
    e.preventDefault()
    go(a)
  })
}

/* ------------------------------------------------------ footnotes in the margin (page) */
// Runs INSIDE the published article (embedded via fnSide.toString(), like fnTrip), on every page
// with footnotes. `start` is the writer's choice ('side' or 'below'); a settings icon lets the
// reader change it, remembered in their browser. With room beside the column, each note moves to the right
// margin with its first line on the same baseline as its marker. A note fills the space down
// to the next one and, if it's longer, stops on a whole line with "…"; hovering it, or
// clicking its marker in the text, slides it open over the notes below, and it slides shut
// again when the reader moves on. Without room, or without JavaScript, or in print, the
// notes simply stay at the bottom — this only ever adds the fn-side class, positions and caps.
function fnSide(minWidth, start) {
  var list = document.querySelector('ol.footnotes')
  var main = list && list.closest('.container')
  if (!list || !main) return
  var room = window.matchMedia('(min-width:' + minWidth + 'px)')
  var items = Array.prototype.slice.call(list.children)
  var GAP = 14
  var queued = false

  // the baseline of the line at `node`, measured with a zero-size box dropped in beside it
  function baseline(parent, before) {
    var probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;width:0;height:0'
    parent.insertBefore(probe, before)
    var y = probe.getBoundingClientRect().bottom
    parent.removeChild(probe)
    return y
  }
  function place() {
    queued = false
    var on = room.matches && want === 'side'
    document.body.classList.toggle('fn-side', on)
    if (!on) {
      main.style.minHeight = ''
      items.forEach(function (li) { li.style.top = ''; li.style.maxHeight = ''; li.classList.remove('fn-clip', 'fn-open') })
      return
    }
    var top0 = main.getBoundingClientRect().top
    var prev = -Infinity
    var tops = []
    items.forEach(function (li) {
      var lineH = parseFloat(getComputedStyle(li).lineHeight) || 20
      var sup = document.getElementById(li.id.replace('fn-', 'fnref-'))
      var back = li.querySelector('.fn-back')
      // at least one line of the note above stays visible
      var at = prev === -Infinity ? 0 : prev + lineH + GAP
      if (sup && back) {
        var own = baseline(back, back.firstChild) - li.getBoundingClientRect().top
        // a marker folded inside a collapsible section: level with that section's title
        var shut = null
        for (var d = sup.closest('details'); d; d = d.parentElement.closest('details')) if (!d.open) shut = d.querySelector('summary')
        at = Math.max((shut ? baseline(shut, shut.firstChild) : baseline(sup.parentNode, sup)) - top0 - own, prev === -Infinity ? -Infinity : at)
      }
      li.style.top = at + 'px'
      tops.push(at)
      prev = at
    })
    // each note fills the space down to the next; longer ones stop on a whole line with "…"
    var end = 0
    items.forEach(function (li, i) {
      var lineH = parseFloat(getComputedStyle(li).lineHeight) || 20
      var full = li.scrollHeight
      var room = i + 1 < items.length ? tops[i + 1] - tops[i] - GAP : Infinity
      var cap = full > room + 1 ? lastLine(li, room) || lineH : 0
      li.dataset.full = full
      li.dataset.cap = cap
      li.classList.toggle('fn-clip', !!cap)
      if (cap) li.style.setProperty('--fn-ell', (cap - lineH) + 'px') // "…" sits on the last shown line
      li.style.maxHeight = cap ? (li.classList.contains('fn-open') ? full : cap) + 'px' : ''
      end = Math.max(end, tops[i] + full)
    })
    // long notes can outrun the text: keep them inside the page
    main.style.minHeight = end > 0 ? end + GAP + 'px' : ''
  }
  // the bottom of the last whole line of `li` that ends within `room` (paragraph gaps make a
  // plain multiple of the line height land mid-line)
  function lastLine(li, room) {
    var r = document.createRange()
    r.selectNodeContents(li)
    var top = li.getBoundingClientRect().top
    var rects = r.getClientRects()
    var best = 0
    for (var k = 0; k < rects.length; k++) {
      var b = rects[k].bottom - top
      if (rects[k].height > 0 && b <= room + 0.5 && b > best) best = b
    }
    return Math.ceil(best)
  }
  // open a cut-off note to its full length (smoothly, over the notes below), or close it
  // While a note slides, it stays on top (closing too, so it never slides under the notes
  // below), and nothing is re-measured until it has settled.
  var moving = 0
  function openNote(li, on) {
    if (!li || !li.classList.contains('fn-clip')) { if (li && !on) li.classList.remove('fn-open'); return }
    if (on === li.classList.contains('fn-open')) return
    clearTimeout(li._fnT)
    if (!li._fnMoving) { li._fnMoving = true; moving++ }
    li.classList.toggle('fn-open', on)
    li.classList.toggle('fn-closing', !on)
    li.style.maxHeight = (on ? li.dataset.full : li.dataset.cap) + 'px'
    li._fnT = setTimeout(function () {
      li.classList.remove('fn-closing')
      if (li._fnMoving) { li._fnMoving = false; moving--; soon() }
    }, 420)
  }
  var pinned = null // opened from its marker: stays open until the reader moves on
  items.forEach(function (li) {
    li.addEventListener('mouseenter', function () { if (document.body.classList.contains('fn-side')) openNote(li, true) })
    li.addEventListener('mouseleave', function () { if (pinned === li) pinned = null; openNote(li, false) })
  })
  document.addEventListener('click', function (e) {
    if (!document.body.classList.contains('fn-side')) return
    var a = e.target.closest && e.target.closest('a[href^="#fn-"]')
    var li = a && document.getElementById(a.getAttribute('href').slice(1))
    if (pinned && pinned !== li && !pinned.contains(e.target)) { openNote(pinned, false); pinned = null }
    if (li && items.indexOf(li) >= 0) { pinned = li; pinnedY = window.scrollY; openNote(li, true) }
  })
  // resting on a marker in the text for half a second opens its note too; moving off closes it
  // (unless the pointer went on to the note itself)
  var peekT = 0, peek = null
  document.addEventListener('mouseover', function (e) {
    var sup = e.target.closest && e.target.closest('sup[id^="fnref-"]')
    if (!sup || !document.body.classList.contains('fn-side')) return
    var li = document.getElementById(sup.id.replace('fnref-', 'fn-'))
    if (!li) return
    clearTimeout(peekT)
    peekT = setTimeout(function () { peek = li; openNote(li, true) }, 500)
  })
  document.addEventListener('mouseout', function (e) {
    var sup = e.target.closest && e.target.closest('sup[id^="fnref-"]')
    if (!sup || (e.relatedTarget && sup.contains(e.relatedTarget))) return
    clearTimeout(peekT)
    var li = peek
    peek = null
    if (li) setTimeout(function () { if (!li.matches(':hover') && pinned !== li) openNote(li, false) }, 250)
  })
  var pinnedY = 0
  window.addEventListener('scroll', function () {
    if (pinned && Math.abs(window.scrollY - pinnedY) > window.innerHeight * 0.5) { openNote(pinned, false); pinned = null }
  }, { passive: true })
  function soon() {
    if (queued || moving > 0) return
    queued = true
    requestAnimationFrame(place)
  }
  var KEY = 'reader.footnotes', want = start
  try { want = localStorage.getItem(KEY) || start } catch (e) {}
  place()
  // the settings icon, shown only when there's a choice to make: room for the margin
  var gear = document.createElement('button')
  gear.type = 'button'
  gear.className = 'rd-gear'
  gear.setAttribute('aria-label', 'Reading settings')
  gear.setAttribute('aria-expanded', 'false')
  gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>'
  var panel = document.createElement('div')
  panel.className = 'rd-panel'
  panel.hidden = true
  panel.innerHTML = '<div class="rd-name">Footnotes</div><div class="rd-seg" role="group" aria-label="Footnotes"><button type="button" data-v="side">On the right</button><button type="button" data-v="below">Below</button></div>'
  document.body.appendChild(gear)
  document.body.appendChild(panel)
  var closeT = 0
  function show(open) { clearTimeout(closeT); panel.hidden = !open; gear.setAttribute('aria-expanded', String(open)) }
  function paint() {
    gear.hidden = !room.matches
    if (!room.matches) show(false)
    var bs = panel.querySelectorAll('button')
    for (var b = 0; b < bs.length; b++) bs[b].setAttribute('aria-pressed', String(bs[b].getAttribute('data-v') === want))
  }
  panel.addEventListener('click', function (e) {
    var b = e.target.closest('button')
    if (!b) return
    want = b.getAttribute('data-v')
    try { localStorage.setItem(KEY, want) } catch (err) {}
    paint()
    place()
  })
  gear.addEventListener('click', function () { show(window.matchMedia('(hover: hover)').matches ? true : panel.hidden) })
  if (window.matchMedia('(hover: hover)').matches) {
    [gear, panel].forEach(function (el) {
      el.addEventListener('mouseenter', function () { show(true) })
      el.addEventListener('mouseleave', function () { clearTimeout(closeT); closeT = setTimeout(function () { show(false) }, 260) })
    })
  }
  document.addEventListener('click', function (e) { if (!panel.contains(e.target) && !gear.contains(e.target)) show(false) })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') show(false) })
  room.addEventListener('change', paint)
  paint()
  // quiet until the reader is on the note (CSS) or on its marker (here)
  function hot(e, on) {
    var sup = e.target.closest && e.target.closest('sup[id^="fnref-"]')
    var li = sup && document.getElementById(sup.id.replace('fnref-', 'fn-'))
    if (li) li.classList.toggle('fn-hot', on)
  }
  document.addEventListener('mouseover', function (e) { hot(e, true) })
  document.addEventListener('mouseout', function (e) { hot(e, false) })
  room.addEventListener('change', soon)
  window.addEventListener('load', soon)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon)
  // the text reflowing (fonts, math, images landing) or a note changing height
  if (window.ResizeObserver) {
    var watch = new ResizeObserver(soon)
    watch.observe(main)
    items.forEach(function (li) { watch.observe(li) })
  }
}

/* ------------------------------------------------------ equation slider (page) */
// Runs INSIDE the published article (embedded via eqSlider.toString(), like fnTrip). A long
// equation with accepted versions (data-levels; see equation-levels.js) gets a small slider
// beneath it, shown on hover, focus or tap, stepping Labeled → Simplified → Full math. The page
// opens on the writer's equation; room for the slider and the tallest version is always kept,
// so nothing moves. Without JavaScript or KaTeX it's simply the plain equation.
function eqSlider() {
  function start() {
    if (!window.katex) return
    var macros = { '\\differentialD': 'd', '\\exponentialE': 'e', '\\imaginaryI': 'i', '\\imaginaryJ': 'j' }
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    var hover = window.matchMedia('(hover: hover)').matches
    var NAMES = ['Labeled', 'Simplified', 'Full math']
    var ps = document.querySelectorAll('p.math-block[data-levels]')
    Array.prototype.forEach.call(ps, function (p) {
      var data
      try { data = JSON.parse(p.getAttribute('data-levels')) } catch (e) { return }
      var fig = document.createElement('div')
      fig.className = 'eqs'
      var stack = document.createElement('div')
      stack.className = 'eqs-stack'
      function stage(el) { el.className = 'eqs-stage'; stack.appendChild(el); return el }
      function rendered(tex) {
        var el = document.createElement('div')
        window.katex.render(tex, el, { displayMode: true, throwOnError: false, strict: false, macros: macros })
        return el
      }
      var stages = []
      try {
        stages.push(stage(rendered(data.labeled)))
        var mid = rendered(data.simplified)
        if (data.why) { var w = document.createElement('div'); w.className = 'eqs-why'; w.textContent = data.why; mid.appendChild(w) }
        stages.push(stage(mid))
        if (data.full) stages.push(stage(rendered(data.full)))
        else { var own = document.createElement('div'); own.innerHTML = p.innerHTML; stages.push(stage(own)) }
      } catch (e) { return }
      var ctl = document.createElement('div')
      ctl.className = 'eqs-ctl'
      ctl.innerHTML = '<span aria-hidden="true">Simple</span><div class="eqs-track"><input type="range" min="0" max="2" step="0.01" aria-label="Equation detail"></div><span aria-hidden="true">Math</span>'
      var track = ctl.querySelector('.eqs-track')
      for (var t = 0; t < 3; t++) {
        var tick = document.createElement('span')
        tick.className = 'eqs-tick'
        tick.style.left = 'calc(6px + (100% - 12px) * ' + (t / 2) + ')'
        track.insertBefore(tick, track.firstChild)
      }
      var input = ctl.querySelector('input')
      fig.appendChild(stack)
      fig.appendChild(ctl)
      p.parentNode.replaceChild(fig, p)

      var v = 2, raf = 0, dragging = false, offT = 0
      function set(x) {
        v = x
        stages.forEach(function (st, i) {
          // one fades out completely before the next fades in, so they never overprint
          var o = Math.max(0, Math.min(1, 1 - Math.abs(x - i) * 2))
          st.style.opacity = o
          st.style.visibility = o > 0 ? 'visible' : 'hidden'
          st.setAttribute('aria-hidden', Math.round(x) === i ? 'false' : 'true')
        })
        input.value = x
        input.setAttribute('aria-valuetext', NAMES[Math.round(x)])
      }
      function glide(to) {
        cancelAnimationFrame(raf)
        if (reduced) { set(to); return }
        var from = v, t0 = performance.now()
        ;(function step(now) {
          var q = Math.min(1, (now - t0) / 170)
          set(from + (to - from) * (1 - (1 - q) * (1 - q)))
          if (q < 1) raf = requestAnimationFrame(step)
        })(t0)
      }
      function on() { clearTimeout(offT); fig.classList.add('on') }
      function later() {
        clearTimeout(offT)
        offT = setTimeout(function () { if (!dragging && !fig.contains(document.activeElement)) fig.classList.remove('on') }, 220)
      }
      if (hover) { fig.addEventListener('mouseenter', on); fig.addEventListener('mouseleave', later) }
      else {
        fig.addEventListener('click', on)
        document.addEventListener('click', function (e) { if (!fig.contains(e.target)) fig.classList.remove('on') })
      }
      fig.addEventListener('focusin', on)
      fig.addEventListener('focusout', later)
      input.addEventListener('pointerdown', function () { dragging = true; cancelAnimationFrame(raf) })
      input.addEventListener('input', function () { if (dragging) set(+input.value) })
      function settle() {
        if (!dragging) return
        dragging = false
        glide(Math.round(v))
        if (!fig.matches(':hover')) later()
      }
      input.addEventListener('pointerup', settle)
      input.addEventListener('pointercancel', settle)
      input.addEventListener('lostpointercapture', settle)
      input.addEventListener('keydown', function (e) {
        var k = e.key, cur = Math.round(v), to = null
        if (k === 'ArrowLeft' || k === 'ArrowDown') to = Math.max(0, cur - 1)
        else if (k === 'ArrowRight' || k === 'ArrowUp') to = Math.min(2, cur + 1)
        else if (k === 'Home') to = 0
        else if (k === 'End') to = 2
        if (to !== null) { e.preventDefault(); glide(to) }
      })
      set(2)
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}

/* ------------------------------------------------------ contents fade (page) */
// Runs INSIDE the published article (embedded via tocFade.toString(), like fnTrip). While the
// reader reads, the contents list fades away, leaving only the word "Contents". It comes back
// quickly when they scroll fast, bring the mouse to the left side, tab into it, or tap the word,
// and fades slowly once none of that is going on. Without JavaScript it simply stays.
function tocFade() {
  var toc = document.querySelector('.toc')
  if (!toc) return
  var IDLE = 1200        // ms of nothing before it starts to fade
  var WINDOW = 300       // ms of scrolling measured for speed
  var FAST = 0.4         // of a screen height within WINDOW counts as scrolling fast
  var REACH = 48         // px beyond the panel that still counts as "the left side"
  var timer = 0, inZone = false, focused = false, samples = []

  function sleepSoon() {
    clearTimeout(timer)
    if (!inZone && !focused) timer = setTimeout(function () { toc.classList.add('quiet') }, IDLE)
  }
  function wake() {
    toc.classList.remove('quiet')
    sleepSoon()
  }
  document.addEventListener('mousemove', function (e) {
    var near = e.clientX <= toc.getBoundingClientRect().right + REACH
    if (near === inZone) return
    inZone = near
    wake()
  }, { passive: true })
  document.documentElement.addEventListener('mouseleave', function () {
    if (inZone) { inZone = false; sleepSoon() }
  })
  window.addEventListener('scroll', function () {
    var now = Date.now()
    samples.push({ t: now, y: window.scrollY })
    while (samples.length > 1 && now - samples[0].t > WINDOW) samples.shift()
    if (Math.abs(window.scrollY - samples[0].y) > window.innerHeight * FAST) wake()
  }, { passive: true })
  toc.addEventListener('focusin', function () { focused = true; wake() })
  toc.addEventListener('focusout', function () { focused = false; sleepSoon() })
  toc.querySelector('.toc-label').addEventListener('click', wake) // touch: no mouse to bring over
  sleepSoon()
}

/* ------------------------------------------------------ video autoplay (page) */
// Runs INSIDE the published article (embedded via vidPlay.toString(), so keep it
// self-contained). Each video plays by itself ONCE, the first time the reader scrolls it
// into view; consecutive videos in view take turns (the next starts when the one before
// ends) instead of playing over each other. A finished video rewinds to its first frame and
// waits under a big centered play button. Once the reader plays, pauses or seeks a video
// themselves it's theirs — never auto-played again. Sound: an unmuted video that the
// browser refuses to autoplay with sound starts muted instead (the controls can unmute).
function vidPlay() {
  var vids = Array.prototype.slice.call(document.querySelectorAll('figure.video-block video'))
  if (!vids.length) return
  // per video: state 'pending' | 'auto' | 'done'; seen = mostly on screen; expect = the
  // 'play'/'pause' event our own call will fire (anything else came from the reader)
  var st = []
  var current = -1 // the video auto-playing (or held paused off-screen mid-autoplay)

  vids.forEach(function (v, i) {
    st.push({ state: 'pending', seen: false, expect: null })
    // wrap so the play button centers on the picture, not the figure + caption
    var wrap = document.createElement('div')
    wrap.className = 'vwrap'
    v.parentNode.insertBefore(wrap, v)
    wrap.appendChild(v)
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'vplay'
    btn.setAttribute('aria-label', 'Play video')
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
    wrap.appendChild(btn)
    // a video autoplay had to start silent gets its sound back once the reader plays it (unless you muted it)
    var authorMuted = v.muted || v.hasAttribute('muted')
    btn.addEventListener('click', function () { if (!authorMuted) v.muted = false; v.play() })
    function sync() { wrap.classList.toggle('playing', !v.paused) }
    v.addEventListener('play', function () {
      sync()
      if (st[i].expect === 'play') { st[i].expect = null; return }
      // the reader started this one: it's theirs, and it shouldn't play over an autoplay
      st[i].state = 'done'
      if (current >= 0 && current !== i) { st[current].state = 'done'; act(current, 'pause'); current = -1 }
    })
    v.addEventListener('pause', function () {
      sync()
      if (st[i].expect === 'pause') { st[i].expect = null; return }
      if (!v.ended) st[i].state = 'done' // the reader paused it: no more autoplay
    })
    v.addEventListener('ended', function () {
      var wasAuto = st[i].state === 'auto'
      st[i].state = 'done'
      v.currentTime = 0 // back to the first frame, ready to be played again
      sync()
      if (current === i) current = -1
      if (wasAuto) pump()
    })
  })

  function act(i, what) {
    var v = vids[i]
    if (what === 'pause') { if (!v.paused) { st[i].expect = 'pause'; v.pause() } return }
    if (!v.paused) return
    st[i].expect = 'play'
    var p = v.play()
    if (p && p.catch) p.catch(function () {
      // no autoplay with sound before a click: start it silent instead (controls can unmute)
      if (v.muted) return giveUp()
      v.muted = true
      var q = v.play()
      if (q && q.catch) q.catch(giveUp)
    })
    function giveUp() { st[i].expect = null; st[i].state = 'done'; if (current === i) current = -1 }
  }

  // keep the current autoplay running while it's on screen; if it's scrolled away, pause it
  // (it resumes when it's back) and play the earliest video in view still owed its autoplay
  function pump() {
    if (current >= 0 && (st[current].state !== 'auto' || !st[current].seen)) {
      if (st[current].state === 'auto') act(current, 'pause') // scrolled away mid-play: resumes if they come back
      current = -1
    }
    if (current >= 0) { act(current, 'play'); return }
    for (var i = 0; i < vids.length; i++) {
      if (st[i].seen && st[i].state !== 'done') { current = i; st[i].state = 'auto'; act(i, 'play'); return }
    }
  }

  if (!('IntersectionObserver' in window)) return
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      // "come across" = most of the video on screen; "gone" = mostly scrolled away
      var i = vids.indexOf(e.target)
      if (e.intersectionRatio >= 0.6) st[i].seen = true
      else if (e.intersectionRatio < 0.25) st[i].seen = false
    })
    pump()
  }, { threshold: [0, 0.25, 0.6, 1] })
  vids.forEach(function (v) { io.observe(v) })
}

/* ------------------------------------------------------ provenance widget (page) */
// Runs INSIDE the published article (embedded via provWidget.toString(), so keep it
// self-contained: no imports, no closures over this module, no "</script>" literals).
// A small caret at the end of the date line opens two short lines, whatever the number of
// versions:
//   v3 Nov 20 · v2 Nov 15 · v1 Nov 13      (the one on screen in bold; the others open it)
//   Timestamped in Bitcoin · file · proof
// On an older version (?v=N, put in place by provOld) the line above the title reads
// "Read the current version →", and its caret adds "You're reading v1 of 3, from …".
function provWidget() {
  var root = document.getElementById('prov')
  if (!root) return
  var slug = root.getAttribute('data-slug')
  var latestN = parseInt(root.getAttribute('data-v') || '0', 10)
  var view = parseInt(root.getAttribute('data-view') || '0', 10) || latestN
  var old = view < latestN
  var line = root.querySelector('.prov-line')
  var dot = root.querySelector('.prov-dot')
  var panel = root.querySelector('.prov-panel')
  var manifest = null
  var opened = false

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
  function day(iso) {
    var d = new Date(iso); if (isNaN(d)) return String(iso || '')
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  function short(iso) {
    var d = new Date(iso); if (isNaN(d)) return ''
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  function verOf(n) {
    var vs = manifest && manifest.versions ? manifest.versions : []
    for (var i = 0; i < vs.length; i++) if (vs[i].n === n) return vs[i]
    return null
  }
  function kind(v) { return !v ? '' : v.status === 'verified' || v.status === 'confirmed' ? 'ok' : v.status === 'invalid' ? 'bad' : 'wait' }

  if (old) {
    // above the title: the way back to the current text, this version's details folded under it
    var top = document.createElement('div')
    top.className = 'prov-top'
    var cur = document.createElement('a')
    cur.className = 'prov-current'
    cur.href = slug + '.html'
    cur.textContent = 'Read the current version →'
    top.appendChild(cur)
    top.appendChild(root)
    var h1 = document.querySelector('main.container h1')
    if (h1) h1.parentNode.insertBefore(top, h1)
    line.setAttribute('title', 'About this version')
    line.setAttribute('aria-label', 'About this version')
  }

  function render() {
    var vs = manifest && manifest.versions ? manifest.versions.slice().reverse() : []
    var me = verOf(view)
    var h = ''
    if (old) h += '<span class="prov-row">You’re reading v' + view + ' of ' + latestN + (me ? ', from ' + esc(day(me.date)) : '') + '.</span>'
    if (vs.length > 1) {
      h += '<span class="prov-row prov-vers">'
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i]
        var label = 'v' + v.n + ' <span class="prov-d">' + esc(short(v.date)) + '</span>'
        var href = v.n === latestN ? slug + '.html' : slug + '.html?v=' + v.n
        h += (i ? '<span aria-hidden="true">·</span>' : '') +
          (v.n === view ? '<b aria-current="page">' + label + '</b>' : '<a href="' + esc(href) + '">' + label + '</a>')
      }
      h += '</span>'
    }
    var k = kind(me)
    h += '<span class="prov-row"><a href="https://opentimestamps.org" rel="noopener" target="_blank" title="How to verify">' +
      (k === 'bad' ? 'Timestamp invalid' : k === 'wait' ? 'Timestamp pending' : 'Timestamped in Bitcoin') + '</a>'
    if (me) {
      h += ' · <a href="' + esc(me.file) + '" title="The exact file the timestamp covers">file</a>' +
        ' · <a href="proofs/' + esc(slug) + '/' + esc(me.ots) + '" download title="OpenTimestamps proof">proof</a>'
    }
    panel.innerHTML = h + '</span>'
  }

  line.addEventListener('click', function () {
    opened = !opened
    panel.hidden = !opened
    line.setAttribute('aria-expanded', opened ? 'true' : 'false')
    root.classList.toggle('open', opened)
    if (opened) render()
  })

  fetch('proofs/' + slug + '/manifest.json', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json() })
    .then(function (j) {
      manifest = j
      var k = kind(verOf(view))
      dot.className = 'prov-dot' + (k ? ' ' + k : '')
      if (opened) render()
    })
    .catch(function () {})
}

// Runs INSIDE the published article, just after the text and before the page's other
// scripts. ?v=N shows an older version here, in the current layout: its text is read from
// the frozen copy (<slug>.vN.html, which stays byte-for-byte what was timestamped) and put
// in place of the current text before Contents, footnotes, maths etc. start up. If the old
// text needs something this page doesn't carry (`has`: footnotes, sliders…), it opens the
// frozen copy itself instead.
function provOld(has) {
  var root = document.getElementById('prov')
  var main = document.querySelector('main.container')
  var q = /[?&]v=(\d+)/.exec(location.search)
  if (!root || !main || !q) return
  var n = parseInt(q[1], 10)
  var latestN = parseInt(root.getAttribute('data-v') || '0', 10)
  var slug = root.getAttribute('data-slug')
  if (!(n >= 1 && n < latestN)) return
  var file = slug + '.v' + n + '.html'
  var html = null
  try {
    var x = new XMLHttpRequest()
    x.open('GET', file, false) // sync on purpose: the text must be in place before the scripts below run
    x.send()
    if (x.status === 200) html = x.responseText
  } catch (e) {}
  if (!html) return
  var doc = new DOMParser().parseFromString(html, 'text/html')
  var om = doc.querySelector('main.container')
  if (!om) { location.replace(file); return }
  var need = {
    toc: !!doc.querySelector('nav.toc'), fn: !!om.querySelector('ol.footnotes'), sliders: !!om.querySelector('[data-levels]'),
    details: !!om.querySelector('details'), video: !!om.querySelector('video'), embed: !!om.querySelector('figure.embed'),
    canvas: !!om.querySelector('.canvas-item'),
  }
  for (var k in need) if (need[k] && has.indexOf(k) < 0) { location.replace(file); return }

  var oh1 = om.querySelector('h1'), osub = om.querySelector('.subtitle'), ometa = om.querySelector('.meta')
  var lh1 = main.querySelector('h1'), lsub = main.querySelector('.subtitle'), lmeta = main.querySelector('.meta')
  if (!oh1 || !lh1 || !lmeta) { location.replace(file); return }
  lh1.innerHTML = oh1.innerHTML
  if (lsub && osub) lsub.innerHTML = osub.innerHTML
  else if (lsub) lsub.parentNode.removeChild(lsub)
  else if (osub) lh1.parentNode.insertBefore(document.importNode(osub, true), lh1.nextSibling)
  // the date line keeps the byline; the date and reading time are the old version's
  var oprov = doc.getElementById('prov')
  var when = new Date(oprov && oprov.getAttribute('data-date'))
  var mins = /(\d+)\s*min/.exec(ometa ? ometa.textContent : '')
  var spans = lmeta.querySelectorAll(':scope > span')
  for (var s = 0; s < spans.length; s++) {
    if (/\d+ min$/.test(spans[s].textContent) && !isNaN(when)) {
      spans[s].textContent = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) + (mins ? ' · ' + mins[1] + ' min' : '')
    }
  }
  // the text: everything after the old date line
  while (lmeta.nextSibling) main.removeChild(lmeta.nextSibling)
  for (var nd = (ometa || osub || oh1).nextSibling; nd; nd = nd.nextSibling) main.appendChild(document.importNode(nd, true))
  // Contents
  var ltoc = document.querySelector('nav.toc'), otoc = doc.querySelector('nav.toc')
  if (ltoc && otoc) ltoc.innerHTML = otoc.innerHTML
  else if (ltoc) ltoc.parentNode.removeChild(ltoc)
  if (doc.title) document.title = doc.title + ' (v' + n + ')'
  root.setAttribute('data-view', String(n))
}

const PROV_CSS = [
  '      .prov { display:contents; }',
  '      .prov-line { display:inline-flex; align-items:center; gap:0.4rem; margin-left:0; padding:0.15rem 0.25rem; border:0; background:none; font:inherit; color:inherit; cursor:pointer; }',
  '      .prov-line:focus:not(:focus-visible) { outline:none; }',
  '      .prov-line:hover { color:var(--text-color); }',
  '      .prov-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:rgba(107,114,128,0.55); flex:none; }',
  '      .prov-dot.ok { background:#4a9a5a; } .prov-dot.wait { background:#d9a441; } .prov-dot.bad { background:#c0392b; }',
  '      .prov-text:empty, .meta .prov-dot, .prov-top .prov-dot { display:none; }',
  '      .prov-caret { display:inline-flex; align-items:center; transition:transform 0.15s; opacity:0.7; }',
  '      .prov.open .prov-caret { transform:rotate(180deg); }',
  '      .prov-panel { flex-basis:100%; display:flex; flex-direction:column; gap:0.05rem; margin:0.2rem 0 0; font-size:0.85rem; line-height:1.55; }',
  '      .prov-panel[hidden] { display:none; }',
  '      @media (max-width:560px) { .prov-panel { font-size:0.8rem; } }',
  '      .prov-vers { display:flex; flex-wrap:wrap; column-gap:0.4rem; }',
  '      .prov-vers b { font-weight:600; color:var(--text-color); }',
  '      .prov-vers a { text-decoration:none; } .prov-vers a:hover { text-decoration:underline; }',
  '      .prov a { color:var(--muted); }',
  '      .prov a:hover { color:var(--text-color); }',
  '      .prov-top { display:flex; flex-wrap:wrap; align-items:center; gap:0 0.15rem; margin:0 0 0.6rem; font-size:0.95rem; color:var(--muted); }',
  '      .prov-current { color:var(--text-color); text-decoration:none; } .prov-current:hover { text-decoration:underline; }',
  // Draft pages have no "← Writings" back-link, so the note sits at the top with the
  // container's (tighter) top margin instead of being pulled up under the link.
  // Deep brick red on the cream page: unmistakably "not the published article", still quiet.
  '      .draft-note { margin:0 0 1rem; font-family:system-ui, -apple-system, sans-serif; font-size:0.74rem; color:#9a2f2f; letter-spacing:0.01em; }',
  '      .draft-note::before { content:""; display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor; margin-right:0.5rem; vertical-align:middle; position:relative; top:-1px; }',
  '      .draft-note strong { font-weight:600; font-size:0.68rem; letter-spacing:0.08em; text-transform:uppercase; }',
]

function longDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
// "Sep 8, 2026, 9:45 AM PDT" — date + time of day in the author's zone (named, so a reader
// elsewhere isn't misled).
function longDateTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

// Build a full standalone article that matches the published site's aesthetic.
// `version` ({ n, date }) adds the provenance widget; `draft` marks an unlisted preview
// (noindex, no widget, relative paths one level deeper via `pathPrefix`).
// The byline: the author's name at the start of the date line. Hover (or tap, on a phone)
// and a small row of icon links drops below it: X, the website, Substack.
const BY_ICONS = {
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 1.2h3.7l-8 9.2L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3z"/></svg>',
  site: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.6 3.9 5.8 3.9 9.5s-1.3 6.9-3.9 9.5c-2.6-2.6-3.9-5.8-3.9-9.5S9.4 5.1 12 2.5z"/></svg>',
  substack: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>',
}
function bylineHtml() {
  const a = CONFIG.author
  if (!a || !a.name) return ''
  const link = (k, label) => a[k] ? '<a href="' + escapeHtml(a[k]) + '"' + (k === 'site' ? '' : ' target="_blank" rel="noopener"') + ' title="' + label + '" aria-label="' + label + '">' + BY_ICONS[k] + '</a>' : ''
  return '<span class="by"><button type="button" class="by-name" aria-expanded="false">' + escapeHtml(a.name) + '</button>' +
    '<span class="by-links">' + link('x', 'X') + link('site', 'Website') + link('substack', 'Substack') + '</span></span><span aria-hidden="true">·</span>'
}
const BY_CSS = [
  '.by { position:relative; display:inline-flex; }',
  '.by-name { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; }',
  '.by-name:hover, .by.open .by-name { color:var(--text-color); }',
  '.by-links { position:absolute; left:-0.35rem; top:calc(100% + 0.3rem); z-index:5; display:flex; gap:0.1rem; padding:0.15rem; background:var(--bg-color); border:1px solid rgba(39,50,63,0.12); border-radius:9px; box-shadow:0 4px 14px rgba(39,50,63,0.08); opacity:0; visibility:hidden; transform:translateY(-3px); transition:opacity 0.15s, transform 0.15s, visibility 0s 0.15s; }',
  '.by:hover .by-links, .by.open .by-links { opacity:1; visibility:visible; transform:none; transition:opacity 0.15s, transform 0.15s; }',
  '.by-links a { display:flex; padding:0.3rem; color:#9ca3af; border-radius:6px; }',
  '.by::after { content:""; position:absolute; left:0; right:0; top:100%; height:0.4rem; }', // hover bridge to the links
  '@media (pointer: coarse) { .by-links a { padding:0.45rem; } .by-links svg { width:16px; height:16px; } }',
  '.by-links a:hover { color:var(--text-color); }',
  '.by-links svg { width:14px; height:14px; fill:currentColor; }',
  '.by-links svg[fill=none] { fill:none; }',
].join('\n')
// Runs INSIDE the published article: a tap toggles the links (phones have no hover).
function bylineToggle() {
  var by = document.querySelector('.by')
  if (!by) return
  var btn = by.querySelector('.by-name')
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    var open = by.classList.toggle('open')
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', function (e) {
    if (!by.contains(e.target)) { by.classList.remove('open'); btn.setAttribute('aria-expanded', 'false') }
  })
}

function buildArticleHtml({ titleText, subtitleText, dateStr, minutes, font, style, bodyHtml, footHtml, toc, slug, version, draft }) {
  const draftCreated = new Date().toISOString() // when this draft link was (re)generated
  const title = escapeHtml(titleText)
  const subtitle = escapeHtml(subtitleText)
  const hasToc = !!(toc && toc.length)
  const hasVideo = /<video\b/.test(bodyHtml)
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
      '          // and it stays the highlighted one until the reader scrolls on their own\n' +
      '          items[m].addEventListener("click", (function (i) { return function () { pinned = i; chosen = i; update(); }; })(m));\n' +
      '        }\n' +
      '        var pinned = -1, chosen = -1;\n' +
      '        ["wheel", "touchmove", "keydown"].forEach(function (t) { addEventListener(t, function () { chosen = -1; }, { passive: true }); });\n' +
      '        var ticking = false;\n' +
      '        function update() {\n' +
      '          ticking = false;\n' +
      '          // over the last screenful of scrolling the reading line slides from near the top down to the\n' +
      '          // bottom edge, so sections near the end (whose headings can never reach the top) still get\n' +
      '          // their turn, and at the very end the last heading on screen is the active one\n' +
      '          var range = document.documentElement.scrollHeight - innerHeight, left = range - scrollY;\n' +
      '          var line = 110 + Math.max(0, innerHeight - 110) * Math.max(0, Math.min(1, 1 - left / Math.max(1, Math.min(innerHeight, range))));\n' +
      '          var active = 0;\n' +
      '          for (var i = 0; i < items.length; i++) {\n' +
      '            var h = document.getElementById(items[i].getAttribute("href").slice(1));\n' +
      '            if (h && h.getBoundingClientRect().top <= line - 4) active = i;\n' +
      '          }\n' +
      '          if (chosen >= 0) active = chosen;\n' +
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
      '        addEventListener("resize", update);\n' +
      '        if (window.ResizeObserver) new ResizeObserver(function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }).observe(document.body);\n' + // diagrams/pictures sizing in late
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

  // Timestamp status, at the end of the date · minutes line (publish) / draft label above the
  // title (draft). The static text shows before (or without) the manifest fetch; provWidget()
  // fills in the status.
  const provHtml = version
    ? '<span class="prov" id="prov" data-slug="' + escapeHtml(slug) + '" data-v="' + version.n + '" data-date="' + escapeHtml(version.date) + '">' +
      '<button class="prov-line" type="button" aria-expanded="false" title="Bitcoin timestamp"><span class="prov-dot"></span><span class="prov-text"></span><span class="prov-caret"><svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>' +
      '<span class="prov-panel" hidden></span></span>'
    : draft
      ? '      <p class="draft-note"><strong>Draft preview</strong> · created <time datetime="' + escapeHtml(draftCreated) + '">' + escapeHtml(longDateTime(draftCreated)) + '</time></p>'
      : ''
  const provScript = version ? '    <script>(' + provWidget.toString() + ')();</script>' : ''
  const looks = normalizeStyle(style)
  const fnMargin = !!footHtml && looks.footnotes !== 'bottom' // the right margin is the readers' default (style.js)
  const hasSliders = bodyHtml.includes('data-levels=')
  const hasCollapsibles = bodyHtml.includes('<details')
  const hasParaLinks = bodyHtml.includes('href="#p-') // links to a paragraph: paraPeek
  const peekCss = footHtml || hasParaLinks
  const hasCanvas = bodyHtml.includes('canvas-block')
  const hasEmbed = bodyHtml.includes('class="embed"')
  // Room needed for the notes: 820px column + 2rem gap + 260px note + a 24px edge, with the
  // column sliding left of centre to make it. A contents panel on the left needs 240px more.
  const fnMinWidth = hasToc ? 1400 : 1160

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
    '      .container { max-width:820px; margin:' + (draft ? '1.25rem' : '1.75rem') + ' auto 2.5rem; }',
    '      .back { display:inline-block; margin-bottom:2rem; color:#000; text-decoration:none; font-size:0.95rem; }',
    '      .back:hover { text-decoration:underline; }',
    '      h1 { text-align:left; font-size:1.6rem; font-weight:700; line-height:1.18; margin:0 0 0.35rem; letter-spacing:-0.01em; }',
    '      .subtitle { text-align:left; font-size:1.3rem; line-height:1.35; color:var(--muted); margin:0 0 0.2rem; }',
    '      @media (max-width:560px) { .subtitle { font-size:1.15rem; } }',
    BY_CSS.split('\n').map((l) => '      ' + l).join('\n'),
    '      .meta { display:flex; flex-wrap:wrap; align-items:center; gap:0 0.4em; text-align:left; color:var(--muted); font-size:0.95rem; margin:0 0 0.8rem; } .meta + figure { margin-top:0.8rem; }',
    '      .math-block { text-align:center; margin:1.6rem 0; overflow-x:auto; overflow-y:hidden; }',
    '      .math-block .katex-display { margin:0; }',
    '      .math-block.align-left, .math-block.align-left .katex-display { text-align:left; }',
    '      .math-block.align-right, .math-block.align-right .katex-display { text-align:right; }',
    '      .katex { font-size: 1em; }',
    '      p, ul, ol { margin:0 0 1.25rem; }',
    '      p.small { font-size:0.85em; margin-bottom:1rem; }',
    // a poem: lines right under each other, an empty line (which has no height of its own) the stanza break
    looks.kind === 'poem' ? '      body.poem main > p:not(.subtitle):not(.meta):not(.poem-date), body.poem .collapsible-body > p:not(.poem-date) { margin:0; line-height:1.42; } .poem-date { margin:0 0 1rem; font-size:0.85rem; color:var(--muted); } body.poem main > p:empty::before, body.poem .collapsible-body > p:empty::before { content:"\\00a0"; } body.poem main > p:empty:not(.subtitle):not(.meta), body.poem .collapsible-body > p:empty { line-height:0.85; }' : '',
    hasEmbed ? EMBED_CSS.split('\n').map((l) => '      ' + l).join('\n') : '',
    hasCanvas ? CANVAS_CSS.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n') : '',
    '      li { margin:0; }',
    '      li > p, li > ul, li > ol { margin:0; }',
    '      ul { list-style-type:disc; }',
    '      ul ul { list-style-type:circle; }',
    '      ul ul ul { list-style-type:square; }',
    '      h2 { font-size:1.7rem; line-height:1.25; margin:2rem 0 0.45rem; letter-spacing:-0.01em; }',
    '      h2 ~ h2 { margin-top:2.2rem; padding-top:1.6rem; border-top:1px solid rgba(39,50,63,0.15); }',
    '      h3 { font-size:1.32rem; line-height:1.3; margin:1.6rem 0 0.35rem; }',
    '      h4 { font-size:1.12rem; line-height:1.35; margin:1.8rem 0 0.3rem; }',
    '      blockquote { margin:1.2rem 0; padding:0.2rem 0 0.2rem 1.2rem; position:relative; }',
    '      blockquote::before { content:""; position:absolute; left:0; top:0.4rem; bottom:0.4rem; width:3px; border-radius:2px; background:var(--accent); }',
    '      a { color:var(--text-color); text-decoration:underline; text-decoration-skip-ink:none; }',
    '      figure { margin:1.8rem auto; text-align:center; }',
    '      figure img, figure video { max-width:100%; border-radius:10px; }',
    '      figure img { height:auto; }', // width/height attributes keep its place while it loads
    '      figure[style] img, figure[style] video { width:100%; }',
    '      figure[data-pair]:has(+ figure), figure[data-pair]:has(+ figure) + figure { display:inline-block; vertical-align:top; width:calc(50% - 0.6rem) !important; margin:1.8rem 0 !important; }',
    '      figure[data-pair]:has(+ figure) { margin-right:1.2rem !important; }',
    '      figure[data-pair]:has(+ figure) img, figure[data-pair]:has(+ figure) video, figure[data-pair]:has(+ figure) + figure img, figure[data-pair]:has(+ figure) + figure video { width:100%; }',
    '      @media (max-width:560px) { figure[data-pair]:has(+ figure), figure[data-pair]:has(+ figure) + figure { display:block; width:auto !important; margin:1.8rem auto !important; } }',
    '      figcaption { margin-top:0.5rem; font-size:0.9rem; color:var(--muted); }',
    '      .in-progress { color:#a8483a; font-style:italic; }',
    hasCollapsibles ? '      details.collapsible { margin:1.25rem 0; }' : '',
    hasCollapsibles ? '      details.collapsible > summary { position:relative; padding-left:1.35rem; font-weight:600; cursor:pointer; list-style:none; }' : '',
    hasCollapsibles ? '      details.collapsible > summary::-webkit-details-marker { display:none; }' : '',
    hasCollapsibles ? '      details.collapsible > summary::before { content:""; position:absolute; left:0.1rem; top:0.55em; width:0.42rem; height:0.42rem; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(-45deg); transition:transform 0.15s ease; }' : '',
    hasCollapsibles ? '      details.collapsible[open] > summary::before { transform:rotate(45deg) translate(-0.08rem,-0.08rem); }' : '',
    hasCollapsibles ? '      details.collapsible > summary[data-level="2"] { font-size:1.7rem; font-weight:700; line-height:1.25; letter-spacing:-0.01em; }' : '',
    hasCollapsibles ? '      details.collapsible > summary[data-level="3"] { font-size:1.32rem; line-height:1.3; }' : '',
    hasCollapsibles ? '      details.collapsible > summary[data-level="4"] { font-size:1.12rem; font-weight:700; line-height:1.35; }' : '',
    hasCollapsibles ? '      .collapsible-body { padding-left:1.35rem; margin-top:0.5rem; }' : '',
    hasCollapsibles ? '      .collapsible-body > :first-child { margin-top:0; }' : '',
    hasCollapsibles ? '      .collapsible-body > :last-child { margin-bottom:0; }' : '',
    hasVideo ? '      .vwrap { position:relative; display:block; width:fit-content; max-width:100%; margin:0 auto; line-height:0; }' : '',
    hasVideo ? '      figure[style] .vwrap, figure[data-pair] .vwrap, figure[data-pair] + figure .vwrap { width:100%; }' : '',
    hasVideo ? '      .vplay { position:absolute; left:50%; top:50%; width:76px; height:76px; margin:-38px 0 0 -38px; padding:0; border:none; border-radius:50%; background:rgba(20,24,30,0.58); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); box-shadow:0 4px 18px rgba(0,0,0,0.25); transition:opacity 0.18s, transform 0.18s, background 0.18s; }' : '',
    hasVideo ? '      .vplay svg { width:36px; height:36px; margin-left:4px; }' : '',
    hasVideo ? '      .vplay:hover { background:rgba(20,24,30,0.72); transform:scale(1.06); }' : '',
    hasVideo ? '      .vwrap.playing .vplay { opacity:0; pointer-events:none; transform:scale(0.9); }' : '',
    hasVideo ? '      @media (max-width:560px) { .vplay { width:60px; height:60px; margin:-30px 0 0 -30px; } .vplay svg { width:28px; height:28px; } }' : '',
    '      hr { border:none; border-top:1px solid rgba(39,50,63,0.15); margin:2.2rem auto; width:40%; }',
    '      sup a { text-decoration:none; color:var(--text-color); font-weight:600; }',
    '      .fn-divider { width:100%; margin:3rem 0 1.2rem; }',
    '      .fn-label { font-family:system-ui, sans-serif; font-size:0.66rem; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); margin:0 0 0.9rem 2px; }',
    '      ol.footnotes { font-size:0.92rem; line-height:1.5; color:var(--text-color); list-style:none; padding-left:0; }',
    '      ol.footnotes li { display:flex; gap:0.5rem; margin-bottom:0.7rem; }',
    '      ol.footnotes .fn-text { flex:1; min-width:0; }',
    '      ol.footnotes p, ol.footnotes div { margin:0 0 0.4rem; }',
    '      ol.footnotes p:last-child, ol.footnotes div:last-child { margin-bottom:0; }',
    '      ol.footnotes img { display:block; max-width:100%; height:auto; border-radius:8px; margin:0.5rem 0; }',
    '      ol.footnotes li:focus { outline:none; }',
    '      .fn-back { flex:none; min-width:1.4rem; color:var(--muted); font-weight:600; text-decoration:none; }',
    '      .fn-back:hover { color:var(--text-color); }',
    // the brief highlight on a note (going out) or its marker (coming back), as in the editor
    '      .fn-flash { background-color:rgba(230,178,60,0.32); box-shadow:0 0 0 0.3em rgba(230,178,60,0.32); border-radius:3px; }',
    '      .fn-flash.fn-flash-fade { background-color:rgba(230,178,60,0); box-shadow:0 0 0 0.3em rgba(230,178,60,0); transition:background-color 1.2s ease-out, box-shadow 1.2s ease-out; }',
    footHtml ? '      .fn-return { position:fixed; left:50%; bottom:calc(1.4rem + env(safe-area-inset-bottom, 0px)); transform:translateX(-50%); z-index:20; display:inline-flex; align-items:center; gap:0.45rem; padding:0.6rem 1.05rem 0.6rem 0.9rem; border:none; border-radius:999px; background:var(--text-color); color:var(--bg-color); font:600 0.8rem/1 system-ui, -apple-system, sans-serif; letter-spacing:0.01em; white-space:nowrap; cursor:pointer; box-shadow:0 1px 3px rgba(39,50,63,0.14), 0 6px 18px rgba(39,50,63,0.2); animation:fn-return-in 0.2s ease-out; }' : '',
    footHtml ? '      .fn-return[hidden] { display:none; }' : '',
    footHtml ? '      .fn-return:hover { background:#1b2430; }' : '',
    footHtml ? '      @keyframes fn-return-in { from { opacity:0; transform:translate(-50%, 0.5rem); } }' : '',
    footHtml ? '      @media (prefers-reduced-motion: reduce) { .fn-return { animation:none; } }' : '',
    peekCss ? '      .fn-peek { position:absolute; z-index:30; box-sizing:border-box; max-height:min(50vh, 22rem); overflow-y:auto; display:flex; gap:0.55rem; padding:0.75rem 0.95rem; background:#faf6ee; color:var(--text-color); border:1px solid rgba(39,50,63,0.14); border-radius:10px; box-shadow:0 1px 3px rgba(39,50,63,0.1), 0 8px 26px rgba(39,50,63,0.16); font-size:0.9rem; line-height:1.5; text-align:left; animation:fn-peek-in 0.12s ease-out; }' : '',
    peekCss ? '      .fn-peek[hidden] { display:none; }' : '',
    footHtml ? '      .fn-peek-n { flex:none; font-weight:600; color:var(--muted); }' : '',
    peekCss ? '      .fn-peek-body { flex:1; min-width:0; overflow-wrap:break-word; }' : '',
    peekCss ? '      .fn-peek-body p, .fn-peek-body div { margin:0 0 0.4rem; }' : '',
    peekCss ? '      .fn-peek-body p:last-child, .fn-peek-body div:last-child { margin-bottom:0; }' : '',
    peekCss ? '      .fn-peek-body img { display:block; max-width:100%; height:auto; border-radius:8px; margin:0.4rem 0; }' : '',
    peekCss ? '      .fn-peek-body .katex-display { margin:0.4rem 0; overflow-x:auto; overflow-y:hidden; }' : '',
    peekCss ? '      @keyframes fn-peek-in { from { opacity:0; transform:translateY(3px); } }' : '',
    peekCss ? '      .fn-peek.up { animation-name:fn-peek-in-up; }' : '',
    peekCss ? '      @keyframes fn-peek-in-up { from { opacity:0; transform:translateY(-3px); } }' : '',
    hasParaLinks ? '      .para-peek { flex-direction:column; gap:0.45rem; cursor:pointer; }' : '',
    hasParaLinks ? '      .para-peek .fn-peek-body { font-style:italic; }' : '',
    hasParaLinks ? '      .para-peek-go { align-self:flex-end; font:600 0.72rem/1 system-ui, -apple-system, sans-serif; color:var(--muted); }' : '',
    hasParaLinks ? '      .para-peek:hover .para-peek-go { color:var(--text-color); }' : '',
    hasParaLinks ? '      p[id^="p-"] { scroll-margin-top:1.4rem; }' : '',
    peekCss ? '      @media (prefers-reduced-motion: reduce) { .fn-peek { animation:none; } }' : '',
    ...(version || draft ? PROV_CSS : []),
    footHtml ? '      @media screen {' : '',
    footHtml ? '        body.fn-side .container { position:relative; margin-left:min(calc((100vw - 820px) / 2 - 24px), calc(100vw - 1160px)); margin-right:0; }' : '',
    footHtml ? '        body.fn-side .fn-divider, body.fn-side .fn-label { display:none; }' : '',
    footHtml ? '        body.fn-side ol.footnotes { position:absolute; top:0; left:calc(100% + 2rem); width:260px; margin:0; font-size:0.85rem; line-height:1.5; }' : '',
    footHtml ? '        body.fn-side ol.footnotes li { position:absolute; left:0; right:0; margin:0; color:rgba(39,50,63,0.8); overflow:hidden; background:var(--bg-color); transition:color 0.15s, max-height 0.38s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.3s; }' : '',
    // a cut-off note: "…" at the end of its last whole line, fading the words under it
    footHtml ? '        body.fn-side ol.footnotes li.fn-clip::after { content:"…"; position:absolute; right:0; top:var(--fn-ell, 0); padding-left:3em; line-height:inherit; color:inherit; background:linear-gradient(to right, rgba(241,235,223,0), var(--bg-color) 55%); transition:opacity 0.15s; pointer-events:none; }' : '',
    footHtml ? '        body.fn-side ol.footnotes li.fn-open, body.fn-side ol.footnotes li.fn-closing { z-index:3; }' : '',
    footHtml ? '        body.fn-side ol.footnotes li.fn-open { box-shadow:0 14px 18px -12px rgba(39,50,63,0.18); color:var(--text-color); }' : '',
    footHtml ? '        body.fn-side ol.footnotes li.fn-open::after, body.fn-side ol.footnotes li.fn-closing::after { opacity:0; }' : '',
    footHtml ? '        @media (prefers-reduced-motion: reduce) { body.fn-side ol.footnotes li { transition:color 0.15s; } }' : '',
    footHtml ? '        body.fn-side ol.footnotes li:hover, body.fn-side ol.footnotes li:focus, body.fn-side ol.footnotes li:focus-within, body.fn-side ol.footnotes li.fn-hot { color:var(--text-color); }' : '',
    footHtml ? '        body.fn-side ol.footnotes .fn-back, body.fn-side ol.footnotes a { color:inherit; }' : '',
    footHtml ? '        body.fn-side ol.footnotes .fn-text { overflow-wrap:break-word; }' : '',
    footHtml ? '        body.fn-side ol.footnotes .katex-display { margin:0.4rem 0; overflow-x:auto; overflow-y:hidden; }' : '',
    footHtml ? '      }' : '',
    hasSliders ? '      .eqs { margin:1.6rem 0 0.5rem; }' : '',
    hasSliders ? '      .eqs-stack { display:grid; align-items:center; justify-items:center; }' : '',
    hasSliders ? '      .eqs-stage { grid-area:1 / 1; max-width:100%; text-align:center; overflow-x:auto; overflow-y:hidden; padding:0.2rem 0.1rem; }' : '',
    hasSliders ? '      .eqs-stage .katex-display { margin:0; }' : '',
    hasSliders ? '      .eqs-why { margin-top:0.35rem; font:400 0.74rem/1.4 system-ui, -apple-system, sans-serif; color:var(--muted); }' : '',
    hasSliders ? '      .eqs:not(.on) .katex [style*="color"] { color:inherit !important; }' : '',
    hasSliders ? '      .katex [style*="color"] { transition:color 0.18s; }' : '',
    hasSliders ? '      .eqs-ctl { display:flex; align-items:center; justify-content:center; gap:0.65rem; height:2rem; margin-top:0.25rem; opacity:0; transition:opacity 0.16s; font:500 0.7rem/1 system-ui, -apple-system, sans-serif; color:var(--muted); user-select:none; }' : '',
    hasSliders ? '      .eqs.on .eqs-ctl { opacity:1; }' : '',
    hasSliders ? '      .eqs-track { position:relative; width:150px; height:18px; display:flex; align-items:center; }' : '',
    hasSliders ? '      .eqs-track::before { content:""; position:absolute; left:0; right:0; top:50%; height:1.5px; margin-top:-0.75px; background:rgba(39,50,63,0.2); border-radius:2px; }' : '',
    hasSliders ? '      .eqs-tick { position:absolute; top:50%; width:3px; height:3px; margin:-1.5px 0 0 -1.5px; border-radius:50%; background:rgba(39,50,63,0.38); pointer-events:none; }' : '',
    hasSliders ? '      .eqs input[type=range] { position:relative; -webkit-appearance:none; appearance:none; width:100%; height:18px; margin:0; background:transparent; cursor:grab; touch-action:none; }' : '',
    hasSliders ? '      .eqs input[type=range]:active { cursor:grabbing; }' : '',
    hasSliders ? '      .eqs input[type=range]:focus { outline:none; }' : '',
    hasSliders ? '      .eqs input[type=range]::-webkit-slider-runnable-track { height:18px; background:transparent; }' : '',
    hasSliders ? '      .eqs input[type=range]::-moz-range-track { height:18px; background:transparent; }' : '',
    hasSliders ? '      .eqs input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; margin-top:3px; border-radius:50%; background:var(--text-color); border:none; box-shadow:0 0 0 3px var(--bg-color); }' : '',
    hasSliders ? '      .eqs input[type=range]::-moz-range-thumb { width:12px; height:12px; border-radius:50%; background:var(--text-color); border:none; box-shadow:0 0 0 3px var(--bg-color); }' : '',
    hasSliders ? '      .eqs input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow:0 0 0 3px var(--bg-color), 0 0 0 5px rgba(15,122,229,0.55); }' : '',
    hasSliders ? '      .eqs input[type=range]:focus-visible::-moz-range-thumb { box-shadow:0 0 0 3px var(--bg-color), 0 0 0 5px rgba(15,122,229,0.55); }' : '',
    hasSliders ? '      @media print { .eqs-ctl { display:none; } }' : '',
    hasSliders ? '      @media (prefers-reduced-motion: reduce) { .eqs-ctl, .katex [style*="color"] { transition:none; } }' : '',
    footHtml ? '      .rd-gear { position:fixed; top:1rem; right:1rem; z-index:30; width:34px; height:34px; padding:7px; border:none; border-radius:9px; background:transparent; color:var(--muted); cursor:pointer; transition:background 0.14s, color 0.14s; }' : '',
    footHtml ? '      .rd-gear[hidden], .rd-panel[hidden] { display:none; }' : '',
    footHtml ? '      .rd-gear:hover, .rd-gear[aria-expanded=true] { background:rgba(39,50,63,0.08); color:var(--text-color); }' : '',
    footHtml ? '      .rd-gear svg { display:block; width:100%; height:100%; }' : '',
    footHtml ? '      .rd-panel { position:fixed; top:3.4rem; right:1rem; z-index:30; width:236px; padding:0.8rem 0.85rem 0.85rem; background:#faf6ee; border:1px solid rgba(39,50,63,0.12); border-radius:12px; box-shadow:0 8px 30px rgba(39,50,63,0.13); font:400 0.75rem/1.3 system-ui, -apple-system, sans-serif; color:var(--muted); }' : '',
    footHtml ? '      .rd-name { margin-bottom:0.35rem; }' : '',
    footHtml ? '      .rd-seg { display:flex; padding:2px; background:rgba(39,50,63,0.06); border-radius:9px; }' : '',
    footHtml ? '      .rd-seg button { flex:1; padding:0.32rem 0.5rem; border:none; border-radius:7px; background:transparent; font:500 0.76rem/1.2 system-ui, -apple-system, sans-serif; color:var(--muted); cursor:pointer; }' : '',
    footHtml ? '      .rd-seg button[aria-pressed=true] { background:var(--bg-color); color:var(--text-color); box-shadow:0 1px 3px rgba(39,50,63,0.14); }' : '',
    footHtml ? '      @media print { .rd-gear, .rd-panel { display:none; } }' : '',
    hasToc ? '      html { scroll-behavior:smooth; }' : '',
    hasToc ? '      h2[id], h3[id], h4[id] { scroll-margin-top:1.4rem; }' : '',
    version ? '      .home { position:fixed; top:1.6rem; left:2rem; padding:0.2rem 2px; font-family:system-ui, sans-serif; font-size:0.66rem; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); text-decoration:none; transition:color 0.12s, opacity 0.2s ease-out; }' : '',
    version ? '      .home:hover { color:var(--text-color); }' : '',
    version ? '      .toc.quiet ~ .home { opacity:0; transition:opacity 1.6s ease-in; }' : '',
    version ? '      .toc.quiet ~ .home:hover, .toc.quiet ~ .home:focus { opacity:1; transition:opacity 0.2s ease-out; }' : '',
    version ? '      .home-arr, .home-all { display:none; } @media (max-width:1060px) { .home { position:static; display:flex; align-items:center; gap:0.2rem; width:fit-content; height:2.5rem; padding:0 0.7rem 0 0.25rem; margin:0.9rem 0 0 max(-0.45rem, calc((100% - 820px) / 2 - 0.45rem)); border-radius:1.25rem; font-family:system-ui, sans-serif; font-size:0.95rem; font-weight:600; letter-spacing:0; text-transform:none; color:var(--text-color); -webkit-tap-highlight-color:transparent; } .home:active { background:rgba(39,50,63,0.08); } .toc.quiet ~ .home { opacity:1; } .home-txt { display:none; } .home-arr { display:block; width:22px; height:22px; } .home-all { display:inline; } .home + .container { margin-top:0.3rem; } }' : '',
    hasToc ? '      .toc { position:fixed; top:' + (version ? '3.9rem' : '2.2rem') + '; left:2rem; width:220px; max-height:calc(100vh - ' + (version ? '6.2rem' : '4.5rem') + '); overflow-y:auto; scrollbar-width:none; }' : '',
    hasToc ? '      .toc::-webkit-scrollbar { display:none; }' : '',
    hasToc ? '      .toc-label { font-family:system-ui, sans-serif; font-size:0.66rem; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); margin:0 0 0.8rem 2px; }' : '',
    hasToc ? '      .toc-list { border-left:2px solid rgba(39,50,63,0.14); padding:0.2rem 0; display:flex; flex-direction:column; gap:0.3rem; }' : '',
    hasToc ? '      .toc-item { position:relative; display:block; padding:0.22rem 0.4rem 0.22rem 0.95rem; font-size:0.92rem; line-height:1.35; color:rgba(39,50,63,0.75); text-decoration:none; transition:color 0.12s; }' : '',
    hasToc ? '      .toc-label, .toc-list { transition:opacity 0.2s ease-out; }' : '',
    hasToc ? '      .toc.quiet .toc-label, .toc.quiet .toc-list { opacity:0; transition:opacity 1.6s ease-in; }' : '',
    hasToc ? '      @media (prefers-reduced-motion: reduce) { .toc-label, .toc-list, .toc.quiet .toc-label, .toc.quiet .toc-list { transition:none; } }' : '',
    hasToc ? '      .toc-item:hover { color:var(--text-color); }' : '',
    hasToc ? '      .toc-item.lvl-3 { padding-left:1.8rem; font-size:0.85rem; }' : '',
    hasToc ? '      .toc-item.lvl-4 { padding-left:2.6rem; font-size:0.8rem; }' : '',
    hasToc ? '      .toc-item.hide { display:none; }' : '',
    hasToc ? '      .toc-item.active { color:var(--text-color); font-weight:700; }' : '',
    hasToc ? '      .toc-item.active::before { content:""; position:absolute; left:-2px; top:0.18rem; bottom:0.18rem; width:3px; background:var(--text-color); border-radius:2px; }' : '',
    hasToc ? '      @media (max-width:1250px) { .toc { display:none; } }' : '',
    '    </style>',
    '  </head>',
    // what publishing checks to tell whether the live page's style is out of date
    '  <body' + (looks.kind === 'poem' ? ' class="poem"' : '') + (styleKey(looks) ? ' data-style="' + escapeHtml(styleKey(looks)) + '"' : '') + '>',
    tocHtml,
    // a quiet way home: in the left margin above Contents (wide screens)
    version ? '    <a class="home" href="../writings.html" aria-label="All writings"><span class="home-txt">← Writings</span><svg class="home-arr" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="home-all">All writings</span></a>' : '',
    '    <main class="container">',
    // Unlisted drafts are shared out of context, so no back-link to the writings index.
    version ? '' : provHtml, // a draft's label
    '      <h1>' + title + '</h1>',
    subtitle ? '      <p class="subtitle">' + subtitle + '</p>' : '',
    '      <div class="meta">' + bylineHtml() + '<span>' + escapeHtml(dateStr) + ' · ' + minutes + ' min</span>' + (version ? provHtml : '') + '</div>',
    '      ' + bodyHtml,
    footHtml,
    '    </main>',
    // ?v=N: an older version's text, swapped in before the scripts below start
    version ? '    <script>(' + provOld.toString() + ')(' + JSON.stringify([hasToc && 'toc', footHtml && 'fn', hasSliders && 'sliders', hasCollapsibles && 'details', hasVideo && 'video', hasEmbed && 'embed', bodyHtml.includes('canvas-item') && 'canvas'].filter(Boolean)) + ');</script>' : '',
    footHtml ? '    <button class="fn-return" id="fnReturn" type="button" hidden><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 10.5v-9M2 5.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Back to reading</button>' : '',
    tocScript,
    hasToc ? '    <script>(' + tocFade.toString() + ')();</script>' : '',
    provScript,
    CONFIG.author && CONFIG.author.name ? '    <script>(' + bylineToggle.toString() + ')();</script>' : '',
    footHtml ? '    <script>(' + fnTrip.toString() + ')();</script>' : '',
    footHtml ? '    <script>(' + fnPeek.toString() + ')();</script>' : '',
    footHtml ? '    <script>(' + fnSide.toString() + ')(' + fnMinWidth + ',' + JSON.stringify(fnMargin ? 'side' : 'below') + ');</script>' : '',
    hasSliders ? '    <script>(' + eqSlider.toString() + ')();</script>' : '',
    hasCollapsibles ? '    <script>(' + collapsibleReveal.toString() + ')();</script>' : '',
    hasParaLinks ? '    <script>(' + paraPeek.toString() + ')();</script>' : '',
    hasVideo ? '    <script>(' + vidPlay.toString() + ')();</script>' : '',
    hasEmbed ? '    <script>(' + embedResize.toString() + ')();</script>' : '',
    bodyHtml.includes('canvas-item') ? '    <script>(' + canvasPlace.toString() + ')();</script>' : '',
    '  </body>',
    '</html>',
    '',
  ].filter((l) => l !== '').join('\n')
}

const TECH_MARK = '<span class="post-tech" tabindex="0" data-tip="technical" aria-label="technical">*</span>'

// Insert a new <li> into writings.html's post list (or fail loudly if the layout is missing).
// Returns true when the index changed (the new text is queued on `sink`).
async function updateWritingsIndex(sink, post) {
  const r = await fetch('/writings.html', { cache: 'no-store' })
  if (!r.ok) throw new Error('writings.html not found at the project root.')
  let text = await r.text()

  const liId = 'post-' + post.slug
  const sub = (post.subtitle || '').trim()
  const subHtml = sub ? '<p class="post-sub">' + escapeHtml(sub) + '</p>' : ''
  // technical pieces: a faint * after the title, "technical" on hover/tap (nothing on the article)
  const tech = post.technical ? TECH_MARK : ''
  if (text.includes('id="' + liId + '"')) {
    // already listed: keep its subtitle line and * in step with the article's
    const li0 = text.indexOf('<li class="post" id="' + liId + '">')
    const li1 = text.indexOf('</li>', li0)
    let item = text.slice(li0, li1).replace(TECH_MARK, '')
    const re = /^([\s\S]*?<\/a\s*>)(\s*<p class="post-sub">[\s\S]*?<\/p>)?(?=\s*<p class="post-meta">)/
    item = item.replace(re, (m, head) => head + tech + (subHtml ? '\n            ' + subHtml : ''))
    const next = text.slice(0, li0) + item + text.slice(li1)
    if (next === text) return false
    await sink.add('writings.html', next)
    return true
  }

  const thumbInner = post.thumb
    ? '<img src="' + post.thumb + '" alt="" onerror="this.parentNode.classList.add(\'no-img\');this.remove();" />'
    : ''
  const li =
    '\n        <li class="post" id="' + liId + '">\n' +
    '          <a class="post-thumb" href="writings/' + post.slug + '.html">' + thumbInner + '</a>\n' +
    '          <div class="post-info">\n' +
    '            <a class="post-title" href="writings/' + post.slug + '.html">' + escapeHtml(post.title) + '</a>' + tech + '\n' +
    (subHtml ? '            ' + subHtml + '\n' : '') +
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
  let mode = 'draft'        // 'draft' (the default) | 'publish'
  let busy = false

  const readingMinutes = () => {
    return Math.max(1, Math.round(wordCount() / 200))
  }
  // words readers actually get: what an in-progress section holds back doesn't count
  const wordCount = () => {
    let text = ''
    let cutLevel = 0
    editor.state.doc.forEach((node) => {
      const heading = node.type.name === 'heading'
      if (cutLevel && heading && node.attrs.level <= cutLevel) cutLevel = 0
      if (cutLevel) return
      text += node.textContent
      if (heading && node.attrs.inProgress) cutLevel = node.attrs.level
    })
    return (text.trim().match(/\S+/g) || []).length
  }

  function setMode(m) {
    mode = m
    document.querySelectorAll('#pubMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m))
    $('pubPublishFields').hidden = m !== 'publish'
    $('pubDraftFields').hidden = m !== 'draft'
    $('publishConfirm').textContent = m === 'draft' ? 'Create draft link' : 'Publish'
    setMsg($('publishMsg'), '', '')
  }

  // Default thumbnail = the article's first image. The user can still pick another.
  function seedThumbFromBody(bodyHtml) {
    const src = firstImageSrc(bodyHtml)
    const drop = $('thumbDrop')
    pendingThumb = null
    if (!src) { drop.textContent = 'Choose an image'; drop.classList.remove('has-img'); return }
    if (src.startsWith('data:')) {
      const ext = ((src.substring(5, src.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg'))
      pendingThumb = { dataUrl: src, ext }
    } else {
      pendingThumb = { path: src }
    }
    drop.innerHTML = '<img src="' + src.replace(/"/g, '&quot;') + '" alt="thumb"/><span class="thumb-hint">first image · click to change</span>'
    drop.classList.add('has-img')
  }

  async function showVersionInfo(slug) {
    const el = $('pubVersionInfo')
    if (!el) return
    el.textContent = ''
    try {
      const m = await apiJson('/api/proofs?slug=' + encodeURIComponent(slug))
      const vs = m.versions || []
      if (!vs.length) { el.textContent = 'v1'; return }
      const last = vs[vs.length - 1]
      const pending = vs.filter((v) => v.status === 'pending').length
      el.textContent = 'v' + last.n + ' · ' + longDate(last.date) + (pending ? ' · timestamp pending' : '')
    } catch (e) {
      el.textContent = 'Editor server not running'
    }
  }

  // Technical? As the writings list has it now; for a piece not listed yet, whether its draft
  // sits in the drafts menu's Technical folder.
  async function seedTechnical(slug, id) {
    const box = $('pubTechnical')
    let inFolder = false
    try { inFolder = ((JSON.parse(localStorage.getItem(LS.layout) || '{}').order || {}).technical || []).includes(id) } catch (e) {}
    box.checked = inFolder
    try {
      const t = await fetch('/writings.html', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''))
      const at = t.indexOf('<li class="post" id="post-' + slug + '">')
      if (at >= 0) box.checked = t.slice(at, t.indexOf('</li>', at)).includes('class="post-tech"')
    } catch (e) {}
  }

  function openPublish() {
    const snap = currentSnapshot()
    const titleText = htmlToText(snap.title)
    if (!titleText) { toast('Add a title first'); return }
    $('pubSlug').value = slugify(titleText)
    $('pubDate').value = todayLong()
    const held = holdBackSections(snap.body)
    seedThumbFromBody(held.html)
    const heldEl = $('pubHeld')
    heldEl.hidden = !held.titles.length
    heldEl.innerHTML = held.titles.length
      ? '<b>In progress:</b> ' + held.titles.map(escapeHtml).join(', ') + '. Readers see only the heading and a note.' +
        (held.deadLinks ? ' ' + (held.deadLinks === 1 ? 'A link' : held.deadLinks + ' links') + ' into that text become plain words.' : '')
      : ''
    setMode('draft')
    showVersionInfo(slugify(titleText))
    seedTechnical(slugify(titleText), snap.id)
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
      // the list shows it at 120px wide: 480px is plenty, even on retina
      const o = await optimizeImage(dataUrlToBlob(pendingThumb.dataUrl), pendingThumb.ext, 480)
      const name = slug + '-thumb.' + o.ext
      await sink.add('media/' + name, o.blob)
      return 'media/' + name
    }
    const p = pendingThumb.path || ''
    if (p.startsWith(DRAFT_MEDIA)) {           // a GIF stored on the local server
      const name = slug + '-thumb.' + p.split('.').pop().toLowerCase()
      await sink.add('media/' + name, await fetchDraftMedia(p))
      return 'media/' + name
    }
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
    setMsg(msg, 'Working…', '')
    try {
      const sink = makeSink()
      const mediaPrefix = draft ? '../media/' : 'media/'

      // 1) split inline data-URI images out to writings/media/<slug>-<hash>.<ext>
      //    (footnote images likewise, as <slug>-fn-<hash>.<ext>)
      const held = holdBackSections(snap.body).html
      const { html: bodyHtml, files, toc } = await buildBody(held, slug, mediaPrefix, { sliders: normalizeStyle(snap.style).eqSlider !== 'off', poemDates: normalizeStyle(snap.style).poemDates === 'each' })
      const { html: footHtml, files: fnFiles } = await buildFootnotesHtml($('fnList'), slug, mediaPrefix, held)
      files.push(...fnFiles)
      for (const f of files) await sink.add('writings/media/' + f.name, f.blob)

      const minutes = readingMinutes()
      const subtitleText = htmlToText(snap.subtitle)
      const common = { titleText, subtitleText, dateStr, minutes, font: snap.font, style: snap.style, bodyHtml, footHtml, toc, slug }
      const site = (CONFIG.siteUrl || '').replace(/\/$/, '')

      /* ---------------------------------------------------------- draft link */
      if (draft) {
        const token = await shareTokenFor(snap.id || 'doc')
        const html = buildArticleHtml(Object.assign({}, common, { draft: true }))
        const rel = 'writings/p/' + token + '.html'
        await sink.add(rel, html)
        const url = site + '/' + rel
        $('draftUrl').value = url
        const written = await sink.flush()
        await sitePush(written, 'Draft preview: ' + titleText)
        setMsg(msg, 'Live in a minute.', 'ok')
        toast('Draft link pushed')
        if (window.__drafts && snap.id) window.__drafts.markOutbound(snap.id) // first draft link: into the Outbound folder
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
        stampNote = 'Text unchanged since v' + n + '.'
        // A new style with the same text is still v<N>: only the live page changes. The frozen
        // copy stays as it was stamped, so its timestamp proof keeps checking out.
        const live = await fetch('/writings/' + slug + '.html', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null)
        const liveStyle = live === null ? null : ((/<body[^>]*\sdata-style="([^"]*)"/.exec(live) || [])[1] || '')
        if (liveStyle !== null && liveStyle !== styleKey(snap.style)) {
          await sink.add('writings/' + slug + '.html', buildArticleHtml(Object.assign({}, common, { version: { n, date: versionDate } })))
          stampNote += ' Style updated.'
        }
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
        await updateWritingsIndex(sink, { slug, title: titleText, subtitle: subtitleText, date: dateStr, minutes, thumb: thumbPath, technical: $('pubTechnical').checked })
      }

      const written = await sink.flush()

      // 5) anchor the fingerprint in Bitcoin (server → OpenTimestamps calendars)
      if (sha) {
        try {
          const r = await apiJson('/api/stamp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, n, sha256: sha, contentSha256: contentSha, date: versionDate, title: titleText, words: wordCount() }),
          })
          const cals = (r.entry && r.entry.calendars || []).length
          stampNote = cals ? 'Timestamp submitted; Bitcoin confirmation lands in a few hours.' : ''
        } catch (e) {
          stampNote = 'Not timestamped (' + escapeHtml(e.message || 'server error') + ') — publish again to retry.'
        }
      }

      // 6) commit + push everything this publish touched (proofs included)
      await sitePush(written.concat(['writings/proofs']), 'Publish: ' + titleText + ' (v' + n + ')')
      const url = site + '/writings/' + slug + '.html'
      setMsg(msg, '<a href="' + url + '" target="_blank" rel="noopener">v' + n + '</a> live in a minute. ' + stampNote, 'ok')
      toast('Published v' + n + ' ✓')
      if (window.__drafts && snap.id) window.__drafts.markPublished(snap.id) // first publish: into the Published folder
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
  // Copy for Substack: the clipboard is written from inside the click (a promised blob keeps
  // the browser's permission while the page loads)
  $('pubSubstack').addEventListener('click', () => {
    const slug = slugify($('pubSlug').value || htmlToText(currentSnapshot().title))
    let math = false, failed = null
    const html = substackHtml(slug).then((x) => { math = x.math; return x.html }, (e) => { failed = e; throw e })
    const item = new ClipboardItem({
      'text/html': html.then((h) => new Blob([h], { type: 'text/html' })),
      'text/plain': html.then((h) => { const d = document.createElement('div'); d.innerHTML = h; return new Blob([d.innerText], { type: 'text/plain' }) }),
    })
    navigator.clipboard.write([item])
      .then(() => toast(math ? 'Copied. It has math, which Substack shows as LaTeX text' : 'Copied — paste into a new Substack post; title and subtitle go in their own fields'))
      .catch(() => toast(failed ? failed.message : "Couldn't copy for Substack"))
  })
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
