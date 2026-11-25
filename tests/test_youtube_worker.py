"""The YouTube transcript worker, with the downloading and speech parts stood in for. No packages beyond Python itself."""
import io
import json
import os
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

FOLDER = Path(__file__).resolve().parents[1] / "tools" / "youtube-transcripts"
sys.path.insert(0, str(FOLDER))
_stdout = sys.stdout
import yt_core as core  # noqa: E402
import yt_worker as worker  # noqa: E402

sys.stdout = _stdout  # the worker takes stdout for itself when imported

A, B, C = "aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"


def seg(text, start, duration=2.0):
    return core.Seg(start, duration, text)


def url(video_id):
    return f"https://www.youtube.com/watch?v={video_id}"


class RunTests(unittest.TestCase):
    def run_job(self, targets, captions, options=None, skip=(), cancel=None, on_video=None):
        out = io.StringIO()
        cancel = cancel or threading.Event()

        def fetch(video_id, _langs):
            result = captions[video_id]
            if isinstance(result, Exception):
                raise result
            if on_video:
                on_video(video_id)
            return result

        job = {"targets": targets, "skip": list(skip), "options": {"whisperFallback": False, **(options or {})}}
        with mock.patch.object(worker, "OUT", out), mock.patch.object(core, "fetch_captions", fetch), mock.patch.object(
            core, "fetch_captions_ytdlp", mock.Mock(side_effect=RuntimeError("No subtitle file available"))
        ), mock.patch.object(worker, "video_info", lambda i: (f"Title {i}", 90)):
            worker.run(job, cancel)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_one_failing_video_does_not_stop_the_batch(self):
        events = self.run_job([url(A), url(B), url(A), "not an address"], {A: ValueError("private"), B: [seg("Hello.", 0)]})
        done = events[-1]
        self.assertEqual((done["total"], done["ok"], done["failed"], done["cancelled"]), (2, 1, 1, False))
        video = next(e for e in events if e["type"] == "video")
        self.assertEqual((video["id"], video["url"], video["method"], video["minutes"]), (B, url(B), "Captions", 1.5))
        text = "\n".join(e.get("text", "") for e in events)
        self.assertIn("Could not parse: not an address", text)
        self.assertIn("No captions and Whisper is disabled", text)

    def test_saved_videos_are_skipped(self):
        events = self.run_job([url(A)], {}, skip=[A])
        self.assertEqual((events[-1]["skipped"], events[-1]["ok"]), (1, 0))
        self.assertTrue(any("Already saved; skipping." in e.get("text", "") for e in events))

    def test_cancel_keeps_the_videos_already_finished(self):
        cancel = threading.Event()
        events = self.run_job(
            [url(A), url(B), url(C)],
            {A: [seg("One.", 0)], B: [seg("Two.", 0)], C: [seg("Three.", 0)]},
            cancel=cancel,
            on_video=lambda i: cancel.set() if i == B else None,
        )
        self.assertEqual([e["id"] for e in events if e["type"] == "video"], [A])
        self.assertTrue(events[-1]["cancelled"])


class ParagraphTests(unittest.TestCase):
    def test_a_long_pause_starts_a_new_paragraph(self):
        self.assertEqual(worker.paragraphs([seg("one", 0), seg("two", 2), seg("three", 20)], False), ["one two", "three"])

    def test_timestamps_mark_each_minute(self):
        out = worker.paragraphs([seg("word", t) for t in range(0, 130, 2)], True)
        self.assertEqual([p.split(" ")[0] for p in out], ["[00:00:00]", "[00:01:00]", "[00:02:00]"])

    def test_nothing_in_gives_nothing_out(self):
        self.assertEqual(worker.paragraphs([seg("  ", 0)], False), [])


class ProtocolTests(unittest.TestCase):
    """The real process: a "cancel" line, or the pipe closing, must set the flag without a read left waiting on stdin."""

    SCRIPT = (
        "import sys, threading; sys.path.insert(0, sys.argv[1]); import yt_worker as w\n"
        "job = w.read_job().strip(); flag = threading.Event()\n"
        "threading.Thread(target=w.listen, args=(flag,), daemon=True).start()\n"
        "w.OUT.write(job + '\\n'); w.OUT.flush()\n"
        "w.OUT.write('cancelled\\n' if flag.wait(20) else 'timeout\\n')\n"
    )

    def listen(self, finish):
        process = subprocess.Popen([sys.executable, "-c", self.SCRIPT, str(FOLDER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ})
        process.stdin.write(b'{"targets": []}\n')
        process.stdin.flush()
        self.assertEqual(process.stdout.readline().strip(), b'{"targets": []}')
        finish(process)
        answer = process.stdout.readline().strip()
        process.wait(timeout=30)
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()
        return answer

    def test_a_cancel_line(self):
        def finish(process):
            process.stdin.write(b"cancel\n")
            process.stdin.flush()

        self.assertEqual(self.listen(finish), b"cancelled")

    def test_the_app_going_away(self):
        self.assertEqual(self.listen(lambda process: process.stdin.close()), b"cancelled")


if __name__ == "__main__":
    unittest.main()
