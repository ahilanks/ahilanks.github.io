/* dom.js — tiny DOM + string helpers shared across modules. */

export const $ = (id) => document.getElementById(id)

export const debounce = (fn, ms) => {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

export const escapeHtml = (s) =>
  (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const slugify = (s) =>
  (s || 'untitled').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60) || 'untitled'

export const uid = () => 'n' + Math.random().toString(36).slice(2, 9)

export const todayLong = () => {
  const d = new Date()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + String(d.getFullYear()).slice(-2)
}

let _toastTimer
export function toast(msg) {
  const t = $('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}
