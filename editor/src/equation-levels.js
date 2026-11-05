/* equation-levels.js — the simpler versions of a long equation behind its reader slider.
 *
 * A display equation can carry `levels` (blockMath attr, data-levels in the saved HTML), a JSON
 * string: { for, labeled, simplified, full?, why? }.
 *   for        — the exact equation these were written for; edit the equation and they no longer
 *                apply (nothing else needs to notice), so a slider can never show stale math
 *   labeled    — the same structure with symbols replaced by short words
 *   simplified — shorter real math
 *   full       — optional: the equation itself with \textcolor around its main terms
 *   why        — optional: a short note explaining a symbol `simplified` introduces
 * They only ever arrive through an accepted suggestion (ai-suggest.js).
 */

// The three colors a term may take; the published page shows them only on hover.
export const LEVEL_COLORS = ['#2b6f9e', '#b4552d', '#2b8a6e']

// Levels that apply to this equation, or null.
export function levelsFor(tex, json) {
  if (!json) return null
  try {
    const l = JSON.parse(json)
    return l && l.for === tex && l.labeled && l.simplified ? l : null
  } catch (e) { return null }
}

// \textcolor{..}{x} → x, at any depth.
export function stripColor(tex) {
  let s = String(tex || '')
  const open = '\\textcolor{'
  for (let at = s.indexOf(open); at >= 0; at = s.indexOf(open)) {
    const close = s.indexOf('}', at + open.length)
    if (close < 0 || s[close + 1] !== '{') return s
    let depth = 0, end = -1
    for (let i = close + 1; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue }
      if (s[i] === '{') depth++
      else if (s[i] === '}' && --depth === 0) { end = i; break }
    }
    if (end < 0) return s
    s = s.slice(0, at) + s.slice(close + 2, end) + s.slice(end + 1)
  }
  return s
}

// Same equation once color and spacing are set aside? Grouping braces don't change the math,
// so a term may gain a pair by being wrapped.
const bare = (tex) => tex.replace(/\s+/g, '').replace(/[{}]/g, '')
export const sameEquation = (a, b) => bare(stripColor(a)) === bare(stripColor(b))

// Every \textcolor uses one of LEVEL_COLORS?
export function colorsAllowed(tex) {
  const used = String(tex || '').match(/\\textcolor\{[^}]*\}/g) || []
  return used.every((c) => LEVEL_COLORS.includes(c.slice(11, -1)))
}
