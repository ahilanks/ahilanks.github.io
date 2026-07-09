/* ai-math.js — the ∑ button: AI-format a selected snippet (prose + informal math)
 * into clean KaTeX in place, and the Settings modal + OpenAI key handling.
 *
 * Ported from the v1 editor's runMathOnSelection / callOpenAIFormatMath. The key
 * is auto-loaded from the local server's .env (absolute /.env — the page now lives
 * under /editor/). Insertion reuses the math nodes' own parseHTML by building the
 * canonical <span class="math-inline" data-tex> / <div class="math-block" data-tex>
 * shapes and letting TipTap parse them back into nodes.
 */

import { CONFIG, LS } from './config.js'
import { $, toast, escapeHtml } from './dom.js'
import { insertAndEditMath } from './nodes/math.js'

let settings = { apiKey: '', model: CONFIG.openai.model }

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

function openSettings() {
  $('apiKey').value = settings.apiKey || ''
  $('modelName').value = settings.model || ''
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
  if (from >= to) return ''
  return editor.state.doc.textBetween(from, to, '\n', (leaf) => {
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
    '5. Leave ordinary prose EXACTLY as written, in the same order. Do NOT translate prose into math or vice-versa ' +
    'beyond adding delimiters and standard LaTeX. Do not add or remove sentences.\n' +
    'Output ONLY the rewritten snippet — no commentary, no code fences, no surrounding quotes.'
  let user = ''
  if (ctx.before) user += 'Context before (do not include in output): ' + ctx.before + '\n'
  if (ctx.paragraph) user += 'Full paragraph the selection is part of (for context): ' + ctx.paragraph + '\n'
  if (ctx.after) user += 'Context after (do not include in output): ' + ctx.after + '\n'
  user += '\nSelected snippet to rewrite:\n' + selected

  const base = { model: settings.model || CONFIG.openai.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }
  const attempts = [Object.assign({}, base, { temperature: 0.1 }), Object.assign({}, base)]
  let lastErr = 'Request failed.'
  for (const payload of attempts) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
      body: JSON.stringify(payload),
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

// Exposed for testing the transform without a network call.
export const _internal = { selectionAsMathText, htmlFromMathText, selectionContext }

async function runMathOnSelection(editor) {
  if (editor.state.selection.empty) { toast('Highlight the text (prose + math) to format'); return }
  if (!settings.apiKey) { toast('Add your OpenAI key in Settings first'); openSettings(); return }
  const selected = selectionAsMathText(editor)
  if (!selected.trim()) { toast('Nothing to format'); return }
  const ctx = selectionContext(editor)
  toast('Formatting math…')
  try {
    const out = await callOpenAIFormatMath(selected, ctx)
    editor.chain().focus().deleteSelection().insertContent(htmlFromMathText(out)).run()
    toast('Math formatted ✓')
  } catch (err) {
    toast(err.message || "Couldn't format math")
  }
}

/* ------------------------------------------------------------------- wire up */
export function setupAiMath(editor) {
  loadSettings()
  loadKeyFromEnv()
  wireSettings()

  // ∑ Math (bubble, shown on a selection) → format the selection in place.
  $('bubbleAI').addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); runMathOnSelection(editor) })
  // Toolbar math icon: with a selection → AI-format it; with none → insert a blank editable equation.
  $('mathBtn').addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!editor.state.selection.empty) runMathOnSelection(editor)
    else insertAndEditMath(editor, { block: false })
  })

  // expose for verification
  return { runMathOnSelection: () => runMathOnSelection(editor), getSettings: () => settings }
}
