/* ai-suggest.js — AI writing suggestions in the margin, like Google Docs' "suggesting".
 *
 * The writer asks (toolbar pen → Proofread / Review / Find links, or a question typed into
 * Ask). The model reads the selection, or else the whole draft (a long Proofread in
 * parallel parts), with the whole draft as context, and returns a handful of suggestions.
 * Nothing changes until one is accepted:
 *   edit     — small fixes (a word, a phrase, at most a sentence), drawn inline as the
 *              struck-out words + the proposed ones. Accept applies it as one ⌘Z-able step.
 *   link     — turn a phrase into a link: to a source in the writer's notes (ai-context.js),
 *              copied verbatim, or to a well-known page on the web (an arXiv abstract, a
 *              Wikipedia article), which is only offered once the local server has loaded it
 *              and its title matches what the model said it is (/api/linkcheck).
 *   format   — bold or italic on a few words, previewed in place.
 *   math     — plain-text notation ("x_t", "O(n^2)") typeset as inline math.
 *   equation — a display equation to insert after a sentence that describes one in words.
 *   note     — an observation or idea: a missing step, an undefined symbol, a figure or an
 *              interactive that would explain it better. No prose is written for you;
 *              "Keep as comment" turns it into an ordinary comment.
 * Ask answers the question in a panel (with follow-ups); anything the answer points at in
 * the draft comes back as the same accept/dismiss suggestions.
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
  visual: 'Visual idea', interactive: 'Interactive idea', link: 'Link', format: 'Format', math: 'Math',
  comment: 'From your comment',
}
const MAX_ITEMS = { proofread: 80, review: 90, links: 40, ask: 30 } // safety caps per run; the prompt asks for fewer
const LINK_LIMIT = { review: 8, links: 25, ask: 10 }
// a long draft is read in parts of about this many words, in parallel, so every part gets
// a careful read instead of one skim of the whole thing (Review parts also share the
// editor's read of the whole piece — see requestRead)
const BATCH_WORDS = { proofread: 1200, review: 700 }
const PARALLEL = 6
const MAX_CLOSED = 30
const TIMEOUT_MS = 300000
// How big an accepted edit may be. Proofread fixes one error; Review and Ask may line-edit
// up to a paragraph (struck words + new ones, accepted or dismissed as one), never more.
const EDIT_LIMITS = {
  proofread: { hunks: 4, chars: 320, sentences: false },
  // Proofread acting on the writer's own comment ("cut this", "add 'in practice'"): a small
  // addition or deletion, which may be a whole sentence of the paragraph
  comment: { hunks: 4, chars: 600, sentences: true },
  review: { hunks: 14, chars: 1600, sentences: true },
  ask: { hunks: 14, chars: 1600, sentences: true },
  links: { hunks: 0, chars: 0, sentences: false },
}
// Remarks that the draft is unfinished — the writer knows. Dropped unless they asked for a
// final polish (prompted against too; this is the backstop).
const UNFINISHED = /\b(unfinished|incomplete|not (yet )?(finished|complete|written|fleshed out)|abrupt(ly)?|cuts? off|trails? off|ends? (mid|suddenly|without)|placeholder|todo|stub|left hanging|fragment(ary)?|needs (a |an )?(conclusion|ending)|underdeveloped|sketchy)\b/i
const tellsUnfinished = (it, read) => (!read || read.stage !== 'polish') && UNFINISHED.test(it.comment)
const STAGES = {
  auto: '',
  rough: 'ROUGH DRAFT — the author is still getting ideas down.',
  revising: 'REVISING — the ideas are mostly down; the author is shaping and clarifying.',
  polish: 'FINAL POLISH — the author considers it nearly done.',
}

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

/* ===================================================================== linked sources */
// The pages the draft links to — the writer's sources — read through the local server
// (/api/source) so the editor knows what they actually say. Fetched once per session.
const SOURCE_LIMIT = 16          // links read per run
const SOURCE_BUDGET = 110000     // characters of source text per request, shared out
const sourceCache = new Map()    // url -> Promise<{ ok, title, text }>

function draftLinks(doc) {
  const links = new Map() // url -> the words linked
  doc.descendants((node) => {
    if (!node.isText) return
    const m = node.marks.find((x) => x.type.name === 'link')
    const href = m && String(m.attrs.href || '')
    if (href && /^https?:\/\//.test(href)) links.set(href, ((links.get(href) || '') + ' ' + node.text).trim().slice(0, 120))
  })
  return links
}
function readSource(url) {
  if (!sourceCache.has(url)) {
    sourceCache.set(url, fetch('/api/source?url=' + encodeURIComponent(url), { cache: 'no-store' })
      .then((r) => r.json()).catch(() => ({ ok: false })))
  }
  return sourceCache.get(url)
}
async function linkedSources(doc) {
  const links = [...draftLinks(doc)].slice(0, SOURCE_LIMIT)
  const got = await Promise.all(links.map(async ([url, words]) => ({ url, words, ...(await readSource(url)) })))
  const ok = got.filter((g) => g.ok && g.text)
  const failed = got.length - ok.length
  if (failed) console.info('[suggest] could not read ' + failed + ' linked source(s):', got.filter((g) => !g.ok).map((g) => g.url + ' (' + (g.error || '?') + ')'))
  const each = ok.length ? Math.min(24000, Math.floor(SOURCE_BUDGET / ok.length)) : 0
  return ok.map((g) => ({ url: g.url, words: g.words, title: g.title || '', text: g.text.slice(0, each), abstractOnly: !!g.abstractOnly }))
}
const sourcesBlock = (list) => list && list.length
  ? '<linked_sources>\nThe pages the draft links to (the author’s sources), as text — long ones cut to their opening:\n' +
    list.map((x) => '<source url="' + x.url.replace(/"/g, '%22') + '" title="' + x.title.replace(/"/g, "'") +
      '" linked_from="' + x.words.replace(/"/g, "'") + '"' + (x.abstractOnly ? ' only="abstract"' : '') + '>\n' + x.text + '\n</source>').join('\n') +
    '\n</linked_sources>\n\n'
  : ''
const SOURCES =
  '\n\nTHE LINKED SOURCES. The pages the draft links to are in <linked_sources>. Read them: they are what the ' +
  'author is building on. Use them to understand the ideas, to check that what the draft says about a paper or ' +
  'method matches what the source says (a misstatement is worth a note that says what the source actually says), ' +
  'and to suggest a precise term, definition or detail from the source where the draft is vague.'

// The words already linked within a part's blocks (the passage the model sees is plain text,
// so it can't tell — and would offer those links again).
function linkedWords(doc, part) {
  const ranges = part.map((b) => b.math ? null : [b.at[0].pos, b.at[b.at.length - 1].end]).filter(Boolean)
  if (!ranges.length) return []
  const seen = new Set()
  doc.nodesBetween(ranges[0][0], ranges[ranges.length - 1][1], (n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'link')) seen.add(n.text.trim())
  })
  return [...seen].filter(Boolean).slice(0, 80)
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

// Math the model proposes: no delimiters, and it must render in KaTeX (which draws the
// published page) — anything else is shown as a note instead.
const cleanTex = (t) => String(t || '').trim()
  .replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim()
function katexOK(tex, displayMode) {
  if (!tex || tex.length > 600) return false
  try { katex.renderToString(tex, { ...CONFIG.katex, displayMode, throwOnError: true }); return true } catch (e) { return false }
}
// every character of [from, to) already has the mark (so there's nothing to suggest)
function allMarked(doc, from, to, type) {
  let all = true
  doc.nodesBetween(from, to, (n) => { if (n.isText && !type.isInSet(n.marks)) all = false })
  return all
}
// Where a display equation can go after the block that holds `pos` (out of a caption or
// list paragraph if need be), or null.
function blockSpotAfter(doc, pos) {
  const $p = doc.resolve(pos)
  const type = doc.type.schema.nodes.blockMath
  for (let d = $p.depth; d >= 1; d--) {
    const parent = $p.node(d - 1), i = $p.indexAfter(d - 1)
    if (parent.canReplaceWith(i, i, type)) return $p.after(d)
  }
  return null
}

// One model suggestion → an item in the START doc's coordinates (or null to drop it).
// `allowed` is the set of URLs that appear in the writer's notes; any other link is a web
// link, checked by verifyWebLinks before it's shown.
function toItem(sg, blocks, mode, doc, allowed) {
  const hit = locate(sg.quote, blocks, (sg.paragraph | 0) - 1)
  if (!hit) return null
  const b = hit.block
  const comment = cleanComment(sg.comment)
  const kind = sg.kind
  const category = kind === 'format' ? 'format' : kind === 'math' || kind === 'equation' ? 'math'
    : CATEGORY_LABELS[sg.category] ? sg.category : 'clarity'
  const base = { id: uid(), mode, category, comment }
  if (b.math) return comment && kind === 'note' ? { ...base, kind: 'note', block: true, from: b.pos, to: b.pos + b.size } : null

  const from = b.at[hit.start].pos
  const to = b.at[hit.end - 1].end
  const note = comment ? { ...base, kind: 'note', from, to } : null
  const text = textOf(doc, from, to)
  const touchesAtoms = b.at.slice(hit.start, hit.end).some((c) => c.atom) // math, footnote refs

  if (kind === 'link') {
    const url = cleanUrl(sg.url)
    if (!/^https?:\/\/\S+$/.test(url) || touchesAtoms || doc.rangeHasMark(from, to, doc.type.schema.marks.link)) return null
    const source = urlAllowed(url, allowed || new Set()) ? 'notes' : 'web'
    return { ...base, category: 'link', kind: 'link', from, to, text, url, source, title: String(sg.title || '').trim().slice(0, 300) }
  }
  if (kind === 'format') {
    const type = (sg.format === 'bold' || sg.format === 'italic') && doc.type.schema.marks[sg.format]
    if (!type || !hit.unique || touchesAtoms || spansSentences(text) || text.length > 160) return note
    if (allMarked(doc, from, to, type)) return null // it already is
    return { ...base, kind: 'format', format: sg.format, from, to, text }
  }
  if (kind === 'math' || kind === 'equation') {
    const tex = cleanTex(sg.latex)
    if (!katexOK(tex, kind === 'equation')) return note
    if (kind === 'equation') {
      const at = blockSpotAfter(doc, from)
      return at == null ? note : { ...base, kind: 'equation', tex, from, to, at }
    }
    if (!hit.unique || touchesAtoms || spansSentences(text) || text.length > 120) return note
    return { ...base, kind: 'math', tex, from, to, text }
  }
  // Proofread does a comment's small edit or nothing — a note would only repeat the comment
  const fromComment = mode === 'proofread' && category === 'comment'
  if (fromComment && (kind !== 'edit' || !hit.unique)) return null
  if (kind !== 'edit' || !hit.unique) return note

  const lim = EDIT_LIMITS[fromComment ? 'comment' : mode] || EDIT_LIMITS.proofread
  const orig = b.str.slice(hit.start, hit.end)
  const changes = wordHunks(orig, String(sg.replacement || ''))
  if (!changes.length) return mode === 'proofread' ? null : note // an "edit" that changes nothing
  const hunks = []
  for (const h of changes) {
    const s0 = hit.start + h.start
    const s1 = hit.start + h.end
    const del = b.str.slice(s0, s1)
    // each change stays small and keeps its hands off math, footnote refs and line breaks
    if (b.at.slice(s0, s1).some((c) => c.atom) || /[$\n]|\[\^/.test(h.ins)) return fromComment ? null : note
    if (!lim.sentences && (spansSentences(del) || spansSentences(h.ins))) return note
    const delFrom = s1 > s0 ? b.at[s0].pos : s0 < b.at.length ? b.at[s0].pos : b.at[s0 - 1].end
    hunks.push({ delFrom, delTo: s1 > s0 ? b.at[s1 - 1].end : delFrom, del, ins: typeset(h.ins, b.str) })
  }
  const changed = hunks.reduce((n, h) => n + h.del.length + h.ins.length, 0)
  if (hunks.length > lim.hunks || changed > lim.chars) return fromComment ? null : note // that's a rewrite, not an edit
  return { ...base, kind: 'edit', from, to, text, hunks }
}

/* Web links (not from the writer's notes) are only offered once the local server has loaded
 * the page and its title matches what the model said it links to — a model can misremember
 * an arXiv id, and a wrong id is usually some other paper, not a 404. */
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'its', 'via', 'how', 'why',
  'what', 'wikipedia', 'arxiv', 'home', 'page', 'official', 'site', 'pdf', 'abs', 'org', 'com', 'www', 'github'])
const titleWords = (t) => new Set((flat(String(t || '')).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
  .filter((w) => w.length > 2 && !TITLE_STOP.has(w)))
function titleMatches(claimed, actual, fallback) {
  const a = titleWords(actual)
  let c = titleWords(claimed)
  if (!c.size) c = titleWords(fallback)
  if (!a.size || !c.size) return false
  let hit = 0
  for (const w of c) if (a.has(w)) hit++
  return hit >= Math.max(1, Math.ceil(c.size / 2))
}
async function verifyWebLinks(items, signal) {
  const web = items.filter((it) => it.kind === 'link' && it.source === 'web')
  if (!web.length) return items
  const bad = new Set()
  await Promise.all(web.map(async (it) => {
    try {
      const res = await fetch('/api/linkcheck?url=' + encodeURIComponent(it.url), { signal, cache: 'no-store' })
      const j = await res.json()
      if (!res.ok || !j.ok || !titleMatches(it.title, j.title, it.text)) { bad.add(it); return }
      it.pageTitle = j.title
    } catch (e) {
      if (e.name === 'AbortError') throw e
      bad.add(it) // server unreachable (or too old to have /api/linkcheck): never show an unchecked link
    }
  }))
  if (bad.size) console.info('[suggest] dropped ' + bad.size + ' web link(s) that did not check out: ' + [...bad].map((it) => it.url + ' (“' + it.title + '”)').join(', '))
  return items.filter((it) => !bad.has(it))
}

/* ===================================================================== plugin */
const key = new PluginKey('aiSuggestions')

// What a suggestion says, independent of its id and of how much text the model happened
// to quote around it — to tell a re-run's repeat from a new suggestion.
const hunkKey = (h) => h.delFrom + ':' + h.del + '→' + h.ins
const sayKey = (it) => it.kind === 'edit' ? 'e|' + it.hunks.map(hunkKey).join('|')
  : it.kind === 'link' ? 'l|' + it.from + '|' + it.url
  : it.kind === 'format' ? 'f|' + it.from + '|' + it.to + '|' + it.format
  : it.kind === 'math' || it.kind === 'equation' ? 'm|' + it.from + '|' + it.tex
  : 'n|' + it.category + '|' + it.from + '|' + it.to
let onChange = null // set by setupSuggestions: refresh cards after any state change

// Carry an item through a change. Notes and equations stay while their sentence does; the
// rest (edits, links, formatting, math) only while their text is untouched.
function mapItem(it, mapping, doc) {
  const from = mapping.map(it.from, 1)
  const to = mapping.map(it.to, -1)
  if (to <= from) return null // its text is gone
  if (it.kind === 'note') return { ...it, from, to }
  if (it.kind === 'equation') return { ...it, from, to, at: mapping.map(it.at, -1) }
  if (textOf(doc, from, to) !== it.text) return null
  if (it.kind !== 'edit') return { ...it, from, to }
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

// the proposed math, drawn after the plain-text notation it would replace
function mathWidget(id, tex, on) {
  return () => {
    const span = document.createElement('span')
    span.className = 'sg-ins sg-math after-del' + on
    span.dataset.sg = id
    try { katex.render(tex, span, { ...CONFIG.katex, displayMode: false }) } catch (e) { span.textContent = tex }
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
    } else if (it.kind === 'math') {
      decos.push(Decoration.inline(it.from, it.to, { class: 'sg-del' + on, 'data-sg': it.id }))
      decos.push(Decoration.widget(it.to, mathWidget(it.id, it.tex, on), { side: 1, key: 'sgm-' + it.id + on, ignoreSelection: true }))
    } else if (it.kind === 'format') {
      decos.push(Decoration.inline(it.from, it.to, { class: 'sg-fmt sg-fmt-' + it.format + on, 'data-sg': it.id }))
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
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraph', 'quote', 'kind', 'category', 'comment', 'replacement', 'url', 'title', 'format', 'latex'],
  properties: {
    paragraph: { type: 'integer', description: 'The [P#] number the quote is in.' },
    quote: { type: 'string', description: 'Text copied exactly from that paragraph.' },
    kind: { type: 'string', enum: ['edit', 'note', 'link', 'format', 'math', 'equation'] },
    category: { type: 'string', enum: ['grammar', 'style', 'flow', 'clarity', 'visual', 'interactive', 'link', 'format', 'math', 'comment'] },
    comment: { type: 'string' },
    replacement: { type: 'string', description: 'For an edit: what the quote becomes. Otherwise "".' },
    url: { type: 'string', description: 'For a link: the URL. Otherwise "".' },
    title: { type: 'string', description: 'For a link: the linked page’s own title. Otherwise "".' },
    format: { type: 'string', enum: ['bold', 'italic', ''], description: 'For a format suggestion. Otherwise "".' },
    latex: { type: 'string', description: 'For math or an equation: the LaTeX, without $. Otherwise "".' },
  },
}
const schemaFor = (mode) => mode === 'ask'
  ? { type: 'object', additionalProperties: false, required: ['answer', 'suggestions'],
      properties: { answer: { type: 'string' }, suggestions: { type: 'array', items: ITEM_SCHEMA } } }
  : { type: 'object', additionalProperties: false, required: ['suggestions'],
      properties: { suggestions: { type: 'array', items: ITEM_SCHEMA } } }

const ANCHOR_RULES =
  '- "paragraph" is the [P#] number; "quote" is copied character-for-character from that paragraph ' +
  '(same punctuation, capitalisation and $…$ math, without the [P#] label), and is unique within it.\n' +
  '- Never change math ($…$), footnote markers ([^n]), code or URLs.\n' +
  '- Fields a kind doesn’t use are "".\n'

// The writer's whole toolbox, as suggestions (Review and Ask).
const KINDS =
  'Kinds of suggestion (the author accepts or dismisses each one; nothing changes until they do):\n' +
  '- "edit": a concrete line edit, shown to the author as struck-out words and inserted words. "quote" is the text ' +
  'to change (copied exactly, from within ONE paragraph) and "replacement" what it becomes. It can be a word, a phrase, ' +
  'a sentence, or several sentences of one paragraph: cutting a redundant sentence, tightening a wordy one, fixing a ' +
  'muddled construction, moving the point of a sentence to the front, adding a missing connective or a short ' +
  'clarifying clause. Keep everything you aren’t changing identical, and keep the author’s voice and word choices — ' +
  'it should read like their sentence, edited, not yours. When you can show the fix, make it an edit, not a note.\n' +
  '- "note": a margin comment with no rewritten text, for what only the author can fix — an idea that needs their ' +
  'knowledge, a structural move across paragraphs, a question about what they mean. Write it the way a good editor ' +
  'talks to a writer: specific, direct, warm, in plain words ("I lost the thread here — is this the same $\\pi$ as ' +
  'above?"). Say what a reader will experience and what you’d try. Visual and interactive ideas are notes; quote the ' +
  'sentence they would illustrate.\n' +
  '- "format": bold or italic — "format" is "bold" or "italic" and "quote" is exactly the words to format. Italic ' +
  'for a term at the point it is defined, the title of a work, or a word that needs stress to be read right; bold ' +
  'only for a key term being introduced. Sparingly: only where it helps a reader.\n' +
  '- "math": notation written as plain text that should be typeset as math — a variable, symbol or formula such ' +
  'as "x_t", "theta", "O(n^2)" or "p(y|x)". "quote" is exactly those characters; "latex" is the KaTeX LaTeX that ' +
  'replaces them (no $). Follow the notation the draft already uses.\n' +
  '- "equation": a display equation that would make the passage clearer, where the prose describes a formula in ' +
  'words without showing it. "quote" is the sentence it should follow; "latex" is the equation (KaTeX; use aligned ' +
  'for several lines, never align or equation environments). Only standard, correct formulas — never invent the ' +
  'author’s results. At most 2.\n' +
  '- "link": see LINKS below.\n'

const LINKS =
  '\n\nLINKS. Suggest a link where a reader would want the source or a reference: a paper, article, post, talk, ' +
  'book, repo, dataset, model, benchmark or a concept worth looking up. Return kind "link", category "link":\n' +
  '- "quote": the exact words in the passage that name the thing (usually 2–8 words); they become the link text.\n' +
  '- "url": from the author’s notes (in <author_notes>, if any), copied EXACTLY — prefer these. Otherwise from the ' +
  'web, but only a canonical URL you are certain of: an arXiv abstract page (https://arxiv.org/abs/ID, never /pdf/), ' +
  'a DOI link (https://doi.org/…) for a published paper with no arXiv version, a Wikipedia article, or an official ' +
  'project, docs or repo page. Never guess an id, a DOI or a path; if unsure, ' +
  'skip it. Every web link is checked: one that doesn’t load, or whose page title doesn’t match "title", is thrown away.\n' +
  '- "title": the linked page’s own title — the paper’s title, the Wikipedia article’s name.\n' +
  '- "comment": what it is (e.g. "Ng et al. 1999, reward shaping"); for a link from the notes, also where it is ' +
  'in them (e.g. "journal, Mar 3").\n' +
  '- Link each source at most once, at its first mention in the passage, and never words that are already a link ' +
  '([text](url) in the document).\n' +
  '- At most {L} links.'

const NOTES =
  '\n\nTHE AUTHOR’S NOTES. The author has shared their own notes (in <author_notes>) — e.g. a research journal of ' +
  'what they have been reading and thinking (a long journal arrives as the excerpts most relevant to the passage, ' +
  'each under its heading — often a date). Use them to understand what the author means and is building toward ' +
  '(a term the notes explain but the passage leaves undefined is worth a clarity note), and as the first place to ' +
  'look for links: the notes are full of sources the author has read.'

// The editor's first pass: read the whole piece before marking anything up.
const READ_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'stage', 'working', 'unfinished', 'priorities', 'voice'],
  properties: {
    summary: { type: 'string', description: 'What the piece is and what it argues or explores, in 2–4 sentences.' },
    stage: { type: 'string', enum: ['rough', 'revising', 'polish'] },
    working: { type: 'string', description: 'What is already working and should be kept.' },
    unfinished: { type: 'array', items: { type: 'string' }, description: 'Parts that are visibly still being written.' },
    priorities: { type: 'array', items: { type: 'string' }, description: 'The few things that would most improve it now.' },
    voice: { type: 'string', description: 'The author’s voice and conventions, to preserve.' },
  },
}
const READ_PROMPT =
  'You are an experienced editor of technical essays (AI and machine learning, written for curious readers, ' +
  'published as web pages). Before marking anything up, you read the WHOLE draft to understand it the way a good ' +
  'editor does: what the author is trying to say, who it is for, how far along it is, and what would help most ' +
  'right now.\n\n' +
  'Write your read of the piece:\n' +
  '- "summary": what the piece is about and what it argues or explores — the through-line, in the author’s terms.\n' +
  '- "stage": "rough" (ideas still being found; sections missing or in note form), "revising" (the argument is ' +
  'mostly there; shaping and clarifying) or "polish" (complete; line-level work left).\n' +
  '- "working": what already works — the strongest ideas, passages, moves — so later edits don’t sand it off.\n' +
  '- "unfinished": parts that are obviously still in progress (a section that stops, bullet notes, a placeholder, an ' +
  'empty heading, a paragraph that ends mid-thought). The author KNOWS these are unfinished; listing them here is ' +
  'so nobody wastes a comment telling them.\n' +
  '- "priorities": the 2–5 things that would most improve the piece at this stage, concretely (e.g. "the jump from ' +
  'curiosity to learning progress needs one bridging example", "§2 defines novelty twice, differently").\n' +
  '- "voice": how the author writes (person, tone, sentence rhythm, spelling, notation conventions) so edits match.\n' +
  'Be specific to THIS draft; no generic advice.'

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
    ANCHOR_RULES +
    '- Return at most {N}, in passage order. If there are no errors, return an empty list.\n\n' +
    'The author’s own margin comments on the PASSAGE may also be given (<author_comments>). Where one asks for a ' +
    'SMALL, SPECIFIC change to the words it is on or right beside them — add a word, phrase or short clause; cut a ' +
    'word, phrase or sentence; swap one word for another — make that change as an edit too, with category ' +
    '"comment" (these don’t count toward {N}):\n' +
    '- "quote": the words to change, from the commented text or its sentence, plus a word or two around them.\n' +
    '- "replacement": the quote with ONLY the requested addition or deletion made, in the author’s voice.\n' +
    '- "comment": says which comment it does, in a few words (e.g. "Adds the example you asked for.").\n' +
    'Skip every other comment: broad or open-ended ones (rewrite, expand, rethink, tighten this section), questions, ' +
    'notes to self, vague reactions ("hmm", "weak"), and anything needing facts, figures, citations or new ideas only ' +
    'the author can supply. When unsure whether a comment is small and specific, skip it.',
  review:
    'You are an experienced, generous and demanding editor working through a draft essay with its author, ' +
    'line by line. The author writes technical essays about AI and machine learning for curious readers; they are ' +
    'published as web pages, so figures, animations and small interactive widgets are possible.\n\n' +
    'You have already read the whole piece (your notes are in <editors_read>). Now go through the PASSAGE carefully, ' +
    'sentence by sentence, and mark it up the way a real editor would: mostly concrete edits the author can accept ' +
    'with one click — words struck out and words added — plus a few margin notes where only the author can make the ' +
    'fix. Be thorough: read every sentence, and don’t stop at the first few things you notice. But every suggestion ' +
    'must earn its place by making the piece better for a reader; no busywork, no taste-swaps.\n\n' +
    'What to look for:\n' +
    '- Clarity: a reader stumbles — an undefined term or symbol, notation before it is introduced, a skipped step, an ' +
    'ambiguous "this"/"it", an abstract claim that wants an example, a sentence that says something other than what ' +
    'the author means.\n' +
    '- Flow and emphasis: a missing connective between two ideas, a buried point, a paragraph whose first sentence ' +
    'isn’t its point, a repeated idea.\n' +
    '- Line editing: wordiness, hedging, filler ("in order to", "it is important to note that"), a clumsy or overlong ' +
    'sentence, weak verbs, a sentence that would be stronger cut. Show the edit.\n' +
    '- Correctness: grammar and typos; and technical accuracy — a claim about a method, result or paper that is wrong ' +
    'or overstated is worth a note.\n' +
    '- Explaining better: where an idea would land far better as a VISUAL (say what it shows), an INTERACTIVE element ' +
    '(say what the reader changes and what they see), or an equation. At most 2 such ideas, only where they really help.\n' +
    '- Typesetting: notation written as plain text that should be math; a defined term or title that should be italic.\n\n' +
    'Respect where the draft is. {STAGE}\n' +
    'NEVER comment that something is unfinished, incomplete, abrupt, cut off, a placeholder, or missing an ending — the ' +
    'author knows (see "unfinished" in your read). Work with what is written: a half-finished paragraph can still get ' +
    'edits to the sentences that are there. Never pad the piece or write new sections for them.\n\n' +
    KINDS + '\n' +
    'Rules:\n' +
    '- Only suggest within the PASSAGE; the rest of the document is context (e.g. to know what is already defined, or ' +
    'what a later section will cover).\n' +
    ANCHOR_RULES +
    '- "comment": for an edit, a short reason in plain words ("Cuts the throat-clearing; the point now leads."). For a ' +
    'note, one to three natural sentences to the author. No praise padding, no hedging, no "consider…" boilerplate. ' +
    'Write any math as $…$.\n' +
    '- One suggestion per problem; don’t split one sentence’s fix into several edits, and don’t make overlapping ones.\n' +
    '- Match the author’s voice, spelling and terminology (see "voice" in your read).\n' +
    '- Up to {N} suggestions besides links, in passage order. Return fewer if the passage is genuinely clean.',
  links:
    'You find links for a draft essay (technical writing about AI and machine learning, published as a web page). ' +
    'Your only job is LINKS, and you are thorough: every paper, method, model, dataset, benchmark, library, person’s ' +
    'work or technical concept named in the PASSAGE that a curious reader might want to look up deserves a link, ' +
    'if there is a reliable URL for it. Return only kind "link" suggestions.\n\n' +
    'Rules:\n' + ANCHOR_RULES +
    '- If nothing in the passage needs a link, return an empty list.',
  ask:
    'You are a sharp editor and a knowledgeable colleague helping an author with a draft essay (technical writing ' +
    'about AI and machine learning for curious readers, published as web pages). The author asks you a question ' +
    'about the draft, or about the PASSAGE (their selection, or else the whole draft).\n\n' +
    'Put your reply in "answer": answer the question directly and honestly — no preamble, no praise, no hedging. ' +
    'Usually under 200 words; longer only if the question needs it. Plain text: short paragraphs, "- " bullet lines, ' +
    '**bold** for emphasis, $…$ for math. To point at a place in the draft, quote a few of its words in quotation ' +
    'marks — never a [P#] number.\n\n' +
    'The author keeps full control and their own voice: you SUGGEST, you never rewrite. When your answer points at ' +
    'specific places in the PASSAGE, ALSO attach them as suggestions so they appear in the margin beside the text. ' +
    'If the author asks you to edit or tighten something, attach the edits themselves (struck words + new ones, within ' +
    'a paragraph) — never a whole new section. Requests for links, formatting or math become suggestions too. If ' +
    'nothing needs attaching, return an empty list. Don’t tell the author a part is unfinished unless they ask; they know.\n\n' +
    KINDS + '\n' +
    'Rules:\n' +
    '- Only attach suggestions within the PASSAGE.\n' +
    ANCHOR_RULES +
    '- "comment": one or two plain sentences saying what and why. Write any math as $…$.\n' +
    '- At most {N} suggestions besides links.',
}

// One structured chat completion → the parsed JSON. Reasoning models take an effort; a 400
// may mean this model doesn't — retry plainer.
async function chatJSON(system, user, schema, effort, signal) {
  const settings = aiSettings()
  const base = {
    model: settings.writingModel || CONFIG.openai.writingModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
  }
  const attempts = [Object.assign({ reasoning_effort: effort }, base), base]
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
      return JSON.parse(msg.content)
    }
    let errText = ''
    try { const j = await res.json(); errText = (j.error && j.error.message) || '' } catch (e) {}
    lastErr = 'OpenAI ' + res.status + (errText ? ': ' + errText : '')
    if (res.status !== 400) break
  }
  throw new Error(lastErr)
}

const notesBlock = (notes) => notes && notes.length
  ? '<author_notes>\n' + notes.map((n) => '<source name="' + n.name.replace(/"/g, "'") + '">\n' + n.text + '\n</source>').join('\n') + '\n</author_notes>\n\n'
  : ''
// the writer's own margin comments — mostly notes to self ("expand", "add figure") that say
// what they already know needs doing
const commentsBlock = (list) => list && list.length
  ? '\n<author_comments>\nThe author’s own margin comments (notes to self — they already know about these):\n' +
    list.map((c) => '- on “' + c.quote.replace(/\s+/g, ' ').slice(0, 160) + '”: ' + c.text.replace(/\s+/g, ' ').slice(0, 400)).join('\n') +
    '\n</author_comments>\n'
  : ''
// Proofread reads the same comments as possible requests for a small edit
const requestsBlock = (list) => list && list.length
  ? '\n<author_comments>\nThe author’s margin comments on the passage (each on the quoted words):\n' +
    list.map((c) => '- on “' + c.quote.replace(/\s+/g, ' ').slice(0, 300) + '”: ' + c.text.replace(/\s+/g, ' ').slice(0, 400)).join('\n') +
    '\n</author_comments>\n'
  : ''
const readText = (r) => !r ? '' :
  '\n<editors_read>\nWhat the piece is: ' + r.summary + '\nStage: ' + r.stage + '\nWhat’s working: ' + r.working +
  (r.unfinished.length ? '\nStill being written (the author knows; don’t flag): ' + r.unfinished.join('; ') : '') +
  (r.priorities.length ? '\nPriorities now: ' + r.priorities.join('; ') : '') +
  '\nVoice: ' + r.voice + '\n</editors_read>\n'

const STAGE_GUIDE = {
  rough: 'It is a ROUGH DRAFT: put most of your effort into the thinking — is the idea clear, is a step missing, ' +
    'does a claim need an example, is the order right — and line-edit sentences that obscure the idea. Skip pure polish.',
  revising: 'It is being REVISED: clarity, flow and tightening matter most; line-edit generously.',
  polish: 'It is in FINAL POLISH: line-edit closely — every sentence, word choice, rhythm, transitions, consistency. ' +
    'Here you may point out a section that genuinely feels unfinished.',
}

// The editor's read of the whole piece (summary, stage, what's unfinished, priorities, voice).
async function requestRead(input, signal) {
  const user = notesBlock(input.notes) + sourcesBlock(input.sources) +
    'Title: ' + (input.title || '(untitled)') + '\n' + (input.subtitle ? 'Subtitle: ' + input.subtitle + '\n' : '') +
    (input.stage ? 'The author says the draft is at this stage: ' + STAGES[input.stage] + '\n' : '') +
    '\n<document>\n' + input.docText + '\n</document>\n' + commentsBlock(input.authorComments)
  const r = await chatJSON(READ_PROMPT + (input.notes && input.notes.length ? NOTES : '') + (input.sources && input.sources.length ? SOURCES : ''),
    user, READ_SCHEMA, 'medium', signal)
  return {
    summary: String(r.summary || ''), stage: input.stage || (STAGES[r.stage] !== undefined ? r.stage : 'revising'),
    working: String(r.working || ''), voice: String(r.voice || ''),
    unfinished: Array.isArray(r.unfinished) ? r.unfinished.map(String) : [],
    priorities: Array.isArray(r.priorities) ? r.priorities.map(String) : [],
  }
}

async function requestSuggestions(mode, input, signal) {
  const notes = notesBlock(input.notes)
  // stable parts first (notes, then the draft) so repeated runs hit the prompt cache. When
  // the passage IS the whole draft, the draft isn't sent twice — just its footnotes.
  const sources = mode !== 'proofread' ? sourcesBlock(input.sources) : ''
  let user =
    notes + sources +
    'Title: ' + (input.title || '(untitled)') + '\n' +
    (input.subtitle ? 'Subtitle: ' + input.subtitle + '\n' : '') +
    (input.docText ? '\n<document>\n' + input.docText + '\n</document>\n' : '') +
    (mode !== 'proofread' ? commentsBlock(input.authorComments) + readText(input.read)
      : requestsBlock(input.authorComments)) +
    '\nPASSAGE (' + input.where + '). ' + (mode === 'ask' ? 'Attach suggestions only within it.' : 'Suggest only within it.') +
    ' Paragraphs are labelled [P#]:\n' +
    '<passage>\n' + (input.passage || '(empty)') + '\n</passage>' +
    (input.linked && input.linked.length && mode !== 'proofread'
      ? '\nAlready linked in the passage (don’t suggest links for these): ' + input.linked.map((w) => '“' + w + '”').join(', ') : '') +
    (input.footnotes ? '\n\nThe draft’s footnotes, for context:' + input.footnotes : '')
  if (mode === 'ask') {
    if (input.history && input.history.length) {
      user += '\n\nEarlier in this conversation:\n' + input.history.map((t) => 'Author: ' + t.q + '\nYou: ' + t.a).join('\n\n')
    }
    user += '\n\nTHE AUTHOR’S QUESTION:\n' + input.question
  }
  const stage = (input.read && input.read.stage) || input.stage || 'revising'
  const system = (PROMPTS[mode] + (mode !== 'proofread' ? LINKS : '') + (mode !== 'proofread' && notes ? NOTES : '') + (sources ? SOURCES : ''))
    .replaceAll('{N}', String(input.limit)).replaceAll('{L}', String(LINK_LIMIT[mode] || 0))
    .replaceAll('{STAGE}', STAGE_GUIDE[stage] || STAGE_GUIDE.revising)
  // judging which comments are small requests takes a little more thought than typos
  const effort = mode === 'proofread' ? (input.authorComments && input.authorComments.length ? 'medium' : 'low')
    : mode === 'links' ? 'medium' : 'high'
  const parsed = await chatJSON(system, user, schemaFor(mode), effort, signal)
  return { answer: typeof parsed.answer === 'string' ? parsed.answer : '', suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [] }
}

/* ===================================================================== UI */
const ICONS = {
  accept: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  dismiss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  keep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
}

const WIDE = '(min-width: 1300px)' // same breakpoint as the comment margin
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

// a comment as HTML: plain text, with any $…$ drawn by KaTeX
function commentHTML(text) {
  return text.split(/(\$[^$]+\$)/).map((part) => {
    const m = part.match(/^\$([^$]+)\$$/)
    if (!m) return escapeHtml(part)
    try { return katex.renderToString(m[1], { ...CONFIG.katex, displayMode: false }) } catch (e) { return escapeHtml(part) }
  }).join('')
}
const texHTML = (tex, displayMode) => {
  try { return katex.renderToString(tex, { ...CONFIG.katex, displayMode }) } catch (e) { return escapeHtml(tex) }
}

// A suggestion in one line (Recently closed, the Ask panel's list of what it attached).
function summary(it, text) {
  const fmt = { bold: 'Bold', italic: 'Italic' }
  switch (it.kind) {
    case 'edit': return it.hunks.map((h) => (h.del ? h.del + ' → ' : '+ ') + (h.ins || '∅')).join(' · ')
    case 'link': return shortUrl(it.url) + (it.pageTitle ? ' — ' + it.pageTitle : '')
    case 'format': return fmt[it.format] + ': “' + text + '”'
    case 'math': return '“' + text + '” → $' + it.tex + '$'
    case 'equation': return 'Equation: $' + it.tex + '$'
    default: return it.comment
  }
}

// The Ask panel's answers: short paragraphs, bullet or numbered lines, **bold**, *italic*,
// `code` and $math$ — the little Markdown the prompt allows. Everything else is text.
function inlineMd(t) {
  return t.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/).map((part) => {
    const m = part.match(/^\$\$?([^$]+)\$\$?$/)
    if (m) return texHTML(m[1], false)
    return escapeHtml(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  }).join('')
}
function answerHTML(text) {
  const out = []
  let list = null
  const flush = () => { if (list) out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'); list = null }
  for (const line of String(text || '').split('\n')) {
    const li = line.match(/^\s*(?:([-*•])|\d+[.)])\s+(.*)$/)
    if (li) {
      const tag = li[1] ? 'ul' : 'ol'
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] } }
      list.items.push('<li>' + inlineMd(li[2]) + '</li>')
    } else {
      flush()
      if (line.trim()) out.push('<p>' + inlineMd(line.trim()) + '</p>')
    }
  }
  flush()
  return out.join('')
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
  const lastUnplaced = []     // the last run's suggestions that didn't anchor (console debugging)
  const wide = window.matchMedia(WIDE)
  const context = setupContextUI()

  const st = () => key.getState(editor.state)
  const find = (id) => st().items.find((it) => it.id === id)
  const dispatchMeta = (meta) => editor.view.dispatch(editor.state.tr.setMeta(key, meta).setMeta('addToHistory', false))
  // what a suggestion says, whichever run it came from (an Ask doesn't repeat what's shown)
  const says = (it) => {
    const what = it.kind === 'edit' ? it.hunks.map((h) => h.del + '→' + h.ins).join('|') : it.kind === 'link' ? it.url
      : it.kind === 'format' ? it.format : it.kind === 'math' || it.kind === 'equation' ? it.tex : it.category
    return [it.kind, loosen(textOf(editor.state.doc, it.from, it.to)).s, what].join('|')
  }
  const fingerprint = (it) => it.mode + '|' + says(it)

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
    if (it.kind !== 'equation' && textOf(state.doc, it.from, it.to) !== it.text) { dispatchMeta({ remove: id }); return }
    const tr = state.tr
    if (it.kind === 'link') {
      tr.addMark(it.from, it.to, state.schema.marks.link.create({ href: it.url }))
    } else if (it.kind === 'format') {
      tr.addMark(it.from, it.to, state.schema.marks[it.format].create())
    } else if (it.kind === 'math') {
      tr.replaceWith(it.from, it.to, state.schema.nodes.inlineMath.create({ tex: it.tex }))
    } else if (it.kind === 'equation') {
      try { tr.insert(it.at, state.schema.nodes.blockMath.create({ tex: it.tex })) } catch (e) { dispatchMeta({ remove: id }); return }
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
      text: c.kind === 'note' ? c.comment
        : summary(c, c.stale ? c.text || '' : textOf(editor.state.doc, c.from, c.to)) + (c.comment ? ' — ' + c.comment : ''),
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
      body = '<a class="sg-url" target="_blank" rel="noopener"></a>' + (it.pageTitle ? '<div class="sg-ltitle"></div>' : '')
    } else if (it.kind === 'format') {
      const tag = it.format === 'bold' ? 'strong' : 'em'
      body = '<div class="sg-diff"><' + tag + ' class="sg-i">' + escapeHtml(it.text) + '</' + tag + '></div>'
    } else if (it.kind === 'math') {
      body = '<div class="sg-diff"><span class="sg-d">' + escapeHtml(it.text) + '</span><span class="sg-arrow">→</span>' +
        '<span class="sg-i">' + texHTML(it.tex, false) + '</span></div>'
    } else if (it.kind === 'equation') {
      body = '<div class="sg-eq">' + texHTML(it.tex, true) + '</div>'
    }
    const acceptTitle = { link: 'Add link', format: it.format === 'bold' ? 'Make bold' : 'Make italic', math: 'Typeset as math', equation: 'Insert equation' }
    const btns = it.kind !== 'note'
      ? '<button class="sg-btn sg-accept" type="button" title="' + (acceptTitle[it.kind] || 'Accept') + '">' + ICONS.accept + '</button>'
      : it.block ? '' : '<button class="sg-btn sg-keep" type="button" title="Keep as a comment">' + ICONS.keep + '</button>'
    const label = it.kind === 'format' ? (it.format === 'bold' ? 'Bold' : 'Italic')
      : it.kind === 'equation' ? 'Equation'
      : it.kind === 'link' ? 'Link' + (it.source === 'web' ? ' · web' : ' · your notes')
      : CATEGORY_LABELS[it.category]
    card.innerHTML =
      '<div class="sg-head"><span class="sg-cat">' + label + '</span><span class="sg-btns">' + btns +
      '<button class="sg-btn sg-dismiss" type="button" title="Dismiss">' + ICONS.dismiss + '</button></span></div>' +
      body + (it.comment ? '<div class="sg-why">' + commentHTML(it.comment) + '</div>' : '')
    const a = card.querySelector('.sg-url')
    if (a) { a.href = it.url; a.textContent = shortUrl(it.url); a.title = it.url }
    const lt = card.querySelector('.sg-ltitle')
    if (lt) lt.textContent = it.pageTitle
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
    document.querySelectorAll('#askThread .ask-ref').forEach((b) => b.classList.toggle('gone', !live.has(b.dataset.sg)))
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
    : !it.block && p >= it.from && p <= it.to // a math suggestion's widget sits at its `to`
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
  // ends at a block boundary once it passes BATCH_WORDS (Review: also at a heading).
  function batches(blocks, mode) {
    const size = BATCH_WORDS[mode]
    if (!size) return [blocks]
    const out = [[]]
    let n = 0
    for (const b of blocks) {
      // a heading starts a new part once this one has some substance, so parts follow sections
      if (n >= size || (b.kind === 'heading' && n >= size / 2)) { out.push([]); n = 0 }
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

  /* ---- the draft's stage (set in the menu; per draft, this browser) and the editor's read ---- */
  const stageKey = () => 'ahilan.editor.aiStage.' + getDocId()
  const getStage = () => { try { return localStorage.getItem(stageKey()) || 'auto' } catch (e) { return 'auto' } }
  const setStage = (v) => { try { localStorage.setItem(stageKey(), v) } catch (e) {} }
  const reads = new Map() // draft id -> { words, stage, read }: reused while the draft hasn't moved much
  const authorComments = () => (comments.openList ? comments.openList() : [])
  const commentsIn = (part) => {
    const lo = part[0].pos, hi = part[part.length - 1].pos + part[part.length - 1].size
    return authorComments().filter((c) => c.from >= lo && c.from < hi)
  }
  async function editorsRead(docText, footnotes, notes, sources, signal) {
    const stage = getStage() === 'auto' ? '' : getStage()
    const words = countWords(docText)
    const cached = reads.get(getDocId())
    if (cached && cached.stage === stage && Math.abs(cached.words - words) < Math.max(120, words * 0.04)) return { read: cached.read, fresh: false }
    const read = await requestRead({
      title: ($('docTitle') || {}).textContent || '', subtitle: ($('docSubtitle') || {}).textContent || '',
      docText: docText + footnotes, notes, sources, stage, authorComments: authorComments(),
    }, signal)
    reads.set(getDocId(), { words, stage, read })
    return { read, fresh: true }
  }
  const STAGE_NAMES = { rough: 'Rough draft', revising: 'Revising', polish: 'Final polish' }
  function readAnswer(r) {
    return '**What it is.** ' + r.summary + '\n\n' +
      '**Stage:** ' + STAGE_NAMES[r.stage] + (getStage() === 'auto' ? ' (my guess — set it in the pen menu)' : '') + '\n\n' +
      (r.working ? '**What’s working.** ' + r.working + '\n\n' : '') +
      (r.priorities.length ? '**What I’d focus on now:**\n' + r.priorities.map((x) => '- ' + x).join('\n') + '\n\n' : '') +
      (r.unfinished.length ? '**Still in progress (leaving these alone):**\n' + r.unfinished.map((x) => '- ' + x).join('\n') : '')
  }
  // put the read in the Ask thread, so it's visible and follow-up questions know it
  function showRead(r) {
    if (threadDoc !== getDocId()) clearThread()
    const el = askEntry('Editor’s read of the draft', 'Before the Review')
    const a = readAnswer(r)
    fillEntry(el, a, [], '')
    thread.push({ q: 'What is your overall read of the draft?', a })
    askPanel.classList.remove('hidden')
    placeAsk()
  }

  /* ---- a run ---- */
  function pendingCard(mode) {
    const card = document.createElement('div')
    card.className = 'cmt-card sg-card sg-pending'
    card.innerHTML = '<span class="sg-spin"></span><span>' + (mode === 'proofread' ? 'Proofreading…' : mode === 'links' ? 'Finding links…' : mode === 'review' ? 'Reading the whole piece…' : 'Reading…') +
      '</span><button class="sg-stop" type="button">Stop</button>'
    card.querySelector('.sg-stop').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); stop() })
    card.addEventListener('mousedown', (e) => e.preventDefault())
    card.style.transition = 'none'
    return card
  }

  // map a position from the doc the request was made against to the doc now
  editor.on('transaction', ({ transaction }) => {
    if (!transaction.docChanged) return
    for (const r of [run, askRun]) if (r) r.maps.push(transaction.mapping)
  })

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
    if (scope.whole) toast({ proofread: 'Proofreading', review: 'Reviewing', links: 'Finding links in' }[mode] + ' the whole draft…')

    const thisRun = run
    try {
      // the writer's notes (not for Proofread): refetched first if a Google Doc has gone
      // stale; a long journal is cut down to the excerpts relevant to this passage
      const query = scope.label + '\n' + blocks.map((b) => b.str).join('\n')
      const [notes, sources] = mode !== 'proofread'
        ? await Promise.all([freshContext(query), mode === 'links' ? [] : linkedSources(state.doc)])
        : [{ parts: [], urls: new Set() }, []]
      if (controller.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' })
      const parts = batches(blocks, mode)
      const docText = documentText(state.doc, fnNum)
      const footnotes = footnotesText()
      // Review: first read the whole piece (what it is, its stage, what's unfinished), then
      // go through it part by part with that read in hand
      let read = null
      if (mode === 'review') {
        const r = await editorsRead(docText, footnotes, notes.parts, sources, controller.signal)
        read = r.read
        if (thisRun.docId !== getDocId()) return
        if (r.fresh) showRead(read)
        thisRun.card.querySelector('span:not(.sg-spin)').textContent = parts.length > 1 ? 'Editing ' + parts.length + ' parts…' : 'Editing…'
      }
      // Review scales with length: ~1 suggestion per 90 words of a part, between 4 and 12
      const limitFor = (part) => mode === 'proofread' ? 15 : mode === 'links' ? 0
        : Math.max(4, Math.min(12, Math.round(countWords(part.map((b) => b.str).join(' ')) / 90)))
      const results = await pool(parts, (part, i) => requestSuggestions(mode, {
        title: ($('docTitle') || {}).textContent || '',
        subtitle: ($('docSubtitle') || {}).textContent || '',
        // the passage already is the whole draft → don't send it twice
        docText: scope.whole && parts.length === 1 ? '' : docText + footnotes,
        footnotes: scope.whole && parts.length === 1 ? footnotes : '',
        passage: part.map((b, j) => '[P' + (j + 1) + (b.kind ? ', ' + b.kind : '') + '] ' + b.str).join('\n\n'),
        where: scope.where + (parts.length > 1 ? ', part ' + (i + 1) + ' of ' + parts.length : ''),
        notes: notes.parts,
        limit: limitFor(part),
        read,
        sources,
        linked: linkedWords(state.doc, part),
        // Proofread only gets the comments on its own part (it may act on them)
        authorComments: mode === 'proofread' ? commentsIn(part) : authorComments(),
      }, controller.signal))
      if (thisRun.docId !== getDocId()) return // switched drafts while it was thinking
      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length === results.length) throw failed[0].reason
      let unplaced = 0, overtaken = 0
      const raw = []
      lastUnplaced.length = 0
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        for (const sg of r.value.suggestions) {
          const it = toItem(sg, parts[i], mode, state.doc, notes.urls)
          if (it && it.kind === 'note' && tellsUnfinished(it, read)) continue
          if (it) raw.push(it); else { unplaced++; lastUnplaced.push({ ...sg, part: i }) }
        }
      })
      const checked = await verifyWebLinks(raw, controller.signal)
      if (thisRun.docId !== getDocId()) return
      const mapping = { map: (p, assoc) => thisRun.mapPos(p, assoc) }
      const seen = new Set()
      const items = []
      // a fix the other mode already shows (Review re-finding a Proofread typo) isn't repeated
      const shown = new Set(st().items.filter((it) => it.mode !== mode && it.kind === 'edit').flatMap((it) => it.hunks.map(hunkKey)))
      // nor is a link another run already offers
      const linked = new Set(st().items.filter((it) => it.mode !== mode && it.kind === 'link').map(says))
      for (let it of checked) {
        if (items.length >= MAX_ITEMS[mode]) break
        it = mapItem(it, mapping, editor.state.doc) // carry it over edits made while waiting
        if (!it) { overtaken++; continue }
        if (it.kind === 'edit') {
          const hunks = it.hunks.filter((h) => !shown.has(hunkKey(h)))
          if (!hunks.length) continue
          it = { ...it, hunks }
        }
        if (it.kind === 'link' && linked.has(says(it))) continue
        const fp = fingerprint(it)
        if (dismissed.has(fp) || seen.has(fp)) continue
        seen.add(fp)
        items.push(it)
      }
      if (unplaced) console.info('[suggest] ' + unplaced + ' suggestion(s) could not be placed')
      if (failed.length) console.warn('[suggest] ' + failed.length + ' part(s) failed:', failed.map((f) => f.reason && f.reason.message))
      dispatchMeta({
        replace: { mode, from: thisRun.mapPos(scope.from, 1), to: thisRun.mapPos(scope.to, -1) },
        add: items,
      })
      if (!items.length && overtaken) toast('The text changed while it was reading — try again')
      else if (!items.length) toast({ proofread: 'No errors found', review: 'Nothing to suggest — it reads well', links: 'No links to suggest' }[mode])
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

  /* ---- Ask: a question about the draft (or the selection), answered in a panel; anything
     the answer points at in the text comes back as ordinary suggestions in the margin ---- */
  const askPanel = $('askPanel')
  const askThread = $('askThread')
  const askInput = $('askInput')
  let askRun = null
  let thread = []       // this draft's conversation: { q, a } (sent back as context for follow-ups)
  let threadDoc = null

  function placeAsk() {
    // bottom-left, in the gutter beside the text when there's room (the margin on the right
    // is where its suggestions land); on a narrow screen, across the bottom
    const col = $('surface').getBoundingClientRect()
    const w = col.left >= 330 ? Math.min(440, col.left - 32) : Math.min(420, window.innerWidth - 32)
    askPanel.style.width = w + 'px'
  }
  function openAsk({ focus = true } = {}) {
    if (threadDoc !== getDocId()) clearThread()
    askPanel.classList.remove('hidden')
    placeAsk()
    if (focus) askInput.focus()
  }
  function closeAsk() { askPanel.classList.add('hidden') }
  function clearThread() {
    if (askRun) askRun.controller.abort()
    thread = []
    threadDoc = getDocId()
    askThread.innerHTML = '<div class="ask-empty">Ask anything about the draft — or select a passage first to ask about just that. ' +
      'Anything the answer points at shows up in the margin to accept or dismiss.</div>'
  }
  window.addEventListener('resize', () => { if (!askPanel.classList.contains('hidden')) placeAsk() })

  function goTo(id) {
    const it = find(id)
    if (!it) { toast('Already accepted or dismissed'); return }
    comments.deactivate()
    dispatchMeta({ active: id })
    const at = it.kind === 'edit' ? it.hunks[0].delFrom : it.from
    editor.chain().focus().setTextSelection(at).scrollIntoView().run()
  }

  function askEntry(q, scopeLabel) {
    const el = document.createElement('div')
    el.className = 'ask-entry'
    el.innerHTML = '<div class="ask-q"></div><div class="ask-meta"></div>' +
      '<div class="ask-a pending"><span class="sg-spin"></span><span>Thinking…</span><button class="sg-stop" type="button">Stop</button></div>'
    el.querySelector('.ask-q').textContent = q
    el.querySelector('.ask-meta').textContent = scopeLabel
    el.querySelector('.sg-stop').addEventListener('click', () => { if (askRun) askRun.controller.abort() })
    const empty = askThread.querySelector('.ask-empty')
    if (empty) empty.remove()
    askThread.appendChild(el)
    askThread.scrollTop = askThread.scrollHeight
    return el
  }
  function fillEntry(el, answer, items, note) {
    const a = el.querySelector('.ask-a')
    a.className = 'ask-a'
    a.innerHTML = answerHTML(answer) || '<p class="ask-faint">No answer.</p>'
    if (items.length) {
      const refs = document.createElement('div')
      refs.className = 'ask-refs'
      refs.innerHTML = '<div class="ask-refs-h">In the margin</div>'
      for (const it of items) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ask-ref'
        b.dataset.sg = it.id
        const label = it.kind === 'format' ? (it.format === 'bold' ? 'Bold' : 'Italic') : it.kind === 'equation' ? 'Equation' : CATEGORY_LABELS[it.category]
        const text = textOf(editor.state.doc, it.from, it.to)
        const line = it.kind === 'format' ? '“' + text + '”' : it.kind === 'equation' ? '$' + it.tex + '$' : summary(it, text)
        b.innerHTML = '<span class="ask-ref-k">' + label + '</span><span class="ask-ref-t">' + commentHTML(line.slice(0, 160)) + '</span>'
        b.addEventListener('click', () => goTo(it.id))
        refs.appendChild(b)
      }
      a.after(refs)
    }
    if (note) {
      const n = document.createElement('div')
      n.className = 'ask-note'
      n.textContent = note
      el.appendChild(n)
    }
    askThread.scrollTop = askThread.scrollHeight
  }

  async function ask(question) {
    question = String(question || '').trim()
    if (!question || askRun) return
    if (!aiSettings().apiKey) { toast('Add your OpenAI key in Settings first'); openSettings(); return }
    openAsk({ focus: false })
    const state = editor.state
    const scope = scopeOf(state)
    const fnNum = footnoteNumbers(state.doc)
    const blocks = passageBlocks(state.doc, scope.from, scope.to, fnNum)
    const el = askEntry(question, 'About: ' + scope.label)
    askInput.value = ''
    askInput.placeholder = 'Ask a follow-up…'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const maps = []
    const thisRun = askRun = {
      maps, controller, docId: getDocId(),
      mapPos: (p, assoc) => maps.reduce((q, m) => m.map(q, assoc), p),
    }
    askPanel.classList.add('busy')
    try {
      const [notes, sources] = await Promise.all([freshContext(question + '\n' + blocks.map((b) => b.str).join('\n')), linkedSources(state.doc)])
      if (controller.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' })
      const docText = documentText(state.doc, fnNum)
      const footnotes = footnotesText()
      const res = await requestSuggestions('ask', {
        title: ($('docTitle') || {}).textContent || '',
        subtitle: ($('docSubtitle') || {}).textContent || '',
        docText: scope.whole ? '' : docText + footnotes,
        footnotes: scope.whole ? footnotes : '',
        passage: blocks.map((b, j) => '[P' + (j + 1) + (b.kind ? ', ' + b.kind : '') + '] ' + b.str).join('\n\n'),
        where: scope.where,
        notes: notes.parts,
        limit: 8,
        linked: linkedWords(state.doc, blocks),
        read: (reads.get(getDocId()) || {}).read || null,
        sources,
        stage: getStage() === 'auto' ? '' : getStage(),
        authorComments: authorComments(),
        question,
        history: thread.slice(-6),
      }, controller.signal)
      if (thisRun.docId !== getDocId()) return // switched drafts while it was thinking
      let unplaced = 0
      const raw = []
      for (const sg of res.suggestions) {
        const it = toItem(sg, blocks, 'ask', state.doc, notes.urls)
        if (it) raw.push(it); else unplaced++
      }
      const checked = await verifyWebLinks(raw, controller.signal)
      if (thisRun.docId !== getDocId()) return
      const mapping = { map: (p, assoc) => thisRun.mapPos(p, assoc) }
      const showing = new Set(st().items.map(says)) // already in the margin from another run
      const items = []
      let overtaken = 0
      for (let it of checked) {
        if (items.length >= MAX_ITEMS.ask) break
        it = mapItem(it, mapping, editor.state.doc)
        if (!it) { overtaken++; continue }
        const said = says(it)
        if (dismissed.has(fingerprint(it)) || showing.has(said)) continue
        showing.add(said)
        items.push(it)
      }
      if (unplaced) console.info('[ask] ' + unplaced + ' suggestion(s) could not be placed')
      if (items.length) dispatchMeta({ add: items })
      thread.push({ q: question, a: res.answer })
      fillEntry(el, res.answer, items, overtaken ? 'The text changed while it was thinking, so some of its suggestions no longer apply.' : '')
    } catch (err) {
      const a = el.querySelector('.ask-a')
      a.className = 'ask-a ask-err'
      a.textContent = err.name === 'AbortError' ? 'Stopped.' : (err.message || 'Something went wrong.')
    } finally {
      clearTimeout(timer)
      if (askRun === thisRun) askRun = null
      askPanel.classList.remove('busy')
    }
  }

  $('askForm').addEventListener('submit', (e) => { e.preventDefault(); ask(askInput.value) })
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(askInput.value) }
    else if (e.key === 'Escape') { e.preventDefault(); closeAsk(); editor.commands.focus() }
  })
  askInput.addEventListener('input', () => { askInput.style.height = 'auto'; askInput.style.height = Math.min(askInput.scrollHeight, 140) + 'px' })
  $('askClose').addEventListener('click', closeAsk)
  $('askClear').addEventListener('click', () => { clearThread(); askInput.placeholder = 'Ask about the draft…'; askInput.focus() })
  // keep the editor's selection (the question's scope) when clicking around the panel
  askPanel.addEventListener('mousedown', (e) => { if (!e.target.closest('textarea, input, a')) e.preventDefault() })

  /* ---- the menu ---- */
  function openMenu() {
    const scope = scopeOf(editor.state)
    $('sgScope').textContent = scope.label + (scope.whole ? ' — select text to narrow it' : '')
    menu.querySelectorAll('[data-mode]').forEach((b) => { b.disabled = !!run })
    $('sgStop').hidden = !run
    $('sgClear').hidden = !st().items.length
    const stage = getStage()
    menu.querySelectorAll('[data-stage]').forEach((b) => b.classList.toggle('on', b.dataset.stage === stage))
    context.render()
    menu.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = menu.offsetWidth
    menu.style.top = (r.bottom + 6) + 'px'
    menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px'
    $('sgAskInput').value = ''
    if (!TOUCH) $('sgAskInput').focus() // type a question straight away (the selection stays the scope)
  }
  function closeMenu() { menu.classList.add('hidden') }

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault() // keep the editor's selection: it's the scope
    if (menu.classList.contains('hidden')) openMenu(); else closeMenu()
  })
  // keep the editor's selection while using the menu (but let its inputs take focus)
  menu.addEventListener('mousedown', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault() })
  menu.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => start(b.dataset.mode)))
  menu.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => {
    setStage(b.dataset.stage)
    menu.querySelectorAll('[data-stage]').forEach((x) => x.classList.toggle('on', x === b))
  }))
  $('sgStop').addEventListener('click', () => { stop(); closeMenu() })
  $('sgClear').addEventListener('click', () => { clearAll(); closeMenu() })
  $('sgCtxAdd').addEventListener('click', () => { closeMenu(); context.openAdd() })
  $('sgAskForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const q = $('sgAskInput').value
    closeMenu()
    if (q.trim()) ask(q); else openAsk()
  })
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) closeMenu() })
  clearThread()

  // exposed for console debugging / verification
  return {
    start, stop, ask, openAsk, clear: clearAll, items: () => st().items, accept, dismiss, keepAsComment, closedSource,
    reads, getStage, lastUnplaced,
    _internal: { requestRead, linkedWords, footnoteNumbers, locate, wordHunks, toItem, passageBlocks, scopeOf, documentText, verifyWebLinks, titleMatches, answerHTML },
  }
}
