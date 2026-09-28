"use strict";

/* ===================================================================
   Study Timer + Music data + rules. Pure functions, no DOM - tests/test_logic.js
   loads this file directly with Node.
   =================================================================== */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const GAME_RATIO = 5;            // 5 minutes of study earns 1 minute of game time
const STREAK_MIN_MS = 1 * MIN;   // a day counts toward a streak after 1 minute
const SLOT_COUNT = 8;            // categorical colors; later stopwatches share "Other"
const HEAT_EDGES = [30 * MIN, 60 * MIN, 120 * MIN];
const MUSIC_MIN_START = 1 * MIN; // music needs at least this much game time to start
const REPEAT_MODES = ["off", "all", "one"];
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|aif|aiff)$/i;

/** An error meant for the user to read (bad name, bad times, etc.). */
class UserError extends Error {}

/* ---------- dates ---------- */

function pad(n) { return String(n).padStart(2, "0"); }

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyToTime(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextMidnight(t) {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function startOfWeek(t) {           // weeks run Sunday-Saturday
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

/* ---------- totals, streaks, formatting ---------- */

/** Map dayKey -> Map(stopwatchId -> ms). Sessions crossing midnight are split. */
function dailyTotals(sessions, now) {
  const days = new Map();
  for (const s of sessions) {
    let a = s.start_ms;
    const b = s.end_ms == null ? now : s.end_ms;
    while (a < b) {
      const cut = Math.min(b, nextMidnight(a));
      const key = dayKey(a);
      let m = days.get(key);
      if (!m) { m = new Map(); days.set(key, m); }
      m.set(s.stopwatch_id, (m.get(s.stopwatch_id) || 0) + (cut - a));
      a = cut;
    }
  }
  return days;
}

/** Total for one day; filterId null means every class. */
function dayTotal(days, key, filterId) {
  const m = days.get(key);
  if (!m) return 0;
  if (filterId == null) {
    let sum = 0;
    for (const v of m.values()) sum += v;
    return sum;
  }
  return m.get(filterId) || 0;
}

/** Current and longest streak. Today only extends a streak; it can't break one. */
function streaks(days, now, filterId, minMs = STREAK_MIN_MS) {
  const today = startOfDay(now);
  const keys = [...days.keys()].filter(k => dayTotal(days, k, filterId) >= minMs).sort();
  if (!keys.length) return { current: 0, longest: 0 };
  let longest = 0, run = 0, runBeforeToday = 0;
  for (let t = keyToTime(keys[0]); t <= today; t = addDays(t, 1)) {
    if (t === today) runBeforeToday = run;
    if (dayTotal(days, dayKey(t), filterId) >= minMs) {
      run += 1;
      longest = Math.max(longest, run);
    } else if (t !== today) {
      run = 0;
    }
  }
  const todayOk = dayTotal(days, dayKey(today), filterId) >= minMs;
  return { current: todayOk ? run : runBeforeToday, longest };
}

/** Streak-grid shade: 0 none, 1 under 30m, 2 under 1h, 3 under 2h, 4 two hours or more. */
function heatLevel(ms) {
  if (ms <= 0) return 0;
  return 1 + HEAT_EDGES.filter(edge => ms >= edge).length;
}

/** A "day" here is 24 hours of elapsed time, not a calendar day. */
function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60), s = total % 60;
  if (d > 0) return `${d}d ${h}:${pad(m)}:${pad(s)}`;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtDur(ms) {
  if (ms <= 0) return "0m";
  if (ms < MIN) return "<1m";
  const mins = Math.floor(ms / MIN);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d}d` + (h || m ? ` ${h}h` : "") + (m ? ` ${m}m` : "");
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** A tick step (in ms) that gives at most 5 gridlines up to maxMs. */
function niceStep(maxMs) {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720].map(m => m * MIN);
  for (const s of steps) if (maxMs / s <= 5) return s;
  return 24 * HOUR;
}

/* ---------- the data ---------- */

function emptyMusic() {
  return { playlists: [], current_playlist_id: null, shuffle: false, shuffle_order: [], repeat: "off", volume: 80, resume: null };
}

function emptyData() {
  return {
    app: "study-timer", version: 2, saved_ms: 0, next_id: 1, stopwatches: [], sessions: [], game_sessions: [],
    spend_mode: "game", music: emptyMusic(),
  };
}

/** Check a loaded file or backup and return a clean copy, or throw UserError. */
function validateData(raw) {
  const bad = () => new UserError("That file isn't a Study Timer save file.");
  const int = v => { if (!Number.isInteger(v)) throw bad(); return v; };
  const intOrNull = v => (v == null ? null : int(v));
  if (!raw || raw.app !== "study-timer" || !Array.isArray(raw.stopwatches) ||
      !Array.isArray(raw.sessions) || !Array.isArray(raw.game_sessions)) throw bad();

  const d = emptyData();
  d.saved_ms = Number.isInteger(raw.saved_ms) ? raw.saved_ms : 0;
  const names = new Set();
  for (const s of raw.stopwatches) {
    if (typeof s.name !== "string" || !s.name.trim()) throw bad();
    if (names.has(s.name.toLowerCase())) throw bad();
    names.add(s.name.toLowerCase());
    d.stopwatches.push({ id: int(s.id), name: s.name, archived: !!s.archived, created_ms: int(s.created_ms) });
  }
  const ids = new Set(d.stopwatches.map(s => s.id));
  for (const s of raw.sessions) {
    if (!ids.has(s.stopwatch_id)) throw bad();
    d.sessions.push({ id: int(s.id), stopwatch_id: s.stopwatch_id, start_ms: int(s.start_ms), end_ms: intOrNull(s.end_ms) });
  }
  for (const g of raw.game_sessions) {
    d.game_sessions.push({ id: int(g.id), kind: g.kind === "music" ? "music" : "game", start_ms: int(g.start_ms), end_ms: intOrNull(g.end_ms) });
  }

  // Music (version 2). Older files have none and get the defaults.
  d.spend_mode = raw.spend_mode === "music" ? "music" : "game";
  const m = raw.music;
  if (m != null) {
    if (typeof m !== "object" || !Array.isArray(m.playlists)) throw bad();
    const listNames = new Set();
    for (const p of m.playlists) {
      if (typeof p.name !== "string" || !p.name.trim() || !Array.isArray(p.songs)) throw bad();
      if (listNames.has(p.name.toLowerCase())) throw bad();
      listNames.add(p.name.toLowerCase());
      d.music.playlists.push({
        id: int(p.id), name: p.name,
        songs: p.songs.flatMap(x => {
          if (x.file == null && typeof x.video_id === "string") return [];   // a YouTube song from an earlier version
          if (typeof x.file !== "string" || !x.file || typeof x.title !== "string") throw bad();
          return [{ id: int(x.id), file: x.file, title: x.title }];
        }),
      });
    }
    const lists = d.music.playlists;
    const cur = lists.find(p => p.id === m.current_playlist_id) || lists[0] || null;
    d.music.current_playlist_id = cur ? cur.id : null;
    d.music.shuffle = !!m.shuffle;
    d.music.repeat = REPEAT_MODES.includes(m.repeat) ? m.repeat : "off";
    d.music.volume = Number.isInteger(m.volume) && m.volume >= 0 && m.volume <= 100 ? m.volume : 80;
    // Keep the saved shuffle order, fixed up to hold exactly the current playlist's songs.
    const ids = cur ? cur.songs.map(x => x.id) : [];
    const kept = Array.isArray(m.shuffle_order) ? [...new Set(m.shuffle_order)].filter(id => ids.includes(id)) : [];
    d.music.shuffle_order = [...kept, ...ids.filter(id => !kept.includes(id))];
    const r = m.resume;
    if (r && lists.some(p => p.id === r.playlist_id && p.songs.some(x => x.id === r.song_id))) {
      d.music.resume = { playlist_id: r.playlist_id, song_id: r.song_id,
        position_s: Number.isFinite(r.position_s) && r.position_s > 0 ? Math.floor(r.position_s) : 0 };
    }
  }

  const maxId = Math.max(0, ...d.stopwatches.map(x => x.id), ...d.sessions.map(x => x.id), ...d.game_sessions.map(x => x.id),
    ...d.music.playlists.map(x => x.id), ...d.music.playlists.flatMap(p => p.songs.map(x => x.id)));
  d.next_id = Math.max(Number.isInteger(raw.next_id) ? raw.next_id : 1, maxId + 1);
  return d;
}

/* ---------- game time ---------- */

/* Game time is spent either on the game countdown (kind "game") or on music (kind "music").
   Both spend the same balance. Music may overlap studying; the game countdown may not. */

const covered = (start, end, t) => Math.max(0, Math.min(end ?? t, t) - start);
const studyAt = (d, t) => d.sessions.reduce((a, s) => a + covered(s.start_ms, s.end_ms, t), 0);
const usedAt = (d, t) => d.game_sessions.reduce((a, g) => a + covered(g.start_ms, g.end_ms, t), 0);
/** Game time left at time t. */
const balanceAt = (d, t) => Math.floor(studyAt(d, t) / GAME_RATIO) - usedAt(d, t);
const studyMs = (d, now) => studyAt(d, now);
const runningGameOf = d => d.game_sessions.find(g => g.end_ms == null) || null;

/** If running game/music time has run out, end it at the exact moment it hit zero. Returns true if it did.
    Studying can overlap music, so walk each stretch between study starts/stops after it began. */
function settleGame(d, now) {
  const game = runningGameOf(d);
  if (!game) return false;
  const cuts = new Set([now]);
  for (const s of d.sessions) {
    for (const t of [s.start_ms, s.end_ms]) if (t != null && t > game.start_ms && t < now) cuts.add(t);
  }
  let a = game.start_ms;
  for (const b of [...cuts].sort((x, y) => x - y)) {
    const left = balanceAt(d, a);
    if (left <= 0) { game.end_ms = a; return true; }
    const studying = d.sessions.filter(s => s.start_ms <= a && (s.end_ms == null || s.end_ms > a)).length;
    if (studying < GAME_RATIO) {
      // Each ms spends 1 and earns studying/5, so the balance hits zero after left * 5 / (5 - studying) ms.
      const zero = a + (studying ? Math.ceil(left * GAME_RATIO / (GAME_RATIO - studying)) : left);
      if (zero <= b) { game.end_ms = zero; return true; }
    }
    a = b;
  }
  return false;
}

/* ---------- music ---------- */

/* Songs are your own audio files. The app only saves their file names (and your names for them);
   the files themselves are loaded fresh each visit and never copied. */

/** Can this browser file be played as music? Some Macs leave the type blank, so check the name too. */
const isAudioFile = (name, type) => (type || "").startsWith("audio/") || AUDIO_EXT_RE.test(name || "");

/** "03 - My Song.mp3" -> "03 - My Song". */
function titleFromFile(name) {
  return (name || "").replace(/\.[^./]+$/, "").trim() || name || "";
}

/** ids in random order; firstId (if in ids) stays first, like turning on shuffle mid-song. */
function shuffled(ids, firstId, rand = Math.random) {
  const rest = ids.filter(id => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return ids.includes(firstId) ? [firstId, ...rest] : rest;
}

const currentPlaylistOf = music => music.playlists.find(p => p.id === music.current_playlist_id) || null;

/** Song ids of the current playlist in the order they'll play. */
function playOrder(music) {
  const p = currentPlaylistOf(music);
  if (!p) return [];
  return music.shuffle ? music.shuffle_order : p.songs.map(s => s.id);
}

/** The song after (dir 1) or before (dir -1) currentId. auto = the song ended on its own. null = stop.
    playable(id) says whether a song's file is loaded; songs that aren't get skipped. */
function nextSong(music, currentId, dir, auto, playable = () => true) {
  const order = playOrder(music).filter(id => id === currentId || playable(id));
  if (auto && music.repeat === "one" && order.includes(currentId) && playable(currentId)) return currentId;
  const i = order.indexOf(currentId);
  let pick;
  if (i < 0) pick = order[0];
  else if (i + dir < 0) pick = music.repeat === "all" ? order[order.length - 1] : order[0];
  else if (i + dir >= order.length) pick = music.repeat === "all" ? order[0] : null;
  else pick = order[i + dir];
  return pick != null && playable(pick) ? pick : null;
}

/** Everything the page needs, computed from the data. */
function computeState(d, now) {
  const earned = Math.floor(studyMs(d, now) / GAME_RATIO);
  const used = d.game_sessions.reduce((a, g) => a + ((g.end_ms ?? now) - g.start_ms), 0);
  return {
    now_ms: now,
    game_ratio: GAME_RATIO,
    music_min_ms: MUSIC_MIN_START,
    spend_mode: d.spend_mode,
    music: d.music,
    stopwatches: d.stopwatches,
    sessions: [...d.sessions].sort((a, b) => a.start_ms - b.start_ms),
    game_sessions: d.game_sessions,
    game_earned_ms: earned,
    game_used_ms: used,
    game_left_ms: Math.max(earned - used, 0),
  };
}

/* ---------- actions ---------- */

function cleanName(d, name, exceptId) {
  name = (name || "").trim();
  if (!name) throw new UserError("Give the stopwatch a name.");
  if (name.length > 60) throw new UserError("Keep the name under 60 characters.");
  if (d.stopwatches.some(s => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase())) {
    throw new UserError("A stopwatch with that name already exists.");
  }
  return name;
}

function findStopwatch(d, id) {
  const sw = d.stopwatches.find(s => s.id === id);
  if (!sw) throw new UserError("That stopwatch doesn't exist.");
  return sw;
}

function findSession(d, id) {
  const s = d.sessions.find(x => x.id === id);
  if (!s) throw new UserError("That session doesn't exist.");
  return s;
}

function checkTimes(start, end, now) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new UserError("Start and end times are required.");
  if (end <= start) throw new UserError("The end time has to be after the start time.");
  if (end > now) throw new UserError("A session can't end in the future.");
}

function stopStudy(d, now) { for (const s of d.sessions) if (s.end_ms == null) s.end_ms = now; }
/** Ends running game time. onlyGame = leave music playing (studying may overlap music). */
function stopGame(d, now, onlyGame) {
  for (const g of d.game_sessions) if (g.end_ms == null && !(onlyGame && g.kind === "music")) g.end_ms = now;
}

function cleanPlaylistName(d, name, exceptId) {
  name = (name || "").trim();
  if (!name) throw new UserError("Give the playlist a name.");
  if (name.length > 60) throw new UserError("Keep the name under 60 characters.");
  if (d.music.playlists.some(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new UserError("A playlist with that name already exists.");
  }
  return name;
}

const cleanTitle = t => (typeof t === "string" ? t.trim().slice(0, 200) : "");

function findPlaylist(d, id) {
  const p = d.music.playlists.find(x => x.id === id);
  if (!p) throw new UserError("That playlist doesn't exist.");
  return p;
}

function findSong(d, id) {
  for (const playlist of d.music.playlists) {
    const song = playlist.songs.find(x => x.id === id);
    if (song) return { playlist, song };
  }
  throw new UserError("That song isn't in your playlists anymore.");
}

function reshuffle(d, firstId) {
  const p = currentPlaylistOf(d.music);
  d.music.shuffle_order = p ? shuffled(p.songs.map(s => s.id), firstId) : [];
}

/** resume: { song_id, position_s } or null. */
function setResume(d, resume) {
  if (resume == null) { d.music.resume = null; return; }
  const { playlist } = findSong(d, resume.song_id);
  const pos = Number.isFinite(resume.position_s) && resume.position_s > 0 ? Math.floor(resume.position_s) : 0;
  d.music.resume = { playlist_id: playlist.id, song_id: resume.song_id, position_s: pos };
}

/** Each action edits the data in place; applyAction runs it on a copy so a failure changes nothing. */
const ACTIONS = {
  addStopwatch(d, now, name) {
    d.stopwatches.push({ id: d.next_id++, name: cleanName(d, name, null), archived: false, created_ms: now });
  },
  renameStopwatch(d, now, id, name) {
    findStopwatch(d, id).name = cleanName(d, name, id);
  },
  archiveStopwatch(d, now, id) {
    findStopwatch(d, id).archived = true;
    for (const s of d.sessions) if (s.stopwatch_id === id && s.end_ms == null) s.end_ms = now;
  },
  restoreStopwatch(d, now, id) {
    findStopwatch(d, id).archived = false;
  },
  deleteStopwatch(d, now, id) {
    if (!findStopwatch(d, id).archived) throw new UserError("Archive the stopwatch before deleting it for good.");
    d.stopwatches = d.stopwatches.filter(s => s.id !== id);
    d.sessions = d.sessions.filter(s => s.stopwatch_id !== id);
  },
  start(d, now, id) {
    if (findStopwatch(d, id).archived) throw new UserError("Restore this stopwatch before using it.");
    // Only one stopwatch runs at a time, and studying stops the game countdown (music can keep playing).
    stopGame(d, now, true);
    stopStudy(d, now);
    d.sessions.push({ id: d.next_id++, stopwatch_id: id, start_ms: now, end_ms: null });
  },
  stop(d, now) {
    stopStudy(d, now);
  },
  startGame(d, now) {
    if (d.spend_mode === "music") throw new UserError("Game time is set to Music. Switch it to Game first.");
    stopStudy(d, now);
    if (runningGameOf(d)) return;
    if (balanceAt(d, now) <= 0) throw new UserError("No game time left. Go study!");
    d.game_sessions.push({ id: d.next_id++, kind: "game", start_ms: now, end_ms: null });
  },
  stopGame(d, now) {
    stopGame(d, now);
  },
  setSpendMode(d, now, mode) {
    if (mode !== "game" && mode !== "music") throw new UserError("Pick Game or Music.");
    if (mode !== d.spend_mode) stopGame(d, now);
    d.spend_mode = mode;
  },
  startMusic(d, now) {
    if (d.spend_mode !== "music") throw new UserError("Switch game time to Music first.");
    if (runningGameOf(d)) return;
    if (balanceAt(d, now) < MUSIC_MIN_START) throw new UserError("Music needs at least 1 minute of game time. Go study!");
    d.game_sessions.push({ id: d.next_id++, kind: "music", start_ms: now, end_ms: null });
  },
  /** resume (optional): where to pick up next time, { song_id, position_s }. */
  stopMusic(d, now, resume) {
    stopGame(d, now);
    if (resume !== undefined) setResume(d, resume);
  },
  saveResume(d, now, resume) {
    setResume(d, resume);
  },
  addPlaylist(d, now, name) {
    const p = { id: d.next_id++, name: cleanPlaylistName(d, name, null), songs: [] };
    d.music.playlists.push(p);
    d.music.current_playlist_id = p.id;
    reshuffle(d, null);
  },
  renamePlaylist(d, now, id, name) {
    findPlaylist(d, id).name = cleanPlaylistName(d, name, id);
  },
  deletePlaylist(d, now, id) {
    findPlaylist(d, id);
    d.music.playlists = d.music.playlists.filter(p => p.id !== id);
    if (d.music.resume && d.music.resume.playlist_id === id) d.music.resume = null;
    if (d.music.current_playlist_id === id) {
      d.music.current_playlist_id = d.music.playlists.length ? d.music.playlists[0].id : null;
      reshuffle(d, null);
    }
  },
  selectPlaylist(d, now, id) {
    findPlaylist(d, id);
    if (d.music.current_playlist_id === id) return;
    d.music.current_playlist_id = id;
    reshuffle(d, null);
  },
  /** songs: [{ file, title }] (file = the file's name). playlistId null = the current playlist (made if there is none). */
  addSongs(d, now, playlistId, songs) {
    if (playlistId == null && !currentPlaylistOf(d.music)) ACTIONS.addPlaylist(d, now, "My playlist");
    const p = playlistId == null ? currentPlaylistOf(d.music) : findPlaylist(d, playlistId);
    const have = new Set(p.songs.map(s => s.file));
    const added = [];
    for (const s of songs) {
      if (typeof s.file !== "string" || !s.file.trim() || s.file.length > 255) throw new UserError("That isn't a music file.");
      if (have.has(s.file)) continue;
      have.add(s.file);
      const song = { id: d.next_id++, file: s.file, title: cleanTitle(s.title) || titleFromFile(s.file) };
      p.songs.push(song);
      added.push(song.id);
    }
    if (!added.length) {
      throw new UserError(songs.length === 1 ? "That song is already in this playlist." : "Those songs are already in this playlist.");
    }
    if (p.id === d.music.current_playlist_id) d.music.shuffle_order.push(...shuffled(added, null));
  },
  renameSong(d, now, id, title) {
    const t = cleanTitle(title);
    if (!t) throw new UserError("Give the song a name.");
    findSong(d, id).song.title = t;
  },
  deleteSong(d, now, id) {
    const { playlist } = findSong(d, id);
    playlist.songs = playlist.songs.filter(s => s.id !== id);
    d.music.shuffle_order = d.music.shuffle_order.filter(x => x !== id);
    if (d.music.resume && d.music.resume.song_id === id) d.music.resume = null;
  },
  /** Move a song to position toIndex (0 = top) in its playlist. */
  moveSong(d, now, id, toIndex) {
    const { playlist, song } = findSong(d, id);
    if (!Number.isInteger(toIndex)) throw new UserError("Couldn't move that song.");
    const rest = playlist.songs.filter(s => s.id !== id);
    rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, song);
    playlist.songs = rest;
  },
  /** currentId (optional) stays first so the song playing now isn't interrupted. */
  setShuffle(d, now, on, currentId) {
    d.music.shuffle = !!on;
    if (on) reshuffle(d, currentId);
  },
  setRepeat(d, now, mode) {
    if (!REPEAT_MODES.includes(mode)) throw new UserError("Unknown repeat mode.");
    d.music.repeat = mode;
  },
  setVolume(d, now, volume) {
    if (!Number.isFinite(volume)) throw new UserError("Unknown volume.");
    d.music.volume = Math.max(0, Math.min(100, Math.round(volume)));
  },
  addSession(d, now, stopwatchId, start, end) {
    findStopwatch(d, stopwatchId);
    checkTimes(start, end, now);
    d.sessions.push({ id: d.next_id++, stopwatch_id: stopwatchId, start_ms: start, end_ms: end });
  },
  updateSession(d, now, id, start, end) {
    const s = findSession(d, id);
    if (s.end_ms == null) throw new UserError("Stop the stopwatch before editing this session.");
    checkTimes(start, end, now);
    s.start_ms = start;
    s.end_ms = end;
  },
  deleteSession(d, now, id) {
    findSession(d, id);
    d.sessions = d.sessions.filter(s => s.id !== id);
  },
};

/** Returns a new data object with the action applied. Throws UserError and leaves d untouched on failure. */
function applyAction(d, now, name, ...args) {
  const copy = structuredClone(d);
  settleGame(copy, now);
  ACTIONS[name](copy, now, ...args);
  copy.saved_ms = now;
  return copy;
}

if (typeof module !== "undefined") {
  module.exports = {
    MIN, HOUR, GAME_RATIO, SLOT_COUNT, MUSIC_MIN_START, UserError,
    pad, dayKey, keyToTime, startOfDay, nextMidnight, addDays, startOfWeek,
    dailyTotals, dayTotal, streaks, heatLevel, fmtClock, fmtDur, niceStep,
    emptyData, validateData, settleGame, computeState, applyAction,
    balanceAt, isAudioFile, titleFromFile, shuffled, playOrder, nextSong,
  };
}
