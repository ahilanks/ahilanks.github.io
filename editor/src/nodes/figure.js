/* figure.js — image (and, later, video) figures with an editable caption + drag-resize.
 *
 * One block node renders <figure class="img-block|video-block" [data-w]><img|video>
 * <figcaption>…</figcaption></figure> — matching v1 so publish/markdown keep working.
 * The caption is the node's inline content (contentDOM = figcaption), so it's real rich
 * text. Width is a percentage stored in the `width` attr (→ data-w). Images embed as a
 * base64 data-URI in `src`; video keeps only `vid` (bytes live in IndexedDB) — video
 * wiring/ rehydration comes in the next step.
 */

import { Node, NodeSelection } from '../../vendor/lib.bundle.js'
import { toast } from '../dom.js'

/* Small scaled-down drag ghost so a full-width image doesn't blanket the text (and
 * the drop-position line) while dragging. Chrome snapshots the element when
 * setDragImage is called and needs it rendered in the DOM at that moment; it's
 * removed right after. Any failure falls back to the browser's default ghost. */
function setDragGhost(e, img) {
  try {
    const w = img.clientWidth, h = img.clientHeight
    if (!w || !h || w <= 240) return
    const c = document.createElement('canvas')
    c.width = 240
    c.height = Math.max(1, Math.round((h * 240) / w))
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    c.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;'
    document.body.appendChild(c)
    e.dataTransfer.setDragImage(c, Math.round(c.width / 2), 18)
    setTimeout(() => c.remove(), 0)
  } catch (err) { /* default ghost */ }
}

function figureNodeView() {
  return ({ node, editor, getPos }) => {
    const isVideo = node.attrs.mediaType === 'video'
    const fig = document.createElement('figure')
    fig.className = isVideo ? 'video-block' : 'img-block'

    let media
    if (isVideo) {
      media = document.createElement('video')
      media.setAttribute('controls', ''); media.setAttribute('playsinline', ''); media.setAttribute('preload', 'metadata')
      if (node.attrs.vid) fig.dataset.vid = node.attrs.vid
      // src (a blob: URL) is rehydrated from IndexedDB after load
    } else {
      media = document.createElement('img')
      media.src = node.attrs.src
      if (node.attrs.alt) media.alt = node.attrs.alt
    }
    media.setAttribute('contenteditable', 'false')
    // Images are draggable: dragging the picture MOVES the whole figure (caption included)
    // through the doc. Videos stay non-draggable — a draggable attr would turn every
    // scrub/volume drag on the native controls into an element drag.
    media.setAttribute('draggable', isVideo ? 'false' : 'true')

    /* ── drag the image to move the figure ─────────────────────────────────────
       Node-select the figure on dragstart and let ProseMirror's own drag pipeline do
       the rest: it serializes the selection into the drag, the StarterKit dropcursor
       draws the insertion line while dragging, and the drop MOVES the node (source
       deleted, caption travels — it's the node's content). The node spec deliberately
       stays draggable:false: spec-draggable arms native dragging for any mousedown
       inside the figure (ProseMirror's mightDrag), which would turn drag-selecting
       caption text into a figure drag. Wiring the <img> alone keeps captions editable. */
    if (!isVideo) {
      let draggingThis = false
      media.addEventListener('dragstart', (e) => {
        const pos = getPos()
        if (!editor.isEditable || typeof pos !== 'number' || !e.dataTransfer ||
            fig.classList.contains('resizing')) { e.preventDefault(); return }
        const { state } = editor.view
        editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)))
        setDragGhost(e, media)
        // dim the source only AFTER the browser snapshots the drag ghost (which happens
        // when this handler returns), so a small image's default ghost isn't dimmed too
        draggingThis = true
        setTimeout(() => { if (draggingThis) fig.classList.add('drag-source') }, 0)
      })
      media.addEventListener('dragend', () => { draggingThis = false; fig.classList.remove('drag-source') })
    }

    const caption = document.createElement('figcaption')
    caption.dataset.placeholder = 'Write a caption…'
    fig.append(media, caption)
    applyWidth()

    function applyWidth() {
      if (node.attrs.width) { fig.dataset.w = node.attrs.width; fig.style.width = node.attrs.width + '%' }
      else { delete fig.dataset.w; fig.style.width = '' }
    }
    function setWidthAttr(w) {
      const pos = getPos()
      if (typeof pos !== 'number') return
      editor.chain().command(({ tr }) => { tr.setNodeAttribute(pos, 'width', w); return true }).run()
    }

    /* drag the right edge to resize (grip is the CSS ::after); dbl-click there resets.
       Pointer events (not mouse) so a finger drag resizes too — the figure's CSS
       touch-action:pan-y hands horizontal touch drags to us while vertical scrolling
       stays native (a vertical pan mid-drag fires pointercancel, which just commits). */
    function onRightEdge(e) {
      const r = fig.getBoundingClientRect()
      const edge = e.pointerType === 'touch' ? 28 : 16 // fatter hit zone for fingers
      return e.clientX >= r.right - edge && e.clientX <= r.right + 8 &&
             e.clientY >= r.top + r.height * 0.18 && e.clientY <= r.bottom - r.height * 0.18
    }
    fig.addEventListener('pointerdown', (e) => {
      if (!editor.isEditable || !e.isPrimary || !onRightEdge(e)) return
      e.preventDefault(); e.stopPropagation()
      const startX = e.clientX
      const startW = fig.getBoundingClientRect().width
      const containerW = editor.view.dom.clientWidth || startW
      fig.classList.add('resizing')
      const onMove = (ev) => {
        ev.preventDefault()
        let pct = Math.round(((startW + (ev.clientX - startX)) / containerW) * 100)
        pct = Math.max(20, Math.min(100, pct))
        fig.style.width = pct + '%'; fig.dataset.w = pct
      }
      const onUp = () => {
        fig.classList.remove('resizing')
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        const w = Number(fig.dataset.w)
        setWidthAttr(w >= 100 ? null : w) // full width = no override
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    })

    /* ── crop: dbl-click the image (not the resize edge) → overlay w/ corner handles ── */
    function setSrcAttr(newSrc) {
      const pos = getPos()
      if (typeof pos !== 'number') return
      editor.chain().command(({ tr }) => { tr.setNodeAttribute(pos, 'src', newSrc); return true }).run()
    }

    function openCrop() {
      if (isVideo || !editor.isEditable) return
      const currentSrc = node.attrs.src
      if (!currentSrc) return

      let box = { x: 0, y: 0, w: 0, h: 0 }, drag = null

      const ov = document.createElement('div')
      ov.className = 'crop-overlay'
      ov.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:1.5rem;'

      const stage = document.createElement('div')
      stage.style.cssText = 'position:relative;user-select:none;touch-action:none;line-height:0;'

      const pic = document.createElement('img')
      pic.draggable = false
      pic.style.cssText = 'display:block;max-width:84vw;max-height:70vh;'
      pic.src = currentSrc

      const boxEl = document.createElement('div')
      boxEl.style.cssText = 'position:absolute;border:1.5px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.5);cursor:move;box-sizing:border-box;'
      ;['nw', 'ne', 'sw', 'se'].forEach((c) => {
        const h = document.createElement('div')
        h.dataset.h = c
        h.style.cssText = 'position:absolute;width:14px;height:14px;background:#fff;border-radius:50%;' +
          (c[0] === 'n' ? 'top:-7px;' : 'bottom:-7px;') + (c[1] === 'w' ? 'left:-7px;' : 'right:-7px;') +
          'cursor:' + c + '-resize;'
        boxEl.appendChild(h)
      })

      const bar = document.createElement('div')
      bar.style.cssText = 'display:flex;gap:10px;'
      const mkBtn = (label, primary) => {
        const b = document.createElement('button')
        b.type = 'button'; b.textContent = label
        b.style.cssText = 'padding:8px 18px;border-radius:8px;font-size:14px;cursor:pointer;border:1px solid rgba(255,255,255,.4);' +
          (primary ? 'background:#fff;color:#111;' : 'background:transparent;color:#fff;')
        return b
      }
      const cancelBtn = mkBtn('Cancel', false), applyBtn = mkBtn('Crop', true)
      bar.append(cancelBtn, applyBtn)

      stage.append(pic, boxEl)
      ov.append(stage, bar)
      document.body.appendChild(ov)

      function layout() {
        boxEl.style.left = box.x + 'px'; boxEl.style.top = box.y + 'px'
        boxEl.style.width = box.w + 'px'; boxEl.style.height = box.h + 'px'
      }
      function init() { box = { x: 0, y: 0, w: pic.clientWidth, h: pic.clientHeight }; layout() }
      pic.complete && pic.naturalWidth ? init() : (pic.onload = init)

      boxEl.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation()
        drag = { mode: (e.target.dataset && e.target.dataset.h) || 'move', sx: e.clientX, sy: e.clientY, b: { ...box } }
        boxEl.setPointerCapture(e.pointerId)
      })
      boxEl.addEventListener('pointermove', (e) => {
        if (!drag) return
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
        const W = pic.clientWidth, H = pic.clientHeight, MIN = 24
        let { x, y, w, h } = drag.b
        if (drag.mode === 'move') {
          x = Math.max(0, Math.min(W - w, x + dx))
          y = Math.max(0, Math.min(H - h, y + dy))
        } else {
          if (drag.mode.includes('w')) { const nx = Math.max(0, Math.min(x + w - MIN, x + dx)); w += x - nx; x = nx }
          if (drag.mode.includes('e')) { w = Math.max(MIN, Math.min(W - x, w + dx)) }
          if (drag.mode.includes('n')) { const ny = Math.max(0, Math.min(y + h - MIN, y + dy)); h += y - ny; y = ny }
          if (drag.mode.includes('s')) { h = Math.max(MIN, Math.min(H - y, h + dy)) }
        }
        box = { x, y, w, h }; layout()
      })
      boxEl.addEventListener('pointerup', () => { drag = null })

      function close() {
        drag = null
        document.removeEventListener('keydown', onKey, true)
        ov.remove()
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      }
      document.addEventListener('keydown', onKey, true)

      cancelBtn.onclick = close
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close() })

      applyBtn.onclick = () => {
        try {
          const sx = pic.naturalWidth / pic.clientWidth, sy = pic.naturalHeight / pic.clientHeight
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round(box.w * sx))
          c.height = Math.max(1, Math.round(box.h * sy))
          c.getContext('2d').drawImage(pic, box.x * sx, box.y * sy, c.width, c.height, 0, 0, c.width, c.height)
          const m = /^data:(image\/(?:jpeg|webp))/.exec(currentSrc)
          const newSrc = m ? c.toDataURL(m[1], 0.92) : c.toDataURL('image/png')
          setSrcAttr(newSrc)
        } catch (err) { toast("Couldn't crop this image") }
        close()
      }
    }

    fig.addEventListener('dblclick', (e) => {
      if (onRightEdge(e)) { e.preventDefault(); setWidthAttr(null); return }
      if (!isVideo && e.target === media) { e.preventDefault(); e.stopPropagation(); openCrop() }
    })

    return {
      dom: fig,
      contentDOM: caption,
      update(next) {
        if (next.type !== node.type) return false
        // The media element (an <img> or a <video>) is built once at creation and can't be
        // mutated into the other kind, and a <video>'s bytes are re-sourced by vid — not by a
        // plain src swap. So when PM reuses this node view across a draft switch (setContent),
        // bail out and let it rebuild a fresh node view if the media KIND or the video source
        // changed; otherwise a reused element keeps showing the previous draft's picture/video
        // until a full page reload. rehydrateVideos() (run right after setContent) then points
        // the fresh <video> at the right bytes. Same-kind image src changes still update in place.
        const nextIsVideo = next.attrs.mediaType === 'video'
        if (nextIsVideo !== isVideo) return false
        if (nextIsVideo && next.attrs.vid !== node.attrs.vid) return false
        node = next
        applyWidth()
        if (!isVideo && media.src !== node.attrs.src && node.attrs.src) media.src = node.attrs.src
        return true
      },
      // PM manages only the caption; everything else (img load, resize style/data-w) is ours.
      ignoreMutation(m) { return !caption.contains(m.target) || m.target === caption },
    }
  }
}

export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  content: 'inline*', // the caption
  draggable: false,
  selectable: true,
  isolating: true,
  addAttributes() {
    return {
      src: { default: '', parseHTML: (el) => (el.querySelector('img') && el.querySelector('img').getAttribute('src')) || '' },
      width: { default: null, parseHTML: (el) => { const w = el.getAttribute('data-w'); return w ? Number(w) : null } },
      mediaType: { default: 'image', parseHTML: (el) => (el.classList.contains('video-block') ? 'video' : 'image') },
      vid: { default: null, parseHTML: (el) => el.getAttribute('data-vid') || null },
      alt: { default: '', parseHTML: (el) => (el.querySelector('img') && el.querySelector('img').getAttribute('alt')) || '' },
    }
  },
  parseHTML() {
    return [{ tag: 'figure.img-block' }, { tag: 'figure.video-block' }]
  },
  renderHTML({ node }) {
    const isVideo = node.attrs.mediaType === 'video'
    const figAttrs = { class: isVideo ? 'video-block' : 'img-block' }
    if (node.attrs.width) figAttrs['data-w'] = node.attrs.width
    if (isVideo && node.attrs.vid) figAttrs['data-vid'] = node.attrs.vid
    const media = isVideo
      ? ['video', { controls: 'true', playsinline: 'true', preload: 'metadata' }]
      : ['img', { src: node.attrs.src, alt: node.attrs.alt || '' }]
    return ['figure', figAttrs, media, ['figcaption', {}, 0]]
  },
  addNodeView() { return figureNodeView() },
  addCommands() {
    return {
      insertFigure: (attrs) => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs }).run(),
    }
  },
})
