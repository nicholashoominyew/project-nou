# Resurfacing

A **Worth revisiting** card on Home that brings old notes back in front of you.

## What it shows
- **Written on this day**: notes you created on today's month and day in an earlier year ("Written a year ago today", "Written 3 years ago today"). Up to three.
- **Not edited for a while**: notes you have not touched for more than 30 days ("Not edited for 5 months"). Up to three, chosen by a stable shuffle that changes each day, so the same note does not nag you every day and every old note gets its turn. The list stays the same all day.
- **Not now** hides a note for 14 days. That is a preference kept on this computer only (it is not stored in your notes and is not backed up).
- The card can be hidden or moved like any Home card (Customize).

## What is never suggested
Pages in the trash, databases and database rows, password-locked notes, notes with almost no text (under 40 characters), and notes edited in the last 30 days.

## How it works
- `list_resurfaced_pages` (`home.rs`) takes today's local date from the app, so the answer is the same all day and is testable. Dates are compared in SQLite, and the daily shuffle is a SHA-256 of the date and page id, so no random numbers and no stored history are needed. It reads only; it never changes a note and adds no database table.
- `resurface.ts` has the snooze rules (reading stored values defensively, month-end arithmetic) and the wording; the widget is `ResurfaceWidget` in `Home.tsx`, added to the Home widget registry.

## Verified
- Rust: 5 tests (what is and is not eligible; the exact 30-day line; anniversaries by month and day, ordered first; stable within a day, different across days and respecting the limit; no repeats and bad dates refused).
- Vitest: 6 tests for the helpers and 5 for the widget (order and wording, opening a note, Not now and remembering it, empty and all-snoozed messages, the three-per-kind cap), and the Home layout tests now include the card.
- Not verified: how it looks and reads on the real Home page with real notes.

## Not built
Choosing the 30-day threshold, a "never show this note" option, spaced-repetition scheduling, a reminder or notification, and bringing back notes because they are related to what you are writing now.
