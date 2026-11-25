"use strict";

const dockPath = /^\/dock\/[0-9a-f]{32}\/$/.test(location.pathname) ? location.pathname : "";
let dockShared = false;
let dockRevision = "";
let dockSyncTimer;
let dockDesktopStatus;
let dockPublishTimer;
let dockUnreachable = false;
const dockRequests = new Map();

async function dockFetch(route, values) {
  const headers = { "X-Station-Pilot": "dock" };
  const options = { headers, cache: "no-store" };
  if (values !== undefined) {
    headers["Content-Type"] = "application/json";
    options.method = "POST";
    options.body = JSON.stringify(values);
  }
  const response = await fetch(dockPath + "api/" + route, options);
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error || "The Station Pilot dock is unavailable.");
  }
  return route === "audio" ? response.arrayBuffer() : response.json();
}

function desktopDock(request) {
  if (window.stationPilotUnix) return desktopInvoke("dock_command", { request });
  return new Promise((resolve, reject) => {
    const id = workstationId();
    const timer = setTimeout(() => {
      dockRequests.delete(id);
      reject(new Error("The desktop did not respond."));
    }, 10000);
    dockRequests.set(id, { resolve, reject, timer });
    try {
      windowsBridge.postMessage("dock:" + JSON.stringify({ id, request }));
    } catch (error) {
      clearTimeout(timer);
      dockRequests.delete(id);
      reject(error);
    }
  });
}

function desktopDockSnapshot() {
  const library = exportLinkedLibrary();
  for (const folder of library.folders) folder.missing = Boolean(store.folders.get(folder.id)?.missing);
  for (const track of library.files) track.missing = Boolean(tracks.get(track.id)?.missing);
  return { settings: state.settings, library, platform: windowsBridge ? "windows" : "unix" };
}

function publishDockLibrary() {
  if (!dockDesktopStatus?.enabled || !dockDesktopStatus.shared) return;
  if (dockPublishTimer) return;
  dockPublishTimer = setTimeout(() => {
    dockPublishTimer = undefined;
    if (!dockDesktopStatus?.enabled || !dockDesktopStatus.shared) return;
    desktopDock({ action: "publish", snapshot: desktopDockSnapshot() })
      .catch(error => { $("dock-feedback").textContent = error.message || String(error); });
  }, 400);
}

function bindDockDesktop() {
  if (!windowsBridge && !window.stationPilotUnix) return;
  windowsBridge?.addEventListener("message", ({ data }) => {
    if (data?.type !== "pilot-dock") return;
    const pending = dockRequests.get(data.id);
    if (!pending) return;
    dockRequests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.value);
  });
  const section = $("dock-section");
  const enabled = $("dock-enable");
  const portInput = $("dock-port");
  const shared = $("dock-shared");
  const closeAction = $("dock-close-action");
  const check = $("dock-check");
  const apply = $("dock-apply");
  const copy = $("dock-copy");
  const url = $("dock-url");
  const feedback = $("dock-feedback");
  section.hidden = false;
  const showStatus = status => {
    dockDesktopStatus = status;
    enabled.checked = status.enabled;
    portInput.value = status.port || "";
    shared.checked = status.shared;
    closeAction.value = status.closeAction;
    closeAction.querySelector('option[value="tray"]').disabled = !status.trayAvailable;
    url.value = status.url || "";
    copy.disabled = !status.url;
    feedback.textContent = status.error || (status.enabled ? "Ready to paste into an OBS custom browser dock." : "");
  };
  const getPort = () => {
    if (!portInput.reportValidity()) throw new Error("Enter a port from 1 to 65535, or leave it blank for Auto.");
    return portInput.valueAsNumber || 0;
  };
  const report = error => { feedback.textContent = error.message || String(error); };
  const ready = desktopDock({ action: "status" });
  ready.then(status => { showStatus(status); publishDockLibrary(); }).catch(report);
  check.addEventListener("click", async () => {
    try {
      await ready;
      await desktopDock({ action: "check", port: getPort() });
      feedback.textContent = portInput.value ? "Port available for Station Pilot." : "Auto will select a free port.";
    } catch (error) { report(error); }
  });
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    try {
      await ready;
      const preferences = { enabled: enabled.checked, port: getPort(), shared: shared.checked, closeAction: closeAction.value };
      const snapshot = preferences.enabled && preferences.shared ? desktopDockSnapshot() : null;
      showStatus(await desktopDock({ action: "apply", preferences, snapshot }));
    } catch (error) { report(error); }
    finally { apply.disabled = false; }
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      feedback.textContent = "Dock URL copied.";
    } catch {
      url.focus();
      url.select();
      if (document.execCommand("copy")) feedback.textContent = "Dock URL copied.";
      else feedback.textContent = "The URL is selected. Copy it with your keyboard.";
    }
  });
  for (const button of document.querySelectorAll("[data-desktop-close]")) {
    button.addEventListener("click", () => {
      $("close-desktop-dialog").close();
      desktopDock({ action: "close", keep: button.dataset.desktopClose === "tray" }).catch(error => notify(error.message, true));
    });
  }
}

function dockLibrary(snapshot) {
  const library = readLinkedLibrary(snapshot.library);
  const bookmark = (entry, kind, name) => {
    const key = snapshot.platform === "windows" ? entry.nativeKey : entry.nativeLink?.key;
    return key ? { nativeLink: { key, parts: entry.nativeLink?.parts || [], kind, name } } : undefined;
  };
  const missingFolders = new Set(snapshot.library.folders.filter(folder => folder.missing).map(folder => folder.id));
  const missingTracks = new Set(snapshot.library.files.filter(track => track.missing).map(track => track.id));
  const folders = library.folders.map(folder => {
    const handle = bookmark(folder, "directory", folder.name);
    return { ...folder, handle, missing: !handle || missingFolders.has(folder.id), count: 0 };
  });
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const files = library.files.map(track => {
    const { source } = track;
    if (source.folderId) {
      const folder = byId.get(source.folderId);
      folder.count++;
      return { ...track, missing: folder.missing || missingTracks.has(track.id) };
    }
    const handle = bookmark(source, "file", track.fileName);
    return { ...track, source: { handle }, missing: !handle || missingTracks.has(track.id) };
  });
  return { ...library, folders, files };
}

function applyDockProfile(snapshot) {
  const library = dockLibrary(snapshot);
  store.folders.clear();
  for (const folder of library.folders) store.folders.set(folder.id, folder);
  const prior = new Map(tracks);
  tracks.clear();
  for (const track of library.files) {
    const previous = prior.get(track.id);
    tracks.set(track.id, previous ? Object.assign(previous, track, { duration: track.duration ?? previous.duration }) : track);
  }
  state.categories = library.categories;
  const settings = readSettingsBackup({ app: "station-pilot", version: 1, settings: snapshot.settings });
  state.settings = { ...settings, sinkId: "" };
  state.queue = state.queue.filter(item => item.stop || tracks.has(item.trackId));
  state.events = state.events.filter(item => tracks.has(item.trackId));
  orderedLibrary = null;
}

async function initializeDock() {
  if (!dockPath) return null;
  const profile = await dockFetch("profile");
  dockShared = profile.shared;
  dockRevision = profile.revision;
  return profile.snapshot || null;
}

function bindDockView() {
  if (!dockPath) return;
  $("dock-profile-note").hidden = false;
  $("dock-profile-note").textContent = dockShared
    ? "This dock follows the desktop’s settings and linked music. Edit them in the desktop app. The dock uses the browser’s default audio output."
    : "This dock has its own settings and library.";
  if (dockShared) {
    for (const id of ["auto", "key-lock", "gain", "scheduler", "processor", "settings", "general-output",
      "import", "import-folder", "link-folder", "new-category", "library-remove-selected"]) $(id).disabled = true;
    $("backup-title").parentElement.hidden = true;
  }
  $("dock-indicator").hidden = false;
  $("dock-indicator").textContent = dockShared ? "OBS · Shared profile" : "OBS · Separate profile";
  const update = async () => {
    try {
      const profile = await dockFetch("profile?since=" + dockRevision);
      if (profile.shared !== dockShared) {
        location.reload();
        return;
      }
      if (profile.snapshot) {
        applyDockProfile(profile.snapshot);
        dockRevision = profile.revision;
        syncSettingsControls();
        engine.configure();
        engine.prepare();
        drawLibrary();
        drawQueue();
        drawSchedule();
        drawDecks();
      }
      if (dockUnreachable) note("OBS dock connected.");
      dockUnreachable = false;
    } catch {
      if (!dockUnreachable) note("OBS dock disconnected. Open Station Pilot or check the dock URL.", true);
      dockUnreachable = true;
    }
    dockSyncTimer = setTimeout(update, 2500);
  };
  dockSyncTimer = setTimeout(update, 2500);
  window.addEventListener("pagehide", () => clearTimeout(dockSyncTimer), { once: true });
}
