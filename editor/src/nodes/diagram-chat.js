/* diagram-chat.js — talk to Claude about a diagram, in a panel on the right.
 *
 * Each diagram keeps its own conversation (node attr `chat`, saved in the draft, never
 * published): what you asked (with any pasted pictures, as thumbnails), what Claude said it
 * did, its thinking, and the diagram each answer made, so an earlier one can be restored.
 *
 * The work itself is a JOB on the editor server (diagram_ai.py): this page only watches it,
 * streaming Claude's thinking and answer as they arrive. Reload mid-answer and the page
 * picks the job up again; an answer that finished while its draft wasn't open is applied the
 * next time it is. Messages sent while Claude is busy queue and run in order, each building
 * on the last answer. Nothing locks: the diagram stays usable, with a small tag on it.
 *
 * Stop (beside Send, while Claude works) ends the answer it's writing and drops queued ones.
 * Send now (or ⌘Enter) does that too, then sends the new message together with any it
 * hadn't answered yet; plain Send queues behind the running answer.
 * Files can be attached (📎, paste, drop): pictures go with that message; other files (PDF,
 * HTML, notes, data) stay with the diagram on the server as context for every later message.
 *
 * A diagram's change is one ⌘Z-able step; chat updates stay out of the undo history.
 */
import { $, toast } from '../dom.js'

const KEEP_VERSIONS = 8 // older answers keep their words, not their diagram
const API_IMG = 1568     // longest side sent to Claude
const THUMB = 240        // longest side kept in the chat

export const newId = () => Math.random().toString(36).slice(2, 10)

export function parseChat(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch (e) { return [] }
}

function trimVersions(chat) {
  let n = 0
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].h && ++n > KEEP_VERSIONS) delete chat[i].h
  return chat
}

// The article text around `pos`, so a diagram fits what it illustrates.
export function contextAround(editor, pos) {
  const doc = editor.state.doc
  const before = doc.textBetween(Math.max(0, pos - 2500), pos, '\n\n')
  const after = doc.textBetween(pos, Math.min(doc.content.size, pos + 1000), '\n\n')
  return (before + '\n\n[the diagram goes here]\n\n' + after).trim()
}

async function api(method, url, body) {
  let res
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  } catch (e) { throw new Error('The editor server isn\'t reachable.') }
  let out = null
  try { out = await res.json() } catch (e) {}
  if (!out || !out.ok) throw new Error((out && out.error) || 'Something went wrong (' + res.status + ').')
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (t) => new Date(t || Date.now()).toISOString()

/* ------------------------------------------------------------ finding diagrams */
function findById(editor, id) {
  let hit = null
  editor.state.doc.descendants((n, p) => {
    if (hit) return false
    if (n.type.name === 'htmlEmbed' && n.attrs.did === id) hit = { node: n, pos: p }
    return !hit
  })
  return hit
}

// A diagram made before chats existed gets its id the first time it's chatted about.
export function ensureId(editor, pos) {
  const n = editor.state.doc.nodeAt(pos)
  if (!n || n.type.name !== 'htmlEmbed') return null
  if (n.attrs.did) return n.attrs.did
  const id = newId()
  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'did', id).setMeta('addToHistory', false))
  return id
}

function setChat(editor, id, chat) {
  const hit = findById(editor, id)
  if (!hit) return
  editor.view.dispatch(editor.state.tr.setNodeAttribute(hit.pos, 'chat', JSON.stringify(trimVersions(chat))).setMeta('addToHistory', false))
}

/* ------------------------------------------------------------ jobs (the server does the work) */
const jobs = new Map()     // job id -> { id, did, status, think, text, t0 }
const following = new Set()
const waiting = new Set()  // finished, but their diagram's draft isn't open here
const interrupted = new Set() // stopped by Send now: their question rides along with the new one
let ed = null

const live = (j) => j.status === 'queued' || j.status === 'running'
export const isPending = (did) => { for (const j of jobs.values()) if (j.did === did && live(j)) return true; return false }
export function pendingSince(did) {
  let t = 0
  for (const j of jobs.values()) if (j.did === did && j.status === 'running') t = j.t0 || Date.now()
  return t || Date.now()
}
function announce() { window.dispatchEvent(new CustomEvent('diagram-pending')); render() }

function handle(id, ev) {
  const j = jobs.get(id)
  if (!j) return
  if (ev.k === 'start') { j.status = 'running'; j.t0 = ev.at ? ev.at * 1000 : Date.now(); j.think = ''; j.text = ''; announce() }
  else if (ev.k === 'think') { j.think += ev.t; paintLive() }
  else if (ev.k === 'text') { j.text += ev.t; paintLive() }
  else if (ev.k === 'end') {
    j.status = ev.job.status
    if (!applyJob(ev.job)) waiting.add(id)
    announce()
  } else if (ev.k === 'gone') { jobs.delete(id); announce() }
}

// Watch a job's events (from where we left off), reconnecting if the line drops.
async function follow(id) {
  if (following.has(id)) return
  following.add(id)
  let from = 0
  let ended = false
  while (!ended) {
    try {
      const res = await fetch('/api/diagram/jobs/' + id + '/events?from=' + from, { cache: 'no-store' })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let ev
          try { ev = JSON.parse(line) } catch (e) { continue }
          if (ev.i) from = ev.i
          handle(id, ev)
          if (ev.k === 'end' || ev.k === 'gone') ended = true
        }
      }
    } catch (e) { await sleep(2000) } // server restarting, or offline: try again
    if (!ended) await sleep(400)
  }
  following.delete(id)
}

// Put a finished job's answer into its diagram (once), then tell the server it's in.
function applyJob(sum) {
  if (!ed || !sum || !(sum.status === 'done' || sum.status === 'error')) return false
  const hit = findById(ed, sum.did)
  if (!hit) return false // its draft isn't open: later
  const chat = parseChat(hit.node.attrs.chat)
  const folded = sum.result && sum.result.stopped && interrupted.has(sum.id) // answered by the Send now that stopped it
  if (!folded && !chat.some((m) => m.j === sum.id && m.r !== 'u')) {
    // a reload before the draft saved the question: put it back
    if (!chat.some((m) => m.j === sum.id && m.r === 'u')) chat.push({ r: 'u', t: sum.prompt, j: sum.id, at: iso(sum.created * 1000) })
    const res = sum.result || {}
    const th = (sum.think || '').trim().slice(-4000) || undefined
    if (res.ok) {
      if (res.html) {
        ed.view.dispatch(ed.state.tr.setNodeAttribute(hit.pos, 'html', res.html)) // ⌘Z-able
        const now = findById(ed, sum.did)
        if (res.caption && now && !now.node.textContent.trim()) ed.view.dispatch(ed.state.tr.insertText(res.caption, now.pos + 1))
      }
      chat.push({ r: 'a', t: res.note || 'Done.', j: sum.id, at: iso(), h: res.html || undefined, th })
    } else {
      chat.push({ r: 'e', t: res.error || 'Something went wrong.', j: sum.id, at: iso(), th, st: res.stopped ? 1 : undefined })
    }
    setChat(ed, sum.did, chat)
    if (!panelOpen() || panelId !== sum.did) { if (!res.stopped) toast(res.ok ? (res.html ? 'Claude changed a diagram · ⌘Z to undo' : 'Claude replied about a diagram') : res.error || 'Claude ran into a problem') }
  }
  jobs.delete(sum.id)
  waiting.delete(sum.id)
  api('POST', '/api/diagram/jobs/' + sum.id + '/applied').catch(() => {})
  return true
}

// The server's diagram version (diagram_ai.open_jobs): 2+ takes files and Stop.
let serverV = 0
const OLD_SERVER = 'The editor server is out of date: double-click run-editor.command to restart it, then try again.'
async function serverReady() {
  if (serverV < 2) await syncJobs()
  return serverV >= 2
}
// On load (and while answers are waiting for their draft): pick up every job on the server.
async function syncJobs() {
  let out
  try { out = await api('GET', '/api/diagram/jobs') } catch (e) { return }
  serverV = out.v || 1
  for (const sum of out.jobs) {
    if (sum.status === 'done' || sum.status === 'error') {
      if (!applyJob(sum)) waiting.add(sum.id)
    } else {
      if (!jobs.has(sum.id)) jobs.set(sum.id, { id: sum.id, did: sum.did, status: sum.status, think: '', text: '', t0: 0 })
      follow(sum.id)
    }
  }
  announce()
}

/* ------------------------------------------------------------ sending */
async function submit(editor, did, text, images, thumbs, { html, files, shown } = {}) {
  const hit = findById(editor, did)
  if (!hit) return false
  if (files && files.length && !(await serverReady())) { toast(OLD_SERVER); return false }
  const chat = parseChat(hit.node.attrs.chat)
  const history = chat.filter((m) => m.r !== 'e' && !interrupted.has(m.j)).slice(-14).map((m) => ({ role: m.r === 'u' ? 'user' : 'assistant', text: m.t }))
  let out
  try {
    out = await api('POST', '/api/diagram/jobs', {
      did, prompt: text, html: html != null ? html : hit.node.attrs.html,
      context: contextAround(editor, hit.pos), history, images, files: files && files.length ? files : undefined,
    })
  } catch (e) { toast(e.message); return false }
  const now = findById(editor, did)
  if (now) {
    const c2 = parseChat(now.node.attrs.chat)
    c2.push({ r: 'u', t: shown != null ? shown : text, j: out.id, at: iso(), img: thumbs && thumbs.length ? thumbs : undefined, fl: files && files.length ? files.map((f) => f.name) : undefined })
    setChat(editor, did, c2)
  }
  jobs.set(out.id, { id: out.id, did, status: 'queued', think: '', text: '', t0: 0 })
  announce()
  follow(out.id)
  return true
}

/* ------------------------------------------------------------ a new diagram from the </> popover */
// It goes in at once as a placeholder (so it survives a reload) and Claude draws it in the
// background; the chat panel opens on it to show the thinking as it happens.
const PLACEHOLDER = '<svg viewBox="0 0 600 120" width="100%"><text x="300" y="66" text-anchor="middle" font-family="var(--font)" fill="var(--muted)" font-size="16" font-style="italic">Claude is drawing this diagram…</text></svg>'
export async function startNewDiagram(editor, at, prompt, { images = [], thumbs = [], files = [] } = {}) {
  const $p = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size))
  const pos = $p.depth ? $p.after(1) : at // after the paragraph the cursor was in
  if (files.length && !(await serverReady())) { toast(OLD_SERVER); return false }
  const did = newId()
  editor.chain().insertContentAt(pos, { type: 'htmlEmbed', attrs: { html: PLACEHOLDER, did, chat: '[]' } }).run()
  const ok = await submit(editor, did, prompt, images, thumbs, { html: '', files })
  if (ok) openChat(editor, did, { focus: false })
}

/* ------------------------------------------------------------ pictures */
async function shrink(file, max, type, q) {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * k))
  c.height = Math.max(1, Math.round(bmp.height * k))
  const g = c.getContext('2d')
  g.fillStyle = '#ffffff' // transparent screenshots stay readable as JPEG
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(bmp, 0, 0, c.width, c.height)
  return c.toDataURL(type, q)
}
// A picture → { img, thumb } (sent with that message). Any other file → { file } — a PDF, or
// anything that reads as text (HTML, Markdown, CSV, code, notes) — which the server keeps
// with the diagram, so later messages about it still have it (diagram_ai.py).
const TEXT_MAX = 400000, FILE_MAX = 9 * 1024 * 1024
export async function readAttachment(f) {
  if (/^image\//.test(f.type)) {
    const big = await shrink(f, API_IMG, 'image/jpeg', 0.9)
    const thumb = await shrink(f, THUMB, 'image/jpeg', 0.8)
    return { name: f.name, img: { media_type: 'image/jpeg', data: big.split(',')[1] }, thumb }
  }
  if (f.size > FILE_MAX) throw new Error(f.name + ' is too big (over 9 MB)')
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
    return { name: f.name, file: { name: f.name, kind: 'pdf', data: url.split(',')[1] } }
  }
  const text = await f.text()
  if (/\u0000/.test(text.slice(0, 8000))) throw new Error('Can\'t read ' + f.name + ': attach a PDF, a picture, or a text file (HTML, Markdown, CSV…)')
  return { name: f.name, file: { name: f.name, kind: 'text', data: text.slice(0, TEXT_MAX) } }
}
// Long text pasted into a message box (an HTML page, notes) goes in as a file instead
export const pastedAsFile = (t) => ({ name: /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(t) ? 'pasted.html' : 'pasted.txt', file: { name: /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(t) ? 'pasted.html' : 'pasted.txt', kind: 'text', data: t.slice(0, TEXT_MAX) } })
export const PASTE_AS_FILE = 1500 // characters
// The chips under a message box: a picture's thumbnail, a file's name.
export function chipsHtml(list) {
  return list.map((a, i) => '<span class="dgc-att-i' + (a.file ? ' dgc-att-file' : '') + '">' +
    (a.file ? '<span class="dgc-fname">' + esc(a.name) + '</span>' : '<img src="' + a.thumb + '" alt="">') +
    '<button type="button" data-i="' + i + '" aria-label="Remove">×</button></span>').join('')
}
export async function addAttachments(list, files) {
  for (const f of files) {
    if (list.length >= 8) { toast('That\'s enough attachments for one message'); break }
    try { list.push(await readAttachment(f)) } catch (e) { toast(e.message || 'Couldn\'t read ' + f.name) }
  }
}
let attached = [] // readAttachment results
async function attach(files) {
  await addAttachments(attached, files)
  paintAttached()
}
function paintAttached() {
  const box = $('dgChatAtt')
  if (!box) return
  box.hidden = !attached.length
  box.innerHTML = chipsHtml(attached)
}

/* ------------------------------------------------------------ the panel */
let panelId = null
let tick = 0
const panelOpen = () => { const p = $('dgChat'); return !!p && !p.hidden }

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
function when(t) {
  const d = new Date(t)
  if (isNaN(d)) return ''
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function openChat(editor, id, { focus = true } = {}) {
  ed = editor
  panelId = id
  lastSig = ''
  const p = $('dgChat')
  if (!p) return
  p.hidden = false
  document.body.classList.add('dg-chat-open')
  render()
  if (focus) setTimeout(() => { const i = $('dgChatInput'); if (i) i.focus() }, 0)
}
function closeChat() {
  lastSig = ''
  const p = $('dgChat')
  if (p) p.hidden = true
  document.body.classList.remove('dg-chat-open')
  panelId = null
  clearInterval(tick)
}

// What Claude is writing, as progress: the drawing (a line count, not the code), then its note.
function progressOf(text) {
  const a = text.indexOf('```')
  if (a < 0) return { note: text.replace(/^\s*(NOTE|CAPTION):\s*/gm, '').trim() }
  const b = text.indexOf('```', a + 3)
  const code = text.slice(a, b < 0 ? undefined : b)
  const lines = Math.max(0, code.split('\n').length - 1)
  if (b < 0) return { drawing: true, lines }
  const after = text.slice(b + 3)
  const m = /NOTE:\s*([\s\S]*)/.exec(after)
  return { drawn: true, lines, note: m ? m[1].trim() : '' }
}

let lastSig = ''
function render() {
  const p = $('dgChat')
  if (!p || p.hidden || !ed) return
  const list = $('dgChatList')
  const hit = panelId && findById(ed, panelId)
  const mine = [...jobs.values()].filter((j) => j.did === panelId)
  const busy = mine.some(live)
  const stopBtn = $('dgChatStop'), nowBtn = $('dgChatNow')
  if (stopBtn) stopBtn.hidden = !busy
  if (nowBtn) nowBtn.hidden = !busy
  const sig = hit ? panelId + '|' + hit.node.attrs.chat + '|' + hit.node.attrs.html.length + '|' + mine.map((j) => j.id + j.status).join(',') : 'none'
  if (sig === lastSig) return
  lastSig = sig
  clearInterval(tick)
  if (!hit) {
    list.innerHTML = ''
    return
  }
  const chat = parseChat(hit.node.attrs.chat)
  const current = hit.node.attrs.html
  const byId = new Map(mine.map((j) => [j.id, j]))
  let h = ''
  chat.forEach((m, i) => {
    const cls = m.r === 'u' ? 'dgc-you' : m.r === 'e' ? (m.st ? 'dgc-stopped' : 'dgc-err') : 'dgc-claude'
    const job = m.r === 'u' && m.j ? byId.get(m.j) : null
    h += '<div class="dgc-msg ' + cls + '">'
    if (m.th) h += '<details class="dgc-think"><summary>Thinking</summary><div class="dgc-think-t">' + esc(m.th) + '</div></details>'
    if (m.img) h += '<div class="dgc-imgs">' + m.img.map((s) => '<img class="dgc-img" src="' + esc(s) + '" alt="">').join('') + '</div>'
    if (m.fl) h += '<div class="dgc-files">' + m.fl.map((n) => '<span class="dgc-fname">' + esc(n) + '</span>').join('') + '</div>'
    if (m.t && m.t !== '(see the attached image)' && m.t !== '(see the attached files)') h += '<div class="dgc-text">' + esc(m.t) + '</div>'
    h += '<div class="dgc-meta">' + esc(when(m.at)) +
      (job && job.status === 'queued' ? ' · <span class="dgc-q">queued</span>' : '') +
      (m.h ? (m.h === current ? ' · <span class="dgc-cur">showing</span>' : ' · <button type="button" class="dgc-restore" data-i="' + i + '">Restore this version</button>') : '') +
      '</div></div>'
    if (job && job.status === 'running') h += liveHtml(job)
  })
  // a job whose question didn't make it into the saved draft (a reload right after sending)
  const asked = new Set(chat.map((m) => m.j).filter(Boolean))
  for (const j of mine) if (!asked.has(j.id)) h += j.status === 'running' ? liveHtml(j) : '<div class="dgc-meta">a message is queued…</div>'
  list.innerHTML = h
  paintLive()
  list.scrollTop = list.scrollHeight
  if (mine.some((j) => j.status === 'running')) tick = setInterval(paintLive, 1000)
}

function liveHtml(j) {
  return '<div class="dgc-msg dgc-claude dgc-live" data-j="' + j.id + '">' +
    '<details class="dgc-think" open><summary>Thinking</summary><div class="dgc-think-t"></div></details>' +
    '<div class="dgc-prog"></div></div>'
}

let liveQueued = false
function paintLive() {
  if (liveQueued) return
  liveQueued = true
  requestAnimationFrame(() => {
    liveQueued = false
    const list = $('dgChatList')
    if (!list || !panelOpen()) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.querySelectorAll('.dgc-live').forEach((el) => {
      const j = jobs.get(el.dataset.j)
      if (!j) return
      const secs = Math.round((Date.now() - (j.t0 || Date.now())) / 1000)
      const t = el.querySelector('.dgc-think-t')
      const think = j.think.trim()
      t.textContent = think || 'Thinking…'
      t.scrollTop = t.scrollHeight
      const pr = progressOf(j.text)
      let line = ''
      if (pr.drawing) line = 'Drawing the diagram… ' + pr.lines + ' lines'
      else if (pr.drawn) line = 'Drew it (' + pr.lines + ' lines).' + (pr.note ? '\n' + pr.note : '')
      else if (pr.note) line = pr.note
      else line = 'Working… ' + secs + 's'
      el.querySelector('.dgc-prog').textContent = line
      const sum = el.querySelector('summary')
      sum.textContent = 'Thinking · ' + secs + 's'
    })
    if (atBottom) list.scrollTop = list.scrollHeight
  })
}

export function setupDiagramChat(editor) {
  ed = editor
  const p = $('dgChat')
  if (!p) return
  const input = $('dgChatInput')
  const send = () => {
    if (!panelId) return
    const t = input.value.trim()
    if (!t && !attached.length) return
    const imgs = attached.filter((a) => a.img).map((a) => a.img), thumbs = attached.filter((a) => a.img).map((a) => a.thumb)
    const files = attached.filter((a) => a.file).map((a) => a.file)
    const keep = attached
    input.value = ''
    attached = []
    paintAttached()
    submit(editor, panelId, t, imgs, thumbs, { files }).then((ok) => {
      if (ok || input.value || attached.length) return
      input.value = t; attached = keep; paintAttached() // not sent: put it back
    })
  }
  // Send now (while Claude works): stop what it's doing and start again with this message
  // plus any it hadn't answered yet, instead of waiting in the queue. ⌘Enter does the same.
  const sendNow = async () => {
    if (!panelId) return
    const t = input.value.trim()
    if (!t && !attached.length) return
    if (!isPending(panelId)) { send(); return }
    const did = panelId
    if (!(await serverReady())) { toast(OLD_SERVER); return }
    const hit = findById(editor, did)
    const live_ = new Set([...jobs.values()].filter((j) => j.did === did && live(j)).map((j) => j.id))
    const earlier = hit ? parseChat(hit.node.attrs.chat).filter((m) => m.r === 'u' && live_.has(m.j)).map((m) => m.t).filter((x) => x && !/^\(see the attached/.test(x)) : []
    live_.forEach((id) => interrupted.add(id))
    const imgs = attached.filter((a) => a.img).map((a) => a.img), thumbs = attached.filter((a) => a.img).map((a) => a.thumb)
    const files = attached.filter((a) => a.file).map((a) => a.file)
    const keep = attached
    input.value = ''
    attached = []
    paintAttached()
    try { await api('POST', '/api/diagram/stop', { did }) } catch (e) { toast(e.message); input.value = t; attached = keep; paintAttached(); return }
    const prompt = earlier.length
      ? 'Earlier message' + (earlier.length > 1 ? 's' : '') + ' I sent while you were working (you hadn\'t answered yet):\n' + earlier.map((x) => '- ' + x).join('\n') + '\n\nNew message: ' + (t || '(see the attachments)')
      : t
    // a new diagram that was still being drawn: start it from scratch, not from the placeholder
    const fresh = hit && hit.node.attrs.html === PLACEHOLDER
    submit(editor, did, prompt, imgs, thumbs, { files, shown: t, html: fresh ? '' : undefined })
  }
  const nowBtn = $('dgChatNow')
  if (nowBtn) nowBtn.addEventListener('click', sendNow)

  // Stop: Claude stops the answer it's writing for this diagram and drops the queued ones;
  // the diagram stays as it was
  const stopBtn = $('dgChatStop')
  if (stopBtn) stopBtn.addEventListener('click', () => {
    if (!panelId) return
    const did = panelId
    serverReady().then((ok) => {
      if (!ok) { toast(OLD_SERVER); return }
      stopBtn.hidden = true
      api('POST', '/api/diagram/stop', { did }).catch((e) => { toast(e.message); lastSig = ''; render() })
    })
  })
  const fileIn = $('dgChatFile')
  $('dgChatAttach').addEventListener('click', () => fileIn.click())
  fileIn.addEventListener('change', () => { const fs = Array.from(fileIn.files || []); fileIn.value = ''; attach(fs); input.focus() })
  $('dgChatSend').addEventListener('click', send)
  $('dgChatClose').addEventListener('click', closeChat)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNow() }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); editor.commands.focus() }
  })
  // paste or drop pictures (screenshots, sketches) to show Claude what you mean
  input.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || [])
    const t = e.clipboardData && e.clipboardData.getData('text/plain')
    if (!files.length && t && t.length > PASTE_AS_FILE) { e.preventDefault(); attached.push(pastedAsFile(t)); paintAttached(); return }
    if (!files.length) return
    e.preventDefault()
    attach(files)
  })
  p.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); p.classList.add('dgc-drop') } })
  p.addEventListener('dragleave', (e) => { if (!p.contains(e.relatedTarget)) p.classList.remove('dgc-drop') })
  p.addEventListener('drop', (e) => {
    p.classList.remove('dgc-drop')
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (!files.length) return
    e.preventDefault()
    attach(files)
  })
  $('dgChatAtt').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]')
    if (!b) return
    attached.splice(+b.dataset.i, 1)
    paintAttached()
  })
  $('dgChatList').addEventListener('click', (e) => {
    const b = e.target.closest('.dgc-restore')
    if (!b) return
    const hit = findById(editor, panelId)
    const m = hit && parseChat(hit.node.attrs.chat)[+b.dataset.i]
    if (!m || !m.h) return
    editor.view.dispatch(editor.state.tr.setNodeAttribute(hit.pos, 'html', m.h))
    toast('Restored that version · ⌘Z to undo')
  })
  // keep the panel in step: answers landing redraw it; selecting another diagram switches
  // to its conversation
  editor.on('transaction', ({ transaction }) => {
    if (!panelOpen()) return
    const n = editor.state.selection.node
    if (n && n.type.name === 'htmlEmbed' && n.attrs.did && n.attrs.did !== panelId) { panelId = n.attrs.did; lastSig = ''; render(); return }
    if (transaction.docChanged) render()
  })
  // pick up anything Claude is doing or has done (a reload mid-answer lands here), and
  // keep checking while an answer waits for its draft to be opened
  syncJobs()
  setInterval(() => { if (waiting.size) syncJobs() }, 4000)
}
