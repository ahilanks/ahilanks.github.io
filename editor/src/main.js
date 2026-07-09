/* main.js — boots the editor. (Phase 1: core editing + toolbar + scroll + minimal
 * sandboxed persistence. Later phases add math, footnotes, figures, publish, sync.) */

import { Editor, StarterKit, Placeholder, NodeSelection, Selection } from '../vendor/lib.bundle.js'
import { CONFIG, LS, SANDBOX } from './config.js'
import { $, debounce, toast } from './dom.js'
import { InlineMath, BlockMath, insertAndEditMath, selectAndEditMath, isMathNode } from './nodes/math.js'
import { FootnoteRef, setupFootnotes, footnotesHTML, loadFootnotesHTML } from './nodes/footnote.js'
import { Figure } from './nodes/figure.js'
import { setupFigures, rehydrateVideos } from './figures.js'
import { setupMathLive, mathKeyboard } from './mathlive-config.js'
import { setupAiMath } from './ai-math.js'
import { setupLinks } from './links.js'
import { setupSourceView } from './source-view.js'
import { setupDrafts } from './drafts.js'
import { setupPublish } from './publish.js'

setupMathLive()

// Block-level items that arrow keys can highlight-then-step-past (like inline math).
// Excludes paragraphs/headings/lists so ordinary text navigation is untouched.
const NAV_BLOCKS = new Set(['figure', 'blockMath', 'blockquote', 'horizontalRule', 'codeBlock'])
function isNavigableBlock(node) {
  return !!node && !node.isText && (NAV_BLOCKS.has(node.type.name) || (node.isAtom && node.isBlock))
}

/* ---------------------------------------------------------------- boot */
const surface = $('surface')
const docTitle = $('docTitle')
const docSubtitle = $('docSubtitle')

// apply the configured writing font to the surface
surface.classList.remove('font-serif', 'font-sans', 'font-mono')
surface.classList.add('font-' + CONFIG.font)

export const editor = new Editor({
  element: $('docBody'),
  extensions: [
    StarterKit.configure({
      heading: { levels: CONFIG.headingLevels },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } },
      // keep it prose-focused; code block stays available
    }),
    // Only prompt "Start writing…" when the whole document is empty — not on every
    // blank paragraph inside an article that already has text.
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? 'Start writing…' : '') }),
    InlineMath,
    BlockMath,
    FootnoteRef,
    Figure,
  ],
  editorProps: {
    scrollThreshold: CONFIG.scroll.threshold,
    scrollMargin: {
      top: CONFIG.scroll.marginTop,
      bottom: CONFIG.scroll.marginBottom,
      left: 0,
      right: 0,
    },
    attributes: { class: 'doc-body-pm' },
    // Click a math node → select it and open the in-place editor. But if it's ALREADY
    // open, let the click fall through to MathLive so it positions the caret where you
    // clicked (otherwise re-selecting would swallow the click and jump to the end).
    handleClickOn(view, pos, node, nodePos, event, direct) {
      if (!direct || !isMathNode(node)) return false
      const dom = view.nodeDOM(nodePos)
      if (dom && dom.classList && dom.classList.contains('math-editing')) return false
      return selectAndEditMath(view, nodePos)
    },
    // Keyboard: Enter opens a selected equation; Left/Right arrows select an adjacent
    // item — inline (math, footnote ref) or block (image/video, block math, quote, rule,
    // code) — as a highlight, then step the caret past it, in both directions, without
    // entering it. (Enter still opens a highlighted equation for editing.)
    handleKeyDown(view, event) {
      const { state } = view
      const { selection, doc } = state
      if (event.key === 'Enter' && selection instanceof NodeSelection && isMathNode(selection.node)) {
        return selectAndEditMath(view, selection.from)
      }
      if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') ||
          event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
      const dir = event.key === 'ArrowRight' ? 1 : -1

      // (1) a whole item is already highlighted → step the caret just past it.
      if (selection instanceof NodeSelection) {
        const at = dir > 0 ? selection.to : selection.from
        view.dispatch(state.tr.setSelection(Selection.near(doc.resolve(at), dir)).scrollIntoView())
        return true
      }

      // (2) a collapsed caret sitting right next to an item → highlight that item.
      if (selection.empty) {
        const $from = selection.$from
        // 2a. an inline atom immediately beside the caret (inline math, footnote ref)
        const inlineSide = dir > 0 ? $from.nodeAfter : $from.nodeBefore
        if (inlineSide && inlineSide.isInline && inlineSide.isAtom && inlineSide.type.name !== 'hardBreak') {
          const pos = dir > 0 ? selection.from : selection.from - inlineSide.nodeSize
          view.dispatch(state.tr.setSelection(NodeSelection.create(doc, pos)).scrollIntoView())
          return true
        }
        // 2b. caret at a block edge → highlight the adjacent block item, if any
        const atStart = $from.parentOffset === 0
        const atEnd = $from.parentOffset === $from.parent.content.size
        if ((dir < 0 && atStart) || (dir > 0 && atEnd)) {
          const boundary = dir > 0 ? $from.after() : $from.before()
          const $b = doc.resolve(boundary)
          const blockSide = dir > 0 ? $b.nodeAfter : $b.nodeBefore
          if (isNavigableBlock(blockSide)) {
            const pos = dir > 0 ? boundary : boundary - blockSide.nodeSize
            try {
              view.dispatch(state.tr.setSelection(NodeSelection.create(doc, pos)).scrollIntoView())
              return true
            } catch (e) { /* not node-selectable here → fall back to default caret motion */ }
          }
        }
      }
      return false
    },
  },
  autofocus: false, // never autofocus on load (focus triggers a scroll that clobbers restore)
  onUpdate: () => { scheduleSave(); updateToolbar() },
  onSelectionUpdate: () => { updateToolbar(); updateBubble() },
})

// expose for console debugging
window.__editor = editor

/* ---------------------------------------------------------------- toolbar */
const cmd = {
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
}

document.querySelectorAll('.tb-btn[data-cmd], .bubble button[data-cmd]').forEach((b) => {
  b.addEventListener('mousedown', (e) => { e.preventDefault(); cmd[b.dataset.cmd]?.() })
})

$('quoteBtn').addEventListener('mousedown', (e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run() })

$('formatSelect').addEventListener('change', (e) => {
  const v = e.target.value
  const chain = editor.chain().focus()
  if (v === 'paragraph') chain.setParagraph().run()
  else if (v === 'blockquote') chain.toggleBlockquote().run()
  else if (/^h(\d)$/.test(v)) chain.setHeading({ level: +v[1] }).run()
})

function updateToolbar() {
  document.querySelectorAll('.tb-btn[data-cmd], .bubble button[data-cmd]').forEach((b) => {
    const c = b.dataset.cmd
    if (c === 'bold' || c === 'italic') b.classList.toggle('active', editor.isActive(c))
  })
  $('quoteBtn').classList.toggle('active', editor.isActive('blockquote'))
  const sel = $('formatSelect')
  if (editor.isActive('heading', { level: 2 })) sel.value = 'h2'
  else if (editor.isActive('heading', { level: 3 })) sel.value = 'h3'
  else if (editor.isActive('heading', { level: 4 })) sel.value = 'h4'
  else if (editor.isActive('blockquote')) sel.value = 'blockquote'
  else sel.value = 'paragraph'
}

/* ---------------------------------------------------------------- bubble menu */
const bubble = $('bubble')
function updateBubble() {
  const { from, to, empty } = editor.state.selection
  if (empty || !editor.isFocused) { bubble.classList.remove('show'); return }
  const start = editor.view.coordsAtPos(from)
  const end = editor.view.coordsAtPos(to)
  const left = (start.left + end.left) / 2
  const top = Math.min(start.top, end.top)
  bubble.style.left = left + 'px'
  bubble.style.top = (top - 8) + 'px'
  bubble.classList.add('show')
}
bubble.querySelectorAll('button[data-cmd]').forEach((b) => b.classList.remove('active'))

/* ---------------------------------------------------------------- title / subtitle */
// plain contenteditable (their content is simple text); Enter moves to the next field.
docTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); docSubtitle.focus() }
})
docSubtitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.commands.focus('start') }
})
;[docTitle, docSubtitle].forEach((el) => {
  el.addEventListener('input', () => { refreshPlaceholders(); scheduleSave() })
})
function refreshPlaceholders() {
  ;[docTitle, docSubtitle].forEach((el) => el.classList.toggle('is-empty', el.textContent.trim() === ''))
}

/* ---------------------------------------------------------------- persistence (Phase 1: minimal, sandboxed) */
function currentSnapshot() {
  return {
    id: doc.id,
    title: docTitle.innerHTML,
    subtitle: docSubtitle.innerHTML,
    body: editor.getHTML(),
    footnotes: footnotesHTML(),
    font: CONFIG.font,
    updated: Date.now(),
  }
}

let doc = { id: 'sandbox-draft' }
const getDocId = () => doc.id
const setDocId = (id) => { doc.id = id }
const setStatus = (state, text) => {
  const s = $('saveStatus'); if (!s) return
  s.className = 'save-status ' + state; $('saveText').textContent = text
}
const _save = debounce(() => {
  const s = currentSnapshot()
  const drafts = JSON.parse(localStorage.getItem(LS.drafts) || '{}')
  drafts[doc.id] = s
  localStorage.setItem(LS.drafts, JSON.stringify(drafts))
  localStorage.setItem(LS.current, doc.id)
  setStatus('saved', 'Saved')
}, CONFIG.autosaveMs)
function scheduleSave() { setStatus('saving', 'Saving…'); _save() }

// Load a draft's CONTENT only (title/subtitle/body/footnotes). Does not set doc.id —
// the drafts module owns switching ids. emitUpdate:false so a switch never queues a save.
function applySnapshot(s) {
  docTitle.innerHTML = s.title || ''
  docSubtitle.innerHTML = s.subtitle || ''
  editor.commands.setContent(s.body || '<p></p>', { emitUpdate: false })
  loadFootnotesHTML(s.footnotes, editor)
  refreshPlaceholders()
  updateToolbar()
  setStatus('saved', 'Saved')
  // Re-create video sources for the draft just displayed (IndexedDB → disk backup).
  rehydrateVideos(editor, s.id || doc.id)
}
function load() {
  const drafts = JSON.parse(localStorage.getItem(LS.drafts) || '{}')
  const cur = localStorage.getItem(LS.current)
  const s = (cur && drafts[cur]) || Object.values(drafts).sort((a, b) => b.updated - a.updated)[0]
  if (s) { doc.id = s.id || doc.id; applySnapshot(s) }
  else { refreshPlaceholders(); updateToolbar(); setStatus('saved', 'Saved') }
}

/* ---------------------------------------------------------------- math: corner keyboard + insert */
const mathKbdToggle = $('mathKbdToggle')
mathKbdToggle.hidden = false
mathKbdToggle.classList.remove('corner-left', 'corner-right')
mathKbdToggle.classList.add('corner-' + CONFIG.mathKeyboard.corner)

function mathFieldFocused() {
  const a = document.activeElement
  return a && a.tagName === 'MATH-FIELD'
}
mathKbdToggle.addEventListener('mousedown', (e) => {
  e.preventDefault() // don't steal focus from a live math-field
  const vk = mathKeyboard()
  if (!vk) return
  if (vk.visible) { vk.hide(); mathKbdToggle.classList.remove('active'); return }
  if (!mathFieldFocused()) insertAndEditMath(editor, { block: false })
  // show after the field mounts + focuses
  setTimeout(() => { vk.show(); mathKbdToggle.classList.add('active') }, 30)
})
// keep the toggle's active state in sync if the keyboard is closed elsewhere
const vk0 = mathKeyboard()
if (vk0) vk0.addEventListener('virtual-keyboard-toggle', () => {
  mathKbdToggle.classList.toggle('active', vk0.visible)
})

// ∑ math buttons (toolbar + bubble): AI-format a selection, else insert a blank equation.
// Also wires the Settings modal + auto-loads the OpenAI key from /.env.
window.__aiMath = setupAiMath(editor)

// Footnotes: fn toolbar + bubble buttons, reconcile numbering, click-ref-to-body, save on edit.
setupFootnotes(editor, scheduleSave)

// Figures: image + video toolbar buttons, file inputs, clipboard image paste, drag-resize, crop.
setupFigures(editor)

// Links: ⌘K / toolbar / bubble link popover + hover URL preview chip.
setupLinks(editor)

// Source view: the Write/Source toggle → read-only Markdown + LaTeX.
setupSourceView(editor)

// Publish: build a standalone article and write it to writings/ via File System Access.
setupPublish({ editor, currentSnapshot })

// Click in the empty margin beside the text → place the caret at the start (left margin) or
// end (right margin) of the line at that height, like a word processor.
$('scrollArea').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !editor.isEditable) return
  const r = editor.view.dom.getBoundingClientRect()
  const left = e.clientX < r.left
  const right = e.clientX > r.right
  if (!left && !right) return                              // inside the text column → let PM handle it
  if (e.clientY < r.top || e.clientY > r.bottom) return    // not level with a body line
  const hit = editor.view.posAtCoords({ left: left ? r.left + 2 : r.right - 2, top: e.clientY })
  if (!hit) return
  e.preventDefault()
  editor.chain().focus().setTextSelection(hit.pos).run()
})

/* ---------------------------------------------------------------- keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey
  if (!meta) return
  const k = e.key.toLowerCase()
  if (k === 'b') { e.preventDefault(); cmd.bold() }
  else if (k === 'i') { e.preventDefault(); cmd.italic() }
  else if (k === 's') { e.preventDefault(); scheduleSave() }
  else if (k === 'm') { e.preventDefault(); insertAndEditMath(editor, { block: e.shiftKey }) }
})

load() // applySnapshot (called by load) rehydrates the displayed draft's videos
// Drafts menu + per-draft scroll restore + server sync (sync is inert while SANDBOX=true).
const drafts = setupDrafts({ editor, currentSnapshot, applySnapshot, getDocId, setDocId })
window.__drafts = drafts
if (SANDBOX) console.info('[editor] SANDBOX mode — real v1 drafts are untouched; using', LS.drafts)
toast(SANDBOX ? 'Sandbox mode — v1 drafts safe' : 'Editor ready')
