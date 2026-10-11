/* mathlive-config.js — global MathLive setup: fonts, the virtual keyboard's layers and
 * the typing shortcuts (the layers + shortcuts themselves live in math-keyboard.js), and
 * the keys inside an equation: Space, Tab, ⌘B / ⌘I, ⌘K (describe it in words). */

import { MathfieldElement, getMathVirtualKeyboard } from '../vendor/lib.bundle.js'
import { VENDOR_BASE } from './config.js'
import { KEYBOARD_LAYOUTS, SHORTCUTS_ADD, SHORTCUTS_REMOVE, SHORTCUTS_NO_LETTER_BEFORE } from './math-keyboard.js'

let done = false
export function setupMathLive() {
  if (done) return
  done = true
  // fonts are vendored next to the page; point MathLive at them (offline).
  MathfieldElement.fontsDirectory = new URL(VENDOR_BASE + '/fonts/', document.baseURI).href
  MathfieldElement.soundsDirectory = null // no keypress sounds
  const vk = getMathVirtualKeyboard()
  if (vk) {
    // custom AI/ML layers first, then the built-in Greek / numeric / symbol boards.
    vk.layouts = KEYBOARD_LAYOUTS
  }
}

// Per-field options: manual keyboard (we drive it from the corner button) on desktop;
// on touch devices there is no hardware keyboard to type LaTeX shortcuts with, so 'auto'
// pops the virtual keyboard the moment a math field gains focus. Desmos-style inline
// shortcuts (^ _ / sqrt) are MathLive defaults; smart fence auto-closes brackets.
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

// Every preceding-atom kind MathLive's `after` condition knows, minus "letter".
const NOT_AFTER_LETTER = 'nothing+digit+function+frac+surd+binop+relop+operator+punct+array+openfence+closefence+space+text'

// MathLive's defaults, edited for AI/ML writing (see math-keyboard.js for why).
function editedShortcuts(defaults) {
  const shortcuts = { ...defaults }
  for (const key of SHORTCUTS_REMOVE) delete shortcuts[key]
  for (const key of SHORTCUTS_NO_LETTER_BEFORE) {
    const v = shortcuts[key]
    if (typeof v === 'string') shortcuts[key] = { after: NOT_AFTER_LETTER, value: v }
  }
  return Object.assign(shortcuts, SHORTCUTS_ADD)
}

export function configureMathfield(mf) {
  mf.mathVirtualKeyboardPolicy = TOUCH ? 'auto' : 'manual'
  mf.smartFence = true
  mf.smartMode = false
  mf.removeExtraneousParentheses = true
  // MathLive's default ("") makes the spacebar do nothing in math. A thick space reads
  // like a word gap; spaceKey() below skips it where TeX already spaces things out.
  mf.mathModeSpace = GAP
  // inlineShortcuts throws until the field is mounted; configureMathfield runs
  // before the element is appended, so fall back to the 'mount' event.
  const applyShortcuts = () => { mf.inlineShortcuts = editedShortcuts(mf.inlineShortcuts) }
  try { applyShortcuts() } catch (e) { mf.addEventListener('mount', applyShortcuts, { once: true }) }
  // Capture phase: runs before MathLive's own keydown handler inside the shadow root.
  mf.addEventListener('keydown', onMathKeydown, true)
  // With nowhere left to go, MathLive's Tab/arrows "move out" and focus the next tabbable
  // element on the page — which closed the equation. Stay in the field instead.
  mf.addEventListener('move-out', (e) => e.preventDefault())
}

/* ------------------------------------------------------- space, tab, bold, italic
 * MathLive's model is private API (`mf._mathfield.model`), pinned by the vendored build.
 * Every use is guarded: if it's ever missing, keys fall back to MathLive's defaults. */
const GAP = '\\;'
const TAB_GAP = '\\quad'
// TeX already puts space here, so an extra gap only looks wrong: after an operator,
// relation, comma, opening bracket or big operator (\sum, \log), or at the start of a slot…
const NO_GAP_AFTER = new Set(['first', 'mbin', 'mrel', 'mpunct', 'mopen', 'mop', 'operator', 'extensible-symbol', 'spacing'])
// …and before an operator, relation, comma or closing bracket.
const NO_GAP_BEFORE = new Set(['mbin', 'mrel', 'mpunct', 'mclose', 'spacing'])
// keys that type an operator/relation: a gap the writer just left before one is dropped,
// so "a + b" comes out like a+b (TeX's own spacing), not wider.
const OPERATOR_KEYS = new Set(['+', '-', '=', '<', '>', ',', '*'])

function modelOf(mf) {
  try { return (mf._mathfield && mf._mathfield.model) || null } catch (e) { return null }
}
const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation() }

function onMathKeydown(e) {
  const mf = e.currentTarget
  if (e.isComposing || mf.mode === 'latex') return // typing a \command: MathLive's own Tab/space
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey
  const cmd = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey ? e.key.toLowerCase() : ''
  if (e.key === ' ' && plain) spaceKey(mf, e)
  else if (e.key === 'Tab' && plain) { swallow(e); tabKey(mf, e.shiftKey) }
  else if (OPERATOR_KEYS.has(e.key) && plain) dropGapBefore(mf)
  else if (cmd === 'b' || cmd === 'i') { swallow(e); toggleMathStyle(mf, cmd === 'b' ? 'bold' : 'italic') }
  // ⌘K: describe the change in words (the bar under the equation, ai-math.js). Swallowed
  // so the document's ⌘K (insert link) doesn't also fire.
  else if (cmd === 'k') { swallow(e); mf.dispatchEvent(new CustomEvent('math-ask', { bubbles: true })) }
}

function spaceKey(mf, e) {
  const model = modelOf(mf)
  if (!model || mf.mode !== 'math') return // text mode types a normal space
  if (slotAtCaret(model)) { swallow(e); return } // an empty slot: nothing to space
  if (!model.selectionIsCollapsed) return // replaces the selection with a gap
  const prev = model.at(model.position)
  const next = prev && prev.rightSibling
  if (!prev || prev.mode === 'text' || (next && next.mode === 'text')) return // beside \text{}: a real space
  if (NO_GAP_AFTER.has(prev.type) || (next && NO_GAP_BEFORE.has(next.type))) {
    swallow(e)
    // a space still ends a typing shortcut, as it would in MathLive ("+ -" mustn't become ±)
    try { mf._mathfield.flushInlineShortcutBuffer() } catch (err) {}
  }
  // otherwise MathLive inserts mathModeSpace
}

function dropGapBefore(mf) {
  const model = modelOf(mf)
  if (!model || mf.mode !== 'math' || !model.selectionIsCollapsed) return
  const prev = model.at(model.position)
  if (prev && prev.type === 'spacing' && prev.command === GAP) mf.executeCommand('deleteBackward')
}

/* Tab = the next compartment: the next empty slot (a fraction's denominator, a limit, a
 * matrix cell); else step out of the slot you're in (superscript, numerator, brackets);
 * at the top level, a wide gap (\quad). Shift+Tab goes back and never adds anything. */
function tabKey(mf, back) {
  const model = modelOf(mf)
  if (!model) { if (!back) mf.insert(TAB_GAP); return }
  const slot = slotAtCaret(model)
  const here = slot ? model.offsetOf(slot) : model.position
  const others = []
  for (let i = 0; i <= model.lastOffset; i++) {
    const a = model.at(i)
    if (a && a.type === 'placeholder' && a !== slot) others.push(i)
  }
  if (others.length) {
    // the next empty slot after the caret (wrapping around), selected the way MathLive
    // selects a slot it lands in, so typing fills it
    const to = back ? [...others].reverse().find((i) => i < here) ?? others[others.length - 1]
      : others.find((i) => i > here) ?? others[0]
    mf.selection = { ranges: [[to - 1, to]], direction: 'forward' }
    return
  }
  const at = model.at(model.position)
  const nested = !!at && !!at.parent && at.parent.type !== 'root'
  if (nested) mf.executeCommand(back ? 'moveBeforeParent' : 'moveAfterParent')
  else if (!back && !slot) mf.insert(TAB_GAP)
}

// The empty slot the caret is in (MathLive puts the caret on the slot's "first" atom, just
// before its placeholder), or null.
function slotAtCaret(model) {
  for (const x of [model.at(model.anchor), model.at(model.position)]) {
    if (!x) continue
    if (x.type === 'placeholder') return x
    if (x.type === 'first' && x.rightSibling && x.rightSibling.type === 'placeholder') return x.rightSibling
  }
  return null
}

/* ⌘B / ⌘I inside an equation, on the selection or for what you type next. Letters in math
 * are italic already, so — as in Word's equation editor — ⌘I toggles italic ↔ upright:
 *   x → ⌘I → \mathrm{x}      x → ⌘B → \boldsymbol{x} (bold italic)
 *   \mathrm{x} → ⌘B → \mathbf{x} (bold upright)              (Greek bold: \bm{\theta}) */
function toggleMathStyle(mf, which) {
  const now = ['bolditalic', 'bold', 'up'].find((v) => mf.queryStyle({ variantStyle: v }) === 'all') || ''
  let bold = now === 'bold' || now === 'bolditalic'
  let italic = now === '' || now === 'bolditalic'
  if (which === 'bold') bold = !bold; else italic = !italic
  mf.applyStyle({ variantStyle: bold ? (italic ? 'bolditalic' : 'bold') : (italic ? '' : 'up') })
}

// A gap at either end of an equation does nothing useful (it only pushes the next word
// away), so it's dropped when the equation is saved.
export function trimGaps(tex) {
  const gap = String.raw`\s*\\(?:;|:|,|quad|qquad)(?![a-zA-Z])\s*`
  return tex.replace(new RegExp('^(?:' + gap + ')+|(?:' + gap + ')+$', 'g'), '').trim()
}

// Rewrite any MathLive-only commands that still slip through (older saved math, paste)
// into KaTeX-renderable plain letters before the LaTeX is stored.
export function toKatexTex(tex) {
  return tex
    .replace(/\\differentialD\s?/g, 'd')
    .replace(/\\exponentialE\s?/g, 'e')
    .replace(/\\imaginaryI\s?/g, 'i')
    .replace(/\\imaginaryJ\s?/g, 'j')
    // MathLive-only relations (from older shortcuts) → their KaTeX spellings
    .replace(/\\coloneq(?![a-zA-Z])/g, '\\coloneqq')
    .replace(/\\questeq(?![a-zA-Z])/g, '\\stackrel{?}{=}')
    // MathLive's bold italic (⌘B + ⌘I) → KaTeX's spelling
    .replace(/\\mathbfit(?![a-zA-Z])/g, '\\boldsymbol')
    .replace(/\\(?:mathbf|bm)\{\\boldsymbol\{([^{}]*)\}\}/g, '\\boldsymbol{$1}')
}

export function mathKeyboard() { return getMathVirtualKeyboard() }
