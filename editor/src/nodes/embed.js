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

import { Node, NodeSelection } from '../../vendor/lib.bundle.js'
import { $, toast } from '../dom.js'
import { openChat, ensureId, isPending, pendingSince, startNewDiagram } from './diagram-chat.js'

const clampW = (v) => Math.max(20, Math.min(100, Math.round(parseFloat(v) || 100)))
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
const MAX_H = 4000

// Runs inside the frame. A diagram drawn wider than its frame (a fixed-width chart) is laid
// out at its own width and scaled down to fit, so it's always seen whole with no sideways
// scrollbar; then the diagram's (scaled) height is posted to the page whenever it changes.
const RESIZE = '<script>(function(){var d=document.documentElement,last=0,busy=0;' +
  'function fit(){if(busy)return;busy=1;var st=d.style;st.transform="";st.width="";st.transformOrigin="0 0";' +
  'var W=d.clientWidth||innerWidth,sw=Math.max(d.scrollWidth,document.body?document.body.scrollWidth:0);' +
  'if(sw>W+1){var b=document.body;if(b){var cs=getComputedStyle(b);sw+=Math.min(80,b.getBoundingClientRect().left+parseFloat(cs.paddingLeft)||0)}var k=W/sw;st.width=sw+"px";st.transform="scale("+k+")";st.overflow="hidden"}else st.overflow="";busy=0;s()}' +
  'function s(){var h=Math.ceil(d.getBoundingClientRect().height);if(Math.abs(h-last)>1){last=h;parent.postMessage({embedH:h},"*")}}' +
  'try{new ResizeObserver(function(){requestAnimationFrame(fit)}).observe(document.body||d)}catch(e){setInterval(fit,500)}' +
  'addEventListener("resize",fit);addEventListener("load",fit);fit();' +
  // the editor's first click on a diagram, passed through (see the node view's cover)
  'addEventListener("message",function(e){var c=e.source===parent&&e.data&&e.data.embedClick;if(!c)return;var el=document.elementFromPoint(c[0],c[1]);if(!el)return;' +
  'if(el.focus)try{el.focus({preventScroll:true})}catch(x){}' +
  '["pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(t){var o={bubbles:true,cancelable:true,composed:true,clientX:c[0],clientY:c[1],button:0,view:window};' +
  'el.dispatchEvent(t[0]==="p"&&window.PointerEvent?new PointerEvent(t,Object.assign({pointerId:1,isPrimary:true,pointerType:"mouse"},o)):new MouseEvent(t,o))})})})()</script>'
// Runs inside the frame (embedded via toString, so self-contained). Diagrams sit straight on
// the page: a page-sized light, neutral background — the page itself, a wrapping "card",
// a full-size rect behind an SVG — is taken away with its border and shadow. Colour that
// means something stays: tinted or dark backgrounds, and anything smaller than the diagram.
function bareBg() {
  function plain(c) { // light and grey-ish (white, off-white, light grey)
    var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '')
    if (!m) return false
    var r = +m[1], g = +m[2], b = +m[3], a = m[4] == null ? 1 : +m[4]
    if (a === 0) return false
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 26
  }
  function run() {
    var body = document.body
    if (!body) return
    var root = document.documentElement
    var W = Math.max(root.scrollWidth, 1), H = Math.max(root.scrollHeight, 1)
    var els = [root, body].concat(Array.prototype.slice.call(body.querySelectorAll('div,section,main,article,figure,header,svg,canvas,rect')))
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      var big = el === root || el === body
      if (!big) {
        var r = el.getBoundingClientRect()
        big = r.width >= W * 0.85 && r.height >= H * 0.6
      }
      if (!big) continue
      if (el.tagName.toLowerCase() === 'rect') {
        if (plain(getComputedStyle(el).fill)) el.style.setProperty('fill', 'transparent', 'important')
        continue
      }
      var cs = getComputedStyle(el)
      if (plain(cs.backgroundColor) && (cs.backgroundImage === 'none' || !cs.backgroundImage)) {
        el.style.setProperty('background-color', 'transparent', 'important')
        el.style.setProperty('box-shadow', 'none', 'important')
        if (el !== root && el !== body) el.style.setProperty('border-color', 'transparent', 'important')
      }
    }
  }
  run()
  addEventListener('DOMContentLoaded', run)
  addEventListener('load', function () { run(); setTimeout(run, 400) })
}
const BARE = '<script>(' + bareBg.toString() + ')()</script>'

// The house style every diagram starts from (its own CSS still wins): the article's serif
// and palette as CSS variables, so a diagram written with var(--ink) / var(--accent) /
// var(--font) matches the page. Claude's diagrams are asked to use them (diagram_ai.py).
const BASE_CSS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap">' +
  '<style>:root{--ink:#27323f;--muted:#6b7280;--accent:#e8743b;--line:rgba(39,50,63,0.15);--tint-green:#e6f2e6;--tint-red:#f8e4df;--tint-orange:#fbe3d4;' +
  '--font:"Newsreader",Georgia,serif;--sans:system-ui,-apple-system,sans-serif}' +
  'html,body{margin:0;background:transparent}body{font-family:var(--font);color:var(--ink)}svg,img,canvas{max-width:100%}</style>'

// A fragment (a lone <svg>, a <div> + <script>) gets a minimal page around it; a whole page
// keeps its own <head>. Either way the margin reset goes first (the diagram's own CSS wins)
// and the resize script last.
export function embedDoc(html) {
  const src = String(html || '').trim()
  if (/<html[\s>]|<!doctype/i.test(src)) {
    let doc = /<head[\s>]/i.test(src)
      ? src.replace(/<head(\s[^>]*)?>/i, (m) => m + '<meta charset="utf-8">' + BASE_CSS)
      : src.replace(/<html(\s[^>]*)?>/i, (m) => m + '<head><meta charset="utf-8">' + BASE_CSS + '</head>')
    return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => BARE + RESIZE + '</body>') : doc + BARE + RESIZE
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    BASE_CSS + '<style>body>svg{display:block;margin:0 auto;height:auto}</style></head><body>' + src + BARE + RESIZE + '</body></html>'
}

// Text that is plainly a diagram rather than prose to paste.
export const looksLikeHtmlDoc = (t) => /^\s*(<!doctype html|<html[\s>]|<svg[\s>]|<\?xml[^>]*>\s*<svg[\s>])/i.test(t || '')

export const HtmlEmbed = Node.create({
  name: 'htmlEmbed',
  group: 'block',
  content: 'inline*', // the caption, rich text like a picture's
  isolating: true,
  draggable: false, // the cover is the drag handle, so dragging across caption text selects it
  selectable: true,

  addAttributes() {
    return {
      html: { default: '', parseHTML: (el) => el.getAttribute('data-html') || '', renderHTML: (a) => ({ 'data-html': a.html }) },
      // width as a % of the column (centred); 100 = full width
      // its conversation with Claude (diagram-chat.js): an id, and the messages as JSON;
      // both stay in the draft and are never published
      did: { default: '', parseHTML: (el) => el.getAttribute('data-did') || '', renderHTML: (a) => (a.did ? { 'data-did': a.did } : {}) },
      chat: { default: '', parseHTML: (el) => el.getAttribute('data-chat') || '', renderHTML: (a) => (a.chat ? { 'data-chat': a.chat } : {}) },
      width: { default: 100, parseHTML: (el) => clampW(el.getAttribute('data-w')), renderHTML: (a) => (a.width < 100 ? { 'data-w': String(a.width) } : {}) },
    }
  },
  parseHTML() {
    return [{ tag: 'div.html-embed', contentElement: (el) => el.querySelector(':scope > figcaption') || document.createElement('figcaption') }]
  },
  renderHTML({ HTMLAttributes }) { return ['div', { class: 'html-embed', ...HTMLAttributes }, ['figcaption', {}, 0]] },

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
      const ask = document.createElement('button') // "Change…": say what to change, Claude redraws it
      ask.type = 'button'
      ask.className = 'he-edit he-ask'
      ask.textContent = 'Chat'
      ask.title = 'Talk to Claude about this diagram'
      const working = document.createElement('div')
      working.className = 'he-working'
      const grip = document.createElement('div') // drag to make it smaller or bigger
      grip.className = 'he-resize'
      grip.title = 'Drag to resize'
      const box = document.createElement('div') // the diagram itself; the caption sits below it
      box.className = 'he-box'
      box.setAttribute('contenteditable', 'false')
      box.append(frame, shield, ask, edit, grip, working)
      const caption = document.createElement('figcaption')
      dom.append(box, caption)

      // The first click on a diagram selects the block AND reaches the diagram (a play
      // button, a slider), so it never feels dead; once selected the cover is gone.
      const selectSelf = () => {
        const pos = typeof getPos === 'function' ? getPos() : null
        if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
      }
      shield.addEventListener('mousedown', (e) => { if (e.button === 0) e.stopPropagation() })
      shield.addEventListener('click', (e) => {
        const r = frame.getBoundingClientRect()
        selectSelf()
        editor.view.focus()
        if (frame.contentWindow) frame.contentWindow.postMessage({ embedClick: [e.clientX - r.left, e.clientY - r.top] }, '*')
      })
      // dragging the cover moves the block (ProseMirror moves the selected node)
      shield.draggable = true
      shield.addEventListener('dragstart', (e) => {
        if (!editor.isEditable || dom.classList.contains('resizing') || !e.dataTransfer) { e.preventDefault(); return }
        selectSelf()
      })
      const setW = (w) => { dom.style.width = w + '%' }
      setW(cur.attrs.width)

      // Resize from the corner: it stays centred, so the width moves twice as fast as the
      // pointer. Snaps to 100 / 75 / 50%.
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation()
        grip.setPointerCapture(e.pointerId)
        let w = cur.attrs.width
        const bx = dom.getBoundingClientRect()
        const mid = bx.left + bx.width / 2 // it's centred in the column
        const colW = bx.width / (w / 100)
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

      ask.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      ask.addEventListener('click', (e) => {
        e.preventDefault()
        const pos = typeof getPos === 'function' ? getPos() : null
        const id = pos == null ? null : ensureId(editor, pos)
        if (id) openChat(editor, id)
      })
      // while Claude works on it: a small tag in the corner; the diagram stays usable
      let wtick = 0
      const showWorking = () => {
        const on = !!cur.attrs.did && isPending(cur.attrs.did)
        dom.classList.toggle('working', on)
        clearInterval(wtick)
        if (on) {
          const t0 = pendingSince(cur.attrs.did)
          const upd = () => { working.textContent = 'Claude is working… ' + Math.round((Date.now() - t0) / 1000) + 's' }
          upd()
          wtick = setInterval(upd, 1000)
        }
      }
      window.addEventListener('diagram-pending', showWorking)
      showWorking()

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
        contentDOM: caption,
        // ProseMirror handles the caption; the diagram box is ours (its cover only lets
        // ProseMirror see a drag, so the block can be moved)
        stopEvent(e) { return box.contains(e.target) && !(e.target === shield && /^drag|^drop/.test(e.type)) },
        ignoreMutation(m) { return !caption.contains(m.target) || m.target === caption },
        destroy() { window.removeEventListener('message', onMsg); window.removeEventListener('diagram-pending', showWorking); clearInterval(wtick) },
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
  pop.classList.toggle('edit-mode', pos != null) // Edit HTML: just the code
  const paste = $('diagramPaste')
  if (paste) paste.open = pos != null || !!html
  $('diagramInsert').textContent = pos == null ? 'Insert' : 'Update'
  const r = (anchor || $('diagramBtn')).getBoundingClientRect()
  const w = pop.offsetWidth || 420
  const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth
  pop.style.left = Math.max(w / 2 + 10, Math.min(r.left + r.width / 2, vw - w / 2 - 10)) + 'px'
  pop.style.top = Math.min(r.bottom + 8, window.innerHeight - pop.offsetHeight - 10) + 'px'
  input.value = html
  if (pos != null || !$('diagramPrompt')) input.focus()
  else $('diagramPrompt').focus()
}

/* ------------------------------------------- Claude: describe a new diagram */
// It goes in at once as a placeholder after the cursor's paragraph and Claude draws it in
// the background (diagram-chat.js); the chat panel opens on it, showing Claude's thinking.
async function generate(editor) {
  const ta = $('diagramPrompt')
  const prompt = ta.value.trim()
  if (!prompt) return
  const pop = $('diagramPop')
  pop.classList.add('hidden')
  ta.value = ''
  const at = editor.state.selection.to
  editor.view.focus()
  await startNewDiagram(editor, at, prompt)
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
    const ta = $('diagramPrompt')
    $('diagramGenerate').addEventListener('click', () => generate(editor))
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(editor) }
      else if (e.key === 'Escape') { e.preventDefault(); close(); editor.commands.focus() }
    })
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
    const cap = el.querySelector(':scope > figcaption')
    if (cap) slot.appendChild(cap) // the caption rides along (and is sanitised with the rest)
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
    const cap = slot.querySelector(':scope > figcaption')
    if (cap && cap.textContent.trim()) fig.appendChild(cap)
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
