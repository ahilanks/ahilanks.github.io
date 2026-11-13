/* canvas.js — a free-layout panel: boxes (text, quotes, images) dragged anywhere on it,
 * resized from a corner, and snapped into line with the canvas and with each other.
 *
 * The panel itself sits beside the text wherever you drag it (left/width as % of the text
 * column; `dy` em below the top of the block it follows, so it moves with that line when the
 * text above changes). It takes no room in the flow. Click it and the toolbar's image, GIF,
 * quote, text (T), B and I act on it (activeCanvas); click the text and they're back to normal.
 *
 * Saved as <div class="canvas-block" data-h> holding one
 * <div class="cv-box cv-text|cv-quote|cv-image" data-x data-y [data-w] [data-fs]> per box,
 * in stacking order. All geometry is in units of 1% of the canvas width (CSS cqw), so the
 * whole canvas scales as one picture: the published page keeps the layout at any width.
 *   x, y  top-left corner        w   width (a text box without one is as wide as its lines)
 *   fs    text size              h   (canvas) height
 * Text boxes keep their lines as <div>s; an empty line (<div><br></div>) is a stanza break.
 */

import { Node, DOMSerializer, DOMParser, Fragment } from '../../vendor/lib.bundle.js'
import { toast } from '../dom.js'
import { storeGif } from '../figures.js'

const DEF_FS = 2.5 // ≈ the body text at the editor's full column width
const SNAP_PX = 6 // how close (on screen) an edge or centre has to come to click into line
const MIN_H = 8

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d }
const r2 = (n) => Math.round(n * 100) / 100
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const copy = (boxes) => (boxes || []).map((b) => ({ ...b }))

// The text a box may hold: lines and inline formatting, nothing else.
const TEXT_TAGS = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'SPAN', 'SUP', 'SUB'])
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'VIDEO', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON'])
export function cleanBoxHtml(html) {
  const d = document.createElement('div')
  d.innerHTML = html || ''
  d.querySelectorAll('*').forEach((el) => {
    if (!d.contains(el)) return
    if (DROP_TAGS.has(el.tagName)) { el.remove(); return }
    if (!TEXT_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); return }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase()
      const keep = (el.tagName === 'A' && n === 'href' && !/^\s*(javascript|vbscript|data):/i.test(a.value)) ||
        (el.tagName === 'SPAN' && (n === 'data-tex' || (n === 'class' && a.value === 'math-inline')))
      if (!keep) el.removeAttribute(a.name)
    }
  })
  return d.innerHTML
}

function readBoxes(el) {
  return Array.from(el.children).filter((c) => c.classList.contains('cv-box')).map((c) => {
    const k = c.classList.contains('cv-image') ? 'image' : c.classList.contains('cv-quote') ? 'quote' : 'text'
    const b = { k, x: num(c.dataset.x, 5), y: num(c.dataset.y, 5), w: c.dataset.w ? num(c.dataset.w, null) : null }
    if (k === 'image') {
      const img = c.querySelector('img')
      b.src = (img && img.getAttribute('src')) || ''
      if (b.w == null) b.w = 40
    } else {
      b.fs = num(c.dataset.fs, DEF_FS)
      b.html = cleanBoxHtml(c.innerHTML)
    }
    return b
  }).filter((b) => (b.k === 'image' ? b.src : true))
}

// A box's saved element (no layout styles: the editor and the publisher add those).
function boxEl(b) {
  const el = document.createElement('div')
  el.className = 'cv-box cv-' + b.k
  el.dataset.x = b.x
  el.dataset.y = b.y
  if (b.w != null) el.dataset.w = b.w
  if (b.k === 'image') {
    const img = document.createElement('img')
    img.src = b.src
    img.alt = ''
    el.append(img)
  } else {
    el.dataset.fs = b.fs
    el.innerHTML = b.html || ''
  }
  return el
}
const cq = (n) => 'calc(' + n + ' * 1cqw)'
function place(el, b) {
  el.style.left = cq(b.x)
  el.style.top = cq(b.y)
  el.style.width = b.w != null ? cq(b.w) : ''
  if (b.k !== 'image') el.style.fontSize = cq(b.fs)
}

/* Runs INSIDE the published article: puts each canvas panel beside the line it hangs from.
   On a narrow screen (or without this script) a panel sits under that line at full width. */
export function canvasPlace() {
  var items = [].slice.call(document.querySelectorAll('.canvas-item'))
  if (!items.length) return
  function place() {
    var wide = window.matchMedia('(min-width: 760px)').matches
    items.forEach(function (it) {
      var c = it.firstElementChild
      if (!c) return
      if (!wide) { c.style.top = ''; return }
      var a = it.previousElementSibling
      while (a && (a.classList.contains('canvas-item') || a.classList.contains('poem-date'))) a = a.previousElementSibling
      var em = parseFloat(getComputedStyle(it).fontSize) || 16
      var off = a ? a.getBoundingClientRect().top - it.getBoundingClientRect().top : 0
      c.style.top = (off + (parseFloat(it.getAttribute('data-dy')) || 0) * em) + 'px'
    })
  }
  place()
  addEventListener('resize', place)
  addEventListener('load', place)
  if (document.fonts) document.fonts.ready.then(place)
}

/* Shared by the editor and the published page. */
export const CANVAS_CSS =
  '.canvas-block { position:relative; container-type:inline-size; width:100%; max-width:772px; margin:1.8rem auto; }\n' +
  '.canvas-item { position:relative; height:0; }\n' +
  '.canvas-item > .canvas-block { position:absolute; margin:0; max-width:none; }\n' +
  '.cv-box { position:absolute; box-sizing:border-box; line-height:1.42; }\n' +
  '.cv-text, .cv-quote { width:max-content; }\n' +
  '.cv-box p { margin:0; }\n' +
  '.cv-quote { font-style:italic; padding-left:0.8em; border-left:3px solid #e8743b; }\n' +
  '.cv-image img { display:block; width:100%; height:auto; border-radius:6px; }\n' +
  '@media (max-width: 759px) { .canvas-item { height:auto; margin:1.2rem 0; } .canvas-item > .canvas-block { position:relative; left:0 !important; top:0 !important; width:100% !important; } }\n'

/* Publish: the saved data-* geometry (kept through the sanitiser) → inline styles. */
export function canvasForPublish(root) {
  root.querySelectorAll('div.canvas-block').forEach((c) => {
    const h = clamp(num(c.getAttribute('data-h'), 50), MIN_H, 2000)
    c.removeAttribute('data-h')
    let style = 'aspect-ratio:100 / ' + h + ';'
    // a panel beside the text: hung from the block before it (the page's canvasPlace script)
    if (c.hasAttribute('data-left')) {
      const left = clamp(num(c.getAttribute('data-left'), 55), -60, 150)
      const width = clamp(num(c.getAttribute('data-width'), 42), 12, 160)
      const dy = clamp(num(c.getAttribute('data-dy'), 0), -500, 5000)
      style += 'left:' + left + '%;width:' + width + '%;'
      const item = document.createElement('div')
      item.className = 'canvas-item'
      item.setAttribute('data-dy', String(dy))
      c.replaceWith(item)
      item.append(c)
    }
    ;['data-left', 'data-width', 'data-dy'].forEach((a) => c.removeAttribute(a))
    c.setAttribute('style', style)
    Array.from(c.children).forEach((bx) => {
      if (!bx.classList.contains('cv-box')) { bx.remove(); return }
      const g = (k, lo, hi) => { const v = bx.getAttribute('data-' + k); bx.removeAttribute('data-' + k); return v == null ? null : clamp(num(v, 0), lo, hi) }
      const x = g('x', -200, 300), y = g('y', -200, 3000), w = g('w', 1, 400), fs = g('fs', 0.3, 40)
      bx.setAttribute('style', 'left:' + cq(x || 0) + ';top:' + cq(y || 0) + ';' +
        (w != null ? 'width:' + cq(w) + ';' : '') + (fs != null && !bx.classList.contains('cv-image') ? 'font-size:' + cq(fs) + ';' : ''))
    })
  })
}

/* The open canvas views, and the one the toolbar adds to (the last one clicked). */
const views = new Set()
let active = null
let activateNext = false // the next canvas view to be built (a new or moved canvas) is the active one
export function activeCanvas() {
  return active && active.dom.isConnected ? active : null
}
function setActive(v) {
  if (active === v) return
  if (active) active.deactivate()
  active = v
  document.body.classList.toggle('canvas-active', !!v)
}
// clicking anywhere but a canvas or the toolbar (and its popovers) hands the toolbar back to the text
document.addEventListener('pointerdown', (e) => {
  if (!active || !e.target.closest) return
  if (e.target.closest('.canvas-block.cv-edit, .topbar, .popover, input[type=file]')) return
  setActive(null)
}, true)

// Re-place every panel next to its line (after edits, resizes, fonts and images loading).
let placeQueued = false
export function placeCanvases() {
  if (placeQueued) return
  placeQueued = true
  requestAnimationFrame(() => { placeQueued = false; views.forEach((v) => v.place()) })
}
window.addEventListener('resize', placeCanvases)
if (document.fonts) document.fonts.ready.then(placeCanvases)

// The block a panel hangs from: the one before it, past other panels and editor-only widgets.
const SKIP = '.canvas-item, .poem-date-w, .ProseMirror-widget, .poem-date'
function anchorOf(el) {
  let a = el.previousElementSibling
  while (a && a.matches(SKIP)) a = a.previousElementSibling
  return a
}

let cssAdded = false
function addCss() {
  if (cssAdded) return
  cssAdded = true
  const s = document.createElement('style')
  s.textContent = CANVAS_CSS
  document.head.append(s)
}

function canvasView({ node, editor, getPos, extension }) {
  addCss()
  let boxes = copy(node.attrs.boxes)
  let h = node.attrs.h
  let sel = -1 // the selected box
  let editing = -1 // the text box being typed in

  const outer = document.createElement('div') // where it sits in the text: no height of its own
  outer.className = 'canvas-item'
  outer.contentEditable = 'false'
  const dom = document.createElement('div') // the panel
  dom.className = 'canvas-block cv-edit'
  outer.append(dom)
  let pos = { left: node.attrs.left, width: node.attrs.width, dy: node.attrs.dy }
  const legacy = () => pos.left == null // from before canvases were panels: an ordinary block
  const layer = document.createElement('div')
  layer.className = 'cv-layer'
  layer.tabIndex = -1
  const guides = document.createElement('div')
  guides.className = 'cv-guides'

  const del = document.createElement('button')
  del.type = 'button'; del.className = 'cv-del'; del.textContent = '×'; del.title = 'Delete this canvas'
  del.addEventListener('mousedown', (e) => e.preventDefault())
  del.addEventListener('click', (e) => {
    e.preventDefault()
    const at = getPos()
    if (typeof at === 'number') { setActive(null); editor.view.dispatch(editor.state.tr.delete(at, at + node.nodeSize)) }
  })
  const wgrip = document.createElement('div')
  wgrip.className = 'cv-wgrip'
  wgrip.title = 'Drag to make the canvas wider or narrower (everything on it scales)'

  const grip = document.createElement('div')
  grip.className = 'cv-hgrip'
  grip.title = 'Drag to change the canvas height'

  const pick = document.createElement('input')
  pick.type = 'file'; pick.accept = 'image/*'; pick.multiple = true; pick.hidden = true
  pick.addEventListener('change', () => { addImages(Array.from(pick.files || []), null); pick.value = '' })

  dom.append(layer, guides, grip, wgrip, del, pick)

  const unit = () => (dom.clientWidth || 772) / 100
  const boxElAt = (i) => layer.children[i]

  function render() {
    layer.textContent = ''
    boxes.forEach((b, i) => {
      const el = boxEl(b)
      place(el, b)
      el.dataset.i = i
      if (b.k === 'image') el.querySelector('img').addEventListener('load', () => fit(false))
      layer.append(el)
    })
    if (sel >= boxes.length) sel = -1
    select(sel)
    dom.style.aspectRatio = '100 / ' + Math.max(h || 0, MIN_H)
  }

  function select(i) {
    sel = i
    Array.from(layer.children).forEach((el, j) => {
      el.classList.toggle('sel', j === i)
      el.querySelectorAll(':scope > .cv-handle').forEach((x) => x.remove())
    })
    const el = i >= 0 && boxElAt(i)
    if (el) {
      const se = document.createElement('div')
      se.className = 'cv-handle se'; se.dataset.h = 'se'
      se.title = boxes[i].k === 'image' ? 'Drag to resize' : 'Drag to make the text bigger or smaller'
      el.append(se)
      if (boxes[i].k !== 'image') {
        const e = document.createElement('div')
        e.className = 'cv-handle e'; e.dataset.h = 'e'
        e.title = 'Drag to set where lines wrap (double-click: no wrapping)'
        el.append(e)
      }
    }
    dom.classList.toggle('has-sel', !!el)
  }

  const panelAttrs = () => (legacy() ? {} : { left: pos.left, width: pos.width, dy: pos.dy })
  function commit(history = true) {
    const pos = getPos()
    if (typeof pos !== 'number') return
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, boxes: copy(boxes), h, ...panelAttrs() })
    if (!history) tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
  }

  // the lowest box bottom, in canvas units (measured: text height depends on its lines)
  function contentBottom() {
    const u = unit()
    let bottom = 0
    boxes.forEach((b, i) => { const el = boxElAt(i); if (el) bottom = Math.max(bottom, b.y + el.offsetHeight / u) })
    return bottom
  }
  // grow the canvas to hold every box (or, `exact`, fit it to them)
  function fit(history = true, exact = false) {
    if (!dom.isConnected || !dom.clientWidth) return false
    const need = Math.ceil(contentBottom() + 3)
    const next = exact ? Math.max(need, MIN_H) : Math.max(h || 0, need, MIN_H)
    if (next === h) return false
    h = next
    dom.style.aspectRatio = '100 / ' + h
    commit(history)
    return true
  }

  function freeY() { return boxes.length ? r2(contentBottom() + 2) : 4 }
  // where something new goes: the middle of the part of the canvas you can see
  function spot() {
    const r = dom.getBoundingClientRect(), u = unit()
    const top = Math.max(r.top, 60), bottom = Math.min(r.bottom, window.innerHeight)
    if (bottom - top < 40 || (r.top >= 60 && r.bottom <= window.innerHeight)) return { x: 30, y: freeY() } // all in view: below what's there
    return { x: 30, y: r2(Math.max(0, ((top + bottom) / 2 - r.top) / u - 4)) }
  }
  let lastDrop = null // the canvas point a file is being dragged over (its drop lands there)

  function addText(k) {
    if (editing >= 0) finishEdit()
    const at = spot()
    // text the size of the article's, whatever the panel's width
    const fs = legacy() ? DEF_FS : r2(clamp(DEF_FS * (outer.clientWidth || 772) / (dom.clientWidth || 772), 1, 20))
    const b = { k, x: 8, y: at.y, w: k === 'quote' ? 80 : null, fs, html: '<div>' + (k === 'quote' ? 'A quote' : 'Text') + '</div>' }
    boxes.push(b)
    sel = boxes.length - 1
    render()
    fit(true)
    commit()
    startEdit(boxes.length - 1, null, true)
  }

  function addImageSrc(src) {
    const dropped = lastDrop && Date.now() - lastDrop.t < 3000
    const at = dropped ? { x: r2(clamp(lastDrop.x - 15, 0, 70)), y: r2(Math.max(0, lastDrop.y - 5)) } : spot()
    lastDrop = null
    boxes.push({ k: 'image', x: dropped ? at.x : 8, y: at.y, w: legacy() ? 30 : dropped ? 50 : 70, src })
    sel = boxes.length - 1
    render()
    commit()
  }

  async function addImages(files, at) {
    const draftId = extension.options.getDocId && extension.options.getDocId()
    let y = at ? at.y : null
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > 300 * 1024) toast('Adding image…')
      let src
      try { src = await storeGif(draftId, { file }) } catch (e) { toast(e.message || "Couldn't save the image"); continue }
      boxes.push({ k: 'image', x: at ? r2(clamp(at.x - 15, 0, 70)) : 30, y: y != null ? r2(Math.max(0, y)) : freeY(), w: 30, src })
      if (y != null) y += 4
      sel = boxes.length - 1
      render()
      commit()
    }
  }

  function removeBox(i) {
    if (i < 0 || i >= boxes.length) return
    boxes.splice(i, 1)
    sel = -1
    render()
    commit()
  }

  function restack(dir) {
    if (sel < 0) return
    const [b] = boxes.splice(sel, 1)
    if (dir > 0) boxes.push(b); else boxes.unshift(b)
    sel = dir > 0 ? boxes.length - 1 : 0
    render()
    commit()
  }

  /* ── typing in a text box ── */
  function startEdit(i, e, selectAll) {
    const b = boxes[i]
    if (!b || b.k === 'image' || !editor.isEditable) return
    editing = i
    select(i)
    const el = boxElAt(i)
    el.querySelectorAll(':scope > .cv-handle').forEach((x) => x.remove())
    el.contentEditable = 'true'
    el.classList.add('editing')
    el.focus({ preventScroll: true })
    const s = getSelection()
    let r = null
    if (selectAll) { r = document.createRange(); r.selectNodeContents(el) }
    else if (e && document.caretRangeFromPoint) r = document.caretRangeFromPoint(e.clientX, e.clientY)
    if (r && el.contains(r.startContainer)) { s.removeAllRanges(); s.addRange(r) }
    el.addEventListener('blur', finishEdit, { once: true })
  }
  function finishEdit() {
    if (editing < 0) return
    const i = editing
    const el = boxElAt(i), b = boxes[i]
    editing = -1
    if (!el || !b) return
    el.contentEditable = 'false'
    el.classList.remove('editing')
    if (!el.textContent.trim()) { removeBox(i); return }
    const html = cleanBoxHtml(el.innerHTML.replace(/<div class="cv-handle[^>]*><\/div>/g, ''))
    if (html !== b.html) { b.html = html; render(); fit(true); commit() } else select(i)
  }

  /* ── dragging: move, resize, snap ── */
  function snapTargets(skip) {
    const u = unit()
    const xs = [0, 50, 100], ys = [0, (h || 0) / 2, h || 0]
    boxes.forEach((b, j) => {
      if (j === skip) return
      const el = boxElAt(j)
      if (!el) return
      const w = el.offsetWidth / u, hh = el.offsetHeight / u
      xs.push(b.x, b.x + w / 2, b.x + w)
      ys.push(b.y, b.y + hh / 2, b.y + hh)
    })
    return { xs, ys }
  }
  // the smallest nudge that puts one of `points` on one of `targets`, within `thr`
  function snap1(points, targets, thr) {
    let best = null
    for (const p of points) for (const t of targets) {
      const d = t - p
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t }
    }
    return best
  }
  let shown = ''
  function showGuides(list) {
    const key = list.map((g) => (g.v ? 'v' : 'h') + r2(g.at)).join('|')
    if (key === shown) return
    const clicked = list.length && key !== shown
    shown = key
    guides.textContent = ''
    for (const g of list) {
      const l = document.createElement('div')
      l.className = 'cv-guide ' + (g.v ? 'v' : 'h') + (clicked ? ' click' : '')
      if (g.v) l.style.left = cq(g.at); else l.style.top = cq(g.at)
      guides.append(l)
    }
  }

  layer.addEventListener('pointerdown', (e) => {
    if (!editor.isEditable || e.button !== 0) return
    const boxElm = e.target.closest('.cv-box')
    setActive(api)
    if (!boxElm) { if (editing >= 0) finishEdit(); select(-1); layer.focus({ preventScroll: true }); movePanel(e); return }
    const i = +boxElm.dataset.i
    if (i === editing) return // placing the caret / selecting text
    if (editing >= 0) finishEdit()
    e.preventDefault()
    const handle = e.target.closest('.cv-handle')
    if (sel !== i) select(i)
    layer.focus({ preventScroll: true })
    const el = boxElAt(i), b = boxes[i]
    const u = unit(), sx = e.clientX, sy = e.clientY
    const start = { ...b }
    const size = { w: el.offsetWidth / u, h: el.offsetHeight / u }
    const mode = handle ? handle.dataset.h : 'move'
    const targets = snapTargets(i)
    let moved = false
    el.setPointerCapture(e.pointerId)
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return
      moved = true
      dom.classList.add('dragging')
      const dx = (ev.clientX - sx) / u, dy = (ev.clientY - sy) / u
      const thr = ev.altKey ? -1 : SNAP_PX / u // hold ⌥ to place freely
      const lines = []
      if (mode === 'move') {
        let x = start.x + dx, y = start.y + dy
        const a = snap1([x, x + size.w / 2, x + size.w], targets.xs, thr)
        if (a) { x += a.d; lines.push({ v: true, at: a.t }) }
        const c = snap1([y, y + size.h / 2, y + size.h], targets.ys, thr)
        if (c) { y += c.d; lines.push({ v: false, at: c.t }) }
        b.x = r2(clamp(x, 2 - size.w, 98))
        b.y = r2(Math.max(0, y))
      } else {
        let w = Math.max(mode === 'e' ? 6 : 2, size.w + dx)
        const a = snap1([start.x + w], targets.xs, thr)
        if (a) { w += a.d; lines.push({ v: true, at: a.t }) }
        if (mode === 'e') b.w = r2(w)
        else if (b.k === 'image') b.w = r2(w)
        else {
          const k = w / size.w
          b.fs = r2(clamp(start.fs * k, 0.6, 30))
          if (start.w != null) b.w = r2(start.w * k)
        }
      }
      place(el, b)
      showGuides(lines)
      const bottom = b.y + el.offsetHeight / u
      if (bottom + 3 > h) { h = Math.ceil(bottom + 3); dom.style.aspectRatio = '100 / ' + h }
    }
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      dom.classList.remove('dragging')
      showGuides([])
      if (moved) { fit(true); commit() }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  })

  layer.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('.cv-handle')
    const boxElm = e.target.closest('.cv-box')
    if (!boxElm) return
    const i = +boxElm.dataset.i
    if (handle && handle.dataset.h === 'e') { boxes[i].w = null; render(); commit(); return }
    if (i !== editing) startEdit(i, e)
  })

  layer.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey
    if (editing >= 0) {
      const k = e.key.toLowerCase()
      if (meta && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault(); e.stopPropagation()
        document.execCommand(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline')
      } else if (meta && k === 'a') { // the box's text, not the whole article
        e.preventDefault(); e.stopPropagation()
        const r = document.createRange(); r.selectNodeContents(boxElAt(editing))
        const s = getSelection(); s.removeAllRanges(); s.addRange(r)
      } else if (e.key === 'Escape') { e.preventDefault(); boxElAt(editing).blur() }
      return
    }
    if (sel < 0 || meta) return
    const b = boxes[sel]
    const step = e.shiftKey ? 2 : 0.25
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (nudge) {
      e.preventDefault()
      b.x = r2(b.x + nudge[0]); b.y = r2(Math.max(0, b.y + nudge[1]))
      place(boxElAt(sel), b)
      clearTimeout(nudgeT); nudgeT = setTimeout(() => { fit(true); commit() }, 400)
    } else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeBox(sel) }
    else if (e.key === 'Enter' && b.k !== 'image') { e.preventDefault(); startEdit(sel, null, true) }
    else if (e.key === 'Escape') { e.preventDefault(); select(-1) }
  })
  let nudgeT = 0

  /* ── the canvas height ── */
  grip.addEventListener('pointerdown', (e) => {
    if (!editor.isEditable || e.button !== 0) return
    e.preventDefault()
    const u = unit(), sy = e.clientY, h0 = h, floor = Math.max(MIN_H, Math.ceil(contentBottom() + 1))
    grip.setPointerCapture(e.pointerId)
    const onMove = (ev) => { h = Math.max(floor, Math.round(h0 + (ev.clientY - sy) / u)); dom.style.aspectRatio = '100 / ' + h }
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      if (h !== h0) commit()
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  })

  /* ── drop image files onto the canvas ── */
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
  dom.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault(); dom.classList.add('drop')
    const r = dom.getBoundingClientRect(), u = unit()
    lastDrop = { x: (e.clientX - r.left) / u, y: (e.clientY - r.top) / u, t: Date.now() }
  })
  dom.addEventListener('dragleave', () => dom.classList.remove('drop'))
  dom.addEventListener('drop', (e) => {
    dom.classList.remove('drop')
    if (!hasFiles(e)) return
    e.preventDefault(); e.stopPropagation()
    const r = dom.getBoundingClientRect(), u = unit()
    addImages(Array.from(e.dataTransfer.files), { x: (e.clientX - r.left) / u, y: (e.clientY - r.top) / u })
  })

  /* ── the panel: where it sits beside the text ── */
  const em = () => parseFloat(getComputedStyle(outer).fontSize) || 16
  function placePanel() {
    if (legacy()) { outer.classList.add('cv-static'); return }
    const a = anchorOf(outer)
    const off = a ? a.getBoundingClientRect().top - outer.getBoundingClientRect().top : 0
    dom.style.left = pos.left + '%'
    dom.style.width = pos.width + '%'
    dom.style.top = (off + pos.dy * em()) + 'px'
  }
  // the article's own blocks (not panels), top to bottom: { at (doc pos after it), rect }
  function blocks() {
    const out = []
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === 'canvas') return
      const d = editor.view.nodeDOM(off)
      if (d && d.getBoundingClientRect) out.push({ at: off + n.nodeSize, rect: d.getBoundingClientRect() })
    })
    return out
  }
  const fixedGuides = document.createElement('div')
  fixedGuides.className = 'cv-fixed-guides'
  function showFixed(list) {
    if (!fixedGuides.isConnected) document.body.append(fixedGuides)
    fixedGuides.textContent = ''
    for (const g of list) {
      const l = document.createElement('div')
      l.className = 'cv-guide ' + (g.v ? 'v' : 'h')
      if (g.v) { l.style.left = g.at + 'px'; l.style.top = g.from + 'px'; l.style.height = (g.to - g.from) + 'px' }
      else { l.style.top = g.at + 'px'; l.style.left = g.from + 'px'; l.style.width = (g.to - g.from) + 'px' }
      fixedGuides.append(l)
    }
  }
  // drag the panel by its empty space: snaps its edges or centre to the column's, its top to a line's
  function movePanel(e) {
    if (legacy()) return
    const sx = e.clientX, sy = e.clientY
    const col = outer.getBoundingClientRect()
    const r0 = dom.getBoundingClientRect()
    const lines = blocks()
    let moved = false, top = r0.top
    dom.setPointerCapture(e.pointerId)
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved = true
      dom.classList.add('moving')
      const thr = ev.altKey ? -1 : SNAP_PX
      let left = r0.left + ev.clientX - sx
      top = r0.top + ev.clientY - sy
      const g = []
      const xs = [col.left, col.left + col.width / 2, col.right]
      for (const v of views) if (v !== api && v.dom.isConnected && !v.legacy()) { const r = v.dom.getBoundingClientRect(); xs.push(r.left, r.left + r.width / 2, r.right) }
      const a = snap1([left, left + r0.width / 2, left + r0.width], xs, thr)
      if (a) { left += a.d; g.push({ v: true, at: a.t, from: Math.min(top, col.top) - 20, to: top + r0.height + 20 }) }
      const ys = []
      lines.forEach((l) => ys.push(l.rect.top))
      const c = snap1([top], ys, thr)
      if (c) { top += c.d; g.push({ v: false, at: c.t, from: Math.min(left, col.left) - 20, to: Math.max(left + r0.width, col.right) + 20 }) }
      pos.left = r2(clamp(((left - col.left) / col.width) * 100, -60, 150))
      dom.style.left = pos.left + '%'
      dom.style.top = (top - outer.getBoundingClientRect().top) + 'px'
      showFixed(g)
    }
    const onUp = () => {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerup', onUp)
      dom.removeEventListener('pointercancel', onUp)
      dom.classList.remove('moving')
      fixedGuides.remove()
      if (moved) settle(top)
    }
    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerup', onUp)
    dom.addEventListener('pointercancel', onUp)
  }
  // after a move: hang the panel from the block its top is beside, so it travels with that line
  function settle(top) {
    const lines = blocks()
    if (!lines.length) return
    let anchor = lines[0]
    for (const l of lines) if (l.rect.top <= top + 1) anchor = l
    pos.dy = r2((top - anchor.rect.top) / em())
    const at = getPos()
    if (typeof at !== 'number') return
    const attrs = { ...node.attrs, boxes: copy(boxes), h, ...panelAttrs() }
    if (at === anchor.at) { commit(); return }
    const tr = editor.state.tr.delete(at, at + node.nodeSize)
    tr.insert(tr.mapping.map(anchor.at), node.type.create(attrs))
    activateNext = true
    editor.view.dispatch(tr)
  }
  // the corner grip: the panel's width (what's on it scales with it)
  wgrip.addEventListener('pointerdown', (e) => {
    if (!editor.isEditable || e.button !== 0 || legacy()) return
    e.preventDefault(); e.stopPropagation()
    setActive(api)
    const sx = e.clientX, w0 = pos.width, colW = outer.clientWidth || 772
    wgrip.setPointerCapture(e.pointerId)
    const onMove = (ev) => { pos.width = r2(clamp(w0 + ((ev.clientX - sx) / colW) * 100, 12, 160)); dom.style.width = pos.width + '%' }
    const onUp = () => {
      wgrip.removeEventListener('pointermove', onMove)
      wgrip.removeEventListener('pointerup', onUp)
      if (pos.width !== w0) commit()
    }
    wgrip.addEventListener('pointermove', onMove)
    wgrip.addEventListener('pointerup', onUp)
  })

  render()
  placePanel()
  if (!h) setTimeout(() => fit(false, true), 0)

  const api = {
    dom,
    addText,
    addImageSrc,
    place: placePanel,
    legacy,
    editing: () => editing >= 0,
    deactivate() { if (editing >= 0) finishEdit(); select(-1); dom.classList.remove('active') },
  }
  views.add(api)
  const activate = () => dom.classList.add('active')
  dom.addEventListener('pointerdown', () => { setActive(api); activate() })
  dom.addEventListener('dragover', () => { setActive(api); activate() })
  if (activateNext) { activateNext = false; setActive(api); activate() }

  return {
    dom: outer,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      pos = { left: next.attrs.left, width: next.attrs.width, dy: next.attrs.dy }
      if (editing >= 0) { placePanel(); return true } // typing; the box saves itself when you're done
      boxes = copy(next.attrs.boxes)
      h = next.attrs.h
      render()
      placePanel()
      return true
    },
    selectNode() { dom.classList.add('pm-selected') },
    deselectNode() { dom.classList.remove('pm-selected') },
    // undo/redo pass through to the editor while no box is being typed in
    stopEvent(e) {
      if (e.type === 'keydown' && editing < 0 && (e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key)) return false
      return true
    },
    ignoreMutation() { return true },
    destroy() { clearTimeout(nudgeT); views.delete(api); fixedGuides.remove(); if (active === api) setActive(null) },
  }
}

export const Canvas = Node.create({
  name: 'canvas',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() { return { getDocId: null } },
  // the boxes' words, for the word count (and anything else that reads the doc's text)
  extendNodeSchema(ext) {
    if (ext.name !== 'canvas') return {}
    return {
      leafText: (node) => (node.attrs.boxes || []).filter((b) => b.k !== 'image').map((b) => {
        const d = document.createElement('div')
        d.innerHTML = (b.html || '').replace(/<\/div>|<br>/g, ' ')
        return d.textContent
      }).join(' '),
    }
  },
  addAttributes() {
    return {
      h: { default: 50, parseHTML: (el) => num(el.getAttribute('data-h'), 50) },
      left: { default: null, parseHTML: (el) => (el.hasAttribute('data-left') ? num(el.getAttribute('data-left'), 55) : null) },
      width: { default: 42, parseHTML: (el) => num(el.getAttribute('data-width'), 42) },
      dy: { default: 0, parseHTML: (el) => num(el.getAttribute('data-dy'), 0) },
      boxes: { default: [], parseHTML: (el) => readBoxes(el) },
    }
  },
  parseHTML() { return [{ tag: 'div.canvas-block' }] },
  renderHTML({ node }) {
    const el = document.createElement('div')
    el.className = 'canvas-block'
    el.dataset.h = Math.round(node.attrs.h || 50)
    if (node.attrs.left != null) { el.dataset.left = node.attrs.left; el.dataset.width = node.attrs.width; el.dataset.dy = node.attrs.dy }
    for (const b of node.attrs.boxes || []) el.append(boxEl(b))
    return el
  },
  addNodeView() { return (props) => canvasView({ ...props, extension: this }) },
  onTransaction() { placeCanvases() },
  addCommands() {
    return {
      // A new, empty canvas beside the line the caret is on (right half of the column), active.
      insertCanvas: () => ({ state, dispatch }) => {
        const $at = state.selection.$from
        const at = $at.depth ? $at.after(1) : state.selection.from
        if (dispatch) {
          activateNext = true
          dispatch(state.tr.insert(at, this.type.create({ h: 60, boxes: [], left: 56, width: 42, dy: 0 })))
        }
        return true
      },
    }
  },
})

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TITLE_RE = /^<div><b>([\s\S]*)<\/b><\/div>$/

/* Canvases from before they were panels (a whole poem laid out as one, or an inline block)
   turn back into text, top to bottom, when their draft opens. */
export function canvasToDoc(editor) {
  const { state } = editor
  const parser = DOMParser.fromSchema(state.schema)
  const nodes = []
  let changed = false
  state.doc.forEach((n) => {
    if (n.type.name !== 'canvas' || n.attrs.left != null) { nodes.push(n); return }
    changed = true
    const boxes = [...(n.attrs.boxes || [])].sort((a, b) => a.y - b.y || a.x - b.x)
    const lines = (html) => {
      const d = document.createElement('div')
      d.innerHTML = html || ''
      const out = Array.from(d.childNodes).some((c) => c.nodeType === 1 && (c.tagName === 'DIV' || c.tagName === 'P'))
        ? Array.from(d.childNodes).map((c) => (c.nodeType === 1 && (c.tagName === 'DIV' || c.tagName === 'P') ? c.innerHTML.replace(/^<br>$/, '') : c.nodeType === 3 ? esc(c.textContent) : c.outerHTML))
        : [d.innerHTML]
      return out.map((l) => '<p>' + l + '</p>').join('')
    }
    let html = ''
    let heading = null // a title waiting to see whether a date box follows it
    const putHeading = () => {
      if (heading) html += '<h2' + (heading.date ? ' data-date="' + esc(heading.date) + '"' : '') + '>' + heading.html + '</h2>'
      heading = null
    }
    boxes.forEach((b) => {
      const m = b.k === 'text' && b.fs > DEF_FS * 1.2 && TITLE_RE.exec(b.html || '')
      if (m) { putHeading(); heading = { html: m[1] }; return }
      if (heading && !heading.date && b.k === 'text' && b.fs < DEF_FS * 0.9 && !/<div>[\s\S]*<div>/.test(b.html)) {
        const d = document.createElement('div'); d.innerHTML = b.html
        heading.date = d.textContent.trim(); return
      }
      putHeading()
      if (b.k === 'image') html += '<figure class="img-block"><img src="' + esc(b.src) + '"><figcaption></figcaption></figure>'
      else if (b.k === 'quote') html += '<blockquote>' + lines(b.html) + '</blockquote>'
      else html += lines(b.html) + '<p></p>'
    })
    putHeading()
    const d = document.createElement('div')
    d.innerHTML = html.replace(/(<p><\/p>)+$/, '') || '<p></p>'
    parser.parse(d).content.forEach((c) => nodes.push(c))
  })
  if (!changed) return false
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(nodes)).setMeta('addToHistory', false))
  return true
}
