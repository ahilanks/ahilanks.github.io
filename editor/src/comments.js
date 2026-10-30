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
 * `closedComments` field (the 500 most recent), listed under History (closed.js)
 * where Reopen finds those words again and re-attaches the comment.
 *
 * Comments never reach a published page: publish.js unwraps the anchor spans.
 *
 * Footnote bodies live outside ProseMirror (nodes/footnote.js), so a comment there is the
 * same <span class="cmt" data-comment> written straight into the body's DOM (saved with
 * the draft's `footnotes` HTML), highlighted with a plain class, and resolved by
 * unwrapping it — not undoable with ⌘Z.
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
const MAX_CLOSED = 500 // resolved comments kept with the draft (the History list shows them all)
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

/* ---------------------------------------------------------- in the footnotes */
const fnList = () => document.getElementById('fnList')
const fnSpans = (id) => {
  const l = fnList()
  return l ? Array.from(l.querySelectorAll(id ? 'span.cmt[data-comment="' + id + '"]' : 'span.cmt[data-comment]')) : []
}
// the footnote body the DOM selection is in, or null
function fnBodyAtSelection() {
  const sel = window.getSelection()
  let n = sel && sel.rangeCount ? sel.anchorNode : null
  if (n && n.nodeType === 3) n = n.parentNode
  const body = n && n.closest ? n.closest('.fn-body') : null
  return body && fnList() && fnList().contains(body) ? body : null
}
// the footnote comment the caret is in
function fnIdAtCaret() {
  if (!fnBodyAtSelection()) return null
  let n = window.getSelection().anchorNode
  if (n && n.nodeType === 3) n = n.parentNode
  const span = n && n.closest ? n.closest('span.cmt[data-comment]') : null
  return span ? span.dataset.comment : null
}
// Wrap every piece of text inside `range` in its own anchor span (a range may cross a
// link or italics, the way a mark is split across nodes) → the spans.
function wrapRange(range, id) {
  const root = range.commonAncestorContainer
  const texts = []
  if (root.nodeType === 3) texts.push(root)
  else {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let t = w.nextNode(); t; t = w.nextNode()) if (range.intersectsNode(t)) texts.push(t)
  }
  const spans = []
  for (let t of texts) {
    const a = t === range.startContainer ? range.startOffset : 0
    const b = t === range.endContainer ? range.endOffset : t.length
    if (b <= a || !t.data.slice(a, b).trim()) continue
    if (b < t.length) t.splitText(b)
    if (a > 0) t = t.splitText(a)
    const span = document.createElement('span')
    span.className = 'cmt'
    span.dataset.comment = id
    t.replaceWith(span)
    span.appendChild(t)
    spans.push(span)
  }
  return spans
}
// the word around a collapsed caret in a footnote body, as a Range
function fnWordRange(sel) {
  const t = sel.anchorNode
  if (!t || t.nodeType !== 3) return null
  let a = sel.anchorOffset, b = a
  while (a > 0 && /\S/.test(t.data[a - 1])) a--
  while (b < t.length && /\S/.test(t.data[b])) b++
  if (a === b) return null
  const r = document.createRange(); r.setStart(t, a); r.setEnd(t, b)
  return r
}
// `quote` in the footnotes (the note `fnId` first) → a Range, or null
function findInFootnotes(quote, fnId) {
  const l = fnList()
  if (!l || !quote) return null
  const bodies = Array.from(l.querySelectorAll('li'))
    .sort((x, y) => (y.dataset.fn === fnId) - (x.dataset.fn === fnId))
    .map((li) => li.querySelector('.fn-body')).filter(Boolean)
  for (const body of bodies) {
    const nodes = []
    let str = ''
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let t = w.nextNode(); t; t = w.nextNode()) { nodes.push({ t, at: str.length }); str += t.data }
    const i = str.indexOf(quote)
    if (i < 0) continue
    const end = i + quote.length
    const s = nodes.findLast((n) => n.at <= i), e = nodes.findLast((n) => n.at < end)
    const r = document.createRange()
    r.setStart(s.t, i - s.at); r.setEnd(e.t, end - e.at)
    return r
  }
  return null
}
const fnQuote = (spans) => spans.map((s) => s.textContent).join('')
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
    return { add() {}, addAt() {}, data: () => ({}), closedData: () => [], load() {}, addSource() {}, layout() {}, deactivate() {}, closedSource: { list: () => [], reopen() {} }, openList: () => [], show() {} }
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
    for (const s of fnSpans()) { const id = s.dataset.comment; if (id && !seen.has(id)) { seen.add(id); ids.push(id) } }
    return ids
  }
  const anchorEl = (id) => editor.view.dom.querySelector('span.cmt[data-comment="' + id + '"]') || fnSpans(id)[0] || null
  const inFootnote = (id) => !editor.view.dom.querySelector('span.cmt[data-comment="' + id + '"]') && fnSpans(id).length > 0

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
    fnSpans().forEach((s) => s.classList.toggle('cmt-on', s.dataset.comment === id))
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
        backToText(id)
      }
    })
    text.addEventListener('focus', () => setActive(id))
    text.addEventListener('blur', () => {
      if (!cards.has(id)) return              // resolved while focused
      if (!text.innerText.trim()) { resolve(id); return } // nothing written → no comment
      // a click away from both the card and its text drops the highlight
      setTimeout(() => {
        if (!cardFocused() && !(editor.isFocused && idAtCaret() === id) && fnIdAtCaret() !== id) setActive(null)
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

  // leaving a card: the caret goes back to the end of its words (a footnote comment's
  // into the footnote; the editor's wherever it was)
  function backToText(id) {
    const spans = inFootnote(id) ? fnSpans(id) : []
    if (!spans.length) { editor.commands.focus(); return }
    const last = spans[spans.length - 1]
    last.closest('.fn-body').focus({ preventScroll: true })
    const sel = window.getSelection()
    if (sel) { const r = document.createRange(); r.selectNodeContents(last); r.collapse(false); sel.removeAllRanges(); sel.addRange(r) }
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
    if (fnBodyAtSelection()) { addInFootnote(); return }
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

  function addInFootnote() {
    const sel = window.getSelection()
    const range = sel.isCollapsed ? fnWordRange(sel) : sel.getRangeAt(0)
    if (!range) return
    const id = uid()
    if (!wrapRange(range, id).length) return
    store[id] = { text: '', created: Date.now() }
    sel.removeAllRanges()
    scheduleSave()
    setActive(id)
    layout()
    const card = cards.get(id)
    if (card) card.querySelector('.cmt-text').focus()
  }
  // unwrap a footnote comment's spans → the words it was on (false if it had none)
  function unwrapFootnote(id) {
    const spans = fnSpans(id)
    if (!spans.length) return false
    const li = spans[0].closest('li')
    const quote = fnQuote(spans)
    spans.forEach((s) => { const p = s.parentNode; s.replaceWith(...s.childNodes); p.normalize() })
    return { quote, fnId: li ? li.dataset.fn : '' }
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
    if (inFootnote(id)) {
      const body = store[id]
      const was = unwrapFootnote(id)
      if (body && body.text.trim()) {
        closed = [{ id, text: body.text, created: body.created, closedAt: Date.now(), quote: was.quote, pos: 0, fnId: was.fnId || '' },
          ...closed.filter((c) => c.id !== id)].slice(0, MAX_CLOSED)
      }
      delete store[id]
      if (id === activeId) setActive(null)
      scheduleSave()
      layout()
      return
    }
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
    if (c.fnId !== undefined) return reopenInFootnote(c)
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
  // a footnote comment: its words in its note (or any note), else a selection in a footnote
  function reopenInFootnote(c) {
    let range = findInFootnotes(c.quote, c.fnId)
    if (!range && fnBodyAtSelection() && !window.getSelection().isCollapsed) range = window.getSelection().getRangeAt(0)
    if (!range) return false
    if (!wrapRange(range, c.id).length) return false
    closed = closed.filter((x) => x.id !== c.id)
    trash.delete(c.id)
    store[c.id] = { text: c.text, created: c.created }
    scheduleSave()
    show(c.id)
    return true
  }
  const closedSource = {
    list: () => closed.map((c) => ({ key: c.id, kind: 'comment', label: 'Comment', how: 'Resolved', text: c.text, quote: c.quote.replaceAll(ATOM, '…'), closedAt: c.closedAt, canReopen: true })),
    reopen: (key) => reopen(key) || 'Its words are gone — select the text to attach it to, then Reopen.',
  }

  // The open comments with the words they're on, in document order — for History and as
  // context for the AI (the writer's own notes to self: "expand this", "TODO: figure").
  function openList() {
    const spans = new Map() // id -> { from, to }
    const type = commentType()
    editor.state.doc.descendants((node, pos) => {
      if (!node.isInline) return
      node.marks.forEach((m) => {
        if (m.type !== type) return
        const s = spans.get(m.attrs.id)
        if (s) s.to = pos + node.nodeSize
        else spans.set(m.attrs.id, { from: pos, to: pos + node.nodeSize })
      })
    })
    const out = []
    for (const [id, { from, to }] of spans) {
      const body = store[id]
      if (!body || !body.text.trim()) continue
      out.push({ id, text: body.text, created: body.created, from, quote: editor.state.doc.textBetween(from, to, '\n', ATOM).replaceAll(ATOM, '…') })
    }
    // footnote comments come after the text's (from -1: no place in the doc)
    const fnIds = []
    fnSpans().forEach((s) => { if (!spans.has(s.dataset.comment) && !fnIds.includes(s.dataset.comment)) fnIds.push(s.dataset.comment) })
    for (const id of fnIds) {
      const body = store[id]
      if (!body || !body.text.trim()) continue
      out.push({ id, text: body.text, created: body.created, from: -1, footnote: true, quote: fnQuote(fnSpans(id)) })
    }
    return out
  }
  // jump to an open comment and open its card
  function show(id) {
    const c = openList().find((x) => x.id === id)
    if (!c) return false
    if (c.footnote) {
      const span = fnSpans(id)[0]
      span.scrollIntoView({ block: 'center' })
      span.closest('.fn-body').focus({ preventScroll: true })
      const sel = window.getSelection()
      if (sel) { const r = document.createRange(); r.setStart(span.firstChild || span, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r) }
      setActive(id)
      layout()
      return true
    }
    editor.chain().focus().setTextSelection(c.from + 1).scrollIntoView().run()
    setActive(id)
    layout()
    return true
  }

  // the draft's `closedComments` field
  function closedData() {
    return closed.map((c) => Object.assign({ id: c.id, text: c.text, created: c.created, closedAt: c.closedAt, quote: c.quote, pos: c.pos },
      c.fnId !== undefined ? { fnId: c.fnId } : {}))
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
      .map((x) => Object.assign({ id: String(x.id), text: x.text, created: +x.created || 0, closedAt: +x.closedAt || 0, quote: String(x.quote || ''), pos: +x.pos || 0 },
        x.fnId !== undefined ? { fnId: String(x.fnId) } : {}))
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
  // the footnotes: caret in a comment there → its card; typing, renumbering → re-place
  document.addEventListener('selectionchange', () => {
    if (!fnBodyAtSelection()) return
    const id = fnIdAtCaret()
    if (id) setActive(id)
    else if (!cardFocused() && activeId && inFootnote(activeId)) setActive(null)
  })
  if (fnList()) new MutationObserver(layoutSoon).observe(fnList(), { childList: true, subtree: true, characterData: true })
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
    add, addAt, data, closedData, load, addSource, layer, closedSource, openList, show,
    layout: layoutSoon,               // also exposed for console debugging
    deactivate: () => setActive(null),
  }
}
