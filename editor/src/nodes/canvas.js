/* canvas.js — a free-layout block: boxes (poem text, quotes, images) dragged anywhere on it,
 * resized from a corner, and snapped into line with the canvas and with each other.
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

/* Shared by the editor and the published page. */
export const CANVAS_CSS =
  '.canvas-block { position:relative; container-type:inline-size; width:100%; max-width:772px; margin:1.8rem auto; }\n' +
  '.cv-box { position:absolute; box-sizing:border-box; line-height:1.42; }\n' +
  '.cv-text, .cv-quote { width:max-content; }\n' +
  '.cv-box p { margin:0; }\n' +
  '.cv-quote { font-style:italic; padding-left:0.8em; border-left:3px solid #e8743b; }\n' +
  '.cv-image img { display:block; width:100%; height:auto; border-radius:6px; }\n'

/* Publish: the saved data-* geometry (kept through the sanitiser) → inline styles. */
export function canvasForPublish(root) {
  root.querySelectorAll('div.canvas-block').forEach((c) => {
    const h = clamp(num(c.getAttribute('data-h'), 50), MIN_H, 2000)
    c.removeAttribute('data-h')
    c.setAttribute('style', 'aspect-ratio:100 / ' + h + ';')
    Array.from(c.children).forEach((bx) => {
      if (!bx.classList.contains('cv-box')) { bx.remove(); return }
      const g = (k, lo, hi) => { const v = bx.getAttribute('data-' + k); bx.removeAttribute('data-' + k); return v == null ? null : clamp(num(v, 0), lo, hi) }
      const x = g('x', -200, 300), y = g('y', -200, 3000), w = g('w', 1, 400), fs = g('fs', 0.3, 40)
      bx.setAttribute('style', 'left:' + cq(x || 0) + ';top:' + cq(y || 0) + ';' +
        (w != null ? 'width:' + cq(w) + ';' : '') + (fs != null && !bx.classList.contains('cv-image') ? 'font-size:' + cq(fs) + ';' : ''))
    })
  })
}

/* The open canvas views. A poem laid out as a canvas (Style → Layout: Canvas, which puts
   body.poem-canvas on the page) is one canvas, and the toolbar adds to it (activeCanvas). */
const views = new Set()
export function activeCanvas() {
  if (!document.body.classList.contains('poem-canvas')) return null
  for (const v of views) if (v.dom.isConnected) return v
  return null
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

  const dom = document.createElement('div')
  dom.className = 'canvas-block cv-edit'
  dom.contentEditable = 'false'
  const layer = document.createElement('div')
  layer.className = 'cv-layer'
  layer.tabIndex = -1
  const guides = document.createElement('div')
  guides.className = 'cv-guides'

  const bar = document.createElement('div')
  bar.className = 'cv-bar'
  const mkBtn = (label, title, onClick) => {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = label; b.title = title
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => { e.preventDefault(); onClick() })
    bar.append(b)
    return b
  }
  const sep = () => { const s = document.createElement('span'); s.className = 'cv-sep'; bar.append(s) }
  mkBtn('+ Text', 'Add a text box', () => addText('text'))
  mkBtn('+ Quote', 'Add a quote box', () => addText('quote'))
  mkBtn('+ Image', 'Add an image (or drop image files onto the canvas)', () => pick.click())
  sep()
  const frontBtn = mkBtn('Front', 'Bring the selected box to the front', () => restack(1))
  const backBtn = mkBtn('Back', 'Send the selected box to the back', () => restack(-1))
  const delBtn = mkBtn('Delete', 'Delete the selected box (Backspace)', () => removeBox(sel))
  sep()
  mkBtn('Remove canvas', 'Delete this whole canvas', () => {
    const pos = getPos()
    if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
  })

  const grip = document.createElement('div')
  grip.className = 'cv-hgrip'
  grip.title = 'Drag to change the canvas height'

  const pick = document.createElement('input')
  pick.type = 'file'; pick.accept = 'image/*'; pick.multiple = true; pick.hidden = true
  pick.addEventListener('change', () => { addImages(Array.from(pick.files || []), null); pick.value = '' })

  dom.append(layer, guides, bar, grip, pick)

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
    frontBtn.disabled = backBtn.disabled = delBtn.disabled = !el
    dom.classList.toggle('has-sel', !!el)
  }

  function commit(history = true) {
    const pos = getPos()
    if (typeof pos !== 'number') return
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, boxes: copy(boxes), h })
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
    if (bottom - top < 40) return { x: 30, y: freeY() }
    return { x: 30, y: r2(Math.max(0, ((top + bottom) / 2 - r.top) / u - 4)) }
  }
  let lastDrop = null // the canvas point a file is being dragged over (its drop lands there)

  function addText(k) {
    if (editing >= 0) finishEdit()
    const at = full() ? spot() : { x: 6, y: freeY() }
    const b = { k, x: full() ? at.x : 6, y: at.y, w: k === 'quote' ? 50 : null, fs: DEF_FS, html: '<div>' + (k === 'quote' ? 'A quote' : 'Text') + '</div>' }
    boxes.push(b)
    sel = boxes.length - 1
    render()
    fit(true)
    commit()
    startEdit(boxes.length - 1, null, true)
  }

  function addImageSrc(src) {
    const at = lastDrop && Date.now() - lastDrop.t < 3000 ? { x: r2(clamp(lastDrop.x - 15, 0, 70)), y: r2(Math.max(0, lastDrop.y - 5)) } : spot()
    lastDrop = null
    boxes.push({ k: 'image', x: at.x, y: at.y, w: 30, src })
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
    if (!boxElm) { if (editing >= 0) finishEdit(); select(-1); layer.focus({ preventScroll: true }); return }
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

  const full = () => dom.classList.contains('cv-full') || (document.body.classList.contains('poem-canvas') && dom.isConnected)

  // A canvas just made from text starts at height 0: stack its boxes top to bottom in their
  // order (measured, once the images have loaded), then fit the canvas around them.
  async function stack() {
    await Promise.all(Array.from(layer.querySelectorAll('img')).map((i) => i.decode().catch(() => {})))
    if (!dom.isConnected) return
    const u = unit()
    let y = 4
    boxes.forEach((b, i) => {
      b.y = r2(y)
      const el = boxElAt(i)
      if (el) place(el, b)
      const next = boxes[i + 1]
      const title = b.k === 'text' && b.fs > DEF_FS * 1.2
      const dateNext = next && next.k === 'text' && next.fs < DEF_FS * 0.9
      y += (el ? el.offsetHeight / u : 5) + (title ? (dateNext ? 0.3 : 1.2) : b.fs < DEF_FS * 0.9 ? 1.6 : 5)
    })
    h = Math.ceil(y + (full() ? 12 : 0))
    dom.style.aspectRatio = '100 / ' + h
    commit(false)
  }

  render()
  if (!h) setTimeout(() => (boxes.length ? stack() : fit(false, true)), 0)

  const api = {
    dom,
    addText,
    addImageSrc,
    editing: () => editing >= 0,
  }
  views.add(api)

  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      if (editing >= 0) return true // typing; the box saves itself when you're done
      boxes = copy(next.attrs.boxes)
      h = next.attrs.h
      render()
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
    destroy() { clearTimeout(nudgeT); views.delete(api) },
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
      boxes: { default: [], parseHTML: (el) => readBoxes(el) },
    }
  },
  parseHTML() { return [{ tag: 'div.canvas-block' }] },
  renderHTML({ node }) {
    const el = document.createElement('div')
    el.className = 'canvas-block'
    el.dataset.h = Math.round(node.attrs.h || 50)
    for (const b of node.attrs.boxes || []) el.append(boxEl(b))
    return el
  },
  addNodeView() { return (props) => canvasView({ ...props, extension: this }) },
  addCommands() {
    return {
      // A canvas at the caret. With text selected, the selected lines become a text box on it
      // (and selected images, image boxes beside it).
      insertCanvas: () => ({ state, dispatch }) => {
        const { $from, $to, empty } = state.selection
        const boxes = []
        let range = null
        if (!empty) {
          range = $from.blockRange($to)
          const ser = DOMSerializer.fromSchema(state.schema)
          const lines = []
          let imgY = 3
          for (let i = range ? range.startIndex : 0; range && i < range.endIndex; i++) {
            const n = range.parent.child(i)
            if (n.isTextblock) {
              const d = document.createElement('div')
              d.append(ser.serializeFragment(n.content))
              lines.push('<div>' + (d.innerHTML || '<br>') + '</div>')
            } else if (n.type.name === 'figure' && n.attrs.mediaType !== 'video' && n.attrs.src) {
              boxes.push({ k: 'image', x: 58, y: imgY, w: 36, src: n.attrs.src }); imgY += 26
            } else { range = null; break } // something a canvas can't hold: leave the selection as it is
          }
          if (range && lines.length) boxes.unshift({ k: 'text', x: 4, y: 3, w: null, fs: DEF_FS, html: cleanBoxHtml(lines.join('')) })
          if (!range) boxes.length = 0
        }
        const canvas = this.type.create({ h: boxes.length ? 0 : 50, boxes })
        if (dispatch) {
          const tr = state.tr
          if (range && boxes.length) tr.replaceWith(range.start, range.end, canvas)
          else tr.replaceSelectionWith(canvas)
          dispatch(tr.scrollIntoView())
        }
        return true
      },
    }
  },
})

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TITLE_RE = /^<div><b>([\s\S]*)<\/b><\/div>$/

/* Style → Layout: Canvas. The whole draft becomes one canvas: each heading (a poem's title)
   a bold box, its date a small one, each run of lines a box, quotes quote boxes, images image
   boxes, all stacked in order to start with. */
export function docToCanvas(editor) {
  const { state } = editor
  const ser = DOMSerializer.fromSchema(state.schema)
  const inline = (n) => { const d = document.createElement('div'); d.append(ser.serializeFragment(n.content)); return d.innerHTML }
  const boxes = []
  let run = []
  const text = (html, fs, extra) => boxes.push({ k: 'text', x: 6, y: 0, w: null, fs, html: cleanBoxHtml(html), ...extra })
  const flush = () => {
    while (run.length && run[run.length - 1] === '<div><br></div>') run.pop()
    if (run.length) text(run.join(''), DEF_FS)
    run = []
  }
  const walk = (n) => {
    const t = n.type.name
    if (t === 'heading') {
      flush()
      const h = inline(n)
      if (h) text('<div><b>' + h + '</b></div>', n.attrs.level <= 2 ? 3.3 : 2.9)
      if (n.attrs.date) text('<div>' + esc(n.attrs.date) + '</div>', 1.9)
    } else if (n.isTextblock) {
      const h = inline(n)
      if (h || run.length) run.push('<div>' + (h || '<br>') + '</div>')
    } else if (t === 'blockquote') {
      flush()
      const lines = []
      n.descendants((c) => { if (c.isTextblock) { lines.push('<div>' + (inline(c) || '<br>') + '</div>'); return false } })
      if (lines.length) boxes.push({ k: 'quote', x: 6, y: 0, w: 60, fs: DEF_FS, html: cleanBoxHtml(lines.join('')) })
    } else if (t === 'figure') {
      flush()
      if (n.attrs.mediaType !== 'video' && n.attrs.src) boxes.push({ k: 'image', x: 6, y: 0, w: 44, src: n.attrs.src })
    } else if (t === 'canvas') {
      flush()
      for (const b of n.attrs.boxes || []) boxes.push({ ...b })
    } else if (n.childCount) n.forEach(walk) // lists, folds
  }
  state.doc.forEach(walk)
  flush()
  const canvas = state.schema.nodes.canvas.create({ h: 0, boxes })
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, canvas))
}

/* Style → Layout: Flow. Each canvas turns back into text, top to bottom. */
export function canvasToDoc(editor) {
  const { state } = editor
  const parser = DOMParser.fromSchema(state.schema)
  const nodes = []
  let changed = false
  state.doc.forEach((n) => {
    if (n.type.name !== 'canvas') { nodes.push(n); return }
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
  if (!changed) return
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(nodes)))
}

export const isAllCanvas = (editor) => {
  let n = 0, other = false
  editor.state.doc.forEach((c) => { if (c.type.name === 'canvas') n++; else if (c.content.size) other = true })
  return n === 1 && !other
}
