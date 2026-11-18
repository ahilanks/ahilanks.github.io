/* track-changes.js — Editing / Commenter mode, like Google Docs' Editing / Suggesting.
 *
 * The header's mode button switches between them (remembered in this browser). In
 * Commenter mode the article can't be changed directly: every edit becomes a suggestion.
 *   - typed or pasted text is kept, marked as a suggested insertion  (<ins data-sg>)
 *   - deleted text is put back, marked as a suggested deletion       (<del data-sg>)
 *     (deleting your own pending insertion just removes it, as you'd expect)
 * Comments work as usual. The title, subtitle and footnotes refuse edits (they live
 * outside the article's editor, so they can't carry suggestions) and Publish is hidden.
 *
 * In Editing mode a suggestion under the caret shows a small card: Accept / Reject. The
 * mode menu also has Accept all / Reject all. Published pages never include suggestions:
 * publish.js shows the text as it was (insertions left out, deletions kept).
 *
 * How: an appendTransaction plugin looks at each user transaction's replace steps after
 * it applies, then (in the same undo step) marks the inserted range and re-inserts what
 * was deleted, marked. Formatting, structure-only changes (Enter) and node attribute
 * changes go through as they are.
 */

import { Extension, Mark, Plugin, PluginKey, Slice, Fragment, TextSelection, mergeAttributes } from '../vendor/lib.bundle.js'
import { $, toast } from './dom.js'

const KEY = new PluginKey('trackChanges')
const MODE_LS = 'editor.mode'
let mode = 'edit'
try { if (localStorage.getItem(MODE_LS) === 'suggest') mode = 'suggest' } catch { /* private window */ }
export const isSuggesting = () => mode === 'suggest'
const newId = () => Math.random().toString(36).slice(2, 10)

const idAttr = {
  id: {
    default: null,
    parseHTML: (el) => el.getAttribute('data-sg'),
    renderHTML: (a) => ({ 'data-sg': a.id }),
  },
}
export const TrackInsert = Mark.create({
  name: 'trackInsert',
  inclusive: false,
  addAttributes() { return idAttr },
  parseHTML() { return [{ tag: 'ins[data-sg]', priority: 100 }] }, // ahead of strikethrough/underline
  renderHTML({ HTMLAttributes }) { return ['ins', mergeAttributes({ class: 'trk trk-ins' }, HTMLAttributes), 0] },
})
export const TrackDelete = Mark.create({
  name: 'trackDelete',
  inclusive: false,
  addAttributes() { return idAttr },
  parseHTML() { return [{ tag: 'del[data-sg]', priority: 100 }] }, // ahead of strikethrough/underline
  renderHTML({ HTMLAttributes }) { return ['del', mergeAttributes({ class: 'trk trk-del' }, HTMLAttributes), 0] },
})

// the slice's content minus anything that was itself a pending insertion
function stripInserted(frag, ins) {
  const out = []
  frag.forEach((n) => {
    if (n.isInline) { if (!ins.isInSet(n.marks)) out.push(n) }
    else out.push(n.copy(stripInserted(n.content, ins)))
  })
  return Fragment.from(out)
}
// an id to join: the same kind of suggestion right before `from` or right after `to`
function idNear(doc, from, to, type) {
  const b = doc.resolve(from).nodeBefore
  let m = b && type.isInSet(b.marks)
  if (m) return m.attrs.id
  const a = doc.resolve(to).nodeAfter
  m = a && type.isInSet(a.marks)
  return m ? m.attrs.id : newId()
}

export const TrackChanges = Extension.create({
  name: 'trackChanges',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: KEY,
      appendTransaction(trs, oldState, newState) {
        if (mode !== 'suggest') return null
        const ins = newState.schema.marks.trackInsert, del = newState.schema.marks.trackDelete
        const ops = []
        trs.forEach((tr, ti) => {
          if (!tr.docChanged || tr.getMeta(KEY) || tr.getMeta('preventUpdate') || tr.getMeta('addToHistory') === false) return
          if (tr.getMeta('history$')) return // undo / redo puts back what was there, suggestions and all
          // a whole-document swap is a draft loading or syncing, not an edit
          if (tr.steps.some((s, i) => { const j = s.toJSON(); return j.stepType === 'replace' && j.from === 0 && j.to === tr.docs[i].content.size })) return
          const map = (pos, assoc, i) => {
            let p = tr.mapping.slice(i + 1).map(pos, assoc)
            for (let k = ti + 1; k < trs.length; k++) p = trs[k].mapping.map(p, assoc)
            return p
          }
          const single = trs.length === 1 && tr.steps.length === 1
          tr.steps.forEach((step, i) => {
            const j = step.toJSON()
            if (j.stepType !== 'replace') return
            const from = step.from, to = step.to, size = step.slice.size
            if (size) ops.push({ kind: 'ins', from: map(from, -1, i), to: map(from + size, 1, i) })
            if (to > from) {
              const sel = oldState.selection
              let caret = null
              if (single && !size) caret = sel.empty && sel.head === from ? 'end' : 'start' // Delete → after it; Backspace → before it
              ops.push({ kind: 'del', at: map(from, -1, i), slice: tr.docs[i].slice(from, to), caret })
            }
          })
        })
        if (!ops.length) return null
        const tr = newState.tr.setMeta(KEY, true)
        ops.filter((o) => o.kind === 'ins' && o.to > o.from).forEach((o) => {
          tr.removeMark(o.from, o.to, ins)
          tr.removeMark(o.from, o.to, del)
          tr.addMark(o.from, o.to, ins.create({ id: idNear(tr.doc, o.from, o.to, ins) }))
        })
        ops.filter((o) => o.kind === 'del').sort((a, b) => b.at - a.at).forEach((o) => {
          const content = stripInserted(o.slice.content, ins)
          const crossesBlocks = o.slice.openStart > 0 || o.slice.openEnd > 0 || (content.firstChild && content.firstChild.isBlock)
          let hasInline = false
          content.descendants((n) => { if (n.isInline) hasInline = true; return !hasInline })
          if (!hasInline && !crossesBlocks) return // only a pending insertion was deleted: really gone
          const pos = tr.mapping.map(o.at, -1)
          const before = tr.doc.content.size
          try { tr.replace(pos, pos, new Slice(content, o.slice.openStart, o.slice.openEnd)) } catch { return }
          const added = tr.doc.content.size - before
          if (added > 0) {
            tr.removeMark(pos, pos + added, ins)
            tr.addMark(pos, pos + added, del.create({ id: idNear(tr.doc, pos, pos + added, del) }))
          }
          if (o.caret) tr.setSelection(TextSelection.create(tr.doc, o.caret === 'end' ? pos + added : pos))
        })
        return tr.docChanged || tr.selectionSet ? tr : null
      },
    })]
  },
})

/* ----------------------------------------------------------- accept / reject */
// The ranges of one suggestion, in document order, merged where they touch.
function rangesOf(doc, type, id) {
  const out = []
  doc.descendants((n, pos) => {
    if (!n.isInline) return true
    if (n.marks.some((m) => m.type === type && m.attrs.id === id)) {
      const last = out[out.length - 1]
      if (last && last.to === pos) last.to = pos + n.nodeSize
      else out.push({ from: pos, to: pos + n.nodeSize })
    }
    return false
  })
  return out
}
function allSuggestions(doc, schema) {
  const seen = new Map()
  doc.descendants((n) => {
    if (!n.isInline) return true
    n.marks.forEach((m) => {
      if (m.type === schema.marks.trackInsert || m.type === schema.marks.trackDelete) seen.set(m.type.name + ':' + m.attrs.id, { type: m.type, id: m.attrs.id })
    })
    return false
  })
  return [...seen.values()]
}
// Remove the text (rejected insertion / accepted deletion), or keep it and drop the mark.
function settle(tr, type, id, removeText) {
  const rs = rangesOf(tr.doc, type, id)
  if (!rs.length) return
  if (!removeText) { rs.forEach((r) => tr.removeMark(r.from, r.to, type.create({ id }))); return }
  // pieces separated only by block boundaries (a deletion across paragraphs) go as one, so
  // the paragraphs join again the way the edit had them
  const groups = [{ ...rs[0] }]
  for (let i = 1; i < rs.length; i++) {
    const g = groups[groups.length - 1]
    if (tr.doc.textBetween(g.to, rs[i].from, '', '') === '' && !hasInlineBetween(tr.doc, g.to, rs[i].from)) g.to = rs[i].to
    else groups.push({ ...rs[i] })
  }
  groups.reverse().forEach((g) => tr.delete(g.from, g.to))
}
function hasInlineBetween(doc, a, b) {
  let found = false
  doc.nodesBetween(a, b, (n) => { if (n.isInline) found = true; return !found })
  return found
}
function decide(editor, list, accept) {
  const tr = editor.state.tr.setMeta(KEY, true)
  list.forEach(({ type, id }) => {
    const isIns = type.name === 'trackInsert'
    settle(tr, type, id, isIns ? !accept : accept)
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

// the suggestion the caret is in (or touching), or null
function suggestionAt(state) {
  const { $from } = state.selection
  const s = state.schema
  for (const n of [$from.nodeAfter, $from.nodeBefore]) {
    const m = n && n.marks.find((x) => x.type === s.marks.trackInsert || x.type === s.marks.trackDelete)
    if (m) return { type: m.type, id: m.attrs.id }
  }
  return null
}

/* ----------------------------------------------------------------- the UI */
export function setupTrackChanges(editor) {
  const btn = $('modeBtn')
  const label = $('modeLabel')
  const menu = $('modeMenu')
  const card = document.createElement('div')
  card.className = 'trk-card'
  card.hidden = true
  card.innerHTML = '<span class="trk-card-what"></span><button type="button" class="trk-yes" title="Accept">✓ Accept</button><button type="button" class="trk-no" title="Reject">✕ Reject</button>'
  document.body.appendChild(card)
  let current = null

  function applyMode() {
    document.body.classList.toggle('mode-suggest', mode === 'suggest')
    label.textContent = mode === 'suggest' ? 'Commenter' : 'Editing'
    btn.classList.toggle('on', mode === 'suggest')
    menu.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode))
    refreshCard()
  }
  function setMode(m) {
    mode = m
    try { localStorage.setItem(MODE_LS, m) } catch { /* private window */ }
    applyMode()
  }
  function refreshMenu() {
    const n = allSuggestions(editor.state.doc, editor.state.schema).length
    const row = menu.querySelector('.mode-all')
    row.hidden = !n || mode === 'suggest'
    menu.querySelector('.mode-count').textContent = n === 1 ? '1 suggestion' : n + ' suggestions'
  }
  function closeMenu() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false') }
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!menu.hidden) { closeMenu(); return }
    refreshMenu()
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    const r = btn.getBoundingClientRect()
    menu.style.top = r.bottom + 6 + 'px'
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
  })
  menu.addEventListener('mousedown', (e) => e.preventDefault())
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.mode) setMode(b.dataset.mode)
    else if (b.dataset.all) {
      const list = allSuggestions(editor.state.doc, editor.state.schema)
      decide(editor, list, b.dataset.all === 'accept')
      toast((b.dataset.all === 'accept' ? 'Accepted ' : 'Rejected ') + (list.length === 1 ? '1 suggestion' : list.length + ' suggestions'))
    }
    closeMenu()
  })
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

  // Accept / Reject card under the suggestion the caret is in (Editing mode)
  function refreshCard() {
    current = mode === 'edit' ? suggestionAt(editor.state) : null
    if (!current) { card.hidden = true; return }
    const rs = rangesOf(editor.state.doc, current.type, current.id)
    if (!rs.length) { card.hidden = true; return }
    card.querySelector('.trk-card-what').textContent = current.type.name === 'trackInsert' ? 'Suggested insertion' : 'Suggested deletion'
    card.hidden = false
    const end = editor.view.coordsAtPos(rs[rs.length - 1].to)
    const w = card.offsetWidth
    card.style.left = Math.max(8, Math.min(end.left - w / 2, window.innerWidth - w - 8)) + 'px'
    card.style.top = end.bottom + 8 + 'px'
  }
  card.addEventListener('mousedown', (e) => e.preventDefault()) // keep the caret
  card.querySelector('.trk-yes').addEventListener('click', () => { if (current) decide(editor, [current], true); refreshCard() })
  card.querySelector('.trk-no').addEventListener('click', () => { if (current) decide(editor, [current], false); refreshCard() })
  editor.on('selectionUpdate', refreshCard)
  editor.on('update', refreshCard)
  editor.on('blur', () => { card.hidden = true })
  editor.on('focus', refreshCard)
  $('scrollArea').addEventListener('scroll', () => { if (!card.hidden) refreshCard() }, { passive: true })

  // In Commenter mode the title, subtitle and footnotes can't take suggestions: refuse edits
  let warned = 0
  const outside = (t) => t && t.closest && t.closest('#docTitle, #docSubtitle, .fn-body')
  const refuse = (e) => {
    if (mode !== 'suggest' || !outside(e.target)) return
    e.preventDefault(); e.stopImmediatePropagation()
    if (Date.now() - warned > 4000) { warned = Date.now(); toast('Commenter mode: only the article text takes suggestions. Leave a comment here instead.') }
  }
  for (const ev of ['beforeinput', 'paste', 'drop', 'cut']) document.addEventListener(ev, refuse, true)

  applyMode()
}

// Published text: as it was before the suggestions (insertions out, deletions kept).
// Returns how many suggestion pieces were left out.
export function stripSuggestions(root) {
  let n = 0
  root.querySelectorAll('ins[data-sg]').forEach((el) => { el.remove(); n++ })
  root.querySelectorAll('del[data-sg]').forEach((el) => { el.replaceWith(...el.childNodes); n++ })
  return n
}
