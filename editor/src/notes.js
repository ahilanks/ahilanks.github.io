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
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); indent(e.shiftKey) }
  })

  // Tab indents (Shift+Tab outdents) instead of leaving the note: at the caret, or every
  // line a selection touches. Edits go through insertText so ⌘Z undoes them.
  function indent(out) {
    const v = text.value, s = text.selectionStart, e = text.selectionEnd
    if (!out && s === e) { document.execCommand('insertText', false, '\t'); return }
    const from = v.lastIndexOf('\n', s - 1) + 1
    const to = e > s && v[e - 1] === '\n' ? e - 1 : e // a selection ending at a line start leaves that line alone
    const lines = v.slice(from, to).split('\n')
    const next = lines.map((l) => out ? l.replace(/^(\t| {1,4})/, '') : '\t' + l)
    const lead = next[0].length - lines[0].length // how far the first line moved
    const changed = next.join('\n')
    if (changed === v.slice(from, to)) return
    text.setSelectionRange(from, to)
    document.execCommand('insertText', false, changed)
    const caret = Math.max(from, s + lead)
    text.setSelectionRange(caret, s === e ? caret : from + changed.length + (e - to))
  }

  let open = false
  try { open = localStorage.getItem(OPEN_KEY) === '1' } catch (e) { /* closed */ }
  setOpen(open)

  return {
    get: () => text.value,
    set(v) { text.value = v || ''; refreshBadge(); if (!panel.hidden) grow() },
  }
}
