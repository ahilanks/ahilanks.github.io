/* config.js — everything tunable in one place.
 * Edit these and just reload the editor (no rebuild needed for app changes). */

export const CONFIG = {
  // Writing font for the surface + published article.
  // "serif" (Newsreader) | "sans" (Inter) | "mono" (JetBrains Mono)
  font: 'serif',

  // Heading levels offered in the toolbar + kept by the schema.
  // Technical writing uses more structure, so h2–h4 are all real levels; h5 is
  // kept in the schema (not surfaced in the toolbar) so imported drafts that use
  // an h5 sub-sub-subheading round-trip losslessly instead of demoting to a paragraph.
  headingLevels: [2, 3, 4, 5],

  // KaTeX render options (used everywhere math is rendered).
  katex: { throwOnError: false, strict: false },

  // MathLive virtual-keyboard: which layers show, and where the toggle sits.
  mathKeyboard: {
    corner: 'right', // 'right' | 'left'  — bottom corner for the toggle button
    // Layers tuned for AI/ML writing. "numeric" and "greek" are built in; the
    // custom layers below add probability / linear-algebra / operators symbols.
    layers: ['ai-symbols', 'greek', 'numeric', 'functions'],
  },

  // OpenAI defaults (key is loaded from .env via the local server, else Settings).
  openai: { model: 'gpt-5.4-mini' },

  // Scroll behaviour. scrollMargin.top keeps the caret out from under the sticky
  // toolbar; ProseMirror scrolls the *minimum* amount instead of recentering.
  scroll: { marginTop: 96, marginBottom: 160, threshold: 0 },

  // Autosave debounce (ms) and how often to poll the server for other devices.
  autosaveMs: 300,
  syncPollMs: 4000,

  // Math delimiters recognised while typing (input rules) and on paste.
  mathDelimiters: {
    inline: ['$', '$'],
    block: ['$$', '$$'],
  },
}

// SANDBOX MODE — while true, the editor uses a SEPARATE localStorage namespace
// and does NOT sync to the server, so it can never touch the real v1 drafts during
// development. Flip to false ONLY at cutover (then it reads/writes the real drafts
// and syncs). This is the core safeguard for the irreplaceable drafts.
//
// CUTOVER 2026-07-09: v2 is now the default editor (run-editor.command opens it).
// The two real drafts were migrated to v2's shape and round-trip verified before
// this flip; the pre-cutover state is preserved at the drafts-repo tag
// `pre-v2-cutover-20260709` and in each draft's git history.
export const SANDBOX = false

const PREFIX = SANDBOX ? 'ahilan.editor2.' : 'ahilan.editor.'

// localStorage keys. In real (non-sandbox) mode these match v1 exactly so existing
// drafts load unchanged; in sandbox mode they are namespaced away from v1.
export const LS = {
  drafts: PREFIX + 'drafts',
  current: PREFIX + 'current',
  settings: 'ahilan.editor.settings', // settings (API key) can be shared safely
  scroll: PREFIX + 'scroll',
  deleted: PREFIX + 'deleted',
}

// Path (relative to editor-next.html) where MathLive should load its fonts/sounds.
export const VENDOR_BASE = 'vendor'
