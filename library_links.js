"use strict";

let folderView = null;
let folderParts = [];
let currentCategory = null;
let linkJobs = Promise.resolve();
const desktopInvoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const windowsBridge = window.chrome?.webview;
let nativePickerReady = Boolean(window.stationPilotUnix || dockPath);

function workstationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function unixHandle(link) {
  const args = { key: link.key, parts: link.parts };
  return {
    nativeLink: link, kind: link.kind, name: link.name,
    async isSameEntry(other) { return other?.nativeLink?.key === link.key && JSON.stringify(other.nativeLink.parts) === JSON.stringify(link.parts); },
    async queryPermission() { return "granted"; },
    async *values() {
      const children = dockPath ? await dockFetch("children", args) : await desktopInvoke("list_children", args);
      for (const child of children) yield unixHandle(child);
    },
    async getFile() {
      try {
        const bytes = dockPath ? await dockFetch("audio", args) : await desktopInvoke("read_music", args);
        const mime = { mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", aiff: "audio/aiff" };
        return new File([new Uint8Array(bytes)], link.name, { lastModified: link.modified, type: mime[link.name.split(".").pop().toLowerCase()] || "" });
      } catch (error) { throw new DOMException(String(error), "NotFoundError"); }
    }
  };
}

function storedHandle(handle) {
  return handle.nativeLink ? { nativeLink: handle.nativeLink } : handle;
}

let nativePickerResult;
const nativeKeys = new WeakMap();
const liveHandles = new Map();
const nativeRequests = new Map();
let reconnectSource;

function requestHandles(id, send) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { nativeRequests.delete(id); reject(new Error("Music link timed out.")); }, 10000);
    nativeRequests.set(id, { finish(handles) {
      clearTimeout(timer);
      nativeRequests.delete(id);
      if (handles) resolve(handles);
      else reject(new Error("Reconnect the music source."));
    } });
    try { send(); } catch { nativeRequests.get(id).finish(null); }
  });
}

function nativeDropHandles(files) {
  const id = workstationId().replaceAll("-", "");
  return requestHandles(id, () => window.chrome.webview.postMessageWithAdditionalObjects("pilot-drop:" + id, files));
}

async function sourceHandle(source) {
  if (source?.handle?.nativeLink) return unixHandle(source.handle.nativeLink);
  const key = source?.nativeKey;
  if (!key || !windowsBridge) return source?.handle;
  if (!liveHandles.has(key)) {
    const restored = requestHandles(key, () => windowsBridge.postMessage("restore:" + key))
      .then(handles => handles[0]).catch(error => {
        liveHandles.delete(key);
        throw new DOMException(error.message, "NotAllowedError");
      });
    liveHandles.set(key, restored);
  }
  return liveHandles.get(key);
}
const reminderDelay = 2 * 60 * 60 * 1000;
const reminderKey = "station-pilot-donation-next";
let donationNext = 0;

function showToast(message, error) {
  const stack = $("toasts");
  const box = document.createElement("div");
  box.className = "toast";
  box.dataset.error = String(error);
  const label = document.createElement("span");
  label.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", () => box.remove());
  box.append(label, close);
  stack.append(box);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => box.remove(), error ? 10000 : 5000);
}

function setNextDonation(time) {
  donationNext = time;
  try { localStorage.setItem(reminderKey, String(time)); } catch { }
}

function checkDonationReminder() {
  if (document.hidden || document.querySelector("dialog[open]")) return;
  if (Date.now() < donationNext) return;
  $("donate-reminder").hidden = false;
  setNextDonation(Date.now() + reminderDelay);
}

function startDonationReminder() {
  try { donationNext = Number(localStorage.getItem(reminderKey)); } catch { }
  if (!donationNext) setNextDonation(Date.now() + reminderDelay);
  checkDonationReminder();
  setInterval(checkDonationReminder, 30000);
  document.addEventListener("visibilitychange", checkDonationReminder);
}

function bindGeneralSettings() {
  $("general-settings").addEventListener("click", () => $("general-dialog").showModal());
  $("general-output").addEventListener("click", () => {
    $("general-dialog").close();
    $("settings").click();
  });
  $("dismiss-donate").addEventListener("click", () => { $("donate-reminder").hidden = true; });
  for (const link of document.querySelectorAll("[data-donate]")) {
    link.addEventListener("click", event => {
      $("donate-reminder").hidden = true;
      if (window.stationPilotUnix) { event.preventDefault(); desktopInvoke("donate").catch(error => notify(String(error), true)); }
      else if (windowsBridge) {
        event.preventDefault();
        windowsBridge.postMessage("open-donation");
      }
    });
  }
}

function divButton(parent, text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  parent.append(button);
  return button;
}

function samePath(first, second) {
  return first.length === second.length && first.every((segment, index) => segment === second[index]);
}

function showFolder(folder, path = []) {
  folderView = folder;
  folderParts = path;
  drawFolders();
}

function folderNavigation(parent, label, onClick) {
  divButton(parent, label, onClick).className = "folder-name";
}

function explorerTrack(parent, track) {
  const row = parent.insertRow();
  dragRow(row, "library", track.id);
  trackCell(row, track, track.artist || track.fileName, true);
  durationCell(row, track);
  bindRowMenu(row, "explorer", track.id);
  const options = cell(row, "");
  action(options, "＋ Queue", () => enqueue(track), "Queue " + track.title).disabled = Boolean(track.missing);
  if (!dockShared) action(options, "Edit", () => editTrack(track), "Edit " + track.title);
}

function drawFolders() {
  const nav = $("folder-path");
  const list = $("folder-list");
  nav.replaceChildren();
  list.replaceChildren();
  folderNavigation(nav, "Folders", () => showFolder(null));
  const folder = store.folders.get(folderView);
  $("folder-depth").hidden = !folder;
  if (!folder) {
    for (const item of store.folders.values()) {
      const row = list.insertRow();
      folderNavigation(cell(row, ""), "📁 " + item.name, () => showFolder(item.id));
      const count = item.count || 0;
      cell(row, count + (count === 1 ? " track" : " tracks") + (item.missing ? " · Missing" : ""));
      const options = cell(row, "");
      if (!dockShared) {
        action(options, "Refresh", () => refreshFolder(item), "Refresh " + item.name);
        if (item.missing) action(options, "Locate folder", () => promptReconnect(null, item), "Locate folder " + item.name);
        else action(options, "Relink", () => pickFolder(item), "Relink " + item.name);
      }
    }
  } else {
    folderNavigation(nav, folder.name, () => showFolder(folder.id));
    folderParts.forEach((part, i) => {
      nav.append("›");
      folderNavigation(nav, part, () => showFolder(folder.id, folderParts.slice(0, i + 1)));
    });
    for (const parts of folder.directories || []) {
      if (!samePath(parts.slice(0, -1), folderParts)) continue;
      const row = list.insertRow();
      folderNavigation(cell(row, ""), "📁 " + parts.at(-1), () => showFolder(folder.id, parts));
      cell(row, "Folder");
      cell(row, "");
    }
    const files = Array.from(tracks.values()).filter(track => track.source?.folderId === folder.id
      && ($("include-subfolders").checked ? samePath(track.source.path.slice(0, folderParts.length), folderParts)
        : samePath(track.source.path.slice(0, -1), folderParts))).sort((a, b) => a.fileName.localeCompare(b.fileName));
    for (const track of files) explorerTrack(list, track);
  }
  const empty = $("folder-empty");
  empty.hidden = Boolean(list.rows.length);
  empty.textContent = folder ? "This folder has no indexed audio or subfolders." : "Link a folder to browse audio on its original drive.";
}

function categories() {
  const names = new Map();
  for (const name of [...state.categories, ...Array.from(tracks.values(), track => track.category)]) {
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
}

function loadCategoryPicker(select, current = "") {
  const names = categories();
  const button = select.querySelector("button");
  const empty = new Option(select.required ? "Choose a category" : "No category", "");
  empty.disabled = select.required;
  const create = new Option("Create category…", "\u0000");
  create.dataset.create = "";
  select.replaceChildren(button, empty, ...names.map(name => new Option(name, name)), create);
  const matching = names.find(name => name.toLowerCase() === current.toLowerCase());
  select.value = matching || "";
  const field = select.form.querySelector(".new-category");
  field.value = "";
  field.setCustomValidity("");
  toggleNewCategory(select);
}

function toggleNewCategory(select) {
  const field = select.form.querySelector(".new-category");
  const create = select.selectedOptions[0]?.hasAttribute("data-create");
  field.required = Boolean(create);
  field.disabled = field.parentElement.hidden = !create;
}

function chosenCategory(select) {
  if (!select.selectedOptions[0]?.hasAttribute("data-create")) return select.value;
  const field = select.form.querySelector(".new-category");
  const name = field.value.trim();
  if (!name) {
    field.setCustomValidity("Enter a category name.");
    field.reportValidity();
    return null;
  }
  return categories().find(category => category.toLowerCase() === name.toLowerCase()) || name;
}

function drawCategories() {
  const nav = $("category-path");
  const list = $("category-list");
  nav.replaceChildren();
  list.replaceChildren();
  const names = categories();
  folderNavigation(nav, "Categories", () => { currentCategory = null; drawCategories(); });
  if (currentCategory) {
    nav.append("› " + currentCategory);
    const content = Array.from(tracks.values()).filter(track => track.category.toLowerCase() === currentCategory.toLowerCase())
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const track of content) explorerTrack(list, track);
  } else {
    const counts = new Map();
    for (const track of tracks.values()) {
      const key = track.category.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const name of names) {
      const row = list.insertRow();
      folderNavigation(cell(row, ""), "📁 " + name, () => { currentCategory = name; drawCategories(); });
      const count = counts.get(name.toLowerCase()) || 0;
      cell(row, count + (count === 1 ? " track" : " tracks"));
      cell(row, "");
    }
  }
  const empty = $("category-empty");
  empty.hidden = Boolean(list.rows.length);
  empty.textContent = currentCategory ? "Right-click tracks to assign this category." : "Create a category to organize tracks.";
}

function drawExplorerViews() {
  drawFolders();
  drawCategories();
}

async function equalAudio(first, second) {
  if (!second || first.size !== second.size) return false;
  const block = 1024 * 1024;
  for (let offset = 0; offset < first.size; offset += block) {
    const [left, right] = await Promise.all([
      first.slice(offset, offset + block).arrayBuffer(), second.slice(offset, offset + block).arrayBuffer()
    ]);
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  }
  return true;
}

async function identicalTrack(file, candidates) {
  for (const track of candidates) {
    try {
      if (await equalAudio(file, await store.readAudio(track))) return track;
    } catch { /* An offline source cannot be compared. */ }
  }
  return null;
}

const defaultNameOrder = "title-artist";

function filenameTrackNames(fileName, order = defaultNameOrder) {
  const stem = fileName.replace(/\.[^.]+$/, "").trim() || fileName;
  const parts = stem.split(" - ");
  if (parts.length === 1) return { title: stem, artist: "" };
  if (order === "artist-title") return { title: parts.slice(1).join(" - ").trim(), artist: parts[0].trim() };
  const artist = parts.pop().trim();
  const remaster = /^[(\[]?(?:\d{4}\s+(?:digital\s+)?remaster(?:ed)?|(?:digital\s+)?remaster(?:ed)?\s+\d{4})[)\]]?$/i;
  if (parts.length > 1 && remaster.test(parts.at(-1).trim())) parts.pop();
  return { title: parts.join(" - ").trim(), artist };
}

function sameTrackNames(track, names) {
  return track.title === names.title && track.artist === names.artist;
}

function legacyTrackNames(fileName) {
  const parts = fileName.replace(/\.[^.]+$/, "").match(/^(.+?) - (.+)$/);
  return parts && { title: parts[2], artist: parts[1] };
}

function correctedTrackNames(track) {
  if (track.namesEdited || track.nameOrder) return track;
  const old = legacyTrackNames(track.fileName);
  if (!old || !sameTrackNames(track, old)) return track;
  // The earlier repair only identified filenames with a separate remaster field.
  const parts = track.fileName.replace(/\.[^.]+$/, "").trim().split(" - ");
  const names = filenameTrackNames(track.fileName);
  if (parts.length < 3 || names.title === parts.slice(0, -1).join(" - ").trim()) return track;
  return { ...track, ...names };
}

function namesForLink(fileName, previous, order) {
  if (previous) {
    const savedNames = { title: previous.title, artist: previous.artist, nameOrder: previous.nameOrder };
    if (!order || previous.namesEdited) return savedNames;
    if (!previous.nameOrder) {
      const original = legacyTrackNames(previous.fileName);
      if (!(original && sameTrackNames(previous, original)) &&
          !["title-artist", "artist-title"].some(format => sameTrackNames(previous, filenameTrackNames(previous.fileName, format)))) {
        return savedNames;
      }
    }
  }
  const nameOrder = order || defaultNameOrder;
  return { ...filenameTrackNames(fileName, nameOrder), nameOrder };
}

function linkedTrack(file, source, previous, duration = null, order) {
  return {
    id: workstationId(), duration, category: "", rotation: false, ...previous,
    ...namesForLink(file.name, previous, order), source, fileName: file.name, size: file.size, modified: file.lastModified,
    duration: previous && previous.size === file.size && previous.modified === file.lastModified ? previous.duration : duration,
    missing: false
  };
}

async function walkFolder(directory, path, result) {
  for await (const handle of directory.values()) {
    const next = [...path, handle.name];
    if (handle.kind === "directory") {
      result.directories.push(next);
      try { await walkFolder(handle, next, result); } catch { result.failed++; }
    } else if (audioExtension.test(handle.name)) {
      try { result.files.push({ file: handle.nativeLink ? { name: handle.name, size: handle.nativeLink.size, lastModified: handle.nativeLink.modified } : await handle.getFile(), path: next, handle }); } catch { result.failed++; }
    }
  }
}

async function findLinkedFolder(handle) {
  for (const folder of store.folders.values()) {
    try {
      if (await handle.isSameEntry(folder.handle)) return folder;
    } catch { /* An unavailable bookmark cannot identify this folder. */ }
  }
  return null;
}

async function indexFolder(handle, folder, preview, order) {
  folder ||= await findLinkedFolder(handle);
  const id = folder?.id || workstationId();
  const result = preview || { directories: [], files: [], failed: 0 };
  if (!preview) {
    note("Reading " + handle.name + "…");
    await walkFolder(handle, [], result);
  }
  const old = new Map();
  const legacy = new Map();
  for (const track of tracks.values()) {
    if (track.source?.folderId === id) old.set(JSON.stringify(track.source.path), track);
    if (!track.source) {
      const key = track.fileName.toLowerCase() + "\0" + track.size;
      if (!legacy.has(key)) legacy.set(key, []);
      legacy.get(key).push(track);
    }
  }
  if (folder && folder.name !== handle.name && old.size &&
      !result.files.some(({ path, file }) => old.get(JSON.stringify(path))?.size === file.size)) {
    throw new Error("Choose a folder that contains the original tracks from “" + folder.name + "”.");
  }
  const linked = [];
  const claimed = new Set();
  for (const { file, path, handle: child } of result.files) {
    const key = JSON.stringify(path);
    let prior = old.get(key);
    old.delete(key);
    if (!prior) {
      const matches = legacy.get(file.name.toLowerCase() + "\0" + file.size) || [];
      prior = matches.length && await identicalTrack(child.nativeLink ? await child.getFile() : file, matches.filter(track => !claimed.has(track.id)));
      if (prior) claimed.add(prior.id);
    }
    linked.push(linkedTrack(file, { folderId: id, path }, prior, prior?.duration, order || (!prior ? folder?.nameOrder : undefined)));
  }
  const missing = result.failed ? [] : Array.from(old.values(), track => ({ ...track, missing: true }));
  const scanned = {
    id, name: handle.name, nameOrder: order || folder?.nameOrder || defaultNameOrder, missing: false, handle: storedHandle(handle), nativeKey: nativeKeys.get(handle) || (folder?.handle === handle ? folder.nativeKey : undefined), count: linked.length,
    directories: result.directories.sort((a, b) => a.join("/").localeCompare(b.join("/")))
  };
  await store.saveLinks([...linked, ...missing], scanned);
  store.folders.set(id, scanned);
  for (const track of [...linked, ...missing]) tracks.set(track.id, track);
  return { linked, failed: result.failed, id, name: handle.name };
}

async function linkFile(handle, readDuration = true, order) {
  const file = await handle.getFile();
  if (!audioExtension.test(file.name) && !file.type.startsWith("audio/")) throw new Error("Unsupported audio type.");
  const matches = Array.from(tracks.values()).filter(track => track.size === file.size);
  let previous;
  for (const track of matches) {
    if (!track.source?.handle || track.fileName !== file.name) continue;
    try {
      if (await handle.isSameEntry(track.source.handle)) { previous = track; break; }
    } catch { /* A disconnected volume can make an older handle unavailable. */ }
  }
  previous ||= await identicalTrack(file, matches);
  if (previous?.source && !previous.missing && (previous.source.folderId || previous.source.nativeKey || !nativeKeys.has(handle))) {
    if (order && previous.fileName === file.name) {
      const names = namesForLink(file.name, previous, order);
      if (!sameTrackNames(previous, names) || previous.nameOrder !== names.nameOrder) {
        await store.updateTrack({ ...previous, ...names });
        Object.assign(previous, names);
      }
    }
    return { track: previous, reused: true };
  }
  const duration = readDuration ? await probe(file) : null;
  const track = linkedTrack(file, { handle: storedHandle(handle), nativeKey: nativeKeys.get(handle) }, previous, duration, order);
  await store.saveLinks([track]);
  tracks.set(track.id, track);
  return { track, reused: Boolean(previous) };
}

function linkHandles(handles, { list = "library", anchor, after, folder, targetDeck, reconnect = false, scans, order } = {}) {
  const job = linkJobs.then(async () => {
    const linked = new Map();
    let failed = 0;
    let reused = 0;
    let opened;
    let lastError = "";
    for (const handle of handles) {
      try {
        if (handle.kind === "directory") {
          const result = await indexFolder(handle, folder, scans?.get(handle), order);
          failed += result.failed;
          opened = result.id;
          for (const track of result.linked) linked.set(track.id, track);
        } else {
          const result = await linkFile(handle, !targetDeck, order);
          if (result.reused) reused++;
          linked.set(result.track.id, result.track);
        }
      } catch (error) {
        if (reconnect) throw error;
        failed++;
        lastError = error.message;
      }
    }
    orderedLibrary = null;
    if (targetDeck && linked.size) {
      cueDropped(targetDeck, newEntry(linked.values().next().value));
    } else if (list === "queue" && linked.size) {
      const position = state.queue.findIndex(item => item.id === anchor);
      const location = position < 0 ? state.queue.length : position + (after ? 1 : 0);
      const floor = state.queue[0]?.id === pendingId() ? 1 : 0;
      state.queue.splice(Math.max(location, floor), 0, ...Array.from(linked.values(), newEntry));
      record(null, "Tracks queued", linked.size + " linked tracks");
      queueUpdated();
    } else {
      engine.prepare();
      drawDecks();
    }
    drawLibrary();
    drawQueue();
    if (opened && !$("view-folders").hidden) showFolder(opened);
    if (opened) record(null, folder ? "Folder refreshed" : "Folder linked",
      store.folders.get(opened).name + " · " + linked.size + " tracks");
    else if (linked.size && !targetDeck && list !== "queue") record(null, "Audio linked", linked.size + " tracks");
    const details = [linked.size + (linked.size === 1 ? " linked track" : " linked tracks"),
      reused ? reused + " existing" : "", failed ? failed + " unreadable" : ""].filter(Boolean).join(", ");
    if (!targetDeck || failed) notify(details + "." + (lastError ? " " + lastError : ""), Boolean(failed));
  });
  linkJobs = job.catch(error => { if (!reconnect) notify(error.message, true); });
  return reconnect ? job : linkJobs;
}

function showTrackPreview(panel, rows, names = entry => entry) {
  const table = panel.querySelector("tbody");
  const search = panel.querySelector("input");
  const previous = panel.querySelector("[data-preview-previous]");
  const next = panel.querySelector("[data-preview-next]");
  const count = panel.querySelector("[data-preview-count]");
  const pageSize = 50;
  let offset = 0;
  let matches = rows;
  const draw = () => {
    table.replaceChildren();
    for (const entry of matches.slice(offset, offset + pageSize)) {
      const row = table.insertRow();
      cell(row, entry.fileName);
      const { title, artist } = names(entry);
      cell(row, title);
      cell(row, artist || "—");
    }
    count.textContent = matches.length ? (offset + 1) + "–" + Math.min(offset + pageSize, matches.length) + " of " + matches.length : "No matching files";
    previous.disabled = offset === 0;
    next.disabled = offset + pageSize >= matches.length;
  };
  search.value = "";
  search.oninput = () => {
    const text = search.value.trim().toLowerCase();
    matches = text ? rows.filter(entry => {
      const { title, artist } = names(entry);
      return [entry.fileName, title, artist].some(name => name.toLowerCase().includes(text));
    }) : rows;
    offset = 0;
    draw();
  };
  previous.onclick = () => { offset -= pageSize; draw(); };
  next.onclick = () => { offset += pageSize; draw(); };
  panel.hidden = !rows.length;
  draw();
  return search.oninput;
}

let musicPreview;

async function previewMusic(handles, options = {}) {
  const dialog = $("music-preview-dialog");
  if (dialog.open) return notify("Finish reviewing the current import first.", true);
  if (!handles.length) return;
  const preview = { handles: [], options, scans: new Map() };
  musicPreview = preview;
  const status = $("music-preview-status");
  const confirm = $("music-preview-confirm");
  const panel = $("music-preview");
  const order = $("music-filename-order");
  order.value = options.folder?.nameOrder || defaultNameOrder;
  order.disabled = true;
  order.onchange = null;
  panel.hidden = true;
  confirm.disabled = true;
  status.textContent = "Reading audio filenames…";
  dialog.showModal();
  const rows = [];
  const linkedByFolder = new Map();
  const linkedFiles = new Map();
  for (const track of tracks.values()) {
    if (track.source?.folderId) {
      const files = linkedByFolder.get(track.source.folderId) || new Map();
      files.set(JSON.stringify(track.source.path), track);
      linkedByFolder.set(track.source.folderId, files);
    } else if (track.source?.handle) {
      const files = linkedFiles.get(track.fileName) || [];
      files.push(track);
      linkedFiles.set(track.fileName, files);
    }
  }
  let unreadable = 0;
  for (const handle of handles) {
    if (musicPreview !== preview || !dialog.open) return;
    try {
      if (handle.kind === "directory") {
        const scan = { directories: [], files: [], failed: 0 };
        await walkFolder(handle, [], scan);
        preview.scans.set(handle, scan);
        unreadable += scan.failed;
        if (!scan.files.length) continue;
        const folder = options.folder || await findLinkedFolder(handle);
        if (handles.length === 1 && folder?.nameOrder) order.value = folder.nameOrder;
        for (const { file, path } of scan.files) {
          rows.push({ fileName: [handle.name, ...path].join(" / "), basename: file.name,
            previous: linkedByFolder.get(folder?.id)?.get(JSON.stringify(path)) });
        }
      } else {
        if (!audioExtension.test(handle.name) && !(await handle.getFile()).type.startsWith("audio/")) {
          unreadable++;
          continue;
        }
        let previous;
        for (const candidate of linkedFiles.get(handle.name) || []) {
          if (await handle.isSameEntry(candidate.source.handle).catch(() => false)) {
            previous = candidate;
            break;
          }
        }
        if (handles.length === 1 && previous?.nameOrder) order.value = previous.nameOrder;
        rows.push({ fileName: handle.name, basename: handle.name, previous });
      }
      preview.handles.push(handle);
    } catch { unreadable++; }
  }
  if (musicPreview !== preview || !dialog.open) return;
  order.onchange = showTrackPreview(panel, rows, entry => namesForLink(entry.basename, entry.previous, order.value));
  order.disabled = !rows.length;
  status.textContent = rows.length ? rows.length + (rows.length === 1 ? " audio file ready to link." : " audio files ready to link.")
    : "No supported audio files were found.";
  if (unreadable) status.textContent += " Skipped " + unreadable + " unreadable or unsupported items.";
  confirm.textContent = options.targetDeck ? "Link and cue" : options.list === "queue" ? "Link and queue" : "Link audio";
  confirm.disabled = !rows.length;
}

async function pickFolder(folder = null) {
  if (!nativePickerReady && !window.showDirectoryPicker) return notify("Folder linking needs a current Chromium-based browser or the Station Pilot desktop app.", true);
  try {
    const handles = nativePickerReady
      ? await pickNativeAudio("pick-folder")
      : [await window.showDirectoryPicker({ mode: "read" })];
    if (handles.length) await previewMusic(handles, { folder });
  } catch (error) {
    if (error.name !== "AbortError") notify("Could not link the folder. " + error.message, true);
  }
}

async function pickAudio() {
  if (!nativePickerReady && !window.showOpenFilePicker) return notify("File linking needs a current Chromium-based browser or the Station Pilot desktop app.", true);
  try {
    const extensions = [".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".aif", ".aiff", ".wma"];
    const handles = nativePickerReady ? await pickNativeAudio("pick-audio")
      : await window.showOpenFilePicker({ multiple: true, types: [{ description: "Audio files", accept: { "audio/*": extensions } }] });
    if (handles.length) await previewMusic(handles);
  } catch (error) {
    if (error.name !== "AbortError") notify("Could not link audio. " + error.message, true);
  }
}

function pickNativeAudio(action) {
  if (dockPath) return dockFetch("pick", { folder: action === "pick-folder" }).then(links => links.map(unixHandle));
  if (window.stationPilotUnix) return desktopInvoke("pick_sources", { folder: action === "pick-folder" }).then(links => links.map(unixHandle));
  if (nativePickerResult) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    windowsBridge.postMessage(action);
    nativePickerResult = { resolve, reject };
  });
}

async function refreshFolder(folder) {
  try {
    const handle = await sourceHandle(folder);
    if (await handle.queryPermission({ mode: "read" }) === "granted") {
      return linkHandles([handle], { folder });
    }
  } catch { /* Offer the picker when the bookmark is unavailable. */ }
  promptReconnect(null, folder);
}

function promptReconnect(track, folder = store.folders.get(track?.source?.folderId)) {
  if (dockShared) return notify("Reconnect this music in the Station Pilot desktop app.", true);
  if ($("reconnect-dialog").open) return;
  reconnectSource = { track, folder };
  $("reconnect-detail").textContent = folder ? "Station Pilot needs access to “" + folder.name + "” and its subfolders."
    : "Station Pilot needs access to “" + track.fileName + "”.";
  $("reconnect-choose").textContent = folder ? "Choose folder" : "Choose file";
  $("reconnect-status").textContent = "";
  $("reconnect-dialog").showModal();
}

async function restoreSelection() {
  const { track, folder } = reconnectSource;
  const button = $("reconnect-choose");
  button.disabled = true;
  try {
    const handles = nativePickerReady ? await pickNativeAudio(folder ? "pick-folder" : "pick-audio")
      : folder ? [await window.showDirectoryPicker({ mode: "read" })] : await window.showOpenFilePicker();
    if (!handles.length) return;
    const handle = handles[0];
    if (folder) {
      $("reconnect-status").textContent = "Reading the folder and its subfolders…";
      await linkHandles([handle], { folder, reconnect: true });
    } else {
      const file = await handle.getFile();
      if (!audioExtension.test(file.name) && !file.type.startsWith("audio/")) throw new Error("Choose a supported audio file.");
      if (file.size !== track.size) throw new Error("Choose the original audio file, " + track.fileName + ".");
      const updated = { ...track, fileName: file.name, modified: file.lastModified, missing: false, source: { handle: storedHandle(handle), nativeKey: nativeKeys.get(handle) } };
      await store.updateTrack(updated);
      Object.assign(track, updated);
      orderedLibrary = null;
      engine.prepare();
      drawLibrary();
    }
    for (const entry of engine.cues.values()) entry.track = tracks.get(entry.trackId) || entry.track;
    for (const waveform of Object.values(engine.waveforms)) {
      const shown = waveform.track;
      if (shown && (shown.id === track?.id || (folder && shown.source?.folderId === folder.id))) waveform.select(null);
    }
    if (track) probedDurations.delete(track);
    drawDecks();
    scanDurations();
    $("reconnect-dialog").close();
    if ($("missing-music-dialog").open) drawMissingMusic();
    notify("Music reconnected.");
  } catch (error) {
    if (error.name !== "AbortError") $("reconnect-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function saveAudioDuration(track, duration) {
  const current = tracks.get(track.id);
  if (!current || current.duration === duration) return;
  current.duration = duration;
  track.duration = duration;
  if (!dockShared) store.updateTrack(current).catch(storageError);
  refreshDurations();
}

function backupBookmark(source) {
  const link = source.handle?.nativeLink;
  return { nativeKey: source.nativeKey, nativeLink: link ? { key: link.key, parts: link.parts } : undefined };
}

function exportLinkedLibrary() {
  const folders = [...store.folders.values()].map(folder =>
    ({ id: folder.id, name: folder.name, nameOrder: folder.nameOrder, directories: folder.directories || [], ...backupBookmark(folder) }));
  const files = [...tracks.values()].filter(track => track.source).map(track => {
    const { id, title, artist, category, rotation, duration, fileName, size, modified, source, namesEdited, nameOrder } = track;
    const location = source.folderId ? { folderId: source.folderId, path: source.path } : backupBookmark(source);
    return { id, title, artist, category, rotation, duration: duration ?? null, fileName, size, modified, source: location, namesEdited, nameOrder };
  });
  return { folders, files, categories: categories() };
}

function readLinkedLibrary(library) {
  const valid = (condition, label) => {
    if (!condition) throw new Error("Invalid linked library: " + label + ".");
  };
  const string = (value, max) => typeof value === "string" && value.length <= max;
  const part = value => string(value, 1024) && value && ![".", ".."].includes(value) && !/[\/\x00]/.test(value);
  const path = value => Array.isArray(value) && value.length <= 128 && value.every(part);
  const id = value => string(value, 128) && value.length > 0;
  const key = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
  const bookmark = source => {
    const result = {};
    if (source.nativeKey !== undefined) {
      valid(key(source.nativeKey), "Windows bookmark");
      result.nativeKey = source.nativeKey;
    }
    if (source.nativeLink !== undefined) {
      const link = source.nativeLink;
      valid(key(link?.key) && path(link.parts), "desktop bookmark");
      result.nativeLink = { key: link.key, parts: link.parts };
    }
    return result;
  };
  valid(Array.isArray(library?.folders) && Array.isArray(library.files) && Array.isArray(library.categories), "expected folders, files and categories");
  valid(library.categories.every(name => string(name, 80) && name.trim()), "category name");
  const nameOrder = value => ["title-artist", "artist-title"].includes(value) ? value : undefined;
  const folderIds = new Set();
  const folders = library.folders.map(folder => {
    valid(id(folder?.id) && !folderIds.has(folder.id) && part(folder.name)
      && Array.isArray(folder.directories) && folder.directories.every(path), "folder details");
    folderIds.add(folder.id);
    return { id: folder.id, name: folder.name, nameOrder: nameOrder(folder.nameOrder), directories: folder.directories, ...bookmark(folder) };
  });
  const fileIds = new Set();
  const files = library.files.map(track => {
    valid(id(track?.id) && !fileIds.has(track.id) && part(track.fileName)
      && string(track.title, 1024) && string(track.artist, 1024) && string(track.category, 80)
      && typeof track.rotation === "boolean" && Number.isSafeInteger(track.size) && track.size >= 0
      && Number.isFinite(track.modified) && (track.duration === null || Number.isFinite(track.duration) && track.duration >= 0)
      && track.source && typeof track.source === "object", "track details");
    fileIds.add(track.id);
    const { id: trackId, fileName, title, artist, category, rotation, size, modified, duration, source } = track;
    let location = bookmark(source);
    if (source.folderId !== undefined) {
      valid(folderIds.has(source.folderId) && path(source.path) && source.path.at(-1) === fileName, "track path");
      location = { folderId: source.folderId, path: source.path };
    }
    return correctedTrackNames({ id: trackId, fileName, title, artist, category, rotation, size, modified, duration,
      source: location, namesEdited: track.namesEdited === true, nameOrder: nameOrder(track.nameOrder) });
  });
  return { folders, files, categories: library.categories };
}

async function importedHandle(bookmark, current, kind, name, currentName = name) {
  const saved = { nativeKey: bookmark.nativeKey };
  if ((window.stationPilotUnix || dockPath) && bookmark.nativeLink) saved.handle = { nativeLink: { ...bookmark.nativeLink, kind, name } };
  for (const source of [current, saved]) {
    try {
      const handle = await sourceHandle(source);
      const expectedName = source === current ? currentName : name;
      if (handle?.kind === kind && handle.name === expectedName && await handle.queryPermission({ mode: "read" }) === "granted") return handle;
    } catch { /* The picker can grant a replacement location. */ }
  }
  return null;
}

async function prepareImportedLibrary(library) {
  const available = new Map();
  const folders = [];
  for (const backup of library.folders) {
    const { nativeLink, ...folder } = backup;
    const current = store.folders.get(folder.id);
    try {
      const handle = await importedHandle(backup, current, "directory", folder.name, current?.name);
      if (!handle) throw new Error("Folder unavailable.");
      const scan = { directories: [], files: [], failed: 0 };
      await walkFolder(handle, [], scan);
      available.set(folder.id, new Set(scan.files.map(item => JSON.stringify(item.path))));
      folders.push({ ...folder, name: handle.name, directories: scan.directories, handle: storedHandle(handle), nativeKey: nativeKeys.get(handle), missing: false });
    } catch {
      folders.push({ ...folder, handle: nativeLink ? { nativeLink: { ...nativeLink, kind: "directory", name: folder.name } } : undefined, missing: true });
    }
  }
  const files = [];
  for (const track of library.files) {
    const existing = tracks.get(track.id);
    const { folderId, nativeLink, nativeKey } = track.source;
    if (existing && !existing.source) continue;
    if (folderId && (!existing || existing.source.folderId || existing.missing)) {
      files.push({ ...track, missing: !available.get(folderId)?.has(JSON.stringify(track.source.path)) });
      continue;
    }
    const handle = await importedHandle(track.source, existing?.source, "file", track.fileName, existing?.fileName);
    try {
      if (!handle) throw new Error("File unavailable.");
      const file = handle.nativeLink
        ? (dockPath ? await dockFetch("stat", handle.nativeLink) : await desktopInvoke("inspect_link", handle.nativeLink))
        : await handle.getFile();
      if (file.name !== handle.name || file.size !== track.size) throw new Error("File changed.");
      files.push({ ...track, fileName: file.name, modified: file.lastModified ?? file.modified, source: { handle: storedHandle(handle), nativeKey: nativeKeys.get(handle) }, missing: false });
    } catch {
      if (folderId) {
        files.push({ ...track, missing: !available.get(folderId)?.has(JSON.stringify(track.source.path)) });
        continue;
      }
      files.push({ ...track, source: { nativeKey, handle: nativeLink ? { nativeLink: { ...nativeLink, kind: "file", name: track.fileName } } : undefined }, missing: true });
    }
  }
  const merged = new Map(tracks);
  for (const track of files) merged.set(track.id, track);
  const folderTracks = new Map();
  for (const track of merged.values()) {
    const folderId = track.source?.folderId;
    if (folderId) folderTracks.set(folderId, (folderTracks.get(folderId) || 0) + 1);
  }
  for (const folder of folders) folder.count = folderTracks.get(folder.id) || 0;
  return { folders, files };
}

function drawMissingMusic() {
  const list = $("missing-music");
  list.replaceChildren();
  for (const folder of store.folders.values()) {
    if (!folder.missing) continue;
    const row = list.insertRow();
    cell(row, folder.name);
    action(cell(row, ""), "Locate folder", () => promptReconnect(null, folder), "Locate folder " + folder.name);
  }
  for (const track of tracks.values()) {
    const folder = store.folders.get(track.source?.folderId);
    if (!track.missing || folder?.missing) continue;
    const row = list.insertRow();
    cell(row, folder ? [folder.name, ...track.source.path].join(" / ") : track.fileName);
    action(cell(row, ""), "Locate file", () => promptReconnect(track, null), "Locate file " + track.fileName);
  }
  const count = list.rows.length;
  $("missing-music-list").hidden = !count;
  $("missing-music-status").textContent = count ? "Choose the current location of each missing source." : "All linked music locations are available.";
  return count;
}

function bindLinkedLibrary() {
  const previewDialog = $("music-preview-dialog");
  previewDialog.addEventListener("close", () => {
    if (!previewDialog.open) musicPreview = null;
  });
  $("music-preview-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!musicPreview?.handles.length || $("music-preview-confirm").disabled) return;
    const { handles, options, scans } = musicPreview;
    musicPreview = null;
    previewDialog.close();
    linkHandles(handles, { ...options, scans, order: $("music-filename-order").value });
  });
  window.addEventListener("station-native-drop", event => {
    if (!window.stationPilotUnix || dragged) return;
    const { links, x, y } = event.detail;
    const list = document.elementFromPoint(x, y)?.closest("[data-drop]")?.dataset.drop || "library";
    const targetDeck = ["A","B"].includes(list) ? list : null;
    if (targetDeck && (links.length !== 1 || links[0].kind !== "file")) return notify("Drop one song on a deck.", true);
    const target = document.elementFromPoint(x, y);
    const row = target?.closest("tr[data-entry]");
    const bounds = row?.getBoundingClientRect();
    previewMusic(links.map(unixHandle), { list, targetDeck, anchor: row?.dataset.entry,
      after: Boolean(bounds && y >= bounds.top + bounds.height / 2) });
  });
  $("include-subfolders").addEventListener("change", drawFolders);
  $("reconnect-choose").addEventListener("click", restoreSelection);
  $("reconnect-dialog").addEventListener("cancel", event => { if ($("reconnect-choose").disabled) event.preventDefault(); });
  window.chrome?.webview?.addEventListener("message", event => {
    const message = event.data;
    const handles = message?.type === "pilot-picker-files" ? Array.from(event.additionalObjects) : null;
    if (handles) {
      handles.forEach((handle, index) => {
        const key = message.keys?.[index];
        if (key) { nativeKeys.set(handle, key); liveHandles.set(key, handle); }
      });
    }
    const request = nativeRequests.get(message?.request);
    if (request) {
      request.finish(handles);
      return;
    }
    if (message?.request && message.request !== "picker") return;
    if (event.data?.type === "pilot-picker-ready") nativePickerReady = true;
    if (!nativePickerResult) return;
    const { resolve, reject } = nativePickerResult;
    switch (event.data?.type) {
      case "pilot-picker-files":
        resolve(handles);
        break;
      case "pilot-picker-canceled":
        resolve([]);
        break;
      case "pilot-picker-error":
        reject(new Error("Windows could not open the selected files."));
        break;
      default: return;
    }
    nativePickerResult = null;
  });
  $("import").addEventListener("click", pickAudio);
  $("import-folder").addEventListener("click", () => pickFolder());
  $("link-folder").addEventListener("click", () => pickFolder());
  $("new-category").addEventListener("click", () => {
    $("category-form").reset();
    $("category-dialog").showModal();
  });
  $("category-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = event.target.elements.categoryName.value.trim();
    if (!name) {
      notify("Enter a category name.", true);
      return;
    }
    const existing = categories().find(item => item.toLowerCase() === name.toLowerCase());
    if (!existing) {
      state.categories.push(name);
      save();
    }
    currentCategory = existing || name;
    $("category-dialog").close();
    drawCategories();
    notify(existing ? "Opened " + existing + "." : "Created category " + name + ".");
  });
}
