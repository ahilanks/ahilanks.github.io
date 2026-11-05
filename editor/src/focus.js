/* focus.js — "Focus on section": show and edit one section; the rest of the article is gone
 * until you choose to bring it back.
 *
 * Hiding is display only: blocks outside the section get a ProseMirror node decoration, so
 * the document, saving, syncing and publishing all still see the whole article. Changes that
 * would reach outside the section are refused (undo included), so nothing moves out of sight.
 * The focused range is two positions mapped through every edit; deleting the whole section
 * ends focus.
 *
 * Which section is focused is remembered per draft, per browser (like the Notes panel's open
 * state): it isn't content, so changing it never marks the draft as edited.
 */

import { Extension, Plugin, PluginKey, Decoration, DecorationSet, Selection, TextSelection } from '../vendor/lib.bundle.js'
import { $, toast } from './dom.js'

const STORE_KEY = 'editor.sectionFocus'
const key = new PluginKey('sectionFocus')

// { from, to } while focused, else null. Both sit on boundaries between top-level blocks.
export const focusRange = (state) => key.getState(state).range

function buildDecos(doc, range) {
  const decos = []
  let first = true
  doc.forEach((node, pos) => {
    const end = pos + node.nodeSize
    if (end <= range.from || pos >= range.to) decos.push(Decoration.node(pos, end, { class: 'focus-hidden' }))
    else if (first) { decos.push(Decoration.node(pos, end, { class: 'focus-first' })); first = false }
  })
  return DecorationSet.create(doc, decos)
}

let lastRefusal = 0
function sayRefused() {
  if (Date.now() - lastRefusal < 3000) return
  lastRefusal = Date.now()
  setTimeout(() => toast('That change is outside this section'), 0)
}

export const SectionFocus = Extension.create({
  name: 'sectionFocus',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ range: null, decos: DecorationSet.empty }),
        apply(tr, val) {
          let range = val.range
          const meta = tr.getMeta(key)
          if (meta !== undefined) range = meta
          else if (!range || !tr.docChanged) return val
          else {
            range = { from: tr.mapping.map(range.from, -1), to: tr.mapping.map(range.to, 1) }
            if (range.from >= range.to) range = null // the whole section was deleted
          }
          return { range, decos: range ? buildDecos(tr.doc, range) : DecorationSet.empty }
        },
      },
      // Nothing outside the section changes, and the caret can't leave it.
      filterTransaction(tr, state) {
        const range = focusRange(state)
        if (!range || tr.getMeta(key) !== undefined) return true
        let { from, to } = range
        if (tr.docChanged) {
          for (const step of tr.steps) {
            const map = step.getMap()
            let outside = false
            map.forEach((start, end) => { if (start < from || end > to) outside = true })
            if (outside) { sayRefused(); return false }
            from = map.map(from, -1)
            to = map.map(to, 1)
          }
        }
        return !tr.selectionSet || (tr.selection.from >= from && tr.selection.to <= to)
      },
      props: {
        decorations: (state) => key.getState(state).decos,
        handleKeyDown(view, event) {
          // ⌘A selects the section, not the hidden article
          const range = focusRange(view.state)
          if (!range || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'a') return false
          const { doc, tr } = view.state
          view.dispatch(tr.setSelection(TextSelection.between(doc.resolve(range.from), doc.resolve(range.to))))
          return true
        },
      },
    })]
  },
})

const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch (e) { return {} } }
function writeStore(id, value) {
  const m = readStore()
  if (value) m[id] = value; else delete m[id]
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)) } catch (e) {}
}

// Top-level headings as [{ node, pos }], in order.
function topHeadings(doc) {
  const out = []
  doc.forEach((node, pos) => { if (node.type.name === 'heading') out.push({ node, pos }) })
  return out
}
// A heading's section: up to the next heading of the same or a higher level.
function sectionOf(doc, pos) {
  const level = doc.nodeAt(pos).attrs.level
  const next = topHeadings(doc).find((h) => h.pos > pos && h.node.attrs.level <= level)
  return { from: pos, to: next ? next.pos : doc.content.size }
}

/**
 * @param {import('../vendor/lib.bundle.js').Editor} editor
 * @param {{ getDocId: () => string, comments: object, onChange: () => void }} deps
 *   onChange — focus started or ended (the word count refreshes)
 */
export function setupSectionFocus(editor, { getDocId, comments, onChange }) {
  const scroll = $('scrollArea')

  const bar = document.createElement('div')
  bar.className = 'focus-bar'
  bar.hidden = true
  const label = document.createElement('span')
  label.className = 'focus-label'
  const exitBtn = document.createElement('button')
  exitBtn.type = 'button'
  exitBtn.textContent = 'Show whole article'
  bar.append(label, exitBtn)
  scroll.before(bar)

  // Footnotes live outside the document, so their hiding is a style rule rather than a class
  // on each note: #fnList's HTML is what gets saved.
  const noteRules = document.createElement('style')
  document.head.appendChild(noteRules)

  let wasOn = false
  function syncNotes(range) {
    const list = $('fnList')
    const section = $('footnotes')
    if (!list || !section) return
    let rules = ''
    let shown = 0
    if (range) {
      Array.from(list.children).forEach((li) => {
        const ref = editor.view.dom.querySelector('.fn-ref[data-fn="' + CSS.escape(li.dataset.fn) + '"]')
        if (ref && !ref.closest('.focus-hidden')) shown++
        else rules += '#fnList li[data-fn="' + CSS.escape(li.dataset.fn) + '"]{display:none}\n'
      })
    }
    section.classList.toggle('focus-no-notes', !!range && !shown)
    if (noteRules.textContent !== rules) {
      noteRules.textContent = rules
      comments.layout()
    }
  }
  function titleOf(range) {
    const node = editor.state.doc.nodeAt(range.from)
    return (node && node.type.name === 'heading' && node.textContent.trim()) || 'this section'
  }
  function sync() {
    const range = focusRange(editor.state)
    const on = !!range
    document.body.classList.toggle('section-focus', on)
    bar.hidden = !on
    if (on) {
      label.textContent = ''
      label.append('Focusing on ', Object.assign(document.createElement('b'), { textContent: titleOf(range) }))
    }
    syncNotes(range)
    if (on !== wasOn) {
      wasOn = on
      if (!on) writeStore(getDocId(), null) // includes the whole section having been deleted
      comments.layout()
      onChange()
    }
  }
  editor.on('transaction', sync)
  const list = $('fnList')
  if (list) new MutationObserver(() => { if (focusRange(editor.state)) syncNotes(focusRange(editor.state)) }).observe(list, { childList: true })

  function remember(range) {
    const doc = editor.state.doc
    const heads = topHeadings(doc)
    const i = heads.findIndex((h) => h.pos === range.from)
    if (i >= 0) writeStore(getDocId(), { i, text: heads[i].node.textContent, level: heads[i].node.attrs.level })
  }

  function enter(range) {
    const { doc, tr, selection } = editor.state
    tr.setMeta(key, range)
    // the caret stays if it's already in the section, else it waits at the section's end
    if (selection.from < range.from || selection.to > range.to) {
      tr.setSelection(Selection.near(doc.resolve(range.to), -1))
    }
    editor.view.dispatch(tr)
    remember(range)
    editor.view.focus()
    scroll.scrollTop = 0
  }
  function exit() {
    const range = focusRange(editor.state)
    if (!range) return
    // what's on screen stays put as the article returns around it
    // (measured below the first block: a heading gets its top spacing back)
    const first = editor.view.nodeDOM(range.from)
    const el = first && (first.nextElementSibling || first)
    const before = el && el.getBoundingClientRect ? el.getBoundingClientRect().top : null
    editor.view.dispatch(editor.state.tr.setMeta(key, null))
    if (before !== null) scroll.scrollTop += el.getBoundingClientRect().top - before
  }

  exitBtn.addEventListener('click', exit)

  return {
    // from a heading's element in the page (the Contents panel)
    enterHeading(el) {
      const pos = editor.view.posAtDOM(el, 0) - 1
      const node = editor.state.doc.nodeAt(pos)
      if (node && node.type.name === 'heading') enter(sectionOf(editor.state.doc, pos))
    },
    // around loading a draft: off while its content is swapped in, then back if it was on
    suspend() {
      if (focusRange(editor.state)) {
        wasOn = false // the draft we're leaving keeps its remembered section
        editor.view.dispatch(editor.state.tr.setMeta(key, null))
      }
    },
    restore(id) {
      const saved = readStore()[id]
      if (!saved) return
      const doc = editor.state.doc
      const heads = topHeadings(doc)
      let range = null
      const same = (h) => h && h.node.textContent === saved.text && h.node.attrs.level === saved.level
      const head = same(heads[saved.i]) ? heads[saved.i] : heads.find(same)
      if (head) range = sectionOf(doc, head.pos)
      if (!range) { writeStore(id, null); return }
      const { tr, selection } = editor.state
      tr.setMeta(key, range)
      if (selection.from < range.from || selection.to > range.to) tr.setSelection(Selection.near(doc.resolve(range.to), -1))
      editor.view.dispatch(tr)
    },
  }
}
