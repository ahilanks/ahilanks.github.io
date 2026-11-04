/* style.js — the toolbar's Style button: choices that belong to one article and change how
 * it looks, not what it says. They are saved with the draft (snapshot `style`, holding only
 * what differs from the default) and read by publish.js; they never touch the text, so they
 * don't change the published version's fingerprint.
 *
 * To add a choice, add an entry to STYLE_OPTIONS: the panel, saving and publishing's "has the
 * style changed?" check all follow from it. Then use the value wherever it applies.
 */

import { $ } from './dom.js'

export const STYLE_OPTIONS = [
  {
    key: 'footnotes',
    label: 'Footnotes',
    def: 'bottom',
    choices: [{ value: 'bottom', label: 'Bottom' }, { value: 'margin', label: 'Right margin' }],
    hint: { margin: 'Narrow screens show them at the bottom.' },
  },
]

// Only known keys with non-default values, in STYLE_OPTIONS order.
export function normalizeStyle(style) {
  const out = {}
  for (const o of STYLE_OPTIONS) {
    const v = style && style[o.key]
    if (v !== o.def && o.choices.some((c) => c.value === v)) out[o.key] = v
  }
  return out
}

// A stable one-line form, written on the published page ('' = all defaults).
export function styleKey(style) {
  return Object.entries(normalizeStyle(style)).map(([k, v]) => k + '=' + v).join(';')
}

/**
 * @param {{ onChange: () => void, apply: (style: object) => void }} deps
 *   onChange — the writer picked something (save the draft); apply — show `style` in the editor
 * @returns {{ get: () => object, set: (style: object) => void }}
 */
export function setupStyle({ onChange, apply }) {
  const btn = $('styleBtn')
  let style = {}

  const panel = document.createElement('div')
  panel.className = 'popover hidden'
  panel.id = 'stylePanel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Article style')
  const head = document.createElement('div')
  head.className = 'style-head'
  head.textContent = 'Style for this article'
  panel.appendChild(head)

  const rows = STYLE_OPTIONS.map((o) => {
    const row = document.createElement('div')
    row.className = 'style-row'
    const name = document.createElement('div')
    name.className = 'style-name'
    name.textContent = o.label
    const seg = document.createElement('div')
    seg.className = 'seg'
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', o.label)
    const buttons = o.choices.map((c) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = c.label
      b.addEventListener('click', () => {
        style = normalizeStyle({ ...style, [o.key]: c.value })
        refresh()
        apply(style)
        onChange()
      })
      seg.appendChild(b)
      return { b, value: c.value }
    })
    const hint = document.createElement('div')
    hint.className = 'style-hint'
    row.append(name, seg, hint)
    panel.appendChild(row)
    return { o, buttons, hint }
  })
  document.body.appendChild(panel)

  function refresh() {
    rows.forEach(({ o, buttons, hint }) => {
      const cur = style[o.key] || o.def
      buttons.forEach(({ b, value }) => {
        b.classList.toggle('active', value === cur)
        b.setAttribute('aria-pressed', String(value === cur))
      })
      hint.textContent = (o.hint && o.hint[cur]) || ''
      hint.hidden = !hint.textContent
    })
  }

  function close() { panel.classList.add('hidden'); btn.classList.remove('active') }
  function open() {
    refresh()
    panel.classList.remove('hidden')
    btn.classList.add('active')
    const r = btn.getBoundingClientRect()
    const half = panel.offsetWidth / 2
    panel.style.left = Math.max(half + 10, Math.min(r.left + r.width / 2, window.innerWidth - half - 10)) + 'px'
    panel.style.top = (r.bottom + 8) + 'px'
  }
  // keep the caret where it is while the panel is used
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  panel.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', () => { panel.classList.contains('hidden') ? open() : close() })
  document.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target) && !btn.contains(e.target)) close()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  window.addEventListener('resize', close)

  return {
    get: () => ({ ...style }),
    set(next) { style = normalizeStyle(next); refresh(); apply(style) },
  }
}
