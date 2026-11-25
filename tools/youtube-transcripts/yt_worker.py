"""NOU's YouTube transcript worker. NOU starts it as a subprocess.

  python yt_worker.py --check          prints what is installed, as one JSON line
  python yt_worker.py                  reads one JSON job from stdin, then runs it; a later line "cancel" stops it

Everything it says on stdout is one JSON object per line. Library chatter goes to stderr, so it cannot corrupt that stream.
It never writes into NOU: NOU receives each finished video and stores it through its own commands.
"""
import importlib.util
import json
import os
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import yt_core as core

OUT = sys.stdout
sys.stdout = sys.stderr  # anything a library prints must not reach the protocol stream

MODULES = {"youtube_transcript_api": "youtube-transcript-api", "yt_dlp": "yt-dlp", "faster_whisper": "faster-whisper"}
MODELS = ["tiny", "base", "small", "medium", "large-v3"]
PARAGRAPH_CHARS = 900
PARAGRAPH_SECONDS = 60


class Cancelled(BaseException):
    """Not an Exception on purpose: the fallbacks that catch "any error" must not swallow a cancel."""


def say(kind, **data):
    OUT.write(json.dumps({"type": kind, **data}, ensure_ascii=False) + "\n")
    OUT.flush()


def log(text):
    say("log", text=text)


def check_environment():
    from importlib.metadata import PackageNotFoundError, version

    found = {}
    for module, package in MODULES.items():
        if importlib.util.find_spec(module) is None:
            found[package] = None
        else:
            try:
                found[package] = version(package)
            except PackageNotFoundError:
                found[package] = "installed"
    return {
        "python": sys.executable,
        "version": "%d.%d.%d" % sys.version_info[:3],
        "packages": found,
        "missing": [p for p, v in found.items() if v is None],
        # Neither is needed to get a transcript: audio is decoded by faster-whisper itself. Reported so the owner knows.
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "javascript": "deno" if shutil.which("deno") else "node" if shutil.which("node") else None,
    }


def clock(seconds):
    t = int(seconds)
    return f"[{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}]"


def paragraphs(segs, timestamps):
    """The transcript as readable blocks: broken after a sentence once long enough, after a pause, or (with timestamps) every minute."""
    out, words, start, end = [], [], None, 0.0

    def flush():
        if words:
            text = " ".join(words)
            out.append(f"{clock(start)} {text}" if timestamps else text)
        words.clear()

    for s in segs:
        text = s.text.strip()
        if not text:
            continue
        long_pause = words and s.start - end > 4
        too_long = words and (sum(len(w) + 1 for w in words) + len(text) > PARAGRAPH_CHARS * 2 or (timestamps and s.start - start >= PARAGRAPH_SECONDS))
        if long_pause or too_long:
            flush()
        if not words:
            start = s.start
        words.append(text)
        end = s.start + s.duration
        if sum(len(w) + 1 for w in words) >= PARAGRAPH_CHARS and re.search(r"[.!?。！？]$", text):
            flush()
    flush()
    return out


def video_info(video_id):
    """Title and length in one request; the title falls back to the app's own get_title."""
    try:
        import yt_dlp

        with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "ignore_no_formats_error": True, **core.EXTRA, **core.COOKIES}) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        return info.get("title") or video_id, info.get("duration")
    except Exception:
        return core.get_title(video_id), None


def collect_ids(targets, cancelled):
    ids = []
    for t in targets:
        cancelled()
        if "playlist?list=" in t or "/@" in t or "/channel/" in t:
            log(f"Expanding playlist/channel: {t}")
            try:
                found = [i for i in core.expand_playlist(t) if core.ID_RE.match(i)]
                if not found and ("/@" in t or "/channel/" in t):
                    # A channel's front page lists its tabs, not its videos.
                    found = [i for i in core.expand_playlist(t.rstrip("/") + "/videos") if core.ID_RE.match(i)]
                if not found:
                    log(f"! No videos found in {t}")
                else:
                    log(f"  {len(found)} video(s).")
                ids += found
            except Exception as e:
                log(f"! Could not expand {t}: {type(e).__name__}: {e}")
        else:
            vid = core.extract_video_id(t)
            if vid:
                ids.append(vid)
            else:
                log(f"! Could not parse: {t}")
    return list(dict.fromkeys(ids))


def run(job, cancel):
    def cancelled():
        if cancel.is_set():
            raise Cancelled()

    options = job.get("options", {})
    core.COOKIES.clear()
    core.COOKIES.update(core.cookie_opts(options.get("cookieBrowser"), options.get("cookieFile")))
    core.EXTRA.clear()
    core.EXTRA["progress_hooks"] = [lambda _progress: cancelled()]
    # Newer yt-dlp needs a JavaScript runtime for YouTube and only looks for deno unless told about others.
    if not shutil.which("deno") and shutil.which("node"):
        core.EXTRA["js_runtimes"] = {"node": {}}
    if core.COOKIES:
        log(f"Using YouTube cookies from: {options.get('cookieFile') or options.get('cookieBrowser')}")
    elif options.get("cookieFile"):
        log("! The cookies.txt file was not found; carrying on without cookies.")

    langs = [x.strip() for x in str(options.get("langs") or "").split(",") if x.strip()] or ["en"]
    model = options.get("model") if options.get("model") in MODELS else "small"
    device = options.get("device") if options.get("device") in ("auto", "cuda", "cpu") else "auto"
    timestamps = bool(options.get("timestamps"))
    force, fallback = bool(options.get("forceWhisper")), options.get("whisperFallback", True) is not False
    save_to = Path(options["outDir"]) if options.get("saveFiles") and options.get("outDir") else None
    fmt = options.get("format") if options.get("format") in ("txt", "srt", "json") else "txt"
    skip = set(job.get("skip") or [])
    counts = {"ok": 0, "failed": 0, "skipped": 0}
    total, was_cancelled = 0, False
    whisper = core.WhisperRunner(log, cancelled)

    try:
        ids = collect_ids([str(t).strip() for t in job.get("targets", []) if str(t).strip()], cancelled)
        total = len(ids)
        say("progress", done=0, total=total)
        for n, vid in enumerate(ids, 1):
            cancelled()
            log(f"[{n}/{total}] {vid}")
            if vid in skip:
                log("  Already saved; skipping.")
                counts["skipped"] += 1
                say("progress", done=n, total=total)
                continue
            try:
                segs, method = None, "Captions"
                if not force:
                    try:
                        segs = core.fetch_captions(vid, langs)
                        log("  Got YouTube captions.")
                    except Exception as e:
                        log(f"  Caption API failed ({type(e).__name__}); trying yt-dlp...")
                        cancelled()
                        try:
                            segs = core.fetch_captions_ytdlp(vid, langs)
                            log("  Got captions via yt-dlp.")
                        except Exception as e2:
                            log(f"  No captions ({type(e2).__name__}: {str(e2)[:200]}).")
                cancelled()
                if segs is None:
                    if not (fallback or force):
                        raise RuntimeError("No captions and Whisper is disabled")
                    segs = whisper.transcribe(vid, model, device)
                    cancelled()  # with no speech there are no segments to notice a cancel between
                    method = "Whisper"
                    if not segs:
                        raise RuntimeError("Whisper found no speech")
                title, duration = video_info(vid)
                minutes = round((duration or max((s.start + s.duration for s in segs), default=0)) / 60, 1)
                cancelled()
                if save_to:
                    try:
                        save_to.mkdir(parents=True, exist_ok=True)
                        path = save_to / f"{core.safe_name(title)} [{vid}].{fmt}"
                        path.write_text(core.render(segs, fmt, timestamps), encoding="utf-8")
                        log(f"  Saved file: {path}")
                    except OSError as e:
                        log(f"! Could not save the file: {type(e).__name__}: {e}")
                say("video", id=vid, title=title, url=f"https://www.youtube.com/watch?v={vid}", method=method, minutes=minutes, paragraphs=paragraphs(segs, timestamps))
                counts["ok"] += 1
            except Exception as e:
                log(f"  ✗ Failed: {type(e).__name__}: {str(e)[:400]}")
                counts["failed"] += 1
            say("progress", done=n, total=total)
    except Cancelled:
        was_cancelled = True
        log("Cancelled.")
    except Exception as e:
        log(f"Unexpected error: {type(e).__name__}: {e}")
        counts["failed"] += 1
    say("done", total=total, cancelled=was_cancelled, whisperLoads=whisper.loads, **counts)


def read_job():
    """The first line of stdin, read straight from the file descriptor so nothing is left in a buffer."""
    data = b""
    while not data.endswith(b"\n"):
        piece = os.read(0, 1)
        if not piece:
            break
        data += piece
    return data.decode("utf-8")


def listen(cancel):
    """Set `cancel` when NOU writes "cancel" or goes away.

    On Windows this must not sit in a blocking read: a read left waiting on stdin deadlocks the loading of the speech libraries
    (they ask about the standard handles while loading). So the pipe is looked at a few times a second instead.
    """
    peek = None
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        handle = wintypes.HANDLE(msvcrt.get_osfhandle(0))

        def peek():
            waiting = wintypes.DWORD()
            if not ctypes.windll.kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(waiting), None):
                return None  # the pipe is closed
            return waiting.value
    else:
        import select

        def peek():
            return 4096 if select.select([0], [], [], 0)[0] else 0

    data = b""
    while True:
        waiting = peek()
        if waiting is None:
            break
        if waiting:
            piece = os.read(0, waiting)
            if not piece:
                break
            data += piece
            if b"cancel" in data.split():
                break
        else:
            time.sleep(0.2)
    cancel.set()


def main():
    if hasattr(OUT, "reconfigure"):
        OUT.reconfigure(encoding="utf-8")
    if "--check" in sys.argv:
        say("check", **check_environment())
        return 0
    try:
        job = json.loads(read_job())
    except ValueError:
        say("log", text="The job could not be read.")
        return 2
    missing = check_environment()["missing"]
    if missing:
        say("log", text="Missing Python packages: " + ", ".join(missing))
        say("done", total=0, ok=0, failed=1, skipped=0, cancelled=False, whisperLoads=0)
        return 3
    cancel = threading.Event()

    threading.Thread(target=listen, args=(cancel,), daemon=True).start()
    run(job, cancel)
    OUT.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
