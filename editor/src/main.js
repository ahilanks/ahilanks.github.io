/* main.js — boots the editor. (Phase 1: core editing + toolbar + scroll + minimal
 * sandboxed persistence. Later phases add math, footnotes, figures, publish, sync.) */

import { Editor, StarterKit, Link, Placeholder, NodeSelection, Selection } from '../vendor/lib.bundle.js'
import { CONFIG, LS, SANDBOX } from './config.js'
import { $, debounce, toast } from './dom.js'
import { InlineMath, BlockMath, insertAndEditMath, selectAndEditMath, isMathNode } from './nodes/math.js'
import { FootnoteRef, setupFootnotes, footnotesHTML, loadFootnotesHTML } from './nodes/footnote.js'
import { Figure } from './nodes/figure.js'
import { SmartTypography } from './typography.js'
import { setupFigures, rehydrateVideos } from './figures.js'
import { setupMathLive, mathKeyboard } from './mathlive-config.js'
import { setupAiMath } from './ai-math.js'
import { setupLinks } from './links.js'
import { cleanPastedHTML, setupPlainTextPaste } from './paste.js'
import { setupSourceView } from './source-view.js'
import { setupToc } from './toc.js'
import { setupDrafts } from './drafts.js'
import { setupPublish } from './publish.js'
import { setupMobileViewport } from './mobile.js'
import { setupMathAlign } from './math-align.js'

setupMathLive()
setupMobileViewport() // phones: size the shell to the visual viewport (keyboard-aware)

// Block-level items that arrow keys highlight-then-step-past, like inline math: media
// figures, display equations, rules. Anything that holds ordinary TEXT — paragraphs,
// headings, lists, quotes, code blocks — is deliberately absent: the caret has to walk
// through those one character at a time, not hop over a whole quote in a single press.
const NAV_BLOCKS = new Set(['figure', 'blockMath', 'horizontalRule'])
function isNavigableBlock(node) {
  return !!node && !node.isText && NAV_BLOCKS.has(node.type.name)
}

// A caret-style selection near `pos` (preferring `bias`: +1 forward, -1 back) that is NOT a
// NodeSelection on an atom — selecting an atom would just move the blue ring instead of clearing
// it. Falls back to the other direction. Used everywhere we "step off" a highlighted math box.
function caretNear(doc, pos, bias) {
  const clamp = (p) => Math.max(0, Math.min(p, doc.content.size))
  const a = Selection.near(doc.resolve(clamp(pos)), bias)
  if (!(a instanceof NodeSelection)) return a
  const b = Selection.near(doc.resolve(clamp(pos)), -bias)
  return b instanceof NodeSelection ? a : b
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
      link: false, // configured below as a non-inclusive mark
      // the drop-position line shown while dragging a figure (or text) — match the
      // node-selection ring blue so "what's selected" and "where it lands" read as one
      dropcursor: { color: 'rgba(15, 122, 229, 0.8)', width: 3 },
      // keep it prose-focused; code block stays available
    }),
    // Stock Link is `inclusive` whenever autolink is on, so typing at the end of a link
    // kept extending it. Autolink only fires on whitespace for not-yet-linked URLs, so it
    // works fine with inclusive:false — text typed right after a link stays plain.
    // (Typing at the very START of a block that begins with a link is the one boundary
    // ProseMirror still treats as inside the mark; handleTextInput below covers that.)
    Link.extend({ inclusive: false }).configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: 'noopener', target: '_blank' },
    }),
    // Only prompt "Start writing…" when the whole document is empty — not on every
    // blank paragraph inside an article that already has text.
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? 'Start writing…' : '') }),
    SmartTypography,
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
    // A click on a link OPENS it (new tab) — that's the only thing that does; hovering one
    // shows nothing (see links.js). Hold any modifier to click "into" a link instead: that
    // drops the caret inside it so ⌘K can edit the URL. Drag-selecting link text never gets
    // here either (ProseMirror skips handleClick once the pointer has moved), so selecting
    // a link and hitting ⌘K works too.
    handleClick(view, pos, event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
      const a = event.target && event.target.closest && event.target.closest('a[href]')
      if (!a || !view.dom.contains(a)) return false
      const href = a.getAttribute('href')
      if (!href) return false
      event.preventDefault()
      window.open(href, '_blank', 'noopener')
      return true
    },
    // Pasted (or dropped) content from another site adopts THIS editor's typography: the
    // structure survives, the source page's presentation doesn't. Internal copy/paste is
    // passed through untouched — see paste.js.
    transformPastedHTML: (html) => cleanPastedHTML(html),
    // Keyboard: Enter opens a selected equation; Left/Right arrows select an adjacent
    // OBJECT — inline (math, footnote ref) or block (image/video, block math, rule) — as a
    // highlight, then step the caret past it, in both directions, without entering it. Text
    // blocks (quotes, lists, code) are not objects: the caret walks into them normally, one
    // character per press. (Enter still opens a highlighted equation for editing.)
    // Typing with the caret at a link's boundary (before its first or after its last
    // character) must never grow the link. inclusive:false handles the end; the start of
    // a block that opens with a link is the case ProseMirror's $pos.marks() still
    // resolves to the link, so strip it here.
    handleTextInput(view, from, to, text) {
      if (from !== to) return false
      const { state } = view
      const linkType = state.schema.marks.link
      const $pos = state.doc.resolve(from)
      const marks = state.storedMarks || $pos.marks()
      if (!linkType.isInSet(marks)) return false
      const before = $pos.nodeBefore, after = $pos.nodeAfter
      const beforeLinked = !!(before && linkType.isInSet(before.marks))
      const afterLinked = !!(after && linkType.isInSet(after.marks))
      if (beforeLinked && afterLinked) return false // genuinely inside the link
      const kept = marks.filter((m) => m.type !== linkType)
      view.dispatch(state.tr.replaceWith(from, to, state.schema.text(text, kept)).scrollIntoView())
      return true
    },
    handleKeyDown(view, event) {
      const { state } = view
      const { selection, doc } = state
      if (event.key === 'Enter' && selection instanceof NodeSelection && isMathNode(selection.node)) {
        return selectAndEditMath(view, selection.from)
      }
      // Backspace in an EMPTY trailing paragraph that sits right after a blockquote (or code
      // block) → delete the whole line. ProseMirror's default instead pulls the empty paragraph
      // up INTO the block before it, so it can never be removed — the "extra space you can't get
      // rid of" between the last quote and the footnotes.
      if (event.key === 'Backspace' && selection.empty && selection.$from.depth === 1) {
        const $from = selection.$from
        const para = $from.parent
        const before = $from.before() > 0 ? doc.resolve($from.before()).nodeBefore : null
        if (para.type.name === 'paragraph' && para.content.size === 0 &&
            $from.after() === doc.content.size && doc.childCount > 1 &&
            before && (before.type.name === 'blockquote' || before.type.name === 'codeBlock')) {
          try {
            const start = $from.before()
            const tr = state.tr.delete(start, $from.after())
            view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(start), -1)).scrollIntoView())
            return true
          } catch (e) { /* fall through to default */ }
        }
      }
      if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') ||
          event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
      const dir = event.key === 'ArrowRight' ? 1 : -1

      // (1) a whole item is already highlighted → step the caret just past it (to a real caret,
      // never onto the next atom — that would just carry the ring along).
      if (selection instanceof NodeSelection) {
        const at = dir > 0 ? selection.to : selection.from
        view.dispatch(state.tr.setSelection(caretNear(doc, at, dir)).scrollIntoView())
        return true
      }

      // (2) a collapsed caret sitting right next to an item → highlight that item.
      if (selection.empty) {
        const $from = selection.$from
        // 2a. an inline OBJECT immediately beside the caret (inline math, footnote ref).
        // `!isText` is load-bearing: in ProseMirror's model a text node is a leaf, so
        // `text.isAtom` is TRUE. Without the guard, every ordinary left/right press inside a
        // word matched here ($from.nodeBefore mid-word is a text node) and node-selected the
        // whole text run — which read as the caret "jumping" to the next link or block edge
        // instead of moving one character.
        const inlineSide = dir > 0 ? $from.nodeAfter : $from.nodeBefore
        if (inlineSide && inlineSide.isInline && !inlineSide.isText && inlineSide.isAtom &&
            inlineSide.type.name !== 'hardBreak' && NodeSelection.isSelectable(inlineSide)) {
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
  setupPlainTextPaste(el) // these store innerHTML: paste text only, never a site's markup
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
  // setContent above runs with emitUpdate:false, so the contents panel won't hear about
  // the swap through editor.on('update') — refresh it directly (toc is set up before load()).
  if (toc) toc.refresh()
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

// Floating Left/Center/Right chip above a selected/edited block equation.
setupMathAlign(editor)

// Footnotes: fn toolbar + bubble buttons, reconcile numbering, click-ref-to-body, save on edit.
setupFootnotes(editor, scheduleSave)

// Figures: image + video toolbar buttons, file inputs, clipboard image paste, drag-resize, crop.
setupFigures(editor)

// Links: ⌘K / toolbar / bubble link popover + hover URL preview chip.
setupLinks(editor)

// Source view: the Write/Source toggle → read-only Markdown + LaTeX.
setupSourceView(editor)

// Contents panel: top-left §-numbered outline of the doc's headings (see toc.js).
const toc = setupToc(editor)

// Publish: build a standalone article and write it to writings/ via File System Access.
setupPublish({ editor, currentSnapshot })

// While a ProseMirror drag (an image figure, or dragged text) is in flight, a drop on any
// OTHER editable surface — title, subtitle, footnote bodies — would natively paste the
// dragged HTML into it. Swallow those: only the editor body may accept an editor drag.
document.addEventListener('drop', (e) => {
  if (editor.view.dragging && !editor.view.dom.contains(e.target)) e.preventDefault()
}, true)

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

// Arrow-selecting a math atom highlights it (blue ring) without opening a field. PM keeps
// that ring on blur, so clicking out in the page — margins, title, chrome — leaves it stuck.
// Drop it on any mousedown that lands outside the editor. Skip when an in-place field is open:
// that case is owned by the field's own focus-out commit (nodes/math.js), which also respects
// focus-preserving controls like the toolbar and corner keyboard toggle. Deferred so the click
// lands (focus moves off the editor) before we collapse, avoiding a focus tug-of-war.
document.addEventListener('mousedown', (e) => {
  // the align chip operates ON the selected equation — clicking it must not collapse
  // the very selection it targets
  if (e.target && e.target.closest && e.target.closest('#mathAlignRow')) return
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || !isMathNode(sel.node)) return
  if (document.querySelector('math-field.math-edit')) return   // a field is open → it owns teardown
  const pos = sel.from
  // Let the click settle, then if a math atom is STILL node-selected at the same spot (the click
  // didn't move the caret off it), collapse it to a plain caret. This enforces "caret not on the
  // box ⟹ no ring" for clicking elsewhere in the text, the margins, or off the editor entirely.
  setTimeout(() => {
    if (document.querySelector('math-field.math-edit')) return // a field opened from this click
    const s = editor.state.selection
    if (!(s instanceof NodeSelection) || !isMathNode(s.node) || s.from !== pos) return
    editor.view.dispatch(editor.state.tr.setSelection(caretNear(editor.state.doc, s.to, 1)))
  }, 0)
}, true)

// Same guarantee when focus leaves the editor without a mousedown we can see (Tab away, switch
// apps, click the title/topbar): drop any lingering math ring on blur, unless a field is editing.
editor.on('blur', () => {
  const sel = editor.state.selection
  if (sel instanceof NodeSelection && isMathNode(sel.node) && !document.querySelector('math-field.math-edit')) {
    editor.view.dispatch(editor.state.tr.setSelection(caretNear(editor.state.doc, sel.to, 1)))
  }
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
