/* figures.js — wire the image + video toolbar buttons, file inputs, and clipboard
 * image paste to insert figure nodes.
 *
 * Images embed as a base64 data-URI in the figure's `src`. Videos are too big for that,
 * so their bytes go to IndexedDB (idb.js) keyed by a short `vid`; the figure persists
 * only the vid and the <video>'s src is a blob: URL created at upload time. Because
 * blob: URLs don't survive a reload, rehydrateVideos() re-creates them from IndexedDB
 * after a draft loads.
 *
 * GIFs (and any image over a couple of MB) don't embed either: the bytes go to the local
 * server (/api/gif → drafts/media/<draft>/gif-<hash>.<ext>) and `src` is that file's path.
 * Inline, a few MB of base64 would overflow localStorage and silently stop saves. The GIF
 * button also takes a link (Giphy, Tenor, a .gif URL); the server downloads it. */

import { $, uid, toast } from './dom.js'
import { setMedia, getMedia } from './idb.js'

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

const INLINE_MAX = 2 * 1024 * 1024 // bigger than this (or any GIF) is stored as a file

// POST a GIF file's bytes, or ask the server to fetch a link → the stored file's src.
async function storeGif(draftId, { file, url }) {
  const q = '/api/gif?draft=' + encodeURIComponent(draftId) + (url ? '&url=' + encodeURIComponent(url) : '')
  const r = await fetch(q, url ? { method: 'POST' } : { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
  let data = {}
  try { data = await r.json() } catch (e) { /* non-JSON error page */ }
  if (!r.ok || !data.src) throw new Error(data.error || "Couldn't save the GIF")
  return data.src
}

// Follow a drop point through edits made while its file loads or uploads (typing, another
// drop landing first), so the figure still goes where it was dropped. Call the result once,
// at insert time, for the up-to-date position.
function pinPos(editor, pos) {
  if (pos == null) return () => null
  const track = ({ transaction }) => { if (transaction.docChanged) pos = transaction.mapping.map(pos) }
  editor.on('transaction', track)
  return () => { editor.off('transaction', track); return pos }
}

// Insert at `pos` (a drop point) or the current selection.
function insertImageSrc(editor, src, pos) {
  const chain = editor.chain().focus()
  if (pos != null) chain.setTextSelection(pos)
  chain.insertFigure({ src, mediaType: 'image' }).run()
}

async function insertImageFile(editor, file, getDocId, pos) {
  if (!file || !file.type.startsWith('image/')) return
  const at = pinPos(editor, pos)
  if (file.type === 'image/gif' || file.size > INLINE_MAX) {
    toast(file.type === 'image/gif' ? 'Adding GIF…' : 'Adding image…')
    try { const src = await storeGif(getDocId(), { file }); insertImageSrc(editor, src, at()); return }
    catch (e) {
      if (file.size > INLINE_MAX) { at(); toast(e.message || "Couldn't save the image"); return }
      // small enough to embed: fall back to inline (e.g. the server is unreachable)
    }
  }
  const src = await fileToDataUrl(file)
  insertImageSrc(editor, src, at())
}

async function insertGifUrl(editor, url, getDocId, pos) {
  toast('Fetching GIF…')
  const at = pinPos(editor, pos)
  try { const src = await storeGif(getDocId(), { url }); insertImageSrc(editor, src, at()) }
  catch (e) { at(); toast(e.message || "Couldn't fetch that GIF"); return false }
  return true
}

// "Copy image" on a web GIF puts a still PNG on the clipboard alongside <img src="…gif">.
// Prefer the animated original when the HTML points at one.
function gifUrlFromHtml(html) {
  if (!html) return null
  const d = document.createElement('div')
  d.innerHTML = html
  const imgs = d.querySelectorAll('img')
  if (imgs.length !== 1 || d.textContent.trim()) return null // a lone image, not a pasted passage
  const src = imgs[0].getAttribute('src') || ''
  return /^https?:\/\//i.test(src) && /(\.gif(?:[?#]|$))|giphy\.com|tenor\.com/i.test(src) ? src : null
}

// Prefer the MIME type; fall back to the file's own extension, then mp4.
function extFromType(type, fallback) {
  const map = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv' }
  return (map[type] || fallback || 'mp4').replace(/[^a-z0-9]/g, '')
}

// IndexedDB alone is one site-data clear away from losing the video: also keep a copy on
// disk (drafts/media/<draft>/<vid>.<ext>), which rehydrateVideos() falls back to.
async function backupVideo(draftId, name, file) {
  if (!draftId) return
  try {
    const r = await fetch('/api/media?draft=' + encodeURIComponent(draftId) + '&name=' + encodeURIComponent(name), { method: 'POST', body: file })
    if (!r.ok) throw new Error(r.status)
  } catch (e) { toast("Video added, but its backup to disk failed") }
}

async function insertVideoFile(editor, file, getDocId, pos) {
  if (!file || !file.type.startsWith('video/')) return
  const id = uid()
  const ext = extFromType(file.type, (file.name.split('.').pop() || 'mp4').toLowerCase())
  const at = pinPos(editor, pos)
  try { await setMedia(id, { blob: file, ext }) }
  catch (e) { at(); toast("Couldn't store the video (too large?)"); return }
  backupVideo(getDocId(), id + '.' + ext, file)
  pos = at()
  const chain = editor.chain().focus()
  if (pos != null) chain.setTextSelection(pos)
  chain.insertFigure({ mediaType: 'video', vid: id }).run()
  // The node view rendered a bare <video>; point it at the freshly uploaded file. The
  // blob: URL is transient — it's rebuilt from IndexedDB by rehydrateVideos() on reload.
  const fig = editor.view.dom.querySelector(`figure.video-block[data-vid="${id}"]`)
  const video = fig && fig.querySelector('video')
  if (video) video.src = URL.createObjectURL(file)
}

/* Re-create blob: URLs for every uploaded video after a draft loads. Called from
 * main.js's applySnapshot (so it runs for every draft that gets displayed).
 *
 * Two sources, in order:
 *   1. this browser's IndexedDB (where a video uploaded here was stored), then
 *   2. the server's durable on-disk backup at drafts/media/<draftId>/<vid>.<ext>.
 * The disk fallback is what lets a video survive across browsers/devices and across
 * the v1→v2 cutover (v1 kept blobs in a different IndexedDB, so IndexedDB alone would
 * miss them). `draftId` is required for the fallback; without it only IndexedDB is used. */
export async function rehydrateVideos(editor, draftId) {
  const figs = editor.view.dom.querySelectorAll('figure.video-block[data-vid]')
  if (!figs.length) return
  let serverFiles = null // lazily fetched list of this draft's disk-backed media
  for (const fig of figs) {
    const video = fig.querySelector('video')
    if (!video) continue
    const vid = fig.dataset.vid
    try {
      const m = await getMedia(vid)
      if (m && m.blob) { video.src = URL.createObjectURL(m.blob); continue }
    } catch (e) { /* fall through to the disk backup */ }
    if (!draftId) continue
    try {
      if (serverFiles === null) {
        const r = await fetch('/api/media?draft=' + encodeURIComponent(draftId), { cache: 'no-store' })
        serverFiles = r.ok ? ((await r.json()).files || []) : []
      }
      const name = serverFiles.find((f) => f === vid || f.startsWith(vid + '.'))
      if (name) video.src = '/drafts/media/' + encodeURIComponent(draftId) + '/' + encodeURIComponent(name)
    } catch (e) { /* missing everywhere — leave the <video> empty */ }
  }
}

export function setupFigures(editor, { getDocId }) {
  const imageBtn = $('imageBtn')
  const imageFileInput = $('imageFileInput')
  if (imageBtn && imageFileInput) {
    imageBtn.addEventListener('click', () => imageFileInput.click())
    imageFileInput.addEventListener('change', () => {
      const file = imageFileInput.files[0]
      imageFileInput.value = ''
      insertImageFile(editor, file, getDocId)
    })
  }

  setupGifPop(editor, getDocId)

  const videoBtn = $('videoBtn')
  const videoFileInput = $('videoFileInput')
  if (videoBtn && videoFileInput) {
    videoBtn.addEventListener('click', () => videoFileInput.click())
    videoFileInput.addEventListener('change', () => {
      const file = videoFileInput.files[0]
      videoFileInput.value = ''
      insertVideoFile(editor, file, getDocId)
    })
  }

  // Paste an image straight from the clipboard → figure. Runs in capture so it wins
  // over ProseMirror's own paste handling for image blobs.
  editor.view.dom.addEventListener('paste', (e) => {
    const cd = e.clipboardData
    if (!cd) return
    const gifUrl = gifUrlFromHtml(cd.getData('text/html'))
    if (gifUrl) { e.preventDefault(); e.stopPropagation(); insertGifUrl(editor, gifUrl, getDocId); return }
    for (const it of cd.items || []) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile()
        if (file) { e.preventDefault(); e.stopPropagation(); insertImageFile(editor, file, getDocId); return }
      }
    }
  }, true)

  setupDrop(editor, getDocId)
}

// Image (incl. GIF) and video files in a drag, in the order they were picked up.
function mediaFiles(dt) {
  return Array.from((dt && dt.files) || []).filter((f) => /^(image|video)\//.test(f.type))
}

// A picture dragged in from a web page carries its address, not its bytes.
function imageUrlFromDrag(dt) {
  if (!dt) return null
  const d = document.createElement('div')
  d.innerHTML = dt.getData('text/html') || ''
  const imgs = d.querySelectorAll('img')
  if (imgs.length !== 1 || d.textContent.trim()) return null // a lone image, not a passage
  const src = imgs[0].getAttribute('src') || ''
  return /^https?:\/\//i.test(src) ? src : null
}

const isFileDrag = (dt) => !!dt && Array.from(dt.types || []).includes('Files')

/* Drag files from Finder (images, GIFs, videos — several at once) or a picture from another
 * web page, and drop it anywhere on the page: in the text it lands at the drop point; in the
 * margins it lands on the line level with the drop; below the text, at the end. Without this,
 * a file let go outside the body made the browser open it in place of the editor. Footnote
 * bodies take their own image drops (footnote.js); an in-editor drag is ProseMirror's job. */
function setupDrop(editor, getDocId) {
  const view = editor.view
  const page = document.body

  // the doc position for a drop at (x, y), clamped into the text column
  function dropPos(x, y) {
    const r = view.dom.getBoundingClientRect()
    if (y > r.bottom) return editor.state.doc.content.size
    if (y < r.top) return 0
    const hit = view.posAtCoords({ left: Math.min(Math.max(x, r.left + 2), r.right - 2), top: y })
    return hit ? hit.pos : null
  }

  async function insertFiles(files, pos) {
    for (const f of files) {
      if (f.type.startsWith('video/')) await insertVideoFile(editor, f, getDocId, pos)
      else await insertImageFile(editor, f, getDocId, pos)
      pos = null // the rest follow the first, in order
    }
  }

  // highlight the text column while files hover over the page
  let depth = 0
  const clearHover = () => { depth = 0; page.classList.remove('file-drag') }
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e.dataTransfer)) return
    depth++
    page.classList.add('file-drag')
  })
  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e.dataTransfer)) return
    if (--depth <= 0) clearHover()
  })
  document.addEventListener('dragend', clearHover)

  // Accept file drags everywhere (the default would navigate to the file). Text inputs
  // (title, subtitle) and the footnotes still do their own thing with non-file drags.
  document.addEventListener('dragover', (e) => {
    if (view.dragging || !isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })

  // Drops in the body: capture, so we beat ProseMirror's own (HTML-pasting) drop handling.
  view.dom.addEventListener('drop', (e) => {
    if (view.dragging) return
    const files = mediaFiles(e.dataTransfer)
    const url = files.length ? null : imageUrlFromDrag(e.dataTransfer)
    if (!files.length && !url) return
    e.preventDefault(); e.stopPropagation(); clearHover()
    const pos = dropPos(e.clientX, e.clientY)
    if (files.length) insertFiles(files, pos)
    else insertGifUrl(editor, url, getDocId, pos)
  }, true)

  // Drops anywhere else on the page (bubble phase: footnotes handle theirs first).
  document.addEventListener('drop', (e) => {
    clearHover()
    if (view.dragging || e.defaultPrevented || !isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    const files = mediaFiles(e.dataTransfer)
    if (!files.length) { toast('Only images, GIFs and videos can be dropped in'); return }
    insertFiles(files, dropPos(e.clientX, e.clientY))
  })
}

/* The toolbar GIF button: a popover that takes a link (Giphy / Tenor page, or any .gif
 * address) or a file. Mirrors links.js's popover (same .popover chrome, Enter/Escape). */
function setupGifPop(editor, getDocId) {
  const btn = $('gifBtn'), pop = $('gifPop'), input = $('gifInput'), fileInput = $('gifFileInput')
  if (!btn || !pop || !input || !fileInput) return
  const isOpen = () => !pop.classList.contains('hidden')
  const close = () => pop.classList.add('hidden')

  function open() {
    pop.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = pop.offsetWidth || 340
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth
    pop.style.left = Math.max(w / 2 + 10, Math.min(r.left + r.width / 2, vw - w / 2 - 10)) + 'px'
    pop.style.top = r.bottom + 8 + 'px'
    input.value = ''
    input.focus()
  }
  async function insertLink() {
    const url = input.value.trim()
    if (!url) { input.focus(); return }
    close()
    await insertGifUrl(editor, /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url, getDocId)
  }

  // mousedown + preventDefault keeps the editor's selection as the insertion point
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open() })
  $('gifInsert').addEventListener('click', insertLink)
  $('gifUpload').addEventListener('click', () => { close(); fileInput.click() })
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0]
    fileInput.value = ''
    insertImageFile(editor, file, getDocId)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); insertLink() }
    else if (e.key === 'Escape') { e.preventDefault(); close(); editor.commands.focus() }
  })
  document.addEventListener('mousedown', (e) => { if (isOpen() && !pop.contains(e.target) && e.target !== btn) close() })
}
