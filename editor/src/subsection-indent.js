// Everything under a sub-subheading (H4/H5) sits slightly in, up to the next H2/H3, so
// the reader sees the level at a glance. A node decoration adds .in-sub to each top-level
// block in such a run (the saved HTML stays clean); publish.js marks the same blocks.
import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/lib.bundle.js'

const key = new PluginKey('subsectionIndent')

function build(doc) {
  const decos = []
  let on = false
  doc.forEach((n, pos) => {
    if (n.type.name === 'heading') on = n.attrs.level >= 4
    if (on) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'in-sub' }))
  })
  return DecorationSet.create(doc, decos)
}

// the same rule over published HTML: top-level elements of the article body
export function markSubsections(root) {
  let on = false
  for (const el of Array.from(root.children)) {
    if (/^H[1-6]$/.test(el.tagName)) on = +el.tagName[1] >= 4
    if (on) el.classList.add('in-sub')
  }
}

export const SubsectionIndent = Extension.create({
  name: 'subsectionIndent',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: { init: (_, s) => build(s.doc), apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old) },
      props: { decorations: (s) => key.getState(s) },
    })]
  },
})
