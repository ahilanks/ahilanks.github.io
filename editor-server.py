#!/usr/bin/env python3
"""Local editor server.

Serves the project (so the editor and File System Access publish work) AND stores
drafts on disk at .editor-drafts.json. Because every device hits this one server,
the on-disk store is the shared source of truth -> drafts sync across devices while
this Mac is running.

Durability: every save also writes each draft to its own file in ./drafts/ as
<id>.json (lossless) + <id>.md (readable). Embedded images (base64 data-URIs) are
extracted to ./drafts/media/<id>/<hash>.<ext> real files and referenced from the
.md; uploaded videos are POSTed by the editor to /api/media and land in the same
folder. A draft file is only ever removed when there's an EXPLICIT tombstone for it
-- an empty/cleared-browser sync can never delete files. ./drafts/ is its own
PRIVATE git repo (separate from the public site); the editor's "Push" button and a
~5-min timer commit + push it.

The merge is intentionally identical to the client's reconcile(): per draft id the
newest `updated` wins, deletes are tracked as tombstones, and nothing is ever
silently dropped. Started by run-editor.command; safe to run directly:

    python3 editor-server.py [PORT]   # default 8765
"""
import json
import os
import re
import sys
import html as htmlmod
import time
import base64
import hashlib
import shutil
import threading
import subprocess
from urllib.parse import urlparse, parse_qs
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Cryptographic timestamping of published versions (provenance.py). Optional: if the
# `opentimestamps` package is missing the drafts server still runs, publish just can't stamp.
try:
    import provenance
except Exception as _e:  # pragma: no cover
    provenance = None
    sys.stderr.write(f"[proofs] timestamping unavailable: {_e}\n")

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(ROOT, "drafts", ".editor-drafts.json")
DRAFTS_DIR = os.path.join(ROOT, "drafts")
MEDIA_DIR = os.path.join(DRAFTS_DIR, "media")
LOCK = threading.Lock()      # serialize read-modify-write so concurrent saves can't clobber
GIT_LOCK = threading.Lock()  # serialize git operations
AUTO_PUSH_SECONDS = 300      # ~5 minutes
PROOF_UPGRADE_SECONDS = 900  # re-check pending Bitcoin timestamps every ~15 minutes
PUBLISH_STATE_PATH = os.path.join(ROOT, "drafts", ".publish-state.json")  # private: draft share tokens
PROOF_LOCK = threading.Lock()
SITE_GIT_LOCK = threading.Lock()   # serialize commits/pushes of the public site repo (ROOT)
# Paths the editor may write when publishing (everything else on the site is hand-edited).
PUBLISH_PATH_RE = re.compile(r"^(writings/(p/|media/)?[A-Za-z0-9_\-.]+\.[A-Za-z0-9]+|media/[A-Za-z0-9_\-.]+\.[A-Za-z0-9]+|writings\.html)$")
GITHUB_FILE_LIMIT = 95 * 1024 * 1024  # keep files >95MB out of git (GitHub rejects >100MB); they stay durable-local-only
MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp",
}
IMG_FILE_RE = re.compile(r"^[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|svg|avif|bmp|bin)$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_\-.]+$")
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Ahilan Karuppusami",
    "GIT_AUTHOR_EMAIL": "ahilanks101@gmail.com",
    "GIT_COMMITTER_NAME": "Ahilan Karuppusami",
    "GIT_COMMITTER_EMAIL": "ahilanks101@gmail.com",
}
LAST_PUSH = {"time": None, "ok": None, "detail": "not pushed yet this session"}


def load_store():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("drafts", {})
    data.setdefault("deleted", {})
    return data


def save_store(data):
    # write to a temp file then atomically replace, so a crash mid-write never
    # leaves a truncated drafts file.
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, STORE_PATH)
    # mirror to per-draft files for durability (best-effort; never fatal)
    try:
        sync_draft_files(data)
    except Exception as e:
        sys.stderr.write(f"[drafts] file sync failed: {e}\n")


def merge(store, incoming):
    drafts = store["drafts"]
    deleted = store["deleted"]
    in_drafts = incoming.get("drafts") or {}
    in_deleted = incoming.get("deleted") or {}

    # 1) tombstones: newest deletion wins
    for _id, ts in in_deleted.items():
        try:
            ts = float(ts)
        except (TypeError, ValueError):
            continue
        if _id not in deleted or ts > deleted[_id]:
            deleted[_id] = ts

    # 2) drafts: newest edit wins, honoring tombstones
    for _id, d in in_drafts.items():
        if not isinstance(d, dict):
            continue
        up = d.get("updated") or 0
        tomb = deleted.get(_id, 0)
        if tomb and up <= tomb:            # deleted at/after this version -> skip
            continue
        cur = drafts.get(_id)
        if cur is None or up > (cur.get("updated") or 0):
            drafts[_id] = d
        if tomb and up > tomb:             # re-created by a newer edit elsewhere
            deleted.pop(_id, None)

    # 3) drop any stored draft a tombstone now supersedes
    for _id, ts in list(deleted.items()):
        d = drafts.get(_id)
        if d is not None and (d.get("updated") or 0) <= ts:
            drafts.pop(_id, None)

    return store


# ---------------------------------------------------------------------------
# Per-draft file mirror (durable, human-readable, git-backed)
# ---------------------------------------------------------------------------

def strip_html(s):
    return htmlmod.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def slugify_title(title, fallback=""):
    """Filename-safe slug from a draft title (falls back to `fallback` when empty)."""
    t = strip_html(title or "").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t)
    t = re.sub(r"-{2,}", "-", t).strip("-")
    return t[:80].strip("-") or fallback


def fmt_time(ms):
    if not ms:
        return "—"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(ms / 1000))
    except Exception:
        return str(ms)


def human_now():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def wordcount(body_html):
    return len(strip_html(body_html).split())


def media_dir(draft_id):
    return os.path.join(MEDIA_DIR, draft_id)


def externalize_media(draft_id, body):
    """Rewrite a draft body for the .md: extract base64 <img> data-URIs to real
    files under drafts/media/<id>/ and point at them; turn each uploaded <video>
    figure into a markdown link to its media file (if the editor uploaded it).
    Returns (rewritten_body, set_of_referenced_media_filenames)."""
    used = set()
    d = media_dir(draft_id)

    def img_sub(m):
        mime = m.group(1).lower()
        b64 = re.sub(r"\s+", "", m.group(2))
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return m.group(0)
        h = hashlib.sha1(raw).hexdigest()[:12]
        ext = MIME_EXT.get(mime, "bin")
        fname = f"{h}.{ext}"
        os.makedirs(d, exist_ok=True)
        fp = os.path.join(d, fname)
        if not os.path.exists(fp):
            with open(fp, "wb") as f:
                f.write(raw)
        used.add(fname)
        return f'src="media/{draft_id}/{fname}"'

    body = re.sub(r'src="data:(image/[A-Za-z0-9.+\-]+);base64,([A-Za-z0-9+/=\s]+)"', img_sub, body)

    def vid_sub(m):
        vid = m.group(1)
        fname = None
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.startswith(vid + "."):
                    fname = f
                    break
        if fname:
            used.add(fname)
            return f"\n\n▶ video: `media/{draft_id}/{fname}` (kept local-only — durable on disk, not in this repo)\n\n"
        return "\n\n▶ video (local-only)\n\n"

    body = re.sub(r'<figure[^>]*data-vid="([A-Za-z0-9_\-]+)"[^>]*>.*?</figure>', vid_sub, body, flags=re.S)
    return body, used


def prune_media(draft_id, used):
    """Remove extracted image files for this draft that are no longer referenced.
    Only touches hash-named image files; never removes uploaded videos."""
    d = media_dir(draft_id)
    if not os.path.isdir(d):
        return
    for f in os.listdir(d):
        if IMG_FILE_RE.match(f) and f not in used:
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass


def html_to_markdown(s):
    if not s:
        return ""
    # any leftover data-URI images (shouldn't happen after externalize) -> placeholder
    s = re.sub(r'<img[^>]*src="data:[^"]*"[^>]*>', "![embedded image — full data in .json]()", s, flags=re.I)
    s = re.sub(r'<img[^>]*src="([^"]*)"[^>]*>', r"![](\1)", s, flags=re.I)
    for lvl in (1, 2, 3, 4):
        s = re.sub(rf"<h{lvl}[^>]*>(.*?)</h{lvl}>",
                   lambda m, l=lvl: f'\n\n{"#" * l} ' + strip_html(m.group(1)).strip() + "\n\n",
                   s, flags=re.I | re.S)
    s = re.sub(r"<blockquote[^>]*>(.*?)</blockquote>",
               lambda m: "\n\n> " + re.sub(r"\s+", " ", strip_html(m.group(1))).strip() + "\n\n",
               s, flags=re.I | re.S)
    s = re.sub(r"<sup[^>]*>(.*?)</sup>", lambda m: "[^" + strip_html(m.group(1)).strip() + "]", s, flags=re.I | re.S)
    s = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', lambda m: f"[{strip_html(m.group(2))}]({m.group(1)})", s, flags=re.I | re.S)
    s = re.sub(r"</?(strong|b)>", "**", s, flags=re.I)
    s = re.sub(r"</?(em|i)>", "*", s, flags=re.I)
    s = re.sub(r"<li[^>]*>(.*?)</li>", lambda m: "\n- " + strip_html(m.group(1)).strip(), s, flags=re.I | re.S)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"</div\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)          # strip any remaining tags
    s = htmlmod.unescape(s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_footnote_bodies(fn_html):
    """Parse the serialized #fnList HTML (stored in a draft's `footnotes` field)
    into {data_fn: body_html}. Each item looks like
    <li data-fn="X"><span class="fn-num">1.</span><div class="fn-body">…</div></li>."""
    out = {}
    for m in re.finditer(r'<li[^>]*\bdata-fn="([^"]*)"[^>]*>(.*?)</li>', fn_html or "", re.S | re.I):
        data_fn, inner = m.group(1), m.group(2)
        # fn-body is the last element in the <li>; grab greedily to the final </div>
        bm = re.search(r'<div[^>]*\bfn-body\b[^>]*>(.*)</div>', inner, re.S | re.I)
        body = bm.group(1) if bm else re.sub(r'<span[^>]*\bfn-num\b[^>]*>.*?</span>', "", inner, flags=re.S | re.I)
        out[data_fn] = body
    return out


def footnote_body_markdown(body_html):
    """Footnotes are inline-sized: convert to markdown then collapse to one line so
    the GFM `[^n]: …` definition stays valid on GitHub."""
    md = html_to_markdown(body_html)
    return re.sub(r"\s+", " ", md).strip()


def draft_to_markdown(_id, d):
    title = strip_html(d.get("title") or "")
    subtitle = strip_html(d.get("subtitle") or "")
    fm = [
        "---",
        f"id: {_id}",
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"subtitle: {json.dumps(subtitle, ensure_ascii=False)}",
        f"updated: {fmt_time(d.get('updated') or 0)}",
        "---",
        "",
    ]
    ext_body, used = externalize_media(_id, d.get("body") or "")
    prune_media(_id, used)

    # Footnotes: number the refs in first-appearance order and match each to its body
    # by data-fn, so GitHub renders proper [^n] links + a definition list. (getHTML only
    # serialises the ref as a bullet '•' and keeps the bodies in a separate `footnotes`
    # field, so without this the .md loses footnotes entirely.)
    fn_bodies = parse_footnote_bodies(d.get("footnotes") or "")
    num_of = {}
    ref_order = []

    def _number_ref(m):
        tag = m.group(0)
        km = re.search(r'data-fn="([^"]*)"', tag)
        key = km.group(1) if km else f"__{len(num_of)}"
        if key not in num_of:
            num_of[key] = len(num_of) + 1
            ref_order.append(key)
        return f"[^{num_of[key]}]"

    ext_body = re.sub(r'<sup[^>]*\bfn-ref\b[^>]*>.*?</sup>', _number_ref, ext_body, flags=re.I | re.S)

    parts = []
    if title:
        parts.append(f"# {title}")
    if subtitle:
        parts.append(f"*{subtitle}*")
    body = html_to_markdown(ext_body)
    if body:
        parts.append(body)

    if ref_order:
        defs = []
        for key in ref_order:
            body_md = footnote_body_markdown(fn_bodies.get(key, ""))
            defs.append(f"[^{num_of[key]}]: {body_md}" if body_md else f"[^{num_of[key]}]:")
        parts.append("\n".join(defs))

    return "\n".join(fm) + "\n\n".join(parts).strip() + "\n"


def write_if_changed(path, content):
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                if f.read() == content:
                    return False
    except Exception:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def existing_id_files():
    """Map draft id -> set of file stems (basename without .md/.json) already on disk,
    read from each file's own id (json: the `id` key; md: the `id:` frontmatter line).
    Lets us find a draft's current files after its title (and so its slug) changed."""
    id_to_stems = {}
    try:
        names = os.listdir(DRAFTS_DIR)
    except OSError:
        return id_to_stems
    for fn in names:
        if fn.startswith("."):            # skip .editor-drafts.json, .DS_Store, etc.
            continue
        stem, ext = os.path.splitext(fn)
        if ext not in (".md", ".json"):
            continue
        path = os.path.join(DRAFTS_DIR, fn)
        _id = None
        try:
            if ext == ".json":
                with open(path, "r", encoding="utf-8") as f:
                    _id = (json.load(f) or {}).get("id")
            else:
                with open(path, "r", encoding="utf-8") as f:
                    head = f.read(1000)
                mm = re.search(r"(?m)^id:\s*(\S+)\s*$", head)
                if mm:
                    _id = mm.group(1)
        except (OSError, ValueError):
            _id = None
        if _id:
            id_to_stems.setdefault(_id, set()).add(stem)
    return id_to_stems


def assign_slugs(drafts):
    """Deterministic id -> filename-stem map. Slug is the title; on a collision the
    later id (sorted) keeps the plain slug and the other gets a `-<id>` suffix."""
    taken = {}          # stem -> id
    id_to_slug = {}
    for _id, d in sorted(drafts.items()):
        if not isinstance(d, dict):
            continue
        base = slugify_title(d.get("title") or "", fallback=_id)
        slug = base
        if taken.get(slug, _id) != _id:      # already claimed by a different draft
            slug = f"{base}-{_id}"
        taken[slug] = _id
        id_to_slug[_id] = slug
    return id_to_slug


def sync_draft_files(data):
    """Mirror the store into ./drafts/. Writes/updates a <title-slug>.md/.json for
    every present draft; removes files ONLY for (a) a still-present draft whose slug
    changed — after its new files are written — or (b) an id with an explicit tombstone.
    Never deletes a file merely because it's absent from `drafts` (anti-data-loss)."""
    os.makedirs(DRAFTS_DIR, exist_ok=True)
    drafts = data.get("drafts", {}) or {}
    deleted = data.get("deleted", {}) or {}

    id_to_slug = assign_slugs(drafts)
    live_stems = set(id_to_slug.values())     # stems a present draft legitimately owns now
    on_disk = existing_id_files()

    # 1) write the current (slug-named) files for every present draft
    for _id, d in drafts.items():
        if not isinstance(d, dict):
            continue
        slug = id_to_slug[_id]
        write_if_changed(os.path.join(DRAFTS_DIR, f"{slug}.json"),
                         json.dumps(d, ensure_ascii=False, indent=2) + "\n")
        write_if_changed(os.path.join(DRAFTS_DIR, f"{slug}.md"),
                         draft_to_markdown(_id, d))

    def _remove_stem(stem):
        # never delete a stem another present draft currently owns
        if stem in live_stems:
            return
        for ext in (".json", ".md"):
            p = os.path.join(DRAFTS_DIR, f"{stem}{ext}")
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass

    # 2) rename cleanup: drop stale stems for a still-present draft (new files just written)
    for _id, slug in id_to_slug.items():
        for stem in on_disk.get(_id, set()):
            if stem != slug:
                _remove_stem(stem)

    # 3) explicit-tombstone-only deletion (files + that draft's media folder)
    for _id in deleted:
        if _id in drafts:
            continue
        for stem in on_disk.get(_id, set()) | {_id}:   # include legacy id-named files
            _remove_stem(stem)
        md = media_dir(_id)
        if os.path.isdir(md):
            shutil.rmtree(md, ignore_errors=True)

    # index
    lines = ["# Drafts index", ""]
    if not drafts:
        lines.append("_No drafts yet._")
    else:
        for _id, d in sorted(drafts.items(), key=lambda kv: -((kv[1] or {}).get("updated") or 0)):
            title = strip_html(d.get("title") or "") or "(untitled)"
            slug = id_to_slug[_id]
            lines.append(f"- **{title}** — {wordcount(d.get('body') or '')} words — "
                         f"updated {fmt_time(d.get('updated') or 0)} — "
                         f"[`.md`]({slug}.md) · [`.json`]({slug}.json)")
    write_if_changed(os.path.join(DRAFTS_DIR, "index.md"), "\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Git push (to the private drafts repo)
# ---------------------------------------------------------------------------

def _git(args, **kw):
    return subprocess.run(["git", *args], cwd=DRAFTS_DIR, env=GIT_ENV,
                          capture_output=True, text=True, **kw)


def _add_local_ignore(rel):
    """Add a path to the drafts repo's local (uncommitted) ignore list."""
    excl = os.path.join(DRAFTS_DIR, ".git", "info", "exclude")
    try:
        existing = ""
        if os.path.exists(excl):
            with open(excl, "r", encoding="utf-8") as f:
                existing = f.read()
        if rel not in existing.split("\n"):
            with open(excl, "a", encoding="utf-8") as f:
                if existing and not existing.endswith("\n"):
                    f.write("\n")
                f.write(rel + "\n")
    except OSError:
        pass


def _exclude_oversized():
    """Unstage (and locally ignore) any staged file over GitHub's size cap, so the
    push can never be rejected. Those files stay as durable local files in drafts/.
    Returns the list of paths kept local-only."""
    staged = _git(["diff", "--cached", "--name-only", "-z"]).stdout.split("\0")
    kept = []
    for rel in staged:
        rel = rel.strip()
        if not rel:
            continue
        fp = os.path.join(DRAFTS_DIR, rel)
        try:
            if os.path.getsize(fp) > GITHUB_FILE_LIMIT:
                _git(["reset", "-q", "--", rel])                              # unstage new file
                _git(["rm", "--cached", "-q", "--ignore-unmatch", "--", rel])  # untrack if it was committed before
                _add_local_ignore(rel)                                        # skip it on future adds
                kept.append(rel)
        except OSError:
            pass
    return kept


def git_sync(reason="update"):
    """Commit any changes in ./drafts/ and push to the private remote."""
    if not os.path.isdir(os.path.join(DRAFTS_DIR, ".git")):
        LAST_PUSH.update(time=human_now(), ok=False, detail="drafts/ is not a git repo")
        return dict(LAST_PUSH)
    with GIT_LOCK:
        try:
            _git(["add", "-A"])
            kept_local = _exclude_oversized()   # never let a >95MB file break the push
            status = _git(["status", "--porcelain"]).stdout.strip()
            committed = False
            if status:
                c = _git(["commit", "-m", f"drafts: {reason} ({human_now()})"])
                committed = c.returncode == 0
            push = _git(["push", "origin", "main"])
            ok = push.returncode == 0
            if ok:
                detail = f"pushed ({reason})" if committed else f"up to date ({reason})"
            else:
                detail = "push failed: " + (push.stderr.strip() or "unknown error")
            if kept_local:
                detail += f"; {len(kept_local)} large file(s) too big for GitHub — kept local-only"
            LAST_PUSH.update(time=human_now(), ok=ok, detail=detail)
        except Exception as e:
            LAST_PUSH.update(time=human_now(), ok=False, detail=f"error: {e}")
    return dict(LAST_PUSH)


def push_status():
    """LAST_PUSH plus live git truth: synced (nothing left to push) and the
    epoch time of the last successful push (upstream head's commit time —
    commits here happen right before pushing, so it's the push time)."""
    s = dict(LAST_PUSH)
    s["synced"] = False
    s["last_push_ts"] = None
    if not os.path.isdir(os.path.join(DRAFTS_DIR, ".git")):
        return s
    try:
        with GIT_LOCK:
            dirty = bool(_git(["status", "--porcelain"]).stdout.strip())
            ahead = _git(["rev-list", "--count", "@{u}..HEAD"])
            up_ts = _git(["log", "-1", "--format=%ct", "@{u}"])
        ahead_n = int(ahead.stdout.strip() or "0") if ahead.returncode == 0 else 1
        s["synced"] = (not dirty) and ahead_n == 0
        if up_ts.returncode == 0 and up_ts.stdout.strip():
            s["last_push_ts"] = int(up_ts.stdout.strip())
    except Exception:
        pass
    return s


def auto_push_loop():
    while True:
        time.sleep(AUTO_PUSH_SECONDS)
        try:
            git_sync("auto")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Publish state (private) + proof upgrades
# ---------------------------------------------------------------------------

def load_publish_state():
    """Per-draft publish bookkeeping that must NOT be public: the unlisted share token
    of each draft ({"shares": {draft_id: token}}). Lives in drafts/ (private repo)."""
    try:
        with open(PUBLISH_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("shares", {})
    return data


def save_publish_state(data):
    os.makedirs(os.path.dirname(PUBLISH_STATE_PATH), exist_ok=True)
    tmp = PUBLISH_STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PUBLISH_STATE_PATH)


def _site_git(args):
    return subprocess.run(["git", *args], cwd=ROOT, env=GIT_ENV, capture_output=True, text=True)


def site_commit_push(paths, message):
    """Stage exactly `paths` in the public site repo, commit them (pathspec commit, so
    unrelated staged/unstaged work is left alone) and push origin main."""
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        return {"ok": False, "detail": "site folder is not a git repo"}
    paths = [p for p in paths if p and ".." not in p]
    with SITE_GIT_LOCK:
        try:
            _site_git(["add", "-A", "--", *paths])
            status = _site_git(["status", "--porcelain", "--", *paths]).stdout.strip()
            committed = False
            if status:
                c = _site_git(["commit", "-q", "-m", message, "--", *paths])
                if c.returncode != 0:
                    return {"ok": False, "committed": False, "pushed": False,
                            "detail": "commit failed: " + (c.stderr.strip() or c.stdout.strip())}
                committed = True
            push = _site_git(["push", "origin", "main"])
            if push.returncode != 0:
                return {"ok": False, "committed": committed, "pushed": False,
                        "detail": "push failed: " + (push.stderr.strip() or "unknown error")}
            head = _site_git(["rev-parse", "--short", "HEAD"]).stdout.strip()
            return {"ok": True, "committed": committed, "pushed": True, "commit": head,
                    "detail": ("committed " + head + " and pushed") if committed else "nothing new to commit; pushed"}
        except Exception as e:
            return {"ok": False, "detail": f"git error: {e}"}


def write_publish_files(files):
    """Write the editor's publish payload ([{path, text | b64}]) under ROOT. Only the
    allow-listed site paths (writings/, writings/media/, writings/p/, media/, writings.html)."""
    written = []
    for f in files:
        rel = str(f.get("path") or "")
        if not PUBLISH_PATH_RE.match(rel) or ".." in rel:
            raise ValueError(f"refusing to write {rel!r}")
        if "b64" in f:
            data = base64.b64decode(f["b64"])
        else:
            data = str(f.get("text") or "").encode("utf-8")
        fp = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        tmp = fp + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, fp)
        written.append(rel)
    return written


def upgrade_proofs(reason="auto"):
    """Upgrade + verify pending OpenTimestamps proofs (see provenance.py), then commit and
    push writings/proofs/ so confirmed proofs go live without a manual git step. Never fatal."""
    if provenance is None:
        return {}
    with PROOF_LOCK:
        try:
            changed = provenance.upgrade_all(log=lambda m: sys.stderr.write(m + "\n"))
        except Exception as e:
            sys.stderr.write(f"[proofs] upgrade ({reason}) failed: {e}\n")
            return {}
    if changed:
        what = ", ".join(f"{slug} v{'/'.join(str(v['n']) for v in vs)}" for slug, vs in changed.items())
        r = site_commit_push(["writings/proofs"], f"Proofs: timestamp update for {what}")
        sys.stderr.write(f"[proofs] {r.get('detail')}\n")
    return changed


def proof_upgrade_loop():
    while True:
        time.sleep(PROOF_UPGRADE_SECONDS)
        try:
            if provenance is not None and provenance.pending_count():
                upgrade_proofs("auto")
        except Exception:
            pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        # Dev server: never let the browser cache static assets, so editing the
        # editor's src/*.js (and CSS/HTML) and hitting reload always serves the
        # fresh code. Without this, Chrome heuristically caches the ES modules and
        # a reload silently keeps running the old code.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        return parse_qs(urlparse(self.path).query)

    def do_GET(self):
        path = self.path.split("?")[0]
        # Serve the editor at the clean URL /editor.html (the file lives at editor/editor.html;
        # its <base href="/editor/"> keeps relative assets resolving correctly).
        if path == "/editor.html":
            self.path = self.path.replace("/editor.html", "/editor/editor.html", 1)
            return super().do_GET()
        if path == "/api/drafts":
            with LOCK:
                store = load_store()
            return self._send_json(store)
        if path == "/api/push":          # status
            return self._send_json(push_status())
        if path == "/api/publish-state":
            return self._send_json(load_publish_state())
        if path == "/api/proofs":        # one article's timestamp manifest (+ pending count)
            if provenance is None:
                return self._send_json({"available": False, "versions": []})
            slug = (self._query().get("slug") or [""])[0]
            if not provenance.SAFE_SLUG_RE.match(slug):
                return self.send_error(400, "bad slug")
            m = provenance.load_manifest(slug)
            m["available"] = True
            return self._send_json(m)
        if path == "/api/media":         # list a draft's backed-up media files
            draft = (self._query().get("draft") or [""])[0]
            if not SAFE_ID_RE.match(draft):
                return self.send_error(400, "bad draft id")
            d = media_dir(draft)
            files = sorted(os.listdir(d)) if os.path.isdir(d) else []
            return self._send_json({"files": files})
        return super().do_GET()

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return None
        return obj if isinstance(obj, dict) else None

    def do_PUT(self):
        path = self.path.split("?")[0]
        if path == "/api/publish-state":   # merge {"shares": {id: token}}
            incoming = self._read_json()
            if incoming is None:
                return self.send_error(400, "bad json")
            with LOCK:
                st = load_publish_state()
                for k, v in (incoming.get("shares") or {}).items():
                    if SAFE_ID_RE.match(str(k)) and re.match(r"^[0-9a-f]{16,64}$", str(v)):
                        st["shares"][k] = v
                save_publish_state(st)
            return self._send_json(st)
        if path != "/api/drafts":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            incoming = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return self.send_error(400, "bad json")
        if not isinstance(incoming, dict):
            return self.send_error(400, "bad payload")
        with LOCK:
            store = load_store()
            merge(store, incoming)
            save_store(store)
            out = store
        self._send_json(out)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/push":
            return self._send_json(git_sync("manual"))
        if path == "/api/stamp":         # timestamp a just-published version (see provenance.py)
            if provenance is None:
                return self._send_json({"ok": False, "error": "timestamping unavailable: pip install opentimestamps"}, 503)
            body = self._read_json()
            if body is None:
                return self.send_error(400, "bad json")
            try:
                with PROOF_LOCK:
                    entry = provenance.stamp_version(
                        str(body.get("slug") or ""), body.get("n"),
                        expected_sha256=str(body.get("sha256") or "") or None,
                        meta={k: body.get(k) for k in ("contentSha256", "date", "title", "words")})
                return self._send_json({"ok": True, "entry": entry})
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, 400)
        if path == "/api/publish":       # write site files (see write_publish_files)
            body = self._read_json()
            if body is None:
                return self.send_error(400, "bad json")
            try:
                written = write_publish_files(body.get("files") or [])
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, 400)
            return self._send_json({"ok": True, "written": written})
        if path == "/api/site-push":     # commit + push the given site paths
            body = self._read_json()
            if body is None:
                return self.send_error(400, "bad json")
            paths = [str(p) for p in (body.get("paths") or []) if PUBLISH_PATH_RE.match(str(p)) or str(p) in ("writings/proofs", "robots.txt")]
            if not paths:
                return self._send_json({"ok": False, "error": "no publishable paths"}, 400)
            r = site_commit_push(paths, str(body.get("message") or "Publish"))
            if not r.get("ok"):
                return self._send_json({"ok": False, "error": r.get("detail"), "git": r}, 500)
            return self._send_json({"ok": True, "git": r})
        if path == "/api/proofs/upgrade":
            changed = upgrade_proofs("manual")
            pending = provenance.pending_count() if provenance else 0
            return self._send_json({"ok": True, "changed": {k: [v["n"] for v in vs] for k, vs in changed.items()}, "pending": pending})
        if path == "/api/media":         # editor uploads a video blob for backup
            q = self._query()
            draft = (q.get("draft") or [""])[0]
            name = (q.get("name") or [""])[0]
            if not SAFE_ID_RE.match(draft) or not SAFE_NAME_RE.match(name) or ".." in name:
                return self.send_error(400, "bad media id")
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else b""
            d = media_dir(draft)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name), "wb") as f:
                f.write(data)
            return self._send_json({"ok": True, "name": name, "bytes": len(data)})
        return self.send_error(404)

    def log_message(self, *args):
        pass  # keep the terminal quiet


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    # mirror any existing drafts to files at startup
    try:
        sync_draft_files(load_store())
    except Exception as e:
        sys.stderr.write(f"[drafts] startup sync failed: {e}\n")
    threading.Thread(target=auto_push_loop, daemon=True).start()
    # Bitcoin timestamps: upgrade any pending proofs now (in the background) and every ~15 min
    threading.Thread(target=lambda: upgrade_proofs("startup"), daemon=True).start()
    threading.Thread(target=proof_upgrade_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving {ROOT} at http://localhost:{port}")
    print(f"Editor:  http://localhost:{port}/editor.html")
    print(f"Drafts:  {STORE_PATH}")
    print(f"Files:   {DRAFTS_DIR}/  (+ media/<id>/ for images & videos; private repo ahilanks/writing-drafts, auto-push every {AUTO_PUSH_SECONDS}s)")
    print(f"Proofs:  writings/proofs/<slug>/ (OpenTimestamps; pending proofs re-checked every {PROOF_UPGRADE_SECONDS}s)"
          if provenance else "Proofs:  UNAVAILABLE (pip install opentimestamps)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
