/* ai-suggest.js — AI writing suggestions in the margin, like Google Docs' "suggesting".
 *
 * The writer asks (toolbar pen → Proofread / Review). The model reads the selection, or
 * else the whole draft (a long Proofread in parallel parts), with the whole draft as
 * context, and returns a handful of suggestions. Nothing changes until one is accepted:
 *   edit — small fixes (a word, a phrase, at most a sentence), drawn inline as the
 *          struck-out words + the proposed ones. Accept applies it as one ⌘Z-able step.
 *   link — turn a phrase into a link to a source from the writer's notes (ai-context.js).
 *          Only URLs that literally appear in the notes are offered.
 *   note — an observation or idea: a missing step, an undefined symbol, a figure or an
 *          interactive that would explain it better. No prose is written for you;
 *          "Keep as comment" turns it into an ordinary comment.
 *
 * Suggestions are DECORATIONS in a ProseMirror plugin, never marks or nodes, so they are
 * not part of the doc: they don't save, sync, publish or enter undo history, and they
 * vanish on reload. Their positions are mapped through every transaction; an edit or link
 * whose text you change by hand no longer applies and is dropped, a note stays until its
 * text is deleted or you dismiss it. Dismissed, cleared and replaced-by-a-new-run ones
 * move to `closed` (still mapped) so "Recently closed" (closed.js) can reopen them.
 *
 * The model anchors each suggestion with a verbatim QUOTE of the passage, which we find
 * ourselves — models can't count characters, but they can copy. Anything that doesn't
 * anchor cleanly, would touch math / footnotes, or rewrites more than a sentence is shown
 * as a note instead (or dropped), so the model can never rewrite a passage.
 */

import { Extension, Plugin, PluginKey, Decoration, DecorationSet, katex } from '../vendor/lib.bundle.js'
import { CONFIG } from './config.js'
import { $, uid, toast, escapeHtml } from './dom.js'
import { aiSettings, openSettings } from './ai-math.js'
import { freshContext, setupContextUI } from './ai-context.js'

const CATEGORY_LABELS = {
  grammar: 'Grammar', style: 'Style', flow: 'Flow', clarity: 'Clarity',
  visual: 'Visual idea', interactive: 'Interactive idea', link: 'Link',
}
const MAX_ITEMS = { proofread: 80, review: 30 } // safety caps per run; the prompt asks for far fewer
const PROOF_BATCH_WORDS = 1200 // a long Proofread is split into parts this size, read in parallel
const PARALLEL = 6
const MAX_CLOSED = 30
const TIMEOUT_MS = 240000

/* ===================================================================== text model */
// How inline atoms read in the text the model sees, and in the anchors we match:
// math as $tex$, footnote refs as [^n], line breaks as newlines.
function leafText(node, fnNum) {
  switch (node.type.name) {
    case 'inlineMath': return '$' + node.attrs.tex + '$'
    case 'blockMath': return '$$' + node.attrs.tex + '$$'
    case 'footnoteRef': return '[^' + ((fnNum && fnNum.get(node.attrs.fnId)) || '') + ']'
    case 'hardBreak': return '\n'
    default: return ''
  }
}

// The text of a doc range, for checking that a suggestion's words are still there.
function textOf(doc, from, to) {
  const size = doc.content.size
  from = Math.max(0, Math.min(from, size)); to = Math.max(from, Math.min(to, size))
  return doc.textBetween(from, to, '\n', (leaf) => leafText(leaf))
}

function footnoteNumbers(doc) {
  const nums = new Map()
  doc.descendants((node) => { if (node.type.name === 'footnoteRef' && !nums.has(node.attrs.fnId)) nums.set(node.attrs.fnId, nums.size + 1) })
  return nums
}

// The whole draft as plain text — the context the passage sits in. Links show as
// [text](url) so the model knows what's already linked.
function documentText(doc, fnNum) {
  const inline = (node) => {
    let s = ''
    node.forEach((child) => {
      if (!child.isText) { s += leafText(child, fnNum); return }
      const link = child.marks.find((m) => m.type.name === 'link')
      s += link ? '[' + child.text + '](' + link.attrs.href + ')' : child.text
    })
    return s
  }
  const out = []
  doc.descendants((node, pos, parent) => {
    const name = node.type.name
    if (name === 'heading') { out.push('#'.repeat(node.attrs.level) + ' ' + inline(node)); return false }
    if (name === 'blockMath') { out.push(leafText(node)); return false }
    if (name === 'codeBlock') { out.push('```\n' + node.textContent + '\n```'); return false }
    if (name === 'horizontalRule') { out.push('---'); return false }
    if (name === 'figure') {
      const cap = inline(node).trim()
      out.push('[' + (node.attrs.mediaType === 'video' ? 'Video' : 'Figure') + (cap ? ': ' + cap : '') + ']')
      return false
    }
    if (node.isTextblock) {
      const lead = parent.type.name === 'blockquote' ? '> ' : parent.type.name === 'listItem' ? '- ' : ''
      out.push(lead + inline(node))
      return false
    }
    return true
  })
  return out.join('\n\n')
}

function footnotesText() {
  const items = Array.from(document.querySelectorAll('#fnList > li:not(.fn-orphan)'))
  if (!items.length) return ''
  return '\n\nFootnotes:\n' + items.map((li, i) => {
    const body = li.querySelector('.fn-body')
    return '[^' + (i + 1) + '] ' + (body ? body.innerText.trim() : '')
  }).join('\n')
}

// The passage the model may suggest on: one entry per textblock (or display equation)
// in [from, to), each with a per-character map back to document positions so a quote
// found in `str` turns into a doc range. Code blocks are left out.
function passageBlocks(doc, from, to, fnNum) {
  const blocks = []
  doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name
    if (name === 'codeBlock') return false
    if (name === 'blockMath') {
      blocks.push({ kind: 'equation', str: leafText(node), pos, size: node.nodeSize, math: true })
      return false
    }
    if (!node.isTextblock) return true
    const start = pos + 1
    let str = ''
    const at = [] // at[i] = the doc range of str[i]; atoms (math, refs) span several chars
    node.forEach((child, offset) => {
      const p = start + offset
      if (child.isText) {
        for (let i = 0; i < child.text.length; i++) {
          if (p + i >= from && p + i < to) { str += child.text[i]; at.push({ pos: p + i, end: p + i + 1 }) }
        }
      } else if (p >= from && p < to) {
        const t = leafText(child, fnNum)
        for (let i = 0; i < t.length; i++) { str += t[i]; at.push({ pos: p, end: p + child.nodeSize, atom: true }) }
      }
    })
    const kind = name === 'heading' ? 'heading' : name === 'figure' ? 'caption' : ''
    if (str.trim()) blocks.push({ kind, str, at })
    return false
  })
  return blocks
}

/* ===================================================================== matching */
const TYPO = {
  '‘': "'", '’': "'", '‚': "'", '′': "'", '“': '"', '”': '"', '„': '"',
  '″': '"', '–': '-', '—': '-', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ',
}
const flat = (t) => Array.from(t, (c) => TYPO[c] || c).join('')

// A loose form for matching a quote the model may have retyped: curly quotes and dashes
// flattened, the ellipsis character spelled out, whitespace runs collapsed, lower case.
// idx[k] is the index in `str` that loose character k came from.
function loosen(str) {
  let s = ''
  const idx = []
  for (let i = 0; i < str.length; i++) {
    let c = TYPO[str[i]] || str[i]
    if (c === '…') { s += '...'; idx.push(i, i, i); continue }
    if (/\s/.test(c)) { if (s.endsWith(' ')) continue; c = ' ' }
    const lower = c.toLowerCase()
    s += lower.length === 1 ? lower : c
    idx.push(i)
  }
  return { s, idx }
}

const isWordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c)
// a match that starts or ends mid-word ("is" inside "This") is not the quote
const onWordEdges = (str, s, e) => !(isWordChar(str[s - 1]) && isWordChar(str[s])) && !(isWordChar(str[e - 1]) && isWordChar(str[e]))

// Find a quote → { block, start, end, unique } (indices into block.str), searching the
// paragraph the model named first. Exact match first, then the loose form.
function locate(quote, blocks, hint) {
  const q = String(quote || '').trim().replace(/^(\.\.\.|…)\s*/, '').replace(/\s*(\.\.\.|…)$/, '')
  if (!q) return null
  const hinted = blocks[hint]
  const order = hinted ? [hinted, ...blocks.filter((b) => b !== hinted)] : blocks
  for (const loose of [false, true]) {
    const needle = loose ? loosen(q).s : q
    if (!needle.trim()) continue
    const hits = []
    for (const b of order) {
      const hay = loose ? (b.loose || (b.loose = loosen(b.str))) : null
      const H = loose ? hay.s : b.str
      for (let i = H.indexOf(needle); i >= 0; i = H.indexOf(needle, i + 1)) {
        const hit = loose
          ? { block: b, start: hay.idx[i], end: hay.idx[i + needle.length - 1] + 1 }
          : { block: b, start: i, end: i + needle.length }
        if (onWordEdges(b.str, hit.start, hit.end)) hits.push(hit)
      }
      if (hits.length && b === hinted) break // found where the model said it was
    }
    if (hits.length) {
      const first = hits[0]
      const unique = first.block === hinted ? hits.filter((h) => h.block === hinted).length === 1 : hits.length === 1
      return { ...first, unique }
    }
  }
  return null
}

// Word-level diff of a quote and its replacement → the changed stretches ("hunks"),
// each { start, end, ins } in `a`'s indices. "enviroment … begins" becomes two small
// fixes rather than one struck-out clause; "utilize → use" never splits a word.
const TOKEN = /[\p{L}\p{N}'’]+|\s+|[^\s\p{L}\p{N}]/gu
function wordHunks(a, b) {
  const ta = a.match(TOKEN) || []
  const tb = b.match(TOKEN) || []
  const na = ta.map(flat), nb = tb.map(flat)
  const n = ta.length, m = tb.length
  // longest common subsequence of tokens (a quote is a sentence at most, so this is tiny)
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  }
  const off = [0]
  for (const t of ta) off.push(off[off.length - 1] + t.length)
  const hunks = []
  let cur = null
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && na[i] === nb[j]) { if (cur) hunks.push(cur); cur = null; i++; j++; continue }
    if (!cur) cur = { start: off[i], end: off[i], ins: '' }
    if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { cur.ins += tb[j]; j++ } else { i++; cur.end = off[i] }
  }
  if (cur) hunks.push(cur)
  // two changes with only a space between them read as one ("very fast ran" → "sprinted")
  const merged = []
  for (const h of hunks) {
    const prev = merged[merged.length - 1]
    const gap = prev ? a.slice(prev.end, h.start) : null
    if (prev && /^\s+$/.test(gap)) { prev.ins += gap + h.ins; prev.end = h.end } else merged.push({ ...h })
  }
  return merged
}

// An edit may touch one sentence: a sentence break INSIDE the changed words means it
// merges, splits or rewrites several — that's the writer's call, so it becomes a note.
const ABBREV = /\b(e\.g|i\.e|etc|vs|cf|al|Dr|Mr|Ms|Fig|Eq|Sec)\./g
const spansSentences = (t) => /[.!?]["'”’)]*\s+\S/.test(t.replace(ABBREV, ''))

// Match the doc's typography in inserted words: -- → em dash, and curly apostrophes if
// the paragraph already uses them.
function typeset(ins, context) {
  let t = ins.replace(/--/g, '—')
  if (context.includes('’')) t = t.replace(/(\p{L})'(\p{L})/gu, '$1’$2')
  return t
}

// Comments may name symbols as $…$ (rendered in the card). Models occasionally emit stray
// control characters around math — drop them, and keep math inline.
const cleanComment = (c) => String(c || '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/\$\$([^$]+)\$\$/g, '$$$1$$')
  .replace(/\s+/g, ' ').trim().slice(0, 400)
const cleanUrl = (u) => String(u || '').trim().replace(/[.,;:!?]+$/, '')
const urlAllowed = (url, allowed) => !!url && (allowed.has(url) || allowed.has(url.replace(/\/$/, '')) || allowed.has(url + '/'))

// One model suggestion → an item in the START doc's coordinates (or null to drop it).
// `allowed` is the set of URLs that appear in the writer's notes.
function toItem(sg, blocks, mode, doc, allowed) {
  const hit = locate(sg.quote, blocks, (sg.paragraph | 0) - 1)
  if (!hit) return null
  const b = hit.block
  const comment = cleanComment(sg.comment)
  const category = CATEGORY_LABELS[sg.category] ? sg.category : 'clarity'
  const base = { id: uid(), mode, category, comment }
  if (b.math) return comment && sg.kind === 'note' ? { ...base, kind: 'note', block: true, from: b.pos, to: b.pos + b.size } : null

  const from = b.at[hit.start].pos
  const to = b.at[hit.end - 1].end
  const note = comment ? { ...base, kind: 'note', from, to } : null

  if (sg.kind === 'link') {
    const url = cleanUrl(sg.url)
    const linkType = doc.type.schema.marks.link
    if (!urlAllowed(url, allowed || new Set()) || !/^https?:\/\//.test(url)) return null // never a URL the notes don't contain
    if (b.at.slice(hit.start, hit.end).some((c) => c.atom) || doc.rangeHasMark(from, to, linkType)) return null
    return { ...base, category: 'link', kind: 'link', from, to, text: textOf(doc, from, to), url }
  }
  if (sg.kind !== 'edit' || !hit.unique) return note

  const orig = b.str.slice(hit.start, hit.end)
  const changes = wordHunks(orig, String(sg.replacement || ''))
  if (!changes.length) return mode === 'review' ? note : null // an "edit" that changes nothing
  const hunks = []
  for (const h of changes) {
    const s0 = hit.start + h.start
    const s1 = hit.start + h.end
    const del = b.str.slice(s0, s1)
    // each change stays small and keeps its hands off math, footnote refs and line breaks
    if (b.at.slice(s0, s1).some((c) => c.atom) || /[$\n]|\[\^/.test(h.ins) || spansSentences(del) || spansSentences(h.ins)) return note
    const delFrom = s1 > s0 ? b.at[s0].pos : s0 < b.at.length ? b.at[s0].pos : b.at[s0 - 1].end
    hunks.push({ delFrom, delTo: s1 > s0 ? b.at[s1 - 1].end : delFrom, del, ins: typeset(h.ins, b.str) })
  }
  const changed = hunks.reduce((n, h) => n + h.del.length + h.ins.length, 0)
  if (hunks.length > 4 || changed > 320) return note // that's a rewrite, not a fix
  return { ...base, kind: 'edit', from, to, text: textOf(doc, from, to), hunks }
}

/* ===================================================================== plugin */
const key = new PluginKey('aiSuggestions')

// What a suggestion says, independent of its id and of how much text the model happened
// to quote around it — to tell a re-run's repeat from a new suggestion.
const hunkKey = (h) => h.delFrom + ':' + h.del + '→' + h.ins
const sayKey = (it) => it.kind === 'edit' ? 'e|' + it.hunks.map(hunkKey).join('|')
  : it.kind === 'link' ? 'l|' + it.from + '|' + it.url
  : 'n|' + it.category + '|' + it.from + '|' + it.to
let onChange = null // set by setupSuggestions: refresh cards after any state change

// Carry an item through a change. Edits and links only survive while their text is untouched.
function mapItem(it, mapping, doc) {
  const from = mapping.map(it.from, 1)
  const to = mapping.map(it.to, -1)
  if (to <= from) return null // its text is gone
  if (it.kind === 'note') return { ...it, from, to }
  if (textOf(doc, from, to) !== it.text) return null
  if (it.kind === 'link') return { ...it, from, to }
  const hunks = it.hunks.map((h) => {
    if (h.delTo === h.delFrom) { const p = mapping.map(h.delFrom, 1); return { ...h, delFrom: p, delTo: p } }
    return { ...h, delFrom: mapping.map(h.delFrom, 1), delTo: mapping.map(h.delTo, -1) }
  })
  return { ...it, from, to, hunks }
}

function insWidget(id, h, on) {
  return () => {
    const span = document.createElement('span')
    span.className = 'sg-ins' + (h.delTo > h.delFrom ? ' after-del' : '') + on
    span.dataset.sg = id
    span.textContent = h.ins
    return span
  }
}

function buildDecorations(doc, items, active) {
  const decos = []
  for (const it of items) {
    const on = it.id === active ? ' sg-on' : ''
    if (it.kind === 'edit') {
      it.hunks.forEach((h, i) => {
        if (h.delTo > h.delFrom) decos.push(Decoration.inline(h.delFrom, h.delTo, { class: 'sg-del' + on, 'data-sg': it.id }))
        if (h.ins) decos.push(Decoration.widget(h.delTo, insWidget(it.id, h, on), { side: 1, key: 'sg-' + it.id + '-' + i + on, ignoreSelection: true }))
      })
    } else if (it.block) {
      decos.push(Decoration.node(it.from, it.to, { class: 'sg-note-block' + on, 'data-sg': it.id }))
    } else {
      decos.push(Decoration.inline(it.from, it.to, { class: (it.kind === 'link' ? 'sg-link' : 'sg-note') + on, 'data-sg': it.id }))
    }
  }
  return DecorationSet.create(doc, decos)
}

export const Suggestions = Extension.create({
  name: 'aiSuggestions',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ items: [], closed: [], active: null, decos: DecorationSet.empty }),
        // meta: { add: [items], replace: {mode, from, to}, remove: id, dismiss: id, clear: true,
        //         reopen: id, active: id|null }. remove = gone for good (accepted, kept as a
        //         comment); dismiss / clear / replace = closed, and reopenable.
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(key)
          if (!meta && !tr.docChanged) return prev
          let { items, closed, active } = prev
          if (tr.docChanged && items.length) items = items.map((it) => mapItem(it, tr.mapping, state.doc)).filter(Boolean)
          // a closed suggestion whose text has changed can't come back; it stays listed, greyed
          if (tr.docChanged && closed.length) closed = closed.map((c) => (c.stale ? c : mapItem(c, tr.mapping, state.doc) || { ...c, stale: true }))
          if (meta) {
            const close = (gone, how) => {
              if (!gone.length) return
              const at = Date.now()
              closed = [...gone.map((it) => ({ ...it, how, closedAt: at })), ...closed].slice(0, MAX_CLOSED)
            }
            if (meta.clear) { close(items, 'Cleared'); items = [] }
            if (meta.remove) items = items.filter((it) => it.id !== meta.remove)
            if (meta.dismiss) { close(items.filter((it) => it.id === meta.dismiss), 'Dismissed'); items = items.filter((it) => it.id !== meta.dismiss) }
            if (meta.replace) {
              const r = meta.replace // a new run supersedes the same kind of run over the same text
              const hit = (it) => it.mode === r.mode && it.from < r.to && it.to > r.from
              // only what the new run dropped counts as closed, not what it said again
              const again = new Set((meta.add || []).map(sayKey))
              close(items.filter((it) => hit(it) && !again.has(sayKey(it))), 'Replaced by a new run')
              items = items.filter((it) => !hit(it))
            }
            if (meta.reopen) {
              const c = closed.find((x) => x.id === meta.reopen && !x.stale)
              if (c) {
                const { how, closedAt, ...it } = c
                items = [...items, it].sort((a, b) => a.from - b.from)
                closed = closed.filter((x) => x !== c)
              }
            }
            if (meta.add) items = items.concat(meta.add).sort((a, b) => a.from - b.from)
            if (meta.active !== undefined) active = meta.active
          }
          if (active && !items.some((it) => it.id === active)) active = null
          if (items === prev.items && closed === prev.closed && active === prev.active) return prev
          const decos = items === prev.items && active === prev.active ? prev.decos : buildDecorations(state.doc, items, active)
          return { items, closed, active, decos }
        },
      },
      props: {
        decorations: (state) => key.getState(state).decos,
      },
      view: () => ({
        update(view, prevState) {
          if (onChange && key.getState(view.state) !== key.getState(prevState)) onChange()
        },
      }),
    })]
  },
})

/* ===================================================================== the model */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['paragraph', 'quote', 'kind', 'category', 'comment', 'replacement', 'url'],
        properties: {
          paragraph: { type: 'integer', description: 'The [P#] number the quote is in.' },
          quote: { type: 'string', description: 'Text copied exactly from that paragraph.' },
          kind: { type: 'string', enum: ['edit', 'note', 'link'] },
          category: { type: 'string', enum: ['grammar', 'style', 'flow', 'clarity', 'visual', 'interactive', 'link'] },
          comment: { type: 'string' },
          replacement: { type: 'string', description: 'For an edit: what the quote becomes. Otherwise "".' },
          url: { type: 'string', description: 'For a link: the URL, copied from the notes. Otherwise "".' },
        },
      },
    },
  },
}

const ANCHOR_RULES =
  '- "paragraph" is the [P#] number; "quote" is copied character-for-character from that paragraph ' +
  '(same punctuation, capitalisation and $…$ math, without the [P#] label), and is unique within it.\n' +
  '- Never change math ($…$), footnote markers ([^n]), code or URLs.\n'

const PROMPTS = {
  proofread:
    'You are a meticulous proofreader for a draft essay (technical writing about AI and machine learning).\n\n' +
    'Find only OBJECTIVE errors in the PASSAGE: spelling and typos; grammar (agreement, tense, articles, missing or ' +
    'doubled words); punctuation; the wrong word (its/it’s, affect/effect, then/than); a term spelled or capitalised ' +
    'inconsistently with the rest of the document.\n\n' +
    'Do NOT suggest stylistic changes, rephrasings or anything that is a matter of taste. Deliberate informal ' +
    'choices (fragments, first person, starting with "And") are not errors.\n\n' +
    'Every suggestion is kind "edit" with category "grammar", ONE error per suggestion:\n' +
    '- "quote": the erroneous words plus a word or two around them, so it is unique within its paragraph.\n' +
    '- "replacement": the same text with ONLY that error fixed.\n' +
    '- "comment": names the error in a few words (e.g. "Subject–verb agreement.").\n' +
    '- "url": "".\n' +
    ANCHOR_RULES +
    '- Return at most {N}, in passage order. If there are no errors, return an empty list.',
  review:
    'You are a sharp, sparing editor leaving margin suggestions on a draft essay. The author writes technical essays ' +
    'about AI and machine learning for curious readers. They are published as web pages, so figures, animations and ' +
    'small interactive widgets are all possible.\n\n' +
    'You SUGGEST; you do not rewrite. The author keeps full control and their own voice. Point out the few things ' +
    'that would most improve the PASSAGE, in this order of importance:\n' +
    '1. Clarity: where a reader would stumble — an undefined term or symbol, notation used before it is introduced, ' +
    'a missing step in the reasoning, an ambiguous "this"/"it", a claim that needs an example.\n' +
    '2. Flow: an abrupt jump between sentences or paragraphs, a missing transition, a sentence whose point is buried.\n' +
    '3. Style: only real problems — wordiness that hides the point, needless repetition, a clumsy construction. ' +
    'Never impose your taste; leave deliberate choices (first person, fragments, informal tone, rhetorical questions) alone.\n' +
    '4. Grammar: actual errors only.\n' +
    '5. Explaining better: where an idea would land far better as a VISUAL (a diagram, plot or figure — say what it ' +
    'shows) or an INTERACTIVE element (a slider, toggle or small simulation — say what the reader changes and what ' +
    'they see happen). Only where it would genuinely help; at most 2.\n\n' +
    'Kinds of suggestion:\n' +
    '- "edit": a small, concrete fix. "quote" is the text to change and "replacement" what it becomes. Change a ' +
    'word, a phrase or at most one sentence; keep the rest of the quote identical. Never rewrite several sentences.\n' +
    '- "note": an observation or idea with NO rewritten text ("replacement" is ""). Use a note whenever the fix is ' +
    'bigger than one sentence, structural, or the author’s call. Say what the problem is and, if useful, which ' +
    'direction to take — do not write the new prose for them. Visual and interactive ideas are always notes; quote ' +
    'the sentence they would illustrate.\n' +
    '- "link": only when the author has shared notes — see below.\n\n' +
    'Rules:\n' +
    '- Only suggest within the PASSAGE; the rest of the document is context (e.g. to know what is already defined).\n' +
    ANCHOR_RULES +
    '- "comment": one or two plain sentences (under ~30 words) saying what is wrong and why it matters to a reader. ' +
    'No praise, no hedging. Write any math in it as $…$.\n' +
    '- "url" is "" except for links.\n' +
    '- Match the author’s spelling conventions and terminology.\n' +
    '- Fewer is better: at most {N} edits and notes, most important first. If the passage is already clear and ' +
    'correct, return an empty list — that is a good outcome.',
  // appended to the review prompt when the writer has attached notes (ai-context.js)
  links:
    '\n\nTHE AUTHOR’S NOTES. The author has shared their own notes (in <author_notes>) — e.g. a research journal of ' +
    'what they have been reading and thinking (a long journal arrives as the excerpts most relevant to the passage, ' +
    'each under its heading — often a date). Use them to understand what the author means and is building toward ' +
    '(a term the notes explain but the passage leaves undefined is worth a clarity note).\n' +
    'Also suggest LINKS: when the passage names or clearly relies on something the notes link to — a paper, article, ' +
    'post, talk, repo or dataset — and that phrase is not already linked, return kind "link", category "link":\n' +
    '- "quote": the exact words in the passage that name the thing (usually 2–8 words), to become the link text.\n' +
    '- "url": copied EXACTLY from the notes. Never guess, shorten or build a URL; if the notes have no URL for it, skip it.\n' +
    '- "comment": what it is and where it is in the notes, e.g. "Ng et al. 1999, reward shaping — journal, Mar 3."\n' +
    'Link each source at most once in the passage, at its first mention. At most 5 links; they don’t count toward the {N}.',
}

async function requestSuggestions(mode, input, signal) {
  const settings = aiSettings()
  const notes = input.notes && input.notes.length
    ? '<author_notes>\n' + input.notes.map((n) => '<source name="' + n.name.replace(/"/g, "'") + '">\n' + n.text + '\n</source>').join('\n') + '\n</author_notes>\n\n'
    : ''
  // stable parts first (notes, then the draft) so repeated runs hit the prompt cache. When
  // the passage IS the whole draft, the draft isn't sent twice — just its footnotes.
  const user =
    notes +
    'Title: ' + (input.title || '(untitled)') + '\n' +
    (input.subtitle ? 'Subtitle: ' + input.subtitle + '\n' : '') +
    (input.docText ? '\n<document>\n' + input.docText + '\n</document>\n' : '') +
    '\nPASSAGE (' + input.where + '). Suggest only within it. Paragraphs are labelled [P#]:\n' +
    '<passage>\n' + input.passage + '\n</passage>' +
    (input.footnotes ? '\n\nThe draft’s footnotes, for context:' + input.footnotes : '')
  const system = (PROMPTS[mode] + (mode === 'review' && notes ? PROMPTS.links : '')).replaceAll('{N}', String(input.limit))
  const base = {
    model: settings.writingModel || CONFIG.openai.writingModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'suggestions', strict: true, schema: SCHEMA } },
  }
  // reasoning models take an effort; a 400 may mean this model doesn't — retry plainer
  const attempts = [Object.assign({ reasoning_effort: mode === 'proofread' ? 'low' : 'medium' }, base), base]
  let lastErr = 'Request failed.'
  for (const payload of attempts) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
      body: JSON.stringify(payload),
      signal,
    })
    if (res.ok) {
      const data = await res.json()
      const msg = data.choices && data.choices[0] && data.choices[0].message
      if (msg && msg.refusal) throw new Error('The model declined: ' + msg.refusal)
      if (!msg || !msg.content) throw new Error('Empty response.')
      const parsed = JSON.parse(msg.content)
      return Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    }
    let errText = ''
    try { const j = await res.json(); errText = (j.error && j.error.message) || '' } catch (e) {}
    lastErr = 'OpenAI ' + res.status + (errText ? ': ' + errText : '')
    if (res.status !== 400) break
  }
  throw new Error(lastErr)
}

/* ===================================================================== UI */
const ICONS = {
  accept: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  dismiss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  keep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
}

const WIDE = '(min-width: 1300px)' // same breakpoint as the comment margin
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

// a comment as HTML: plain text, with any $…$ drawn by KaTeX
function commentHTML(text) {
  return text.split(/(\$[^$]+\$)/).map((part) => {
    const m = part.match(/^\$([^$]+)\$$/)
    if (!m) return escapeHtml(part)
    try { return katex.renderToString(m[1], { ...CONFIG.katex, displayMode: false }) } catch (e) { return escapeHtml(part) }
  }).join('')
}

/**
 * @param editor    the live TipTap editor (with the Suggestions extension)
 * @param comments  the comments controller — suggestion cards share its margin layout
 * @param getDocId  the current draft's id (a reply for another draft is discarded)
 */
export function setupSuggestions(editor, comments, { getDocId }) {
  const btn = $('suggestBtn')
  const menu = $('sgMenu')
  const layer = comments.layer
  if (!btn || !menu || !layer) return {}

  const cards = new Map()     // item id -> card
  const dismissed = new Set() // fingerprints of suggestions waved off this session
  let run = null              // the request in flight
  const wide = window.matchMedia(WIDE)
  const context = setupContextUI()

  const st = () => key.getState(editor.state)
  const find = (id) => st().items.find((it) => it.id === id)
  const dispatchMeta = (meta) => editor.view.dispatch(editor.state.tr.setMeta(key, meta).setMeta('addToHistory', false))
  const fingerprint = (it) => {
    const what = it.kind === 'edit' ? it.hunks.map((h) => h.del + '→' + h.ins).join('|') : it.kind === 'link' ? it.url : it.category
    return [it.mode, it.kind, loosen(textOf(editor.state.doc, it.from, it.to)).s, what].join('|')
  }

  function setActive(id) {
    if (st().active === id) return
    if (id) comments.deactivate()
    dispatchMeta({ active: id })
  }

  /* ---- actions ---- */
  function accept(id) {
    const it = find(id)
    if (!it || it.kind === 'note') return
    const { state } = editor
    if (textOf(state.doc, it.from, it.to) !== it.text) { dispatchMeta({ remove: id }); return }
    const tr = state.tr
    if (it.kind === 'link') {
      tr.addMark(it.from, it.to, state.schema.marks.link.create({ href: it.url }))
    } else {
      // last change first, so the earlier positions still hold
      for (const h of [...it.hunks].sort((a, b) => b.delFrom - a.delFrom)) {
        if (h.ins) tr.insertText(h.ins, h.delFrom, h.delTo)
        else tr.delete(h.delFrom, h.delTo)
      }
    }
    editor.view.dispatch(tr.setMeta(key, { remove: id })) // one undoable step
  }
  function dismiss(id) {
    const it = find(id)
    if (it) dismissed.add(fingerprint(it))
    dispatchMeta({ dismiss: id })
  }
  function keepAsComment(id) {
    const it = find(id)
    if (!it || it.block) return
    dismissed.add(fingerprint(it))
    dispatchMeta({ remove: id })
    comments.addAt(it.from, it.to, it.comment)
  }
  function clearAll() { dispatchMeta({ clear: true }) }

  // "Recently closed" (closed.js): dismissed / cleared / replaced suggestions, this session
  function reopen(id) {
    const c = st().closed.find((x) => x.id === id)
    if (!c) return false
    if (c.stale) return 'Its text has changed since, so it no longer applies.'
    dismissed.delete(fingerprint(c))
    comments.deactivate()
    dispatchMeta({ reopen: id, active: id })
    const at = c.kind === 'edit' ? c.hunks[0].delFrom : c.from
    editor.chain().focus().setTextSelection(at).scrollIntoView().run()
    return true
  }
  const closedSource = {
    list: () => st().closed.map((c) => ({
      key: c.id, kind: 'ai', label: 'AI · ' + CATEGORY_LABELS[c.category], how: c.how, closedAt: c.closedAt,
      text: c.kind === 'edit' ? c.hunks.map((h) => (h.del ? h.del + ' → ' : '+ ') + (h.ins || '∅')).join(' · ') + (c.comment ? ' — ' + c.comment : '')
        : c.kind === 'link' ? shortUrl(c.url) + (c.comment ? ' — ' + c.comment : '') : c.comment,
      quote: c.stale || c.block ? '' : textOf(editor.state.doc, c.from, c.to),
      canReopen: !c.stale,
    })),
    reopen: (key) => reopen(key) || 'Couldn’t reopen it.',
  }

  /* ---- cards ---- */
  function makeCard(it) {
    const card = document.createElement('div')
    card.className = 'cmt-card sg-card sg-' + it.kind
    card.dataset.sg = it.id
    let body = ''
    if (it.kind === 'edit') {
      body = '<div class="sg-diff">' + it.hunks.map((h) => {
        const del = h.del ? '<span class="sg-d">' + escapeHtml(h.del) + '</span>' : ''
        const ins = h.ins ? '<span class="sg-i">' + escapeHtml(h.ins) + '</span>' : ''
        return del + (del && ins ? '<span class="sg-arrow">→</span>' : '') + ins
      }).join('<span class="sg-sep">·</span>') + '</div>'
    } else if (it.kind === 'link') {
      body = '<a class="sg-url" target="_blank" rel="noopener"></a>'
    }
    const btns = it.kind !== 'note'
      ? '<button class="sg-btn sg-accept" type="button" title="' + (it.kind === 'link' ? 'Add link' : 'Accept') + '">' + ICONS.accept + '</button>'
      : it.block ? '' : '<button class="sg-btn sg-keep" type="button" title="Keep as a comment">' + ICONS.keep + '</button>'
    card.innerHTML =
      '<div class="sg-head"><span class="sg-cat">' + CATEGORY_LABELS[it.category] + '</span><span class="sg-btns">' + btns +
      '<button class="sg-btn sg-dismiss" type="button" title="Dismiss">' + ICONS.dismiss + '</button></span></div>' +
      body + (it.comment ? '<div class="sg-why">' + commentHTML(it.comment) + '</div>' : '')
    const a = card.querySelector('.sg-url')
    if (a) { a.href = it.url; a.textContent = shortUrl(it.url); a.title = it.url }
    const on = (sel, fn) => {
      const b = card.querySelector(sel)
      if (b) b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); fn(it.id) })
    }
    on('.sg-accept', accept)
    on('.sg-dismiss', dismiss)
    on('.sg-keep', keepAsComment)
    card.addEventListener('mousedown', (e) => { e.preventDefault(); setActive(it.id) })
    card.style.transition = 'none' // land at the right spot, then animate later moves
    return card
  }

  function sync() {
    const { items, active } = st()
    const live = new Set(items.map((it) => it.id))
    for (const [id, card] of cards) if (!live.has(id)) { card.remove(); cards.delete(id) }
    for (const it of items) {
      let card = cards.get(it.id)
      if (!card) { card = makeCard(it); cards.set(it.id, card); layer.appendChild(card) }
      card.classList.toggle('active', it.id === active)
    }
    btn.classList.toggle('has', items.length > 0)
    comments.layout()
  }
  onChange = sync

  function anchorRect(it) {
    const el = editor.view.dom.querySelector('[data-sg="' + it.id + '"]')
    if (el) return el.getBoundingClientRect()
    try {
      const a = editor.view.coordsAtPos(it.from)
      return { top: a.top, bottom: a.bottom, left: a.left }
    } catch (e) { return null }
  }

  // the margin layout pulls our cards from here (see comments.addSource)
  comments.addSource({
    entries(sRect) {
      const out = []
      const { items, active } = st()
      for (const it of items) {
        const card = cards.get(it.id)
        const r = card && anchorRect(it)
        if (!r) continue
        out.push({ card, active: it.id === active, top: r.top - sRect.top, bottom: r.bottom - sRect.top, left: r.left - sRect.left })
      }
      if (run) {
        try {
          const p = Math.min(run.mapPos(run.scope.from, 1) + 1, editor.state.doc.content.size)
          const r = editor.view.coordsAtPos(p)
          out.push({ card: run.card, active: false, pinned: true, top: r.top - sRect.top, bottom: r.bottom - sRect.top, left: r.left - sRect.left })
        } catch (e) {}
      }
      return out
    },
    deactivate: () => setActive(null),
  })

  /* ---- the caret selects the suggestion it's in ---- */
  const contains = (it, p) => it.kind === 'edit'
    ? it.hunks.some((h) => p >= h.delFrom && p <= h.delTo)
    : !it.block && p >= it.from && p <= it.to
  editor.on('selectionUpdate', () => {
    const { from, empty } = editor.state.selection
    const it = empty ? st().items.find((x) => contains(x, from)) : null
    setActive(it ? it.id : null)
  })
  // clicking an inline insertion (a widget, not text) doesn't move the caret into anything
  editor.view.dom.addEventListener('mousedown', (e) => {
    const el = e.target && e.target.closest && e.target.closest('.sg-ins')
    if (el) setTimeout(() => setActive(el.dataset.sg), 0)
  })

  /* ---- scope: the selection, else the whole draft ---- */
  const countWords = (t) => t.split(/\s+/).filter(Boolean).length
  const wordsLabel = (n) => n.toLocaleString('en-US') + (n === 1 ? ' word' : ' words')
  function scopeOf(state) {
    const { doc, selection } = state
    if (!selection.empty && !selection.node) {
      const words = countWords(doc.textBetween(selection.from, selection.to, ' ', ' '))
      return { from: selection.from, to: selection.to, label: 'Selection · ' + wordsLabel(words), where: 'the writer’s selection' }
    }
    const words = countWords(doc.textBetween(0, doc.content.size, ' ', ' '))
    return { from: 0, to: doc.content.size, whole: true, label: 'Whole draft · ' + wordsLabel(words), where: 'the whole draft' }
  }

  // Proofread reads a long passage in parts (faster, and nothing gets skimmed); a part
  // ends at a block boundary once it passes PROOF_BATCH_WORDS.
  function batches(blocks, mode) {
    if (mode !== 'proofread') return [blocks]
    const out = [[]]
    let n = 0
    for (const b of blocks) {
      if (n >= PROOF_BATCH_WORDS) { out.push([]); n = 0 }
      out[out.length - 1].push(b)
      n += countWords(b.str)
    }
    return out
  }

  // run fn over items, at most PARALLEL at a time → Promise.allSettled-style results
  async function pool(items, fn) {
    const results = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) } } catch (reason) { results[i] = { status: 'rejected', reason } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
    return results
  }

  /* ---- a run ---- */
  function pendingCard(mode) {
    const card = document.createElement('div')
    card.className = 'cmt-card sg-card sg-pending'
    card.innerHTML = '<span class="sg-spin"></span><span>' + (mode === 'proofread' ? 'Proofreading…' : 'Reading…') +
      '</span><button class="sg-stop" type="button">Stop</button>'
    card.querySelector('.sg-stop').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); stop() })
    card.addEventListener('mousedown', (e) => e.preventDefault())
    card.style.transition = 'none'
    return card
  }

  // map a position from the doc the request was made against to the doc now
  editor.on('transaction', ({ transaction }) => { if (run && transaction.docChanged) run.maps.push(transaction.mapping) })

  async function start(mode) {
    closeMenu()
    if (run) return
    if (!aiSettings().apiKey) { toast('Add your OpenAI key in Settings first'); openSettings(); return }
    const state = editor.state
    const scope = scopeOf(state)
    const fnNum = footnoteNumbers(state.doc)
    const blocks = passageBlocks(state.doc, scope.from, scope.to, fnNum)
    if (!blocks.length) { toast('Nothing to read here'); return }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const maps = []
    run = {
      mode, scope, maps, controller, docId: getDocId(), card: pendingCard(mode),
      mapPos: (p, assoc) => maps.reduce((q, m) => m.map(q, assoc), p),
    }
    layer.appendChild(run.card)
    btn.classList.add('busy')
    comments.layout()
    if (scope.whole) toast((mode === 'proofread' ? 'Proofreading' : 'Reviewing') + ' the whole draft…')

    const thisRun = run
    try {
      // the writer's notes (Review only): refetched first if a Google Doc has gone stale;
      // a long journal is cut down to the excerpts relevant to this passage
      const query = scope.label + '\n' + blocks.map((b) => b.str).join('\n')
      const notes = mode === 'review' ? await freshContext(query) : { parts: [], urls: new Set() }
      if (controller.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' })
      const parts = batches(blocks, mode)
      const docText = documentText(state.doc, fnNum)
      const footnotes = footnotesText()
      // Review scales with length: ~1 suggestion per 300 words, between 6 and 15
      const limit = mode === 'proofread' ? 15 : Math.max(6, Math.min(15, Math.round(countWords(blocks.map((b) => b.str).join(' ')) / 300)))
      const results = await pool(parts, (part, i) => requestSuggestions(mode, {
        title: ($('docTitle') || {}).textContent || '',
        subtitle: ($('docSubtitle') || {}).textContent || '',
        // the passage already is the whole draft → don't send it twice
        docText: scope.whole && parts.length === 1 ? '' : docText + footnotes,
        footnotes: scope.whole && parts.length === 1 ? footnotes : '',
        passage: part.map((b, j) => '[P' + (j + 1) + (b.kind ? ', ' + b.kind : '') + '] ' + b.str).join('\n\n'),
        where: scope.where + (parts.length > 1 ? ', part ' + (i + 1) + ' of ' + parts.length : ''),
        notes: notes.parts,
        limit,
      }, controller.signal))
      if (thisRun.docId !== getDocId()) return // switched drafts while it was thinking
      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length === results.length) throw failed[0].reason
      const mapping = { map: (p, assoc) => thisRun.mapPos(p, assoc) }
      const seen = new Set()
      const items = []
      // a fix the other mode already shows (Review re-finding a Proofread typo) isn't repeated
      const shown = new Set(st().items.filter((it) => it.mode !== mode && it.kind === 'edit').flatMap((it) => it.hunks.map(hunkKey)))
      let unplaced = 0, overtaken = 0
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        for (const sg of r.value) {
          if (items.length >= MAX_ITEMS[mode]) return
          let it = toItem(sg, parts[i], mode, state.doc, notes.urls)
          if (!it) { unplaced++; continue }
          it = mapItem(it, mapping, editor.state.doc) // carry it over edits made while waiting
          if (!it) { overtaken++; continue }
          if (it.kind === 'edit') {
            const hunks = it.hunks.filter((h) => !shown.has(hunkKey(h)))
            if (!hunks.length) continue
            it = { ...it, hunks }
          }
          const fp = fingerprint(it)
          if (dismissed.has(fp) || seen.has(fp)) continue
          seen.add(fp)
          items.push(it)
        }
      })
      if (unplaced) console.info('[suggest] ' + unplaced + ' suggestion(s) could not be placed')
      if (failed.length) console.warn('[suggest] ' + failed.length + ' part(s) failed:', failed.map((f) => f.reason && f.reason.message))
      dispatchMeta({
        replace: { mode, from: thisRun.mapPos(scope.from, 1), to: thisRun.mapPos(scope.to, -1) },
        add: items,
      })
      if (!items.length && overtaken) toast('The text changed while it was reading — try again')
      else if (!items.length) toast(mode === 'proofread' ? 'No errors found' : 'Nothing to suggest — it reads well')
      else toast(items.length + (items.length === 1 ? ' suggestion' : ' suggestions') + (wide.matches ? '' : ' — tap the marked text') +
        (failed.length ? ' (' + failed.length + ' of ' + results.length + ' parts failed — run it again for those)' : ''))
    } catch (err) {
      toast(err.name === 'AbortError' ? 'Stopped' : (err.message || 'Suggestions failed'))
    } finally {
      clearTimeout(timer)
      thisRun.card.remove()
      if (run === thisRun) run = null
      btn.classList.remove('busy')
      comments.layout()
    }
  }
  function stop() { if (run) run.controller.abort() }

  /* ---- the menu ---- */
  function openMenu() {
    const scope = scopeOf(editor.state)
    $('sgScope').textContent = scope.label + (scope.whole ? ' — select text to narrow it' : '')
    menu.querySelectorAll('[data-mode]').forEach((b) => { b.disabled = !!run })
    $('sgStop').hidden = !run
    $('sgClear').hidden = !st().items.length
    context.render()
    menu.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = menu.offsetWidth
    menu.style.top = (r.bottom + 6) + 'px'
    menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px'
  }
  function closeMenu() { menu.classList.add('hidden') }

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault() // keep the editor's selection: it's the scope
    if (menu.classList.contains('hidden')) openMenu(); else closeMenu()
  })
  // keep the editor's selection while using the menu (but let its inputs take focus)
  menu.addEventListener('mousedown', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault() })
  menu.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => start(b.dataset.mode)))
  $('sgStop').addEventListener('click', () => { stop(); closeMenu() })
  $('sgClear').addEventListener('click', () => { clearAll(); closeMenu() })
  $('sgCtxAdd').addEventListener('click', () => { closeMenu(); context.openAdd() })
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) closeMenu() })

  // exposed for console debugging / verification
  return {
    start, stop, clear: clearAll, items: () => st().items, accept, dismiss, keepAsComment, closedSource,
    _internal: { locate, wordHunks, toItem, passageBlocks, scopeOf, documentText },
  }
}
