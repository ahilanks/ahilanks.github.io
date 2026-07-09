/* build.mjs — ONE-TIME build. Run `npm run build` only when upgrading a library.
 *
 * Produces the committed-to-disk, served-offline artifacts under vendor/:
 *   vendor/lib.bundle.js   — TipTap + ProseMirror + KaTeX + MathLive, bundled (ESM)
 *   vendor/katex.min.css   — KaTeX stylesheet     (+ vendor/fonts/ KaTeX + MathLive fonts)
 *   vendor/mathlive-fonts.css, vendor/mathlive-static.css
 *   vendor/sounds/         — MathLive keypress sounds (we disable them, kept for completeness)
 *
 * The python launcher NEVER runs this — it only serves the output. No build at launch.
 */
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(ROOT, 'vendor')
const NM = join(ROOT, 'node_modules')
const watch = process.argv.includes('--watch')

rmSync(VENDOR, { recursive: true, force: true })
mkdirSync(join(VENDOR, 'fonts'), { recursive: true })
mkdirSync(join(VENDOR, 'sounds'), { recursive: true })

// 1) JS bundle -----------------------------------------------------------------
const buildOptions = {
  entryPoints: [join(ROOT, 'lib-entry.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(VENDOR, 'lib.bundle.js'),
  sourcemap: true,
  minify: true,
  legalComments: 'none',
  loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.wav': 'empty' },
  logLevel: 'info',
}

// 2) Static assets (CSS + fonts + sounds) --------------------------------------
function copyAssets() {
  // KaTeX
  cpSync(join(NM, 'katex/dist/katex.min.css'), join(VENDOR, 'katex.min.css'))
  cpSync(join(NM, 'katex/dist/fonts'), join(VENDOR, 'fonts'), { recursive: true })
  // MathLive CSS
  cpSync(join(NM, 'mathlive/mathlive-fonts.css'), join(VENDOR, 'mathlive-fonts.css'))
  cpSync(join(NM, 'mathlive/mathlive-static.css'), join(VENDOR, 'mathlive-static.css'))
  // MathLive fonts (into the same vendor/fonts/ dir its CSS expects at ./fonts) + sounds
  cpSync(join(NM, 'mathlive/fonts'), join(VENDOR, 'fonts'), { recursive: true })
  cpSync(join(NM, 'mathlive/sounds'), join(VENDOR, 'sounds'), { recursive: true })
  // MathLive CSS references url("./fonts/...") and mathlive-fonts.css lives at vendor/;
  // our fonts are at vendor/fonts/, which matches. Leave as-is.
  // Small manifest so we can sanity-check the vendored versions later.
  const pkg = (p) => JSON.parse(readFileSync(join(NM, p, 'package.json'), 'utf8')).version
  writeFileSync(join(VENDOR, 'VERSIONS.json'), JSON.stringify({
    '@tiptap/core': pkg('@tiptap/core'),
    '@tiptap/starter-kit': pkg('@tiptap/starter-kit'),
    katex: pkg('katex'),
    mathlive: pkg('mathlive'),
    builtWith: 'esbuild ' + esbuild.version,
  }, null, 2) + '\n')
}

if (watch) {
  const ctx = await esbuild.context(buildOptions)
  copyAssets()
  await ctx.watch()
  console.log('[build] watching lib-entry.js …')
} else {
  await esbuild.build(buildOptions)
  copyAssets()
  const stat = existsSync(join(VENDOR, 'lib.bundle.js'))
  console.log('[build] done →', join(VENDOR, 'lib.bundle.js'), stat ? '(ok)' : '(MISSING!)')
}
