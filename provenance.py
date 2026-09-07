#!/usr/bin/env python3
"""Cryptographic timestamping for published articles (OpenTimestamps -> Bitcoin).

Every full (non-draft) publish freezes the article as writings/<slug>.v<N>.html. This
module hashes that frozen file (SHA-256), submits the digest to the public
OpenTimestamps calendar servers, and stores the proof as writings/proofs/<slug>/v<N>.ots
plus a human/JS-readable writings/proofs/<slug>/manifest.json that the article's
provenance widget reads at runtime.

Life-cycle of a proof:
  1. stamp    - calendars return a *pending* attestation within a second.
  2. upgrade  - a few hours later (once the calendar's aggregate commitment is mined
                into a Bitcoin block) the calendar hands back the completed proof, which
                carries a BitcoinBlockHeaderAttestation(height).
  3. verify   - we fetch that block's header from two independent public explorers and
                check the proof's merkle root against the block's. Confirmed + verified
                proofs are final: nobody (including the author) can change the text
                without changing the fingerprint.

The editor server calls stamp_version() on publish and upgrade_all() at startup and
every ~15 minutes. Also usable from the shell:

    python3 provenance.py upgrade          # upgrade + verify every pending proof
    python3 provenance.py verify <slug>    # re-verify every version of one article
    python3 provenance.py status           # one line per version

Verification for readers is independent of this code: each version file + its .ots can
be checked at opentimestamps.org or with `ots verify <file>.ots`.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

from opentimestamps.calendar import RemoteCalendar
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpAppend, OpSHA256
from opentimestamps.core.serialize import BytesDeserializationContext, BytesSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

ROOT = os.path.dirname(os.path.abspath(__file__))
WRITINGS_DIR = os.path.join(ROOT, "writings")
PROOFS_DIR = os.path.join(WRITINGS_DIR, "proofs")

# The same public calendars the reference `ots` client uses.
CALENDARS = [
    "https://a.pool.opentimestamps.org",
    "https://b.pool.opentimestamps.org",
    "https://a.pool.eternitywall.com",
    "https://ots.btc.catallaxy.com",
]
# Two independent block explorers; the proof is marked verified only if one of them
# returns a header whose merkle root matches the proof's.
EXPLORERS = [
    "https://blockstream.info/api",
    "https://mempool.space/api",
]
SAFE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,79}$")
HTTP_TIMEOUT = 12


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _ser(file_ts):
    ctx = BytesSerializationContext()
    file_ts.serialize(ctx)
    return ctx.getbytes()


def _deser(raw):
    return DetachedTimestampFile.deserialize(BytesDeserializationContext(raw))


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def proof_dir(slug):
    return os.path.join(PROOFS_DIR, slug)


def manifest_path(slug):
    return os.path.join(proof_dir(slug), "manifest.json")


def load_manifest(slug):
    try:
        with open(manifest_path(slug), "r", encoding="utf-8") as f:
            m = json.load(f)
    except (FileNotFoundError, ValueError):
        m = {}
    if not isinstance(m, dict):
        m = {}
    m.setdefault("slug", slug)
    m.setdefault("versions", [])
    return m


def save_manifest(slug, m):
    os.makedirs(proof_dir(slug), exist_ok=True)
    m["updated"] = _now_iso()
    tmp = manifest_path(slug) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, manifest_path(slug))


def list_slugs():
    try:
        return sorted(d for d in os.listdir(PROOFS_DIR)
                      if os.path.isfile(manifest_path(d)))
    except OSError:
        return []


# ---------------------------------------------------------------------------
# stamp
# ---------------------------------------------------------------------------

def stamp_digest(digest):
    """Submit a 32-byte SHA-256 digest to the calendars. Mirrors the reference client:
    the digest is salted with a random nonce (so the calendars never learn the raw
    fingerprint) before the merkle tip goes out. Returns (DetachedTimestampFile, [ok urls])."""
    file_ts = DetachedTimestampFile(OpSHA256(), Timestamp(digest))
    nonce_ts = file_ts.timestamp.ops.add(OpAppend(os.urandom(16)))
    merkle_tip = nonce_ts.ops.add(OpSHA256())
    ok = []
    errors = []
    for url in CALENDARS:
        try:
            ts = RemoteCalendar(url).submit(merkle_tip.msg, timeout=HTTP_TIMEOUT)
            merkle_tip.merge(ts)
            ok.append(url)
        except Exception as e:  # one calendar down is fine; zero is not
            errors.append(f"{url}: {e}")
    if not ok:
        raise RuntimeError("No OpenTimestamps calendar accepted the digest: " + "; ".join(errors))
    return file_ts, ok


def stamp_version(slug, n, expected_sha256=None, meta=None):
    """Hash writings/<slug>.v<n>.html on disk, timestamp it, and record the version in the
    manifest. `expected_sha256` (what the editor computed client-side) must match the
    on-disk bytes, which proves the folder the browser wrote to is the one this server
    serves. Returns the manifest entry."""
    if not SAFE_SLUG_RE.match(slug or ""):
        raise ValueError("bad slug")
    n = int(n)
    if n < 1:
        raise ValueError("bad version number")
    fname = f"{slug}.v{n}.html"
    fpath = os.path.join(WRITINGS_DIR, fname)
    if not os.path.isfile(fpath):
        raise FileNotFoundError(f"writings/{fname} is not on disk - was the article published into the folder this server serves?")
    digest_hex = sha256_file(fpath)
    if expected_sha256 and expected_sha256.lower() != digest_hex:
        raise ValueError("fingerprint mismatch: the bytes on disk differ from what the editor wrote")

    m = load_manifest(slug)
    existing = next((v for v in m["versions"] if v.get("n") == n), None)
    if existing and existing.get("sha256") == digest_hex and existing.get("ots"):
        return existing  # idempotent re-request

    file_ts, calendars = stamp_digest(bytes.fromhex(digest_hex))
    os.makedirs(proof_dir(slug), exist_ok=True)
    ots_name = f"v{n}.ots"
    with open(os.path.join(proof_dir(slug), ots_name), "wb") as f:
        f.write(_ser(file_ts))

    meta = meta or {}
    entry = {
        "n": n,
        "file": fname,
        "sha256": digest_hex,
        "contentSha256": meta.get("contentSha256") or "",
        "date": meta.get("date") or _now_iso(),
        "title": meta.get("title") or "",
        "words": int(meta.get("words") or 0),
        "ots": ots_name,
        "status": "pending",          # pending -> confirmed (block known) -> verified (header checked)
        "submitted": _now_iso(),
        "calendars": calendars,
        "block": None,
        "blockHash": None,
        "blockTime": None,
        "verified": False,
    }
    m["versions"] = [v for v in m["versions"] if v.get("n") != n] + [entry]
    m["versions"].sort(key=lambda v: v.get("n", 0))
    if meta.get("title"):
        m["title"] = meta["title"]
    save_manifest(slug, m)
    return entry


# ---------------------------------------------------------------------------
# upgrade + verify
# ---------------------------------------------------------------------------

def _walk(ts):
    yield ts
    for sub in ts.ops.values():
        yield from _walk(sub)


def upgrade_timestamp(file_ts):
    """Ask each calendar for the completed proof of every pending commitment. Returns
    True if anything was merged in. (Same algorithm as `ots upgrade`.)"""
    upgraded = False
    for sub in list(_walk(file_ts.timestamp)):
        for att in list(sub.attestations):
            if not isinstance(att, PendingAttestation):
                continue
            try:
                done = RemoteCalendar(att.uri).get_timestamp(sub.msg, timeout=HTTP_TIMEOUT)
            except Exception:
                continue  # still pending at this calendar (404) or it's unreachable
            sub.merge(done)
            if any(isinstance(a, BitcoinBlockHeaderAttestation) for _m, a in done.all_attestations()):
                sub.attestations.discard(att)   # completed: the pending stub is now redundant
            upgraded = True
    return upgraded


def bitcoin_attestations(file_ts):
    """[(height, merkle_root_hex_display)] carried by the proof."""
    out = []
    for msg, att in file_ts.timestamp.all_attestations():
        if isinstance(att, BitcoinBlockHeaderAttestation):
            out.append((att.height, msg[::-1].hex()))
    return sorted(set(out))


def _http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ahilanks-provenance/1.0"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return r.read().decode("utf-8")


def fetch_block(height):
    """Header facts for a block height from the first explorer that answers:
    {hash, merkle_root, time, source}."""
    errors = []
    for base in EXPLORERS:
        try:
            block_hash = _http_get(f"{base}/block-height/{height}").strip()
            info = json.loads(_http_get(f"{base}/block/{block_hash}"))
            return {
                "hash": block_hash,
                "merkle_root": info["merkle_root"],
                "time": int(info["timestamp"]),
                "source": base,
            }
        except Exception as e:
            errors.append(f"{base}: {e}")
    raise RuntimeError("no block explorer reachable: " + "; ".join(errors))


def refresh_version(slug, entry, force_verify=False):
    """Upgrade (if pending) and verify (if confirmed but unverified) one manifest entry
    in place. Returns True if the entry changed."""
    ots_path = os.path.join(proof_dir(slug), entry.get("ots") or "")
    if not os.path.isfile(ots_path):
        return False
    with open(ots_path, "rb") as f:
        raw = f.read()
    file_ts = _deser(raw)
    changed = False

    if entry.get("status") == "pending":
        if upgrade_timestamp(file_ts):
            with open(ots_path, "wb") as f:
                f.write(_ser(file_ts))
            changed = True

    atts = bitcoin_attestations(file_ts)
    if atts and entry.get("status") == "pending":
        entry["status"] = "confirmed"
        entry["block"] = atts[0][0]
        entry["confirmed"] = _now_iso()
        changed = True

    if atts and (not entry.get("verified") or force_verify):
        height, root = atts[0]
        try:
            blk = fetch_block(height)
        except Exception as e:
            entry["verifyError"] = str(e)[:200]
            return changed or True
        entry.pop("verifyError", None)
        if blk["merkle_root"].lower() == root.lower():
            entry.update(status="verified", verified=True, block=height,
                         blockHash=blk["hash"], blockTime=blk["time"],
                         verifiedVia=blk["source"], verifiedAt=_now_iso())
        else:
            entry.update(status="invalid", verified=False, block=height,
                         blockHash=blk["hash"], blockTime=blk["time"],
                         verifyError="merkle root in proof does not match the block header")
        changed = True
    return changed


def upgrade_all(force_verify=False, log=None):
    """Refresh every version of every article. Returns {slug: [entries that changed]}."""
    log = log or (lambda *_a: None)
    result = {}
    for slug in list_slugs():
        m = load_manifest(slug)
        touched = []
        for entry in m["versions"]:
            needs = entry.get("status") == "pending" or not entry.get("verified") or force_verify
            if not needs:
                continue
            try:
                if refresh_version(slug, entry, force_verify=force_verify):
                    touched.append(entry)
                    log(f"[proofs] {slug} v{entry['n']}: {entry['status']}"
                        + (f" (block {entry['block']})" if entry.get('block') else ""))
            except Exception as e:
                log(f"[proofs] {slug} v{entry.get('n')}: refresh failed: {e}")
        if touched:
            save_manifest(slug, m)
            result[slug] = touched
    return result


def pending_count():
    n = 0
    for slug in list_slugs():
        for v in load_manifest(slug)["versions"]:
            if v.get("status") == "pending" or not v.get("verified"):
                n += 1
    return n


def status_lines():
    lines = []
    for slug in list_slugs():
        for v in load_manifest(slug)["versions"]:
            blk = f"block {v['block']}" if v.get("block") else "no block yet"
            when = (datetime.fromtimestamp(v["blockTime"], timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                    if v.get("blockTime") else "-")
            lines.append(f"{slug} v{v['n']}  {v['status']:9s}  {blk:14s}  {when}  sha256 {v['sha256'][:16]}…")
    return lines


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "upgrade":
        upgrade_all(log=print)
        print("\n".join(status_lines()) or "no proofs yet")
    elif cmd == "verify":
        slug = sys.argv[2] if len(sys.argv) > 2 else None
        for s in ([slug] if slug else list_slugs()):
            m = load_manifest(s)
            for entry in m["versions"]:
                refresh_version(s, entry, force_verify=True)
            save_manifest(s, m)
        print("\n".join(status_lines()) or "no proofs yet")
    else:
        print("\n".join(status_lines()) or "no proofs yet")
