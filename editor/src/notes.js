/* notes.js — the draft's sticky note: a single plain-text scratchpad pinned top-right for
 * to-dos and open questions. Its text is part of the draft snapshot (`notes`), so it is
 * saved, synced and backed up with the draft and never published. Open/closed is a
 * per-browser convenience kept in localStorage.
 */

import { $ } from './dom.js'

const OPEN_KEY = 'editor.notesOpen'

export function setupNotes({ onChange }) {
  const panel = $('notesPanel'), text = $('notesText'), toggle = $('notesToggle'), close = $('notesClose')

  // the textarea grows with its text (the panel caps it and scrolls past that)
  const grow = () => { text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px' }
  const refreshBadge = () => {
    const n = text.value.split('\n').filter((l) => l.trim()).length
    toggle.dataset.count = n ? String(n) : ''
  }

  function setOpen(open, { focus = false } = {}) {
    panel.hidden = !open
    toggle.classList.toggle('on', open)
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch (e) { /* storage off: still works */ }
    if (open) { grow(); if (focus) text.focus() }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden, { focus: true }))
  close.addEventListener('click', () => setOpen(false))
  text.addEventListener('input', () => { grow(); refreshBadge(); onChange() })
  text.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } })

  let open = false
  try { open = localStorage.getItem(OPEN_KEY) === '1' } catch (e) { /* closed */ }
  setOpen(open)

  return {
    get: () => text.value,
    set(v) { text.value = v || ''; refreshBadge(); if (!panel.hidden) grow() },
  }
}
