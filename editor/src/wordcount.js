/* wordcount.js — word count pinned to the bottom-left of the write view.
 *
 * The pill shows the body's word count (or "N of M words" while text is selected).
 * Hovering or focusing it opens a details card: reading time, characters, paragraphs,
 * sentences, footnotes, equations, figures, links, and a per-section breakdown keyed
 * to the same top heading level the contents panel numbers as §1, §2, ….
 *
 * Words are counted from the ProseMirror doc (math, footnote refs and figures count as
 * separators, not words); footnote words come from the #fnList DOM, which lives outside PM.
 */

import { $, debounce } from './dom.js'

const WPM = 238 // average adult silent-reading speed
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu

const countWords = (s) => (s.match(WORD_RE) || []).length
const countSentences = (s) => (s.match(/[^.!?]*[\p{L}\p{N}][^.!?]*(?:[.!?]+|$)/gu) || []).length
const fmt = (n) => n.toLocaleString('en-US')
const plural = (n, one, many = one + 's') => fmt(n) + ' ' + (n === 1 ? one : many)

function readingTime(words) {
  if (!words) return '—'
  const min = words / WPM
  return min < 1 ? '< 1 min' : '~' + Math.round(min) + ' min'
}

export function setupWordCount(editor) {
  const wrap = document.createElement('div')
  wrap.className = 'wc'
  wrap.innerHTML =
    '<div class="wc-card" role="tooltip" id="wcCard"></div>' +
    '<button type="button" class="wc-pill" aria-describedby="wcCard"></button>'
  document.body.appendChild(wrap)
  const pill = wrap.querySelector('.wc-pill')
  const card = wrap.querySelector('.wc-card')
  pill.addEventListener('mousedown', (e) => e.preventDefault()) // don't steal editor focus
  pill.addEventListener('click', () => wrap.classList.toggle('open')) // touch: tap to open
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open') })

  let total = 0

  function stats() {
    const doc = editor.state.doc
    const text = (node) => node.textBetween(0, node.content.size, ' ', ' ')
    const s = { words: 0, chars: 0, charsNoSpace: 0, paragraphs: 0, sentences: 0,
      inlineMath: 0, blockMath: 0, figures: 0, links: new Set(), sections: [] }

    // section level = the top heading level actually used (matches toc.js numbering)
    let top = 7
    doc.descendants((n) => { if (n.type.name === 'heading') top = Math.min(top, n.attrs.level) })
    let sec = null

    doc.forEach((node) => {
      if (node.type.name === 'heading' && node.attrs.level === top) {
        sec = { title: node.textContent.trim() || 'Untitled section', words: 0 }
        s.sections.push(sec)
      }
      const t = text(node)
      const w = countWords(t)
      s.words += w
      s.chars += t.length
      s.charsNoSpace += t.replace(/\s/g, '').length
      if (sec && node.type.name !== 'heading') sec.words += w
      else if (!sec && w && node.type.name !== 'heading') {
        sec = { title: 'Intro', words: w, intro: true }
        s.sections.push(sec)
      }
    })

    doc.descendants((n) => {
      const name = n.type.name
      if (name === 'paragraph' && n.textContent.trim()) {
        s.paragraphs++
        s.sentences += countSentences(n.textContent)
      } else if (name === 'inlineMath') s.inlineMath++
      else if (name === 'blockMath') s.blockMath++
      else if (name === 'figure') s.figures++
      if (n.isText) n.marks.forEach((m) => { if (m.type.name === 'link' && m.attrs.href) s.links.add(m.attrs.href) })
    })

    // only footnotes the text still references (#fnList can briefly hold orphans)
    const refs = new Set()
    doc.descendants((n) => { if (n.type.name === 'footnoteRef') refs.add(n.attrs.fnId) })
    const fnBodies = Array.from(document.querySelectorAll('#fnList li[data-fn]'))
      .filter((li) => refs.has(li.getAttribute('data-fn')))
      .map((li) => li.querySelector('.fn-body')).filter(Boolean)
    s.footnotes = fnBodies.length
    s.footnoteWords = fnBodies.reduce((a, b) => a + countWords(b.textContent || ''), 0)
    return s
  }

  function selectionWords() {
    const { from, to, empty } = editor.state.selection
    return empty ? 0 : countWords(editor.state.doc.textBetween(from, to, ' ', ' '))
  }

  function renderPill() {
    const sel = selectionWords()
    pill.textContent = sel ? fmt(sel) + ' of ' + plural(total, 'word') : plural(total, 'word')
  }

  const row = (label, value) => `<div class="wc-row"><span>${label}</span><b>${value}</b></div>`
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')

  function refresh() {
    const s = stats()
    total = s.words
    renderPill()

    const avg = s.sentences ? Math.round(s.words / s.sentences) : 0
    let html =
      `<div class="wc-head"><span class="wc-big">${fmt(s.words)}</span> words` +
      `<span class="wc-time">${readingTime(s.words)} read</span></div>` +
      '<div class="wc-grid">' +
      row('Characters', fmt(s.chars)) +
      row('Without spaces', fmt(s.charsNoSpace)) +
      row('Paragraphs', fmt(s.paragraphs)) +
      row('Sentences', fmt(s.sentences)) +
      row('Words / sentence', avg ? fmt(avg) : '—') +
      row('Footnotes', s.footnotes ? `${fmt(s.footnotes)} · ${plural(s.footnoteWords, 'word')}` : '0') +
      row('Equations', s.inlineMath + s.blockMath
        ? `${fmt(s.inlineMath)} inline · ${fmt(s.blockMath)} display` : '0') +
      row('Figures', fmt(s.figures)) +
      row('Links', fmt(s.links.size)) +
      '</div>'

    const named = s.sections.filter((x) => !x.intro)
    if (named.length) {
      const max = Math.max(...s.sections.map((x) => x.words), 1)
      let n = 0
      html += '<div class="wc-label">By section</div><div class="wc-secs">' +
        s.sections.map((x) => {
          const name = x.intro ? x.title : '§' + (++n) + ' · ' + esc(x.title)
          return `<div class="wc-sec"><span class="wc-sec-t">${name}</span><b>${fmt(x.words)}</b>` +
            `<i style="width:${(x.words / max) * 100}%"></i></div>`
        }).join('') + '</div>'
    }
    card.innerHTML = html
  }

  const later = debounce(refresh, 250)
  editor.on('update', later)
  editor.on('selectionUpdate', renderPill)
  $('fnList')?.addEventListener('input', later) // footnote bodies live outside ProseMirror
  refresh()

  return { refresh }
}
