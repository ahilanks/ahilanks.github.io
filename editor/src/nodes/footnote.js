/* footnote.js — footnote references + the footnotes region.
 *
 * A footnote reference is an inline atom node rendered as <sup class="fn-ref" data-fn="id">N</sup>.
 * The footnote BODIES live in a region below the article (`#fnList`, a contenteditable list),
 * OUTSIDE the ProseMirror doc — mirroring v1 so the stored `footnotes` field (fnList.innerHTML)
 * round-trips unchanged. The number N is NOT stored in the doc; `reconcileFootnotes()` walks the
 * refs in document order on every update, numbers them, and reorders/prunes the body list to match.
 */

import { Node } from '../../vendor/lib.bundle.js'
import { $, uid, debounce } from '../dom.js'

/* ----------------------------------------------------------------- the node */
export const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { fnId: { default: '', parseHTML: (el) => el.getAttribute('data-fn') || '' } }
  },
  parseHTML() {
    return [{ tag: 'sup.fn-ref' }]
  },
  renderHTML({ node }) {
    // number is filled in by reconcileFootnotes at render time; storage keeps a placeholder.
    return ['sup', { class: 'fn-ref', 'data-fn': node.attrs.fnId }, '•']
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('sup')
      dom.className = 'fn-ref'
      dom.setAttribute('contenteditable', 'false')
      dom.dataset.fn = node.attrs.fnId
      dom.textContent = '•' // reconcileFootnotes sets the actual number
      return {
        dom,
        update(next) { return next.type === node.type }, // keep our dom (and its number)
        ignoreMutation() { return true },
      }
    }
  },
  addCommands() {
    return {
      insertFootnoteRef: (fnId) => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: { fnId } }).run(),
    }
  },
})

/* ----------------------------------------------------- the footnotes region */
// Footnote bodies are text-only: only inline formatting survives (like v1).
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

function createFnEntry(id) {
  const li = document.createElement('li')
  li.dataset.fn = id
  const num = document.createElement('span'); num.className = 'fn-num'; num.textContent = '.'
  const body = document.createElement('div'); body.className = 'fn-body'; body.setAttribute('contenteditable', 'true')
  li.append(num, body)
  return li
}

let lastSig = ''
export function reconcileFootnotes(editor) {
  const fnList = $('fnList'); const section = $('footnotes')
  if (!fnList || !section) return
  fnList.querySelectorAll('.fn-body').forEach((b) => normalizeFnBody(b))
  const refs = Array.from(editor.view.dom.querySelectorAll('.fn-ref'))
  const seen = new Set(refs.map((r) => r.dataset.fn))
  const sig = refs.map((r) => r.dataset.fn).join('|')
  if (sig === lastSig && fnList.children.length === refs.length) { section.hidden = refs.length === 0; return }
  lastSig = sig

  const entries = {}
  Array.from(fnList.children).forEach((li) => (entries[li.dataset.fn] = li))
  Object.keys(entries).forEach((id) => { if (!seen.has(id)) { entries[id].remove(); delete entries[id] } })
  refs.forEach((ref, i) => {
    const n = i + 1
    ref.textContent = n
    let li = entries[ref.dataset.fn]
    if (!li) { li = createFnEntry(ref.dataset.fn); entries[ref.dataset.fn] = li }
    li.querySelector('.fn-num').textContent = n + '.'
    fnList.appendChild(li) // append in ref order → correct ordering
  })
  section.hidden = refs.length === 0
}

export function insertFootnote(editor) {
  const id = uid()
  editor.chain().focus().insertContent({ type: 'footnoteRef', attrs: { fnId: id } }).run()
  const fnList = $('fnList')
  if (fnList) fnList.appendChild(createFnEntry(id))
  reconcileFootnotes(editor)
  const li = fnList && fnList.querySelector(`li[data-fn="${id}"]`)
  if (li) li.querySelector('.fn-body').focus()
}

// Called by main.js: wire buttons, reconcile on updates, click-ref-to-body, and save on body edits.
export function setupFootnotes(editor, onFootnoteEdit) {
  const reconcile = () => reconcileFootnotes(editor)
  editor.on('update', debounce(reconcile, 120))
  const fnList = $('fnList')
  if (fnList) fnList.addEventListener('input', () => onFootnoteEdit && onFootnoteEdit())
  // click a ref → focus its body
  editor.view.dom.addEventListener('click', (e) => {
    const ref = e.target.closest && e.target.closest('.fn-ref')
    if (!ref) return
    const li = document.querySelector(`li[data-fn="${ref.dataset.fn}"]`)
    if (li) { li.scrollIntoView({ behavior: 'smooth', block: 'center' }); li.querySelector('.fn-body').focus() }
  })
  $('footnoteBtn').addEventListener('click', () => insertFootnote(editor))
  $('bubbleFootnote').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); insertFootnote(editor) })
  reconcile()
}

// storage helpers
export function footnotesHTML() { const l = $('fnList'); return l ? l.innerHTML : '' }
export function loadFootnotesHTML(html, editor) {
  const l = $('fnList'); if (!l) return
  l.innerHTML = html || ''
  lastSig = '' // force a re-number on the next reconcile
  reconcileFootnotes(editor)
}
