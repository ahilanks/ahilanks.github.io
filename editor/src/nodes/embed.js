/* embed.js — HTML diagrams: a block that runs a self-contained piece of HTML (an SVG, a D3
 * or Chart.js chart, a whole interactive page) inside the article.
 *
 * Saved as <div class="html-embed" data-html="…the HTML…">. It always runs in a sandboxed
 * iframe (scripts allowed, but no access to the editor, the page or its storage), so pasting
 * anything is safe. The frame sizes itself: a tiny script added to the diagram posts its
 * height to the page.
 *
 * In the editor: the toolbar's </> button (paste HTML or pick an .html file), pasting text
 * that is a whole HTML page or an <svg>, or dropping an .html file. Click the block to
 * select it (then you can use it); "Edit HTML" on hover changes it; the corner grip makes it
 * smaller or bigger (width attr, % of the column, centred).
 *
 * Publishing (embedsForPublish): each diagram becomes its own file, media/<slug>-diagram-
 * <hash>.html, loaded in a sandboxed, lazy iframe that is always the column's full width,
 * so it follows the reader's screen (phones included). Substack can't run it: the copy
 * gets a link to the article instead.
 */

import { Node } from '../../vendor/lib.bundle.js'
import { $, toast } from '../dom.js'

const clampW = (v) => Math.max(20, Math.min(100, Math.round(parseFloat(v) || 100)))
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
const MAX_H = 4000

// Posts the diagram's height to the page whenever it changes (runs inside the frame).
const RESIZE = '<script>(function(){var last=0;function s(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(Math.abs(h-last)>1){last=h;parent.postMessage({embedH:h},"*")}}' +
  'try{new ResizeObserver(s).observe(document.documentElement)}catch(e){setInterval(s,500)}addEventListener("load",s);s()})()</script>'
const BASE_CSS = '<style>html,body{margin:0;background:transparent}body{font-family:system-ui,-apple-system,sans-serif;color:#27323f}svg,img,canvas{max-width:100%}</style>'

// A fragment (a lone <svg>, a <div> + <script>) gets a minimal page around it; a whole page
// keeps its own <head>. Either way the margin reset goes first (the diagram's own CSS wins)
// and the resize script last.
export function embedDoc(html) {
  const src = String(html || '').trim()
  if (/<html[\s>]|<!doctype/i.test(src)) {
    let doc = /<head[\s>]/i.test(src)
      ? src.replace(/<head(\s[^>]*)?>/i, (m) => m + '<meta charset="utf-8">' + BASE_CSS)
      : src.replace(/<html(\s[^>]*)?>/i, (m) => m + '<head><meta charset="utf-8">' + BASE_CSS + '</head>')
    return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, RESIZE + '</body>') : doc + RESIZE
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    BASE_CSS + '<style>body>svg{display:block;margin:0 auto;height:auto}</style></head><body>' + src + RESIZE + '</body></html>'
}

// Text that is plainly a diagram rather than prose to paste.
export const looksLikeHtmlDoc = (t) => /^\s*(<!doctype html|<html[\s>]|<svg[\s>]|<\?xml[^>]*>\s*<svg[\s>])/i.test(t || '')

export const HtmlEmbed = Node.create({
  name: 'htmlEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      html: { default: '', parseHTML: (el) => el.getAttribute('data-html') || '', renderHTML: (a) => ({ 'data-html': a.html }) },
      // width as a % of the column (centred); 100 = full width
      width: { default: 100, parseHTML: (el) => clampW(el.getAttribute('data-w')), renderHTML: (a) => (a.width < 100 ? { 'data-w': String(a.width) } : {}) },
    }
  },
  parseHTML() { return [{ tag: 'div.html-embed' }] },
  renderHTML({ HTMLAttributes }) { return ['div', { class: 'html-embed', ...HTMLAttributes }] },

  addCommands() {
    return {
      insertHtmlEmbed: (html, pos) => ({ chain }) => {
        const node = { type: this.name, attrs: { html } }
        return pos == null ? chain().insertContent(node).run() : chain().insertContentAt(pos, node).run()
      },
    }
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let cur = node
      const dom = document.createElement('div')
      dom.className = 'html-embed-view'
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', SANDBOX)
      frame.setAttribute('title', 'Diagram')
      frame.style.height = '320px'
      const shield = document.createElement('div') // clicks select the block; once selected, the diagram is usable
      shield.className = 'he-shield'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'he-edit'
      edit.textContent = 'Edit HTML'
      const grip = document.createElement('div') // drag to make it smaller or bigger
      grip.className = 'he-resize'
      grip.title = 'Drag to resize'
      dom.append(frame, shield, edit, grip)
      const setW = (w) => { dom.style.width = w + '%' }
      setW(cur.attrs.width)

      // Resize from the corner: it stays centred, so the width moves twice as fast as the
      // pointer. Snaps to 100 / 75 / 50%.
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation()
        grip.setPointerCapture(e.pointerId)
        let w = cur.attrs.width
        const box = dom.getBoundingClientRect()
        const mid = box.left + box.width / 2 // it's centred in the column
        const colW = box.width / (w / 100)
        dom.classList.add('resizing')
        const move = (ev) => {
          w = clampW((2 * (ev.clientX - mid) / colW) * 100)
          for (const s of [100, 75, 50]) if (Math.abs(w - s) <= 2) w = s
          setW(w)
          grip.dataset.w = w + '%'
        }
        const up = () => {
          grip.removeEventListener('pointermove', move)
          dom.classList.remove('resizing')
          delete grip.dataset.w
          const pos = typeof getPos === 'function' ? getPos() : null
          if (pos != null && w !== cur.attrs.width) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'width', w))
          editor.view.focus() // so ⌘Z undoes it
        }
        grip.addEventListener('pointermove', move)
        grip.addEventListener('pointerup', up, { once: true })
        grip.addEventListener('pointercancel', up, { once: true })
      })

      const load = () => { frame.srcdoc = embedDoc(cur.attrs.html) }
      load()
      const onMsg = (e) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data.embedH !== 'number') return
        frame.style.height = Math.min(Math.max(e.data.embedH, 40), MAX_H) + 'px'
      }
      window.addEventListener('message', onMsg)

      edit.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      edit.addEventListener('click', (e) => {
        e.preventDefault()
        openDiagramPop(editor, { html: cur.attrs.html, anchor: edit, pos: typeof getPos === 'function' ? getPos() : null })
      })

      return {
        dom,
        update(n) {
          if (n.type !== cur.type) return false
          const changed = n.attrs.html !== cur.attrs.html
          cur = n
          if (changed) load()
          setW(n.attrs.width)
          return true
        },
        selectNode() { dom.classList.add('selected') },
        deselectNode() { dom.classList.remove('selected') },
        stopEvent(e) { return e.target === edit || e.target === grip },
        ignoreMutation() { return true },
        destroy() { window.removeEventListener('message', onMsg) },
      }
    }
  },
})

/* ------------------------------------------------------------- the popover */
let popEditor = null, popPos = null
function openDiagramPop(editor, { html = '', anchor, pos = null } = {}) {
  const pop = $('diagramPop'), input = $('diagramInput')
  if (!pop || !input) return
  popEditor = editor
  popPos = pos
  pop.classList.remove('hidden')
  $('diagramInsert').textContent = pos == null ? 'Insert' : 'Update'
  const r = (anchor || $('diagramBtn')).getBoundingClientRect()
  const w = pop.offsetWidth || 420
  const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth
  pop.style.left = Math.max(w / 2 + 10, Math.min(r.left + r.width / 2, vw - w / 2 - 10)) + 'px'
  pop.style.top = Math.min(r.bottom + 8, window.innerHeight - pop.offsetHeight - 10) + 'px'
  input.value = html
  input.focus()
}

function commit(html) {
  const editor = popEditor
  $('diagramPop').classList.add('hidden')
  if (!editor || !html.trim()) return
  if (popPos != null) {
    const n = editor.state.doc.nodeAt(popPos)
    if (n && n.type.name === 'htmlEmbed') editor.view.dispatch(editor.state.tr.setNodeAttribute(popPos, 'html', html))
    editor.view.focus() // so ⌘Z works straight away
  } else editor.chain().focus().insertHtmlEmbed(html).run()
}

// (an .svg file dropped goes in as a picture, figures.js; pick it from the popover to run it)
const isDiagramFile = (f) => f && (/\.html?$/i.test(f.name) || f.type === 'text/html')

export function setupEmbeds(editor) {
  const btn = $('diagramBtn'), pop = $('diagramPop'), input = $('diagramInput'), file = $('diagramFile')
  if (btn && pop && input && file) {
    const isOpen = () => !pop.classList.contains('hidden')
    const close = () => pop.classList.add('hidden')
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : openDiagramPop(editor) })
    $('diagramInsert').addEventListener('click', () => commit(input.value))
    $('diagramUpload').addEventListener('click', () => file.click())
    file.addEventListener('change', async () => {
      const f = file.files[0]
      file.value = ''
      if (f) input.value = await f.text()
      input.focus()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(input.value) }
      else if (e.key === 'Escape') { e.preventDefault(); close(); editor.commands.focus() }
    })
    document.addEventListener('mousedown', (e) => { if (isOpen() && !pop.contains(e.target) && e.target !== btn) close() })
  }

  // Pasting a whole HTML page or an <svg> (copied as text from a code editor or a chat)
  // makes a diagram instead of a wall of code. Capture, so it beats ProseMirror's paste.
  editor.view.dom.addEventListener('paste', (e) => {
    const t = e.clipboardData && e.clipboardData.getData('text/plain')
    if (!looksLikeHtmlDoc(t)) return
    if (editor.isActive('codeBlock')) return
    e.preventDefault(); e.stopPropagation()
    editor.chain().focus().insertHtmlEmbed(t.trim()).run()
    toast('Pasted as a diagram · ⌘Z to undo')
  }, true)

  // Dropping an .html or .svg file: a diagram where it lands.
  editor.view.dom.addEventListener('drop', async (e) => {
    if (e.defaultPrevented) return
    const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find(isDiagramFile)
    if (!f) return
    e.preventDefault(); e.stopPropagation()
    const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
    const html = await f.text()
    const $p = hit && editor.state.doc.resolve(hit.pos)
    const pos = $p && $p.depth ? $p.after(1) : null // after the block it was dropped on
    editor.chain().focus().insertHtmlEmbed(html, pos).run()
  }, true)
}

/* ------------------------------------------------------------- publishing */
const sha12 = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

// Before sanitising: each diagram → its own file, leaving <div data-embed="media/…html">.
export async function extractEmbeds(root, prefix, files, mediaPrefix) {
  for (const el of Array.from(root.querySelectorAll('div.html-embed'))) {
    const html = el.getAttribute('data-html') || ''
    if (!html.trim()) { el.remove(); continue }
    const doc = embedDoc(html)
    const name = prefix + '-diagram-' + (await sha12(doc)) + '.html'
    if (!files.some((f) => f.name === name)) files.push({ name, blob: new Blob([doc], { type: 'text/html' }) })
    const slot = document.createElement('div')
    slot.setAttribute('data-embed', mediaPrefix + name)
    if (el.hasAttribute('data-w')) slot.setAttribute('data-w', String(clampW(el.getAttribute('data-w'))))
    el.replaceWith(slot)
  }
}

// After sanitising: the slots → sandboxed frames (only our own media/ files).
export function embedsForPublish(root) {
  root.querySelectorAll('div[data-embed]').forEach((slot) => {
    const src = slot.getAttribute('data-embed') || ''
    if (!/^(\.\.\/)?media\/[\w.-]+-diagram-[0-9a-f]{12}\.html$/.test(src)) { slot.remove(); return }
    const fig = document.createElement('figure')
    fig.className = 'embed'
    const w = clampW(slot.getAttribute('data-w'))
    if (w < 100) fig.setAttribute('style', 'width:' + w + '%;margin-left:auto;margin-right:auto;')
    const f = document.createElement('iframe')
    f.setAttribute('src', src)
    f.setAttribute('sandbox', SANDBOX)
    f.setAttribute('loading', 'lazy')
    f.setAttribute('title', 'Diagram')
    fig.appendChild(f)
    slot.replaceWith(fig)
  })
}

export const EMBED_CSS = [
  '.embed { margin:1.8rem 0; }',
  '.embed iframe { display:block; width:100%; height:320px; border:0; }',
  '@media (max-width:560px) { .embed { width:auto !important; } }', // a shrunken diagram would be tiny on a phone
].join('\n')

// Runs INSIDE the published article (embedded via embedResize.toString()): sizes each frame
// to the height its diagram reports.
export function embedResize() {
  addEventListener('message', function (e) {
    var d = e.data
    if (!d || typeof d.embedH !== 'number') return
    var frames = document.querySelectorAll('.embed iframe')
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) frames[i].style.height = Math.min(Math.max(d.embedH, 40), 4000) + 'px'
    }
  })
}
