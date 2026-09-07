/* source-view.js — the read-only "Source" view.
 *
 * The header segmented control (#viewToggle) has two buttons: [data-view="write"]
 * and [data-view="source"]. "source" hides #surface, shows #sourceView, and fills
 * #sourcePre with a Markdown + LaTeX serialization of the current document; "write"
 * reverses it. Serialization walks editor.state.doc by node.type.name (the cleanest
 * source of truth) and mirrors the style of editor-server.py's html_to_markdown:
 *   headings h2/h3/h4 → ## / ### / ####, paragraphs blank-line-separated,
 *   blockquote → "> ", bold → **, italic → *, code → `, strike → ~~,
 *   links → [text](href), bullet/ordered lists → - / 1., hr → ---,
 *   inlineMath → $tex$, blockMath → $$…$$ on their own lines,
 *   figure → ![caption](src) (image) or a "▶ video" line (video),
 *   footnoteRef → [^N] in 1-based document order, with a footnotes section appended
 *   ([^N]: <body>) whose bodies come from #fnList matched by data-fn.
 *
 * READ-ONLY: the surface is hidden while this view is up, so nothing here edits the
 * doc or persists anything — it's inert with respect to drafts (safe under SANDBOX).
 */

import { $ } from './dom.js'

/* --------------------------------------------------------------- wiring */
export function setupSourceView(editor) {
  const toggle = $('viewToggle')
  const surface = $('surface')
  const sourceView = $('sourceView')
  const sourcePre = $('sourcePre')
  if (!toggle || !surface || !sourceView || !sourcePre) return

  function setView(v) {
    const writing = v === 'write'
    toggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === v))
    surface.hidden = !writing
    sourceView.hidden = writing
    if (!writing) sourcePre.textContent = serializeDocument(editor)
  }

  toggle.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view))
  })
}

/* --------------------------------------------------------- serialization */
// Number footnote references by first appearance in document order (matches the DOM
// order reconcileFootnotes uses). Returns { order: [fnId…], num: Map<fnId, N> }.
function buildFootnoteOrder(doc) {
  const order = []
  const num = new Map()
  doc.descendants((node) => {
    if (node.type.name === 'footnoteRef') {
      const id = node.attrs.fnId
      if (!num.has(id)) { num.set(id, order.length + 1); order.push(id) }
    }
  })
  return { order, num }
}

function serializeDocument(editor) {
  const ctx = buildFootnoteOrder(editor.state.doc)
  const parts = []
  const title = ($('docTitle') && $('docTitle').textContent || '').trim()
  const subtitle = ($('docSubtitle') && $('docSubtitle').textContent || '').trim()
  if (title) parts.push('# ' + title)
  if (subtitle) parts.push('*' + subtitle + '*')
  parts.push(blocksToMarkdown(editor.state.doc, ctx))
  const footnotes = serializeFootnotes(ctx)
  if (footnotes) parts.push(footnotes)
  return parts.filter((p) => p && p.trim() !== '').join('\n\n').trim() + '\n'
}

// Serialize each top-level (or nested) block child, dropping empties, blank-line-joined.
function blocksToMarkdown(parent, ctx) {
  const parts = []
  parent.forEach((child) => {
    const s = serializeBlock(child, ctx)
    if (s && s.trim() !== '') parts.push(s)
  })
  return parts.join('\n\n')
}

function serializeBlock(node, ctx) {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInline(node, ctx)
    case 'heading':
      return '#'.repeat(node.attrs.level || 2) + ' ' + serializeInline(node, ctx)
    case 'blockquote': {
      const inner = blocksToMarkdown(node, ctx)
      return inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n')
    }
    case 'bulletList':
      return serializeList(node, ctx, false, '')
    case 'orderedList':
      return serializeList(node, ctx, true, '')
    case 'horizontalRule':
      return '---'
    case 'codeBlock':
      return '```' + (node.attrs.language || '') + '\n' + (node.textContent || '') + '\n```'
    case 'blockMath':
      return '$$\n' + (node.attrs.tex || '') + '\n$$'
    case 'figure':
      return serializeFigure(node, ctx)
    default:
      return serializeInline(node, ctx)
  }
}

// Inline content of a block: text (with marks), inline math, footnote refs, line breaks.
function serializeInline(node, ctx) {
  let out = ''
  node.forEach((child) => {
    const name = child.type.name
    if (name === 'inlineMath') out += '$' + (child.attrs.tex || '') + '$'
    else if (name === 'footnoteRef') out += '[^' + (ctx.num.get(child.attrs.fnId) || '?') + ']'
    else if (name === 'hardBreak') out += '\n'
    else if (child.isText) out += applyMarks(child)
    else out += child.textContent || ''
  })
  return out
}

// Wrap a text node's string with markdown for its marks (code innermost, link outermost).
function applyMarks(node) {
  let t = node.text || ''
  const marks = node.marks || []
  const has = (n) => marks.some((m) => m.type.name === n)
  if (has('code')) t = '`' + t + '`'
  if (has('bold')) t = '**' + t + '**'
  if (has('italic')) t = '*' + t + '*'
  if (has('strike')) t = '~~' + t + '~~'
  const link = marks.find((m) => m.type.name === 'link')
  if (link) t = '[' + t + '](' + (link.attrs.href || '') + ')'
  return t
}

// bullet ("- ") / ordered ("1. ") list, recursing for nested lists with hanging indent.
function serializeList(node, ctx, ordered, indent) {
  const out = []
  let i = 1
  node.forEach((li) => {
    const marker = ordered ? (i++ + '. ') : '- '
    const pad = ' '.repeat(marker.length)
    let firstDone = false
    li.forEach((child) => {
      const name = child.type.name
      if (name === 'bulletList' || name === 'orderedList') {
        serializeList(child, ctx, name === 'orderedList', indent + pad).split('\n').forEach((l) => out.push(l))
      } else {
        serializeBlock(child, ctx).split('\n').forEach((l, idx) => {
          if (!firstDone && idx === 0) { out.push(indent + marker + l); firstDone = true }
          else out.push(indent + pad + l)
        })
      }
    })
    if (!firstDone) out.push(indent + marker)
  })
  return out.join('\n')
}

function serializeFigure(node, ctx) {
  const caption = serializeInline(node, ctx).trim()
  if (node.attrs.mediaType === 'video') {
    return '▶ video' + (caption ? ' — ' + caption : '')
  }
  let src = node.attrs.src || ''
  if (src.startsWith('data:')) src = 'embedded image' // keep base64 blobs out of the source view
  return '![' + caption + '](' + src + ')'
}

// Footnotes section: [^N]: <body> in document order, bodies pulled from #fnList by data-fn.
function serializeFootnotes(ctx) {
  if (!ctx.order.length) return ''
  const fnList = $('fnList')
  const bodies = {}
  if (fnList) {
    Array.from(fnList.children).forEach((li) => {
      const b = li.querySelector('.fn-body')
      if (!b) { bodies[li.dataset.fn] = ''; return }
      const c = b.cloneNode(true)
      // embedded images → markdown image syntax (base64 blobs stay out of the source view)
      c.querySelectorAll('img').forEach((img) => {
        const src = (img.getAttribute('src') || '').startsWith('data:') ? 'embedded image' : (img.getAttribute('src') || '')
        img.replaceWith(document.createTextNode(' ![' + (img.getAttribute('alt') || '') + '](' + src + ') '))
      })
      bodies[li.dataset.fn] = (c.textContent || '').replace(/\s+/g, ' ').trim()
    })
  }
  return ctx.order.map((id, idx) => '[^' + (idx + 1) + ']: ' + (bodies[id] || '')).join('\n')
}
