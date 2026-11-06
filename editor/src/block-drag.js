/* block-drag.js — a grip in the left margin that moves a whole block.
 *
 * It follows the pointer: the paragraph, heading, list, quote or figure you're on, one inside a
 * collapsible section included, or the whole section when you're on its title. With several
 * blocks selected, grabbing one of them moves them all. A move is one undo step.
 *
 * Where it lands goes by the pointer's height alone (the top or bottom half of the block under
 * it), so a drag straight down the margin reaches every gap, the end of a section's contents
 * included. ProseMirror's own drop position also weighs how far along the line the pointer is,
 * which makes "after this line" unreachable from the margin. So these drags draw their own line.
 *
 * Only ever at the two levels you'd move things between: the article and a section's contents.
 * Lists and quotes move whole; words inside a block still drag the ordinary way.
 */

import { Extension, Plugin, PluginKey, Selection } from '../vendor/lib.bundle.js'

const GRIP = '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>'

// The movable block at a document position: { from, to, node }, or null.
function blockAt(doc, pos) {
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d >= 0; d--) {
    const parent = $pos.node(d)
    if (d > 0 && parent.type.name !== 'collapsibleBody') continue
    let i = $pos.index(d)
    if (i >= parent.childCount) i = parent.childCount - 1
    if (i < 0) return null
    const from = $pos.posAtIndex(i, d)
    const node = parent.child(i)
    return { from, to: from + node.nodeSize, node }
  }
  return null
}

// What a drag from `block` carries: the block, or every block in a selection that includes it.
function dragRange(state, block) {
  const { selection } = state
  if (selection.empty || selection.from >= block.to || selection.to <= block.from) return block
  const range = selection.$from.blockRange(selection.$to)
  if (!range || (range.depth > 0 && range.parent.type.name !== 'collapsibleBody')) return block
  return range.start <= block.from && range.end >= block.to ? { from: range.start, to: range.end } : block
}

// The gap between blocks a pointer height means: a document position.
function gapAt(view, x, y) {
  const r = view.dom.getBoundingClientRect()
  const left = r.left + parseFloat(getComputedStyle(view.dom).paddingLeft) + 1
  const hit = view.posAtCoords({ left: Math.max(x, left), top: Math.min(Math.max(y, r.top + 1), r.bottom - 1) })
  const block = hit && blockAt(view.state.doc, hit.pos)
  const dom = block && view.nodeDOM(block.from)
  if (!dom || !dom.getBoundingClientRect) return null
  const box = dom.getBoundingClientRect()
  // an open section's title: its lower half is the top of the contents
  if (block.node.type.name === 'collapsible' && block.node.attrs.open) {
    const title = dom.querySelector('summary').getBoundingClientRect()
    return y < (title.top + title.bottom) / 2 ? block.from : block.from + 2 + block.node.child(0).nodeSize
  }
  return y < (box.top + box.bottom) / 2 ? block.from : block.to
}

// Where to draw the line for a gap: { left, top, width }.
function gapLine(view, gap) {
  const $gap = view.state.doc.resolve(gap)
  const beforeDom = $gap.nodeBefore && view.nodeDOM(gap - $gap.nodeBefore.nodeSize)
  const afterDom = $gap.nodeAfter && view.nodeDOM(gap)
  const b = beforeDom && beforeDom.getBoundingClientRect ? beforeDom.getBoundingClientRect() : null
  const a = afterDom && afterDom.getBoundingClientRect ? afterDom.getBoundingClientRect() : null
  if (!a && !b) return null
  const edge = a || b
  const top = a && b ? (b.bottom + a.top) / 2 : a ? a.top - 3 : b.bottom + 3
  return { left: edge.left, top, width: edge.width }
}

let own = null // { from, to } while one of our drags is in flight
let line = null // the element showing where it will land
const hideLine = () => { if (line) line.hidden = true }

export const BlockDrag = Extension.create({
  name: 'blockDrag',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('blockDrag'),
      props: {
        handleDrop(view, event, slice) {
          if (!own) return false
          const { from, to } = own
          own = null
          hideLine()
          const { state } = view
          const at = gapAt(view, event.clientX, event.clientY)
          if (at === null || (at >= from && at <= to)) return true // nowhere new
          // a section holding only its blank line: that line makes way
          const $at = state.doc.resolve(at)
          const parent = $at.parent
          const blank = parent.type.name === 'collapsibleBody' && parent.childCount === 1 && !parent.textContent && parent.child(0).type.name === 'paragraph'
          const tr = blank ? state.tr.replace($at.start(), $at.end(), slice) : state.tr.replace(at, at, slice)
          const landed = blank ? $at.start() : at
          tr.delete(tr.mapping.map(from, 1), tr.mapping.map(to, -1))
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(landed, -1)), 1)))
          view.focus()
          return true
        },
      },
    })]
  },
})

export function setupBlockDrag(editor) {
  const view = editor.view
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)')

  const grip = document.createElement('div')
  grip.className = 'block-grip'
  grip.draggable = true
  grip.hidden = true
  grip.title = 'Drag to move'
  grip.innerHTML = GRIP
  document.body.appendChild(grip)
  line = document.createElement('div')
  line.className = 'block-drop-line'
  line.hidden = true
  document.body.appendChild(line)
  // Caught on the way down: the stock drop cursor listens on the editor element itself, so
  // this is the one way to keep it from drawing a second, different line.
  document.addEventListener('dragover', (e) => {
    if (!own) return
    if (!view.dom.contains(e.target)) { hideLine(); return } // off the article a drop does nothing
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const gap = gapAt(view, e.clientX, e.clientY)
    const at = gap === null || (gap >= own.from && gap <= own.to) ? null : gapLine(view, gap)
    if (!at) { hideLine(); return }
    line.style.left = at.left + 'px'
    line.style.top = at.top + 'px'
    line.style.width = at.width + 'px'
    line.hidden = false
  }, true)

  let block = null
  const hide = () => { grip.hidden = true; block = null }

  function place(next) {
    const dom = view.nodeDOM(next.from)
    if (!dom || !dom.getBoundingClientRect) { hide(); return }
    block = next
    const r = dom.getBoundingClientRect()
    // level with the block's first line (a section's title, a heading past its top padding)
    const line = dom.querySelector && dom.classList.contains('collapsible') ? dom.querySelector('summary') : dom
    const cs = getComputedStyle(line)
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const lineTop = line.getBoundingClientRect().top + parseFloat(cs.paddingTop || 0)
    grip.style.left = (r.left - 20) + 'px'
    grip.style.top = (lineTop + Math.min(lineH, r.height) / 2 - 12) + 'px'
    grip.hidden = false
  }

  const scroll = document.getElementById('scrollArea')
  scroll.addEventListener('mousemove', (e) => {
    if (!canHover.matches || !editor.isEditable || e.buttons) { hide(); return }
    const r = view.dom.getBoundingClientRect()
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX > r.right + 8 || e.clientX < r.left - 8) { hide(); return }
    if (e.target.closest && e.target.closest('.cmt-layer, .doc-footnotes')) { hide(); return }
    const hit = view.posAtCoords({ left: Math.max(e.clientX, r.left + parseFloat(getComputedStyle(view.dom).paddingLeft) + 1), top: e.clientY })
    const next = hit && blockAt(view.state.doc, hit.pos)
    if (next) place(next); else hide()
  })
  scroll.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== grip && !grip.contains(e.relatedTarget)) hide() })
  scroll.addEventListener('scroll', hide, { passive: true })
  grip.addEventListener('mouseleave', (e) => { if (!scroll.contains(e.relatedTarget)) hide() })
  document.addEventListener('keydown', hide, true) // never in the way while typing

  grip.addEventListener('dragstart', (e) => {
    if (!block || !e.dataTransfer) { e.preventDefault(); return }
    const { state } = view
    const { from, to } = dragRange(state, block)
    const slice = state.doc.slice(from, to)
    own = { from, to }
    view.dragging = { slice, move: true }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', state.doc.textBetween(from, to, '\n\n'))
    const dom = view.nodeDOM(block.from)
    if (dom && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(dom, 0, 0)
    // later: hiding the source of a drag while it starts would cancel it
    setTimeout(() => grip.classList.add('dragging'), 0)
  })
  grip.addEventListener('dragend', () => {
    own = null
    view.dragging = null
    hideLine()
    grip.classList.remove('dragging')
    hide()
  })
}
