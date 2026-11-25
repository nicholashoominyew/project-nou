"""Core of the YouTube Transcript Extractor, taken from the standalone tkinter app (yt_transcript_app.py).

The GUI and the Notion push are gone: NOU writes the results into its own database. The functions are otherwise the same; the only
addition is `check`, a callable that raises to stop a long download or transcription when the owner presses Cancel.
The heavy libraries are imported inside the functions, so loading this file costs nothing.
"""
import json
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# yt-dlp options that let it reuse your logged-in YouTube session (avoids "not a bot" blocks)
COOKIES = {}
# yt-dlp options every call shares (set by the worker: JavaScript runtime, progress hook for Cancel).
EXTRA = {}


def cookie_opts(browser, cookie_file):
    if cookie_file and Path(cookie_file).is_file():
        return {"cookiefile": cookie_file}
    if browser and browser != "none":
        return {"cookiesfrombrowser": (browser,)}
    return {}


@dataclass
class Seg:
    start: float
    duration: float
    text: str


def extract_video_id(s: str):
    s = s.strip()
    if ID_RE.match(s):
        return s
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})", s)
    return m.group(1) if m else None


def expand_playlist(url: str):
    import yt_dlp

    opts = {"extract_flat": True, "quiet": True, "skip_download": True, **EXTRA, **COOKIES}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return [e["id"] for e in info.get("entries", []) if e and e.get("id")]


def get_title(video_id: str) -> str:
    try:
        import yt_dlp

        with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, **EXTRA, **COOKIES}) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        return info.get("title") or video_id
    except Exception:
        return video_id


def safe_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s).strip()[:100] or "video"


def fetch_captions(video_id: str, langs):
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    try:
        tr = api.fetch(video_id, languages=langs)
    except Exception:
        tr = None
        for t in api.list(video_id):
            if t.is_translatable and t.language_code not in langs:
                try:
                    tr = t.translate(langs[0]).fetch()
                    break
                except Exception:
                    pass
            tr = t.fetch()
            break
        if tr is None:
            raise RuntimeError("No captions available")
    return [Seg(s.start, s.duration, s.text.replace("\n", " ")) for s in tr]


def fetch_captions_ytdlp(video_id: str, langs):
    """Backup caption method: let yt-dlp download the subtitle file (uses cookies if set)."""
    import yt_dlp

    tmp = Path(tempfile.mkdtemp(prefix="yt_subs_"))
    try:
        opts = {
            "skip_download": True,
            "quiet": True,
            "noprogress": True,
            "writesubtitles": True,
            "writeautomaticsubtitles": True,
            "subtitleslangs": list(langs) + [l + ".*" for l in langs],
            "subtitlesformat": "json3",
            "outtmpl": str(tmp / "%(id)s.%(ext)s"),
            **EXTRA,
            **COOKIES,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        files = sorted(tmp.glob("*.json3"))
        if not files:
            raise RuntimeError("No subtitle file available")
        data = json.loads(files[0].read_text(encoding="utf-8"))
        segs = []
        for e in data.get("events", []):
            text = "".join(s.get("utf8", "") for s in e.get("segs", []) or []).replace("\n", " ").strip()
            if text:
                segs.append(Seg(e.get("tStartMs", 0) / 1000, e.get("dDurationMs", 0) / 1000, text))
        if not segs:
            raise RuntimeError("Subtitle file was empty")
        return segs
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def render(segs, fmt: str, timestamps: bool) -> str:
    if fmt == "json":
        return json.dumps(
            [{"start": round(s.start, 2), "duration": round(s.duration, 2), "text": s.text} for s in segs],
            indent=2,
            ensure_ascii=False,
        )
    if fmt == "srt":

        def ts(t):
            ms = int(round(t * 1000))
            return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d},{ms % 1000:03d}"

        return "\n".join(
            f"{i}\n{ts(s.start)} --> {ts(s.start + s.duration)}\n{s.text}\n" for i, s in enumerate(segs, 1)
        )
    if timestamps:
        out = []
        for s in segs:
            t = int(s.start)
            out.append(f"[{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}] {s.text}")
        return "\n".join(out)
    return "\n".join(s.text for s in segs)


class WhisperRunner:
    """Lazy-loads faster-whisper and keeps the model between videos."""

    def __init__(self, log, check=lambda: None):
        self.log = log
        self.check = check
        self.model = None
        self.key = None
        self.loads = 0

    def _load(self, name, device):
        from faster_whisper import WhisperModel

        self.log(f"Loading Whisper model '{name}' (device: {device}). First run downloads it...")
        try:
            self.model = WhisperModel(name, device=device, compute_type="auto")
        except Exception as e:
            self.log(f"  Could not use '{device}' ({e}); falling back to CPU.")
            self.model = WhisperModel(name, device="cpu", compute_type="int8")
        self.key = (name, device)
        self.loads += 1

    def _run(self, audio):
        gen, info = self.model.transcribe(str(audio), vad_filter=True)
        segs = []
        for s in gen:  # the work happens as the segments are read, so this is where Cancel is noticed
            self.check()
            segs.append(Seg(s.start, s.end - s.start, s.text.strip()))
        return segs, info

    def transcribe(self, video_id, name, device):
        import yt_dlp

        if self.key != (name, device):
            self._load(name, device)
        tmp = Path(tempfile.mkdtemp(prefix="yt_audio_"))
        try:
            self.log("  Downloading audio...")
            opts = {
                "format": "bestaudio/best",
                "outtmpl": str(tmp / "%(id)s.%(ext)s"),
                "quiet": True,
                "noprogress": True,
                **EXTRA,
                **COOKIES,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            audio = next(tmp.iterdir())
            self.log("  Transcribing with Whisper (language auto-detected)...")
            try:
                segs, info = self._run(audio)
            except RuntimeError as e:
                if "cuda" in str(e).lower() or "cublas" in str(e).lower() or "cudnn" in str(e).lower():
                    self.log("  GPU libraries missing; retrying on CPU...")
                    self._load(name, "cpu")
                    self.key = (name, device)  # keep the CPU model for the rest of the batch
                    segs, info = self._run(audio)
                else:
                    raise
            self.log(f"  Detected language: {info.language}")
            return segs
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
