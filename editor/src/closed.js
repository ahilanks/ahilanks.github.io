/* closed.js — "Recently closed": the comments you resolved and the AI suggestions that
 * were dismissed, cleared or replaced by a newer Review run, newest first, each with
 * Reopen — for when one was closed by mistake.
 *
 * The lists themselves live with their owners (comments.js: saved with the draft;
 * ai-suggest.js: this session only, like the suggestions). Each gives a source:
 *   list()      → [{ key, kind, label, how, text, quote, closedAt, canReopen }]
 *   reopen(key) → true, or a message saying why it couldn't
 */

import { $, toast, escapeHtml } from './dom.js'

const SHOW = 30

function when(t) {
  const d = new Date(t || Date.now())
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function setupClosedList(sources) {
  const btn = $('closedBtn')
  const menu = $('closedMenu')
  const list = $('closedList')
  if (!btn || !menu || !list) return {}

  const entries = () => sources
    .flatMap((src) => src.list().map((e) => ({ ...e, src })))
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, SHOW)

  function render() {
    const all = entries()
    list.textContent = ''
    if (!all.length) {
      list.innerHTML = '<div class="cl-empty">Nothing closed yet. Comments you resolve and AI suggestions you dismiss show up here, so you can bring them back.</div>'
      return
    }
    for (const e of all) {
      const row = document.createElement('div')
      row.className = 'cl-row cl-' + e.kind + (e.canReopen ? '' : ' cl-stale')
      row.innerHTML =
        '<div class="cl-top"><span class="cl-kind">' + escapeHtml(e.label) + '</span>' +
        '<span class="cl-when">' + escapeHtml(e.how) + ' · ' + when(e.closedAt) + '</span>' +
        (e.canReopen ? '<button type="button" class="cl-reopen">Reopen</button>' : '<span class="cl-gone" title="Its text has changed since">text changed</span>') +
        '</div>' +
        '<div class="cl-text">' + escapeHtml(clip(e.text || '', 220)) + '</div>' +
        (e.quote ? '<div class="cl-quote">on “' + escapeHtml(clip(e.quote.replace(/\s+/g, ' '), 90)) + '”</div>' : '')
      const b = row.querySelector('.cl-reopen')
      if (b) b.addEventListener('click', () => {
        const ok = e.src.reopen(e.key)
        if (ok === true) close()
        else { toast(ok); render() }
      })
      list.appendChild(row)
    }
  }

  function open() {
    render()
    menu.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = menu.offsetWidth
    menu.style.top = (r.bottom + 6) + 'px'
    menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px'
    btn.classList.add('active')
  }
  function close() { menu.classList.add('hidden'); btn.classList.remove('active') }

  // mousedown + preventDefault: keep the editor's selection (Reopen can use it as the
  // place to attach a comment whose words are gone)
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else close() })
  menu.addEventListener('mousedown', (e) => e.preventDefault())
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !btn.contains(e.target)) close()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) close() })

  return { open, close, entries } // exposed for console debugging
}
