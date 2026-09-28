"use strict";

/* Study Timer + Music page. Data rules and helpers live in store.js (loaded first). */

if (typeof document !== "undefined") {
  const $ = sel => document.querySelector(sel);
  const SVG_NS = "http://www.w3.org/2000/svg";

  let data = null;         // everything saved (see store.js)
  let S = null;            // computeState(data) at the last render
  let days = new Map();    // dailyTotals for the last render
  let lastRenderDay = null;
  let beepedFor = null;
  let audioCtx = null;

  const ui = {
    reportMode: "week",
    reportOffset: 0,
    streakFilter: "all",
    logLimit: 25,
    renameId: null,        // null = adding a new stopwatch
    editSession: null,     // null = adding a new session
    dragSongId: null,      // song being dragged in the music list
    seeking: false,        // dragging the song position slider
  };

  const now = () => Date.now();

  /* ---------- small DOM helpers ---------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function svg(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtDate = (t, opts) => new Date(t).toLocaleDateString([], opts || { weekday: "short", month: "short", day: "numeric" });

  function toLocalInput(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let errorTimer = null;
  function showError(msg) {
    const el = $("#error");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  let noticeTimer = null;
  function showNotice(msg) {
    const el = $("#notice");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  /* ---------- saving: browser storage (always) + save file (Chrome) ---------- */

  // Separate from the original Study Timer: Chrome gives every double-clicked page the same storage.
  const LS_KEY = "study-timer-music-data";
  const fileSupported = "showSaveFilePicker" in window;
  let fileHandle = null;
  let fileState = fileSupported ? "none" : "unsupported"; // none | connected | needs-permission | error | unsupported
  let writeQueue = Promise.resolve();

  function loadLocal() {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyData();
    try {
      return validateData(JSON.parse(raw));
    } catch (e) {
      // Keep the unreadable copy instead of silently throwing it away.
      localStorage.setItem(`${LS_KEY}-unreadable-${Date.now()}`, raw);
      showError("Your saved data couldn't be read, so the app started empty. The old copy was kept in browser storage.");
      return emptyData();
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      showError("Couldn't save in this browser: " + e.message);
    }
  }

  function saveFile() {
    if (!fileHandle || fileState !== "connected") return;
    writeQueue = writeQueue.then(async () => {
      // createWritable writes to a temporary copy and swaps it in on close,
      // so a crash mid-write never leaves a half-written file.
      const w = await fileHandle.createWritable();
      await w.write(JSON.stringify(data, null, 1));
      await w.close();
    }).catch(e => {
      fileState = "error";
      renderFileStatus();
      showError(`Couldn't write to ${fileHandle.name}: ${e.message}`);
    });
  }

  function persist() {
    saveLocal();
    saveFile();
  }

  /* Tiny IndexedDB key-value store: Chrome can only remember a file link there. */
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("study-timer-music", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", mode);
        const req = fn(tx.objectStore("kv"));
        tx.oncomplete = () => { open.result.close(); resolve(req.result); };
        tx.onerror = () => { open.result.close(); reject(tx.error); };
      };
    });
  }
  const idbGet = key => idb("readonly", s => s.get(key));
  const idbSet = (key, val) => idb("readwrite", s => s.put(val, key));
  const idbDel = key => idb("readwrite", s => s.delete(key));

  /** Link a save file. Whichever copy (file or browser) was saved more recently wins. */
  async function linkFile(handle, { mustBeStudyFile }) {
    const text = await (await handle.getFile()).text();
    let fromFile = null;
    if (text.trim()) {
      try {
        fromFile = validateData(JSON.parse(text));
      } catch (e) {
        if (mustBeStudyFile) throw new UserError(`${handle.name} isn't a Study Timer save file.`);
      }
    } else if (mustBeStudyFile) {
      throw new UserError(`${handle.name} is empty.`);
    }
    fileHandle = handle;
    fileState = "connected";
    await idbSet("file", handle);
    if (fromFile && fromFile.saved_ms > data.saved_ms) {
      data = fromFile;
      saveLocal();
      showNotice(`Loaded your data from ${handle.name} (it was newer than this browser's copy).`);
      render();
    } else {
      saveFile();
      showNotice(`Linked ${handle.name}. Every change now saves there too.`);
    }
    renderFileStatus();
  }

  async function createSaveFile() {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "study-data.json",
        types: [{ description: "Study Timer data", accept: { "application/json": [".json"] } }],
      });
      await linkFile(handle, { mustBeStudyFile: false });
    } catch (e) {
      if (e.name !== "AbortError") showError(e.message);
    }
  }

  async function openSaveFile() {
    try {
      const [handle] = await showOpenFilePicker({
        types: [{ description: "Study Timer data", accept: { "application/json": [".json"] } }],
      });
      if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return;
      await linkFile(handle, { mustBeStudyFile: true });
    } catch (e) {
      if (e.name !== "AbortError") showError(e.message);
    }
  }

  async function reconnectFile() {
    try {
      if ((await fileHandle.requestPermission({ mode: "readwrite" })) !== "granted") return;
      await linkFile(fileHandle, { mustBeStudyFile: false });
    } catch (e) {
      fileState = "error";
      renderFileStatus();
      showError(`Couldn't open ${fileHandle.name}: ${e.message}`);
    }
  }

  async function unlinkFile() {
    if (!confirm(`Stop saving to ${fileHandle.name}? The file stays where it is; this browser just stops updating it.`)) return;
    await idbDel("file");
    fileHandle = null;
    fileState = "none";
    renderFileStatus();
  }

  /** On page load: find the remembered file and reconnect if Chrome still allows it. */
  async function restoreFileLink() {
    if (!fileSupported) return;
    try {
      const handle = await idbGet("file");
      if (!handle) return;
      fileHandle = handle;
      if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") {
        await linkFile(handle, { mustBeStudyFile: false });
      } else {
        fileState = "needs-permission";
      }
    } catch (e) {
      fileState = fileHandle ? "error" : "none";
    }
    renderFileStatus();
  }

  function renderFileStatus() {
    const box = $("#file-status");
    const name = fileHandle ? fileHandle.name : "";
    const btn = (label, fn, primary) => h("button", { type: "button", class: "btn" + (primary ? " btn-primary" : ""), onclick: fn }, label);
    const parts = {
      unsupported: [h("span", { class: "muted" }, "This browser can't save to a file. Use Chrome, or use Export backup regularly.")],
      none: [
        h("span", {}, "Not linked. Right now your data lives only in this browser."),
        btn("Create save file…", createSaveFile, true),
        btn("Open existing save file…", openSaveFile),
      ],
      connected: [h("span", {}, "✓ Saving to ", h("strong", {}, name)), btn("Unlink", unlinkFile)],
      "needs-permission": [h("span", {}, "Chrome needs your OK to keep saving to ", h("strong", {}, name), "."), btn("Reconnect", reconnectFile, true)],
      error: [h("span", {}, "⚠ Can't save to ", h("strong", {}, name), "."), btn("Try again", reconnectFile, true), btn("Unlink", unlinkFile)],
    }[fileState];
    box.replaceChildren(...parts);
    const banner = $("#reconnect");
    banner.hidden = !(fileState === "needs-permission" || fileState === "error");
    $("#reconnect-name").textContent = name;
  }

  /* ---------- actions ---------- */

  /** Runs a store.js action. Returns null on success, or a message for the user. */
  function run(name, ...args) {
    try {
      data = applyAction(data, now(), name, ...args);
    } catch (e) {
      if (e instanceof UserError) return e.message;
      throw e;
    }
    persist();
    render();
    return null;
  }

  function act(name, ...args) {
    const err = run(name, ...args);
    if (err) showError(err);
    return err;
  }

  /** Recompute from the data (and end game time that has run out). */
  function render() {
    if (settleGame(data, now())) persist();
    S = computeState(data, now());
    renderAll();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `study-timer-music-backup-${dayKey(now())}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- derived values ---------- */

  const runningSession = () => S.sessions.find(s => s.end_ms == null) || null;
  const runningGame = () => S.game_sessions.find(g => g.end_ms == null) || null;
  const activeStopwatches = () => S.stopwatches.filter(s => !s.archived);
  const swById = id => S.stopwatches.find(s => s.id === id);

  function slotOf(id) {
    const i = S.stopwatches.findIndex(s => s.id === id);
    return i >= 0 && i < SLOT_COUNT ? i + 1 : null;
  }
  const colorOf = id => (slotOf(id) ? `var(--s${slotOf(id)})` : "var(--s-other)");

  /** Chart series: the first 8 stopwatches get their own color; the rest fold into Other. */
  function seriesOf(id) {
    return slotOf(id) ? { key: id, name: swById(id).name, color: colorOf(id), order: slotOf(id) }
                      : { key: "other", name: "Other", color: "var(--s-other)", order: 99 };
  }

  /** Live game time left. Music can play while studying, so both can apply at once. */
  function gameLeft() {
    const elapsed = now() - S.now_ms;
    let left = S.game_left_ms;
    if (runningSession()) left += Math.floor(elapsed / S.game_ratio);
    if (runningGame()) left -= elapsed;
    return Math.max(0, left);
  }

  /** ms studied today on one stopwatch, including the live running session. */
  function todayFor(id) {
    const base = dayTotal(days, dayKey(S.now_ms), id);
    const run = runningSession();
    if (!run || run.stopwatch_id !== id) return base;
    return base + Math.max(0, now() - Math.max(S.now_ms, startOfDay(now())));
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    days = dailyTotals(S.sessions, S.now_ms);
    lastRenderDay = dayKey(now());
    renderStopwatches();
    renderStreakFilter();
    renderStreak();
    renderReport();
    renderLog();
    renderArchive();
    renderMusic();
    syncPlayer();
    tick();
  }

  function renderStopwatches() {
    const grid = $("#stopwatches");
    const list = activeStopwatches();
    const run = runningSession();
    $("#sw-empty").hidden = list.length > 0;
    grid.replaceChildren(...list.map(sw => {
      const isRunning = run && run.stopwatch_id === sw.id;
      return h("article", { class: "sw" + (isRunning ? " is-running" : ""), "data-id": sw.id },
        h("div", { class: "sw-top" },
          h("span", { class: "dot", style: `background:${colorOf(sw.id)}` }),
          h("span", { class: "sw-name" }, sw.name),
          h("button", { type: "button", class: "btn-link btn-small", title: "Rename", onclick: () => openNameDialog(sw) }, "Rename"),
          h("button", { type: "button", class: "btn-link btn-small", title: "Archive", onclick: () => archive(sw) }, "Archive"),
        ),
        h("div", { class: "sw-clock" }, "0:00"),
        h("div", { class: "sw-sub" }),
        h("div", { class: "sw-actions" },
          h("span", { class: "muted small" }, "today"),
          isRunning
            ? h("button", { type: "button", class: "btn", onclick: () => act("stop") }, "■ Stop")
            : h("button", { type: "button", class: "btn btn-primary", onclick: () => act("start", sw.id) }, "▶ Start"),
        ),
      );
    }));
  }

  function archive(sw) {
    const msg = `Archive "${sw.name}"? Its history stays in your streak and reports, ` +
      "and you can restore it from Saving & backup.";
    if (confirm(msg)) act("archiveStopwatch", sw.id);
  }

  /** Runs 4x a second: live clocks, game countdown, tab title. */
  function tick() {
    if (!S) return;
    if (dayKey(now()) !== lastRenderDay) { render(); return; }   // crossed midnight

    const run = runningSession();
    const game = runningGame();

    for (const card of document.querySelectorAll(".sw")) {
      const id = Number(card.dataset.id);
      card.querySelector(".sw-clock").textContent = fmtClock(todayFor(id));
      const sub = card.querySelector(".sw-sub");
      if (run && run.stopwatch_id === id) {
        sub.replaceChildren(h("span", { class: "sw-live" }, "● "), `This session ${fmtClock(now() - run.start_ms)}`);
      } else {
        const all = S.sessions.filter(s => s.stopwatch_id === id)
          .reduce((a, s) => a + ((s.end_ms ?? S.now_ms) - s.start_ms), 0);
        sub.textContent = `All time ${fmtDur(all)}`;
      }
    }

    const left = gameLeft();
    $("#game-clock").textContent = fmtClock(left);
    const btn = $("#game-btn");
    $(".game").classList.toggle("is-running", !!game);
    if (game) {
      btn.textContent = "❚❚ Pause game time";
      btn.disabled = false;
    } else {
      btn.textContent = left > 0 ? "▶ Start game time" : "No game time yet";
      btn.disabled = left <= 0;
    }

    if (game && left <= 0) {
      if (beepedFor !== game.id) {
        beepedFor = game.id;
        beep();
        $("#times-up").hidden = false;
      }
      render();   // ends the game session at the moment it ran out
    }

    let total = 0;
    for (const sw of S.stopwatches) total += todayFor(sw.id);
    $("#today-line").textContent =
      `${fmtDate(now(), { weekday: "long", month: "long", day: "numeric" })} · ${fmtDur(total)} studied today`;

    tickMusic(left);

    const note = game && game.kind === "music" ? "🎵" : "🎮";
    if (run) document.title = `▶ ${fmtClock(now() - run.start_ms)} · ${swById(run.stopwatch_id).name}` + (game ? ` · ${note}` : "");
    else if (game) document.title = `${note} ${fmtClock(left)} left`;
    else document.title = "Study Timer + Music";
  }

  function beep() {
    try {
      audioCtx = audioCtx || new AudioContext();
      [0, 0.35, 0.7].forEach(offset => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + offset + 0.25);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + offset);
        osc.stop(audioCtx.currentTime + offset + 0.3);
      });
    } catch (e) { /* no audio available */ }
  }

  /* ---------- music (your own audio files) ---------- */

  const musicRunning = () => { const g = runningGame(); return !!g && g.kind === "music"; };
  const currentPlaylist = () => S.music.playlists.find(p => p.id === S.music.current_playlist_id) || null;
  function songById(id) {
    for (const p of S.music.playlists) {
      const s = p.songs.find(x => x.id === id);
      if (s) return s;
    }
    return null;
  }
  const songLabel = s => s.title || titleFromFile(s.file);
  const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // Music files picked this visit, by file name. They're never saved or copied: reloading the page forgets them.
  const files = new Map();
  const audio = $("#audio");
  let audioUrl = null;        // object URL of the file in the audio element
  let loadedSongId = null;    // song in the audio element
  let playing = false;        // this page is playing music (a music session is running)
  let switching = false;      // changing songs: ignore the audio element's own pause
  let skipStreak = 0;         // songs skipped in a row because Chrome couldn't play the file
  let lastResumeSave = 0;

  const fileOf = song => (song ? files.get(song.file) || null : null);
  const playable = id => !!fileOf(songById(id));

  /** The song shown as "now playing": the one playing, or where Play will start. */
  function shownSongId() {
    if (playing) return loadedSongId;
    return S.music.resume ? S.music.resume.song_id : loadedSongId;
  }
  const currentPos = () => (loadedSongId != null ? audio.currentTime || 0 : 0);

  /** Load a song's file and play it (music time must already be running). */
  function playSong(id, startSeconds) {
    const song = songById(id);
    const file = fileOf(song);
    if (!file) return;
    const start = startSeconds || 0;
    const oldUrl = audioUrl;
    audioUrl = URL.createObjectURL(file);
    loadedSongId = id;
    playing = true;
    switching = true;
    audio.src = audioUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    if (start > 0) audio.addEventListener("loadedmetadata", () => { audio.currentTime = start; }, { once: true });
    audio.volume = S.music.volume / 100;
    audio.play().catch(() => { /* a newer song replaced it, or the file is broken ("error" handles that) */ })
      .finally(() => { switching = false; });
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: songLabel(song) });
    lastResumeSave = now();
    act("saveResume", { song_id: id, position_s: start });
  }

  /** Play button, or clicking a song: start spending game time on music. songId null = pick up where it left off. */
  function startMusic(songId) {
    const order = playOrder(S.music);
    const r = S.music.resume;
    let id = songId, pos = 0;
    if (id == null) {
      if (r && order.includes(r.song_id) && playable(r.song_id)) { id = r.song_id; pos = r.position_s; }
      else id = nextSong(S.music, null, 1, false, playable);
    }
    if (id == null) {
      showError(order.length ? "Load your music files first: click “Load music folder…” or “+ Add songs…”."
                             : "Add some songs to this playlist first.");
      return;
    }
    if (act("startMusic")) return;
    $("#times-up").hidden = true;
    skipStreak = 0;
    if (songId == null && id === loadedSongId && audio.paused && !audio.ended && audio.getAttribute("src")) {
      playing = true;
      audio.play().catch(() => {});
      render();
    } else {
      playSong(id, pos);
    }
  }

  /** Stop the music and the game time it spends. resume: where to pick up (undefined = leave it). */
  function stopPlaying(resume) {
    playing = false;
    audio.pause();
    act("stopMusic", resume);
  }

  function pauseMusic() {
    const pos = currentPos();
    stopPlaying(songById(loadedSongId) ? { song_id: loadedSongId, position_s: pos } : undefined);
  }

  /** Next (dir 1) or previous (dir -1). auto = the song ended by itself. */
  function skip(dir, auto) {
    // Previous restarts the song once it's a few seconds in, like YouTube Music.
    if (dir < 0 && playing && currentPos() > 3) { audio.currentTime = 0; return; }
    const id = nextSong(S.music, shownSongId(), dir, auto, playable);
    if (id == null) {
      if (playing) stopPlaying(null);   // next Play starts from the top
      showNotice(playOrder(S.music).some(playable) ? "That's the end of the playlist."
                                                   : "None of this playlist's files are loaded this visit.");
      return;
    }
    if (playing) playSong(id, 0);
    else act("saveResume", { song_id: id, position_s: 0 });
  }

  function clickSong(id) {
    const song = songById(id);
    if (!playable(id)) {
      showNotice(`"${songLabel(song)}" isn't loaded this visit. Pick its file (${song.file}) with “Load music folder…” or “+ Add songs…”.`);
      return;
    }
    if (playing) { skipStreak = 0; playSong(id, 0); return; }
    if (S.spend_mode !== "music") return;
    startMusic(id);
  }

  /** Keep the audio in step with the data: music time ended (ran out, mode switched, another tab) -> pause. */
  function syncPlayer() {
    if (!playing || musicRunning()) return;
    playing = false;
    const pos = currentPos(), id = loadedSongId;
    audio.pause();
    if (songById(id)) setTimeout(() => act("saveResume", { song_id: id, position_s: pos }), 0);
  }

  audio.addEventListener("playing", () => { skipStreak = 0; });
  audio.addEventListener("ended", () => { if (playing) skip(1, true); });
  // Paused or played from outside the page's buttons: keyboard media keys, Chrome's media controls, headphones.
  audio.addEventListener("pause", () => { if (playing && !switching && !audio.ended) pauseMusic(); });
  audio.addEventListener("play", () => {
    if (playing) return;
    if (!musicRunning() && act("startMusic")) { audio.pause(); return; }
    playing = true;
    render();
  });
  audio.addEventListener("error", () => {
    if (!audio.getAttribute("src") || loadedSongId == null) return;
    const song = songById(loadedSongId);
    skipStreak += 1;
    if (skipStreak >= Math.max(1, playOrder(S.music).filter(playable).length)) {
      stopPlaying(undefined);
      showError("Chrome couldn't play any of the loaded files in this playlist.");
      return;
    }
    showNotice(`Skipped "${song ? songLabel(song) : "a song"}": Chrome can't play that file.`);
    if (playing) skip(1, false);
  });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => { if (!musicRunning()) startMusic(null); });
    navigator.mediaSession.setActionHandler("pause", () => { if (musicRunning()) pauseMusic(); });
    navigator.mediaSession.setActionHandler("nexttrack", () => skip(1, false));
    navigator.mediaSession.setActionHandler("previoustrack", () => skip(-1, false));
  }

  function renderMusic() {
    const m = S.music;
    const pl = currentPlaylist();
    // The toggle shows either the game countdown or the music player.
    $("#game-card").hidden = S.spend_mode === "music";
    $("#music-card").hidden = S.spend_mode !== "music";
    for (const b of document.querySelectorAll("[data-spend]")) b.setAttribute("aria-pressed", String(b.dataset.spend === S.spend_mode));
    $("#spend-hint").textContent = S.spend_mode === "music"
      ? "Music uses game time while it plays. It can play while you study, and studying keeps refilling it."
      : "The game countdown can't run while you study.";

    const sel = $("#pl-select");
    sel.replaceChildren(...(m.playlists.length
      ? m.playlists.map(p => h("option", { value: p.id }, `${p.name} (${p.songs.length})`))
      : [h("option", { value: "" }, "No playlists yet")]));
    sel.value = pl ? pl.id : "";
    sel.disabled = !m.playlists.length;
    $("#pl-rename").hidden = !pl;
    $("#pl-delete").hidden = !pl;

    $("#m-shuffle").setAttribute("aria-pressed", String(m.shuffle));
    const rep = $("#m-repeat");
    rep.setAttribute("aria-pressed", String(m.repeat !== "off"));
    rep.title = `Repeat: ${m.repeat === "one" ? "this song" : m.repeat === "all" ? "whole playlist" : "off"}`;
    rep.textContent = m.repeat === "one" ? "🔂" : "🔁";
    if (document.activeElement !== $("#m-volume")) {
      $("#m-volume").value = m.volume;
      audio.volume = m.volume / 100;
    }
    renderSongs(pl);
  }

  function renderSongs(pl) {
    if (ui.dragSongId != null) return;   // don't rebuild the list mid-drag
    const cur = shownSongId();
    const list = $("#songs");
    if (!pl || !pl.songs.length) {
      list.replaceChildren(h("li", { class: "empty" },
        pl ? "No songs yet. Click “+ Add songs…” or drop music files here."
           : "No playlists yet. Click “+ Add songs…” to start one, or + New."));
      return;
    }
    list.replaceChildren(...pl.songs.map((s, i) => {
      const loaded = !!fileOf(s);
      return h("li", {
        class: "song-row" + (s.id === cur ? " is-current" : "") + (loaded ? "" : " is-missing"),
        draggable: "true", "data-id": s.id,
      },
        h("span", { class: "drag-handle", title: "Drag to reorder" }, "⋮⋮"),
        h("span", { class: "song-num" }, s.id === cur && playing ? "♪" : i + 1),
        h("span", { class: "song-title", title: loaded ? "Play" : `Not loaded this visit (${s.file})`, onclick: () => clickSong(s.id) },
          songLabel(s)),
        h("button", { type: "button", class: "btn-link btn-small",
          onclick: () => askText("Rename song", s.title, titleFromFile(s.file), t => run("renameSong", s.id, t)) }, "Rename"),
        h("button", {
          type: "button", class: "btn-link btn-small danger",
          onclick: () => { if (confirm(`Remove "${songLabel(s)}" from ${pl.name}? (The file itself isn't touched.)`)) act("deleteSong", s.id); },
        }, "Delete"),
      );
    }));
  }

  /** Runs every tick: time left, now-playing position, play button, hint. */
  function tickMusic(left) {
    const on = musicRunning();
    $("#music-clock").textContent = fmtClock(left);
    $("#music-card").classList.toggle("is-running", playing);
    const id = shownSongId();
    const song = id != null ? songById(id) : null;
    $("#now-title").textContent = song ? songLabel(song) : "Nothing yet";
    const dur = song && id === loadedSongId && Number.isFinite(audio.duration) ? audio.duration : 0;
    let time = "";
    if (dur) time = `${fmtClock(currentPos() * 1000)} / ${fmtClock(dur * 1000)}`;
    else if (song && S.music.resume && S.music.resume.song_id === id && S.music.resume.position_s > 0) {
      time = `Picks up at ${fmtClock(S.music.resume.position_s * 1000)}`;
    }
    $("#now-time").textContent = time;
    const seek = $("#m-seek");
    seek.disabled = !dur;
    if (!ui.seeking) seek.value = dur ? Math.round((currentPos() / dur) * 1000) : 0;

    const pl = currentPlaylist();
    const total = pl ? pl.songs.length : 0;
    const ready = pl ? pl.songs.filter(fileOf).length : 0;
    const btn = $("#m-play");
    btn.textContent = on ? "❚❚ Pause" : "▶ Play";
    btn.disabled = !on && (left < S.music_min_ms || !ready);
    $("#music-hint").textContent =
      !total ? "" :
      !ready ? "This visit, your songs' files aren't loaded yet. Click “Load music folder…” (or “+ Add songs…”) and pick them." :
      !on && left < S.music_min_ms ? "Music needs at least 1 minute of game time. Study to earn more." :
      ready < total ? `${counted(total - ready, "song")} in this playlist ${total - ready === 1 ? "isn't" : "aren't"} loaded this visit (greyed out) and will be skipped.` :
      S.music.shuffle ? "Shuffle is on." : "";

    // Remember the spot every 15 seconds so a crash or reload picks up close to here.
    if (playing && now() - lastResumeSave > 15000 && songById(loadedSongId)) {
      lastResumeSave = now();
      act("saveResume", { song_id: loadedSongId, position_s: currentPos() });
    }
  }

  /** Music files picked or dropped this visit. addToPlaylist: also add ones the current playlist doesn't have yet. */
  function takeFiles(list, addToPlaylist) {
    const all = [...list];
    const picked = all.filter(f => isAudioFile(f.name, f.type));
    if (!picked.length) {
      if (all.length) showError("None of those are music files Chrome can play (mp3, m4a, wav, flac, ogg…).");
      return;
    }
    for (const f of picked) files.set(f.name, f);
    let added = 0;
    if (addToPlaylist) {
      const pl = currentPlaylist();
      const have = new Set(pl ? pl.songs.map(s => s.file) : []);
      const fresh = [...new Set(picked.map(f => f.name))].filter(name => !have.has(name));
      if (fresh.length && act("addSongs", null, fresh.map(name => ({ file: name, title: titleFromFile(name) })))) return;
      added = fresh.length;
    }
    render();
    const pl = currentPlaylist();
    const songs = pl ? pl.songs : [];
    const missing = songs.filter(s => !fileOf(s));
    const parts = [];
    if (added) parts.push(`Added ${counted(added, "song")} to ${pl.name}.`);
    if (songs.length) parts.push(`${songs.length - missing.length} of ${songs.length} songs in ${pl.name} are ready to play.`);
    if (missing.length) {
      parts.push(`Still missing: ${missing.slice(0, 3).map(s => s.file).join(", ")}` +
        (missing.length > 3 ? ` and ${missing.length - 3} more.` : "."));
    }
    if (!parts.length) parts.push(`Loaded ${counted(picked.length, "music file")}. None are in a playlist yet: use \u201c+ Add songs\u2026\u201d to add them.`);
    showNotice(parts.join(" "));
  }

  $("#add-files").addEventListener("change", e => { takeFiles(e.target.files, true); e.target.value = ""; });
  $("#load-folder").addEventListener("change", e => { takeFiles(e.target.files, false); e.target.value = ""; });

  /* drop music files on the music card to add them */
  const hasFiles = e => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  const card = $("#music-card");
  card.addEventListener("dragover", e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    card.classList.add("drop-target");
  });
  card.addEventListener("dragleave", e => { if (!card.contains(e.relatedTarget)) card.classList.remove("drop-target"); });
  card.addEventListener("drop", e => {
    card.classList.remove("drop-target");
    if (!hasFiles(e)) return;
    e.preventDefault();
    takeFiles(e.dataTransfer.files, true);
  });
  // A file dropped anywhere else would make Chrome leave the app to open it.
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", e => { if (hasFiles(e)) e.preventDefault(); });

  /* drag to reorder */
  const songsEl = $("#songs");
  const clearDropMarks = () => {
    for (const r of songsEl.querySelectorAll(".drop-before, .drop-after")) r.classList.remove("drop-before", "drop-after");
  };
  songsEl.addEventListener("dragstart", e => {
    const row = e.target.closest && e.target.closest(".song-row");
    if (!row) return;
    ui.dragSongId = Number(row.dataset.id);
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.id);
  });
  songsEl.addEventListener("dragover", e => {
    const row = ui.dragSongId != null && e.target.closest && e.target.closest(".song-row");
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    clearDropMarks();
    row.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  });
  songsEl.addEventListener("drop", e => {
    if (ui.dragSongId == null) return;
    e.preventDefault();
    const id = ui.dragSongId;
    ui.dragSongId = null;
    const row = e.target.closest && e.target.closest(".song-row");
    const pl = currentPlaylist();
    if (!row || !pl) { render(); return; }
    const ids = pl.songs.map(s => s.id);
    const from = ids.indexOf(id);
    let to = ids.indexOf(Number(row.dataset.id)) + (row.classList.contains("drop-after") ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) act("moveSong", id, to); else render();
  });
  songsEl.addEventListener("dragend", () => {
    if (ui.dragSongId != null) { ui.dragSongId = null; render(); }
  });

  /* text dialog (playlist and song names) */
  let textSave = null;
  function askText(title, value, placeholder, onSave) {
    textSave = onSave;
    $("#text-title").textContent = title;
    $("#text-input").value = value || "";
    $("#text-input").placeholder = placeholder || "";
    $("#text-error").textContent = "";
    $("#text-dialog").showModal();
    $("#text-input").select();
  }
  $("#text-form").addEventListener("submit", e => {
    e.preventDefault();
    const err = textSave($("#text-input").value);
    if (err) $("#text-error").textContent = err;
    else $("#text-dialog").close();
  });
  $("#text-cancel").addEventListener("click", () => $("#text-dialog").close());

  /* music controls */
  $("#pl-select").addEventListener("change", e => { if (e.target.value) act("selectPlaylist", Number(e.target.value)); });
  $("#pl-new").addEventListener("click", () => askText("New playlist", "", "e.g. Lo-fi", name => run("addPlaylist", name)));
  $("#pl-rename").addEventListener("click", () => {
    const pl = currentPlaylist();
    if (pl) askText("Rename playlist", pl.name, "", name => run("renamePlaylist", pl.id, name));
  });
  $("#pl-delete").addEventListener("click", () => {
    const pl = currentPlaylist();
    const n = pl ? pl.songs.length : 0;
    if (pl && confirm(`Delete the playlist "${pl.name}" and its ${counted(n, "song")}? Your music files aren't touched.`)) {
      act("deletePlaylist", pl.id);
    }
  });
  $("#m-play").addEventListener("click", () => (musicRunning() ? pauseMusic() : startMusic(null)));
  $("#m-next").addEventListener("click", () => skip(1, false));
  $("#m-prev").addEventListener("click", () => skip(-1, false));
  $("#m-shuffle").addEventListener("click", () => act("setShuffle", !S.music.shuffle, shownSongId() ?? undefined));
  $("#m-repeat").addEventListener("click", () => act("setRepeat", { off: "all", all: "one", one: "off" }[S.music.repeat]));
  $("#m-volume").addEventListener("input", e => { audio.volume = Number(e.target.value) / 100; });
  $("#m-volume").addEventListener("change", e => act("setVolume", Number(e.target.value)));
  $("#m-seek").addEventListener("input", () => { ui.seeking = true; });
  $("#m-seek").addEventListener("change", e => {
    ui.seeking = false;
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
  });
  for (const b of document.querySelectorAll("[data-spend]")) {
    b.addEventListener("click", () => { if (b.dataset.spend !== S.spend_mode) act("setSpendMode", b.dataset.spend); });
  }

  /* ---------- streak ---------- */

  const filterId = () => (ui.streakFilter === "all" ? null : Number(ui.streakFilter));

  function renderStreakFilter() {
    const sel = $("#streak-filter");
    if (ui.streakFilter !== "all" && !swById(Number(ui.streakFilter))) ui.streakFilter = "all";
    sel.replaceChildren(
      h("option", { value: "all" }, "All classes"),
      ...S.stopwatches.map(sw => h("option", { value: sw.id }, sw.name + (sw.archived ? " (archived)" : ""))),
    );
    sel.value = ui.streakFilter;
  }

  const plural = n => `${n} day${n === 1 ? "" : "s"}`;

  function renderStreak() {
    const fid = filterId();
    const st = streaks(days, S.now_ms, fid);
    $("#streak-current").textContent = plural(st.current);
    $("#streak-longest").textContent = plural(st.longest);

    const today = startOfDay(S.now_ms);
    const first = startOfWeek(addDays(today, -7 * 52));
    let yearTotal = 0;
    for (let t = addDays(today, -364); t <= today; t = addDays(t, 1)) yearTotal += dayTotal(days, dayKey(t), fid);
    $("#streak-year").textContent = fmtDur(yearTotal);

    const CELL = 11, STEP = 14, LEFT = 30, TOP = 18;
    const el = $("#heatmap");
    el.replaceChildren();
    let col = 0, lastMonth = -1;
    for (let t = first; t <= today; t = addDays(t, 1)) {
      const d = new Date(t);
      const dow = d.getDay();
      if (dow === 0 && t !== first) col += 1;
      if (dow === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7) {
        lastMonth = d.getMonth();
        const label = svg("text", { x: LEFT + col * STEP, y: 11 });
        label.textContent = d.toLocaleDateString([], { month: "short" });
        el.append(label);
      }
      const key = dayKey(t);
      const cell = svg("rect", {
        x: LEFT + col * STEP, y: TOP + dow * STEP, width: CELL, height: CELL, rx: 2,
        fill: `var(--h${heatLevel(dayTotal(days, key, fid))})`, "data-day": key,
      });
      el.append(cell);
    }
    ["Mon", "Wed", "Fri"].forEach((name, i) => {
      const label = svg("text", { x: 0, y: TOP + (i * 2 + 1) * STEP + 9 });
      label.textContent = name;
      el.append(label);
    });
    el.setAttribute("width", LEFT + (col + 1) * STEP);
    el.setAttribute("height", TOP + 7 * STEP);
  }

  function dayTooltip(key) {
    const fid = filterId();
    const rows = [];
    const m = days.get(key) || new Map();
    if (fid == null) {
      [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([id, ms]) => rows.push([colorOf(id), swById(id)?.name ?? "?", ms]));
    }
    return {
      title: `${fmtDate(keyToTime(key))} · ${fmtDur(dayTotal(days, key, fid))}`,
      rows,
    };
  }

  /* ---------- report (screen-time style) ---------- */

  function renderReport() {
    for (const b of document.querySelectorAll(".seg-btn[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === ui.reportMode));
    $("#report-next").disabled = ui.reportOffset >= 0;
    if (ui.reportMode === "week") renderWeek(); else renderDay();
  }

  function seriesTotals(dayKeys) {
    const totals = new Map();   // series key -> {series, ms}
    for (const key of dayKeys) {
      for (const [id, ms] of days.get(key) || []) {
        const s = seriesOf(id);
        const cur = totals.get(s.key) || { series: s, ms: 0 };
        cur.ms += ms;
        totals.set(s.key, cur);
      }
    }
    return [...totals.values()].sort((a, b) => b.ms - a.ms);
  }

  function renderTable(totals) {
    const sum = totals.reduce((a, t) => a + t.ms, 0);
    $("#report-table tbody").replaceChildren(...(totals.length ? totals.map(t =>
      h("tr", {},
        h("td", {}, h("span", { class: "legend-item" }, h("span", { class: "dot", style: `background:${t.series.color}` }), t.series.name)),
        h("td", { class: "num" }, fmtDur(t.ms)),
        h("td", { class: "num" }, sum ? `${Math.round((t.ms / sum) * 100)}%` : "–"),
      )) : [h("tr", {}, h("td", { colspan: 3, class: "muted" }, "No study time in this range."))]));
  }

  function renderWeek() {
    const today = startOfDay(S.now_ms);
    const start = startOfWeek(addDays(today, ui.reportOffset * 7));
    const dayTimes = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const keys = dayTimes.map(dayKey);
    const end = dayTimes[6];
    $("#report-range").textContent = ui.reportOffset === 0 ? "This week" :
      `${fmtDate(start, { month: "short", day: "numeric" })} – ${fmtDate(end, { month: "short", day: "numeric", year: "numeric" })}`;

    const totals = keys.map(k => dayTotal(days, k, null));
    const weekTotal = totals.reduce((a, b) => a + b, 0);
    const elapsedDays = dayTimes.filter(t => t <= today).length;
    const avg = elapsedDays ? weekTotal / elapsedDays : 0;
    $("#report-total").textContent = fmtDur(weekTotal);
    $("#report-sub").textContent = `Daily average ${fmtDur(avg)}`;

    const series = seriesTotals(keys);
    const order = [...series].sort((a, b) => a.series.order - b.series.order).map(t => t.series);

    // geometry
    const W = Math.max(320, $("#report-chart").clientWidth || 600);
    const H = 220, L = 46, R = 10, T = 12, B = 30;
    const plotW = W - L - R, plotH = H - T - B;
    const maxMs = Math.max(...totals, avg, 30 * MIN);
    const step = niceStep(maxMs);
    const yMax = Math.ceil(maxMs / step) * step;
    const y = ms => T + plotH - (ms / yMax) * plotH;

    const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Study time per day this week, by class" });
    for (let v = 0; v <= yMax + 1; v += step) {
      chart.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--baseline)" : "var(--grid)", "stroke-width": 1 }));
      const label = svg("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" });
      label.textContent = v === 0 ? "0" : fmtDur(v);
      chart.append(label);
    }

    const band = plotW / 7;
    const barW = Math.min(24, band * 0.6);
    dayTimes.forEach((t, i) => {
      const cx = L + band * i + band / 2;
      const m = days.get(keys[i]) || new Map();
      const segs = order.map(s => {
        let ms = 0;
        for (const [id, v] of m) if (seriesOf(id).key === s.key) ms += v;
        return { s, ms };
      }).filter(x => x.ms > 0);
      let base = 0;
      segs.forEach((seg, j) => {
        const y0 = y(base), y1 = y(base + seg.ms);
        base += seg.ms;
        const gap = j > 0 ? 2 : 0;           // 2px surface gap between stacked segments
        const hgt = Math.max(0, y0 - y1 - gap);
        if (hgt <= 0) return;
        const top = j === segs.length - 1;
        chart.append(svg("path", { d: barPath(cx - barW / 2, y1, barW, hgt, top ? 4 : 0), fill: seg.s.color }));
      });
      const label = svg("text", { x: cx, y: H - 10, "text-anchor": "middle", class: t === today ? "today" : "" });
      label.textContent = new Date(t).toLocaleDateString([], { weekday: "short" });
      chart.append(label);
      chart.append(svg("rect", { x: L + band * i, y: T, width: band, height: plotH + B, fill: "transparent", "data-week-day": keys[i] }));
    });

    if (avg > 0) {
      chart.append(svg("line", { x1: L, x2: W - R, y1: y(avg), y2: y(avg), stroke: "var(--text-2)", "stroke-width": 1, "pointer-events": "none" }));
      const label = svg("text", { x: W - R, y: y(avg) - 5, "text-anchor": "end", "pointer-events": "none" });
      label.textContent = `avg ${fmtDur(avg)}`;
      chart.append(label);
    }

    $("#report-chart").replaceChildren(chart);
    $("#report-legend").replaceChildren(...(order.length > 1 ? order.map(s =>
      h("span", { class: "legend-item" }, h("span", { class: "dot", style: `background:${s.color}` }), s.name)) : []));
    renderTable(series);
  }

  /** Rect with rounded top corners only (the data end), square at the baseline. */
  function barPath(x, y, w, hgt, r) {
    r = Math.min(r, hgt, w / 2);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }

  function renderDay() {
    const today = startOfDay(S.now_ms);
    const t = addDays(today, ui.reportOffset);
    const key = dayKey(t);
    $("#report-range").textContent = ui.reportOffset === 0 ? "Today" : ui.reportOffset === -1 ? "Yesterday" :
      fmtDate(t, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    const total = dayTotal(days, key, null);
    let prev = 0;
    for (let i = 1; i <= 7; i++) prev += dayTotal(days, dayKey(addDays(t, -i)), null);
    $("#report-total").textContent = fmtDur(total);
    $("#report-sub").textContent = `Average of the 7 days before: ${fmtDur(prev / 7)}`;

    const series = seriesTotals([key]);
    const max = Math.max(1, ...series.map(s => s.ms));
    $("#report-chart").replaceChildren(series.length
      ? h("div", { class: "hbars" }, ...series.map(s =>
          h("div", { class: "hbar-row" },
            h("span", {}, s.series.name),
            h("div", { class: "hbar-track" }, h("div", { class: "hbar-fill", style: `width:${(s.ms / max) * 100}%;background:${s.series.color}` })),
            h("span", { class: "hbar-val" }, fmtDur(s.ms)))))
      : h("p", { class: "empty" }, "No study time on this day."));
    $("#report-legend").replaceChildren();
    renderTable(series);
  }

  /* ---------- session log ---------- */

  function renderLog() {
    const list = [...S.sessions].sort((a, b) => b.start_ms - a.start_ms);
    const shown = list.slice(0, ui.logLimit);
    $("#log-more").hidden = list.length <= ui.logLimit;
    const items = [];
    let lastDay = null;
    for (const s of shown) {
      const key = dayKey(s.start_ms);
      if (key !== lastDay) {
        lastDay = key;
        items.push(h("li", { class: "log-day" }, fmtDate(s.start_ms, { weekday: "long", month: "short", day: "numeric" })));
      }
      const sw = swById(s.stopwatch_id);
      const running = s.end_ms == null;
      items.push(h("li", { class: "log-row" },
        h("span", { class: "dot", style: `background:${colorOf(s.stopwatch_id)}` }),
        h("span", { class: "log-name" }, sw.name, sw.archived ? h("span", { class: "muted" }, " (archived)") : null),
        h("span", { class: "log-time" }, `${fmtTime(s.start_ms)} – ${running ? "now" : fmtTime(s.end_ms)}`),
        h("span", { class: "log-dur" }, running ? "running" : fmtDur(s.end_ms - s.start_ms)),
        running ? null : h("button", { type: "button", class: "btn-link btn-small", onclick: () => openSessionDialog(s) }, "Edit"),
        running ? null : h("button", {
          type: "button", class: "btn-link btn-small danger",
          onclick: () => { if (confirm(`Delete this ${fmtDur(s.end_ms - s.start_ms)} ${sw.name} session?`)) act("deleteSession", s.id); },
        }, "Delete"),
      ));
    }
    $("#log").replaceChildren(...(items.length ? items : [h("li", { class: "empty" }, "No sessions yet. Start a stopwatch!")]));
  }

  /* ---------- archive ---------- */

  function renderArchive() {
    const archived = S.stopwatches.filter(s => s.archived);
    $("#archive-count").textContent = archived.length;
    $("#archive").replaceChildren(...(archived.length ? archived.map(sw => {
      const total = S.sessions.filter(s => s.stopwatch_id === sw.id).reduce((a, s) => a + (s.end_ms - s.start_ms), 0);
      return h("li", { class: "archive-row" },
        h("span", { class: "dot", style: `background:${colorOf(sw.id)}` }),
        h("span", { class: "log-name" }, sw.name),
        h("span", { class: "log-time" }, fmtDur(total)),
        h("button", { type: "button", class: "btn-link btn-small", onclick: () => act("restoreStopwatch", sw.id) }, "Restore"),
        h("button", {
          type: "button", class: "btn-link btn-small danger",
          onclick: () => {
            if (confirm(`Delete "${sw.name}" for good? This erases ${fmtDur(total)} of study history and the game time it earned. This can't be undone.`)) {
              act("deleteStopwatch", sw.id);
            }
          },
        }, "Delete forever"));
    }) : [h("li", { class: "muted small" }, "Nothing archived.")]));
  }

  /* ---------- dialogs ---------- */

  function openNameDialog(sw) {
    ui.renameId = sw ? sw.id : null;
    $("#name-title").textContent = sw ? "Rename stopwatch" : "New stopwatch";
    $("#name-input").value = sw ? sw.name : "";
    $("#name-error").textContent = "";
    $("#name-dialog").showModal();
    $("#name-input").select();
  }

  $("#name-form").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("#name-input").value;
    const err = ui.renameId == null
      ? run("addStopwatch", name)
      : run("renameStopwatch", ui.renameId, name);
    if (err) $("#name-error").textContent = err;
    else $("#name-dialog").close();
  });
  $("#name-cancel").addEventListener("click", () => $("#name-dialog").close());

  function openSessionDialog(session) {
    ui.editSession = session;
    const choices = S.stopwatches.filter(sw => !sw.archived || (session && sw.id === session.stopwatch_id));
    if (!choices.length) { showError("Add a stopwatch first."); return; }
    $("#session-sw").replaceChildren(...choices.map(sw => h("option", { value: sw.id }, sw.name)));
    const end = session ? session.end_ms : Math.floor(now() / MIN) * MIN;
    const start = session ? session.start_ms : end - HOUR;
    $("#session-sw").value = session ? session.stopwatch_id : choices[0].id;
    $("#session-sw").disabled = !!session;
    $("#session-start").value = toLocalInput(start);
    $("#session-end").value = toLocalInput(end);
    $("#session-title").textContent = session ? "Edit session" : "Add a session";
    $("#session-error").textContent = "";
    $("#session-dialog").showModal();
  }

  $("#session-form").addEventListener("submit", e => {
    e.preventDefault();
    const s = ui.editSession;
    // Keep the original seconds if a field wasn't changed.
    const read = (input, original) =>
      original != null && input.value === toLocalInput(original) ? original : new Date(input.value).getTime();
    const start_ms = read($("#session-start"), s && s.start_ms);
    const end_ms = read($("#session-end"), s && s.end_ms);
    if (Number.isNaN(start_ms) || Number.isNaN(end_ms)) { $("#session-error").textContent = "Fill in both times."; return; }
    const err = s
      ? run("updateSession", s.id, start_ms, end_ms)
      : run("addSession", Number($("#session-sw").value), start_ms, end_ms);
    if (err) $("#session-error").textContent = err;
    else $("#session-dialog").close();
  });
  $("#session-cancel").addEventListener("click", () => $("#session-dialog").close());

  /* ---------- tooltip ---------- */

  const tip = $("#tooltip");
  function showTip(e, content) {
    tip.replaceChildren(
      h("div", { class: "tt-title" }, content.title),
      ...content.rows.map(([color, name, ms]) =>
        h("div", { class: "tt-row" }, h("span", { class: "dot", style: `background:${color}` }), h("span", {}, name), h("span", {}, fmtDur(ms)))),
    );
    tip.hidden = false;
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  $("#heatmap").addEventListener("mousemove", e => {
    const key = e.target.dataset && e.target.dataset.day;
    if (key) showTip(e, dayTooltip(key)); else hideTip();
  });
  $("#heatmap").addEventListener("mouseleave", hideTip);

  $("#report-chart").addEventListener("mousemove", e => {
    const key = e.target.dataset && e.target.dataset.weekDay;
    if (!key) return hideTip();
    const m = days.get(key) || new Map();
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id, ms]) => [colorOf(id), swById(id)?.name ?? "?", ms]);
    showTip(e, { title: `${fmtDate(keyToTime(key))} · ${fmtDur(dayTotal(days, key, null))}`, rows });
  });
  $("#report-chart").addEventListener("mouseleave", hideTip);

  /* ---------- wiring ---------- */

  $("#add-sw-btn").addEventListener("click", () => openNameDialog(null));
  $("#add-session-btn").addEventListener("click", () => openSessionDialog(null));
  $("#game-btn").addEventListener("click", () => {
    if (runningGame()) act("stopGame");
    else { $("#times-up").hidden = true; act("startGame"); }
  });
  $("#times-up-close").addEventListener("click", () => { $("#times-up").hidden = true; });
  $("#streak-filter").addEventListener("change", e => { ui.streakFilter = e.target.value; renderStreak(); });
  for (const b of document.querySelectorAll(".seg-btn[data-mode]")) {
    b.addEventListener("click", () => { ui.reportMode = b.dataset.mode; ui.reportOffset = 0; renderReport(); });
  }
  $("#report-prev").addEventListener("click", () => { ui.reportOffset -= 1; renderReport(); });
  $("#report-next").addEventListener("click", () => { ui.reportOffset = Math.min(0, ui.reportOffset + 1); renderReport(); });
  $("#log-more").addEventListener("click", () => { ui.logLimit += 25; renderLog(); });

  $("#import-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let backup;
    try {
      backup = validateData(JSON.parse(await file.text()));
    } catch (err) {
      showError("That file isn't a Study Timer backup.");
      return;
    }
    if (!confirm("Replace ALL current stopwatches and history with this backup? Export a backup first if you're unsure.")) return;
    data = backup;
    data.saved_ms = now();
    persist();
    render();
    showNotice("Backup imported.");
  });
  $("#export-btn").addEventListener("click", exportBackup);
  $("#reconnect-btn").addEventListener("click", reconnectFile);

  // Browsers only allow sound after a click; unlock audio on the first one.
  document.addEventListener("click", () => {
    try { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); } catch (e) { /* ignore */ }
  }, { once: true });

  window.addEventListener("resize", () => { if (S && ui.reportMode === "week") renderWeek(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

  // Another tab changed the data: pick it up.
  window.addEventListener("storage", e => {
    if (e.key === LS_KEY) { data = loadLocal(); render(); }
  });

  // Closing or reloading the page stops the music, so stop spending game time on it too.
  window.addEventListener("pagehide", () => { if (musicRunning()) pauseMusic(); });

  data = loadLocal();
  // Music left "running" with no page open (a crash, say) ends at the last save. That's within
  // 15 seconds while music plays. If the last save is newer, another tab may be playing it.
  const stale = data.game_sessions.find(g => g.end_ms == null && g.kind === "music");
  if (stale && now() - data.saved_ms > 20 * 1000) {
    const lastSave = Math.max(stale.start_ms, data.saved_ms);
    if (!settleGame(data, lastSave)) stale.end_ms = lastSave;   // unless it ran out even earlier
    data.saved_ms = now();
    saveLocal();
  }
  render();
  renderFileStatus();
  restoreFileLink();

  setInterval(tick, 250);
  setInterval(render, 30 * 1000);   // keeps charts current while a stopwatch runs
}
