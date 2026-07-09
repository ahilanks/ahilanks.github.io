/* figures.js — wire the image + video toolbar buttons, file inputs, and clipboard
 * image paste to insert figure nodes.
 *
 * Images embed as a base64 data-URI in the figure's `src`. Videos are too big for that,
 * so their bytes go to IndexedDB (idb.js) keyed by a short `vid`; the figure persists
 * only the vid and the <video>'s src is a blob: URL created at upload time. Because
 * blob: URLs don't survive a reload, rehydrateVideos() re-creates them from IndexedDB
 * after a draft loads. */

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

async function insertImageFile(editor, file) {
  if (!file || !file.type.startsWith('image/')) return
  const src = await fileToDataUrl(file)
  editor.chain().focus().insertFigure({ src, mediaType: 'image' }).run()
}

// Prefer the MIME type; fall back to the file's own extension, then mp4.
function extFromType(type, fallback) {
  const map = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv' }
  return (map[type] || fallback || 'mp4').replace(/[^a-z0-9]/g, '')
}

async function insertVideoFile(editor, file) {
  if (!file || !file.type.startsWith('video/')) return
  const id = uid()
  const ext = extFromType(file.type, (file.name.split('.').pop() || 'mp4').toLowerCase())
  try { await setMedia(id, { blob: file, ext }) }
  catch (e) { toast("Couldn't store the video (too large?)"); return }
  editor.chain().focus().insertFigure({ mediaType: 'video', vid: id }).run()
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

export function setupFigures(editor) {
  const imageBtn = $('imageBtn')
  const imageFileInput = $('imageFileInput')
  if (imageBtn && imageFileInput) {
    imageBtn.addEventListener('click', () => imageFileInput.click())
    imageFileInput.addEventListener('change', () => {
      const file = imageFileInput.files[0]
      imageFileInput.value = ''
      insertImageFile(editor, file)
    })
  }

  const videoBtn = $('videoBtn')
  const videoFileInput = $('videoFileInput')
  if (videoBtn && videoFileInput) {
    videoBtn.addEventListener('click', () => videoFileInput.click())
    videoFileInput.addEventListener('change', () => {
      const file = videoFileInput.files[0]
      videoFileInput.value = ''
      insertVideoFile(editor, file)
    })
  }

  // Paste an image straight from the clipboard → figure. Runs in capture so it wins
  // over ProseMirror's own paste handling for image blobs.
  editor.view.dom.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile()
        if (file) { e.preventDefault(); e.stopPropagation(); insertImageFile(editor, file); return }
      }
    }
  }, true)
}
