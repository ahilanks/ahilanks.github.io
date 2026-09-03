/* mathlive-config.js — global MathLive setup + the AI/ML virtual-keyboard layers.
 * Edit the AI_LAYER below to change which symbols appear in the custom keyboard. */

import { MathfieldElement, getMathVirtualKeyboard } from '../vendor/lib.bundle.js'
import { VENDOR_BASE } from './config.js'

// A compact layer of the symbols that come up most in AI/ML writing.
// Each keycap inserts its `latex`; `#@` means "wrap the previous item", `#0` a slot.
const AI_LAYER = {
  label: 'AI/ML',
  tooltip: 'Probability & linear algebra',
  rows: [
    [
      { latex: '\\mathbb{E}', tooltip: 'expectation' },
      { latex: '\\mathbb{P}', tooltip: 'probability' },
      { latex: '\\operatorname{Var}' }, { latex: '\\operatorname{Cov}' },
      { latex: '\\sim' }, { latex: '\\mathcal{N}' },
      { latex: '\\mid' }, { latex: '\\propto' },
    ],
    [
      { latex: '\\sum_{#0}^{#0}' }, { latex: '\\prod_{#0}^{#0}' }, { latex: '\\int_{#0}^{#0}' },
      { latex: '\\nabla' }, { latex: '\\partial' },
      { latex: '\\operatorname*{arg\\,max}' }, { latex: '\\operatorname*{arg\\,min}' },
      { latex: '\\|#0\\|' },
    ],
    [
      { latex: '\\hat{#@}' }, { latex: '\\bar{#@}' }, { latex: '\\tilde{#@}' }, { latex: '#@^{\\top}' },
      { latex: '\\in' }, { latex: '\\subseteq' }, { latex: '\\otimes' }, { latex: '\\odot' },
    ],
    [
      { latex: '\\alpha' }, { latex: '\\beta' }, { latex: '\\theta' }, { latex: '\\lambda' },
      { latex: '\\mu' }, { latex: '\\sigma' }, { latex: '\\epsilon' }, { latex: '\\infty' },
    ],
  ],
}

let done = false
export function setupMathLive() {
  if (done) return
  done = true
  // fonts are vendored next to the page; point MathLive at them (offline).
  MathfieldElement.fontsDirectory = new URL(VENDOR_BASE + '/fonts/', document.baseURI).href
  MathfieldElement.soundsDirectory = null // no keypress sounds
  const vk = getMathVirtualKeyboard()
  if (vk) {
    // custom AI layer first, then the built-in symbol/greek/number boards.
    vk.layouts = [AI_LAYER, 'greek', 'symbols', 'numeric']
  }
}

// Per-field options: manual keyboard (we drive it from the corner button) on desktop;
// on touch devices there is no hardware keyboard to type LaTeX shortcuts with, so 'auto'
// pops the virtual keyboard the moment a math field gains focus. Desmos-style inline
// shortcuts (^ _ / sqrt) are MathLive defaults; smart fence auto-closes brackets.
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

// MathLive's default dx/dy/dt/ee/ii/jj shortcuts insert \differentialD, \exponentialE,
// \imaginaryI/J — commands KaTeX doesn't know, so they publish as red errors (and typing
// a word like "dynamics" silently mutates its "dy"). Plain italic letters are fine.
const MATHLIVE_ONLY_SHORTCUTS = ['dx', 'dy', 'dt', 'ee', 'ii', 'jj']

export function configureMathfield(mf) {
  mf.mathVirtualKeyboardPolicy = TOUCH ? 'auto' : 'manual'
  mf.smartFence = true
  mf.smartMode = false
  mf.removeExtraneousParentheses = true
  // inlineShortcuts throws until the field is mounted; configureMathfield runs
  // before the element is appended, so fall back to the 'mount' event.
  const dropMathliveOnlyShortcuts = () => {
    const shortcuts = { ...mf.inlineShortcuts }
    for (const k of MATHLIVE_ONLY_SHORTCUTS) delete shortcuts[k]
    mf.inlineShortcuts = shortcuts
  }
  try { dropMathliveOnlyShortcuts() } catch (e) { mf.addEventListener('mount', dropMathliveOnlyShortcuts, { once: true }) }
}

// Rewrite any MathLive-only commands that still slip through (older saved math, paste)
// into KaTeX-renderable plain letters before the LaTeX is stored.
export function toKatexTex(tex) {
  return tex
    .replace(/\\differentialD\s?/g, 'd')
    .replace(/\\exponentialE\s?/g, 'e')
    .replace(/\\imaginaryI\s?/g, 'i')
    .replace(/\\imaginaryJ\s?/g, 'j')
}

export function mathKeyboard() { return getMathVirtualKeyboard() }
