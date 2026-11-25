# YouTube transcripts

Open the **YouTube Transcripts** page and press **Get transcripts**. Paste video, playlist or channel addresses, press **Extract**, and each video becomes a row in the database on that page. Everything runs on this PC; the only network traffic is to YouTube, plus the one-off download of a Whisper model.

## One-off setup (Windows)

The tool needs Python 3.10 or newer (3.12 recommended). The panel's **Something is missing** card shows the two exact commands for your profile. They have this shape:

```powershell
py -3.12 -m venv "<profile>\youtube\venv"
```

```powershell
& "<profile>\youtube\venv\Scripts\python.exe" -m pip install -r "<profile>\youtube\requirements.txt"
```

Press **Check again** afterwards.

- **Packages:** `tools/youtube-transcripts/requirements.txt`. `av` is held below 19 because faster-whisper 1.2.1 cannot open audio with PyAV 19.
- **ffmpeg:** not needed.
- **JavaScript runtime:** yt-dlp wants `deno` or `node` for YouTube. The card says which it found.
- **Whisper models:** not bundled. Downloaded on first use into the Hugging Face cache in your user folder.
- **GPU:** `auto` and `cuda` fall back to CPU, with a line in the log, if the GPU libraries are missing.

## What gets stored

One row per video: **Name** (title), **URL** (`https://www.youtube.com/watch?v=<id>`), **Method** (Captions or Whisper), **Minutes**, **Added**. The row's page holds the address, then the transcript in paragraphs (with timestamps if ticked).

- A video already in the database is skipped. **Re-extract** replaces that row's page and values.
- Each row is written as soon as its video finishes, so a failure or Cancel keeps the earlier ones.
- One failing video does not stop the batch; the log says why.
- Options are remembered on this device only. For a cookies file, only its path is stored.
- **Also save files** (off by default) writes `.txt`, `.srt` or `.json` to a folder.

## Bots

`nou_propose_extract_transcripts` (scope `databases:write`) takes `urls` (1 to 50, YouTube only) and optionally `languages`, `timestamps`, `always_whisper`, `model`, `reextract`. It waits for your approval like any other proposal and is never auto-approved. A bot cannot choose cookies, folders or which Python runs. After approval the job is queued; `nou_proposal_status` shows `applied`, and its result text changes to the outcome when the job ends.

The REST read used by bots caps page text at 100,000 characters, so a very long transcript reaches them truncated. NOU itself holds all of it.

## How it fits together

| Piece | File |
|---|---|
| Fetching and transcribing | `tools/youtube-transcripts/yt_core.py` |
| Job runner (JSON lines on stdout, job and `cancel` on stdin) | `tools/youtube-transcripts/yt_worker.py` |
| Starting, cancelling, temp folder | `apps/desktop/src-tauri/src/youtube.rs` |
| Database, row writing, job queue | `apps/desktop/src/youtube.ts` |
| Screen | `apps/desktop/src/YouTubePanel.tsx` |
| `transcripts_extract` proposal kind | `db/notes/019_transcript_requests.sql` |

The scripts are built into the app and written to `<profile>\youtube\` when used. On Windows the worker must not leave a blocking read waiting on stdin: it deadlocks the loading of the speech libraries, so the pipe is polled instead.

## Schema 19

One-way. Install the new build on every device before syncing between them.
