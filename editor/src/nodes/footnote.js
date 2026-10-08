/* footnote.js — footnote references + the footnotes region.
 *
 * A footnote reference is an inline atom node rendered as <sup class="fn-ref" data-fn="id">N</sup>.
 * The footnote BODIES live in a region below the article (`#fnList`, a contenteditable list),
 * OUTSIDE the ProseMirror doc — mirroring v1 so the stored `footnotes` field (fnList.innerHTML)
 * round-trips unchanged. The number N is NOT stored in the doc; `reconcileFootnotes()` walks the
 * refs in document order on every update, numbers them, and reorders the body list to match;
 * bodies whose ref was deleted stay in the list, gray and unnumbered (see "orphaned bodies" below).
 */

import { Node } from '../../vendor/lib.bundle.js'
import { $, uid, debounce, toast } from '../dom.js'
import { cleanPastedHTML, insertCleanHTML, insertPlain } from '../paste.js'

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
// Footnote bodies keep inline formatting plus images (<img> embedded as a data-URI, the
// same way body figures store theirs; publish.js splits them out to media/ files).
const FN_ALLOW = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'SUP', 'SUB', 'IMG'])
const FN_ATTRS = { A: ['href', 'target', 'rel'], IMG: ['src', 'alt'] }
const FN_IMG_SRC = /^(https?:|data:image\/|media\/|\.\.?\/|\/)/i
function normalizeFnBody(root) {
  root.querySelectorAll('*').forEach((el) => {
    if (!root.contains(el)) return
    if (!FN_ALLOW.has(el.tagName)) { el.replaceWith(...el.childNodes); return }
    const keep = FN_ATTRS[el.tagName] || []
    Array.from(el.attributes).forEach((a) => { if (!keep.includes(a.name.toLowerCase())) el.removeAttribute(a.name) })
    // an image we can't show (file:// from a drag, a stripped/blocked src) is just noise
    if (el.tagName === 'IMG' && !FN_IMG_SRC.test(el.getAttribute('src') || '')) el.remove()
  })
}

/* ------------------------------------------------------- images in footnotes
 * A footnote body is a raw contenteditable, so an image is a plain <img> in its HTML
 * (block-styled by CSS). Three ways in — the toolbar image button while a body has
 * focus, pasting an image from the clipboard, dropping an image file — all land here. */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// The footnote body that currently owns the caret, or null.
export function activeFootnoteBody() {
  const a = document.activeElement
  return a && a.closest ? a.closest('.fn-body') : null
}

// Snapshot the caret inside `body` so it can be restored after a file dialog stole focus.
function saveRange(body) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  return body.contains(r.commonAncestorContainer) ? r.cloneRange() : null
}

/* Insert an image file into a footnote body. If `range` (or the live caret) is inside the
 * body it goes there via execCommand so Cmd-Z undoes it; otherwise it's appended. */
export async function insertImageIntoFootnote(body, file, range) {
  if (!body || !file || !file.type.startsWith('image/')) return false
  let src
  try { src = await fileToDataUrl(file) } catch (e) { toast("Couldn't read that image"); return false }
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  const sel = window.getSelection()
  if (!range) range = saveRange(body) // the live caret, if it's already in this body
  if (range && sel) {
    body.focus()
    sel.removeAllRanges(); sel.addRange(range)
    insertCleanHTML(img.outerHTML)
  } else {
    // no caret in the body → append, then park the caret after the image
    body.appendChild(img)
    body.focus()
    if (sel) { const r = document.createRange(); r.setStartAfter(img); r.collapse(true); sel.removeAllRanges(); sel.addRange(r) }
  }
  body.dispatchEvent(new Event('input', { bubbles: true })) // → save
  return true
}

// First image file in a clipboard/drag DataTransfer, or null.
function imageFileFrom(dt) {
  if (!dt) return null
  for (const f of Array.from(dt.files || [])) if (f.type && f.type.startsWith('image/')) return f
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) return f }
  }
  return null
}

/* -------------------------------------------------------- links in footnotes
 * A footnote body is a raw contenteditable, so a link is a plain <a href> in its HTML
 * (normalizeFnBody keeps href/target/rel; publish.js copies them out verbatim). links.js
 * owns the popover + preview chip and calls in here whenever a footnote body owns the
 * caret. The edits are the browser's own createLink / unlink: they keep the surrounding
 * <b>/<i> structure intact (an insertHTML wrap splits it and sprinkles &nbsp;) and sit
 * on the native undo stack, so Cmd-Z undoes them like typing. New links then get
 * target=_blank / rel=noopener like the article's link mark. */

// The <a href> enclosing `node` inside `body`, or null (never walks past the body).
function anchorIn(body, node) {
  if (node && node.nodeType === 3) node = node.parentNode
  while (node && node !== body) {
    if (node.tagName === 'A' && node.getAttribute('href')) return node
    node = node.parentNode
  }
  return null
}

function restoreSelection(body, range) {
  body.focus()
  const sel = window.getSelection()
  if (sel && range) { sel.removeAllRanges(); sel.addRange(range) }
}

/* What ⌘K / the link button acts on: the footnote body that owns the caret, the selection
 * inside it, and — if the selection sits inside a link — that link (→ edit instead of
 * wrap). Null when the caret isn't in a footnote body at all. Must be taken BEFORE the
 * popover's input steals focus, since that drops the body's selection. */
export function footnoteLinkContext() {
  const body = activeFootnoteBody()
  if (!body) return null
  const range = saveRange(body)
  const anchor = range ? anchorIn(body, range.commonAncestorContainer) : null
  return { body, range, anchor }
}

// The footnote link the caret currently sits in (drives the preview chip), or null.
export function footnoteAnchorAtSelection() {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const node = sel.getRangeAt(0).commonAncestorContainer
  const el = node && node.nodeType === 3 ? node.parentNode : node
  const body = el && el.closest ? el.closest('.fn-body') : null
  return body ? anchorIn(body, node) : null
}

// Put the caret back where the popover found it (Escape / cancelled edit).
export function focusFootnoteLinkContext(ctx) { restoreSelection(ctx.body, ctx.range) }

// After a link edit: park the caret just AFTER `after` (the link, so typing on doesn't
// extend it) or else collapse to the selection's end, then tell the draft it changed.
function finishFootnoteLinkEdit(body, after) {
  const sel = window.getSelection()
  if (sel && sel.rangeCount) {
    if (after) { const r = document.createRange(); r.setStartAfter(after); r.collapse(true); sel.removeAllRanges(); sel.addRange(r) }
    else sel.collapseToEnd()
  }
  body.dispatchEvent(new Event('input', { bubbles: true })) // → save
}

/* Apply the popover to a footnote: an empty href unlinks; a selection inside an existing
 * link re-targets that whole link; otherwise the selection is linked (one <a> per inline
 * run when it crosses formatting, as the browser does). Returns whether anything changed. */
export function applyFootnoteLink(ctx, href) {
  const { body, range, anchor } = ctx
  if (!href) return removeFootnoteLink(ctx)
  let r = range
  if (anchor) { r = document.createRange(); r.selectNodeContents(anchor) }
  else if (!r || r.collapsed) return false
  restoreSelection(body, r)
  document.execCommand('createLink', false, href)
  // the link(s) just made carry only href — match the article's link mark
  let last = null
  body.querySelectorAll('a[href]').forEach((a) => {
    if (a.getAttribute('href') !== href) return
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
    last = a
  })
  finishFootnoteLinkEdit(body, last)
  return true
}

// Unwrap the link the popover was opened on (keeps its text). No link → just refocus.
export function removeFootnoteLink(ctx) {
  const { body, range, anchor } = ctx
  if (!anchor) { restoreSelection(body, range); return false }
  const r = document.createRange(); r.selectNodeContents(anchor)
  restoreSelection(body, r)
  document.execCommand('unlink')
  finishFootnoteLinkEdit(body, null)
  return true
}

function createFnEntry(id) {
  const li = document.createElement('li')
  li.dataset.fn = id
  const num = document.createElement('span'); num.className = 'fn-num'; num.textContent = '.'
  const body = document.createElement('div'); body.className = 'fn-body'; body.setAttribute('contenteditable', 'true')
  li.append(num, body)
  return li
}

/* ---------------------------------------------------------- orphaned bodies
 * Footnote BODIES live outside the ProseMirror doc, so deleting a reference must not
 * destroy its text: the <li> stays in the list, gray with a bullet instead of a number
 * ("orphan"), below the numbered notes. Undoing the deletion re-attaches it by fnId;
 * clicking its bullet (shown as × on hover) deletes it for good. An orphan with no text
 * has nothing worth keeping, so it's dropped instead. Orphans are part of
 * fnList.innerHTML, so they persist with the draft — but are skipped at publish time. */

// No words and no image — nothing worth keeping.
function isEmptyBody(body) {
  return !body || (!(body.textContent || '').trim() && !body.querySelector('img'))
}

// Delete a footnote entry outright (an orphan's × / Backspace) and save.
function removeFnEntry(li) {
  const fnList = li.parentNode
  if (!fnList) return
  // Removing the focused body fires a synchronous focusout, whose handler (below) may remove
  // this same entry first — so blur up front and bail if that already did the job.
  if (li.contains(document.activeElement)) document.activeElement.blur()
  if (!li.isConnected) return
  li.remove()
  const section = $('footnotes')
  if (section) section.hidden = fnList.children.length === 0
  fnList.dispatchEvent(new Event('input', { bubbles: true })) // → save
}

// Scroll the one scroller (#scrollArea) so `el` sits in the middle of the screen.
function centerOnScreen(el) {
  const area = $('scrollArea')
  if (!area) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
  const a = area.getBoundingClientRect(); const r = el.getBoundingClientRect()
  const top = area.scrollTop + (r.top + r.height / 2) - (a.top + a.height / 2)
  area.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

// Take the caret to footnote `id`'s body, centred on screen, with a brief highlight.
function revealFootnote(id) {
  const li = document.querySelector(`#fnList li[data-fn="${id}"]`)
  if (!li) return
  li.querySelector('.fn-body').focus({ preventScroll: true })
  centerOnScreen(li)
  if (li.animate) {
    li.animate([{ backgroundColor: 'rgba(230, 178, 60, 0.32)' }, { backgroundColor: 'rgba(230, 178, 60, 0)' }],
      { duration: 1600, easing: 'ease-out' })
  }
}

// And back: caret just after footnote `id`'s marker in the text, centred on screen.
function revealRef(editor, id) {
  let at = -1
  editor.state.doc.descendants((n, p) => {
    if (at < 0 && n.type.name === 'footnoteRef' && n.attrs.fnId === id) at = p
    return at < 0
  })
  if (at < 0) return
  editor.commands.setTextSelection(at + 1)
  editor.view.focus()
  const ref = editor.view.dom.querySelector(`.fn-ref[data-fn="${id}"]`)
  if (ref) centerOnScreen(ref)
}

let lastSig = null // null, not '': a draft with no refs must still get one full pass
export function reconcileFootnotes(editor) {
  const fnList = $('fnList'); const section = $('footnotes')
  if (!fnList || !section) return
  fnList.querySelectorAll('.fn-body').forEach((b) => normalizeFnBody(b))
  const refs = Array.from(editor.view.dom.querySelectorAll('.fn-ref'))
  const seen = new Set(refs.map((r) => r.dataset.fn))
  // Number refs before any fast-path bail: a rebuilt nodeview (undo, paste, paragraph
  // redraw) re-renders as the '•' placeholder even when the ref ORDER is unchanged.
  refs.forEach((ref, i) => { ref.textContent = i + 1 })
  const sig = refs.map((r) => r.dataset.fn).join('|')
  const entryIds = new Set(Array.from(fnList.children, (li) => li.dataset.fn))
  if (sig === lastSig && refs.every((r) => entryIds.has(r.dataset.fn))) {
    section.hidden = fnList.children.length === 0
    return
  }
  lastSig = sig

  const entries = {}
  Array.from(fnList.children).forEach((li) => (entries[li.dataset.fn] = li))
  // ref gone → keep the body, gray and unnumbered (undo re-attaches it) — unless it's empty
  Object.values(entries).forEach((li) => {
    if (seen.has(li.dataset.fn)) return
    if (isEmptyBody(li.querySelector('.fn-body')) && !li.contains(document.activeElement)) {
      li.remove(); delete entries[li.dataset.fn]; return
    }
    li.classList.add('fn-orphan')
    li.querySelector('.fn-num').textContent = '•'
  })
  refs.forEach((ref, i) => {
    let li = entries[ref.dataset.fn]
    if (!li) { li = createFnEntry(ref.dataset.fn); entries[ref.dataset.fn] = li }
    li.classList.remove('fn-orphan')
    li.querySelector('.fn-num').textContent = (i + 1) + '.'
    fnList.appendChild(li) // append in ref order → correct ordering
  })
  // orphans sink below the numbered notes, keeping their relative order
  fnList.querySelectorAll('li.fn-orphan').forEach((li) => fnList.appendChild(li))
  section.hidden = fnList.children.length === 0
}

export function insertFootnote(editor) {
  const id = uid()
  const fnList = $('fnList')
  if (fnList) fnList.appendChild(createFnEntry(id))
  // No .focus() in the chain: when the article isn't focused (the toolbar button took it),
  // TipTap's focus() re-focuses it a frame later — pulling the caret back out of the new
  // footnote body and scrolling back up to the marker.
  editor.chain().insertContent({ type: 'footnoteRef', attrs: { fnId: id } }).run()
  reconcileFootnotes(editor)
  revealFootnote(id)
}

// Called by main.js: wire buttons, reconcile on updates, click-ref-to-body, and save on body edits.
export function setupFootnotes(editor, onFootnoteEdit) {
  const reconcile = () => reconcileFootnotes(editor)
  editor.on('update', debounce(reconcile, 120))
  const fnList = $('fnList')
  if (fnList) {
    fnList.addEventListener('input', () => onFootnoteEdit && onFootnoteEdit())
    // An orphan emptied of its text goes away once the caret leaves it, or straight away on
    // Backspace/Delete (caret then lands at the end of the footnote above).
    fnList.addEventListener('focusout', (e) => {
      const li = e.target.closest && e.target.closest('li.fn-orphan')
      if (li && li.isConnected && isEmptyBody(li.querySelector('.fn-body'))) removeFnEntry(li)
    })
    fnList.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      const li = e.target.closest && e.target.closest('li.fn-orphan')
      if (!li || !isEmptyBody(li.querySelector('.fn-body'))) return
      e.preventDefault()
      const prev = li.previousElementSibling && li.previousElementSibling.querySelector('.fn-body')
      if (prev) {
        prev.focus({ preventScroll: true })
        const sel = window.getSelection()
        if (sel) { sel.selectAllChildren(prev); sel.collapseToEnd() }
      }
      removeFnEntry(li) // a no-op if leaving it (the focusout above) already removed it
    })
    // Paste into a footnote body: keep the words and inline formatting, drop the source
    // page's styling. (These are raw contenteditable divs — the browser's default paste
    // would inject its spans/fonts/colors verbatim, which normalizeFnBody only cleans up
    // on the next reconcile.)
    fnList.addEventListener('paste', (e) => {
      const cd = e.clipboardData
      if (!cd) return
      e.preventDefault()
      // an image on the clipboard (screenshot, copied picture) → embed it
      const imgFile = imageFileFrom(cd)
      const body = e.target.closest && e.target.closest('.fn-body')
      if (imgFile && body) { insertImageIntoFootnote(body, imgFile); return }
      const html = cd.getData('text/html')
      if (html) {
        const tmp = document.createElement('div')
        tmp.innerHTML = cleanPastedHTML(html)
        normalizeFnBody(tmp) // footnote bodies allow inline formatting only
        insertCleanHTML(tmp.innerHTML)
      } else {
        insertPlain(cd.getData('text/plain') || '')
      }
      if (onFootnoteEdit) onFootnoteEdit()
    })
    // Drop an image file onto a footnote body → embed it there. (An editor-internal drag —
    // a body figure — is already swallowed by main.js's capture-phase drop handler.)
    fnList.addEventListener('dragover', (e) => {
      if (imageFileFrom(e.dataTransfer) && e.target.closest && e.target.closest('.fn-body')) {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
      }
    })
    fnList.addEventListener('drop', (e) => {
      const body = e.target.closest && e.target.closest('.fn-body')
      const f = imageFileFrom(e.dataTransfer)
      if (!body || !f) return
      e.preventDefault()
      let range = null
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY)
      else if (document.caretPositionFromPoint) {
        const cp = document.caretPositionFromPoint(e.clientX, e.clientY)
        if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); range.collapse(true) }
      }
      if (range && !body.contains(range.commonAncestorContainer)) range = null
      insertImageIntoFootnote(body, f, range)
    })
    // Click an image → select it whole, so Backspace/Delete removes it (a bare click in a
    // contenteditable only puts the caret beside it). A plain click on a link OPENS it in a
    // new tab, as in the article (main.js handleClick); hold any modifier to click INTO it
    // instead — the caret lands inside, the preview chip appears, ⌘K edits the URL.
    fnList.addEventListener('click', (e) => {
      // the number → back to its marker in the text; an orphan's bullet (× on hover) → delete
      const num = e.target.closest && e.target.closest('.fn-num')
      if (num && e.button === 0) {
        const li = num.closest('li')
        if (li.classList.contains('fn-orphan')) removeFnEntry(li)
        else revealRef(editor, li.dataset.fn)
        return
      }
      const a = e.target.closest && e.target.closest('.fn-body a[href]')
      if (a && e.button === 0 && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
        e.preventDefault()
        window.open(a.getAttribute('href'), '_blank', 'noopener')
        return
      }
      if (!(e.target instanceof HTMLImageElement) || !e.target.closest('.fn-body')) return
      const sel = window.getSelection(); if (!sel) return
      const r = document.createRange(); r.selectNode(e.target)
      sel.removeAllRanges(); sel.addRange(r)
    })
    // Toolbar image button while a footnote body has the caret → the picked file goes
    // into that body, not the article. The mousedown must not steal focus (so we can see
    // WHICH body), and the caret is snapshotted because the file dialog will blur it.
    const imageBtn = $('imageBtn'); const imageFileInput = $('imageFileInput')
    if (imageBtn && imageFileInput) {
      let target = null
      imageBtn.addEventListener('mousedown', (e) => {
        const body = activeFootnoteBody()
        if (!body) { target = null; return }
        e.preventDefault()
        target = { body, range: saveRange(body) }
      })
      // capture phase: runs before figures.js's own change listener, which we then stop
      imageFileInput.addEventListener('change', (e) => {
        if (!target) return
        const t = target; target = null
        const file = imageFileInput.files[0]
        imageFileInput.value = ''
        e.stopImmediatePropagation()
        insertImageIntoFootnote(t.body, file, t.range)
      }, true)
      // a click that never reached the input (dialog cancelled) must not leave a stale target
      imageFileInput.addEventListener('cancel', () => { target = null })
    }
  }
  // click a ref → its body, centred on screen
  editor.view.dom.addEventListener('click', (e) => {
    const ref = e.target.closest && e.target.closest('.fn-ref')
    if (ref) revealFootnote(ref.dataset.fn)
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
  lastSig = null // force a full pass (re-number, drop empty orphans) on the next reconcile
  reconcileFootnotes(editor)
}
