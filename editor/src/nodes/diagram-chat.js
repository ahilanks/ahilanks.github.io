/* diagram-chat.js — talk to Claude about a diagram, in a panel on the right.
 *
 * Each diagram keeps its own conversation (node attr `chat`, saved in the draft, never
 * published): what you asked, what Claude said it did, and the diagram each answer made,
 * so an earlier one can be restored. Requests run in the background — the diagram stays
 * usable and you keep writing; a small tag on it shows Claude is working. The editor server
 * (diagram_ai.py) asks Claude Opus 5.5 with the site's house style.
 *
 * A diagram's change is one ⌘Z-able step; chat updates stay out of the undo history.
 */
import { $, toast } from '../dom.js'

const KEEP_VERSIONS = 8 // older answers keep their words, not their diagram

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

export async function askClaude(body) {
  let res
  try {
    res = await fetch('/api/diagram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch (e) { throw new Error('The editor server isn\'t reachable.') }
  let out = null
  try { out = await res.json() } catch (e) {}
  if (!out || !out.ok) throw new Error((out && out.error) || 'Something went wrong (' + res.status + ').')
  return out
}

/* ------------------------------------------------------------ pending requests */
const pending = new Map() // diagram id -> { t0, text }
export const isPending = (id) => pending.has(id)
export function pendingSince(id) { const p = pending.get(id); return p ? p.t0 : 0 }
function announce() { window.dispatchEvent(new CustomEvent('diagram-pending')) }

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

/* ------------------------------------------------------------ sending a message */
async function send(editor, id, text) {
  text = text.trim()
  const hit = findById(editor, id)
  if (!text || !hit || pending.has(id)) return
  const chat = parseChat(hit.node.attrs.chat)
  const history = chat.slice(-12).map((m) => ({ role: m.r === 'u' ? 'user' : 'assistant', text: m.t }))
  chat.push({ r: 'u', t: text, at: new Date().toISOString() })
  setChat(editor, id, chat)
  pending.set(id, { t0: Date.now(), text })
  announce()
  render()
  try {
    const before = findById(editor, id)
    const out = await askClaude({ prompt: text, html: before.node.attrs.html, history, context: contextAround(editor, before.pos) })
    const now = findById(editor, id)
    if (!now) throw new Error('That diagram was removed while Claude worked.')
    const after = parseChat(now.node.attrs.chat)
    if (out.html) {
      editor.view.dispatch(editor.state.tr.setNodeAttribute(now.pos, 'html', out.html)) // ⌘Z-able
      after.push({ r: 'a', t: out.note || 'Done.', at: new Date().toISOString(), h: out.html })
    } else {
      after.push({ r: 'a', t: out.note || 'No change.', at: new Date().toISOString() })
    }
    setChat(editor, id, after)
    if (!panelOpen() || panelId !== id) toast(out.html ? 'Diagram changed · ⌘Z to undo' : 'Claude replied about the diagram')
  } catch (e) {
    const now = findById(editor, id)
    if (now) {
      const after = parseChat(now.node.attrs.chat)
      after.push({ r: 'e', t: e.message, at: new Date().toISOString() })
      setChat(editor, id, after)
    }
    toast(e.message)
  } finally {
    pending.delete(id)
    announce()
    render()
  }
}

/* ------------------------------------------------------------ a new diagram from the </> popover */
// Its first chat turn is the description; the answer becomes the diagram, the caption its caption.
export async function generateInto(editor, at, prompt) {
  const out = await askClaude({ prompt, context: contextAround(editor, at.pos) })
  const $p = editor.state.doc.resolve(Math.min(at.pos, editor.state.doc.content.size))
  const pos = $p.depth ? $p.after(1) : at.pos // after the paragraph the cursor was in
  const t = new Date().toISOString()
  const chat = [{ r: 'u', t: prompt, at: t }, { r: 'a', t: out.note || 'Here’s a first version.', at: t, h: out.html }]
  const node = {
    type: 'htmlEmbed',
    attrs: { html: out.html, did: newId(), chat: JSON.stringify(chat) },
    content: out.caption ? [{ type: 'text', text: out.caption }] : [],
  }
  editor.chain().insertContentAt(pos, node).run()
}

/* ------------------------------------------------------------ the panel */
let ed = null
let panelId = null
let tick = 0
const panelOpen = () => { const p = $('dgChat'); return !!p && !p.hidden }

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function when(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function openChat(editor, id) {
  ed = editor
  panelId = id
  lastSig = ''
  const p = $('dgChat')
  if (!p) return
  p.hidden = false
  document.body.classList.add('dg-chat-open')
  render()
  setTimeout(() => { const i = $('dgChatInput'); if (i) i.focus() }, 0)
}
function closeChat() {
  lastSig = ''
  const p = $('dgChat')
  if (p) p.hidden = true
  document.body.classList.remove('dg-chat-open')
  panelId = null
  clearInterval(tick)
}

let lastSig = ''
function render() {
  const p = $('dgChat')
  if (!p || p.hidden || !ed) return
  const list = $('dgChatList'), input = $('dgChatInput'), go = $('dgChatSend')
  const hit = panelId && findById(ed, panelId)
  // redraw only when this diagram's conversation (or its state) actually changed
  const sig = hit ? panelId + '|' + hit.node.attrs.chat + '|' + hit.node.attrs.html.length + '|' + pending.has(panelId) : 'none'
  if (sig === lastSig && list.childElementCount) return
  lastSig = sig
  clearInterval(tick)
  if (!hit) {
    list.innerHTML = '<p class="dgc-empty">Select a diagram and click <b>Chat</b> to talk to Claude about it.</p>'
    input.disabled = go.disabled = true
    return
  }
  const chat = parseChat(hit.node.attrs.chat)
  const current = hit.node.attrs.html
  let h = chat.length ? '' : '<p class="dgc-empty">Ask for a change, like “smaller labels” or “make the danger zone orange”. Each change can be undone with ⌘Z.</p>'
  chat.forEach((m, i) => {
    const cls = m.r === 'u' ? 'dgc-you' : m.r === 'e' ? 'dgc-err' : 'dgc-claude'
    h += '<div class="dgc-msg ' + cls + '"><div class="dgc-text">' + esc(m.t) + '</div><div class="dgc-meta">' + esc(when(m.at)) +
      (m.h ? (m.h === current ? ' · <span class="dgc-cur">showing</span>' : ' · <button type="button" class="dgc-restore" data-i="' + i + '">Restore this version</button>') : '') +
      '</div></div>'
  })
  if (pending.has(panelId)) h += '<div class="dgc-msg dgc-claude dgc-wait"><div class="dgc-text" id="dgcWait"></div></div>'
  list.innerHTML = h
  list.scrollTop = list.scrollHeight
  const busy = pending.has(panelId)
  input.disabled = false
  go.disabled = busy
  input.placeholder = busy ? 'Claude is working… you can keep writing' : 'Ask for a change…'
  if (busy) {
    const w = $('dgcWait'), t0 = pendingSince(panelId)
    const upd = () => { if (w) w.textContent = 'Working on it… ' + Math.round((Date.now() - t0) / 1000) + 's' }
    upd()
    tick = setInterval(upd, 1000)
  }
}

export function setupDiagramChat(editor) {
  ed = editor
  const p = $('dgChat')
  if (!p) return
  const input = $('dgChatInput')
  const submit = () => {
    if (!panelId || pending.has(panelId)) return
    const t = input.value
    if (!t.trim()) return
    input.value = ''
    send(editor, panelId, t)
  }
  $('dgChatSend').addEventListener('click', submit)
  $('dgChatClose').addEventListener('click', closeChat)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); editor.commands.focus() }
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
  // keep the panel in step: the chat updates as answers land; selecting another diagram
  // switches to its conversation
  editor.on('transaction', ({ transaction }) => {
    if (!panelOpen()) return
    const sel = editor.state.selection
    const n = sel.node
    if (n && n.type.name === 'htmlEmbed' && n.attrs.did && n.attrs.did !== panelId) { panelId = n.attrs.did; render(); return }
    if (transaction.docChanged) render()
  })
}
