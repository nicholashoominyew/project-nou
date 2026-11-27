# Home: clocks, weather, countdowns, progress and calendar

Below the Daily page, Waiting for approval, Recently edited, Favorites and Worth revisiting, Home has five more sections. All can be moved or hidden from the gear.

- **Clocks:** two clocks. Click a city name to change its time zone (type to search the zone list, for example `Europe/London`; only real zones are accepted). They start as this computer's zone and Asia/Tokyo. Kept on this computer (`nou-clocks`).
- **Weather:** two places side by side. **Set location** searches a place name (OpenStreetMap Nominatim, the same search as database place fields, sent only when you press Enter or Search) and saves its name and coordinates. The forecast comes from Open-Meteo (`api.open-meteo.com`, no account). **Network:** only the rounded latitude and longitude are sent. It is asked once when Home opens with a place set, when you change a place, and when you press **Refresh**. Never on a timer. The reply is validated and shown as plain text. The connection is allowed in the app's content security policy (`tauri.conf.json`). Nothing is sent if no place is set. Places are kept in `nou-weather-places`.
- **Year, quarter, month and day:** four bars showing how far through each period you are, with the percentage and time left. They update twice a minute.
- **Countdowns:** add a name, a date and a unit (days, weeks or months). The bar fills from the day you added it (or the date, if you pick one before today) to the deadline, and the text shows the time left in the unit you chose (for example "2 weeks 3 days left", "3 months 15 days left"). The unit can be changed per countdown, and a finished one says how long ago. Up to 30, kept in `nou-countdowns`.
- **Calendar:** a Monday-first month grid. A day shows a dot when it has a daily page (a page titled like `2026-11-18`), a database row with a date property, or a countdown deadline. Click a day to list them; a daily page opens when clicked. It reads up to 20 databases when Home opens or the page list changes. Database rows are listed by name; opening a row from the calendar is not built.

## Files: gallery and preview
**Files** opens as a gallery (switch to the list with the toggle; the choice is remembered). Images show as pictures, loaded only when the tile scrolls into view; PDFs and other files show an icon. Click a file to preview it: images, PDFs (in a frame) and text files (txt, md, csv, json, html and similar, shown as plain text, never run) open in a window with Save a copy, the pages that use the file, and previous and next (arrow keys). Files over 25 MB, SVG images and unknown types are not previewed (you can still save a copy). Nothing here changes or deletes a file.

## Verified
- Vitest: date and time maths (zones, periods, countdown units, calendar grid), weather parsing and refusal of bad answers, the five Home sections (edit, remember, add, remove, search, month navigation, databases) and the gallery and preview (image, PDF frame, plain text, no preview, too large, keys).
- Not verified: how any of it looks in the real window, a real weather request, and a real PDF in the preview frame.

## Not built
Weather for more than two places, a forecast beyond today, units other than Celsius and km/h, repeating events, adding events from the calendar, opening a database row from the calendar, and PDF thumbnails.

## Elementel Home layout (NOU-ELEMENTEL-REDESIGN.md section 7)
Top to bottom: header (greeting, date and page count, daylight arc, New page, gear), the Daily page strip, a calendar column (Calendar, Teaching of the day) beside a column of Clocks, Today's tasks and Weather, then a row of Year/quarter/month/day rings, Countdowns and Waiting for approval, then a row of Recently edited, Favorites and Worth revisiting. The arrangement is fixed; the gear lets you hide and show sections (move up and down is gone). AI access is in the gear panel.

Where the brief's sample content has no real source in NOU, this is what the screen does instead:
- **Daylight arc:** drawn from the first weather place (sunrise and sunset are calculated on this computer, shown in that place's time zone). With no place set there is no arc.
- **Habit streak:** the Daily page strip counts days on which enough habits were ticked for 100% (see [HABITS.md](HABITS.md)). Today does not break it while still open, days on which no habit counts are skipped, and ticking a forgotten day repairs it. Daily pages no longer count.
- **Teaching of the day:** reads a database called Teachings (the title column or a Teaching/Text column, a Theme column, a Book/Source column). Five are picked per day. Without that database it explains how to make one.
- **Today's tasks:** the linked to-dos (open first), with a tick box and an add box. To-dos typed straight into a daily page are not read, and the chips for time and "from an assistant" are not shown because to-dos carry no such data.
- **Calendar shading:** by how many items a day has (daily page, database dates, countdown deadlines). Days after today are not shaded.
- **Recently edited bars:** pages last edited on each of the last 14 days. **Worth revisiting bar:** how long since the note was edited, against a year.
- **Waiting for approval:** the full request stays visible (field by field) before the Approve and apply button, because approving blind would defeat the gateway's rule; Reject is the outline button.
- **Clocks:** default to London and Kuala Lumpur (saved choices are kept). The seconds tick once a second inside this card only.
