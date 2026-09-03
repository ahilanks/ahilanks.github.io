/* links.js — the link mark UI: popover editor + caret preview chip.
 *
 * StarterKit's Link mark is already enabled in main.js (autolink:true, target=_blank/
 * rel=noopener). Opening a link is main.js's handleClick — a plain click on a link opens
 * it in a new tab; hovering does nothing. This module only wires the CHROME around it:
 *
 *   • ⌘K / the toolbar #linkBtn / the bubble #bubbleLink open #linkPop near the selection,
 *     prefilled with the current href. Apply runs extendMarkRange('link').setLink({href})
 *     (href is normalised: a bare host gets https://; empty unsets). Remove unsets.
 *   • A #linkPreview chip shows the URL (as a real clickable <a target=_blank>) whenever the
 *     CARET is inside a link, with an Edit button back into the popover. Not on hover.
 *
 * Ported from v1's openLinkPop / positionPopover / linkPreview, adapted from raw contenteditable
 * + execCommand to TipTap commands (extendMarkRange/setLink/unsetLink) and ProseMirror geometry
 * (coordsAtPos / posAtDOM / getMarkRange). Popovers are position:fixed, so viewport coords from
 * coordsAtPos map straight to left/top; the CSS transforms handle the -50% centering.
 */

import { getMarkRange } from '../vendor/lib.bundle.js'
import { $, toast } from './dom.js'

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
  const hideBubble = () => $('bubble')?.classList.remove('show')
  const closeLinkPop = () => linkPop.classList.add('hidden')
  const isPopOpen = () => !linkPop.classList.contains('hidden')

  function openLinkPop() {
    const { empty } = editor.state.selection
    // Need either a real selection to wrap, or a caret already sitting inside a link to edit.
    if (empty && !editor.isActive('link')) { toast('Select some text to link'); return }
    hideBubble()
    hidePreviewNow()
    positionPopover(linkPop, popAnchorRect())
    linkInput.value = editor.getAttributes('link').href || ''
    linkInput.focus()
    linkInput.select()
  }

  function applyLink() {
    const href = normalizeHref(linkInput.value)
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run() // empty input clears the link
    closeLinkPop()
  }

  function removeLink() {
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
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkPop(); editor.commands.focus() }
  })

  // ⌘K / Ctrl-K (main.js's shortcut handler ignores 'k', so there's no conflict).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
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

  function showPreview(a) {
    clearTimeout(lpHideTimer)
    lpAnchor = a
    const href = a.getAttribute('href') || ''
    linkPreviewUrl.textContent = href.length > 60 ? href.slice(0, 57) + '…' : href
    linkPreviewUrl.setAttribute('href', href)
    positionPreview(a)
    linkPreview.classList.add('show')
  }
  function positionPreview(a) {
    const rect = a.getBoundingClientRect() // chip CSS is translate(-50%,-100%): sits centered, above
    linkPreview.style.left = rect.left + rect.width / 2 + 'px'
    linkPreview.style.top = rect.top - 8 + 'px'
  }
  function hidePreview() {
    clearTimeout(lpHideTimer)
    // small delay so the mouse can travel from the link to the chip to click Edit
    lpHideTimer = setTimeout(() => { linkPreview.classList.remove('show'); lpAnchor = null }, 220)
  }
  function hidePreviewNow() {
    clearTimeout(lpHideTimer)
    linkPreview.classList.remove('show')
    lpAnchor = null
  }

  // caret inside a link → show; caret left the link → hide.
  // Hover deliberately does NOT show the chip: a click opens the link (main.js's
  // handleClick), so pointing at one has no side effect at all. The chip is the *editing*
  // affordance — it appears once the caret is actually inside the link (modifier-click,
  // arrow keys, or a drag-selection), and its Edit button opens the URL popover.
  editor.on('selectionUpdate', () => {
    const a = anchorAtSelection()
    if (a) showPreview(a)
    else if (lpAnchor) hidePreview()
  })

  // keep the chip alive while the pointer is on it (so Edit stays clickable)
  linkPreview.addEventListener('mouseenter', () => clearTimeout(lpHideTimer))
  linkPreview.addEventListener('mouseleave', () => hidePreview())

  // Edit → select the link's whole range, then open the popover on it.
  $('linkPreviewEdit').addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!lpAnchor) return
    const pos = editor.view.posAtDOM(lpAnchor.firstChild || lpAnchor, 0)
    const range = linkType && getMarkRange(editor.state.doc.resolve(pos), linkType)
    editor.chain().focus().setTextSelection(range || pos).run()
    hidePreviewNow()
    openLinkPop()
  })

  // Anchored-once popover/chip drift on scroll: close the editor, re-anchor the chip.
  $('scrollArea')?.addEventListener('scroll', () => {
    if (isPopOpen()) closeLinkPop()
    if (lpAnchor && linkPreview.classList.contains('show')) positionPreview(lpAnchor)
  }, { passive: true })

  // expose for verification
  return { openLinkPop, closeLinkPop, normalizeHref }
}
