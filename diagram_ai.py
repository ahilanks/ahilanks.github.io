"""diagram_ai.py — make or change an article diagram with Claude (used by editor-server.py).

POST /api/diagram {"prompt": "...", "html": "<current diagram, to change it>", "context": "..."}
  -> {"ok": true, "html": "<!DOCTYPE html>…", "caption": "…"}

Claude Opus 5.5 at medium effort, with the site's house style in the system prompt so every
diagram sits on the page the same way (no background, the article's ink and accent, thin
lines, responsive, no title inside — the caption does that).

The key is ANTHROPIC_API_KEY, from the environment or the project's .env (gitignored).
"""
import os
import re

MODEL = "claude-opus-5-5"
EFFORT = "medium"
ROOT = os.path.dirname(os.path.abspath(__file__))

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

Answer with the complete HTML document in one ```html code block, then one line starting with "CAPTION:" giving a short caption for under the figure (one sentence, plain, no "Figure 1"). Nothing else."""

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


def make_diagram(prompt, html="", context=""):
    """Returns (status, payload) for the JSON response."""
    prompt = (prompt or "").strip()
    if not prompt:
        return 400, {"ok": False, "error": "Describe the diagram first."}
    try:
        import anthropic
    except ImportError:
        return 503, {"ok": False, "error": "The Anthropic SDK isn't installed: run  python3 -m pip install anthropic"}
    key = _api_key()
    if not key:
        return 503, {"ok": False, "error": "No Claude key yet: add ANTHROPIC_API_KEY=… to the .env file in the site folder."}

    parts = []
    if context.strip():
        parts.append("Where it goes in the article (for meaning; don't copy it into the figure):\n<article_excerpt>\n" + context.strip()[:6000] + "\n</article_excerpt>")
    if html.strip():
        parts.append(CHANGE_NOTE + "\n<current_diagram>\n" + html.strip()[:120000] + "\n</current_diagram>")
        parts.append("Change: " + prompt)
    else:
        parts.append("Diagram: " + prompt)

    client = anthropic.Anthropic(api_key=key, timeout=600.0)
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=HOUSE_STYLE,
            output_config={"effort": EFFORT},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": "\n\n".join(parts)}],
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        return 401, {"ok": False, "error": "Claude rejected the key in .env (ANTHROPIC_API_KEY)."}
    except anthropic.RateLimitError:
        return 429, {"ok": False, "error": "Claude is rate-limiting right now; try again in a minute."}
    except anthropic.APIStatusError as e:
        return 502, {"ok": False, "error": "Claude error " + str(e.status_code) + ": " + str(e.message)[:300]}
    except anthropic.APIConnectionError:
        return 502, {"ok": False, "error": "Couldn't reach Claude (network)."}

    if msg.stop_reason == "refusal":
        return 422, {"ok": False, "error": "Claude declined this one; try wording it differently."}
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    m = re.search(r"```(?:html)?\s*\n(.*?)```", text, re.S)
    doc = (m.group(1) if m else text).strip()
    if msg.stop_reason == "max_tokens" or not re.search(r"<(svg|html|div|canvas)[\s>]", doc, re.I):
        return 502, {"ok": False, "error": "Claude's answer didn't contain a usable diagram; try again."}
    cap = re.search(r"^\s*CAPTION:\s*(.+)$", text[m.end():] if m else "", re.M)
    return 200, {"ok": True, "html": doc, "caption": cap.group(1).strip() if cap else "", "model": msg.model}
