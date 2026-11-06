/* collapsible.js — a titled block whose contents fold away, slightly indented.
 *
 * Saved and published as <details class="collapsible"><summary>…</summary><div
 * class="collapsible-body">…</div></details>. `open` only says how it's folded in the editor:
 * publishing strips it, so readers always find these closed.
 *
 * Folding is display only (CSS on .is-closed): the words stay in the document, so saving,
 * footnote numbering, comments and the AI all still see them. Anything that puts the caret
 * inside a closed one — a comment jump, a footnote's way home, undo — opens it, so the caret
 * can never sit somewhere you can't see.
 *
 * A heading's section turned into one keeps its level and anchor on the title, so it still
 * looks like that heading, links to it still work, and removing the fold restores it.
 *
 * Moving things in and out: Tab sends the blocks you're on into the open section just above
 * them, Shift+Tab sends them out below it, and Backspace at the start of the line below an open
 * section pulls that line in. The grip in the margin (block-drag.js) does it by mouse.
 */

import { Node, mergeAttributes, Plugin, PluginKey, Selection, TextSelection, Decoration, DecorationSet } from '../../vendor/lib.bundle.js'
import { toast } from '../dom.js'

const TITLE = 'collapsibleTitle'
const BODY = 'collapsibleBody'
const NODE = 'collapsible'

/* ---------------------------------------------------------------- helpers */
// Nearest collapsible around a resolved position: { node, pos, depth } or null.
function around($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === NODE) return { node: $pos.node(d), pos: $pos.before(d), depth: d }
  }
  return null
}

const titleEnd = (pos, node) => pos + 2 + node.child(0).content.size

function setOpen(view, pos, open) {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== NODE) return
  const tr = state.tr.setNodeAttribute(pos, 'open', open)
  // closing around the caret: bring it up to the title rather than lose it
  const bodyFrom = pos + 1 + node.child(0).nodeSize
  const { from, to } = state.selection
  if (!open && from > bodyFrom && to < pos + node.nodeSize) tr.setSelection(TextSelection.create(tr.doc, titleEnd(pos, node)))
  view.dispatch(tr.setMeta('addToHistory', false))
}

// Open every closed collapsible around `pos` (a section link or scroll target inside one).
export function revealPos(view, pos) {
  const { state } = view
  const $pos = state.doc.resolve(pos)
  const tr = state.tr
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === NODE && !$pos.node(d).attrs.open) tr.setNodeAttribute($pos.before(d), 'open', true)
  }
  if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false))
}

// The box to line margin cards up against: the element's own, or, when it's folded away, the
// title of the outermost closed collapsible hiding it.
export function visibleRect(el) {
  let title = null
  for (let c = el.closest('.collapsible.is-closed'); c; c = c.parentElement.closest('.collapsible.is-closed')) {
    title = c.querySelector('summary')
  }
  return (title || el).getBoundingClientRect()
}

/* ---------------------------------------------------------------- wrap / unwrap */
function wrap(state, dispatch) {
  const { schema } = state
  const { $from, $to, empty } = state.selection
  const type = schema.nodes[NODE]
  const makeBlock = (blocks) => schema.nodes[BODY].create(null, blocks.length ? blocks : schema.nodes.paragraph.create())

  let depth, start, end
  let titleNode = schema.nodes[TITLE].create()
  let blocks = null

  // caret on a heading → its whole section folds under it
  if (empty && $from.parent.type.name === 'heading') {
    const heading = $from.parent
    if (heading.attrs.inProgress) {
      toast('Mark this section finished before collapsing it')
      return false
    }
    depth = $from.depth - 1
    const parent = $from.node(depth)
    start = $from.index(depth)
    end = start + 1
    const stops = (n) => n.type.name === 'heading' && n.attrs.level <= heading.attrs.level
    while (end < parent.childCount && !stops(parent.child(end))) end++
    titleNode = schema.nodes[TITLE].create({ level: heading.attrs.level, anchor: heading.attrs.anchor || null }, heading.content)
    blocks = []
    for (let i = start + 1; i < end; i++) blocks.push(parent.child(i))
  } else {
    const range = $from.blockRange($to)
    if (range && range.parent.canReplaceWith(range.startIndex, range.endIndex, type)) {
      depth = range.depth
      start = range.startIndex
      end = range.endIndex
    } else { // somewhere a block can't go (inside a list item): wrap the whole top-level block
      depth = 0
      start = $from.index(0)
      end = $to.indexAfter(0)
    }
    const parent = $from.node(depth)
    blocks = []
    for (let i = start; i < end; i++) blocks.push(parent.child(i))
    // a blank line becomes the blank first line of the body, not body plus another
    if (blocks.length === 1 && blocks[0].type.name === 'paragraph' && !blocks[0].content.size) blocks = []
  }

  if (!$from.node(depth).canReplaceWith(start, end, type)) return false
  const from = $from.posAtIndex(start, depth)
  const to = $to.posAtIndex(end, depth)
  const node = type.create({ open: true }, [titleNode, makeBlock(blocks)])
  const tr = state.tr.replaceWith(from, to, node)
  tr.setSelection(TextSelection.create(tr.doc, titleEnd(from, node)))
  dispatch(tr.scrollIntoView())
  return true
}

function unwrap(state, dispatch, found) {
  const { schema, selection } = state
  const { node, pos } = found
  const title = node.child(0)
  const body = node.child(1)
  const blocks = []
  if (title.content.size) {
    blocks.push(title.attrs.level
      ? schema.nodes.heading.create({ level: title.attrs.level, anchor: title.attrs.anchor }, title.content)
      : schema.nodes.paragraph.create(null, title.content))
  }
  const titleBlocks = blocks.reduce((s, b) => s + b.nodeSize, 0)
  const blankBody = body.childCount === 1 && body.child(0).type.name === 'paragraph' && !body.child(0).content.size
  if (!blankBody) body.forEach((b) => blocks.push(b))
  if (!blocks.length) blocks.push(schema.nodes.paragraph.create())

  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, blocks)
  // the caret stays on the same words
  const bodyContent = pos + 2 + title.nodeSize
  const caret = selection.from >= bodyContent
    ? (blankBody ? pos + 1 : pos + titleBlocks + (selection.from - bodyContent))
    : pos + 1 + (selection.from - (pos + 2))
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size)), 1))
  dispatch(tr.scrollIntoView())
  return true
}

/* ---------------------------------------------------------------- moving in and out */
// The whole blocks a selection covers, at a level things move between: { range, inBody }
function movableBlocks(state) {
  const { $from, $to } = state.selection
  const range = $from.blockRange($to)
  if (!range) return null
  const inBody = range.depth > 0 && range.parent.type.name === BODY
  return range.depth === 0 || inBody ? { range, inBody } : null
}

// Keep the selection on the same words after they've moved by `delta`.
function carrySelection(tr, selection, delta) {
  const max = tr.doc.content.size
  tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(selection.anchor + delta, max)), tr.doc.resolve(Math.min(selection.head + delta, max))))
}

// Into the open section right above these blocks, as its last blocks. → false if there isn't one.
function moveIn(state, dispatch) {
  const found = movableBlocks(state)
  if (!found) return false
  const { start, end } = found.range
  const before = state.doc.resolve(start).nodeBefore
  if (!before || before.type.name !== NODE || !before.attrs.open) return false
  const blocks = state.doc.slice(start, end).content
  const at = start - 2 // inside the section: past nothing but the two closing tokens
  const tr = state.tr.delete(start, end).insert(at, blocks)
  carrySelection(tr, state.selection, at - start)
  dispatch(tr.scrollIntoView())
  return true
}

// Out of the section these blocks are in, to just below it. → false if they aren't in one.
function moveOut(state, dispatch) {
  const found = movableBlocks(state)
  if (!found || !found.inBody) return false
  const { start, end, depth } = found.range
  const $start = state.doc.resolve(start)
  const section = $start.before(depth - 1)
  const after = section + $start.node(depth - 1).nodeSize
  const blocks = state.doc.slice(start, end).content
  const tr = state.tr.insert(after, blocks).delete(start, end) // emptied, it keeps one blank line
  carrySelection(tr, state.selection, tr.mapping.map(after, -1) - start)
  dispatch(tr.scrollIntoView())
  return true
}

/* ---------------------------------------------------------------- nodes */
const CollapsibleTitle = Node.create({
  name: TITLE,
  content: 'inline*',
  defining: true,
  selectable: false,
  addAttributes() {
    return {
      level: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-level')) || null,
        renderHTML: (attrs) => (attrs.level ? { 'data-level': attrs.level } : {}),
      },
      anchor: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-anchor') || null,
        renderHTML: (attrs) => (attrs.anchor ? { 'data-anchor': attrs.anchor } : {}),
      },
    }
  },
  parseHTML: () => [{ tag: 'summary' }],
  renderHTML({ HTMLAttributes }) { return ['summary', HTMLAttributes, 0] },
})

const CollapsibleBody = Node.create({
  name: BODY,
  content: 'block+',
  defining: true,
  isolating: true,
  selectable: false,
  parseHTML: () => [{ tag: 'div.collapsible-body' }],
  renderHTML() { return ['div', { class: 'collapsible-body' }, 0] },
})

const emptyTitleKey = new PluginKey('collapsibleTitles')
function emptyTitleDecos(doc) {
  const decos = []
  doc.descendants((node, pos) => {
    if (node.type.name === TITLE && !node.content.size) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'collapsible-untitled', 'data-placeholder': 'Title' }))
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decos)
}

export const Collapsible = Node.create({
  name: NODE,
  group: 'block',
  content: `${TITLE} ${BODY}`,
  defining: true,
  isolating: true,
  // a higher priority than StarterKit's, so Enter and Backspace reach us first
  priority: 200,

  addExtensions() { return [CollapsibleTitle, CollapsibleBody] },

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute('open'),
        renderHTML: (attrs) => (attrs.open ? { open: '' } : {}),
      },
    }
  },

  parseHTML: () => [{ tag: 'details' }],
  renderHTML({ HTMLAttributes }) { return ['details', mergeAttributes({ class: 'collapsible' }, HTMLAttributes), 0] },

  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'collapsible'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'collapsible-toggle'
      button.contentEditable = 'false'
      const inner = document.createElement('div')
      inner.className = 'collapsible-inner'
      dom.append(button, inner)

      let node = initial
      const paint = () => {
        dom.classList.toggle('is-closed', !node.attrs.open)
        const level = node.child(0).attrs.level
        if (level) dom.setAttribute('data-level', level); else dom.removeAttribute('data-level')
        button.setAttribute('aria-expanded', String(node.attrs.open))
        button.setAttribute('aria-label', node.attrs.open ? 'Collapse' : 'Expand')
        button.title = node.attrs.open ? 'Collapse' : 'Expand'
      }
      paint()
      button.addEventListener('mousedown', (e) => e.preventDefault()) // keep the caret where it is
      button.addEventListener('click', () => setOpen(editor.view, getPos(), !node.attrs.open))

      return {
        dom,
        contentDOM: inner,
        update(next) {
          if (next.type !== initial.type) return false
          node = next
          paint()
          return true
        },
        stopEvent: (e) => button.contains(e.target),
        ignoreMutation: (m) => m.type !== 'selection' && !(inner.contains(m.target) && m.target !== inner),
      }
    }
  },

  addCommands() {
    return {
      toggleCollapsible: () => ({ state, dispatch }) => {
        const found = around(state.selection.$from)
        if (found) return dispatch ? unwrap(state, dispatch, found) : true
        return dispatch ? wrap(state, dispatch) : true
      },
    }
  },

  addKeyboardShortcuts() {
    const inTitle = ($from) => $from.parent.type.name === TITLE
    // Down / Right past a closed block's title: on to whatever follows, not into its contents
    const past = (view) => {
      const { state } = view
      const { selection } = state
      if (!selection.empty || !inTitle(selection.$from)) return false
      const found = around(selection.$from)
      if (found.node.attrs.open) return false
      const after = found.pos + found.node.nodeSize
      const next = Selection.near(state.doc.resolve(after), 1)
      if (next.from < after) return false
      view.dispatch(state.tr.setSelection(next).scrollIntoView())
      return true
    }
    // Up / Left into a closed block from below: onto its title
    const back = (view) => {
      const { state } = view
      const { selection } = state
      const { $from } = selection
      if (!selection.empty || !$from.depth) return false
      const before = state.doc.resolve($from.before()).nodeBefore
      if (!before || before.type.name !== NODE || before.attrs.open) return false
      const pos = $from.before() - before.nodeSize
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, titleEnd(pos, before))).scrollIntoView())
      return true
    }
    return {
      Enter: ({ editor }) => {
        const { state, view } = editor
        const { selection, schema } = state
        const { $from } = selection
        if (!selection.empty) return false
        if (inTitle($from)) {
          const found = around($from)
          // closed: carry on writing below it. Open: on into its contents.
          if (!found.node.attrs.open) {
            const after = found.pos + found.node.nodeSize
            const tr = state.tr.insert(after, schema.nodes.paragraph.create())
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
            return true
          }
          const bodyFrom = found.pos + 1 + found.node.child(0).nodeSize + 1
          view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(bodyFrom), 1)).scrollIntoView())
          return true
        }
        // a blank last line in the contents: step out below the block
        const body = $from.depth > 1 ? $from.node($from.depth - 1) : null
        if (body && body.type.name === BODY && $from.parent.type.name === 'paragraph' && !$from.parent.content.size &&
            body.childCount > 1 && $from.index($from.depth - 1) === body.childCount - 1) {
          const found = around($from)
          const after = found.pos + found.node.nodeSize
          const tr = state.tr.delete($from.before(), $from.after())
          const at = tr.mapping.map(after)
          tr.insert(at, schema.nodes.paragraph.create())
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
          return true
        }
        return false
      },
      Backspace: ({ editor }) => {
        const { state, view } = editor
        const { selection } = state
        const { $from } = selection
        if (!selection.empty || $from.parentOffset !== 0) return false
        // start of the title: take the fold away, keep the words
        if (inTitle($from)) return unwrap(state, view.dispatch, around($from))
        // a blank first line of the contents, with more after it
        const body = $from.depth > 1 ? $from.node($from.depth - 1) : null
        if (body && body.type.name === BODY && $from.parent.type.name === 'paragraph' && !$from.parent.content.size &&
            body.childCount > 1 && $from.index($from.depth - 1) === 0) {
          const start = $from.before()
          const tr = state.tr.delete(start, $from.after())
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(start), 1)).scrollIntoView())
          return true
        }
        // the line below an open section joins it (a blank line just goes)
        if ($from.parent.type.name === 'paragraph' && $from.depth > 0) {
          const before = state.doc.resolve($from.before()).nodeBefore
          if (before && before.type.name === NODE && before.attrs.open) {
            if ($from.parent.content.size) return moveIn(state, view.dispatch)
            const tr = state.tr.delete($from.before(), $from.after())
            view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve($from.before()), -1)).scrollIntoView())
            return true
          }
        }
        return false
      },
      Tab: ({ editor }) => moveIn(editor.state, editor.view.dispatch),
      'Shift-Tab': ({ editor }) => moveOut(editor.state, editor.view.dispatch),
      ArrowDown: ({ editor }) => editor.view.endOfTextblock('down') && past(editor.view),
      ArrowRight: ({ editor }) => {
        const { $from } = editor.state.selection
        return $from.parentOffset === $from.parent.content.size && past(editor.view)
      },
      ArrowUp: ({ editor }) => editor.view.endOfTextblock('up') && back(editor.view),
      ArrowLeft: ({ editor }) => editor.state.selection.$from.parentOffset === 0 && back(editor.view),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('collapsibleReveal'),
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.selectionSet || t.docChanged)) return null
          const $head = state.selection.$head
          let tr = null
          for (let d = $head.depth; d > 1; d--) {
            if ($head.node(d).type.name === BODY && !$head.node(d - 1).attrs.open) {
              tr = (tr || state.tr).setNodeAttribute($head.before(d - 1), 'open', true)
            }
          }
          return tr && tr.setMeta('addToHistory', false)
        },
      }),
      new Plugin({
        key: emptyTitleKey,
        state: {
          init: (_c, state) => emptyTitleDecos(state.doc),
          apply: (tr, old) => (tr.docChanged ? emptyTitleDecos(tr.doc) : old),
        },
        props: { decorations: (state) => emptyTitleKey.getState(state) },
      }),
    ]
  },
})
