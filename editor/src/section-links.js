/* section-links.js — links that jump to a section (heading) of the same article.
 *
 * A heading gets a stable `anchor` attr (data-anchor) the first time something links to
 * it, so renaming the heading never breaks the link. The link itself is an ordinary link
 * mark with href "#<anchor>"; publish.js turns data-anchor into the heading's id.
 */

import { Extension } from '../vendor/lib.bundle.js'
import { $ } from './dom.js'

export const HeadingAnchor = Extension.create({
  name: 'headingAnchor',
  addGlobalAttributes() {
    return [{
      types: ['heading'],
      attributes: {
        anchor: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-anchor') || null,
          renderHTML: (attrs) => (attrs.anchor ? { 'data-anchor': attrs.anchor } : {}),
        },
      },
    }]
  },
})

// Every non-empty heading in the doc: [{ pos, node, text, level, anchor }]
export function docHeadings(editor) {
  const out = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim()
      if (text) out.push({ pos, node, text, level: node.attrs.level, anchor: node.attrs.anchor })
    }
    return node.isBlock && node.type.name !== 'heading'
  })
  return out
}

export const anchorOf = (href) => (/^#[\w-]+$/.test(href || '') ? href.slice(1) : null)

export function headingForHref(editor, href) {
  const a = anchorOf(href)
  return a ? docHeadings(editor).find((h) => h.anchor === a) || null : null
}

// The heading's anchor, or a fresh one for it ("sec-" + its text, deduped) if it has none
// yet — the caller stores a fresh one on the heading in the same transaction as the link.
export function anchorFor(editor, heading) {
  if (heading.anchor) return heading.anchor
  const used = new Set(docHeadings(editor).map((h) => h.anchor).filter(Boolean))
  const base = heading.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section'
  let a = 'sec-' + base
  for (let i = 2; used.has(a); i++) a = 'sec-' + base + '-' + i
  return a
}

// Scroll the editor to the heading an "#anchor" href points at and flash it.
export function jumpToSection(editor, href) {
  const h = headingForHref(editor, href)
  const el = h && editor.view.nodeDOM(h.pos)
  const scroll = $('scrollArea')
  if (!el || !scroll) return false
  const top = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
  scroll.scrollTo({ top: Math.max(0, top - 90), behavior: 'smooth' })
  // a Web Animation, not a class: an attribute change on a heading would read to
  // ProseMirror's DOM observer as an edit of it
  if (el.animate) {
    el.animate([{ backgroundColor: 'rgba(15, 122, 229, 0.16)' }, { backgroundColor: 'rgba(15, 122, 229, 0)' }],
      { duration: 1800, delay: 250, easing: 'ease-out', fill: 'backwards' })
  }
  return true
}
