/* mathlive-config.js — global MathLive setup: fonts, the virtual keyboard's layers and
 * the typing shortcuts. The layers + shortcuts themselves live in math-keyboard.js. */

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
  // inlineShortcuts throws until the field is mounted; configureMathfield runs
  // before the element is appended, so fall back to the 'mount' event.
  const applyShortcuts = () => { mf.inlineShortcuts = editedShortcuts(mf.inlineShortcuts) }
  try { applyShortcuts() } catch (e) { mf.addEventListener('mount', applyShortcuts, { once: true }) }
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
}

export function mathKeyboard() { return getMathVirtualKeyboard() }
