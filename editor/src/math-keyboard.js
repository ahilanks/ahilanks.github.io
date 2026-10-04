/* math-keyboard.js — the virtual-keyboard layers and typing shortcuts for AI/ML notation.
 *
 * Pure data (no imports), applied by mathlive-config.js. Everything here must ALSO render
 * in KaTeX, which draws the published pages — MathLive knows a few commands KaTeX doesn't.
 *
 * Keycaps: `latex` is shown on the key and inserted; `insert` (when present) is inserted
 * instead. `#@` wraps whatever sits just before the caret (type x, press x̂ → \hat{x});
 * `#0` is an empty slot to fill in. `class: 'small'` shrinks a long label to fit.
 */

const k = (latex, extra) => Object.assign({ latex }, extra)
const sm = (latex, extra) => Object.assign({ latex, class: 'small' }, extra)

// Probability, optimisation and the everyday ML vocabulary.
const AI_LAYER = {
  label: 'AI/ML',
  tooltip: 'Probability, optimisation, ML',
  rows: [
    [
      k('\\mathbb{E}', { tooltip: 'expectation' }),
      k('\\mathbb{P}', { tooltip: 'probability' }),
      sm('\\operatorname{Var}'), sm('\\operatorname{Cov}'),
      k('\\sim', { tooltip: 'distributed as' }),
      k('\\mathcal{N}', { insert: '\\mathcal{N}\\left(#0,#0\\right)', tooltip: 'normal distribution' }),
      k('\\mid', { tooltip: 'given' }),
      k('\\propto'),
      k('\\perp\\!\\!\\!\\perp', { tooltip: 'independent' }),
      sm('D_{\\mathrm{KL}}', { insert: 'D_{\\mathrm{KL}}\\left(#0\\,\\|\\,#0\\right)', tooltip: 'KL divergence' }),
    ],
    [
      k('\\sum_{#0}^{#0}'), k('\\prod_{#0}^{#0}'), k('\\int_{#0}^{#0}'),
      k('\\nabla_{#0}', { tooltip: 'gradient' }),
      sm('\\frac{\\partial #0}{\\partial #0}', { tooltip: 'partial derivative' }),
      sm('\\mathbb{E}_{#0}\\left[#0\\right]', { tooltip: 'expectation over' }),
      sm('\\operatorname*{arg\\,max}_{#0}'), sm('\\operatorname*{arg\\,min}_{#0}'),
      sm('\\max_{#0}'), sm('\\min_{#0}'),
    ],
    [
      sm('\\log'), sm('\\exp'), sm('\\operatorname{softmax}'), sm('\\tanh'), sm('\\operatorname{ReLU}'),
      k('\\mathcal{L}', { tooltip: 'loss' }),
      k('\\mathcal{D}', { tooltip: 'dataset' }),
      sm('\\mathcal{O}\\left(#0\\right)', { tooltip: 'big-O' }),
      sm('\\mathbf{1}\\left[#0\\right]', { tooltip: 'indicator' }),
      k('\\ell'),
    ],
    [
      k('\\mathbb{R}^{#0}'), sm('\\mathbb{R}^{#0\\times #0}'),
      k('\\in'), k('\\approx'),
      k('\\coloneqq', { tooltip: 'defined as' }),
      k('\\leftarrow', { tooltip: 'update / assign' }),
      k('\\to'),
      '[left]', '[right]', '[backspace]',
    ],
  ],
}

// Notation AROUND a letter: accents, primes/stars/transposes, indices, fonts, braces.
// Each key wraps the letter before the caret; its label shows it on an example letter.
const wrap = (tpl, letter, extra) => Object.assign({ latex: tpl.replace(/#@/g, letter || 'x'), insert: tpl }, extra)
const ACCENT_LAYER = {
  label: 'x̂ x′',
  tooltip: 'Accents, scripts, fonts',
  rows: [
    [
      wrap('\\hat{#@}'), wrap('\\bar{#@}'), wrap('\\tilde{#@}'), wrap('\\dot{#@}'), wrap('\\ddot{#@}'),
      wrap('\\vec{#@}'), wrap('\\widehat{#@}', 'xy'), wrap('\\widetilde{#@}', 'xy'),
      wrap('\\overline{#@}', 'xy'), wrap('\\underline{#@}', 'xy'),
    ],
    [
      wrap('#@^{*}', 0, { tooltip: 'optimal / conjugate' }),
      wrap('#@^{\\prime}'),
      wrap('#@^{\\top}', 0, { tooltip: 'transpose' }),
      wrap('#@^{-1}', 0, { tooltip: 'inverse' }),
      wrap('#@^{\\dagger}', 0, { tooltip: 'pseudo-inverse / adjoint' }),
      wrap('#@^{(#0)}', 0, { tooltip: 'i-th example / layer' }),
      wrap('#@_{#0}'), wrap('#@^{#0}'), wrap('#@_{#0}^{#0}'),
      '[backspace]',
    ],
    [
      wrap('\\mathbf{#@}', 'x', { tooltip: 'bold (vectors, matrices)' }),
      wrap('\\boldsymbol{#@}', '\\theta', { tooltip: 'bold Greek' }),
      wrap('\\mathcal{#@}', 'L'), wrap('\\mathbb{#@}', 'R'), wrap('\\mathrm{#@}', 'd'),
      wrap('\\mathsf{#@}', 'A'), wrap('\\mathfrak{#@}', 'g'), wrap('\\mathscr{#@}', 'F'),
      sm('\\operatorname{op}', { insert: '\\operatorname{#0}', tooltip: 'named operator' }),
      sm('\\text{text}', { insert: '\\text{#0}', tooltip: 'words inside math' }),
    ],
    [
      wrap('\\overset{#0}{#@}'), wrap('\\underset{#0}{#@}'),
      wrap('\\overbrace{#@}^{#0}', 'xy'), wrap('\\underbrace{#@}_{#0}', 'xy'),
      wrap('\\overrightarrow{#@}', 'AB'), wrap('\\boxed{#@}'), wrap('\\cancel{#@}'), wrap('\\check{#@}'),
      '[left]', '[right]',
    ],
  ],
}

// Linear algebra and sets.
const LINALG_LAYER = {
  label: 'Lin. alg.',
  tooltip: 'Norms, products, matrices, sets',
  rows: [
    [
      k('\\left\\lVert #0\\right\\rVert', { tooltip: 'norm' }),
      k('\\left\\lVert #0\\right\\rVert_{2}'),
      k('\\left\\langle #0,#0\\right\\rangle', { tooltip: 'inner product' }),
      k('\\left| #0\\right|'),
      k('\\left\\lfloor #0\\right\\rfloor'), k('\\left\\lceil #0\\right\\rceil'),
      sm('\\operatorname{tr}'), sm('\\det'), sm('\\operatorname{diag}'), sm('\\operatorname{rank}'),
    ],
    [
      k('\\otimes'), k('\\odot', { tooltip: 'elementwise product' }), k('\\oplus'), k('\\circ'),
      k('\\times'), k('\\cdot'), k('\\star'), k('\\ast'), k('\\parallel'), k('\\perp'),
    ],
    [
      sm('\\begin{bmatrix}#0 & #0\\\\ #0 & #0\\end{bmatrix}'),
      sm('\\begin{pmatrix}#0 & #0\\\\ #0 & #0\\end{pmatrix}'),
      sm('\\begin{bmatrix}#0\\\\ #0\\end{bmatrix}', { tooltip: 'column vector' }),
      sm('\\begin{cases}#0 & #0\\\\ #0 & #0\\end{cases}'),
      k('\\vdots'), k('\\cdots'), k('\\ddots'), k('\\ldots'),
      k('\\mathbf{I}', { tooltip: 'identity' }), k('\\mathbf{0}'),
    ],
    [
      k('\\in'), k('\\notin'), k('\\subseteq'), k('\\subset'), k('\\cup'), k('\\cap'),
      k('\\setminus'), k('\\emptyset'), k('\\forall'), k('\\exists'),
      '[backspace]',
    ],
  ],
}

// Relations, arrows, logic.
const RELATION_LAYER = {
  label: '≤ →',
  tooltip: 'Relations, arrows, logic',
  rows: [
    [
      k('\\le'), k('\\ge'), k('\\ne'), k('\\approx'), k('\\equiv'),
      k('\\simeq'), k('\\cong'), k('\\ll'), k('\\gg'), k('\\lesssim'),
    ],
    [
      k('\\gtrsim'), k('\\prec'), k('\\succ'), k('\\preceq'), k('\\succeq'),
      k('\\asymp'), k('\\pm'), k('\\mp'), sm('\\overset{\\text{def}}{=}'), k('\\triangleq', { tooltip: 'defined as' }),
    ],
    [
      k('\\to'), k('\\mapsto'), k('\\leftarrow'), k('\\Rightarrow'), k('\\Leftarrow'),
      k('\\iff'), sm('\\xrightarrow{#0}'), k('\\rightleftharpoons'), k('\\uparrow'), k('\\downarrow'),
    ],
    [
      k('\\land'), k('\\lor'), k('\\neg'), k('\\vdash'), k('\\models'), k('\\therefore'), k('\\because'),
      '[left]', '[right]', '[backspace]',
    ],
  ],
}

// Custom layers first, then MathLive's built-in Greek / numeric / symbol boards.
export const KEYBOARD_LAYOUTS = [AI_LAYER, ACCENT_LAYER, LINALG_LAYER, RELATION_LAYER, 'greek', 'numeric', 'symbols']

/* ------------------------------------------------------------ typing shortcuts
 * MathLive converts letter sequences as you type (Desmos-style: "sqrt", "alpha", "->").
 * It matches the END of what you've typed, so a shortcut also fires inside a word:
 * x_{train} became x_{tra∈}, "for" became f∨, "model" mo∂l. */

// Added for AI/ML writing (each renders in KaTeX).
export const SHORTCUTS_ADD = {
  EE: '\\mathbb{E}', // was ∃ ("exists" still types ∃); like RR → ℝ
  PP: '\\mathbb{P}',
  Var: '\\operatorname{Var}',
  Cov: '\\operatorname{Cov}',
  KL: '\\mathrm{KL}',
  softmax: '\\operatorname{softmax}',
  relu: '\\operatorname{ReLU}',
  ReLU: '\\operatorname{ReLU}',
  diag: '\\operatorname{diag}',
  rank: '\\operatorname{rank}',
  trace: '\\operatorname{tr}',
  partial: '\\partial',
  ell: '\\ell',
  log: '\\log', // the default \log_{#?} swallowed the next letters as its base ("logits")
  // defaults that publish wrong or not at all in KaTeX:
  ':=': '\\coloneqq', // \coloneq renders as ":−" in KaTeX
  '?=': '\\stackrel{?}{=}', // \questeq is unknown to KaTeX
  '//': '/', // \slash is unknown to KaTeX
  setminus: '\\setminus', // was \backslash
}

// Removed: they fire inside / at the start of everyday words typed in math, or emit a
// command KaTeX can't render (it would publish as a red error).
export const SHORTCUTS_REMOVE = [
  'in', 'of', 'or', 'and', 'not', 'lt', 'gt', 'lt=', 'gt=', // train, proof, for, random, note, salt
  'sub', 'sup', 'sube', 'supe', 'prop', 'times', 'mod', '(mod', 'del', // subgoal, timestep, model
  'ch', 'sh', 'th', 'tg', 'ctg', 'cth', 'cotg', 'lb', 'lg', // batch, shared, threshold
  'mm', 'cm', 'km', 'kg', 'ft', 'inch', 'mi', // units: "mix", "mid"
  'dx', 'dy', 'dt', 'ee', 'ii', 'jj', // MathLive-only \differentialD, \exponentialE, \imaginaryI
  '::', '>->>', // \Colon, \twoheadrightarrowtail: not in KaTeX
]

// Kept, but only when NOT typed straight after a letter (so never mid-word): these are
// rarely written right after a variable, but end common words — joint, target, distance.
export const SHORTCUTS_NO_LETTER_BEFORE = ['int', 'arg', 'tan', 'sec', 'csc', 'cot', 'iff', 'nn', 'nnn', 'uu', 'uuu', 'vv', 'vvv']
