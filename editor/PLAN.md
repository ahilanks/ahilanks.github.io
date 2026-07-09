# Editor v2 rebuild — status & next steps

Local-only. Everything lives in `editor/` (gitignored). New editor runs at
`http://localhost:8765/editor/editor.html`. The v1 editor (`/editor.html`) is untouched.

**Safety:** `src/config.js` has `SANDBOX = true` → separate localStorage namespace
(`ahilan.editor2.*`), no server sync. Real v1 drafts cannot be touched until cutover.
Build only when upgrading a library: `cd editor && npm run build`.

---

## ✅ Done & verified in-browser
- **Decision:** TipTap v3 (ProseMirror) + vendored esbuild bundle (offline, no runtime CDN);
  in-place MathLive math; lazy/on-edit migration; sandbox until cutover.
- **Repo consolidated** into one gitignored `editor/` folder (clean root).
- **Toolchain:** `package.json`, `build.mjs`, `lib-entry.js`; `vendor/lib.bundle.js`
  (TipTap+ProseMirror+KaTeX+MathLive) + vendored KaTeX/MathLive CSS+fonts. Fully offline.
- **Core editing:** boots clean; typing, Enter, **Backspace-at-block-boundary merges cleanly**
  (the main v1 bug — fixed by ProseMirror), autosave, serif look, scroll config in place.
- **Math nodes:** inline + block created; KaTeX render works; serializes to the exact legacy
  shape `<span class="math-inline" data-tex="x^2">$x^2$</span>` (LaTeX only, no KaTeX bloat;
  literal `$tex$` text so the server's .md mirror recovers math for free). `$...$` input rule,
  corner "Math keyboard" button, ∑ button all wired. MathLive registered + round-trips LaTeX.

## 🔧 In progress — click-to-edit math (fix implemented, awaiting a visible-browser confirm)
Reworked the NodeView (`src/nodes/math.js`) to the canonical ProseMirror selection-lifecycle
pattern (benrbray/prosemirror-math + the PM footnote example). Root cause of "mounts then
disappears": on a `NodeSelection` PM draws a browser Range around the atom, blurring the freshly
mounted `<math-field>`. Fixes applied:
- **`setSelection() {}` no-op** on the NodeView — stops PM drawing that Range (THE fix). Verified:
  a `NodeSelection` now mounts the field and it **stays** (no teardown).
- **Open path unified:** `main.js` `editorProps.handleClickOn` turns a click on a math node into a
  `NodeSelection` (a plain click only makes a *TextSelection* for an inline atom, so `selectNode`
  never fired before). `selectNode()` → `startEdit()` is the single open trigger; the old DOM
  `click` listener is gone.
- **Commit path unified:** re-introduced `deselectNode() { commit() }`; Esc / inline-Enter route
  through moving the selection off the node (→ deselectNode). The doc write is deferred with
  `queueMicrotask` (deselectNode runs *inside* a PM dispatch). A guarded `focusout` handler is a
  safety net for focus escaping to the title/toolbar. Removed the global `mousedown` `onDocPointer`.
- **Robustness:** `dom.contentEditable='false'`; focus the field synchronously + on the `mount`
  event + a `setTimeout` fallback (never rAF-only — rAF was the fragile bit).

Confirmed working by the user in a real browser (click → edit → type → commit). Follow-up fixes:
- **Arrow-key nav:** opening is no longer tied to being node-selected (removed `selectNode`; open
  goes through `selectAndEditMath` = set NodeSelection + call the DOM's `__startMathEdit`, used by
  click `handleClickOn`, Enter-on-selected, and the insert flows). `main.js` `handleKeyDown` makes
  ←/→ select an adjacent equation then step past it (both directions) without editing. Verified.
- `window.__MATHLOG` / `mlog` debug logging is still in `math.js` — safe to remove now (blocker is
  resolved); left in for one more round in case anything surfaces.

**Dev-server cache fix (new):** `editor-server.py` now sends `Cache-Control: no-store` on every
response. Without it Chrome heuristically cached the ES modules, so editing `src/*.js` + reload
silently kept running the OLD code. Restart the server (kill :8765, `python3 editor-server.py`) to
pick up server changes; the browser now always gets fresh app code on reload.

---

## Next steps (dependency order)

1. **Finish in-place math editing** (the blocker)
   - Get click → `<math-field>` reliably; verify Desmos shortcuts (`^ _ / sqrt`) and that the
     field stays open while using the virtual keyboard; commit on Esc/Enter/click-away.
   - Block math: insert, edit, and the align (L/C/R) control.
   - Verify the corner keyboard button: toggles the keyboard; when no field is focused, inserts
     a blank equation and opens it; custom AI/ML layer shows the right symbols.

2. ~~**∑ → AI math**~~ ✅ **DONE + verified end-to-end.** `src/ai-math.js`: the ∑ buttons
   (toolbar `mathBtn` + bubble `bubbleAI`) AI-format a selection in place — this is v1's real
   behavior (`runMathOnSelection`/`callOpenAIFormatMath`); the old describe-math `#aiPop` popover
   was dead code in v1, so it wasn't ported. Selection → `$tex$`/`$$tex$$` via `textBetween`, model
   rewrites it, result inserted by building the canonical `<span class="math-inline" data-tex>` /
   `<div class="math-block" data-tex>` HTML and letting the nodes' `parseHTML` rebuild them.
   OpenAI key auto-loads from **`/.env`** (absolute — page is at `/editor/`). Settings modal wired
   (key + model). `mathBtn` with no selection inserts a blank editable equation. Verified: real
   `gpt-5.4-mini` call turned "sum of 1/n^2 from n=1 to infinity equals pi^2/6" into correct inline
   KaTeX with prose preserved.

3. ~~**Footnotes**~~ ✅ **DONE + core verified.** `src/nodes/footnote.js`: `FootnoteRef` inline atom
   (`<sup class="fn-ref" data-fn="id">N</sup>`) in the body; bodies live in a contenteditable
   `#fnList` region below the article (added to `editor.html`), OUTSIDE the PM doc, so the separate
   `footnotes` storage field round-trips unchanged (v1 shape). `reconcileFootnotes()` runs on each
   update: walks refs in **document order**, numbers them, reorders/prunes the body list. Wired to
   `footnoteBtn` + `bubbleFootnote`; click-a-ref focuses its body; body edits autosave. Verified via
   CDP: insert, renumber-by-order (a ref inserted earlier becomes #1), body edit, save, reload
   restore. **Not yet exercised (needs a real browser):** editing/focus in the contenteditable
   bodies, click-to-scroll, and paste normalization. Known gap: copy/pasting a ref duplicates its
   `data-fn` (no dedup pass yet — v1 had one).

4. **Figure NodeView** (one node, image + video) — 🟡 **images DONE + verified; video + crop next.**
   `src/nodes/figure.js` + `src/figures.js`. One `figure` block node, `content:'inline*'` so the
   `<figcaption>` is real editable caption content (contentDOM); renders v1's exact
   `<figure class="img-block" data-w><img src=base64><figcaption>…</figcaption></figure>` shape.
   Image upload (toolbar button + file input) and clipboard image paste both embed as base64.
   Drag the right edge to resize → `width` attr → `data-w` (dbl-click there resets). Verified via
   CDP: insert, base64 img, caption round-trip, resize→data-w, getHTML shape. Node is already
   **video-ready** (`mediaType`/`vid` attrs, parses `figure.video-block`). **Still to do:** video
   upload → IndexedDB blob + rehydrate `blob:` src on load + `/api/media` backup (persist only
   `data-vid`); double-click-to-crop. Interactive checks for the user: real image upload/paste,
   drag-resize feel, caption typing.

5. ~~**Links**~~ ✅ **DONE + verified (open/apply).** `src/links.js` `setupLinks(editor)`: ⌘K + toolbar
   `#linkBtn` + bubble `#bubbleLink` open `#linkPop` (prefilled href, https:// normalize, Apply/Remove),
   plus a `#linkPreview` hover/caret chip with an Edit button. Verified popover opens + applies with
   scheme normalization. Needs browser: hover-chip behavior, outside-click/scroll close.

6. ~~**Full persistence + sync**~~ ✅ **DONE (sandbox-safe) + verified.** `src/drafts.js`
   `setupDrafts({editor, currentSnapshot, applySnapshot, getDocId, setDocId})`: drafts menu
   (list/new/open/two-click-delete→tombstone), per-draft scroll restore, and the full `/api/drafts`
   pull/push/reconcile (byte-for-byte the server's merge policy) + `/api/push` status UI. **Every network
   path is gated behind `!SANDBOX`** — verified empirically: opening the menu, clicking Backup, and saving
   fire **zero** `/api` requests in sandbox. main.js `load()` was split into `applySnapshot()`+`load()`.

7. ~~**Publish**~~ ✅ **DONE (built; needs a real folder-pick to exercise).** `src/publish.js`
   `setupPublish({editor, currentSnapshot})`: `#publishBtn`→modal (slug/date prefill, thumbnail picker),
   confirm → build a standalone article (ported v1 `buildArticleHtml`/`sanitizeNode`, math→KaTeX
   delimiters, footnotes renumbered from `#fnList`, inline images → `writings/media/`) and write
   `writings/<slug>.html` via File System Access + optional `writings.html` list update. The dir handle is
   remembered in its own IndexedDB. Only writes on the user's folder pick. Needs browser to fully test.

8. ~~**Source view**~~ ✅ **DONE + verified.** `src/source-view.js` `setupSourceView(editor)`: the
   Write/Source toggle → read-only Markdown+LaTeX of the doc (headings, marks, lists, blockquote, `$tex$`
   / `$$tex$$`, `![caption](src)`, `[^N]` + a footnotes section). Verified toggle + serialization.

Also DONE this pass: **video** (`src/idb.js` IndexedDB store + `src/figures.js` upload/rehydrate;
`rehydrateVideos(editor)` called after load) and **image crop** (double-click an image → canvas-crop
overlay in `src/nodes/figure.js`). Both need a real browser (a real video file / image) to exercise.

9. **Migration pre-normalization** (runs on load) — collapse rendered KaTeX/MathML → minimal
   `data-tex`; map Substack footnote/image classes + Claude wrappers to canonical shapes;
   coerce/keep `h4/h5`. Enumerated inventory already captured.

10. **Migration gate** — round-trip harness over COPIES of the two real drafts
    (`drafts/*.json`): load → `getHTML` → reload → assert stable AND semantically equal
    (text, every `data-tex`/`data-fn`, image srcs, captions, footnote count/order). Nothing
    real is overwritten until every draft passes.

11. **Cutover** — flip `SANDBOX = false`; point `run-editor.command` at the new editor (and
    decide whether to relocate `editor-server.py`/`run-editor.command` into `editor/`, serving
    the repo root from there). Keep `editor.html.bak-*` + the drafts git history as rollback.
    Back up the drafts repo (Push) BEFORE first real save.

## Handy
- Build: `cd editor && npm run build` (only when upgrading a lib).
- Serve: existing `editor-server.py` on :8765 already serves `/editor/` and now sends
  `Cache-Control: no-store` so `src/*.js` edits show up on reload. **Caveat:** files cached in the
  browser *before* that header was added are sticky — do ONE hard reload (Cmd+Shift+R) to flush
  them, then normal reloads serve fresh code. Restart the server after editing the server itself.
- Reset sandbox: `localStorage.removeItem('ahilan.editor2.drafts'); localStorage.removeItem('ahilan.editor2.current')`.
- Debug editor in console: `window.__editor`.
