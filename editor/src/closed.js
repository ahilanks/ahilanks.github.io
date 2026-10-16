/* closed.js — History (toolbar clock), two tabs:
 *
 *   Comments — every comment you've left on this draft: the open ones (in document order;
 *              click to jump to it), then every resolved one, newest first, each with
 *              Reopen; then AI suggestions dismissed / cleared / replaced this session.
 *   Versions — the draft at each push to the drafts repo (versions.js): pick one to see
 *              what changed since, and restore it.
 *
 * The lists themselves live with their owners (comments.js: saved with the draft;
 * ai-suggest.js: this session only, like the suggestions). Each closed source gives:
 *   list()      → [{ key, kind, label, how, text, quote, closedAt, canReopen }]
 *   reopen(key) → true, or a message saying why it couldn't
 * and `comments` gives openList() → [{ id, text, created, quote }] and show(id).
 */

import { $, toast, escapeHtml } from './dom.js'

function when(t) {
  const d = new Date(t || Date.now())
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function setupClosedList(sources, comments, getVersions) {
  const btn = $('closedBtn')
  const menu = $('closedMenu')
  const list = $('closedList')
  const foot = $('closedFoot')
  if (!btn || !menu || !list) return {}
  let tab = 'comment'

  const closedOf = (kind) => sources
    .flatMap((src) => src.list().map((e) => ({ ...e, src })))
    .filter((e) => (kind === 'comment' ? e.kind === 'comment' : e.kind !== 'comment'))
    .sort((a, b) => b.closedAt - a.closedAt)

  function row(e) {
    const el = document.createElement('div')
    el.className = 'cl-row cl-' + e.kind + (e.canReopen || e.open ? '' : ' cl-stale') + (e.open ? ' cl-open' : '')
    const action = e.open ? '<span class="cl-jump">Go to</span>'
      : e.canReopen ? '<button type="button" class="cl-reopen">Reopen</button>'
      : '<span class="cl-gone" title="Its text has changed since">text changed</span>'
    el.innerHTML =
      '<div class="cl-top"><span class="cl-kind">' + escapeHtml(e.label) + '</span>' +
      '<span class="cl-when">' + escapeHtml(e.how) + ' · ' + when(e.closedAt) + '</span>' + action + '</div>' +
      '<div class="cl-text">' + escapeHtml(clip(e.text || '', 600)) + '</div>' +
      (e.quote ? '<div class="cl-quote">on “' + escapeHtml(clip(e.quote.replace(/\s+/g, ' '), 140)) + '”</div>' : '')
    if (e.open) {
      el.addEventListener('click', () => { if (comments.show(e.key)) close(); else toast('Couldn’t find it'); })
    } else {
      const b = el.querySelector('.cl-reopen')
      if (b) b.addEventListener('click', () => {
        const ok = e.src.reopen(e.key)
        if (ok === true) close()
        else { toast(ok); render() }
      })
    }
    return el
  }

  function section(title) {
    const h = document.createElement('div')
    h.className = 'cl-section'
    h.textContent = title
    list.appendChild(h)
  }

  function render() {
    menu.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
    list.textContent = ''
    if (tab === 'comment') {
      const open = (comments && comments.openList ? comments.openList() : [])
        .map((c) => ({ key: c.id, kind: 'comment', label: 'Comment', how: 'Open', text: c.text, quote: c.quote, closedAt: c.created, open: true }))
      const resolved = closedOf('comment')
      const ai = closedOf('ai')
      if (!open.length && !resolved.length && !ai.length) {
        list.innerHTML = '<div class="cl-empty">No comments on this draft yet. Comments you leave — open or resolved — are listed here.</div>'
      } else {
        if (open.length) { section('Open · ' + open.length); open.forEach((e) => list.appendChild(row(e))) }
        if (resolved.length) { section('Resolved · ' + resolved.length); resolved.forEach((e) => list.appendChild(row(e))) }
        if (ai.length) { section('Closed AI suggestions · ' + ai.length); ai.forEach((e) => list.appendChild(row(e))) }
      }
      if (foot) foot.textContent = 'Comments are saved with the draft. Reopen puts one back on its words. (AI suggestions last until you reload.)'
    } else {
      const v = getVersions && getVersions()
      if (!v) list.innerHTML = '<div class="cl-empty">Versions aren’t available.</div>'
      else v.renderInto(list, close)
      if (foot) foot.textContent = 'A version is saved at every backup. Pick one to see what changed since.'
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

  menu.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render() }))
  // mousedown + preventDefault: keep the editor's selection (Reopen can use it as the
  // place to attach a comment whose words are gone)
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else close() })
  menu.addEventListener('mousedown', (e) => e.preventDefault())
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !btn.contains(e.target)) close()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) close() })

  return { open, close, render } // exposed for console debugging
}
