/* lib-entry.js — the ONLY file esbuild bundles.
 *
 * It re-exports everything the app (src/*.js) needs from the heavy npm libraries
 * (TipTap v3 / ProseMirror / KaTeX / MathLive) into one file: vendor/lib.bundle.js.
 * App code imports from that single bundle, so the browser needs no bundler and app
 * logic stays hand-editable. Rebuild ONLY when upgrading a library:  npm run build
 */

// ---- TipTap core ----
export {
  Editor,
  Extension,
  Node,
  Mark,
  mergeAttributes,
  InputRule,
  nodeInputRule,
  markInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
  getMarkRange,
  findParentNode,
} from '@tiptap/core'

export { default as StarterKit } from '@tiptap/starter-kit'
export { Placeholder } from '@tiptap/extensions'

// ---- ProseMirror internals (via @tiptap/pm so there is ONE prosemirror-model) ----
export { Plugin, PluginKey, TextSelection, NodeSelection, Selection } from '@tiptap/pm/state'
export { Decoration, DecorationSet } from '@tiptap/pm/view'
export { DOMParser, DOMSerializer, Slice, Fragment } from '@tiptap/pm/model'

// ---- KaTeX (static rendering of math) ----
export { default as katex } from 'katex'

// ---- MathLive (interactive in-place math field + virtual keyboard) ----
// Importing for side effect registers the <math-field> custom element.
import 'mathlive'
export { MathfieldElement, convertLatexToMarkup, convertLatexToMathMl } from 'mathlive'
// mathVirtualKeyboard is a global singleton; re-export a getter so app code can reach it.
export function getMathVirtualKeyboard() {
  return window.mathVirtualKeyboard
}
