# Study Timer + Music

A copy of `../study-timer` that can spend game time on **music from your own files**
instead of the game countdown. The original folder is untouched; delete this folder to roll back.

Stopwatches for each class, a GitHub-style streak grid, a screen-time-style report,
and game time you earn by studying (5 minutes of study = 1 minute of game time).

Plain HTML/CSS/JavaScript. Nothing to install and nothing to run.

## Open it

Double-click `index.html` (open it in **Chrome**).

## First time: bring your data over

This app has its own storage, separate from the original Study Timer. Under *Saving & backup*,
click **Open existing save file…** and pick the `study-data.json` **in this folder** (it started
as a copy of the original's). Or use **Import backup** with a backup exported from the original.
After that, the two apps don't share data.

## Where your data is saved

1. **In Chrome, always.** Every change autosaves instantly in the browser's storage.
2. **In a save file, once you link one (recommended).** Under *Saving & backup*, click
   **Create save file…** and save `study-data.json` in this folder. From then on, every
   change is also written to that file, so git can back it up.
   - When you reopen the page, Chrome may ask you to **Reconnect** (one click). Until you
     do, changes still save in the browser and get written to the file after you reconnect.
   - If the browser's copy and the file differ, **whichever was saved more recently wins**.
   - If Chrome's data is ever wiped, open the page and click **Open existing save file…**
     to get everything back.

**Export backup** downloads a copy anytime; **Import backup** replaces everything with one.

Clearing Chrome's browsing data ("Cookies and other site data") erases the browser copy.
The save file and any exported backups are unaffected.

## Music

- **Spend game time on: 🎮 Game / 🎵 Music**, at the top, picks what game time pays for.
  🎮 Game shows the game countdown. 🎵 Music hides it and shows the music player, with its own time-left clock.
- In Music mode, music spends game time 1:1 while it plays. It **can play while you study**.
  Studying keeps refilling it at 1/5 speed, so with both running it drains at 4/5 speed.
- When game time hits 0, the music stops and beeps. It needs **at least 1 minute** banked to play again.
- Multiple playlists, shuffle 🔀, repeat 🔁 (off → whole playlist → one song 🔂), previous/next,
  a position slider, and volume. Your keyboard's media keys work too.
- Drag **⋮⋮** to reorder. **Rename** and **Delete** are on each song (deleting never touches the file).
- Pausing, or closing the page, remembers the song and spot. **Play** picks up there.

### Your music files are only used for the visit

- **+ Add songs…** (or drop files onto the music card) adds songs to the current playlist.
  Chrome can play mp3, m4a/AAC, wav, flac, ogg, and opus.
- The app **never copies or uploads** your files. It saves only each song's file name and your name
  for it (in `study-data.json`, with everything else). Reloading or closing the page forgets the files.
- **Each visit**, click **Load music folder…** and pick the folder your songs are in, or use
  **+ Add songs…** to pick them again. Songs are matched up by file name, and nothing gets added twice.
  Chrome will ask "Upload files to this site?" for a folder. That's its standard wording:
  the page runs on your Mac, and nothing leaves it.
- Until their files are loaded, songs are **greyed out** and get skipped.
- Songs from Apple Music or Spotify can't be used; they're locked to those apps.
  Purchased iTunes songs and your own recordings are fine.

## Rules

- Only one stopwatch runs at a time. Starting one stops the other.
- The game countdown and studying never overlap. Starting either one stops the other.
  (Music is the exception: it can play while you study.)
- Game time is earned continuously, never expires, and can be paused.
- Closing the tab doesn't stop the stopwatches or the game countdown. Timers keep correct time.
  Closing it does stop the music, and the game time it was spending.
- A day counts toward your streak after 1 minute of study. Days follow your Mac's clock.
- Archiving a stopwatch keeps its history. "Delete forever" (from the archive) erases it.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout (open this) |
| `style.css` | Look and feel, including dark mode |
| `store.js` | The data and the rules: stopwatches, sessions, game time, music playlists, streaks |
| `app.js` | The page: timers, charts, music player, dialogs, saving |
| `tests/test_logic.js` | Tests for `store.js`: `node tests/test_logic.js` |
