/* publish.js — one-click publish to the static site's writings/ folder.
 *
 * Opens #publishOverlay, then on confirm builds a standalone article HTML from the
 * current doc and writes it into the project's writings/<slug>.html via the File
 * System Access API. Inline data-URI images are split out into media/ files; the
 * writings.html index list is optionally updated. Everything is USER-GATED: the
 * browser folder picker means nothing is written until the user grants access.
 *
 * Ported (and adapted to TipTap/ProseMirror) from the v1 editor.html:
 * buildArticleHtml / bodyToPublishHtml / sanitizeNode / updateWritingsIndex.
 * NOTE: v2's editor.getHTML() serialises math as <span class="math-inline" data-tex>$..$</span>
 * / <div class="math-block" data-tex>$$..$$</div> and footnote refs as <sup class="fn-ref"
 * data-fn>•</sup> (the number is NOT in the serialised form), so this module re-numbers the
 * refs in document order and pulls the footnote bodies (already numbered) from the live #fnList.
 *
 * This writes to writings/ (the public site), NOT to the drafts store or the server sync,
 * so it is safe to run in SANDBOX mode.
 */

import { $, escapeHtml, slugify, todayLong, toast } from './dom.js'

/* ---------------------------------------------------------- File System Access */
// Remember the chosen project folder across reloads (a directory handle survives in IDB).
const IDB_NAME = 'ahilan.editor2.fs'
const IDB_STORE = 'handles'
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGet(key) {
  const db = await idbOpen()
  return new Promise((res, rej) => {
    const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
    rq.onsuccess = () => res(rq.result)
    rq.onerror = () => rej(rq.error)
  })
}
async function idbSet(key, val) {
  const db = await idbOpen()
  return new Promise((res, rej) => {
    const t = db.transaction(IDB_STORE, 'readwrite')
    t.objectStore(IDB_STORE).put(val, key)
    t.oncomplete = () => res()
    t.onerror = () => rej(t.error)
  })
}

let projectHandle = null
// Resolve (remembering across sessions) a read-write handle to the project root the user
// picks. requestPermission runs inside the publish click, so the gesture requirement is met.
async function ensureProjectHandle() {
  if (projectHandle) {
    if ((await projectHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return projectHandle
    if ((await projectHandle.requestPermission({ mode: 'readwrite' })) === 'granted') return projectHandle
  }
  const saved = await idbGet('projectDir').catch(() => null)
  if (saved) {
    const perm = await saved.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted' || (await saved.requestPermission({ mode: 'readwrite' })) === 'granted') {
      projectHandle = saved
      return projectHandle
    }
  }
  if (!window.showDirectoryPicker) throw new Error('Use Chrome on localhost for one-click publish (File System Access API).')
  projectHandle = await window.showDirectoryPicker({ id: 'ahilan-project', mode: 'readwrite' })
  await idbSet('projectDir', projectHandle).catch(() => {})
  return projectHandle
}

async function writeFile(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(blob)
  await w.close()
}
function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',')
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/png'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
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

// Footnote bodies stay footnote-sized: inline formatting only, matching the editor's own
// footnote normaliser (footnote.js, which isn't exported — re-implemented small here).
const FN_ALLOW = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'SUP', 'SUB'])
const FN_ATTRS = { A: ['href', 'target', 'rel'] }
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

// Split inline data-URI images out to media/ files and drop unresolvable videos, then
// return { html, files } ready for buildArticleHtml + writeFile.
function buildBody(bodyHtml, slug) {
  const clone = document.createElement('div')
  clone.innerHTML = bodyHtml || ''
  const files = []
  let i = 0
  clone.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (src.startsWith('data:')) {
      i++
      const ext = (src.substring(5, src.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg')
      const name = slug + '-' + i + '.' + ext
      files.push({ name, blob: dataUrlToBlob(src) })
      img.setAttribute('src', 'media/' + name)
    }
  })
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
function buildFootnotesHtml(fnListEl) {
  const items = fnListEl ? Array.from(fnListEl.children).filter((li) => !li.classList.contains('fn-orphan')) : []
  if (!items.length) return ''
  let html = '\n      <hr class="fn-divider" />\n      <ol class="footnotes">\n'
  items.forEach((li, idx) => {
    const n = idx + 1 // index order matches the re-numbered body refs above
    const bodyEl = li.querySelector('.fn-body') || li
    const bodyClone = bodyEl.cloneNode(true)
    sanitizeNode(bodyClone)
    normalizeFnBody(bodyClone)
    html += '        <li id="fn-' + n + '">' + bodyClone.innerHTML + ' <a href="#fnref-' + n + '" class="fn-back">↩</a></li>\n'
  })
  html += '      </ol>\n'
  return html
}

// Build a full standalone article that matches the published site's aesthetic.
function buildArticleHtml({ titleText, subtitleText, dateStr, minutes, font, bodyHtml, footHtml, toc }) {
  const title = escapeHtml(titleText)
  const subtitle = escapeHtml(subtitleText)
  const hasToc = !!(toc && toc.length)

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

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
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
    '      .fn-back { text-decoration:none; }',
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
    '      <a class="back" href="../writings.html">← Writings</a>',
    '      <h1>' + title + '</h1>',
    subtitle ? '      <p class="subtitle">' + subtitle + '</p>' : '',
    '      <p class="meta">' + escapeHtml(dateStr) + ' · ' + minutes + ' min</p>',
    '      ' + bodyHtml,
    footHtml,
    '    </main>',
    tocScript,
    '  </body>',
    '</html>',
    '',
  ].filter((l) => l !== '').join('\n')
}

// Insert a new <li> into writings.html's post list (or fail loudly if the layout is missing).
async function updateWritingsIndex(root, post) {
  let fh, text
  try { fh = await root.getFileHandle('writings.html'); text = await (await fh.getFile()).text() }
  catch (e) { throw new Error('writings.html not found at the project root you selected.') }

  const liId = 'post-' + post.slug
  if (text.includes('id="' + liId + '"')) return // already listed

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
  const w = await fh.createWritable()
  await w.write(text)
  await w.close()
}

/* --------------------------------------------------------------------- wire up */
function setMsg(el, text, kind) {
  if (!el) return
  el.className = 'modal-msg' + (kind ? ' ' + kind : '')
  el.textContent = text
}

/**
 * setupPublish — wire the Publish button + modal.
 * @param {{ editor: import('../vendor/lib.bundle.js').Editor, currentSnapshot: () => object }} deps
 * @returns {{ open: () => void, publish: () => Promise<void> }}
 */
export function setupPublish({ editor, currentSnapshot }) {
  let pendingThumb = null

  const readingMinutes = () => {
    const words = ((editor.state.doc.textContent || '').trim().match(/\S+/g) || []).length
    return Math.max(1, Math.round(words / 200))
  }

  function openPublish() {
    const snap = currentSnapshot()
    const titleText = htmlToText(snap.title)
    if (!titleText) { toast('Add a title first'); return }
    $('pubSlug').value = slugify(titleText)
    $('pubDate').value = todayLong()
    setMsg($('publishMsg'), '', '')
    pendingThumb = null
    $('thumbDrop').textContent = 'Click to choose an image'
    $('publishOverlay').classList.remove('hidden')
  }
  const closePublish = () => $('publishOverlay').classList.add('hidden')

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
      }
      r.readAsDataURL(f)
    }
    inp.click()
  }

  async function doPublish() {
    const msg = $('publishMsg')
    const snap = currentSnapshot()
    const titleText = htmlToText(snap.title)
    if (!titleText) { setMsg(msg, 'Add a title before publishing.', 'err'); return }
    const slug = slugify($('pubSlug').value)
    if (!slug) { setMsg(msg, 'Add a slug before publishing.', 'err'); return }
    const dateStr = ($('pubDate').value || '').trim() || todayLong()
    setMsg(msg, 'Publishing…', '')
    try {
      const root = await ensureProjectHandle()
      const writingsDir = await root.getDirectoryHandle('writings', { create: true })

      // 1) split inline data-URI images out to writings/media/<slug>-N.<ext>
      const { html: bodyHtml, files, toc } = buildBody(snap.body, slug)
      const mediaDir = files.length ? await writingsDir.getDirectoryHandle('media', { create: true }) : null
      for (const f of files) await writeFile(mediaDir, f.name, f.blob)

      // 2) write the article html
      const minutes = readingMinutes()
      const articleHtml = buildArticleHtml({
        titleText,
        subtitleText: htmlToText(snap.subtitle),
        dateStr,
        minutes,
        font: snap.font,
        bodyHtml,
        footHtml: buildFootnotesHtml($('fnList')),
        toc,
      })
      await writeFile(writingsDir, slug + '.html', new Blob([articleHtml], { type: 'text/html' }))

      // 3) thumbnail -> media/<slug>-thumb.<ext> (top-level media/, per site convention)
      let thumbPath = ''
      if (pendingThumb) {
        const md = await root.getDirectoryHandle('media', { create: true })
        const name = slug + '-thumb.' + pendingThumb.ext
        await writeFile(md, name, dataUrlToBlob(pendingThumb.dataUrl))
        thumbPath = 'media/' + name
      }

      // 4) update the writings.html index list
      if ($('pubUpdateList').checked) {
        await updateWritingsIndex(root, { slug, title: titleText, date: dateStr, minutes, thumb: thumbPath })
      }

      setMsg(msg, 'Published writings/' + slug + '.html — commit & push to go live.', 'ok')
      toast('Published ✓')
    } catch (err) {
      setMsg(msg, err.message || 'Publish failed.', 'err')
    }
  }

  $('publishBtn').addEventListener('click', openPublish)
  $('publishClose').addEventListener('click', closePublish)
  $('publishConfirm').addEventListener('click', doPublish)
  $('thumbDrop').addEventListener('click', chooseThumb)
  // click the dark backdrop (not the modal) to dismiss
  $('publishOverlay').addEventListener('mousedown', (e) => { if (e.target === $('publishOverlay')) closePublish() })

  return { open: openPublish, publish: doPublish }
}
