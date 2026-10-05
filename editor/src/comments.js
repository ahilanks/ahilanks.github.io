/* comments.js — Google-Docs-style comments on a stretch of text.
 *
 * A comment is a `comment` MARK on the text it refers to — stored in the body as
 * <span class="cmt" data-comment="id"> — plus a body {text, created} kept OUTSIDE the
 * ProseMirror doc in the draft's `comments` field (the same split as footnotes: the
 * anchor lives in the doc, the words beside it). Cards are drawn in the right margin
 * level with their anchor when the window is wide enough; on narrower windows only the
 * active comment shows, as a small card under its text.
 *
 * Resolving removes the mark through a normal transaction, so ⌘Z brings the comment
 * back: its body is parked in `trash` (never saved) and re-adopted when the anchor
 * returns. The same parking covers cut/paste of commented text and deleting it.
 *
 * Resolved comments are also kept — with the words they were on — in the draft's
 * `closedComments` field (the 30 most recent), listed under "Recently closed" (closed.js)
 * where Reopen finds those words again and re-attaches the comment.
 *
 * Comments never reach a published page: publish.js unwraps the anchor spans.
 *
 * Other margin cards (AI suggestions — ai-suggest.js) join the same layout through
 * addSource(), so the two kinds stack around each other instead of overlapping.
 */

import { Mark, mergeAttributes, Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/lib.bundle.js'
import { $, uid } from './dom.js'
import { setupPlainTextPaste } from './paste.js'

/* ----------------------------------------------------------------- the mark */
// The active comment's anchor is highlighted with an inline DECORATION rather than by
// toggling a class on its <span>: ProseMirror watches attribute mutations inside the
// editor and redraws the affected span from the doc, which would wipe the class again.
const activeKey = new PluginKey('commentActive')

function activeDecorations(doc, id) {
  const decos = []
  doc.descendants((node, pos) => {
    if (!node.isInline) return
    if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)) {
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'cmt-on' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false, // typing at either edge never grows the commented range
  excludes: '',     // two comments may overlap
  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-comment') || '',
        renderHTML: (attrs) => ({ 'data-comment': attrs.id }),
      },
    }
  },
  parseHTML() { return [{ tag: 'span[data-comment]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes({ class: 'cmt' }, HTMLAttributes), 0] },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: activeKey,
      state: {
        init: () => ({ id: null, set: DecorationSet.empty }),
        apply(tr, prev) {
          const meta = tr.getMeta(activeKey)
          if (meta === undefined && !tr.docChanged) return prev
          const id = meta === undefined ? prev.id : meta
          return { id, set: id ? activeDecorations(tr.doc, id) : DecorationSet.empty }
        },
      },
      props: { decorations: (state) => activeKey.getState(state).set },
    })]
  },
})

/* ------------------------------------------------------------------- setup */
const WIDE = '(min-width: 1300px)' // room for a 224px card beside the 820px column
const GAP = 8
const MAX_CLOSED = 30
const ATOM = '\uFFFC' // how an inline atom (math, footnote ref) reads in a comment's quoted words

// The doc's text as one string (blocks joined by newlines, atoms as ATOM) with each
// character's position — to find a closed comment's words again.
function docTextMap(doc) {
  let str = ''
  const at = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (str) { str += '\n'; at.push(-1) }
    node.forEach((child, off) => {
      const p = pos + 1 + off
      if (child.isText) for (let i = 0; i < child.text.length; i++) { str += child.text[i]; at.push(p + i) }
      else { str += ATOM; at.push(p) }
    })
    return false
  })
  return { str, at }
}

function fmtTime(t) {
  const d = new Date(t || Date.now())
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * @param editor        the live TipTap editor
 * @param scheduleSave  called after a comment's text changes
 * @returns {{ add, data, load, layout }}
 */
export function setupComments(editor, scheduleSave) {
  const layer = $('cmtLayer')
  const surface = $('surface')
  const btn = $('commentBtn')
  if (!layer || !surface) {
    return { add() {}, addAt() {}, data: () => ({}), closedData: () => [], load() {}, addSource() {}, layout() {}, deactivate() {}, closedSource: { list: () => [], reopen() {} } }
  }

  let store = {}            // id -> { text, created }   (saved with the draft)
  const trash = new Map()   // bodies whose anchor left the doc; re-adopted if it comes back
  const cards = new Map()   // id -> card element
  const sources = []        // other margin cards laid out with ours (see addSource)
  let closed = []           // resolved comments, newest first: { id, text, created, closedAt, quote, pos }
  let activeId = null
  const wide = window.matchMedia(WIDE)

  const commentType = () => editor.state.schema.marks.comment

  /* ---- doc queries ---- */
  // ids with an anchor in the doc, in document order of first appearance
  function anchoredIds() {
    const ids = []
    const seen = new Set()
    editor.state.doc.descendants((node) => {
      if (!node.isInline) return
      node.marks.forEach((m) => {
        if (m.type.name === 'comment' && m.attrs.id && !seen.has(m.attrs.id)) { seen.add(m.attrs.id); ids.push(m.attrs.id) }
      })
    })
    return ids
  }
  const anchorEl = (id) => editor.view.dom.querySelector('span.cmt[data-comment="' + id + '"]')

  // the comment the caret sits in (preferring the text just after the caret)
  function idAtCaret() {
    const { $from } = editor.state.selection
    const pick = (n) => n && n.marks.find((m) => m.type.name === 'comment')
    const m = pick($from.nodeAfter) || pick($from.nodeBefore)
    return m ? m.attrs.id : null
  }

  // the word under a collapsed caret, so "comment" with nothing selected still has a target
  function wordAt() {
    const { $from } = editor.state.selection
    const p = $from.parent
    if (!p.isTextblock) return null
    const s = p.textBetween(0, p.content.size, undefined, '￼') // atoms count as one char
    const ok = (c) => !!c && /\S/.test(c) && c !== '￼'
    let a = $from.parentOffset, b = a
    while (ok(s[a - 1])) a--
    while (ok(s[b])) b++
    return a === b ? null : { from: $from.start() + a, to: $from.start() + b }
  }

  const cardFocused = () => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cmt-card:not(.sg-card)'))

  /* ---- active comment ---- */
  function setActive(id) {
    if (id === activeId) return
    activeId = id
    if (id) sources.forEach((s) => s.deactivate()) // one active card in the margin at a time
    editor.view.dispatch(editor.state.tr.setMeta(activeKey, id)) // meta-only: no history, no save
    layoutSoon()
  }

  /* ---- cards ---- */
  function makeCard(id) {
    const card = document.createElement('div')
    card.className = 'cmt-card'
    card.dataset.id = id
    card.innerHTML =
      '<div class="cmt-head"><span class="cmt-time"></span>' +
      '<button class="cmt-resolve" type="button" title="Resolve">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' +
      '</button></div>' +
      '<div class="cmt-text" contenteditable="true" data-placeholder="Comment…"></div>'
    const text = card.querySelector('.cmt-text')
    setupPlainTextPaste(text)
    text.addEventListener('input', () => {
      if (!store[id]) return
      store[id].text = text.innerText.replace(/\n$/, '')
      scheduleSave()
      layoutSoon() // the card's height may have changed
    })
    text.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
        e.preventDefault()
        text.blur()
        editor.commands.focus()
      }
    })
    text.addEventListener('focus', () => setActive(id))
    text.addEventListener('blur', () => {
      if (!cards.has(id)) return              // resolved while focused
      if (!text.innerText.trim()) { resolve(id); return } // nothing written → no comment
      // a click away from both the card and its text drops the highlight
      setTimeout(() => {
        if (!cardFocused() && !(editor.isFocused && idAtCaret() === id)) setActive(null)
      }, 0)
    })
    card.querySelector('.cmt-resolve').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); resolve(id) })
    card.addEventListener('mousedown', (e) => {
      // clicking the card's chrome (not the text) still selects the comment
      if (e.target === text || text.contains(e.target)) return
      e.preventDefault()
      setActive(id)
      text.focus()
    })
    card.style.transition = 'none' // land at the right spot, then animate later moves
    return card
  }

  function entryFor(id) {
    if (!store[id]) store[id] = trash.get(id) || { text: '', created: Date.now() }
    trash.delete(id)
    return store[id]
  }

  /* ---- layout: sync cards to anchors and place them ---- */
  let raf = 0
  function layoutSoon() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout() }) }

  function layout() {
    if (surface.hidden) return
    const ids = anchoredIds()
    const anchored = new Set(ids)
    // bodies whose anchor is gone are parked, not saved — ⌘Z (or a paste) brings them back
    for (const id in store) if (!anchored.has(id)) { trash.set(id, store[id]); delete store[id] }
    for (const [id, card] of cards) if (!anchored.has(id)) { card.remove(); cards.delete(id) }
    if (activeId && !anchored.has(activeId)) setActive(null)
    if (closed.some((c) => anchored.has(c.id))) { closed = closed.filter((c) => !anchored.has(c.id)); scheduleSave() }

    const sRect = surface.getBoundingClientRect()
    const entries = []
    for (const id of ids) {
      const el = anchorEl(id)
      if (!el) continue
      let card = cards.get(id)
      if (!card) { card = makeCard(id); cards.set(id, card); layer.appendChild(card) }
      const e = entryFor(id)
      const text = card.querySelector('.cmt-text')
      if (document.activeElement !== text && text.innerText.replace(/\n$/, '') !== e.text) text.innerText = e.text
      card.querySelector('.cmt-time').textContent = fmtTime(e.created)
      card.classList.toggle('active', id === activeId)
      const r = el.getBoundingClientRect()
      entries.push({ id, card, active: id === activeId, top: r.top - sRect.top, bottom: r.bottom - sRect.top, left: r.left - sRect.left })
    }
    // other sources' cards, interleaved by height (comments come first on a tie)
    sources.forEach((s) => entries.push(...s.entries(sRect)))
    entries.sort((a, b) => a.top - b.top)

    layer.classList.toggle('narrow', !wide.matches)
    if (wide.matches) {
      // Every card wants to sit level with its anchor. Stack top-down, each one pushed
      // below the previous; the active card then claims its exact spot and shoves the
      // ones above it up instead.
      entries.forEach((e) => { e.card.hidden = false })
      let y = -Infinity
      entries.forEach((e) => { e.y = Math.max(e.top, y); y = e.y + e.card.offsetHeight + GAP })
      const ai = entries.findIndex((e) => e.active)
      if (ai >= 0) {
        entries[ai].y = entries[ai].top
        let limit = entries[ai].top
        for (let i = ai - 1; i >= 0; i--) {
          const e = entries[i]
          e.y = Math.min(e.y, limit - GAP - e.card.offsetHeight)
          limit = e.y
        }
        y = entries[ai].top + entries[ai].card.offsetHeight + GAP
        for (let i = ai + 1; i < entries.length; i++) {
          const e = entries[i]
          e.y = Math.max(e.top, y)
          y = e.y + e.card.offsetHeight + GAP
        }
      }
      entries.forEach((e) => { e.card.style.top = e.y + 'px'; e.card.style.left = '' })
    } else {
      // only the active comment, tucked under the text it refers to
      entries.forEach((e) => {
        const show = e.active || e.pinned
        e.card.hidden = !show
        if (!show) return
        e.card.style.top = (e.bottom + 6) + 'px'
        e.card.style.left = Math.max(0, Math.min(e.left, surface.clientWidth - e.card.offsetWidth)) + 'px'
      })
    }
    entries.forEach((e) => {
      if (e.card.style.transition === 'none') requestAnimationFrame(() => { e.card.style.transition = '' })
    })
    if (btn) btn.classList.toggle('active', !!activeId)
  }

  /* ---- commands ---- */
  function add() {
    if (cardFocused()) return
    const { state } = editor
    let { from, to, empty } = state.selection
    if (empty) { const w = wordAt(); if (!w) return; from = w.from; to = w.to }
    const id = uid()
    store[id] = { text: '', created: Date.now() }
    editor.view.dispatch(state.tr.addMark(from, to, commentType().create({ id })))
    setActive(id)
    layout()
    const card = cards.get(id)
    if (card) card.querySelector('.cmt-text').focus()
  }

  // A comment with its text already written (an AI note kept as a comment).
  function addAt(from, to, text) {
    const id = uid()
    store[id] = { text, created: Date.now() }
    editor.view.dispatch(editor.state.tr.addMark(from, to, commentType().create({ id })))
    setActive(id)
    layout()
    return id
  }

  function resolve(id) {
    const card = cards.get(id)
    cards.delete(id)
    if (card) card.remove()
    const { state } = editor
    const type = commentType()
    const tr = state.tr
    let from = -1, to = -1
    state.doc.descendants((node, pos) => {
      if (!node.isInline) return
      node.marks.forEach((m) => {
        if (m.type !== type || m.attrs.id !== id) return
        tr.removeMark(pos, pos + node.nodeSize, m)
        if (from < 0) from = pos
        to = pos + node.nodeSize
      })
    })
    // keep it for "Recently closed" (an empty comment was never really written)
    const body = store[id]
    if (body && body.text.trim() && from >= 0) {
      closed = [{ id, text: body.text, created: body.created, closedAt: Date.now(), quote: state.doc.textBetween(from, to, '\n', ATOM), pos: from },
        ...closed.filter((c) => c.id !== id)].slice(0, MAX_CLOSED)
    }
    if (id === activeId) { activeId = null; tr.setMeta(activeKey, null) }
    editor.view.dispatch(tr) // the mark removal is undoable; the body waits in trash
    layout()
  }

  /* ---- recently closed ---- */
  // Re-attach a resolved comment to its words: the occurrence nearest where it was, else
  // the current selection. → false if there's nowhere to put it.
  function reopen(id) {
    const c = closed.find((x) => x.id === id)
    if (!c) return false
    const { state } = editor
    let from = -1, to = -1
    const { str, at } = docTextMap(state.doc)
    let best = Infinity
    for (let i = c.quote ? str.indexOf(c.quote) : -1; i >= 0; i = str.indexOf(c.quote, i + 1)) {
      const d = Math.abs(at[i] - c.pos)
      if (d < best) { best = d; from = at[i]; to = at[i + c.quote.length - 1] + 1 }
    }
    if (from < 0 && !state.selection.empty) ({ from, to } = state.selection)
    if (from < 0) return false
    closed = closed.filter((x) => x.id !== id)
    trash.delete(id)
    store[id] = { text: c.text, created: c.created }
    editor.view.dispatch(state.tr.addMark(from, to, commentType().create({ id })))
    editor.chain().focus().setTextSelection(from).scrollIntoView().run() // caret in it → its card opens
    setActive(id)
    layout()
    return true
  }
  const closedSource = {
    list: () => closed.map((c) => ({ key: c.id, kind: 'comment', label: 'Comment', how: 'Resolved', text: c.text, quote: c.quote.replaceAll(ATOM, '…'), closedAt: c.closedAt, canReopen: true })),
    reopen: (key) => reopen(key) || 'Its words are gone — select the text to attach it to, then Reopen.',
  }

  // the draft's `closedComments` field
  function closedData() {
    return closed.map((c) => ({ id: c.id, text: c.text, created: c.created, closedAt: c.closedAt, quote: c.quote, pos: c.pos }))
  }

  // the draft's `comments` field
  function data() {
    const out = {}
    for (const id in store) out[id] = { text: store[id].text || '', created: store[id].created || 0 }
    return out
  }
  function load(c, closedList) {
    closed = (Array.isArray(closedList) ? closedList : [])
      .filter((x) => x && typeof x === 'object' && x.id && typeof x.text === 'string')
      .map((x) => ({ id: String(x.id), text: x.text, created: +x.created || 0, closedAt: +x.closedAt || 0, quote: String(x.quote || ''), pos: +x.pos || 0 }))
      .slice(0, MAX_CLOSED)
    store = {}
    for (const id in (c || {})) {
      const e = c[id]
      if (e && typeof e === 'object') store[id] = { text: String(e.text || ''), created: +e.created || Date.now() }
    }
    trash.clear()
    cards.forEach((card) => card.remove())
    cards.clear()
    if (activeId) { activeId = null; editor.view.dispatch(editor.state.tr.setMeta(activeKey, null)) }
    layout()
  }

  /* ---- wiring ---- */
  if (btn) btn.addEventListener('mousedown', (e) => { e.preventDefault(); add() })
  editor.on('update', layoutSoon)
  editor.on('selectionUpdate', () => {
    const id = idAtCaret()
    if (id) setActive(id)
    else if (!cardFocused()) setActive(null)
  })
  // Editing shortcuts (⌘B, ⌘M, ⌘⌥M…) are document-level and act on the editor; while the
  // caret is in a card they must not fire. ⌘S still saves.
  layer.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() !== 's') e.stopPropagation()
  })
  new ResizeObserver(layoutSoon).observe(editor.view.dom) // images/fonts landing, reflow
  window.addEventListener('resize', layoutSoon)
  wide.addEventListener('change', layoutSoon)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutSoon)

  /* ---- other margin cards ----
   * src.entries(surfaceRect) → [{ card, active, pinned?, top, bottom, left }] in surface
   * coordinates, the source's cards already appended to `layer`; src.deactivate() drops
   * its active card when a comment becomes active. `pinned` cards show on narrow windows
   * even when inactive. */
  function addSource(src) { sources.push(src); layoutSoon() }

  return {
    add, addAt, data, closedData, load, addSource, layer, closedSource,
    layout: layoutSoon,               // also exposed for console debugging
    deactivate: () => setActive(null),
  }
}
