/* ai-math.js — the ∑ button: AI-format a selected snippet (prose + informal math)
 * into clean KaTeX in place; the "describe it in words" bar under an open equation; and
 * the Settings modal + OpenAI key handling (shared with the writing suggestions in
 * ai-suggest.js).
 *
 * Ported from the v1 editor's runMathOnSelection / callOpenAIFormatMath. The key
 * is auto-loaded from the local server's .env (absolute /.env — the page now lives
 * under /editor/). Insertion reuses the math nodes' own parseHTML by building the
 * canonical <span class="math-inline" data-tex> / <div class="math-block" data-tex>
 * shapes and letting TipTap parse them back into nodes.
 */

import { katex } from '../vendor/lib.bundle.js'
import { CONFIG, LS } from './config.js'
import { $, toast, escapeHtml } from './dom.js'
import { insertAndEditMath } from './nodes/math.js'
import { toKatexTex } from './mathlive-config.js'

let settings = { apiKey: '', model: CONFIG.openai.model, writingModel: CONFIG.openai.writingModel }

// For ai-suggest.js: the current key/models, and the modal to ask for a key.
export const aiSettings = () => settings

/* ------------------------------------------------------------------ settings */
function loadSettings() {
  try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(LS.settings) || '{}')) } catch (e) {}
}
function saveSettings() { localStorage.setItem(LS.settings, JSON.stringify(settings)) }

// Auto-load OPENAI_API_KEY from the local server's .env so it never has to be pasted.
// ABSOLUTE path: the page is at /editor/, so a relative ".env" would wrongly hit /editor/.env.
async function loadKeyFromEnv() {
  try {
    const res = await fetch('/.env', { cache: 'no-store' })
    if (!res.ok) return
    const text = await res.text()
    const m = text.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m)
    if (m && m[1]) {
      settings.apiKey = m[1].trim()
      saveSettings()
      const field = $('apiKey')
      if (field && !field.value) field.value = settings.apiKey
    }
  } catch (e) { /* .env not reachable — fall back to a saved/entered key */ }
}

export function openSettings() {
  $('apiKey').value = settings.apiKey || ''
  $('modelName').value = settings.model || ''
  $('writingModelName').value = settings.writingModel || ''
  const msg = $('settingsMsg'); if (msg) { msg.textContent = ''; msg.className = 'modal-msg' }
  $('settingsOverlay').classList.remove('hidden')
  $('apiKey').focus()
}
function closeSettings() { $('settingsOverlay').classList.add('hidden') }

function wireSettings() {
  $('settingsBtn').addEventListener('click', openSettings)
  $('settingsClose').addEventListener('click', closeSettings)
  $('settingsSave').addEventListener('click', () => {
    settings.apiKey = $('apiKey').value.trim()
    settings.model = $('modelName').value.trim() || CONFIG.openai.model
    settings.writingModel = $('writingModelName').value.trim() || CONFIG.openai.writingModel
    saveSettings()
    const msg = $('settingsMsg'); if (msg) { msg.textContent = 'Saved'; msg.className = 'modal-msg ok' }
    setTimeout(closeSettings, 500)
  })
  // click the dark backdrop (not the modal) to dismiss
  $('settingsOverlay').addEventListener('mousedown', (e) => { if (e.target === $('settingsOverlay')) closeSettings() })
}

/* ------------------------------------------------- selection <-> math text */
// The selected range as plain text, with math nodes written back as $tex$ / $$tex$$.
function selectionAsMathText(editor) {
  const { from, to } = editor.state.selection
  return rangeAsMathText(editor.state.doc, from, to)
}

function rangeAsMathText(doc, from, to) {
  if (from >= to) return ''
  return doc.textBetween(from, to, '\n', (leaf) => {
    if (leaf.type.name === 'inlineMath') return '$' + leaf.attrs.tex + '$'
    if (leaf.type.name === 'blockMath') return '$$' + leaf.attrs.tex + '$$'
    return ''
  })
}

// The paragraph the selection sits in (+ the blocks before/after) for context.
function selectionContext(editor) {
  const { $from } = editor.state.selection
  const depth = $from.depth
  const para = depth > 0 ? $from.node(depth) : null
  const asText = (node) => node ? node.textBetween(0, node.content.size, '\n', (leaf) =>
    leaf.type.name === 'inlineMath' ? '$' + leaf.attrs.tex + '$'
      : leaf.type.name === 'blockMath' ? '$$' + leaf.attrs.tex + '$$' : '') : ''
  const ctx = { paragraph: asText(para).trim(), before: '', after: '' }
  if (depth > 0) {
    const parent = $from.node(depth - 1)
    const idx = $from.index(depth - 1)
    if (idx > 0) ctx.before = asText(parent.child(idx - 1)).trim().slice(-500)
    if (idx < parent.childCount - 1) ctx.after = asText(parent.child(idx + 1)).trim().slice(0, 500)
  }
  return ctx
}

// Turn a "$inline$ / $$block$$ + prose" string into INLINE HTML the math nodes'
// parseHTML understands, so insertContent replaces the selection in place (no new
// paragraph). A standalone $$...$$ becomes a block node, which naturally lifts out.
function htmlFromMathText(str) {
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
  let last = 0, m, html = ''
  const escAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;')
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) html += escapeHtml(str.slice(last, m.index))
    if (m[1] != null) html += `<div class="math-block" data-tex="${escAttr(m[1].trim())}"></div>`
    else html += `<span class="math-inline" data-tex="${escAttr(m[2].trim())}"></span>`
    last = m.index + m[0].length
  }
  if (last < str.length) html += escapeHtml(str.slice(last))
  // keep it inline: collapse newlines to spaces (block math breaks on its own)
  return html.replace(/\s*\n+\s*/g, ' ')
}

/* ------------------------------------------------------------ the OpenAI call */
async function callOpenAIFormatMath(selected, ctx) {
  const sys =
    'You are a typesetting assistant for a writing editor that renders Markdown with KaTeX 0.16. ' +
    'You receive a snippet selected from an article, plus surrounding context. The snippet may mix ' +
    "ordinary prose with math written informally (e.g. 'x^2', 'sum of 1/n^2', 'integral from 0 to 1', " +
    "'<=', 'pi', 'theta') or already in LaTeX. Rewrite ONLY the selected snippet so every mathematical " +
    'expression is valid, well-formatted KaTeX. Follow these rules exactly:\n' +
    '1. Wrap inline math (inside a sentence) in single $...$; put a standalone equation on its own line in $$...$$.\n' +
    '2. Use only KaTeX-supported LaTeX. For multi-line/aligned math use the aligned, cases, matrix/pmatrix/bmatrix, ' +
    'or array environments — NEVER align, align*, eqnarray, equation, gather, or multline.\n' +
    '3. Never emit \\label, \\ref, \\tag, \\newcommand, \\def, \\require, \\usepackage, or custom macros.\n' +
    '4. Convert informal notation to proper commands: fractions -> \\frac{a}{b}, roots -> \\sqrt{...}, ' +
    "'sum'/'integral'/'product' -> \\sum/\\int/\\prod, '*' between symbols -> \\cdot, " +
    "'<=' -> \\le, '>=' -> \\ge, '!=' -> \\neq, '~=' -> \\approx, '->' -> \\to, 'inf' -> \\infty, " +
    'spelled-out Greek -> \\alpha, \\theta, \\pi, etc. Use \\left( ... \\right) for tall delimiters, ' +
    'subscripts/superscripts with _{...} and ^{...}, and \\text{...} for words inside math.\n' +
    '4b. Use standard AI/ML notation: expectation \\mathbb{E}[...], probability \\mathbb{P}, real spaces \\mathbb{R}^{n}, ' +
    '\\operatorname*{arg\\,max}_{x} / \\operatorname*{arg\\,min}_{x}, transpose x^{\\top}, \\operatorname{softmax}, ' +
    '\\operatorname{Var}, D_{\\mathrm{KL}}(p \\,\\|\\, q), \\nabla_{\\theta}, \\mathcal{L} for a loss, \\coloneqq for "is defined as", ' +
    '\\mathbf{x} for vectors and matrices, \\hat{y} / \\theta^{*} for estimates / optima, \\sim for "distributed as".\n' +
    '5. Leave ordinary prose EXACTLY as written, in the same order. Do NOT translate prose into math or vice-versa ' +
    'beyond adding delimiters and standard LaTeX. Do not add or remove sentences.\n' +
    'Output ONLY the rewritten snippet — no commentary, no code fences, no surrounding quotes.'
  let user = ''
  if (ctx.before) user += 'Context before (do not include in output): ' + ctx.before + '\n'
  if (ctx.paragraph) user += 'Full paragraph the selection is part of (for context): ' + ctx.paragraph + '\n'
  if (ctx.after) user += 'Context after (do not include in output): ' + ctx.after + '\n'
  user += '\nSelected snippet to rewrite:\n' + selected
  return chat([{ role: 'system', content: sys }, { role: 'user', content: user }])
}

// One chat completion with the math model → its text, code fences stripped.
async function chat(messages, signal) {
  const base = { model: settings.model || CONFIG.openai.model, messages }
  const attempts = [Object.assign({}, base, { temperature: 0.1 }), Object.assign({}, base)]
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
      const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      if (!c) throw new Error('Empty response.')
      return c.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
    }
    let errText = ''
    try { const j = await res.json(); errText = (j.error && j.error.message) || '' } catch (e) {}
    lastErr = 'OpenAI ' + res.status + (errText ? ': ' + errText : '')
    if (res.status !== 400) break // 400 may be an unsupported param — retry plainer; else stop
  }
  throw new Error(lastErr)
}

/* ------------------------------------------------- describe the math in words
 * A slim bar under whichever equation is open (nodes/math.js announces it). Type what to
 * add or change — "add a KL penalty weighted by β", "make it a sum over t", or for an
 * empty one just "Bayes' rule" — and the model rewrites THAT equation. The result lands in
 * the open field, where you can keep typing; nothing is saved until you leave the
 * equation, and Undo puts the old one back. Typing math by hand works as before. */

const MATH_EDIT_SYS =
  'You edit ONE math expression in an essay about AI and machine learning; it is rendered with KaTeX 0.16. ' +
  'You get the expression\'s current LaTeX (possibly empty), the text around it, and the writer\'s instruction in words. ' +
  'Return the COMPLETE updated expression.\n' +
  'Rules:\n' +
  '1. Do what the instruction asks and nothing more: keep every other part of the expression exactly as it is ' +
  '(same symbols, order and notation). If the expression is empty, write what the instruction describes.\n' +
  '2. Match the notation already used in the surrounding text and the draft\'s other equations.\n' +
  '3. Only KaTeX-supported LaTeX. For several lines use aligned, cases, matrix/pmatrix/bmatrix or array — never ' +
  'align, align*, eqnarray, equation, gather or multline. Never \\label, \\ref, \\tag, \\newcommand, \\def or custom macros.\n' +
  '4. Standard AI/ML notation: \\mathbb{E}[...], \\mathbb{P}, \\mathbb{R}^{n}, \\operatorname*{arg\\,max}_{x}, x^{\\top}, ' +
  '\\operatorname{softmax}, D_{\\mathrm{KL}}(p \\,\\|\\, q), \\nabla_{\\theta}, \\mathcal{L} for a loss, \\coloneqq for "is defined as", ' +
  '\\mathbf{x} for vectors and matrices, \\hat{y} / \\theta^{*}, \\sim for "distributed as", \\text{...} for words.\n' +
  'Output ONLY the LaTeX of the expression — no $ delimiters, no code fences, no explanation.'

// The equation's surroundings as text, with the equation itself marked, plus the draft's
// other equations (for consistent notation).
function mathContext(editor, pos) {
  const doc = editor.state.doc
  if (typeof pos !== 'number' || pos < 0 || pos >= doc.content.size) return ''
  const leaf = (n) => n.type.name === 'inlineMath' ? '$' + n.attrs.tex + '$' : n.type.name === 'blockMath' ? '$$' + n.attrs.tex + '$$' : ''
  const textOf = (node, start) => {
    let s = ''
    node.forEach((child, offset) => {
      if (start + offset === pos) s += '⟦THIS EXPRESSION⟧'
      else if (child.isText) s += child.text
      else s += leaf(child)
    })
    return s
  }
  const $p = doc.resolve(pos)
  const node = doc.nodeAt(pos)
  let ctx = ''
  if (node && node.type.name === 'blockMath') {
    const parent = $p.parent, idx = $p.index()
    const block = (i) => i >= 0 && i < parent.childCount ? parent.child(i).textBetween(0, parent.child(i).content.size, ' ', leaf) : ''
    const before = block(idx - 1).slice(-800), after = block(idx + 1).slice(0, 800)
    ctx = 'This is a display equation.\n' + (before ? 'Text before it: ' + before + '\n' : '') + (after ? 'Text after it: ' + after + '\n' : '')
  } else if ($p.parent.isTextblock) {
    ctx = 'This is inline math inside a sentence. The paragraph it sits in:\n' + textOf($p.parent, $p.start()).slice(0, 1500) + '\n'
  }
  const others = []
  let total = 0
  doc.descendants((n, p) => {
    if (p === pos || total > 2500 || (n.type.name !== 'inlineMath' && n.type.name !== 'blockMath')) return
    if (n.attrs.tex && !others.includes(n.attrs.tex)) { others.push(n.attrs.tex); total += n.attrs.tex.length }
  })
  if (others.length) ctx += 'The draft\'s other equations: ' + others.map((t) => '$' + t + '$').join('  ') + '\n'
  return ctx
}

const unwrapTex = (t) => t.trim()
  .replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1')
  .replace(/^\\\[([\s\S]*)\\\]$/, '$1').replace(/^\\\(([\s\S]*)\\\)$/, '$1').trim()

async function callOpenAIMathEdit({ current, instruction, block, context }, signal) {
  const user =
    (context ? context + '\n' : '') +
    'Current expression: ' + (current ? current : '(empty)') + '\n' +
    'Instruction: ' + instruction +
    (block ? '' : '\n(Inline math: keep it on one line — no multi-line environments.)')
  const messages = [{ role: 'system', content: MATH_EDIT_SYS }, { role: 'user', content: user }]
  let tex = unwrapTex(await chat(messages, signal))
  // one repair round if KaTeX (which draws the published page) can't render it
  for (let tries = 0; ; tries++) {
    try { katex.renderToString(tex, { ...CONFIG.katex, displayMode: block, throwOnError: true }); return tex } catch (e) {
      if (tries > 0) throw new Error('The model\'s LaTeX doesn\'t render: ' + (e.message || e))
      messages.push({ role: 'assistant', content: tex }, { role: 'user', content: 'KaTeX fails on that: ' + (e.message || e) + '. Return a corrected version, LaTeX only.' })
      tex = unwrapTex(await chat(messages, signal))
    }
  }
}

function setupMathAsk(editor) {
  const bar = $('mathAsk'), input = $('mathAskInput'), status = $('mathAskStatus'), undoBtn = $('mathAskUndo')
  const scroller = $('scrollArea')
  let cur = null          // the open equation (handle from nodes/math.js)
  let pending = null      // the request in flight: { controller, handle }
  let focusOnOpen = false // the ∑ button opened a blank equation: start in the bar

  function place() {
    if (!cur || bar.classList.contains('hidden')) return
    const r = cur.dom.getBoundingClientRect()
    const w = bar.offsetWidth, h = bar.offsetHeight
    const left = cur.isBlock ? r.left + r.width / 2 - w / 2 : r.left
    bar.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px'
    // below the equation, or above it when there's no room (bottom of the screen, keyboard)
    const below = r.bottom + 6
    bar.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below) + 'px'
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null

  function setStatus(text, { busy = false, undo = false, err = false } = {}) {
    status.textContent = text
    status.className = 'ma-status' + (busy ? ' busy' : '') + (err ? ' err' : '')
    undoBtn.hidden = !undo
    bar.classList.toggle('busy', busy)
    place()
  }
  function show(handle) {
    cur = handle
    input.value = ''
    setStatus('')
    bar.classList.remove('hidden')
    if (ro) { ro.disconnect(); ro.observe(handle.dom) }
    place()
    if (focusOnOpen) { focusOnOpen = false; input.focus() }
  }
  function hide() {
    if (pending && pending.handle === cur) { pending.controller.abort(); pending = null }
    cur = null
    if (ro) ro.disconnect()
    bar.classList.add('hidden')
  }

  document.addEventListener('math-edit-open', (e) => show(e.detail))
  document.addEventListener('math-edit-close', (e) => { if (e.detail === cur) hide() })
  document.addEventListener('math-ask', () => { if (cur) input.focus() }) // ⌘K inside an equation
  scroller.addEventListener('scroll', place, { passive: true })
  window.addEventListener('resize', place)

  async function ask() {
    const instruction = input.value.trim()
    if (!instruction || !cur || pending) return
    if (!settings.apiKey) { toast('Add your OpenAI key in Settings first'); openSettings(); return }
    const handle = cur, mf = handle.mf
    if (!mf) return
    const before = mf.getValue('latex')
    const controller = new AbortController()
    pending = { controller, handle }
    setStatus('Writing…', { busy: true })
    try {
      const tex = await callOpenAIMathEdit({
        current: toKatexTex(before).trim(), instruction, block: handle.isBlock,
        context: mathContext(editor, handle.getPos()),
      }, controller.signal)
      if (cur !== handle || !handle.editing || handle.mf !== mf) return // the equation was closed
      if (mf.getValue('latex') !== before) { setStatus('The equation changed while it was writing — ask again', { err: true }); return }
      // one undoable step in the field (Undo below, or ⌘Z in the equation). MathLive merges
      // consecutive inserts that end on the same kind of atom into one undo step, so two
      // asks in a row would undo together — break the merge first (private API, guarded).
      try { mf._mathfield.stopCoalescingUndo() } catch (e) {}
      mf.insert(tex, { insertionMode: 'replaceAll', selectionMode: 'after', format: 'latex' })
      input.value = ''
      setStatus('Done', { undo: true })
    } catch (err) {
      if (err.name !== 'AbortError' && cur === handle) setStatus(err.message || 'Couldn\'t write that', { err: true })
    } finally {
      if (pending && pending.controller === controller) pending = null
      if (cur === handle && bar.classList.contains('busy')) setStatus('')
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ask() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (cur && cur.mf) cur.mf.focus() }
  })
  input.addEventListener('input', () => { if (!pending && status.textContent) setStatus('') })
  // focus leaving the bar for somewhere other than its equation closes the equation, the
  // same as leaving the field itself does
  input.addEventListener('focusout', () => setTimeout(() => { if (cur) cur.leaveIfFocusGone() }, 0))
  bar.addEventListener('mousedown', (e) => { if (e.target !== input) e.preventDefault() }) // keep focus where it is
  undoBtn.addEventListener('click', () => {
    if (cur && cur.mf) { cur.mf.executeCommand('undo'); cur.mf.focus() }
    setStatus('')
  })

  return {
    // the ∑ button: focus the bar of the open equation, else open a blank one and start there
    describe() {
      if (cur) { input.focus(); return }
      focusOnOpen = true
      insertAndEditMath(editor, { block: false })
      focusOnOpen = false
      // if the editor wasn't focused, TipTap's focus() lands a frame later and would take
      // focus back from the bar (closing the blank equation) — re-take it after that
      requestAnimationFrame(() => { if (cur) input.focus() })
    },
    isOpen: () => !!cur,
  }
}

// Exposed for testing the transform without a network call.
export const _internal = { selectionAsMathText, htmlFromMathText, selectionContext }

async function runMathOnSelection(editor) {
  if (editor.state.selection.empty) { toast('Highlight the text (prose + math) to format'); return }
  if (!settings.apiKey) { toast('Add your OpenAI key in Settings first'); openSettings(); return }
  const selected = selectionAsMathText(editor)
  if (!selected.trim()) { toast('Nothing to format'); return }
  const ctx = selectionContext(editor)
  // The reply takes a moment, and the writer may click or type elsewhere meanwhile: pin
  // the highlighted range and carry it through every edit until the answer arrives, so
  // the math replaces what was selected — not wherever the caret has moved to.
  let { from, to } = editor.state.selection
  const track = ({ transaction }) => {
    if (!transaction.docChanged) return
    from = transaction.mapping.map(from, 1)
    to = transaction.mapping.map(to, -1)
  }
  editor.on('transaction', track)
  toast('Formatting math…')
  try {
    const out = await callOpenAIFormatMath(selected, ctx)
    editor.off('transaction', track)
    if (to <= from || rangeAsMathText(editor.state.doc, from, to) !== selected) {
      toast('That text changed while formatting — select it and try again')
      return
    }
    // leave the caret where the writer is now
    editor.chain().insertContentAt({ from, to }, htmlFromMathText(out), { updateSelection: false }).run()
    toast('Math formatted ✓')
  } catch (err) {
    toast(err.message || "Couldn't format math")
  } finally {
    editor.off('transaction', track)
  }
}

/* ------------------------------------------------------------------- wire up */
export function setupAiMath(editor) {
  loadSettings()
  loadKeyFromEnv()
  wireSettings()

  const mathAsk = setupMathAsk(editor)

  // ∑ Math (bubble, shown on a selection) → format the selection in place.
  $('bubbleAI').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); runMathOnSelection(editor) })
  // Toolbar math icon: with text selected → AI-format it; otherwise a blank equation (or the
  // open one) with the "describe it in words" bar focused — click the equation to type it.
  $('mathBtn').addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation()
    const sel = editor.state.selection
    if (!sel.empty && !sel.node && !mathAsk.isOpen()) runMathOnSelection(editor)
    else mathAsk.describe()
  })

  // expose for verification
  return { runMathOnSelection: () => runMathOnSelection(editor), getSettings: () => settings, _internal: { mathContext, unwrapTex } }
}
