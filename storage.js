"use strict";

class LocalStore {
  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("station-pilot", 2);
      request.onupgradeneeded = event => {
        if (event.oldVersion === 0) {
          request.result.createObjectStore("state");
          request.result.createObjectStore("media");
          request.result.createObjectStore("tracks", { keyPath: "id" });
          request.result.createObjectStore("history", { autoIncrement: true });
        }
        request.result.createObjectStore("folders", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(new LocalStore(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other Station Pilot tabs and reload."));
    });
  }

  constructor(database) {
    this.database = database;
    this.folders = new Map();
  }

  read(store, key) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(store);
      const objectStore = transaction.objectStore(store);
      const request = key === undefined ? objectStore.getAll() : objectStore.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  recentHistory(limit) {
    return new Promise((resolve, reject) => {
      const request = this.database.transaction("history").objectStore("history").openCursor(null, "prev");
      const rows = [];
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) return resolve(rows);
        rows.push(cursor.value);
        cursor.continue();
      };
    });
  }

  write(stores, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(stores, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      try {
        operation(transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  save(state) {
    return this.write(["state"], tx => tx.objectStore("state").put(state, "workstation"));
  }

  saveBackup(state, library) {
    return this.write(["state", "tracks", "folders"], tx => {
      tx.objectStore("state").put(state, "workstation");
      for (const track of library.files) tx.objectStore("tracks").put(track);
      for (const folder of library.folders) tx.objectStore("folders").put(folder);
    });
  }

  saveLinks(entries, folder) {
    return this.write(folder ? ["tracks", "folders"] : ["tracks"], tx => {
      const tracks = tx.objectStore("tracks");
      for (const track of entries) tracks.put(track);
      if (folder) tx.objectStore("folders").put(folder);
    });
  }

  async readAudio(track) {
    if (!track.source) return this.read("media", track.id);
    try {
      if (track.source.handle) return await (await sourceHandle(track.source)).getFile();
      let directory = await sourceHandle(this.folders.get(track.source.folderId));
      if (!directory) throw new DOMException("The music location is missing.", "NotFoundError");
      const segments = track.source.path;
      if (directory.nativeLink) {
        return await unixHandle({ ...directory.nativeLink, parts: segments, kind: "file", name: track.fileName, modified: track.modified }).getFile();
      }
      for (const name of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(name);
      const file = await directory.getFileHandle(segments.at(-1));
      return await file.getFile();
    } catch (error) {
      if (error.name === "NotAllowedError" || error.name === "SecurityError") {
        throw new DOMException("Reconnect the original music source.", "SourceAccessError");
      }
      if (error.name === "NotFoundError") throw new DOMException("The original file was moved, renamed, or disconnected.", "SourceAccessError");
      throw error;
    }
  }

  updateTrack(track) {
    return this.write(["tracks"], tx => tx.objectStore("tracks").put(track));
  }

  removeMedia(state, ids) {
    return this.write(["media", "tracks", "state"], tx => {
      for (const id of ids) {
        tx.objectStore("media").delete(id);
        tx.objectStore("tracks").delete(id);
      }
      tx.objectStore("state").put(state, "workstation");
    });
  }

  log(row) {
    return this.write(["history"], tx => tx.objectStore("history").add(row));
  }
}
