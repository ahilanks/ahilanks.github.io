/* toc.js — minimal "Contents" panel pinned to the top-left of the write view.
 *
 * Lists the doc's H2s (numbered §1, §2, …), H3s and H4s (indented, unnumbered),
 * live-updating as you write. Sub-entries are progressively disclosed: H3s appear only
 * while the caret/viewport is inside their parent section, H4s only inside their parent
 * sub-section. Clicking an entry scrolls #scrollArea to that heading; the entry nearest
 * the top of the viewport is highlighted (bold + dark bar over the list's left rule).
 * The panel hides itself when the doc has no headings, when the surface is hidden
 * (source view), and below 1250px viewport width (CSS) where it would overlap the text.
 *
 * Heading DOM nodes are re-queried on every use rather than cached: ProseMirror is free
 * to replace them on any transaction, so stored references go stale.
 */

import { $, debounce } from './dom.js'

export function setupToc(editor) {
  const scroll = $('scrollArea')
  const surface = $('surface')

  const panel = document.createElement('nav')
  panel.className = 'toc-panel'
  panel.setAttribute('aria-label', 'Contents')
  panel.hidden = true
  panel.innerHTML = '<div class="toc-label">Contents</div><div class="toc-list"></div>'
  document.body.appendChild(panel)
  const list = panel.querySelector('.toc-list')

  const headings = () => Array.from(editor.view.dom.querySelectorAll('h2, h3, h4'))

  let items = [] // [{ btn, index, depth, parentSec, parentSub }] — index into headings() at interaction time

  function refresh() {
    // mirror the surface's writing font so the panel reads as part of the page
    panel.classList.remove('font-serif', 'font-sans', 'font-mono')
    const font = Array.from(surface.classList).find((c) => c.startsWith('font-'))
    if (font) panel.classList.add(font)

    list.textContent = ''
    items = []
    const entries = []
    headings().forEach((h, i) => {
      const text = (h.textContent || '').trim()
      if (text) entries.push({ i, text, lvl: +h.tagName[1] })
    })
    // Depth comes from the distinct levels actually used (a doc written all in H3s still
    // gets §-numbered sections; H4s directly under H2s still nest one step). Depth 0 is
    // the numbered section level; 1 and 2 are indented sub-entries whose visibility
    // updateActive() gates on the section/sub-section currently being read.
    const lvls = Array.from(new Set(entries.map((e) => e.lvl))).sort()
    let secN = 0
    let curSec = null; let curSub = null
    entries.forEach((e) => {
      const depth = lvls.indexOf(e.lvl)
      if (depth === 0) secN++
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'toc-item lvl-' + (depth + 2)
      b.textContent = depth === 0 ? '§' + secN + ' · ' + e.text : e.text
      b.addEventListener('mousedown', (ev) => ev.preventDefault()) // don't steal editor focus
      b.addEventListener('click', () => { pinnedIdx = e.i; scrollToHeading(e.i); updateActive() })
      list.appendChild(b)
      const it = { btn: b, index: e.i, depth, parentSec: null, parentSub: null }
      if (depth === 0) { curSec = it; curSub = null }
      else if (depth === 1) { it.parentSec = curSec; curSub = it }
      else { it.parentSec = curSec; it.parentSub = curSub }
      items.push(it)
    })
    panel.hidden = items.length === 0 || surface.hidden
    updateActive()
  }

  function scrollToHeading(i) {
    const h = headings()[i]
    if (!h) return
    const top = h.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    scroll.scrollTo({ top: Math.max(0, top - 90), behavior: 'smooth' })
  }

  let pinnedIdx = -1 // headings() index held open by a TOC click, until the caret moves

  // headings() index of the nearest heading at/above the caret, or -1
  function caretHeadingIndex() {
    const sel = editor.state.selection
    let idx = -1; let count = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && node.attrs.level <= 4) {
        if (pos <= sel.from) idx = count
        count++
      }
    })
    return idx
  }

  const chainOf = (it) => ({
    sec: it.depth === 0 ? it : it.parentSec,
    sub: it.depth === 1 ? it : it.parentSub,
  })
  const itemAt = (hIdx) => { // last TOC item at/above this headings() index
    let found = null
    items.forEach((it) => { if (it.index <= hIdx) found = it })
    return found
  }

  function updateActive() {
    if (panel.hidden || !items.length) return
    const hs = headings()
    const refY = scroll.getBoundingClientRect().top + 100
    let active = 0
    items.forEach((it, k) => {
      const h = hs[it.index]
      if (h && h.getBoundingClientRect().top <= refY) active = k
    })
    // Progressive disclosure: subs show only inside an OPEN section, sub-subs only inside
    // an open sub-section (entries with no parent are always shown). Open means: being
    // read (scroll position), holding the caret (clicked/typed in the text), or last
    // clicked in the panel — scroll alone can't always bring a heading to the top of a
    // short doc, so selection has to count too.
    const chains = [chainOf(items[active])]
    ;[caretHeadingIndex(), pinnedIdx].forEach((hIdx) => {
      if (hIdx < 0) return
      const it = itemAt(hIdx)
      if (it) chains.push(chainOf(it))
    })
    const secs = new Set(chains.map((c) => c.sec).filter(Boolean))
    const subs = new Set(chains.map((c) => c.sub).filter(Boolean))
    items.forEach((it, k) => {
      it.btn.classList.toggle('active', k === active)
      let show = true
      if (it.depth === 1) show = !it.parentSec || secs.has(it.parentSec)
      else if (it.depth === 2) {
        show = (!it.parentSec || secs.has(it.parentSec)) && (!it.parentSub || subs.has(it.parentSub))
      }
      it.btn.classList.toggle('toc-collapsed', !show)
    })
  }

  let raf = 0
  scroll.addEventListener('scroll', () => {
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; updateActive() })
  }, { passive: true })

  editor.on('update', debounce(refresh, 250))
  // moving the caret discloses the section/sub-section it lands in (and releases a pin)
  editor.on('selectionUpdate', debounce(() => { pinnedIdx = -1; updateActive() }, 80))
  refresh()

  return { refresh }
}
