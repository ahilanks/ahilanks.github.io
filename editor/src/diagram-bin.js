/* diagram-bin.js — deleted diagrams, kept so they can be added back.
 *
 * Whenever a change leaves the draft with fewer diagrams than before, each diagram that
 * went is kept here whole (its HTML, caption, width, and its Claude chat), newest first,
 * along with the text of the block it followed. The bin is saved with the draft (so it is
 * in the drafts backup and its versions) and never published. History → Deleted lists it;
 * Add back puts a diagram where it was (after that block, if it's still there; otherwise
 * after the cursor's block). A diagram that comes back any other way (undo, paste) leaves
 * the bin by itself.
 */

import { NodeSelection } from '../vendor/lib.bundle.js'
import { escapeHtml, toast } from './dom.js'
import { embedDoc, SANDBOX } from './nodes/embed.js'

const MAX = 40
const keyOf = (a) => a.did || 'h:' + a.html

function embedsIn(doc) {
  const out = []
  doc.descendants((n, pos) => {
    if (n.type.name === 'htmlEmbed') { out.push({ n, pos }); return false }
  })
  return out
}

// the text of the nearest non-empty top-level block before pos (where it sat)
function textBefore(doc, pos) {
  const i = doc.resolve(pos).index(0)
  for (let k = i - 1; k >= 0; k--) {
    const t = doc.child(k).textContent.trim()
    if (t) return t.slice(0, 200)
  }
  return ''
}

function when(t) {
  const d = new Date(t)
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function setupDiagramBin(editor, { onChange } = {}) {
  let items = []

  editor.on('transaction', ({ transaction: tr }) => {
    // a draft being loaded or switched (setContent without an update) isn't a deletion
    if (!tr.docChanged || tr.getMeta('preventUpdate')) return
    const before = embedsIn(tr.before)
    if (!before.length && !items.length) return
    const after = embedsIn(tr.doc)
    const left = new Map()
    for (const e of after) { const k = keyOf(e.n.attrs); left.set(k, (left.get(k) || 0) + 1) }
    let changed = false
    const n0 = items.length
    items = items.filter((it) => !left.has(it.key)) // back in the draft: out of the bin
    if (items.length !== n0) changed = true
    // fewer diagrams than before: the unmatched ones were deleted (a move or an edit of a
    // diagram keeps the count, so those never land here)
    if (after.length < before.length) {
      const rem = new Map(left)
      for (const e of before) {
        const k = keyOf(e.n.attrs)
        const c = rem.get(k) || 0
        if (c) { rem.set(k, c - 1); continue }
        items = items.filter((it) => it.key !== k)
        items.unshift({ key: k, node: e.n.toJSON(), caption: e.n.textContent.trim(), after: textBefore(tr.before, e.pos), deletedAt: Date.now() })
        changed = true
      }
      if (items.length > MAX) items.length = MAX
    }
    if (changed && onChange) onChange()
  })

  function addBack(it) {
    const { state } = editor
    let at = null
    if (!it.after) at = 0
    else state.doc.forEach((n, pos) => { if (at == null && n.textContent.trim().slice(0, 200) === it.after) at = pos + n.nodeSize })
    if (at == null) { const $t = state.selection.$to; at = $t.depth ? $t.after(1) : $t.pos }
    if (!editor.chain().insertContentAt(at, it.node).run()) return false
    const n = editor.state.doc.nodeAt(at)
    if (n && n.type.name === 'htmlEmbed') {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)).scrollIntoView())
      editor.view.focus()
    }
    return true
  }

  function renderInto(list, close) {
    if (!items.length) {
      list.innerHTML = '<div class="cl-empty">No deleted diagrams. When you delete a diagram from this draft it’s kept here, so you can add it back later.</div>'
      return
    }
    for (const it of items) {
      const row = document.createElement('div')
      row.className = 'cl-row bin-row'
      row.innerHTML =
        '<div class="cl-top"><span class="cl-kind">Diagram</span><span class="cl-when">Deleted ' + when(it.deletedAt) + '</span>' +
        '<button type="button" class="cl-reopen bin-add">Add back</button><button type="button" class="bin-forget" title="Delete for good">×</button></div>' +
        '<div class="bin-preview"></div>' +
        (it.caption ? '<div class="cl-text">' + escapeHtml(clip(it.caption, 200)) + '</div>' : '') +
        (it.after ? '<div class="cl-quote">was after “' + escapeHtml(clip(it.after.replace(/\s+/g, ' '), 110)) + '”</div>' : '<div class="cl-quote">was at the top</div>')
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', SANDBOX)
      f.setAttribute('tabindex', '-1')
      f.setAttribute('title', 'Deleted diagram')
      f.srcdoc = embedDoc((it.node.attrs && it.node.attrs.html) || '')
      row.querySelector('.bin-preview').appendChild(f)
      row.querySelector('.bin-add').addEventListener('click', () => {
        if (addBack(it)) { close(); toast('Diagram added back · ⌘Z to undo') }
        else toast('Couldn’t add it back here')
      })
      row.querySelector('.bin-forget').addEventListener('click', () => {
        items = items.filter((x) => x !== it)
        if (onChange) onChange()
        list.textContent = ''
        renderInto(list, close)
      })
      list.appendChild(row)
    }
  }

  return {
    data: () => items,
    load: (arr) => { items = Array.isArray(arr) ? arr.filter((x) => x && x.node && x.key) : [] },
    count: () => items.length,
    renderInto,
  }
}
