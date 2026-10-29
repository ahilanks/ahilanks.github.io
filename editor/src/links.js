/* links.js — the link mark UI: popover editor + caret preview chip.
 *
 * StarterKit's Link mark is already enabled in main.js (autolink:true, target=_blank/
 * rel=noopener). Opening a link is main.js's handleClick — a plain click on a link opens
 * it in a new tab. This module only wires the CHROME around it:
 *
 *   • ⌘K / the toolbar #linkBtn / the bubble #bubbleLink open #linkPop near the selection,
 *     prefilled with the current href. Apply runs extendMarkRange('link').setLink({href})
 *     (href is normalised: a bare host gets https://; empty unsets). Remove unsets.
 *   • A #linkPreview chip shows the URL (as a real clickable <a target=_blank>) whenever the
 *     CARET is inside a link, or the pointer has rested on one for a second, with an Edit
 *     button back into the popover.
 *   • Footnote bodies are raw contenteditables outside the doc, so the same popover + chip
 *     run in a "footnote mode" (fnCtx) whenever a footnote body owns the caret: the edits
 *     go through footnote.js's execCommand helpers instead of TipTap commands.
 *
 * Ported from v1's openLinkPop / positionPopover / linkPreview, adapted from raw contenteditable
 * + execCommand to TipTap commands (extendMarkRange/setLink/unsetLink) and ProseMirror geometry
 * (coordsAtPos / posAtDOM / getMarkRange). Popovers are position:fixed, so viewport coords from
 * coordsAtPos map straight to left/top; the CSS transforms handle the -50% centering.
 */

import { getMarkRange } from '../vendor/lib.bundle.js'
import { $, toast } from './dom.js'
import { docHeadings, anchorOf, anchorFor, headingForHref, jumpToSection } from './section-links.js'
import {
  footnoteLinkContext, footnoteAnchorAtSelection, applyFootnoteLink, removeFootnoteLink, focusFootnoteLinkContext,
} from './nodes/footnote.js'

/* --------------------------------------------------------------- href helpers */
// Add https:// to a bare host; leave anything with a scheme (http:, mailto:, tel:…),
// a protocol-relative //, a root-relative /, or an in-page #anchor untouched.
function normalizeHref(raw) {
  const url = (raw || '').trim()
  if (!url) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url // already has a scheme
  if (/^(\/\/|\/|#)/.test(url)) return url // protocol-relative / root-relative / anchor
  return 'https://' + url
}

/* ------------------------------------------------------------- geometry helpers */
export function setupLinks(editor) {
  const linkPop = $('linkPop')
  const linkInput = $('linkInput')
  const linkPreview = $('linkPreview')
  const linkPreviewUrl = $('linkPreviewUrl')
  const linkType = editor.schema.marks.link

  // A viewport rect covering the doc range [from,to] (mirrors main.js updateBubble()).
  const coordsRect = (from, to) => {
    const s = editor.view.coordsAtPos(from)
    const e = editor.view.coordsAtPos(to)
    const left = Math.min(s.left, e.left)
    const right = Math.max(s.right, e.right)
    const top = Math.min(s.top, e.top)
    const bottom = Math.max(s.bottom, e.bottom)
    return { left, top, right, bottom, width: right - left }
  }

  // Where to anchor the popover: the selection, or — if the caret is collapsed inside a
  // link — the whole link range so the box points at the whole href being edited.
  function popAnchorRect() {
    const { from, to, $from } = editor.state.selection
    if (from === to && linkType) {
      const range = getMarkRange($from, linkType)
      if (range) return coordsRect(range.from, range.to)
    }
    return coordsRect(from, to)
  }

  // Ported verbatim from v1: center horizontally, prefer below the anchor, flip above when
  // there's no room, and clamp fully on-screen. Popover CSS is translate(-50%,0) so `left`
  // is the CENTER x.
  function positionPopover(pop, rect) {
    pop.classList.remove('hidden')
    const w = pop.offsetWidth || 340
    const h = pop.offsetHeight || 0
    // clamp against the VISUAL viewport where available: with the on-screen keyboard
    // up, window.innerHeight still spans behind it and the popover would hide there
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight
    let left = rect.left + rect.width / 2
    left = Math.max(w / 2 + 10, Math.min(left, vw - w / 2 - 10))
    let top = rect.bottom + 8
    if (top + h > vh - 10) top = rect.top - h - 8
    top = Math.max(10, Math.min(top, vh - h - 10))
    pop.style.left = left + 'px'
    pop.style.top = top + 'px'
  }

  /* --------------------------------------------------------------- the popover */
  // Set while the popover is editing a FOOTNOTE link: { body, range, anchor } captured by
  // footnote.js before the input stole focus. Null → the popover is on the article.
  let fnCtx = null
  const inFootnote = (a) => !!(a && a.closest && a.closest('.fn-body'))

  const hideBubble = () => $('bubble')?.classList.remove('show')
  const closeLinkPop = () => { linkPop.classList.add('hidden'); fnCtx = null; renderSections(null) }

  /* sections list: every heading in the article, filtered by what's typed (unless it's a
     URL). Picking one links the selection to it — see section-links.js. Article only:
     footnote bodies live outside the doc. */
  const linkSections = $('linkSections'), linkSecList = $('linkSecList')
  function renderSections(filter) {
    linkSecList.textContent = ''
    if (filter === null || fnCtx) { linkSections.hidden = true; return }
    const q = /[/:.]/.test(filter) || filter.startsWith('#') ? '' : filter.trim().toLowerCase()
    const current = anchorOf(editor.getAttributes('link').href)
    const hs = docHeadings(editor).filter((h) => !q || h.text.toLowerCase().includes(q))
    hs.forEach((h) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'link-sec lvl-' + h.level + (current && h.anchor === current ? ' on' : '')
      b.textContent = h.text
      b.title = h.text
      b.addEventListener('mousedown', (e) => e.preventDefault()) // keep the input's focus
      b.addEventListener('click', () => linkToSection(h))
      linkSecList.appendChild(b)
    })
    linkSections.hidden = !hs.length
  }
  function linkToSection(h) {
    const anchor = anchorFor(editor, h)
    editor.chain().focus().extendMarkRange('link')
      .command(({ tr }) => { if (!h.anchor) tr.setNodeAttribute(h.pos, 'anchor', anchor); return true })
      .setLink({ href: '#' + anchor }).run()
    closeLinkPop()
  }
  linkInput.addEventListener('input', () => { if (isPopOpen()) renderSections(linkInput.value) })
  const isPopOpen = () => !linkPop.classList.contains('hidden')

  function openFootnoteLinkPop(fn) {
    if (!fn.anchor && (!fn.range || fn.range.collapsed)) { toast('Select some text to link'); return }
    hideBubble()
    hidePreviewNow()
    fnCtx = fn
    positionPopover(linkPop, (fn.anchor || fn.range).getBoundingClientRect())
    linkInput.value = fn.anchor ? fn.anchor.getAttribute('href') || '' : ''
    linkInput.focus()
    linkInput.select()
  }

  function openLinkPop() {
    const fn = footnoteLinkContext()
    if (fn) { openFootnoteLinkPop(fn); return }
    const { empty } = editor.state.selection
    // Need either a real selection to wrap, or a caret already sitting inside a link to edit.
    if (empty && !editor.isActive('link')) { toast('Select some text to link'); return }
    hideBubble()
    hidePreviewNow()
    linkInput.value = editor.getAttributes('link').href || ''
    renderSections('')
    positionPopover(linkPop, popAnchorRect())
    linkInput.focus()
    linkInput.select()
  }

  function applyLink() {
    const href = normalizeHref(linkInput.value)
    if (fnCtx) { const ctx = fnCtx; closeLinkPop(); applyFootnoteLink(ctx, href); return }
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run() // empty input clears the link
    closeLinkPop()
  }

  function removeLink() {
    if (fnCtx) { const ctx = fnCtx; closeLinkPop(); removeFootnoteLink(ctx); return }
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    closeLinkPop()
  }

  // triggers: toolbar + bubble. mousedown+preventDefault keeps the editor selection alive;
  // stopPropagation keeps the document "click-outside" closer from instantly re-hiding us.
  $('linkBtn').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openLinkPop() })
  $('bubbleLink').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openLinkPop() })

  $('linkApply').addEventListener('click', applyLink)
  $('linkRemove').addEventListener('click', removeLink)
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLink() }
    else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      const ctx = fnCtx
      closeLinkPop()
      if (ctx) focusFootnoteLinkContext(ctx) // back into the footnote body, selection intact
      else editor.commands.focus()
    }
  })

  // ⌘K / Ctrl-K (main.js's shortcut handler ignores 'k', so there's no conflict).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if (e.target && e.target.closest && e.target.closest('#mathAsk')) return // the equation's words bar
      e.preventDefault(); openLinkPop()
    } else if (e.key === 'Escape' && isPopOpen()) {
      closeLinkPop()
    }
  })

  // dismiss on outside click (the popover's own buttons/input are inside it, so they're safe).
  document.addEventListener('mousedown', (e) => {
    if (isPopOpen() && !linkPop.contains(e.target)) closeLinkPop()
  })

  /* ----------------------------------------------------------- the preview chip */
  let lpHideTimer = null
  let lpAnchor = null

  // Walk up from a DOM node to the enclosing <a href> inside the editor (never past its root).
  function anchorFrom(node) {
    if (node && node.nodeType === 3) node = node.parentNode
    const root = editor.view.dom
    while (node && node !== root) {
      if (node.tagName === 'A' && node.getAttribute('href')) return node
      node = node.parentNode
    }
    return null
  }

  // The DOM <a> the caret currently sits in, or null. Probe a position strictly inside the
  // link mark range so domAtPos lands on the anchor's text node (not a paragraph boundary).
  function anchorAtSelection() {
    if (!editor.isActive('link') || !linkType) return null
    const range = getMarkRange(editor.state.selection.$from, linkType)
    if (!range) return null
    const probe = Math.min(range.from + 1, range.to)
    const dom = editor.view.domAtPos(probe)
    let node = dom.node
    if (node && node.nodeType === 1 && node.childNodes[dom.offset]) node = node.childNodes[dom.offset]
    return anchorFrom(node)
  }

  // hover: `hoverShown` is the link the chip is showing because the pointer rested on it
  let hoverShown = null
  function showPreview(a, { hover = false } = {}) {
    clearTimeout(lpHideTimer)
    lpAnchor = a
    hoverShown = hover ? a : null
    const href = a.getAttribute('href') || ''
    const sec = anchorOf(href) && !inFootnote(a) ? headingForHref(editor, href) : null
    const label = anchorOf(href) && !inFootnote(a) ? (sec ? '§ ' + sec.text : 'Section not found') : href
    linkPreviewUrl.textContent = label.length > 60 ? label.slice(0, 57) + '…' : label
    linkPreviewUrl.setAttribute('href', href)
    positionPreview(a)
    linkPreview.classList.add('show')
  }
  function positionPreview(a) {
    const rect = a.getBoundingClientRect() // chip CSS is translate(-50%,-100%): sits centered, above
    const half = (linkPreview.offsetWidth || 0) / 2 // kept on screen near either edge
    linkPreview.style.left = Math.max(half + 8, Math.min(rect.left + rect.width / 2, window.innerWidth - half - 8)) + 'px'
    linkPreview.style.top = rect.top - 8 + 'px'
  }
  // the link the caret is in (article or footnote), if any
  const caretAnchor = () => anchorAtSelection() || footnoteAnchorAtSelection()
  function hidePreview() {
    clearTimeout(lpHideTimer)
    // small delay so the mouse can travel from the link to the chip to click Edit; then back
    // to the caret's link if it's in one (a hover chip only borrows the spot), else gone
    lpHideTimer = setTimeout(() => {
      const a = caretAnchor()
      if (a) { showPreview(a); return }
      linkPreview.classList.remove('show'); lpAnchor = null; hoverShown = null
    }, 220)
  }
  function hidePreviewNow() {
    clearTimeout(lpHideTimer)
    cancelDwell()
    linkPreview.classList.remove('show')
    lpAnchor = null
    hoverShown = null
  }

  // caret inside a link → show; caret left the link → hide (a chip you're hovering stays).
  // A click opens the link (main.js's handleClick), so the chip is how you edit one: it
  // appears once the caret is inside the link (modifier-click, arrow keys, a drag-selection)
  // or after the pointer rests on it (below), and its Edit button opens the URL popover.
  editor.on('selectionUpdate', () => {
    const a = anchorAtSelection()
    if (a) showPreview(a)
    else if (lpAnchor && lpAnchor !== hoverShown) hidePreview()
  })
  // Same for the footnote bodies, which ProseMirror knows nothing about: follow the DOM
  // selection. Only ever hides a chip it showed itself (a footnote link's), never the
  // article's, which the handler above owns.
  document.addEventListener('selectionchange', () => {
    const a = footnoteAnchorAtSelection()
    if (a) showPreview(a)
    else if (lpAnchor && inFootnote(lpAnchor) && lpAnchor !== hoverShown) hidePreview()
  })

  // Rest the pointer on a link (article or footnote) for a second → the chip. Just passing
  // over one, clicking, typing or scrolling never shows it.
  const HOVER_MS = 1000
  let dwellTimer = null
  let dwellAnchor = null
  const linkAt = (t) => {
    const a = t && t.closest && t.closest('a[href]')
    return a && (editor.view.dom.contains(a) || inFootnote(a)) ? a : null
  }
  function cancelDwell() { clearTimeout(dwellTimer); dwellTimer = null; dwellAnchor = null }
  function onLinkOver(e) {
    const a = linkAt(e.target)
    if (!a || a === dwellAnchor) return
    if (a === lpAnchor && linkPreview.classList.contains('show')) {
      // back on the link its chip is showing for (e.g. from the chip): keep it up
      clearTimeout(lpHideTimer)
      if (a !== caretAnchor()) hoverShown = a
      return
    }
    cancelDwell()
    dwellAnchor = a
    dwellTimer = setTimeout(() => {
      dwellTimer = null; dwellAnchor = null
      if (a.isConnected && !isPopOpen()) showPreview(a, { hover: true })
    }, HOVER_MS)
  }
  function onLinkOut(e) {
    const a = linkAt(e.target)
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return // still inside the link
    if (a === dwellAnchor) cancelDwell()
    if (a === hoverShown) hidePreview()
  }
  for (const el of [editor.view.dom, $('fnList')]) {
    if (!el) continue
    el.addEventListener('mouseover', onLinkOver)
    el.addEventListener('mouseout', onLinkOut)
  }
  document.addEventListener('mousedown', cancelDwell, true)
  document.addEventListener('keydown', cancelDwell, true)

  // a section link's chip scrolls to it rather than opening a tab
  linkPreviewUrl.addEventListener('click', (e) => {
    const href = linkPreviewUrl.getAttribute('href') || ''
    if (!anchorOf(href) || (lpAnchor && inFootnote(lpAnchor))) return
    e.preventDefault()
    jumpToSection(editor, href)
  })

  // keep the chip alive while the pointer is on it (so Edit stays clickable)
  linkPreview.addEventListener('mouseenter', () => clearTimeout(lpHideTimer))
  linkPreview.addEventListener('mouseleave', () => hidePreview())

  // Copy → the link's URL to the clipboard (a section link copies as-is, e.g. #intro)
  $('linkPreviewCopy').addEventListener('mousedown', async (e) => {
    e.preventDefault(); e.stopPropagation()
    const href = lpAnchor && lpAnchor.getAttribute('href')
    if (!href) return
    try { await navigator.clipboard.writeText(href); toast('Link copied') } catch (err) { toast('Couldn’t copy link') }
  })

  // Edit → select the link's whole range, then open the popover on it.
  $('linkPreviewEdit').addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!lpAnchor) return
    if (inFootnote(lpAnchor)) {
      // footnote link: select its text inside the body, then the popover picks it up as an edit
      const a = lpAnchor
      hidePreviewNow()
      a.closest('.fn-body').focus()
      const r = document.createRange(); r.selectNodeContents(a)
      const sel = window.getSelection()
      if (sel) { sel.removeAllRanges(); sel.addRange(r) }
      openLinkPop()
      return
    }
    const pos = editor.view.posAtDOM(lpAnchor.firstChild || lpAnchor, 0)
    const range = linkType && getMarkRange(editor.state.doc.resolve(pos), linkType)
    editor.chain().focus().setTextSelection(range || pos).run()
    hidePreviewNow()
    openLinkPop()
  })

  // Anchored-once popover/chip drift on scroll: close the editor, re-anchor the chip.
  $('scrollArea')?.addEventListener('scroll', () => {
    cancelDwell()
    if (isPopOpen()) closeLinkPop()
    if (lpAnchor && linkPreview.classList.contains('show')) positionPreview(lpAnchor)
  }, { passive: true })

  // expose for verification
  return { openLinkPop, closeLinkPop, normalizeHref }
}
