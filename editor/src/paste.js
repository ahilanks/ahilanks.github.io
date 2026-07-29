/* paste.js — pasted text adopts THIS editor's typography, not the source page's.
 *
 * Copying from a web page puts that page's markup on the clipboard: inline `style`
 * attributes, class hooks, <font>/<span> wrappers, hard-coded colors and pixel sizes,
 * Word/Docs cruft. ProseMirror's schema drops a lot of that in the body, but not all of
 * it — and the plain contenteditable fields (title, subtitle, footnote bodies) get the
 * browser's *default* paste, which keeps every bit of it.
 *
 * So: keep the STRUCTURE (paragraphs, headings, lists, quotes, bold/italic, links) and
 * throw away everything that carries presentation. The editor's own CSS then styles it.
 *
 * Copy/paste WITHIN the editor is passed through untouched: ProseMirror tags its own
 * clipboard HTML with data-pm-slice, and that markup is already ours.
 */

// Presentation- or behaviour-only elements: dropped with their contents.
const DROP = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT',
  'EMBED', 'SVG', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION',
  'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'PICTURE', 'IMG',
])

// Wrappers with no meaning of their own: removed, children kept. (Their only job on most
// sites is to hang a font/size/color off — with attributes gone they'd just be noise.)
const UNWRAP = new Set([
  'SPAN', 'FONT', 'CENTER', 'MARK', 'SMALL', 'BIG', 'ABBR', 'TIME', 'DATA', 'LABEL',
  'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'WBR', 'INS',
])

// The few attributes worth keeping, by tag. Everything else — style, class, id, width,
// height, color, align, dir, data-*, aria-*, on* — goes.
const KEEP = { A: ['href'], OL: ['start'] }

// The editor's OWN markup (pasting from a published article of yours, or from a draft's
// saved HTML): kept verbatim so math, figures and footnote refs survive the round trip.
const OWN = [
  ['span.math-inline', ['class', 'data-tex']],
  ['div.math-block', ['class', 'data-tex', 'data-align']],
  ['sup.fn-ref', ['class', 'data-fn']],
  ['figure.img-block', ['class', 'data-w']],
  ['figure.video-block', ['class', 'data-w', 'data-vid']],
]
const OWN_SEL = OWN.map(([sel]) => sel).join(',')

function stripAttrs(el, keep) {
  Array.from(el.attributes).forEach((a) => {
    if (!keep.includes(a.name.toLowerCase())) el.removeAttribute(a.name)
  })
}

// One of our own nodes: keep its data-* payload, and inside a figure keep only the <img>
// source (the node view rebuilds the rest of the figure from the attributes).
function keepOwn(el) {
  const rule = OWN.find(([sel]) => el.matches(sel))
  stripAttrs(el, rule ? rule[1] : [])
  el.querySelectorAll('*').forEach((d) => stripAttrs(d, tagOf(d) === 'IMG' ? ['src', 'alt'] : []))
}

// SVG/MathML elements keep their authored (lowercase) name, unlike HTML ones — normalise
// so `svg` and `math` can't slip past the tag lists.
const tagOf = (el) => (el.tagName || '').toUpperCase()

/* ------------------------------------------------------------------ pasted equations
 * Math on other sites is rendered markup, and its visible half is a pile of positioned
 * glyph spans that would paste as unreadable soup. But the LaTeX is almost always right
 * there next to it — MathML's <annotation encoding="application/x-tex"> (Wikipedia,
 * KaTeX's MathML fallback), LaTeXML's alttext attribute, or MathJax v2's own
 * <script type="math/tex">. Where we find it, the whole thing becomes a real math node;
 * where we don't, the subtree goes rather than pasting the soup. */
const MATH_SEL = 'math, .katex, .katex-display, .mwe-math-element, mjx-container'
function mathNode(tex, block) {
  const el = document.createElement(block ? 'div' : 'span')
  el.className = block ? 'math-block' : 'math-inline'
  el.setAttribute('data-tex', tex)
  el.textContent = block ? '$$' + tex + '$$' : '$' + tex + '$'
  return el
}
function texOf(el) {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]')
  if (ann && ann.textContent.trim()) return ann.textContent.trim()
  const withAlt = el.hasAttribute('alttext') ? el : el.querySelector('math[alttext]')
  return withAlt ? (withAlt.getAttribute('alttext') || '').trim() : ''
}
function isDisplayMath(el) {
  return el.getAttribute('display') === 'block' ||
         /katex-display/.test(String(el.className || '')) ||
         !!el.querySelector('math[display="block"]')
}

/* Runs BEFORE clean() — while class names and sibling order are still intact, which the
 * MathJax v2 shape depends on. The nodes it leaves behind are our own math markup, so
 * clean() then treats them as OWN and leaves them alone. */
function convertMath(root) {
  // MathJax v2: <span class="MathJax_Preview">…</span><span class="MathJax">…glyphs…</span>
  //             <script type="math/tex">the source</script>
  root.querySelectorAll('script[type^="math/tex"]').forEach((s) => {
    const tex = s.textContent.trim()
    let p = s.previousElementSibling
    while (p && /MathJax/.test(String(p.className || ''))) {
      const prev = p.previousElementSibling
      p.remove()
      p = prev
    }
    if (tex) s.replaceWith(mathNode(tex, /mode\s*=\s*display/.test(s.getAttribute('type') || '')))
    else s.remove()
  })
  // MathML (Wikipedia), KaTeX's MathML fallback, LaTeXML's alttext, MathJax v3 containers.
  // Outermost first, so an inner <math> inside an already-replaced .katex is skipped.
  root.querySelectorAll(MATH_SEL).forEach((el) => {
    if (!root.contains(el)) return
    const tex = texOf(el)
    if (tex) el.replaceWith(mathNode(tex, isDisplayMath(el)))
    else el.remove()
  })
}

function clean(parent) {
  Array.from(parent.childNodes).forEach((n) => {
    if (n.nodeType === 8) { n.remove(); return }               // comments (Word ships many)
    if (n.nodeType !== 1) return                               // text stays as-is
    const tag = tagOf(n)
    if (OWN_SEL && n.matches(OWN_SEL)) { keepOwn(n); return }   // ours → leave the subtree
    if (DROP.has(tag)) { n.remove(); return }
    clean(n)                                                   // depth-first, so unwrapping is safe
    stripAttrs(n, KEEP[tag] || [])
    if (UNWRAP.has(tag)) n.replaceWith(...n.childNodes)
  })
}

/* Strip presentation from clipboard HTML. Used by the ProseMirror body
 * (editorProps.transformPastedHTML, which covers drops too) and by the footnote bodies. */
export function cleanPastedHTML(html) {
  if (!html) return html
  if (/\bdata-pm-slice\b/.test(html)) return html // ProseMirror's own clipboard → already ours
  try {
    const doc = new window.DOMParser().parseFromString(html, 'text/html')
    convertMath(doc.body)
    clean(doc.body)
    return doc.body.innerHTML
  } catch (e) {
    return html
  }
}

/* Insert into a plain contenteditable. execCommand is deprecated but it is the only insert
 * that keeps the browser's own undo stack intact for these fields, so prefer it and fall
 * back to a manual Range edit. */
export function insertPlain(text) {
  try { if (document.execCommand('insertText', false, text)) return } catch (e) {}
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const r = sel.getRangeAt(0)
  r.deleteContents()
  const node = document.createTextNode(text)
  r.insertNode(node)
  r.setStartAfter(node); r.collapse(true)
  sel.removeAllRanges(); sel.addRange(r)
}
export function insertCleanHTML(html) {
  try { if (document.execCommand('insertHTML', false, html)) return } catch (e) {}
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const r = sel.getRangeAt(0)
  r.deleteContents()
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  const frag = document.createDocumentFragment()
  while (tmp.firstChild) frag.appendChild(tmp.firstChild)
  const last = frag.lastChild
  r.insertNode(frag)
  if (last) { r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r) }
}

/* Title + subtitle are plain-text fields whose innerHTML is what gets stored, so paste as
 * text (newlines flattened to spaces) — a copied headline can't drag a font stack along. */
export function setupPlainTextPaste(el) {
  el.addEventListener('paste', (e) => {
    const cd = e.clipboardData
    if (!cd) return
    e.preventDefault()
    const text = (cd.getData('text/plain') || '').replace(/\s*\r?\n\s*/g, ' ').trim()
    if (text) insertPlain(text)
  })
}
