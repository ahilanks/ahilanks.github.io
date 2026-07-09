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

// Per-field options: manual keyboard (we drive it from the corner button), Desmos-style
// inline shortcuts (^ _ / sqrt) are MathLive defaults; smart fence auto-closes brackets.
export function configureMathfield(mf) {
  mf.mathVirtualKeyboardPolicy = 'manual'
  mf.smartFence = true
  mf.smartMode = false
  mf.removeExtraneousParentheses = true
}

export function mathKeyboard() { return getMathVirtualKeyboard() }
