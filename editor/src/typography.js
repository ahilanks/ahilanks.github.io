/* typography.js — Word-style autocorrect-as-you-type for the editor body.
 *
 * Each rule fires the moment its trigger is typed. Backspace (or ⌘Z) right after
 * undoes just the conversion, so the literal characters are always reachable.
 * TipTap skips input rules inside code blocks and inline code, so `--` and `...`
 * in code stay literal.
 */
import { Extension, InputRule } from '../vendor/lib.bundle.js'

// replace exactly what `find` matched (ending at the caret) with `text`
const replaceRule = (find, text) => new InputRule({
  find,
  handler: ({ state, range }) => { state.tr.insertText(text, range.from, range.to) },
})

export const SmartTypography = Extension.create({
  name: 'smartTypography',
  addInputRules() {
    return [
      replaceRule(/--$/, '—'), // double hyphen → em dash
      replaceRule(/\.\.\.$/, '…'), // three periods → ellipsis
    ]
  },
})
