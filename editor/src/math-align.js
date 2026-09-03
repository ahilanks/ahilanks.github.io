/* math-align.js — the floating Left/Center/Right chip for equations.
 *
 * Block equations: the chip sets the blockMath node's `align` attr (the
 * setBlockMathAlign command in nodes/math.js; data-align CSS lives in the
 * editor and in published articles). It appears above the equation whenever it
 * is node-selected — which includes the whole time its in-place MathLive field
 * is open, since selectAndEditMath node-selects first — and hides as soon as
 * the selection moves off the node.
 *
 * Inline equations that are ALONE in their paragraph get the same chip, and a
 * button click CONVERTS them to a block equation with that alignment (inline
 * math has no alignment of its own — it hugs the left like any text). The tex
 * is read from the open <math-field> if one is up, so mid-edit changes aren't
 * lost, and the field is reopened on the new block node. Inline math inside a
 * sentence is left alone — no chip.
 *
 * Buttons use mousedown+preventDefault so clicking one never steals focus from
 * the open math-field (same trick as every toolbar button). */

import { NodeSelection } from '../vendor/lib.bundle.js'
import { selectAndEditMath } from './nodes/math.js'
import { $ } from './dom.js'

export function setupMathAlign(editor) {
  const row = $('mathAlignRow')
  const btns = [...row.querySelectorAll('button[data-align]')]

  // The node-selected equation the chip applies to, or null.
  //   { node, pos, block:true }  — a block equation: buttons set its align attr
  //   { node, pos, block:false } — an inline equation alone in its paragraph:
  //                                buttons convert it to a block equation
  function selectedMath() {
    const sel = editor.state.selection
    if (!(sel instanceof NodeSelection)) return null
    const name = sel.node.type.name
    if (name === 'blockMath') return { node: sel.node, pos: sel.from, block: true }
    if (name !== 'inlineMath') return null
    // inline: only when it's the paragraph's sole content (ignoring blank text),
    // and the paragraph's parent actually accepts a blockMath in its place
    const $pos = editor.state.doc.resolve(sel.from)
    const para = $pos.parent
    if (para.type.name !== 'paragraph') return null
    let others = 0
    para.forEach((c) => { if (c !== sel.node && !(c.isText && !c.text.trim())) others++ })
    if (others) return null
    const d = $pos.depth
    const grand = $pos.node(d - 1)
    const idx = $pos.index(d - 1)
    if (!grand.canReplaceWith(idx, idx + 1, editor.state.schema.nodes.blockMath)) return null
    return { node: sel.node, pos: sel.from, block: false }
  }

  // Replace the paragraph holding a lone inline equation with a blockMath carrying
  // `align`. Reads the live tex out of an open <math-field> (attrs.tex is stale
  // mid-edit) and reopens the field on the new node so editing continues seamlessly.
  function convertInlineToBlock(cur, align) {
    const view = editor.view
    const dom = view.nodeDOM(cur.pos)
    const mf = dom && dom.querySelector ? dom.querySelector('math-field') : null
    const tex = mf ? mf.getValue('latex').trim() : cur.node.attrs.tex
    const wasEditing = !!mf
    const $pos = editor.state.doc.resolve(cur.pos)
    const from = $pos.before($pos.depth)
    const to = $pos.after($pos.depth)
    const block = editor.state.schema.nodes.blockMath.create({ tex, align })
    let tr = editor.state.tr.replaceWith(from, to, block)
    tr = tr.setSelection(NodeSelection.create(tr.doc, from))
    view.dispatch(tr)
    if (wasEditing) selectAndEditMath(view, from)
  }

  function refresh() {
    const cur = selectedMath()
    const dom = cur && editor.view.nodeDOM(cur.pos)
    if (!dom || !dom.getBoundingClientRect) { row.classList.add('hidden'); return }
    row.classList.remove('hidden')
    const r = dom.getBoundingClientRect()
    const w = row.offsetWidth || 120
    // clamp to the VISUAL viewport (matches links.js) so it stays reachable on phones
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth
    let left = r.left + r.width / 2
    left = Math.max(w / 2 + 8, Math.min(left, vw - w / 2 - 8))
    row.style.left = left + 'px'
    // translate(-50%,-100%) → `top` is the chip's BOTTOM edge; keep it clear of the topbar
    row.style.top = Math.max(56 + row.offsetHeight, r.top - 8) + 'px'
    // inline math has no alignment yet — light no button up until it's converted
    const align = cur.block ? cur.node.attrs.align || 'center' : null
    btns.forEach((b) => b.classList.toggle('active', b.dataset.align === align))
  }

  btns.forEach((b) =>
    b.addEventListener('mousedown', (e) => {
      e.preventDefault() // keep the math-field (or the node selection) focused
      e.stopPropagation()
      const cur = selectedMath()
      if (!cur) return
      if (cur.block) editor.commands.setBlockMathAlign(b.dataset.align)
      else convertInlineToBlock(cur, b.dataset.align)
      // the equation just moved to its new alignment — follow it
      setTimeout(refresh, 0)
    })
  )

  editor.on('selectionUpdate', refresh)
  editor.on('update', refresh)
  $('scrollArea')?.addEventListener('scroll', refresh, { passive: true })
  window.addEventListener('resize', refresh)
  return { refresh }
}
