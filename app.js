"use strict";

const $ = id => document.getElementById(id);
const initialState = {
  queue: [], events: [],
  settings: { auto: true, scheduler: false, output: "stereo", sinkId: "", gain: 65, fade: 2, rotation: false,
    keyLock: true, artwork: true, rotateArtwork: true, checkUpdates: false, processor: PROCESSOR_DEFAULTS }
};
const tracks = new Map();
let state, store, engine;
let recent = [];
let nextRotation;
let editingTrack, editingEvent, removing;
let storageFault = false;
let settingsImporting = false;
let libraryLimit = 150;
let orderedLibrary = null;
const selected = { queue: new Set(), library: new Set() };
let libraryMatches = [];
let dragged = null;
let highlightedDrop = null;
let highlightedRow = null;
const audioExtension = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|aif|aiff|wma)$/i;

function note(message, error = false) {
  $("message").textContent = message;
  $("message").dataset.error = String(error);
}

function storageError(error) {
  storageFault = true;
  note("Local storage error. Changes or history may be unsaved. " + error.message, true);
}

function save() {
  return store.save(state).catch(storageError);
}

function timecode(seconds) {
  if (!Number.isFinite(seconds)) return "–";
  const total = Math.max(0, Math.floor(seconds));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

function localStamp(date) {
  const pad = number => String(number).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")
    + "T" + [pad(date.getHours()), pad(date.getMinutes())].join(":");
}

function entryFor(item) {
  if (item?.stop) return item;
  const track = item && tracks.get(item.trackId);
  return track ? { ...item, track } : null;
}

function rotationTrack() {
  if (!state.settings.rotation || !state.settings.auto) return null;
  const candidates = Array.from(tracks.values()).filter(track => track.rotation);
  const index = candidates.findIndex(track => track.id === nextRotation);
  return candidates.length ? candidates[(index + 1) % candidates.length] : null;
}

function peek(allowRotation) {
  const queued = entryFor(state.queue[0]);
  if (queued || !allowRotation) return queued;
  const track = rotationTrack();
  return track ? { id: workstationId(), track, trackId: track.id, source: "Rotation" } : null;
}

function consume(entry) {
  if (entry.source === "Rotation") {
    nextRotation = entry.track.id;
  } else {
    state.queue = state.queue.filter(item => item.id !== entry.id);
    save();
  }
  drawQueue();
}

function record(entry, event, detail = "", deck, position = null) {
  const row = { at: new Date().toISOString(), trackId: entry?.trackId || "",
    title: entry?.track?.title || (entry?.stop ? "Stop and recue" : ""), artist: entry?.track?.artist || "",
    event, source: entry?.source || "Operator", detail, deck: deck?.name || "", position };
  recent.unshift(row);
  if (recent.length > 200) recent.pop();
  store.log(row).catch(storageError);
  if (!$("view-history").hidden) drawHistory();
}

function cell(row, value) {
  const td = row.insertCell();
  td.textContent = value;
  return td;
}

function trackCell(row, track, detail, draggable = false) {
  const td = cell(row, track.title);
  if (draggable) {
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⠿";
    td.className = "drag-name";
    td.prepend(grip);
  }
  if (detail) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = detail;
    td.append(meta);
  }
}

function action(td, label, handler, title = label) {
  td.className = "actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", handler);
  td.append(button);
  return button;
}

function queueUpdated() {
  save();
  engine.prepare();
  drawQueue();
  drawDecks();
}

function newEntry(track) {
  return { id: workstationId(), trackId: track.id, source: "Manual" };
}

function enqueue(track) {
  const entry = newEntry(track);
  state.queue.push(entry);
  record(entryFor(entry), "Queued");
  queueUpdated();
  note("Queued " + track.title + ".");
}

function pendingId() {
  return engine.pending?.entry.id;
}

function place(from, id, to, anchor, after) {
  if ((from !== "library" && id === pendingId()) || (from === to && id === anchor)) return;
  const origin = from === "library" ? null : state[from];
  const sourceIndex = origin ? origin.findIndex(row => row.id === id) : -1;
  const entry = origin ? origin[sourceIndex] : tracks.has(id) && newEntry(tracks.get(id));
  if (!entry) return;
  const target = state[to];
  if (origin) origin.splice(sourceIndex, 1);
  const anchorIndex = target.findIndex(row => row.id === anchor);
  const offset = anchorIndex < 0 ? target.length : anchorIndex + (after ? 1 : 0);
  const minimum = to === "queue" && target[0] && target[0].id === pendingId() ? 1 : 0;
  target.splice(Math.max(offset, minimum), 0, entry);
  record(entryFor(entry), from === "library" ? "Queued" : "Queue reordered");
  if (from === "library" && selected.library.delete(id)) drawLibrary();
  queueUpdated();
}

function beginTrackDrag(row, list, id) {
  const selection = selected[list];
  const ids = !selection?.has(id) ? [id] : list === "queue"
    ? state.queue.filter(item => selection.has(item.id) && item.id !== pendingId()).map(item => item.id)
    : orderedLibrary.filter(({ track }) => selection.has(track.id)).map(({ track }) => track.id);
  dragged = { list, id, ids, row };
  row.classList.add("dragging");
}

function dragRow(row, list, id, locked = false) {
  row.dataset.entry = id;
  if (locked) return;
  if (window.stationPilotLinux) {
    bindPointerDrag(row, list, id);
    return;
  }
  row.draggable = true;
  row.addEventListener("dragstart", event => {
    if (!event.dataTransfer) return event.preventDefault();
    beginTrackDrag(row, list, id);
    event.dataTransfer.setData("application/x-station-pilot-track", id);
    event.dataTransfer.setData("text/plain", row.querySelector(".drag-name")?.textContent || row.textContent);
    event.dataTransfer.effectAllowed = list === "library" ? "copy" : "move";
  });
  row.addEventListener("dragend", finishDrag);
}

function bindPointerDrag(row, list, id) {
  let press;
  row.classList.add("pointer-drag");
  row.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest("button, input, select, textarea, a")) return;
    if (event.pointerType === "touch" && !event.target.closest(".grip")) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    row.setPointerCapture(event.pointerId);
  });
  row.addEventListener("pointermove", event => {
    if (press?.id !== event.pointerId) return;
    if (!dragged && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 5) {
      beginTrackDrag(row, list, id);
    }
    if (dragged?.row !== row) return;
    event.preventDefault();
    clearDrop();
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const zone = target?.closest("[data-drop]");
    if (acceptsTrackDrop(zone)) highlightDrop(zone, { target, clientY: event.clientY });
  });
  row.addEventListener("pointerup", event => {
    if (press?.id !== event.pointerId) return;
    press = null;
    if (dragged?.row !== row) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const zone = target?.closest("[data-drop]");
    const source = dragged;
    if (acceptsTrackDrop(zone)) {
      const { row: anchor, after } = dropPosition({ target, clientY: event.clientY }, zone);
      finishDrag();
      dropTracks(source, zone.dataset.drop, anchor?.dataset.entry, after);
    } else {
      finishDrag();
    }
  });
  row.addEventListener("lostpointercapture", () => {
    press = null;
    if (dragged?.row === row) finishDrag();
  });
}

const estimateClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

function drawQueueEstimates() {
  const lead = engine.current;
  const remaining = deck => deck ? (deck.audio.duration - engine.position(deck)) / deck.audio.playbackRate : 0;
  const tail = Math.max(remaining(lead), remaining(engine.secondary), 0);
  let offset = tail;
  let duration = lead ? lead.audio.duration / lead.audio.playbackRate : 0;
  let canOverlap = Boolean(lead && !engine.secondary);
  let held = false;
  let waiting = !lead || !state.settings.auto || lead.audio.paused || Boolean(engine.cues.size);
  const cells = $("queue").querySelectorAll("[data-estimate]");
  state.queue.forEach((item, i) => {
    const td = cells[i];
    if (!td || td.dataset.estimate !== item.id) return;
    const length = tracks.get(item.trackId)?.duration;
    if (!held && canOverlap && !item.stop && item.source !== "Scheduled") {
      // Match the automation trigger and keep the estimate within the time left on air.
      const trigger = Math.min(state.settings.fade, duration / 2);
      if (trigger >= FADE_GUARD) offset = Math.max(0, offset - Math.min(trigger, i === 0 ? tail : duration));
    }
    let label;
    if (held) label = "On hold";
    else if (!Number.isFinite(offset)) label = "—";
    else if (!i && item.id === pendingId()) label = "Starting";
    else if (!i && !lead) label = "On Play";
    else label = estimateClock.format(new Date(Date.now() + offset * 1000));
    if (td.textContent !== label) td.textContent = label;
    td.title = held ? "Playout is held by a stop and recue marker."
      : waiting ? "Estimated start assuming playback begins or resumes now and continues in queue order."
      : "Estimated local start time.";
    if (item.stop) held = true;
    else offset += length ?? NaN;
    duration = length;
    canOverlap = true;
  });
}

const probedDurations = new WeakSet();
let durationWorkers = 0;
let durationScanPending = false;
let durationPaintPending = false;
let durationTasks = [];

function durationCell(row, track) {
  const value = track.missing ? "Missing file" : timecode(track.duration);
  cell(row, value).dataset.duration = track.id;
}

function refreshDurations() {
  if (durationPaintPending) return;
  durationPaintPending = true;
  requestAnimationFrame(() => {
    durationPaintPending = false;
    for (const cell of document.querySelectorAll("[data-duration]")) {
      const track = tracks.get(cell.dataset.duration);
      cell.textContent = track?.missing ? "Missing file" : timecode(track?.duration);
    }
    drawQueueEstimates();
  });
}

function scanDurations() {
  if (dockShared || durationScanPending) return;
  durationScanPending = true;
  setTimeout(() => {
    durationScanPending = false;
    const priority = new Set(state.queue.map(item => item.trackId));
    for (const { track } of libraryMatches) priority.add(track.id);
    for (const id of tracks.keys()) priority.add(id);
    durationTasks = [...priority].map(id => tracks.get(id)).filter(track =>
      track && !track.missing && !Number.isFinite(track.duration) && !probedDurations.has(track));
    runDurationScan();
  }, 50);
}

function runDurationScan() {
  while (durationWorkers < 3 && durationTasks.length) {
    const track = durationTasks.shift();
    if (tracks.get(track.id) !== track || Number.isFinite(track.duration) || probedDurations.has(track)) continue;
    probedDurations.add(track);
    durationWorkers++;
    store.readAudio(track).then(file => file && probe(file)).then(seconds => {
      if (seconds && tracks.get(track.id) === track && !Number.isFinite(track.duration)) saveAudioDuration(track, seconds);
    }).catch(() => { /* Inaccessible audio can be retried after relinking. */ }).finally(() => {
      durationWorkers--;
      runDurationScan();
    });
  }
}

let categoryTargets = [];
let menuAnchor = null;

function closeRowMenu(restoreFocus = false) {
  $("row-menu").hidden = true;
  if (restoreFocus && menuAnchor?.isConnected) menuAnchor.focus({ preventScroll: true });
  menuAnchor = null;
}

function openCategoryAssignment(ids) {
  categoryTargets = ids;
  loadCategoryPicker($("assign-category"));
  $("assign-summary").textContent = ids.length === 1 ? tracks.get(ids[0]).title : ids.length + " selected tracks";
  $("assign-category-dialog").showModal();
}

function insertStop(anchor, after) {
  const index = state.queue.findIndex(item => item.id === anchor);
  if (index < 0 && anchor) return;
  const marker = { id: workstationId(), stop: true, source: "Operator" };
  const slot = index < 0 ? state.queue.length : index + Number(after);
  state.queue.splice(Math.max(slot, state.queue[0]?.id === pendingId() && pendingId() ? 1 : 0), 0, marker);
  record(marker, "Stop and recue inserted");
  queueUpdated();
}

function showRowMenu(event, row, list, id, keyboard = false) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $("row-menu");
  menu.replaceChildren();
  const add = (name, run, disabled = false) => {
    const button = divButton(menu, name, () => { closeRowMenu(true); run(); });
    button.setAttribute("role", "menuitem");
    button.disabled = disabled;
  };
  const item = list === "queue" ? state.queue.find(item => item.id === id) : null;
  const track = tracks.get(item?.trackId || id);
  if (track) {
    const selection = selected[list];
    const ids = selection?.has(id) ? [...new Set([...selection].map(key =>
      list === "queue" ? state.queue.find(item => item.id === key)?.trackId : key).filter(key => tracks.has(key)))] : [track.id];
    if (list !== "queue") add("Add to queue", () => {
      for (const key of ids) enqueue(tracks.get(key));
    }, track.missing);
    if (!dockShared) {
      add(ids.length > 1 ? "Assign category to " + ids.length + " tracks…" : "Assign category…", () => openCategoryAssignment(ids));
      add("Edit track…", () => editTrack(track));
      if (track.missing) add("Locate file…", () => promptReconnect(track, null));
    }
    for (const deck of ["A", "B"]) {
      add("Cue on Deck " + deck, () => cueDropped(deck, item || newEntry(track)), track.missing || item?.id === pendingId() && Boolean(item));
    }
  }
  if (list === "queue") {
    if (item) {
      add("Insert stop and recue before", () => insertStop(id, false), id === pendingId());
      add("Insert stop and recue after", () => insertStop(id, true));
      add("Remove from queue", () => removeQueue(new Set([id])), id === pendingId());
    } else add("Insert stop and recue", () => insertStop(null, true));
  }
  if (!menu.childElementCount) return;
  const bounds = row.getBoundingClientRect();
  menuAnchor = row;
  menu.hidden = false;
  menu.style.left = Math.max(6, Math.min(keyboard ? bounds.left : event.clientX, innerWidth - menu.offsetWidth - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(keyboard ? bounds.bottom : event.clientY, innerHeight - menu.offsetHeight - 6)) + "px";
  menu.querySelector("button:not(:disabled)")?.focus();
}

function bindRowMenu(row, list, id) {
  row.tabIndex = -1;
  row.addEventListener("contextmenu", event => showRowMenu(event, row, list, id, !event.clientX && !event.clientY));
  row.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") showRowMenu(event, row, list, id, true);
  });
}

function bindRowMenus() {
  const menu = $("row-menu");
  if (windowsBridge || window.stationPilotUnix) {
    document.addEventListener("contextmenu", event => {
      const field = event.target.closest("input, textarea, [contenteditable]");
      if (!(field instanceof HTMLTextAreaElement || field?.isContentEditable ||
            field instanceof HTMLInputElement && ["text", "search", "number", "url", "email", "password", "tel"].includes(field.type))) {
        event.preventDefault();
      }
    });
  }
  document.querySelector(".queue").addEventListener("contextmenu", event => showRowMenu(event, event.target, "queue", null));
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) closeRowMenu(); });
  document.addEventListener("dragstart", () => closeRowMenu());
  window.addEventListener("resize", () => closeRowMenu());
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      closeRowMenu(true);
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + items.length + (event.key === "ArrowUp" ? -1 : 1)) % items.length;
      items[next]?.focus();
    }
  });
  $("assign-category-form").addEventListener("submit", async event => {
    event.preventDefault();
    const category = chosenCategory($("assign-category"));
    if (category === null) return;
    const originals = categoryTargets.map(id => tracks.get(id)).filter(Boolean);
    const previous = originals.map(track => track.category);
    originals.forEach(track => { track.category = category; });
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      // Submit the updated copies together in one storage transaction.
      await store.saveLinks(originals);
      orderedLibrary = null;
      record(originals.length === 1 ? { track: originals[0], trackId: originals[0].id } : null,
        "Category assigned", category + " · " + originals.length + (originals.length === 1 ? " track" : " tracks"));
      drawLibrary();
      $("assign-category-dialog").close();
      notify("Assigned " + originals.length + (originals.length === 1 ? " track to " : " tracks to ") + category + ".");
    } catch (error) {
      originals.forEach((track, index) => { track.category = previous[index]; });
      storageError(error);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

function drawQueue() {
  const list = "queue";
  const tbody = $("queue");
  tbody.replaceChildren();
  const items = state[list];
  const available = new Set(items.map(item => item.id));
  for (const id of selected.queue) if (!available.has(id) || id === pendingId()) selected.queue.delete(id);
  items.forEach((item, index) => {
    const track = tracks.get(item.trackId) || { title: "Stop and recue", artist: "" };
    const row = tbody.insertRow();
    row.toggleAttribute("data-marker", Boolean(item.stop));
    bindRowMenu(row, "queue", item.id);
    const locked = pendingId() === item.id;
    dragRow(row, list, item.id, locked);
    selectCell(row, list, item.id, "Select queued " + track.title, locked);
    trackCell(row, track, [track.artist, item.source === "Scheduled" ? "Scheduled insert" : ""].filter(Boolean).join(" · "), !locked);
    if (item.stop) cell(row, "—");
    else durationCell(row, track);
    cell(row, "").dataset.estimate = item.id;
    const td = cell(row, "");
    const before = items[index - 1];
    const after = items[index + 1];
    action(td, "↑", () => place(list, item.id, list, before.id, false), "Move " + track.title + " up")
      .disabled = !before || locked || before.id === pendingId();
    action(td, "↓", () => place(list, item.id, list, after.id, true), "Move " + track.title + " down")
      .disabled = !after || locked || after.id === pendingId();
    action(td, "×", () => {
      if (pendingId() === item.id) return;
      removeQueue(new Set([item.id]));
    }, "Remove " + track.title + " from queue").disabled = locked;
  });
  const count = items.filter(item => !item.stop).length;
  const markers = items.length - count;
  $(list + "-count").textContent = count + (count === 1 ? " track" : " tracks") + (markers ? " · " + markers + (markers === 1 ? " stop" : " stops") : "");
  drawQueueEstimates();
  scanDurations();
  $(list + "-empty").hidden = items.length !== 0;
  updateSelection("queue");
}

function selectCell(row, list, id, label, disabled = false) {
  const td = cell(row, "");
  td.className = "selection-cell";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("aria-label", label);
  input.checked = selected[list].has(id);
  input.disabled = disabled;
  input.addEventListener("change", () => {
    if (input.checked) selected[list].add(id);
    else selected[list].delete(id);
    updateSelection(list);
  });
  td.append(input);
}

function updateSelection(list) {
  const count = selected[list].size;
  $(list + "-selection").textContent = count ? count + " selected" : "";
  $(list + "-deselect").disabled = $(list + "-remove-selected").disabled = count === 0;
  if (list === "queue") {
    const available = state.queue.some(item => item.id !== pendingId());
    $("queue-select-all").disabled = $("queue-clear").disabled = !available;
  } else {
    $("library-select-all").disabled = !libraryMatches.length;
    $("library-queue-selected").disabled = count === 0;
    if (dockShared) $("library-remove-selected").disabled = true;
  }
}

function removeQueue(ids) {
  const removed = state.queue.filter(item => ids.has(item.id) && item.id !== pendingId());
  const before = state.queue.length;
  state.queue = state.queue.filter(item => !ids.has(item.id) || item.id === pendingId());
  const removedIds = new Set(removed.map(item => item.id));
  for (const [name, cue] of engine.cues) if (removedIds.has(cue.id)) engine.clearCue(name);
  if (removed.length === 1) record(entryFor(removed[0]), "Removed from queue");
  if (removed.length > 1) record(null, "Queue items removed", removed.length + " items");
  queueUpdated();
  const count = before - state.queue.length;
  if (count) notify(count + (count === 1 ? " track removed from the queue." : " tracks removed from the queue."));
}

function bindBatch() {
  $("queue-select-all").addEventListener("click", () => {
    for (const item of state.queue) if (item.id !== pendingId()) selected.queue.add(item.id);
    drawQueue();
  });
  $("library-select-all").addEventListener("click", () => {
    for (const { track } of libraryMatches) selected.library.add(track.id);
    drawLibrary();
  });
  for (const [list, redraw] of [["queue", drawQueue], ["library", drawLibrary]]) {
    $(list + "-deselect").addEventListener("click", () => { selected[list].clear(); redraw(); });
  }
  $("queue-remove-selected").addEventListener("click", () => removeQueue(selected.queue));
  $("queue-clear").addEventListener("click", () => $("clear-queue-dialog").showModal());
  $("clear-queue-form").addEventListener("submit", event => {
    event.preventDefault();
    $("clear-queue-dialog").close();
    removeQueue(new Set(state.queue.map(item => item.id)));
  });
  $("library-queue-selected").addEventListener("click", () => {
    const batch = orderedLibrary.filter(({ track }) => selected.library.has(track.id));
    for (const { track } of batch) state.queue.push(newEntry(track));
    if (batch.length) record(null, "Tracks queued", batch.length + " tracks from Library");
    queueUpdated();
    notify(batch.length + (batch.length === 1 ? " track queued." : " tracks queued."));
  });
  $("library-remove-selected").addEventListener("click", () => {
    confirmRemoveTracks(Array.from(selected.library, id => tracks.get(id)).filter(Boolean));
  });
}

function notify(message, error = false) {
  note(message, error);
  showToast(message, error);
}

function drawLibrary() {
  const query = $("search").value.toLowerCase().trim();
  const tbody = $("library");
  tbody.replaceChildren();
  if (!orderedLibrary) {
    orderedLibrary = Array.from(tracks.values()).sort((a, b) => a.title.localeCompare(b.title)).map(track => ({
      track, text: [track.title, track.artist, track.category, track.fileName].join(" ").toLowerCase()
    }));
  }
  const words = query.split(/\s+/);
  const matches = query ? orderedLibrary.filter(row => words.every(word => row.text.includes(word))) : orderedLibrary;
  libraryMatches = matches;
  for (const id of selected.library) if (!tracks.has(id)) selected.library.delete(id);
  for (const { track } of matches.slice(0, libraryLimit)) {
    const row = tbody.insertRow();
    dragRow(row, "library", track.id);
    bindRowMenu(row, "library", track.id);
    selectCell(row, "library", track.id, "Select " + track.title);
    row.addEventListener("dblclick", event => {
      if (!event.target.closest("button, input")) {
        if (track.missing) promptReconnect(track, null);
        else enqueue(track);
      }
    });
    trackCell(row, track, track.artist || track.fileName, true);
    cell(row, track.category || "—");
    durationCell(row, track);
    const td = cell(row, "");
    action(td, "＋ Queue", () => enqueue(track), "Queue " + track.title);
    if (!dockShared) {
      action(td, "Edit", () => editTrack(track), "Edit " + track.title);
      if (track.missing) action(td, "Locate", () => promptReconnect(track, null), "Locate " + track.title);
      else if (track.source?.handle) action(td, "Access", () => promptReconnect(track), "Reconnect " + track.title);
      action(td, "×", () => confirmRemove(track), "Remove " + track.title + " from library");
    }
  }
  $("library-empty").hidden = matches.length !== 0;
  $("library-empty").textContent = query ? "No matching tracks." : "Link files or a folder to begin.";
  drawExplorerViews();
  scanDurations();
  $("library-count").textContent = matches.length > libraryLimit
    ? "Showing " + libraryLimit + " of " + matches.length + " tracks"
    : query ? matches.length + " of " + tracks.size + " tracks" : tracks.size + " tracks";
  $("more-tracks").hidden = matches.length <= libraryLimit;
  $("add-event").disabled = !tracks.size;
  updateSelection("library");
}

function clearDrop() {
  if (highlightedDrop) highlightedDrop.classList.remove("drop-active");
  if (highlightedRow) delete highlightedRow.dataset.insert;
  highlightedDrop = highlightedRow = null;
}

function finishDrag() {
  if (dragged) dragged.row.classList.remove("dragging");
  dragged = null;
  clearDrop();
}

function fileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function dropZone(event) {
  return event.target.closest("[data-drop]") || (fileDrag(event) && !($("view-library").hidden) ? $("view-library") : null);
}

function dropPosition(event, zone) {
  if (["A", "B"].includes(zone.dataset.drop)) return { row: null, after: false };
  const row = zone.contains(event.target) ? event.target.closest("tr[data-entry]") : null;
  if (!row) return { row: null, after: false };
  const bounds = row.getBoundingClientRect();
  return { row, after: event.clientY >= bounds.top + bounds.height / 2 };
}

function highlightDrop(zone, position) {
  highlightedDrop = zone;
  zone.classList.add("drop-active");
  const { row, after } = dropPosition(position, zone);
  if (row && zone.dataset.drop !== "library") {
    highlightedRow = row;
    row.dataset.insert = after ? "after" : "before";
  }
}

function cueDropped(name, entry) {
  const loaded = entryFor(entry);
  if (!loaded || loaded.stop || entry.id === pendingId()) return;
  engine.cue(name, loaded);
  state.queue = state.queue.filter(item => item.id !== entry.id);
  queueUpdated();
  note("Deck " + name + " cued · " + loaded.track.title);
}

function acceptsTrackDrop(zone) {
  if (!zone || !dragged || zone.dataset.drop === "library") return false;
  return !["A", "B"].includes(zone.dataset.drop) || dragged.list !== "queue"
    || !state.queue.some(item => item.id === dragged.id && item.stop);
}

function dropTracks(source, list, anchor, after) {
  if (list === "A" || list === "B") {
    const track = source.list === "library" ? tracks.get(source.id) : null;
    const entry = source.list === "queue" ? state.queue.find(item => item.id === source.id) : track && newEntry(track);
    if (entry) cueDropped(list, entry);
  } else if (list === "queue") {
    if (source.ids.length === 1) place(source.list, source.id, list, anchor, after);
    else if (source.list === "library" || !source.ids.includes(anchor)) {
      const ids = new Set(source.ids);
      const group = source.list === "queue" ? state.queue.filter(item => ids.has(item.id))
        : source.ids.map(id => tracks.get(id)).filter(Boolean).map(newEntry);
      if (!group.length) return;
      if (source.list === "queue") state.queue = state.queue.filter(item => !ids.has(item.id));
      else {
        for (const item of group) selected.library.delete(item.trackId);
        drawLibrary();
      }
      const index = state.queue.findIndex(item => item.id === anchor);
      const slot = index < 0 ? state.queue.length : index + Number(after);
      state.queue.splice(Math.max(slot, state.queue[0]?.id === pendingId() && pendingId() ? 1 : 0), 0, ...group);
      record(null, source.list === "queue" ? "Queue reordered" : "Tracks queued", group.length + " items");
      queueUpdated();
    }
  }
}

function bindDrop() {
  document.addEventListener("dragover", event => {
    const external = fileDrag(event);
    if (external || dragged) event.preventDefault();
    clearDrop();
    const zone = dropZone(event);
    if (!zone || (!external && !acceptsTrackDrop(zone))) {
      if (external || dragged) event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = external || dragged.list === "library" ? "copy" : "move";
    highlightDrop(zone, event);
  });
  document.addEventListener("dragleave", event => {
    if (!event.relatedTarget && event.target === document.documentElement) clearDrop();
  });
  document.addEventListener("drop", async event => {
    const external = fileDrag(event);
    if (!external && !dragged) return;
    event.preventDefault();
    // Files dropped outside a panel go to the library.
    const zone = dropZone(event);
    const list = zone ? zone.dataset.drop : "library";
    const { row, after } = zone ? dropPosition(event, zone) : { row: null, after: false };
    const anchor = row ? row.dataset.entry : null;
    const source = dragged;
    finishDrag();
    if (!external) {
      dropTracks(source, list, anchor, after);
      return;
    }
    if (dockShared) return notify("Link music in the Station Pilot desktop app.", true);
    const targetDeck = ["A", "B"].includes(list) ? list : null;
    const droppedFiles = Array.from(event.dataTransfer.files);
    const tasks = Array.from(event.dataTransfer.items).filter(item => item.kind === "file")
      .map(item => item.getAsFileSystemHandle?.());
    let handles = (await Promise.allSettled(tasks)).flatMap(result =>
      result.status === "fulfilled" && result.value ? [result.value] : []);
    if (nativePickerReady && droppedFiles.length && window.chrome?.webview?.postMessageWithAdditionalObjects) {
      try { handles = await nativeDropHandles(droppedFiles); }
      catch { /* Browsers can supply an ordinary read handle for virtual files. */ }
    }
    if (!handles.length) return notify("Use Link audio or Link folder to keep a reference to these originals.", true);
    if (targetDeck && (handles.length !== 1 || handles[0].kind !== "file")) {
      return notify("Drop one audio file on a deck. Drop folders or multiple songs on the queue.", true);
    }
    previewMusic(handles, { list, anchor, after, targetDeck });
  });
}

function drawSchedule() {
  const tbody = $("schedule");
  tbody.replaceChildren();
  for (const scheduled of state.events) {
    const row = tbody.insertRow();
    const stamp = scheduleLabel(scheduled);
    cell(row, stamp + (scheduled.repeat === "once" && scheduled.lastFired ? " · Queued" : ""));
    cell(row, tracks.get(scheduled.trackId).title);
    const td = cell(row, "");
    action(td, "Edit", () => editEvent(scheduled), "Edit event for " + tracks.get(scheduled.trackId).title);
    action(td, "×", () => {
      state.events = state.events.filter(event => event.id !== scheduled.id);
      record(entryFor(scheduled), "Schedule removed", stamp);
      save();
      drawSchedule();
    }, "Delete event for " + tracks.get(scheduled.trackId).title);
  }
  $("schedule-empty").hidden = state.events.length !== 0;
}

function drawHistory() {
  const tbody = $("history");
  tbody.replaceChildren();
  for (const event of recent) {
    const row = tbody.insertRow();
    const stamp = new Date(event.at);
    const time = cell(row, estimateClock.format(stamp));
    time.className = "history-time";
    const day = document.createElement("span");
    day.className = "meta";
    day.textContent = stamp.toLocaleDateString();
    time.append(day);
    time.title = stamp.toLocaleString();
    trackCell(row, event, event.artist);
    cell(row, event.event);
    cell(row, event.deck || "–");
    cell(row, timecode(event.position));
    cell(row, event.detail || "–");
  }
  $("history-count").textContent = recent.length === 200 ? "Latest 200 entries" : recent.length + " entries";
  $("history-empty").hidden = recent.length !== 0;
  $("export").disabled = recent.length === 0;
}

let lastWindowsPlayback;
function publishWindowsPlayback() {
  if (!windowsBridge) return;
  const deck = engine.current;
  const playback = deck ? {
    title: deck.entry.track.title || "Station Pilot",
    artist: deck.entry.track.artist || "",
    playing: !deck.audio.paused || engine.scratch?.deck === deck
  } : null;
  const message = JSON.stringify(playback);
  if (message === lastWindowsPlayback) return;
  windowsBridge.postMessage("media-playback:" + message);
  lastWindowsPlayback = message;
}

if (windowsBridge) {
  window.pilotMediaAction = playing => {
    const deck = engine?.current;
    if (!deck) return;
    const currentlyPlaying = !deck.audio.paused || engine.scratch?.deck === deck;
    if (playing !== currentlyPlaying) engine.toggle();
  };
}

function drawDecks() {
  const active = engine.current;
  publishWindowsPlayback();
  const playing = [active, engine.secondary, engine.outgoing].some(deck => deck && !deck.audio.paused);
  const cued = engine.cues.size > 0;
  const busy = Boolean(engine.pending || engine.starting);
  const next = peek(true);
  const reserved = [...engine.cues.values()].some(cue => cue.id === next?.id);
  $("transport-state").textContent = engine.scratch?.node ? "SCRATCHING" : playing ? "PLAYING"
    : active ? "PAUSED" : busy ? "LOADING" : cued ? "CUED" : "STANDBY";
  $("transport-state").dataset.live = String(playing || Boolean(engine.scratch?.node));
  for (const [name, prefix, suffix, platterId] of [
    ["A", "live", "a", "program-platter"], ["B", "standby", "b", "standby-platter"]
  ]) {
    const deck = engine.loaded(name);
    const cue = engine.cues.get(name);
    const pending = engine.pending?.deck.name === name ? engine.pending.entry : null;
    const nextDeck = active ? engine.deckName("standby") : engine.availableDeck()?.name || "A";
    const queued = name === nextDeck && !next?.stop && !reserved ? next : null;
    const track = (deck?.entry || pending || cue || queued)?.track;
    const live = Boolean(deck && !deck.audio.paused && !deck.audio.ended);
    $("play-" + suffix).disabled = busy || !track || Boolean(!deck && !cue && active);
    $("play-" + suffix).setAttribute("aria-label", (live ? "Pause" : "Play") + " Deck " + name);
    $("play-" + suffix).textContent = live ? "Ⅱ" : "▶";
    $("stop-" + suffix).disabled = !deck && !cue;
    $(prefix + "-deck").textContent = pending ? "LOADING" : engine.scratch?.node && engine.scratch.deck === deck ? "SCRATCH"
      : live ? "PLAYING" : deck ? "PAUSED" : cue ? "CUED" : queued ? "NEXT" : "EMPTY";
    $(prefix + "-title").textContent = track?.title || "No track loaded";
    $(prefix + "-artist").textContent = track
      ? [track.artist || track.fileName, Number.isFinite(track.duration) && timecode(track.duration)].filter(Boolean).join(" · ")
      : "Drop a track to cue it.";
    $(platterId).classList.toggle("rotating", live && state.settings.rotateArtwork);
    $(platterId).classList.toggle("scratch-enabled", Boolean(deck && deck !== engine.outgoing));
    drawCover($(prefix + "-cover"), state.settings.artwork && track);
    engine.waveforms[name].select(track);
  }
  $("play").textContent = active && !active.audio.paused ? "Ⅱ Pause" : "▶ Play";
  $("play").disabled = busy || (!active && !cued && !next);
  $("stop").disabled = !active && !engine.pending && !engine.armed;
  $("next").disabled = busy || (!next?.stop && Boolean(engine.secondary)) || (!next && !engine.cues.has(engine.deckName("standby")));
  $("output-mode").textContent = state.settings.output.toUpperCase();
  const pitch = active ? (active.audio.playbackRate - 1) * 100 : 0;
  $("pitch").disabled = $("pitch-reset").disabled = $("trim").disabled = !active;
  $("pitch").value = pitch;
  $("pitch-value").value = pitchText(pitch);
  $("trim").value = active ? active.trimDb : 0;
  $("processor").textContent = state.settings.processor.enabled ? "Processor · On" : "Processor";
}

function bindPlatter(name, id) {
  const platter = $(id);
  let gesture = null;
  const angle = (event, bounds) =>
    Math.atan2(event.clientY - bounds.top - bounds.height / 2, event.clientX - bounds.left - bounds.width / 2);
  platter.addEventListener("pointerdown", event => {
    if (gesture || engine.scratch || event.button !== 0 || !engine.loaded(name) || engine.loaded(name) === engine.outgoing || engine.pending) return;
    const bounds = platter.getBoundingClientRect();
    const transform = getComputedStyle(platter.querySelector(".disc")).transform;
    const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
    const start = Math.atan2(matrix.b, matrix.a);
    gesture = { pointerId: event.pointerId, bounds, previous: angle(event, bounds), rotation: 0, start };
    event.preventDefault();
    platter.setPointerCapture(event.pointerId);
    platter.style.setProperty("--hand-angle", start + "rad");
    platter.classList.add("held");
    engine.beginScratch(name).catch(error => {
      engine.endScratch();
      note("Could not start scratching. " + error.message, true);
    });
  });
  platter.addEventListener("pointermove", event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const samples = event.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) {
      const next = angle(sample, gesture.bounds);
      const delta = next - gesture.previous;
      gesture.rotation += Math.atan2(Math.sin(delta), Math.cos(delta));
      gesture.previous = next;
      engine.moveScratch(gesture.rotation * 1.8 / (Math.PI * 2), sample.timeStamp);
    }
    platter.style.setProperty("--hand-angle", (gesture.start + gesture.rotation) + "rad");
  });
  const release = event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture = null;
    platter.classList.remove("held");
    engine.endScratch();
  };
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    platter.addEventListener(name, release);
}

function pitchText(percent) {
  return (percent < -0.001 ? "−" : "+") + Math.abs(percent).toFixed(1) + "%";
}

function drawTransport() {
  for (const [name, suffix] of [["A", ""], ["B", "-b"]]) {
    const active = engine.loaded(name);
    const elapsed = active ? engine.position(active) : 0;
    const duration = active ? active.audio.duration : engine.cues.get(name)?.track.duration;
    const seek = $("seek" + suffix);
    $("elapsed" + suffix).textContent = timecode(elapsed);
    $("remaining" + suffix).textContent = Number.isFinite(duration) ? "−" + timecode((duration - elapsed) / (active?.audio.playbackRate || 1)) : "–";
    seek.disabled = !active || !Number.isFinite(duration);
    if (seek.dataset.editing !== "true") {
      seek.max = Number.isFinite(duration) && duration > 0 ? duration : 1;
      seek.value = elapsed;
    }
    engine.waveforms[name].draw(active, elapsed);
  }

  const levels = engine.levels();
  $("limiter-active").hidden = !engine.limiting;
  ["meter-left", "meter-right"].forEach((id, i) => {
    const db = levels[i] ? levels[i].db : -60;
    $(id).style.setProperty("--level", Math.max(0, Math.min(100, (db + 60) * 100 / 60)) + "%");
  });
}

function probe(file) {
  const audio = new Audio();
  audio.preload = "metadata";
  const url = URL.createObjectURL(file);
  const result = new Promise((resolve, reject) => {
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) reject(new Error("Invalid audio duration."));
      else resolve(audio.duration);
    };
    audio.onerror = () => reject(new Error("This browser could not open the audio."));
    audio.src = url;
  });
  return withTimeout(result, 5000, "Could not read the audio in time.").finally(() => {
    audio.onloadedmetadata = audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  });
}

function editTrack(track) {
  editingTrack = track;
  const fields = $("track-form").elements;
  for (const key of ["title", "artist"]) fields[key].value = track[key];
  loadCategoryPicker(fields.category, track.category);
  fields.rotation.checked = track.rotation;
  $("track-dialog").showModal();
}

function confirmRemove(track) {
  confirmRemoveTracks([track]);
}

function confirmRemoveTracks(batch) {
  const allowed = batch.filter(track => !engine.protect(track.id));
  if (!allowed.length) return notify("Stop or finish these tracks before removing them.", true);
  removing = allowed.map(track => track.id);
  const label = allowed.length === 1 ? "Remove track" : "Remove " + allowed.length + " tracks";
  $("remove-title").textContent = label;
  $("remove-submit").textContent = label;
  $("remove-name").textContent = allowed.length === 1 ? allowed[0].title : "";
  $("remove-name").hidden = allowed.length !== 1;
  $("remove-detail").textContent = "This removes the library entries, any stored copies, and matching queue and schedule entries. Linked files stay on their drive."
    + (allowed.length !== batch.length ? " Tracks in use will be kept." : "");
  $("remove-dialog").showModal();
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, index, 1))));

function scheduleLabel(event) {
  switch (event.repeat) {
    case "once": return event.when.replace("T", " ");
    case "weekly": return event.when + " · " + weekdays[event.weekday] + " weekly";
    case "monthly": return event.when + " · Day " + event.monthDay + " monthly";
    case "yearly": return event.when + " · " + months[event.month - 1] + " " + event.monthDay + " yearly";
    default: return event.when + " · daily";
  }
}

function eventFields() {
  const fields = $("event-form").elements;
  const repeat = fields.repeat.value;
  const monthlyDate = repeat === "monthly" || repeat === "yearly";
  for (const [label, input, visible] of [
    ["repeat-time-field", fields.time, repeat !== "once"],
    ["once-field", fields.date, repeat === "once"],
    ["weekly-field", fields.weekday, repeat === "weekly"],
    ["yearly-field", fields.month, repeat === "yearly"],
    ["month-day-field", fields.monthDay, monthlyDate]
  ]) {
    $(label).hidden = input.disabled = !visible;
    input.required = visible;
  }
  const max = repeat === "yearly" ? new Date(Date.UTC(2024, Number(fields.month.value), 0)).getUTCDate() : 31;
  fields.monthDay.max = max;
  if (Number(fields.monthDay.value) > max) fields.monthDay.value = max;
  $("short-month-note").hidden = !monthlyDate;
}

function filterEventTracks(preferred = $("event-track").value) {
  const select = $("event-track");
  const words = $("event-search").value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const options = document.createDocumentFragment();
  let count = 0;
  for (const track of tracks.values()) {
    const label = [track.title, track.artist].filter(Boolean).join(" · ");
    const text = label.toLocaleLowerCase();
    if (!words.every(word => text.includes(word))) continue;
    options.append(new Option(label, track.id, false, preferred === track.id));
    count++;
  }
  select.options.length = 0;
  select.append(options);
  select.disabled = !count;
  $("event-submit").disabled = !count;
  $("event-matches").hidden = !words.length;
  $("event-matches").textContent = count ? count + (count === 1 ? " matching track" : " matching tracks") : "No matching tracks";
}

function editEvent(event) {
  if (!tracks.size) return;
  editingEvent = event;
  const fields = $("event-form").elements;
  $("event-search").value = "";
  filterEventTracks(event?.trackId || "");
  const nextHour = new Date();
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  fields.date.value = event && event.repeat === "once" ? event.when : localStamp(nextHour);
  fields.time.value = event && event.repeat !== "once" ? event.when : localStamp(nextHour).slice(11);
  fields.weekday.value = event?.weekday ?? nextHour.getDay();
  fields.month.value = event?.month ?? nextHour.getMonth() + 1;
  fields.monthDay.value = event?.monthDay ?? nextHour.getDate();
  fields.repeat.value = event ? event.repeat : "daily";
  eventFields();
  $("event-dialog").showModal();
}

function scheduleTick(stamp) {
  if (settingsImporting || !state.settings.scheduler) return;
  const day = stamp.slice(0, 10);
  const date = new Date(day + "T00:00:00Z");
  const due = state.events.filter(event => {
    if (event.repeat === "once") return !event.lastFired && stamp === event.when;
    if (stamp.slice(11) !== event.when || event.lastFired && event.lastFired >= day) return false;
    switch (event.repeat) {
      case "daily": return true;
      case "weekly": return date.getUTCDay() === event.weekday;
      case "monthly": return date.getUTCDate() === event.monthDay;
      case "yearly": return date.getUTCMonth() + 1 === event.month && date.getUTCDate() === event.monthDay;
      default: return false;
    }
  });
  if (!due.length) return;
  const inserted = due.map(event => {
    event.lastFired = day;
    return { id: workstationId(), trackId: event.trackId, source: "Scheduled" };
  });
  let index = 0;
  while (index < state.queue.length && (state.queue[index].stop || state.queue[index].source === "Scheduled"
      || (engine.pending && state.queue[index].id === engine.pending.entry.id))) index++;
  state.queue.splice(index, 0, ...inserted);
  queueUpdated();
  for (const item of inserted) record(entryFor(item), "Queued", "Scheduled insert");
  drawSchedule();
  note(inserted.length === 1 ? "Scheduled: " + tracks.get(inserted[0].trackId).title : inserted.length + " scheduled tracks queued.");
  if (!engine.current && state.settings.auto) engine.take(false);
}

function csvCell(value) {
  let text = String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function saveWindowsSettings(filename, contents) {
  return new Promise((resolve, reject) => {
    const receive = ({ data }) => {
      if (data?.type !== "pilot-settings-export") return;
      windowsBridge.removeEventListener("message", receive);
      if (data.error) reject(new Error(data.error));
      else resolve(data.saved);
    };
    windowsBridge.addEventListener("message", receive);
    try {
      windowsBridge.postMessage("save-settings:" + JSON.stringify({ filename, contents }));
    } catch (error) {
      windowsBridge.removeEventListener("message", receive);
      reject(error);
    }
  });
}

async function download(contents, filename, type, reveal = false) {
  if (window.stationPilotUnix) return desktopInvoke("save_export", { filename, contents, reveal });
  if (windowsBridge && reveal) return saveWindowsSettings(filename, contents);
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

async function exportHistory() {
  try {
    const history = await store.read("history");
    const header = ["Timestamp UTC", "Title", "Artist", "Event", "Source", "Detail", "Deck", "Position (seconds)"];
    const rows = history.map(row => [row.at, row.title, row.artist, row.event, row.source, row.detail, row.deck || "", row.position ?? ""]);
    const csv = [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
    await download("\uFEFF" + csv, "station-pilot-history-" + localStamp(new Date()).slice(0, 10) + ".csv", "text/csv;charset=utf-8");
  } catch (error) {
    storageError(error);
  }
}


function fillProcessor(values) {
  const fields = $("processor-form").elements;
  fields.enabled.checked = values.enabled;
  for (const key of Object.keys(PROCESSOR_DEFAULTS)) {
    if (key !== "enabled") fields[key].value = values[key];
  }
  updateProcessorReadouts();
}

function updateProcessorReadouts() {
  const fields = $("processor-form").elements;
  for (const output of document.querySelectorAll("[data-processor-value]")) {
    const key = output.dataset.processorValue;
    output.value = fields[key].value;
  }
  const fieldsMatch = (key, value) => key === "enabled" ? fields.enabled.checked === value : Number(fields[key].value) === value;
  $("processor-preset").value = Object.entries(PROCESSOR_PRESETS).find(([, preset]) =>
    Object.entries({ ...PROCESSOR_DEFAULTS, enabled: true, ...preset }).every(([key, value]) => fieldsMatch(key, value)))?.[0] || "";
}

function wheelControls(event) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const field = event.target.closest("input[type=range], input[type=number], select");
  if (!field || field.disabled) return;
  const direction = event.deltaY < 0 ? 1 : -1;
  const previous = field.value;
  if (field instanceof HTMLSelectElement) {
    if (field !== document.activeElement || field.matches(":open")) return;
    const options = Array.from(field.options);
    const next = direction > 0 ? options.slice(field.selectedIndex + 1) : options.slice(0, field.selectedIndex).reverse();
    const option = next.find(item => !item.disabled && !item.hidden);
    if (option) field.selectedIndex = option.index;
  } else if (direction > 0) {
    field.stepUp();
  } else {
    field.stepDown();
  }
  event.preventDefault();
  if (field.value !== previous) {
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function canSelectOutput() {
  return typeof (window.AudioContext || window.webkitAudioContext)?.prototype.setSinkId === "function";
}

async function availableOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default");
}

let outputRefresh = 0;
async function refreshOutputs(selected, granted) {
  const revision = ++outputRefresh;
  const picker = $("settings-form").elements.sink;
  const support = canSelectOutput();
  picker.options.length = 0;
  picker.add(new Option("System default", ""));
  if (support && selected) picker.add(new Option(granted?.label || "Previously selected device", selected));
  picker.value = support ? selected : "";
  picker.disabled = !support;
  $("refresh-outputs").disabled = !support;
  $("output-help").textContent = support
    ? "Only devices available to the browser are listed." : "This browser uses the output selected in your operating system.";
  if (!support) return;
  try {
    const outputs = await availableOutputs();
    if (revision !== outputRefresh) return;
    const original = picker.value;
    picker.options.length = 1;
    outputs.forEach((device, i) => picker.add(new Option(device.label || "Output " + (i + 1), device.deviceId)));
    if (original && !outputs.some(device => device.deviceId === original)) {
      picker.add(new Option(granted?.label || "Previously selected device", original));
    }
    picker.value = original;
    if (windowsBridge) {
      $("output-help").textContent = outputs.length
        ? "Select an output and save to route program audio."
        : "Open Audio device access to list connected speakers and HDMI outputs.";
    } else if (!outputs.length && !granted) {
      $("output-help").textContent = "No additional outputs are available. Use System default or select a device in your operating system.";
    }
  } catch (error) {
    if (revision === outputRefresh) $("output-help").textContent = "Could not read audio outputs. " + error.message;
  }
}

function changeWindowsAudioAccess(action) {
  const id = workstationId();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      windowsBridge.removeEventListener("message", receive);
      if (error) reject(new Error(error));
      else resolve();
    };
    const receive = ({ data }) => {
      if (data?.type === "pilot-audio-access" && data.id === id) finish(data.error);
    };
    const timer = setTimeout(() => finish("WebView2 did not respond. Try again."), 10000);
    windowsBridge.addEventListener("message", receive);
    try { windowsBridge.postMessage("audio-access:" + JSON.stringify({ id, action })); }
    catch (error) { finish(error.message); }
  });
}

function bindWindowsAudioAccess() {
  if (!windowsBridge || dockPath || !canSelectOutput()) return;
  const button = $("audio-access");
  const dialog = $("audio-access-dialog");
  const form = $("audio-access-form");
  const status = $("audio-access-status");
  const reset = $("audio-access-reset");
  const allow = $("audio-access-allow");
  let busy = false;
  button.hidden = false;
  button.addEventListener("click", async () => {
    allow.hidden = false;
    reset.hidden = true;
    status.textContent = "Permission applies to this Station Pilot desktop profile.";
    dialog.showModal();
    try {
      const permission = await navigator.permissions.query({ name: "microphone" });
      if (!dialog.open || busy) return;
      if (permission.state === "granted") {
        allow.hidden = true;
        reset.hidden = false;
        status.textContent = "Access is enabled. Removing access switches program audio to System default.";
      }
    } catch { /* Older runtimes can still process explicit permission requests. */ }
  });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !event.submitter) return;
    const removing = event.submitter === reset;
    const previous = state.settings.sinkId;
    const selected = $("settings-form").elements.sink.value;
    busy = true;
    for (const control of form.elements) control.disabled = true;
    try {
      if (removing) await engine.routeOutput("");
      try { await changeWindowsAudioAccess(removing ? "reset" : "allow"); }
      catch (error) {
        if (removing && previous) await engine.routeOutput(previous);
        throw error;
      }
      if (removing) {
        state.settings.sinkId = "";
        await save();
      }
      await refreshOutputs(removing ? "" : selected);
      dialog.close();
    } catch (error) { status.textContent = "Could not change audio device access. " + error.message; }
    finally {
      busy = false;
      for (const control of form.elements) control.disabled = false;
    }
  });
}

let installingUpdate = false;

function bindUpdates() {
  if (!windowsBridge && !window.stationPilotUnix) return;

  const endpoint = "https://api.github.com/repos/bitwraith21/station-pilot/releases/latest";
  const version = $("app-version").textContent.trim();
  const enabled = $("updates-auto");
  const check = $("updates-check");
  const release = $("updates-release");
  const status = $("updates-status");
  const updateNow = $("updates-now");
  const dialog = $("update-dialog");
  const progress = $("update-progress");
  const result = $("update-status");
  const confirm = $("update-install");
  const later = $("update-later");
  let notifiedVersion;
  let availableTag;
  let selectedTag;
  let downloading = false;
  let downloaded = false;

  const showResult = message => { result.textContent = message; };
  const busy = value => { confirm.disabled = later.disabled = value; };
  const install = async () => {
    if (engine.armed || engine.pending || engine.starting) {
      showResult("The update is ready. Stop playout before installing.");
      busy(false);
      return;
    }
    installingUpdate = true;
    busy(true);
    try {
      await store.save(state);
      showResult("Installing… Station Pilot will close and reopen when setup finishes.");
      windowsBridge.postMessage('install-update:{"action":"install"}');
    } catch (error) {
      installingUpdate = false;
      showResult("Could not start setup. " + error.message);
      busy(false);
    }
  };
  if (window.stationPilotInAppUpdates && windowsBridge && !dockPath) {
    updateNow.addEventListener("click", () => {
      if (!availableTag) return;
      if (selectedTag !== availableTag) downloaded = false;
      selectedTag = availableTag;
      $("update-summary").textContent = "Install Station Pilot " + selectedTag.replace(/^v/, "") + "? Station Pilot will close and reopen during setup.";
      progress.hidden = !downloaded;
      if (downloaded) progress.value = 100;
      confirm.textContent = downloaded ? "Install and restart" : "Download and install";
      showResult(downloaded ? "The verified installer is ready." : "");
      dialog.showModal();
    });
    dialog.addEventListener("cancel", event => {
      if (downloading || installingUpdate) event.preventDefault();
    });
    $("update-form").addEventListener("submit", event => {
      event.preventDefault();
      if (downloading || installingUpdate) return;
      if (downloaded) { install(); return; }
      downloading = true;
      busy(true);
      progress.hidden = false;
      progress.removeAttribute("value");
      showResult("Checking the installer on GitHub…");
      windowsBridge.postMessage("install-update:" + JSON.stringify({ action: "download", tag: selectedTag }));
    });
    window.pilotUpdateStatus = update => {
      if (update.error) {
        downloading = installingUpdate = downloaded = false;
        busy(false);
        progress.hidden = true;
        confirm.textContent = "Download and install";
        showResult(update.error);
      } else if (update.ready) {
        downloading = false;
        downloaded = true;
        confirm.textContent = "Install and restart";
        install();
      } else if (update.total) {
        const percent = Math.floor(100 * update.received / update.total);
        progress.value = percent;
        showResult("Downloading… " + percent + "%");
      }
    };
  }

  const report = message => {
    status.textContent = message;
    status.hidden = !message;
  };

  const checkNow = async (manual = false) => {
    if (check.disabled) return;
    check.disabled = true;
    report("Checking GitHub for updates…");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, { credentials: "omit", cache: "no-cache", signal: controller.signal });
      if (response.status === 404) {
        release.hidden = updateNow.hidden = true;
        report("GitHub has no published stable release.");
        return;
      }
      if (response.status === 429 || (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0")) {
        throw new Error("GitHub’s request limit was reached. Try again later.");
      }
      if (!response.ok) throw new Error("GitHub returned HTTP " + response.status + ".");
      const data = await response.json();
      const latest = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(data.tag_name);
      if (!latest) throw new Error("GitHub returned a release with an unsupported version tag.");
      const difference = latest.slice(1).map((part, index) => Number(part) - Number(version.split(".")[index]));
      const newer = (difference.find(part => part !== 0) ?? 0) > 0;
      const message = newer ? "Station Pilot " + latest[0].replace(/^v/, "") + " is available."
        : "You’re up to date (version " + version + ").";
      availableTag = newer ? data.tag_name : undefined;
      release.hidden = !newer;
      const windowsBase = "Station-Pilot-" + latest.slice(1).join(".") + "-Windows-x64";
      const hasInstaller = data.assets?.some(asset =>
        [windowsBase + ".msi", windowsBase + "-Small.msi"].includes(asset.name)
        && /^sha256:[a-f0-9]{64}$/i.test(asset.digest));
      updateNow.hidden = !newer || !window.stationPilotInAppUpdates || !hasInstaller;
      report(message);
      if (newer && !manual && enabled.checked && notifiedVersion !== latest[0]) {
        notifiedVersion = latest[0];
        notify(message + " Open Settings → Updates for downloads.");
      }
    } catch (error) {
      const details = error.name === "AbortError" || error instanceof TypeError
        ? "Check your internet connection and try again." : error.message;
      report("Could not check for updates. " + details);
    } finally {
      clearTimeout(timeout);
      check.disabled = false;
    }
  };

  $("updates-section").hidden = false;
  enabled.checked = state.settings.checkUpdates;
  enabled.addEventListener("change", () => {
    state.settings.checkUpdates = enabled.checked;
    save();
    if (enabled.checked) checkNow();
  });
  check.addEventListener("click", () => checkNow(true));
  release.addEventListener("click", () => {
    if (windowsBridge) windowsBridge.postMessage("open-releases");
    else desktopInvoke("open_releases").catch(() => report("Could not open the release page in your browser."));
  });
  if (enabled.checked) checkNow();
  setInterval(() => { if (enabled.checked) checkNow(); }, 24 * 60 * 60 * 1000);
}

function syncSettingsControls() {
  $("updates-auto").checked = state.settings.checkUpdates;
  for (const id of ["auto", "key-lock", "scheduler"]) {
    $(id).checked = state.settings[id === "key-lock" ? "keyLock" : id];
  }
  $("gain").value = state.settings.gain;
  $("gain-value").value = state.settings.gain + "%";
}

function settingsFeedback(message, error = false) {
  const status = $("settings-feedback");
  status.textContent = message;
  status.dataset.error = String(error);
  status.hidden = !message;
  if (message) note(message, error);
}

function readSettingsBackup(backup) {
  if (backup?.app !== "station-pilot" || ![1, 2].includes(backup.version)) {
    throw new Error("Select a Station Pilot settings backup in JSON format.");
  }
  const source = backup.settings;
  const settings = {};
  const check = (value, valid, label) => {
    if (!valid(value)) throw new Error("Invalid or missing setting: " + label + ".");
    return value;
  };
  const validNumber = (min, max, step = 1) => value => {
    if (!Number.isFinite(value) || value < min || value > max) return false;
    const steps = (value - min) / step;
    return Math.abs(steps - Math.round(steps)) < 0.000001;
  };
  const validToggle = value => typeof value === "boolean";
  for (const name of Object.keys(initialState.settings)) {
    if (typeof initialState.settings[name] === "boolean") {
      const value = name === "checkUpdates" && source?.[name] === undefined
        ? initialState.settings.checkUpdates : source?.[name];
      settings[name] = check(value, validToggle, name);
    }
  }
  settings.output = check(source?.output, value => value === "stereo" || value === "mono", "program channels");
  settings.sinkId = check(source?.sinkId, value => typeof value === "string" && value.length <= 256, "audio output device");
  settings.gain = check(source?.gain, validNumber(0, 100), "master level");
  settings.fade = check(source?.fade, validNumber(0, 12, 0.5), "transition overlap");
  const processor = $("processor-form").elements;
  settings.processor = {};
  for (const name of Object.keys(PROCESSOR_DEFAULTS)) {
    const field = processor[name];
    const valid = name === "enabled" ? validToggle : validNumber(Number(field.min), Number(field.max), Number(field.step));
    settings.processor[name] = check(source?.processor?.[name], valid, "processor " + name);
  }
  return settings;
}

function bindSettingsBackup() {
  let pendingBackup;
  const dialog = $("import-settings-dialog");
  const controls = dialog.querySelectorAll("button");
  const fileInput = $("settings-file");
  $("export-settings").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    settingsFeedback("");
    const settings = Object.fromEntries(Object.keys(initialState.settings).map(key => [key, state.settings[key]]));
    const backup = { app: "station-pilot", version: 2, settings, library: exportLinkedLibrary() };
    try {
      const saved = await download(JSON.stringify(backup, null, 2) + "\n", "station-pilot-settings-" + localStamp(new Date()).slice(0, 10) + ".json", "application/json", true);
      if (saved) settingsFeedback(windowsBridge || window.stationPilotUnix ? "Settings backup saved." : "Settings backup prepared.");
    } catch (error) { settingsFeedback(error.message || String(error), true); }
    finally { button.disabled = false; }
  });
  $("locate-music").addEventListener("click", () => {
    drawMissingMusic();
    $("missing-music-dialog").showModal();
  });
  $("import-settings").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    pendingBackup = null;
    settingsFeedback("");
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error("The backup exceeds 64 MiB.");
      const data = JSON.parse(await file.text());
      const settings = readSettingsBackup(data);
      const library = data.version === 2 ? readLinkedLibrary(data.library) : null;
      pendingBackup = { settings, library };
      showTrackPreview($("backup-track-preview"), library?.files || []);
      $("import-summary").textContent = library
        ? "Replace your preferences and merge " + library.folders.length + " folders and " + library.files.length + " linked tracks into your library."
        : "Replace your current preferences.";
      if ($("general-dialog").open) dialog.showModal();
    } catch (error) {
      settingsFeedback("Could not read settings. " + error.message, true);
    }
  });
  dialog.addEventListener("cancel", event => { if (settingsImporting) event.preventDefault(); });
  $("import-settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!pendingBackup || settingsImporting) return;
    const { settings: imported, library } = pendingBackup;
    pendingBackup = null;
    if (engine.armed || engine.pending) {
      dialog.close();
      return settingsFeedback("Stop playout before importing settings.", true);
    }
    settingsImporting = true;
    for (const button of controls) button.disabled = true;
    const previous = state.settings;
    let keptOutput = false;
    let locate = false;
    try {
      $("backup-track-preview").hidden = true;
      $("import-summary").textContent = "Checking linked music locations…";
      await linkJobs;
      const restored = library ? await prepareImportedLibrary(library) : null;
      if (imported.sinkId !== previous.sinkId) {
        try {
          if (imported.sinkId && (!canSelectOutput() || !(await availableOutputs()).some(device => device.deviceId === imported.sinkId))) {
            throw new Error("Audio output is unavailable.");
          }
          await engine.routeOutput(imported.sinkId);
        } catch {
          imported.sinkId = previous.sinkId;
          keptOutput = true;
        }
      }
      const categoryNames = new Map(state.categories.map(name => [name.toLowerCase(), name]));
      for (const name of library?.categories || []) {
        if (!categoryNames.has(name.toLowerCase())) categoryNames.set(name.toLowerCase(), name);
      }
      const next = { ...state, settings: imported, categories: [...categoryNames.values()] };
      if (restored) await store.saveBackup(next, restored);
      else await store.save(next);
      state = next;
      if (restored) {
        for (const folder of restored.folders) store.folders.set(folder.id, folder);
        for (const track of restored.files) tracks.set(track.id, track);
        for (const entry of engine.cues.values()) entry.track = tracks.get(entry.trackId) || entry.track;
        orderedLibrary = null;
        drawLibrary();
        drawQueue();
        drawSchedule();
        locate = drawMissingMusic() > 0;
      }
      syncSettingsControls();
      engine.configure();
      engine.prepare();
      drawDecks();
      const message = restored ? "Settings and music links imported." : "Settings imported.";
      settingsFeedback(message + (keptOutput ? " The current audio output was kept." : ""));
    } catch (error) {
      if (imported.sinkId !== previous.sinkId) await engine.routeOutput(previous.sinkId).catch(storageError);
      settingsFeedback("Could not save imported settings. " + error.message, true);
    } finally {
      settingsImporting = false;
      for (const button of controls) button.disabled = false;
      dialog.close();
      if (locate) $("missing-music-dialog").showModal();
    }
  });
}

function bind() {
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => {
      if (button.dataset.view === "history") drawHistory();
      for (const tab of document.querySelectorAll("[data-view]")) {
        const selected = tab === button;
        tab.setAttribute("aria-pressed", String(selected));
        $("view-" + tab.dataset.view).hidden = !selected;
      }
    });
  }
  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }
  bindDrop();
  document.addEventListener("wheel", wheelControls, { passive: false });
  bindPlatter("A", "program-platter");
  bindPlatter("B", "standby-platter");
  bindRowMenus();
  bindBatch();
  $("search").addEventListener("input", () => { libraryLimit = 150; drawLibrary(); });
  $("more-tracks").addEventListener("click", () => { libraryLimit += 150; drawLibrary(); });
  bindLinkedLibrary();
  bindGeneralSettings();
  bindDockDesktop();
  bindDockView();
  bindSettingsBackup();
  syncSettingsControls();
  $("play").addEventListener("click", () => engine.toggle());
  $("stop").addEventListener("click", () => { engine.stop(); note("Playout stopped."); });
  $("next").addEventListener("click", () => engine.take(true));
  $("pitch").addEventListener("input", () => {
    const percent = Number($("pitch").value);
    engine.pitch(percent);
    $("pitch-value").value = pitchText(percent);
  });
  $("pitch-reset").addEventListener("click", () => { engine.pitch(0); drawDecks(); });
  $("trim").addEventListener("input", () => engine.trim(Number($("trim").value)));
  $("key-lock").addEventListener("change", () => {
    state.settings.keyLock = $("key-lock").checked;
    engine.configure();
    save();
  });
  for (const [name, suffix] of [["A", "a"], ["B", "b"]]) {
    $("play-" + suffix).addEventListener("click", () => engine.toggle(name));
    $("stop-" + suffix).addEventListener("click", () => engine.stopDeck(name));
    const seek = $(name === "A" ? "seek" : "seek-b");
    seek.addEventListener("input", () => { seek.dataset.editing = "true"; });
    seek.addEventListener("change", () => {
      engine.seek(Number(seek.value), name);
      delete seek.dataset.editing;
    });
    seek.addEventListener("blur", () => { delete seek.dataset.editing; });
  }
  for (const id of ["auto", "scheduler"]) {
    $(id).addEventListener("change", () => {
      state.settings[id] = $(id).checked;
      record(null, id === "auto" ? "Auto advance" : "Scheduler", state.settings[id] ? "Enabled" : "Disabled");
      save();
      drawDecks();
    });
  }
  $("gain").addEventListener("input", () => {
    state.settings.gain = Number($("gain").value);
    $("gain-value").value = state.settings.gain + "%";
    engine.configure();
    save();
  });

  $("settings").addEventListener("click", () => {
    const fields = $("settings-form").elements;
    fields.output.value = state.settings.output;
    fields.fade.value = state.settings.fade;
    fields.rotation.checked = state.settings.rotation;
    fields.artwork.checked = state.settings.artwork;
    fields.rotateArtwork.checked = state.settings.rotateArtwork;
    refreshOutputs(state.settings.sinkId);
    $("settings-dialog").showModal();
  });
  $("refresh-outputs").addEventListener("click", () => refreshOutputs($("settings-form").elements.sink.value));
  $("windows-volume-mixer").hidden = !windowsBridge;
  $("windows-volume-mixer").addEventListener("click", () => windowsBridge?.postMessage("open-volume-mixer"));
  bindWindowsAudioAccess();
  $("choose-output").hidden = !navigator.mediaDevices?.selectAudioOutput;
  $("choose-output").addEventListener("click", async () => {
    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      await refreshOutputs(device.deviceId, device);
    } catch (error) { $("output-help").textContent = error.message; }
  });
  navigator.mediaDevices?.addEventListener("devicechange", () => {
    if ($("settings-dialog").open) refreshOutputs($("settings-form").elements.sink.value);
  });
  $("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    const fields = event.target.elements;
    const sink = fields.sink.value;
    try { await engine.routeOutput(sink); }
    catch (error) {
      $("output-help").textContent = "Could not switch outputs. " + error.message;
      return;
    }
    state.settings.sinkId = sink;
    state.settings.output = fields.output.value;
    state.settings.fade = Number(fields.fade.value);
    state.settings.rotation = fields.rotation.checked;
    state.settings.artwork = fields.artwork.checked;
    state.settings.rotateArtwork = fields.rotateArtwork.checked;
    save();
    engine.configure();
    drawDecks();
    $("settings-dialog").close();
  });
  $("processor").addEventListener("click", () => {
    fillProcessor(state.settings.processor);
    $("processor-dialog").showModal();
  });
  const presets = $("processor-preset");
  for (const label of Object.keys(PROCESSOR_PRESETS)) presets.add(new Option(label, label));
  presets.addEventListener("change", () => {
    if (Object.hasOwn(PROCESSOR_PRESETS, presets.value)) {
      fillProcessor({ ...PROCESSOR_DEFAULTS, enabled: true, ...PROCESSOR_PRESETS[presets.value] });
    }
  });
  $("processor-form").addEventListener("input", event => {
    if (event.target !== presets) updateProcessorReadouts();
  });
  $("processor-reset").addEventListener("click", () => fillProcessor(PROCESSOR_DEFAULTS));
  $("processor-form").addEventListener("submit", event => {
    event.preventDefault();
    const fields = event.target.elements;
    const values = { enabled: fields.enabled.checked };
    for (const key of Object.keys(PROCESSOR_DEFAULTS)) {
      if (key !== "enabled") values[key] = Number(fields[key].value);
    }
    state.settings.processor = values;
    record(null, "Processor settings applied", values.enabled ? "Enabled" : "Bypassed");
    engine.configure();
    save();
    drawDecks();
    $("processor-dialog").close();
  });
  for (const select of document.querySelectorAll(".category-picker")) {
    const field = select.form.querySelector(".new-category");
    select.addEventListener("change", () => {
      toggleNewCategory(select);
      if (!field.disabled) field.focus();
    });
    field.addEventListener("input", () => field.setCustomValidity(""));
  }
  $("track-form").elements.title.addEventListener("input", event => event.target.setCustomValidity(""));
  $("track-form").addEventListener("submit", async event => {
    event.preventDefault();
    const fields = event.target.elements;
    if (!fields.title.value.trim()) {
      fields.title.setCustomValidity("Enter a track title.");
      fields.title.reportValidity();
      return;
    }
    const category = chosenCategory(fields.category);
    if (category === null) return;
    const updated = { ...editingTrack, title: fields.title.value.trim(), artist: fields.artist.value.trim(),
      category, rotation: fields.rotation.checked };
    if (updated.title !== editingTrack.title || updated.artist !== editingTrack.artist) updated.namesEdited = true;
    $("track-dialog").close();
    try {
      await store.updateTrack(updated);
      const existing = tracks.get(updated.id);
      if (existing) Object.assign(existing, updated, { duration: existing.duration ?? updated.duration });
      record({ track: updated, trackId: updated.id }, "Track edited");
      orderedLibrary = null;
      drawLibrary();
      drawQueue();
      drawSchedule();
      drawDecks();
    } catch (error) {
      storageError(error);
    }
  });
  $("remove-form").addEventListener("submit", async event => {
    event.preventDefault();
    const batch = removing.map(id => tracks.get(id)).filter(track => track && !engine.protect(track.id));
    $("remove-dialog").close();
    if (!batch.length) return notify("The selected tracks are in use or have already been removed.", true);
    const ids = new Set(batch.map(track => track.id));
    const removedQueue = state.queue.filter(item => ids.has(item.trackId));
    const removedEvents = state.events.filter(item => ids.has(item.trackId));
    for (const id of ids) tracks.delete(id);
    orderedLibrary = null;
    state.queue = state.queue.filter(item => !ids.has(item.trackId));
    state.events = state.events.filter(item => !ids.has(item.trackId));
    const removal = store.removeMedia(state, ids);
    engine.prepare();
    drawQueue();
    drawDecks();
    drawSchedule();
    drawLibrary();
    try {
      await removal;
      record(batch.length === 1 ? { track: batch[0], trackId: batch[0].id } : null, "Removed from library", batch.length + " tracks");
      notify(batch.length === 1 ? "Removed " + batch[0].title + "." : "Removed " + batch.length + " tracks.");
    } catch (error) {
      for (const track of batch) tracks.set(track.id, track);
      state.queue.push(...removedQueue);
      state.events.push(...removedEvents);
      orderedLibrary = null;
      queueUpdated();
      drawSchedule();
      drawLibrary();
      storageError(error);
    }
  });
  $("add-event").addEventListener("click", () => editEvent(null));
  $("event-search").addEventListener("input", () => filterEventTracks());
  $("event-search").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      if (!$("event-track").disabled) $("event-track").focus();
    }
  });
  const scheduleFields = $("event-form").elements;
  weekdays.forEach((name, index) => scheduleFields.weekday.add(new Option(name, index)));
  months.forEach((name, index) => scheduleFields.month.add(new Option(name, index + 1)));
  scheduleFields.repeat.addEventListener("change", eventFields);
  scheduleFields.month.addEventListener("change", eventFields);
  $("event-form").addEventListener("submit", event => {
    event.preventDefault();
    const fields = event.target.elements;
    if (!tracks.has(fields.track.value)) return;
    const repeat = fields.repeat.value;
    const when = repeat === "once" ? fields.date.value : fields.time.value;
    const scheduled = { id: editingEvent?.id || workstationId(), trackId: fields.track.value, repeat, when, lastFired: null };
    if (repeat === "weekly") scheduled.weekday = Number(fields.weekday.value);
    if (repeat === "monthly" || repeat === "yearly") scheduled.monthDay = fields.monthDay.valueAsNumber;
    if (repeat === "yearly") scheduled.month = Number(fields.month.value);
    if (editingEvent && ["repeat", "when", "weekday", "month", "monthDay"].every(key => editingEvent[key] === scheduled[key])) {
      scheduled.lastFired = editingEvent.lastFired;
    }
    if (editingEvent) {
      state.events = state.events.map(row => row.id === scheduled.id ? scheduled : row);
    } else {
      state.events.push(scheduled);
    }
    save();
    drawSchedule();
    $("event-dialog").close();
    record(entryFor(scheduled), editingEvent ? "Schedule updated" : "Scheduled", when + " · " + repeat);
    notify(editingEvent ? "Scheduled insert updated." : "Scheduled insert added.");
  });
  $("export").addEventListener("click", exportHistory);
}

async function start(snapshot = null) {
  const profile = !dockPath ? undefined : dockShared ? "station-pilot-obs-shared" : "station-pilot-obs-separate";
  store = await LocalStore.open(profile);
  const [saved, library, history, folders] = await Promise.all([
    store.read("state", "workstation"), store.read("tracks"), store.recentHistory(200), store.read("folders")
  ]);
  for (const folder of folders) store.folders.set(folder.id, folder);
  const corrected = [];
  for (const track of library) {
    const entry = correctedTrackNames(track);
    if (entry !== track) corrected.push(entry);
    tracks.set(entry.id, entry);
  }
  if (corrected.length) await store.saveLinks(corrected).catch(storageError);
  state = { ...initialState, ...saved };
  state.categories = Array.isArray(state.categories) ? state.categories : [];
  state.settings = { ...initialState.settings, ...state.settings };
  state.settings.processor = { ...PROCESSOR_DEFAULTS, ...state.settings.processor };
  if (snapshot) applyDockProfile(snapshot);
  if (!dockShared) {
    state.queue = state.queue.filter(item => item.stop || tracks.has(item.trackId));
    state.events = state.events.filter(item => tracks.has(item.trackId));
  }
  const lastRotation = history.find(row => row.event === "Started" && row.source === "Rotation");
  nextRotation = lastRotation ? lastRotation.trackId : null;
  recent = history;
  engine = new Playout(store, {
    settings: () => state.settings, peek, consume, record, duration: saveAudioDuration,
    reconnect: promptReconnect,
    report: (message, error) => { if (!storageFault) (error ? notify : note)(message, error); },
    changed: () => { drawDecks(); drawQueue(); }
  });
  engine.waveforms = {
    A: new ProgramWaveform(engine, $("scope"), ["#658f81", "#b5df93"]),
    B: new ProgramWaveform(engine, $("scope-b"), ["#9b715a", "#edb27f"])
  };
  bind();
  drawLibrary();
  drawQueue();
  drawSchedule();
  drawHistory();
  drawDecks();
  let clock = "";
  const update = () => {
    const now = new Date();
    const display = now.toLocaleTimeString([], { hour12: false });
    if (display !== clock) {
      $("clock").textContent = display;
      clock = display;
    }
    if (!installingUpdate) scheduleTick(localStamp(now));
    drawQueueEstimates();
  };
  update();
  setInterval(update, 500);
  startDonationReminder();
  // Keep playout decisions separate from painting. Animation frames can pause in background tabs.
  setInterval(() => engine.tick(), 50);
  let drawn = 0;
  const paint = timestamp => {
    if (timestamp - drawn >= 33) {
      drawTransport();
      drawn = timestamp;
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
  note("Library ready.");
  bindUpdates();
  if (windowsBridge) windowsBridge.postMessage("pilot-ready");
  else window.chrome?.webview?.postMessage("pilot-ready");
}

if (dockPath) {
  initializeDock().then(snapshot => {
    if (!navigator.locks) return start(snapshot);
    return navigator.locks.request("station-pilot-obs", { ifAvailable: true }, async lock => {
      if (!lock) return note("Station Pilot is already open in another dock using this URL.", true);
      await start(snapshot);
      await new Promise(() => {});
    });
  }).catch(error => note(error.message, true));
} else if (window.stationPilotUnix && window.crypto?.getRandomValues) {
  navigator.locks?.request("station-pilot-desktop-playout", () => new Promise(() => {})).catch(() => {});
  start().catch(storageError);
} else if (!navigator.locks || !window.crypto || !crypto.randomUUID) {
  note("Open Station Pilot from its loopback URL in a current Chrome, Edge, Firefox, or Safari browser.", true);
} else {
  navigator.locks.request("station-pilot-workstation", { ifAvailable: true }, async lock => {
    if (!lock) {
      note("Station Pilot is already open in this browser profile. Close the other tab and reload.", true);
      return;
    }
    await start();
    await new Promise(() => {});
  }).catch(storageError);
}
