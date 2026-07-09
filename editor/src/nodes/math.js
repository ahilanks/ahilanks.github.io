/* math.js — InlineMath + BlockMath TipTap nodes.
 *
 * On disk / in getHTML(): a minimal wrapper only —
 *   <span class="math-inline" data-tex="x^2">$x^2$</span>
 *   <div class="math-block" data-tex="..." data-align="left">$$...$$</div>
 * (LaTeX only; no rendered KaTeX. The literal $tex$ text lets the server's regex
 *  markdown mirror recover the math for free.)
 *
 * In the editor: a NodeView renders KaTeX when idle, and swaps to a live MathLive
 * <math-field> (Desmos shortcuts ^ _ / sqrt; virtual keyboard) when you click into it.
 */

import { Node, nodeInputRule, katex, NodeSelection } from '../../vendor/lib.bundle.js'
window.__MATHLOG = window.__MATHLOG || []
const mlog = (m) => { try { window.__MATHLOG.push(m) } catch (e) {} }
import { CONFIG } from '../config.js'
import { configureMathfield, mathKeyboard } from '../mathlive-config.js'
import { escapeHtml } from '../dom.js'

function renderKatex(el, tex, displayMode) {
  el.textContent = ''
  if (!tex) {
    const span = document.createElement('span')
    span.className = 'math-empty'
    span.textContent = displayMode ? 'Empty equation — click to edit' : '∅'
    el.appendChild(span)
    return
  }
  try {
    katex.render(tex, el, { displayMode, ...CONFIG.katex })
  } catch (e) {
    el.innerHTML = '<span class="math-error">' + escapeHtml(tex) + '</span>'
  }
}

/* NodeView factory shared by inline + block math.
 *
 * Edit mode is driven entirely by the ProseMirror *selection lifecycle* (the pattern
 * benrbray/prosemirror-math and the PM footnote example use), so there is exactly one
 * way in and one way out:
 *   NodeSelection lands on the node → selectNode()   → open + mount + focus <math-field>
 *   selection leaves the node       → deselectNode()  → commit + tear down + re-render
 * A plain click doesn't node-select an inline atom by default, so main.js's
 * `handleClickOn` turns a click on a math node into that NodeSelection.
 *
 * Two things keep the freshly-mounted field from being blurred by PM:
 *   1. setSelection() is a no-op, so PM never draws a browser Range around the atom.
 *   2. the field is focused synchronously on mount, so PM's editorOwnsSelection early-out
 *      also skips that draw.
 */
function mathNodeView(isBlock) {
  return ({ node, editor, getPos }) => {
    const dom = document.createElement(isBlock ? 'div' : 'span')
    dom.className = isBlock ? 'math-block' : 'math-inline'
    dom.contentEditable = 'false' // isolate the widget subtree from PM's caret/selection
    applyAlign()
    let editing = false
    let mf = null

    function applyAlign() {
      if (isBlock && node.attrs.align && node.attrs.align !== 'center') dom.dataset.align = node.attrs.align
      else delete dom.dataset.align
    }
    function idle() {
      renderKatex(dom, node.attrs.tex, isBlock)
    }
    // Focus the field. MathLive upgrades synchronously on connect, so a sync focus after
    // append usually takes; the `mount` event and a timer are belt-and-suspenders for the
    // rare case the element isn't focusable yet (rAF alone was the original fragile path).
    function focusField() {
      if (!mf || !editing || document.activeElement === mf) return
      try { mf.focus(); mf.executeCommand('moveToMathfieldEnd') } catch (e) {}
    }
    function startEdit() {
      mlog('startEdit call editing=' + editing + ' editable=' + editor.isEditable)
      if (editing || !editor.isEditable) return
      editing = true
      dom.classList.add('math-editing') // suppress the node-selection ring while the field is open
      dom.textContent = ''
      mf = document.createElement('math-field')
      mf.className = 'math-edit'
      configureMathfield(mf)
      mf.value = node.attrs.tex
      mf.addEventListener('keydown', onKey)
      mf.addEventListener('mount', focusField, { once: true })
      mf.addEventListener('focusout', onFocusOut)
      dom.appendChild(mf)
      focusField()
      setTimeout(focusField, 0)
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exit() }
      else if (e.key === 'Enter' && !isBlock) { e.preventDefault(); exit() }
      // block math: Enter builds multi-line environments inside MathLive
    }
    // Safety net: if focus leaves the field to something that is NOT the virtual keyboard
    // and NOT back into the node, commit. Deferred so keycap clicks (which briefly blur then
    // refocus) don't commit mid-formula. The in-editor click-away case is already handled by
    // deselectNode; this also covers focus escaping to the title/toolbar/page.
    function onFocusOut() {
      setTimeout(() => {
        if (!editing) return
        const a = document.activeElement
        if (a === mf || dom.contains(a)) return
        if (a && a.closest && a.closest('.ML__keyboard, .MLK__container, .ML__popover')) return
        commit()
      }, 0)
    }
    // Leave edit mode by moving the outer selection off the node → deselectNode → commit.
    function exit() {
      const pos = getPos()
      if (typeof pos === 'number') editor.chain().focus().setTextSelection(pos + node.nodeSize).run()
      else commit()
    }
    function commit() {
      if (!editing) return
      editing = false
      dom.classList.remove('math-editing')
      const tex = mf ? mf.getValue('latex').trim() : node.attrs.tex
      if (mf) { mf.removeEventListener('keydown', onKey); mf.removeEventListener('focusout', onFocusOut); mf = null }
      const pos = getPos()
      idle() // KaTeX comes back immediately
      if (typeof pos !== 'number') return
      // deselectNode runs *inside* a PM dispatch; defer the doc change out of it.
      if (!tex) {
        queueMicrotask(() => { try { editor.chain().command(({ tr }) => { tr.delete(pos, pos + node.nodeSize); return true }).run() } catch (e) {} })
      } else if (tex !== node.attrs.tex) {
        queueMicrotask(() => { try { editor.chain().command(({ tr }) => { tr.setNodeAttribute(pos, 'tex', tex); return true }).run() } catch (e) {} })
      }
    }

    dom.__startMathEdit = startEdit // opened explicitly by click / Enter / insert (see selectAndEditMath)
    idle()

    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false
        node = next
        applyAlign()
        if (!editing) idle()
        return true
      },
      // NOTE: intentionally NO selectNode() → editing is not tied to being node-selected, so
      // arrow keys can select the atom (highlight) and step past it without opening the field.
      deselectNode() { commit() },
      // Never let PM draw a DOM Range around the selected atom — that browser selection
      // change is what blurs/tears down the freshly-mounted <math-field>.
      setSelection() {},
      // editing: keep every event (keyboard, pointer) inside the <math-field> so PM never
      // interferes. idle: let PM handle the click (which handleClickOn turns into a select).
      stopEvent() { return editing },
      ignoreMutation() { return true },
      destroy() {
        if (mf) { mf.removeEventListener('keydown', onKey); mf.removeEventListener('focusout', onFocusOut); try { mf.remove() } catch (e) {} mf = null }
      },
      // expose for the corner-keyboard "insert & edit" flow
      _startEdit: startEdit,
    }
  }
}

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { tex: { default: '', parseHTML: (el) => el.getAttribute('data-tex') || '' } }
  },
  parseHTML() {
    return [{ tag: 'span.math-inline' }]
  },
  renderHTML({ node }) {
    return ['span', { class: 'math-inline', 'data-tex': node.attrs.tex }, '$' + node.attrs.tex + '$']
  },
  addNodeView() { return mathNodeView(false) },
  addInputRules() {
    // typing `$x^2$` converts to inline math
    return [nodeInputRule({ find: /\$([^$\n]+)\$$/, type: this.type, getAttributes: (m) => ({ tex: m[1].trim() }) })]
  },
  addCommands() {
    return {
      insertInlineMath: (tex = '') => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: { tex } }).run(),
    }
  },
})

export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      tex: { default: '', parseHTML: (el) => el.getAttribute('data-tex') || '' },
      align: { default: 'center', parseHTML: (el) => el.getAttribute('data-align') || 'center' },
    }
  },
  parseHTML() {
    return [{ tag: 'div.math-block' }]
  },
  renderHTML({ node }) {
    const attrs = { class: 'math-block', 'data-tex': node.attrs.tex }
    if (node.attrs.align && node.attrs.align !== 'center') attrs['data-align'] = node.attrs.align
    return ['div', attrs, '$$' + node.attrs.tex + '$$']
  },
  addNodeView() { return mathNodeView(true) },
  addCommands() {
    return {
      insertBlockMath: (tex = '') => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: { tex } }).run(),
      setBlockMathAlign: (align) => ({ state, chain }) => {
        const { $from } = state.selection
        const node = $from.nodeAfter || state.selection.node
        if (!node || node.type.name !== this.name) return false
        return chain().updateAttributes(this.name, { align }).run()
      },
    }
  },
})

/* Node-select the math node at `pos` and open its <math-field> for editing. This is the
 * single "open the editor" entry point — used by the click handler (handleClickOn), the
 * Enter-on-a-selected-node key handler, and the insert flows. It sets a NodeSelection
 * (so committing on exit flows through deselectNode) and then calls the NodeView's
 * startEdit via a hook stashed on the node's DOM. */
export function isMathNode(node) {
  return !!node && (node.type.name === 'inlineMath' || node.type.name === 'blockMath')
}
export function selectAndEditMath(view, pos) {
  const node = view.state.doc.nodeAt(pos)
  if (!isMathNode(node)) return false
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  const el = view.nodeDOM(pos)
  if (el && el.__startMathEdit) el.__startMathEdit()
  return true
}

/* Insert a blank math node and immediately open it for editing (corner keyboard, ⌘M,
 * and the ∑ button with no selection). */
export function insertAndEditMath(editor, { block = false } = {}) {
  const type = block ? 'blockMath' : 'inlineMath'
  editor.chain().focus().insertContent({ type, attrs: { tex: '' } }).run()
  const view = editor.view
  const insertedPos = view.state.selection.from - 1 // node sits just before the cursor
  if (isMathNode(view.state.doc.nodeAt(insertedPos))) selectAndEditMath(view, insertedPos)
}
