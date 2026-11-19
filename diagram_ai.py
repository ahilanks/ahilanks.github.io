"""diagram_ai.py — make or change an article diagram with Claude (used by editor-server.py).

Claude Opus 5.5 at medium effort, with the site's house style in the system prompt so every
diagram sits on the page the same way (no background, the article's ink and accent, thin
lines, responsive, no title inside — the caption does that).

Requests are server-side JOBS, so an answer keeps going (and is kept) when the browser
reloads: the editor only watches. Jobs for the same diagram run one after another, each
starting from the previous answer's diagram, so the writer can keep sending messages.

  POST /api/diagram/jobs            {did, prompt, html, context, history, images, files} -> {id}
  POST /api/diagram/stop            {did} -> stop what Claude is doing on that diagram (the
                                    running answer and any queued after it)
  GET  /api/diagram/jobs            -> every job not yet applied to its draft
  GET  /api/diagram/jobs/<id>/events?from=N   NDJSON: {"k":"think"|"text","t":…} … then
                                              {"k":"end","job":{…}} when it finishes
  POST /api/diagram/jobs/<id>/applied         the editor put the answer into the draft

Finished jobs are written to .diagram-jobs/ (gitignored) until applied, so an answer that
lands while no editor is open is still there later. Files the writer attaches (a paper, notes,
data, an HTML page: {name, kind: "text"|"pdf", data}) stay with their diagram in
.diagram-jobs/ctx/<did>.json, so every later message about it still has them. The key is ANTHROPIC_API_KEY, from the
environment or the project's .env (gitignored).
"""
import base64
import json
import os
import re
import threading
import time
import uuid

MODEL = "claude-opus-5-5"
EFFORT = "medium"
ROOT = os.path.dirname(os.path.abspath(__file__))
JOB_DIR = os.path.join(ROOT, ".diagram-jobs")
IMG_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGES = 6
MAX_TEXT = 200000          # characters kept from one text file
MAX_CTX_TEXT = 400000      # all of one diagram's text files together
MAX_PDF = 12 * 1024 * 1024 # base64 characters of one PDF

HOUSE_STYLE = """You make diagrams for a personal essay site about AI. Each diagram is one self-contained HTML document shown inside a sandboxed iframe in the article, between paragraphs. Readers see it on laptops (frame about 820px wide) and phones (about 340px wide).

How the site looks: a warm cream page (#f1ebdf), ink #27323f, muted grey #6b7280, one accent orange #e8743b, serif text (Newsreader). Calm, editorial, minimal: think a well-made figure in a print essay, not a dashboard.

Rules for every diagram:
- No background. Leave html and body transparent; no card, panel, border, rounded box or shadow around the figure. Add a background only where it carries meaning (a shaded region of a chart, a night sky).
- No title or heading inside the diagram, and no source/footnote text: the article gives it a caption. Short labels on the figure itself are good.
- Colours from the house palette, already defined as CSS variables you can use: var(--ink) #27323f, var(--muted) #6b7280, var(--accent) #e8743b, var(--line) rgba(39,50,63,0.15), var(--tint-green) #e6f2e6, var(--tint-red) #f8e4df, var(--tint-orange) #fbe3d4. Use the accent for the one thing that matters most. At most one or two tints.
- Type: font-family var(--font) (the article's serif) for labels; var(--sans) only for tiny axis numbers if it reads better. Labels 13–16px; never below 12px.
- Lines thin (1–1.5px), rounded caps, generous whitespace. No gradients, glows, 3D or emoji.
- Responsive: fill 100% of the width, never a fixed pixel width. Prefer one <svg> with a viewBox and width="100%"; keep the height modest (roughly 0.35–0.6 of the width). Lay out HTML controls with flex and let them wrap. It must stay legible at 340px wide.
- Interactivity or animation only when it explains something (a slider over a parameter, a play/pause for a process). Keep controls small and quiet in the same style (thin outline, ink colour). Respect prefers-reduced-motion.
- Self-contained: inline CSS, inline SVG, plain JavaScript. No external scripts, images, fonts or network requests.
- Accurate: labels and shapes must match what the text says. Don't invent data; if the figure is illustrative, keep it qualitative (no fake numbers on axes).
- When the writer says a change didn't work or they still can't see something, read the current code closely to find what really controls it (inline styles, opacity, a script or animation that sets colours at runtime, a later CSS rule) and fix that, rather than repeating the same edit.
- The writer may paste screenshots or sketches; use them to see what they mean.
- The writer may attach files (a paper, notes, data, an existing HTML page). Treat them as the source for what the diagram shows: take its facts, numbers and terms from them. An attached HTML page can be a starting point to restyle in the house style.

How to answer:
- A new diagram: the complete HTML document in one ```html code block, then a line "CAPTION: …" (one plain sentence for under the figure, no "Figure 1"), then a line "NOTE: …" (one sentence on what you drew).
- A change to the current diagram: the whole updated document in one ```html code block, then "NOTE: …" saying in one or two plain sentences what you changed.
- If the writer only asks a question, or the request would make the diagram worse or wrong, don't send code: answer with just "NOTE: …" (two or three sentences at most), and suggest what you would do instead.
Nothing else outside these parts."""

CHANGE_NOTE = "This is the current diagram. Change it as asked, keep everything else as it is, and return the whole updated document."


def _api_key():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.join(ROOT, ".env"), "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*[\"']?([^\"'\r\n]+)", line)
                if m:
                    return m.group(1).strip()
    except OSError:
        pass
    return ""


def _parse(text):
    """(html, caption, note) from Claude's answer; NOTE/CAPTION may sit before or after the code."""
    m = re.search(r"```(?:html)?\s*\n(.*?)```", text, re.S)
    doc = m.group(1).strip() if m else ""
    rest = (text[:m.start()] + "\n" + text[m.end():]) if m else text
    cap = re.search(r"^\s*CAPTION:\s*(.+)$", rest, re.M)
    note = re.search(r"^\s*NOTE:\s*(.+(?:\n(?!\s*(?:CAPTION|NOTE):)(?!\s*$).+)*)", rest, re.M)
    if doc and not re.search(r"<(svg|html|div|canvas)[\s>]", doc, re.I):
        doc = ""
    note_text = note.group(1).strip() if note else ""
    if not note_text:  # plain words outside the code are still worth showing
        note_text = re.sub(r"^\s*CAPTION:.*$", "", rest, flags=re.M).strip()[:600]
    return doc, (cap.group(1).strip() if cap else ""), note_text


def run_claude(prompt, html, context, history, images, emit, files=None, stopped=lambda: False):
    """Stream one request. emit({"k": "think"|"text", "t": delta}). Returns a result dict."""
    try:
        import anthropic
    except ImportError:
        return {"ok": False, "error": "The Anthropic SDK isn't installed: run  python3 -m pip install anthropic"}
    key = _api_key()
    if not key:
        return {"ok": False, "error": "No Claude key yet: add ANTHROPIC_API_KEY=… to the .env file in the site folder."}

    parts = []
    if context.strip():
        parts.append("Where it goes in the article (for meaning; don't copy it into the figure):\n<article_excerpt>\n" + context.strip()[:6000] + "\n</article_excerpt>")
    turns = [h for h in (history or []) if isinstance(h, dict) and str(h.get("text") or "").strip()][-14:]
    if turns:
        parts.append("The conversation about this diagram so far:\n<conversation>\n" + "\n".join(
            ("Writer: " if h.get("role") == "user" else "You: ") + str(h.get("text"))[:1500] for h in turns) + "\n</conversation>")
    if html.strip():
        parts.append(CHANGE_NOTE + "\n<current_diagram>\n" + html.strip()[:120000] + "\n</current_diagram>")
        parts.append("Writer's new message: " + prompt)
    else:
        parts.append("Diagram: " + prompt)
    content = []
    names = []
    for f in (files or []):
        if f.get("kind") == "pdf":
            content.append({"type": "document", "title": f["name"], "source": {"type": "base64", "media_type": "application/pdf", "data": f["data"]}})
        else:
            content.append({"type": "document", "title": f["name"], "source": {"type": "text", "media_type": "text/plain", "data": f["data"]}})
        names.append(f["name"])
    if names:
        parts.insert(0, "Files the writer attached for this diagram (above): " + ", ".join(names) + ". Use them as the source for what it shows.")
    for im in (images or [])[:MAX_IMAGES]:
        if isinstance(im, dict) and im.get("media_type") in IMG_TYPES and im.get("data"):
            content.append({"type": "image", "source": {"type": "base64", "media_type": im["media_type"], "data": im["data"]}})
    if content:
        parts.append("(The writer attached " + str(len(content)) + " image" + ("s" if len(content) > 1 else "") + " above.)")
    content.append({"type": "text", "text": "\n\n".join(parts)})

    client = anthropic.Anthropic(api_key=key, timeout=600.0)
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=HOUSE_STYLE,
            thinking={"type": "adaptive", "display": "summarized"},  # shown live in the chat
            output_config={"effort": EFFORT},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": content}],
        ) as stream:
            for event in stream:
                if stopped():
                    return {"ok": False, "stopped": True, "error": "Stopped."}  # leaving the block closes the request
                if event.type == "content_block_delta":
                    d = event.delta
                    if d.type == "thinking_delta" and d.thinking:
                        emit({"k": "think", "t": d.thinking})
                    elif d.type == "text_delta" and d.text:
                        emit({"k": "text", "t": d.text})
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        return {"ok": False, "error": "Claude rejected the key in .env (ANTHROPIC_API_KEY)."}
    except anthropic.RateLimitError:
        return {"ok": False, "error": "Claude is rate-limiting right now; try again in a minute."}
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": "Claude error " + str(e.status_code) + ": " + str(e.message)[:300]}
    except anthropic.APIConnectionError:
        return {"ok": False, "error": "Couldn't reach Claude (network)."}

    if msg.stop_reason == "refusal":
        return {"ok": False, "error": "Claude declined this one; try wording it differently."}
    if msg.stop_reason == "max_tokens":
        return {"ok": False, "error": "Claude's answer was cut off; try a simpler request."}
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    doc, cap, note = _parse(text)
    if not doc and not html.strip():
        return {"ok": False, "error": "Claude's answer didn't contain a usable diagram; try again."}
    if not doc and not note:
        return {"ok": False, "error": "Claude's answer was empty; try again."}
    return {"ok": True, "html": doc, "caption": cap, "note": note or "Done.", "model": msg.model}


# ------------------------------------------------------------------ jobs
LOCK = threading.Lock()
JOBS = {}      # id -> Job
WORKERS = {}   # did -> True while a worker thread is running that diagram's queue


class Job:
    def __init__(self, body):
        self.id = uuid.uuid4().hex[:12]
        self.did = str(body.get("did") or "")
        self.prompt = str(body.get("prompt") or "").strip()
        self.html = str(body.get("html") or "")
        self.context = str(body.get("context") or "")
        self.history = body.get("history") if isinstance(body.get("history"), list) else []
        self.images = body.get("images") if isinstance(body.get("images"), list) else []
        self.files = _clean_files(body.get("files"))
        self.stop = False
        self.status = "queued"
        self.created = time.time()
        self.events = []
        self.result = None
        self.think = ""
        self.cond = threading.Condition()

    def push(self, ev):
        with self.cond:
            self.events.append(ev)
            if ev.get("k") == "think":
                self.think += ev.get("t", "")
            self.cond.notify_all()

    def summary(self):
        return {"id": self.id, "did": self.did, "status": self.status, "prompt": self.prompt,
                "created": self.created, "result": self.result, "think": self.think[-6000:]}

    def save(self):
        os.makedirs(JOB_DIR, exist_ok=True)
        tmp = os.path.join(JOB_DIR, self.id + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.summary(), f)
        os.replace(tmp, os.path.join(JOB_DIR, self.id + ".json"))


def _clean_files(raw):
    out = []
    for f in (raw if isinstance(raw, list) else [])[:12]:
        if not isinstance(f, dict):
            continue
        name = re.sub(r"[^\w .()\-]", "_", str(f.get("name") or "file"))[:120] or "file"
        data = f.get("data")
        if not isinstance(data, str) or not data:
            continue
        if f.get("kind") == "pdf":
            if len(data) <= MAX_PDF and re.match(r"^[A-Za-z0-9+/=\s]+$", data[:200]):
                out.append({"name": name, "kind": "pdf", "data": data})
        else:
            out.append({"name": name, "kind": "text", "data": data[:MAX_TEXT]})
    return out


def _ctx_path(did):
    return os.path.join(JOB_DIR, "ctx", re.sub(r"[^\w-]", "", did)[:40] + ".json")


def ctx_files(did):
    """The files attached to this diagram so far."""
    try:
        with open(_ctx_path(did), "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, list) else []
    except (OSError, ValueError):
        return []


def _add_ctx(did, files):
    """Keep new files with the diagram (a file with the same name is replaced; the oldest
    text goes first when the text gets too long)."""
    if not files or not did:
        return
    have = [f for f in ctx_files(did) if f["name"] not in {n["name"] for n in files}] + files
    while sum(len(f["data"]) for f in have if f["kind"] == "text") > MAX_CTX_TEXT and len(have) > 1:
        have.pop(0)
    os.makedirs(os.path.dirname(_ctx_path(did)), exist_ok=True)
    tmp = _ctx_path(did) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(have, fh)
    os.replace(tmp, _ctx_path(did))


def stop(body):
    """Stop the running answer for this diagram and drop the queued ones."""
    did = str((body or {}).get("did") or "")
    if not did:
        return 400, {"ok": False, "error": "missing diagram id"}
    n = 0
    with LOCK:
        jobs = [j for j in JOBS.values() if j.did == did and j.status in ("queued", "running")]
        for j in jobs:
            j.stop = True
            n += 1
            if j.status == "queued":
                j.status = "error"
                j.result = {"ok": False, "stopped": True, "error": "Stopped before it started."}
    for j in jobs:
        if j.status == "error":
            try:
                j.save()
            except OSError:
                pass
        with j.cond:
            j.cond.notify_all()
    return 200, {"ok": True, "stopped": n}


def _queue_for(did):
    return sorted([j for j in JOBS.values() if j.did == did and j.status == "queued"], key=lambda j: j.created)


def _worker(did):
    """Run this diagram's queued jobs in order, each starting from the last answer."""
    chain_html, chain_hist = None, None
    while True:
        with LOCK:
            q = _queue_for(did)
            if not q:
                WORKERS.pop(did, None)
                return
            job = q[0]
            job.status = "running"
        html = chain_html if chain_html is not None else job.html
        hist = (chain_hist if chain_hist is not None else list(job.history))
        job.push({"k": "start", "at": time.time()})
        try:
            res = run_claude(job.prompt, html, job.context, hist, job.images, job.push,
                             files=ctx_files(did), stopped=lambda: job.stop)
        except Exception as e:  # never leave a job hanging
            res = {"ok": False, "error": "Something broke: " + str(e)[:200]}
        job.images = []  # big; not needed any more
        job.result = res
        job.status = "done" if res.get("ok") else "error"
        try:
            job.save()
        except OSError:
            pass
        with job.cond:
            job.cond.notify_all()
        if res.get("ok") and res.get("html"):
            chain_html = res["html"]
        elif chain_html is None:
            chain_html = html
        chain_hist = hist + [{"role": "user", "text": job.prompt}, {"role": "assistant", "text": res.get("note") or res.get("error") or ""}]


def submit(body):
    job = Job(body)
    if not job.prompt and not job.images and not job.files:
        return 400, {"ok": False, "error": "Say what you'd like first."}
    if not job.prompt:
        job.prompt = "(see the attached image)" if job.images else "(see the attached files)"
    if not job.did:
        return 400, {"ok": False, "error": "missing diagram id"}
    if job.files:
        try:
            _add_ctx(job.did, job.files)
        except OSError:
            return 500, {"ok": False, "error": "Couldn't keep the attached files."}
        job.files = []
    with LOCK:
        JOBS[job.id] = job
        start = job.did not in WORKERS
        if start:
            WORKERS[job.did] = True
    if start:
        threading.Thread(target=_worker, args=(job.did,), daemon=True).start()
    return 200, {"ok": True, "id": job.id}


def _load_saved():
    out = {}
    try:
        names = os.listdir(JOB_DIR)
    except OSError:
        return out
    for n in names:
        if n.endswith(".json"):
            try:
                with open(os.path.join(JOB_DIR, n), "r", encoding="utf-8") as f:
                    d = json.load(f)
                out[d["id"]] = d
            except (OSError, ValueError, KeyError):
                pass
    return out


def open_jobs():
    """Everything the editor still has to show or apply: live jobs plus saved finished ones."""
    saved = _load_saved()
    with LOCK:
        live = {j.id: j.summary() for j in JOBS.values() if j.status in ("queued", "running") or j.id in saved}
    saved.update(live)
    # v2: takes attached files and /api/diagram/stop (the editor checks, so an old server
    # that's still running says so instead of quietly dropping files)
    return {"ok": True, "v": 2, "jobs": sorted(saved.values(), key=lambda d: d.get("created", 0))}


def applied(job_id):
    if not re.match(r"^[0-9a-f]{12}$", job_id or ""):
        return 400, {"ok": False}
    with LOCK:
        j = JOBS.get(job_id)
        if j and j.status in ("done", "error"):
            JOBS.pop(job_id, None)
    try:
        os.remove(os.path.join(JOB_DIR, job_id + ".json"))
    except OSError:
        pass
    return 200, {"ok": True}


def stream_events(job_id, start, write):
    """Write the job's events from `start` on, live, then an end line. write(dict) -> False to stop."""
    with LOCK:
        job = JOBS.get(job_id)
    if job is None:  # finished before a server restart: just the outcome
        d = _load_saved().get(job_id)
        write({"k": "end", "job": d} if d else {"k": "gone"})
        return
    i = max(0, int(start or 0))
    while True:
        with job.cond:
            while i >= len(job.events) and job.status in ("queued", "running"):
                job.cond.wait(timeout=15)
                if i >= len(job.events) and job.status in ("queued", "running"):
                    break  # heartbeat
            batch = job.events[i:]
            finished = job.status not in ("queued", "running")
        if not batch and not finished:
            if write({"k": "ping"}) is False:
                return
            continue
        for ev in batch:
            i += 1
            if write(dict(ev, i=i)) is False:
                return
        if finished and i >= len(job.events):
            write({"k": "end", "job": job.summary()})
            return
