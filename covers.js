"use strict";

const COVER_LIMIT = 12 * 1024 * 1024;
const coverCache = new Map();

function tag(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function syncSize(bytes, offset) {
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

function picture(bytes) {
  const limit = Math.min(2048, bytes.length);
  for (let i = 0; i < limit; i++) {
    let type;
    if (bytes[i] === 255 && bytes[i + 1] === 216 && bytes[i + 2] === 255) type = "image/jpeg";
    if (bytes[i] === 137 && tag(bytes, i + 1, "PNG\r\n")) type = "image/png";
    if (tag(bytes, i, "RIFF") && tag(bytes, i + 8, "WEBP")) type = "image/webp";
    if (tag(bytes, i, "GIF87a") || tag(bytes, i, "GIF89a")) type = "image/gif";
    if (type) return new Blob([bytes.subarray(i)], { type });
  }
  return null;
}

async function readPart(blob, start, length) {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

async function id3Cover(blob) {
  const header = await readPart(blob, 0, 10);
  if (!tag(header, 0, "ID3") || ![2, 3, 4].includes(header[3])) return null;
  const version = header[3];
  const length = syncSize(header, 6);
  if (length < 7 || length > COVER_LIMIT) return null;
  const data = await readPart(blob, 10, length);
  const view = new DataView(data.buffer);
  const frameHeader = version === 2 ? 6 : 10;
  let pos = 0;
  if (header[5] & 0x40) {
    if (data.length < 4 || version === 2) return null;
    pos = version === 4 ? syncSize(data, 0) : 4 + view.getUint32(0);
  }
  let other = null;
  while (pos + frameHeader < data.length && data[pos]) {
    const size = version === 4 ? syncSize(data, pos + 4) : version === 3
      ? view.getUint32(pos + 4) : (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5];
    if (!size || size > data.length - pos - frameHeader) break;
    if (tag(data, pos, version === 2 ? "PIC" : "APIC")) {
      let frame = data.subarray(pos + frameHeader, pos + frameHeader + size);
      if ((header[5] & 0x80) || (version === 4 && (data[pos + 9] & 2))) {
        frame = frame.filter((byte, offset) => byte !== 0 || !offset || frame[offset - 1] !== 255);
      }
      const typeOffset = version === 2 ? 4 : frame.indexOf(0, 1) + 1;
      const found = picture(frame);
      if (found && frame[typeOffset] === 3) return found;
      if (!other) other = found;
    }
    pos += frameHeader + size;
  }
  return other;
}

async function flacCover(blob) {
  let offset = 4;
  let other = null;
  for (let count = 0; count < 256 && offset + 4 <= blob.size; count++) {
    const block = await readPart(blob, offset, 4);
    const size = (block[1] << 16) | (block[2] << 8) | block[3];
    if (offset + 4 + size > blob.size) break;
    if ((block[0] & 127) === 6 && size <= COVER_LIMIT && size >= 32) {
      const image = await readPart(blob, offset + 4, size);
      const found = flacPicture(image);
      if (found?.front) return found.blob;
      if (!other && found) other = found.blob;
    }
    if (block[0] & 128) break;
    offset += 4 + size;
  }
  return other;
}

function flacPicture(bytes) {
  if (bytes.length < 32) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const description = 8 + view.getUint32(4);
  if (description + 24 > bytes.length) return null;
  const start = description + 24 + view.getUint32(description);
  const length = start <= bytes.length ? view.getUint32(start - 4) : 0;
  const found = length && start + length <= bytes.length ? picture(bytes.subarray(start, start + length)) : null;
  return found ? { front: view.getUint32(0) === 3, blob: found } : null;
}

async function riffCover(blob, littleEndian) {
  let offset = 12;
  for (let count = 0; count < 256 && offset + 8 <= blob.size; count++) {
    const chunk = await readPart(blob, offset, 8);
    const size = new DataView(chunk.buffer).getUint32(4, littleEndian);
    if (tag(chunk, 0, "id3 ") || tag(chunk, 0, "ID3 ")) return id3Cover(blob.slice(offset + 8, offset + 8 + size));
    offset += 8 + size + size % 2;
  }
  return null;
}

function commentCover(packet) {
  const header = tag(packet, 0, "OpusTags") ? 8 : packet[0] === 3 && tag(packet, 1, "vorbis") ? 7 : 0;
  if (!header || packet.length < header + 8) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let offset = header + 4 + view.getUint32(header, true);
  if (offset + 4 > packet.length) return null;
  const count = view.getUint32(offset, true);
  offset += 4;
  const text = new TextDecoder();
  let legacy = null;
  for (let i = 0; i < count && offset + 4 < packet.length; i++) {
    const size = view.getUint32(offset, true);
    offset += 4;
    if (size > packet.length - offset) break;
    const key = text.decode(packet.subarray(offset, offset + Math.min(size, 23))).split("=")[0].toUpperCase();
    if (key === "METADATA_BLOCK_PICTURE" || key === "COVERART") {
      try {
        const encoded = text.decode(packet.subarray(offset + key.length + 1, offset + size));
        const image = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        if (key === "METADATA_BLOCK_PICTURE") {
          const cover = flacPicture(image);
          if (cover) return cover.blob;
        } else legacy = picture(image);
      } catch { /* An invalid tag should not hide other artwork. */ }
    }
    offset += size;
  }
  return legacy;
}

async function oggCover(blob) {
  let size = 0;
  let packets = 0;
  let serial;
  let chunks = [];
  for (let offset = 0; offset + 27 < Math.min(blob.size, COVER_LIMIT) && packets < 2;) {
    const page = await readPart(blob, offset, 27);
    if (!tag(page, 0, "OggS")) break;
    const pageSerial = new DataView(page.buffer).getUint32(14, true);
    if (serial === undefined) serial = pageSerial;
    const lacing = await readPart(blob, offset + 27, page[26]);
    const length = lacing.reduce((total, segment) => total + segment, 0);
    offset += 27 + lacing.length;
    if (offset + length > blob.size || offset + length > COVER_LIMIT) break;
    if (serial === pageSerial) {
      const data = await readPart(blob, offset, length);
      let pos = 0;
      for (const segment of lacing) {
        if (packets === 1 && segment) {
          chunks.push(data.subarray(pos, pos + segment));
          size += segment;
        }
        pos += segment;
        if (segment < 255 && ++packets === 2) {
          const packet = new Uint8Array(size);
          let dest = 0;
          for (const chunk of chunks) { packet.set(chunk, dest); dest += chunk.length; }
          return commentCover(packet);
        }
      }
    }
    offset += length;
  }
  return null;
}

async function mp4Cover(blob, start, end, container = "", depth = 0) {
  if (depth > 8) return null;
  for (let offset = start, count = 0; count < 1024 && offset + 8 <= end; count++) {
    const atom = await readPart(blob, offset, Math.min(16, end - offset));
    const view = new DataView(atom.buffer);
    const name = String.fromCharCode(...atom.subarray(4, 8));
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1 && atom.length >= 16) { size = Number(view.getBigUint64(8)); header = 16; }
    if (!size) size = end - offset;
    if (size < header || !Number.isSafeInteger(size) || offset + size > end) break;
    const inner = offset + header;
    const limit = offset + size;
    if (name === "data" && container === "covr" && size - header > 8 && size <= COVER_LIMIT) {
      const data = await readPart(blob, inner + 8, limit - inner - 8);
      const found = picture(data);
      if (found) return found;
    }
    if (["moov", "udta", "meta", "ilst", "covr"].includes(name) && name !== container) {
      const found = await mp4Cover(blob, inner + (name === "meta" ? 4 : 0), limit, name, depth + 1);
      if (found) return found;
    }
    offset = limit;
  }
  return null;
}

async function embeddedCover(blob) {
  if (!blob) return null;
  const signature = await readPart(blob, 0, 12);
  if (tag(signature, 0, "ID3")) return id3Cover(blob);
  if (tag(signature, 0, "fLaC")) return flacCover(blob);
  if (tag(signature, 0, "RIFF") && tag(signature, 8, "WAVE")) return riffCover(blob, true);
  if (tag(signature, 0, "FORM") && (tag(signature, 8, "AIFF") || tag(signature, 8, "AIFC"))) return riffCover(blob, false);
  if (tag(signature, 0, "OggS")) return oggCover(blob);
  if (tag(signature, 4, "ftyp")) return mp4Cover(blob, 0, blob.size);
  return null;
}

function coverFor(track) {
  if (!coverCache.has(track.id)) {
    if (coverCache.size >= 24) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(track.id, store.readAudio(track).then(embeddedCover).catch(() => {
      coverCache.delete(track.id);
      return null;
    }));
  }
  return coverCache.get(track.id);
}

function drawCover(image, track) {
  const id = track ? track.id : "";
  if (image.dataset.track === id) return;
  image.dataset.track = id;
  if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src);
  image.removeAttribute("src");
  image.hidden = true;
  if (!id) return;
  coverFor(track).then(blob => {
    if (!blob || image.dataset.track !== id) return;
    image.src = URL.createObjectURL(blob);
    image.hidden = false;
  });
}
