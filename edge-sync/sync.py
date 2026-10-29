#!/usr/bin/env python3
"""AgriVision edge-sync: pushes new CSV rows and snapshots from the Jetson to the web app.

Runs beside shf-core and never modifies it or its output.

  * Resolves the results dir exactly like the legacy _resolve_results_root():
    env AGRIVISION_RESULTS_DIR -> config.json "results_dir" -> ~/Desktop/Results
  * Tails each grain_*_rolling10s*.csv by remembering a byte offset (only complete lines are sent).
    Stores a SHA-256 hash of the bytes from file start through the end of the first DATA record
    (stored once that record exists) to detect a replaced CSV (even if the header is identical and the new file is larger).
  * Requires Python >= 3.8 (checked at startup; uses logging.basicConfig(force=True)).
  * POST /api/ingest/rows (idempotent), advancing offset and records_sent together per chunk,
    then uploads new snapshot JPGs + a 480 px thumbnail via signed URLs.
  * Offline or per-file error? Isolates errors and tracks exponential retry backoff per file/image
    (`next_retry_at` in state) so one failing CSV or snapshot never delays healthy files; the main loop
    always keeps the normal poll interval.
  * Logs every response: skipped rows (count, reasons, first record numbers) and the server's weight_warning.

Environment:
  AGRIVISION_API_URL        required, must be https:// (http:// allowed only for localhost/127.0.0.1/::1)
  AGRIVISION_DEVICE_KEY     required (pnpm create-device <name>)
  AGRIVISION_RESULTS_DIR    optional, see above
  AGRIVISION_CONFIG         optional path to config.json (default: next to this script, its parent, then cwd)
  AGRIVISION_SYNC_STATE     state file (default ~/.agrivision-sync/state.json)
  AGRIVISION_SYNC_INTERVAL_S  poll interval, default 5
  AGRIVISION_MAX_AGE_DAYS   ignore CSVs not modified within N days (default 7, 0 = all)
  AGRIVISION_SYNC_LOG       optional rotating log file

Usage: python sync.py [--once] [--dry-run]
"""
from __future__ import annotations

import csv
import fnmatch
import hashlib
import io
import json
import logging
import logging.handlers
import os
import random
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MIN_PYTHON = (3, 8)


def check_python_version(version_info: tuple[int, ...] = sys.version_info[:3]) -> None:
    """Require Python >= 3.8 (needed for logging.basicConfig(force=True) and typing features)."""
    if version_info[:2] < MIN_PYTHON:
        raise SystemExit(
            f"edge-sync requires Python >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]} "
            f"(running {version_info[0]}.{version_info[1]}); logging.basicConfig(force=True) requires 3.8+"
        )


check_python_version()

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Image = None

log = logging.getLogger("edge-sync")

CSV_PATTERN = "grain_*_rolling10s*.csv"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
MAX_ROWS_PER_REQUEST = 500
SIGN_BATCH = 50
THUMB_WIDTH = 480
MIN_FILE_AGE_S = 2.0          # don't upload an image that is still being written
MAX_SCAN_DEPTH = 5
SKIP_DIRS = {"env", "venv", ".venv", "__pycache__", "node_modules", ".git", ".svn", ".hg",
             "site-packages", "dist-packages", "dist", "build", ".tox", ".mypy_cache"}
WEIGHT_REMINDER_S = 600
PERMANENT_REJECT_CODES = {400, 413, 422}
AUTH_ERROR_CODES = {401, 403}
DEFAULT_AUTH_COOLDOWN_S = 900.0  # 15 min cooldown on 401/403 so revoked/bad keys never retry hot
MAX_BACKOFF_S = 300.0            # 5 min cap for network outages lasting hours
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


# ---------- configuration ----------
def resolve_results_root(script_dir: Path | None = None) -> str:
    """Mirror of legacy _resolve_results_root(): env -> config.json results_dir -> ~/Desktop/Results."""
    env_val = os.environ.get("AGRIVISION_RESULTS_DIR", "").strip()
    if env_val:
        return env_val
    here = script_dir or Path(__file__).resolve().parent
    candidates = [os.environ.get("AGRIVISION_CONFIG", "").strip()] if os.environ.get("AGRIVISION_CONFIG") else []
    candidates += [str(here / "config.json"), str(here.parent / "config.json"), str(Path.cwd() / "config.json")]
    for cfg_path in candidates:
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg_val = str(json.load(f).get("results_dir", "")).strip()
            if cfg_val:
                return cfg_val
        except Exception:
            continue
    return os.path.join(os.path.expanduser("~"), "Desktop", "Results")


def is_allowed_api_url(url: str) -> bool:
    """Require https://, except http:// on loopback (localhost / 127.0.0.1 / ::1)."""
    p = urllib.parse.urlparse(url)
    host = (p.hostname or "").lower()
    if not host:
        return False
    if p.scheme == "https":
        return True
    if p.scheme == "http" and host in LOCAL_HOSTS:
        return True
    return False


class Config:
    def __init__(self) -> None:
        self.api_url = os.environ.get("AGRIVISION_API_URL", "").strip().rstrip("/")
        self.key = os.environ.get("AGRIVISION_DEVICE_KEY", "").strip()
        self.root = resolve_results_root()
        self.state_path = Path(os.environ.get("AGRIVISION_SYNC_STATE") or Path.home() / ".agrivision-sync" / "state.json")
        self.interval = float(os.environ.get("AGRIVISION_SYNC_INTERVAL_S", "5"))
        self.max_age_days = float(os.environ.get("AGRIVISION_MAX_AGE_DAYS", "7"))
        self.auth_cooldown_s = float(os.environ.get("AGRIVISION_AUTH_COOLDOWN_S", str(DEFAULT_AUTH_COOLDOWN_S)))
        self.timeout = 30.0
        self.dry_run = False

    def validate(self) -> None:
        if not self.api_url or not self.key:
            raise SystemExit("AGRIVISION_API_URL and AGRIVISION_DEVICE_KEY must be set")
        if not is_allowed_api_url(self.api_url):
            raise SystemExit(
                f"AGRIVISION_API_URL must use https:// (got {self.api_url!r}); http:// is only allowed for localhost"
            )
        if any(ord(ch) < 32 for ch in self.root):
            raise SystemExit(
                f"AGRIVISION_RESULTS_DIR contains control characters ({self.root!r}) — likely unescaped Windows "
                "backslashes such as \\t (tab) or \\a (bell) in C:\\tmp\\agv-test. "
                "Use forward slashes (e.g. C:/tmp/agv-test) or double backslashes (C:\\\\tmp\\\\agv-test)."
            )


# ---------- state ----------
def _backup_state_path(path: Path) -> Path:
    return path.with_name(path.name + ".bak")


def load_state(path: Path) -> dict:
    for candidate, is_backup in ((path, False), (_backup_state_path(path), True)):
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                st = json.load(f)
            if not isinstance(st, dict):
                raise ValueError("state root must be a JSON object")
            st.setdefault("files", {})
            if is_backup:
                log.warning("recovered state from backup %s after primary %s was unreadable", candidate, path)
            return st
        except FileNotFoundError:
            continue
        except Exception as exc:
            log.error(
                "state file %s unreadable (%s)%s",
                candidate,
                exc,
                "; trying backup" if not is_backup else "; starting fresh (server upserts make re-sending safe)",
            )
    return {"files": {}}


def save_state(path: Path, state: dict) -> bool:
    """Atomically persist state.json via state.json.tmp + backup state.json.bak.
    If the disk is full (ENOSPC / OSError), logs a clear error, cleans up .tmp, and keeps
    the existing state.json and in-memory state intact without crashing the daemon.
    """
    tmp = path.with_name(path.name + ".tmp")
    bak = _backup_state_path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(state)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        if path.exists():
            try:
                with open(path, "rb") as src_f:
                    prev_bytes = src_f.read()
                if prev_bytes:
                    with open(bak, "wb") as bak_f:
                        bak_f.write(prev_bytes)
            except OSError:
                pass
        os.replace(tmp, path)
        return True
    except OSError as exc:
        log.error(
            "DISK / FS ERROR saving state to %s (%s) — check free disk space (df -h). "
            "In-memory state and local CSV/snapshot files remain intact.",
            path,
            exc,
        )
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        return False


# ---------- HTTP ----------
class HttpError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body

    @property
    def retryable(self) -> bool:
        return self.status in (401, 403, 408, 429) or self.status >= 500


class NetworkError(Exception):
    pass


def http_json(cfg: Config, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        cfg.api_url + path,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg.key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, e.read().decode("utf-8", "replace")) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise NetworkError(str(e)) from None


def http_put(url: str, data: bytes, content_type: str, timeout: float) -> None:
    req = urllib.request.Request(url, data=data, method="PUT",
                                 headers={"Content-Type": content_type, "x-upsert": "true"})
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            return
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, e.read().decode("utf-8", "replace")) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise NetworkError(str(e)) from None


# ---------- response logging ----------
def log_ingest_response(name: str, resp: dict, fstate: dict) -> None:
    log.info("%s: received=%s accepted=%s skipped=%s duplicates=%s batch=%s",
             name, resp.get("received"), resp.get("accepted"), resp.get("skipped"),
             resp.get("duplicates_in_request"), resp.get("batch_id"))
    if resp.get("skipped"):
        samples = " ".join(f"#{s['record']}({s['reason']})" for s in resp.get("skipped_samples", []))
        log.warning("%s: SKIPPED %s row(s) by the server: reasons=%s; first records: %s",
                    name, resp["skipped"], resp.get("skip_reasons"), samples)
    weight = resp.get("weight") or {}
    warn = bool(weight.get("weight_warning"))
    now = time.time()
    # Log on every transition and re-log periodically; not on every 5 s poll.
    if warn and (not fstate.get("weight_warning") or now - fstate.get("weight_logged_at", 0) > WEIGHT_REMINDER_S):
        for w in resp.get("warnings", []) or [weight.get("message")]:
            if w:
                log.warning("%s: %s", name, w)
        fstate["weight_logged_at"] = now
    elif not warn and fstate.get("weight_warning"):
        log.info("%s: weight warning cleared", name)
    fstate["weight_warning"] = warn


# ---------- CSV tailing ----------
def _parse_csv_records_with_offsets(chunk: bytes, base_offset: int, strip_bom: bool) -> list[tuple[list[str], int]]:
    """Parse newline-terminated CSV bytes into (fields, end_byte_offset_in_file) per non-empty record."""
    if strip_bom and chunk.startswith(b"\xef\xbb\xbf"):
        base_offset += 3
        chunk = chunk[3:]

    records: list[tuple[list[str], int]] = []
    pos = 0
    buf = b""
    in_quotes = False
    n = len(chunk)
    while pos < n:
        nl = chunk.find(b"\n", pos)
        if nl < 0:
            break
        line = chunk[pos:nl + 1]
        pos = nl + 1
        buf += line
        # Count unescaped double quotes to handle embedded newlines inside quoted CSV fields
        in_quotes = (buf.count(b'"') % 2) == 1
        if not in_quotes:
            text = buf.decode("utf-8", errors="replace")
            parsed = [r for r in csv.reader(io.StringIO(text, newline="")) if r]
            for r in parsed:
                records.append((r, base_offset + pos))
            buf = b""
    return records


def _first_record_hash(path: Path) -> str | None:
    """SHA-256 hex of the raw bytes from file start (0) through the end of the first DATA record
    (i.e. header line + first complete data record). Returns None if the first data record does not exist yet.
    Because the CSV header is identical across files, hashing through the first data record detects
    a replaced file even when the header is unchanged and the new file is larger.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
    except OSError:
        return None
    cut = head.rfind(b"\n")
    if cut < 0:
        return None
    recs = _parse_csv_records_with_offsets(head[:cut + 1], 0, strip_bom=True)
    if len(recs) < 2:
        return None
    end_of_first_data = recs[1][1]
    return hashlib.sha256(head[:end_of_first_data]).hexdigest()


def read_new_records(path: Path, fstate: dict) -> tuple[list[str] | None, list[list[str]], int, list[int]]:
    """Return (header, new_records, new_offset, record_end_offsets).

    * Only complete (newline-terminated) lines are consumed.
    * Detects truncated files (size < offset) AND replaced files (SHA-256 of bytes from start through
      end of first data record changed, even if the header is identical and the new file is larger).
    * When offset == 0, always treats the first CSV row as the header even if fstate["header"] was already set.
    """
    size = path.stat().st_size
    offset = int(fstate.get("offset", 0))
    cur_first_rec_hash = _first_record_hash(path)
    prev_first_rec_hash = fstate.get("first_record_hash")

    if size < offset:
        log.warning("%s shrank (%d < %d); re-reading from the start", path.name, size, offset)
        fstate.update(offset=0, header=None, records_sent=0, first_record_hash=cur_first_rec_hash)
        offset = 0
    elif offset > 0 and prev_first_rec_hash and cur_first_rec_hash != prev_first_rec_hash:
        log.warning("%s first data record changed (file replaced); re-reading from the start", path.name)
        fstate.update(offset=0, header=None, records_sent=0, first_record_hash=cur_first_rec_hash)
        offset = 0

    with open(path, "rb") as f:
        f.seek(offset)
        raw = f.read()
    cut = raw.rfind(b"\n")
    if cut < 0:
        return fstate.get("header"), [], offset, []

    if cur_first_rec_hash:
        fstate["first_record_hash"] = cur_first_rec_hash

    chunk = raw[:cut + 1]
    parsed = _parse_csv_records_with_offsets(chunk, offset, strip_bom=(offset == 0))
    header = fstate.get("header")
    if offset == 0:
        fstate["records_sent"] = 0
        if parsed:
            header = parsed[0][0]
            header_end = parsed[0][1]
            parsed = parsed[1:]
        else:
            header_end = offset + len(chunk)
        new_offset = parsed[-1][1] if parsed else header_end
    else:
        if header is None and parsed:
            header = parsed[0][0]
            parsed = parsed[1:]
        new_offset = parsed[-1][1] if parsed else (offset + len(chunk))

    rows = [r for r, _ in parsed]
    end_offsets = [off for _, off in parsed]
    return header, rows, new_offset, end_offsets


def post_rows(cfg: Config, source_name: str, header: list[str], rows: list[list[str]], first_record: int) -> dict:
    return http_json(cfg, "/api/ingest/rows", {
        "source_name": source_name, "columns": header, "rows": rows, "first_record": first_record,
    })


def reject_locally(cfg: Config, source_name: str, first_record: int, rows: list[list[str]], err: HttpError) -> None:
    path = cfg.state_path.with_name("rejected.jsonl")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.time(), "source": source_name, "first_record": first_record,
                                "status": err.status, "body": err.body[:500], "rows": rows}, ensure_ascii=False) + "\n")
    except OSError as fs_exc:
        log.error("%s: could not write rejected.jsonl (%s — check disk space); continuing", source_name, fs_exc)
    log.error("%s: server permanently rejected %d row(s) starting at record #%d (%s). Saved to %s and moving on.",
              source_name, len(rows), first_record, err, path)


def compute_backoff_delay(interval: float, failures: int) -> float:
    return min(MAX_BACKOFF_S, interval * (2 ** min(failures, 8))) * random.uniform(0.8, 1.2)


def _ensure_fstate(state: dict, path: Path) -> dict:
    fstate = state["files"].setdefault(str(path), {})
    fstate.setdefault("offset", 0)
    fstate.setdefault("header", None)
    fstate.setdefault("records_sent", 0)
    fstate.setdefault("first_record_hash", None)
    fstate.setdefault("failures", 0)
    fstate.setdefault("next_retry_at", 0.0)
    fstate.setdefault("snapshots_done", [])
    fstate.setdefault("snapshots_rejected", [])
    fstate.setdefault("snapshot_backoff", {})
    return fstate


def sync_csv(cfg: Config, state: dict, path: Path) -> None:
    fstate = _ensure_fstate(state, path)
    header, rows, new_offset, end_offsets = read_new_records(path, fstate)
    if header is not None:
        fstate["header"] = header
    if not rows:
        if new_offset != fstate["offset"]:  # header-only progress
            fstate["offset"] = new_offset
            save_state(cfg.state_path, state)
        return
    assert header is not None
    sent = int(fstate.get("records_sent", 0))
    total = len(rows)
    for i in range(0, total, MAX_ROWS_PER_REQUEST):
        chunk = rows[i:i + MAX_ROWS_PER_REQUEST]
        chunk_end_offset = end_offsets[i + len(chunk) - 1]
        first_record = sent + i + 1
        if cfg.dry_run:
            log.info("[dry-run] %s: would send %d row(s) from record #%d", path.name, len(chunk), first_record)
            continue
        try:
            resp = post_rows(cfg, path.name, header, chunk, first_record)
        except HttpError as e:
            if e.status in PERMANENT_REJECT_CODES:
                reject_locally(cfg, path.name, first_record, chunk, e)
            else:
                raise
        else:
            log_ingest_response(path.name, resp, fstate)
        # Advance both records_sent and offset together per chunk so a retry starts after the last accepted chunk
        fstate["records_sent"] = sent + i + len(chunk)
        fstate["offset"] = chunk_end_offset
        if fstate.get("failures") or fstate.get("next_retry_at"):
            log.info("%s: CSV sync recovered", path.name)
            fstate["failures"] = 0
            fstate["next_retry_at"] = 0.0
        save_state(cfg.state_path, state)


# ---------- snapshots ----------
def make_thumbnail(path: Path) -> bytes | None:
    if Image is None:
        return None
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            if im.width > THUMB_WIDTH:
                im = im.resize((THUMB_WIDTH, max(1, round(im.height * THUMB_WIDTH / im.width))))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80)
            return buf.getvalue()
    except Exception as exc:
        log.warning("thumbnail failed for %s: %s", path.name, exc)
        return None


def content_type_for(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower()
    return "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"


def sync_snapshots(cfg: Config, state: dict, csv_path: Path, now: float | None = None) -> int:
    snap_dir = csv_path.parent / "snapshots"
    if not snap_dir.is_dir():
        return 0
    fstate = _ensure_fstate(state, csv_path)
    done, rejected = set(fstate.setdefault("snapshots_done", [])), set(fstate.setdefault("snapshots_rejected", []))
    snap_backoff: dict[str, dict] = fstate.setdefault("snapshot_backoff", {})
    now = time.time() if now is None else now
    pending = sorted(
        p.name for p in snap_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and p.name not in done and p.name not in rejected
        and now - p.stat().st_mtime >= MIN_FILE_AGE_S
        and now >= float(snap_backoff.get(p.name, {}).get("next_retry_at") or 0.0)
    )
    if not pending:
        return 0
    use_thumbs = Image is not None
    if not use_thumbs:
        log.warning("Pillow not installed: uploading snapshots WITHOUT thumbnails (pip install Pillow)")

    transient_failures = 0
    for i in range(0, len(pending), SIGN_BATCH):
        names = pending[i:i + SIGN_BATCH]
        if cfg.dry_run:
            log.info("[dry-run] %s: would upload %d snapshot(s)", csv_path.name, len(names))
            continue
        resp = http_json(cfg, "/api/ingest/snapshots/sign", {
            "source_name": csv_path.name, "files": [{"filename": n} for n in names], "thumbs": use_thumbs,
        })
        if resp.get("skipped"):
            log.warning("%s: server REJECTED %s snapshot name(s): reasons=%s; %s", csv_path.name, resp["skipped"],
                        resp.get("skip_reasons"), [r["filename"] for r in resp.get("rejected", [])])
            rejected.update(r["filename"] for r in resp.get("rejected", []))
        uploaded_in_batch = 0
        for item in resp.get("signed", []):
            name = item["filename"]
            p = snap_dir / name
            try:
                data = p.read_bytes()
            except OSError as exc:
                log.warning("cannot read %s: %s", p, exc)
                continue
            try:
                http_put(item["image"]["signed_url"], data, content_type_for(name), cfg.timeout)
                if item.get("thumb"):
                    thumb = make_thumbnail(p)
                    if thumb is not None:
                        http_put(item["thumb"]["signed_url"], thumb, "image/jpeg", cfg.timeout)
            except HttpError as e:
                if e.status in PERMANENT_REJECT_CODES:
                    log.error("%s: snapshot %s permanently rejected during PUT (%s); adding to snapshots_rejected",
                              csv_path.name, name, e)
                    rejected.add(name)
                    snap_backoff.pop(name, None)
                    continue
                entry = snap_backoff.setdefault(name, {"failures": 0, "next_retry_at": 0.0})
                entry["failures"] = int(entry.get("failures") or 0) + 1
                delay = compute_backoff_delay(cfg.interval, entry["failures"])
                entry["next_retry_at"] = now + delay
                log.warning("%s: transient error uploading snapshot %s (%s); attempt %d, retrying in %.0fs",
                            csv_path.name, name, e, entry["failures"], delay)
                transient_failures += 1
                continue
            except NetworkError as e:
                entry = snap_backoff.setdefault(name, {"failures": 0, "next_retry_at": 0.0})
                entry["failures"] = int(entry.get("failures") or 0) + 1
                delay = compute_backoff_delay(cfg.interval, entry["failures"])
                entry["next_retry_at"] = now + delay
                log.warning("%s: network error uploading snapshot %s (%s); attempt %d, retrying in %.0fs",
                            csv_path.name, name, e, entry["failures"], delay)
                transient_failures += 1
                continue
            done.add(name)
            snap_backoff.pop(name, None)
            uploaded_in_batch += 1
        # Save state once per signing batch
        fstate["snapshots_done"] = sorted(done)
        fstate["snapshots_rejected"] = sorted(rejected)
        save_state(cfg.state_path, state)
        log.info("%s: uploaded %d snapshot(s)", csv_path.name, uploaded_in_batch)

    return transient_failures


# ---------- discovery + loop ----------
def find_csvs(root: str, max_age_days: float) -> list[Path]:
    out: list[Path] = []
    root_p = Path(root)
    if not root_p.is_dir():
        log.warning("results directory does not exist: %s (check AGRIVISION_RESULTS_DIR)", root)
        return out
    cutoff = time.time() - max_age_days * 86400 if max_age_days > 0 else 0
    skipped_old = 0
    for dirpath, dirnames, filenames in os.walk(root_p):
        depth = len(Path(dirpath).relative_to(root_p).parts)
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        if depth >= MAX_SCAN_DEPTH:
            dirnames.clear()
        for fn in fnmatch.filter(filenames, CSV_PATTERN):
            p = Path(dirpath) / fn
            try:
                if p.stat().st_mtime >= cutoff:
                    out.append(p)
                else:
                    skipped_old += 1
            except OSError:
                continue
    if not out and skipped_old:
        log.warning(
            "found %d CSV(s) matching %s in %s, but all are older than AGRIVISION_MAX_AGE_DAYS=%g "
            "(set AGRIVISION_MAX_AGE_DAYS=0 to sync older/fixture CSVs)",
            skipped_old,
            CSV_PATTERN,
            root,
            max_age_days,
        )
    return sorted(out, key=lambda p: p.stat().st_mtime)


def _record_file_backoff(cfg: Config, state: dict, fstate: dict, name: str, exc: Exception, now: float,
                         failures_key: str = "failures", retry_key: str = "next_retry_at") -> None:
    is_auth_err = isinstance(exc, HttpError) and exc.status in AUTH_ERROR_CODES
    if isinstance(exc, HttpError) and not exc.retryable:
        log.error("%s: non-retryable error, will retry later: %s", name, exc)
    failures = int(fstate.get(failures_key) or 0) + 1
    if is_auth_err:
        delay = max(cfg.auth_cooldown_s, compute_backoff_delay(cfg.interval, failures))
        state["auth_backoff_until"] = now + delay
    else:
        delay = compute_backoff_delay(cfg.interval, failures)
    fstate[failures_key] = failures
    fstate[retry_key] = now + delay
    save_state(cfg.state_path, state)
    if is_auth_err:
        log.error(
            "%s: AUTH ERROR (%s) — server rejected AGRIVISION_DEVICE_KEY (invalid or revoked). "
            "Stopping hot retries for %.0fs; local CSV and snapshot files are kept intact. "
            "Check AGRIVISION_DEVICE_KEY in /etc/agrivision-sync.env or issue a new device key in /settings.",
            name,
            exc,
            delay,
        )
    else:
        log.warning(
            "%s: sync failed (%s); attempt %d, retrying in %.0fs",
            name,
            exc,
            failures,
            delay,
        )


def run_pass(cfg: Config, state: dict, now: float | None = None) -> int:
    """One sync pass. Tracks retry backoff (`next_retry_at` in state) per file/image so one failing CSV or
    snapshot never delays healthy files, while the main loop keeps the normal poll interval.
    If the server returned 401/403 (`auth_backoff_until`), pauses all requests until the cooldown elapses.
    Returns the number of transient failures encountered during this pass."""
    now = time.time() if now is None else now
    auth_until = float(state.get("auth_backoff_until") or 0.0)
    if now < auth_until:
        return 1
    if auth_until:
        state.pop("auth_backoff_until", None)
    pass_failures = 0
    for csv_path in find_csvs(cfg.root, cfg.max_age_days):
        fstate = _ensure_fstate(state, csv_path)
        if now >= float(fstate.get("next_retry_at") or 0.0):
            try:
                sync_csv(cfg, state, csv_path)
            except (HttpError, NetworkError) as exc:
                _record_file_backoff(cfg, state, fstate, csv_path.name, exc, now)
                pass_failures += 1
                if isinstance(exc, HttpError) and exc.status in AUTH_ERROR_CODES:
                    break
        if now >= float(fstate.get("snapshots_next_retry_at") or 0.0):
            try:
                snap_failures = sync_snapshots(cfg, state, csv_path, now=now)
                pass_failures += snap_failures
                if fstate.get("snapshots_failures") or fstate.get("snapshots_next_retry_at"):
                    fstate["snapshots_failures"] = 0
                    fstate["snapshots_next_retry_at"] = 0.0
                    save_state(cfg.state_path, state)
            except (HttpError, NetworkError) as exc:
                _record_file_backoff(
                    cfg, state, fstate, f"{csv_path.name} (snapshots)", exc, now,
                    failures_key="snapshots_failures", retry_key="snapshots_next_retry_at",
                )
                pass_failures += 1
                if isinstance(exc, HttpError) and exc.status in AUTH_ERROR_CODES:
                    break
    return pass_failures


def configure_logging() -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if os.environ.get("AGRIVISION_SYNC_LOG"):
        handlers.append(logging.handlers.RotatingFileHandler(os.environ["AGRIVISION_SYNC_LOG"], maxBytes=2_000_000, backupCount=3))
    for h in handlers:
        h.setFormatter(fmt)
    logging.basicConfig(level=logging.INFO, handlers=handlers, force=True)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    configure_logging()
    cfg = Config()
    cfg.dry_run = "--dry-run" in argv
    cfg.validate()
    once = "--once" in argv
    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))
    log.info("edge-sync starting: root=%s api=%s state=%s", cfg.root, cfg.api_url, cfg.state_path)
    state = load_state(cfg.state_path)
    while not stop["flag"]:
        pass_failures = run_pass(cfg, state)
        if once:
            return 1 if pass_failures else 0
        end = time.time() + cfg.interval
        while time.time() < end and not stop["flag"]:
            time.sleep(0.25)
    log.info("edge-sync stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
