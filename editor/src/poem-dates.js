/* poem-dates.js — Style → Kind: Poem → Dates: Under each poem. Each poem in a collection gets
 * its own date, typed into a small field under its heading. The date is the heading's `date`
 * attr (data-date, section-links.js); publish.js writes it as a line under the heading.
 *
 * Which headings are poems: the top level of heading the draft uses (a collection whose poems
 * are H2s shows a field under each H2, not under H3s inside them).
 */

import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/lib.bundle.js'

const key = new PluginKey('poemDates')

export function setPoemDates(editor, on) {
  if (!editor || editor.isDestroyed || key.getState(editor.state).on === on) return
  editor.view.dispatch(editor.state.tr.setMeta(key, on).setMeta('addToHistory', false))
}

function field(view, getPos, date) {
  const wrap = document.createElement('div')
  wrap.className = 'poem-date-w'
  wrap.contentEditable = 'false'
  const input = document.createElement('input')
  input.className = 'poem-date-in'
  input.placeholder = 'Add a date'
  input.value = date || ''
  input.spellcheck = false
  const save = () => {
    const at = getPos()
    if (typeof at !== 'number') return
    const $at = view.state.doc.resolve(at)
    const h = $at.nodeBefore
    if (!h || h.type.name !== 'heading') return
    const v = input.value.trim() || null
    if (v === (h.attrs.date || null)) return
    view.dispatch(view.state.tr.setNodeAttribute(at - h.nodeSize, 'date', v))
  }
  input.addEventListener('blur', save)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      if (e.key === 'Escape') input.value = date || ''
      input.blur()
      view.focus()
    }
  })
  wrap.append(input)
  return wrap
}

export const PoemDates = Extension.create({
  name: 'poemDates',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ on: false }),
        apply: (tr, prev) => { const m = tr.getMeta(key); return m == null ? prev : { on: m } },
      },
      props: {
        decorations(state) {
          if (!key.getState(state).on) return null
          let top = 9
          state.doc.descendants((n) => { if (n.type.name === 'heading') top = Math.min(top, n.attrs.level) })
          const decos = []
          state.doc.descendants((n, pos) => {
            if (n.type.name !== 'heading') return
            if (n.attrs.level !== top && !n.attrs.date) return false
            const at = pos + n.nodeSize
            decos.push(Decoration.widget(at, (view, getPos) => field(view, getPos, n.attrs.date), {
              side: -1, key: 'pd:' + (n.attrs.date || ''), ignoreSelection: true, stopEvent: () => true,
            }))
            return false
          })
          return DecorationSet.create(state.doc, decos)
        },
      },
    })]
  },
})
