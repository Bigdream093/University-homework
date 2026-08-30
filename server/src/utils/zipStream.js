import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

// 纯 Node 实现的流式 ZIP 写入（STORE 方式，不调用任何外部网络请求库）。
// 通过 data descriptor 实现大文件流式写入，兼容主流解压工具。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function createCrc() {
  let crc = 0xffffffff;
  return {
    update(buffer) {
      for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    },
    digest() { return (crc ^ 0xffffffff) >>> 0; }
  };
}

function crc32(buffer) {
  const hasher = createCrc();
  hasher.update(buffer);
  return hasher.digest();
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function localHeader(nameBuffer, crc, size, { descriptor }) {
  const buffer = Buffer.alloc(30 + nameBuffer.length);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(descriptor ? 0x0808 : 0x0800, 6); // 0x0800=UTF-8 文件名，0x0008=数据描述符
  buffer.writeUInt16LE(0, 8); // STORE
  buffer.writeUInt16LE(dosDateTime().time, 10);
  buffer.writeUInt16LE(dosDateTime().date, 12);
  buffer.writeUInt32LE(descriptor ? 0 : crc, 14);
  buffer.writeUInt32LE(descriptor ? 0 : size, 18);
  buffer.writeUInt32LE(descriptor ? 0 : size, 22);
  buffer.writeUInt16LE(nameBuffer.length, 26);
  buffer.writeUInt16LE(0, 28); // extra length
  nameBuffer.copy(buffer, 30);
  return buffer;
}

function dataDescriptor(crc, size) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(0x08074b50, 0);
  buffer.writeUInt32LE(crc, 4);
  buffer.writeUInt32LE(size, 8);
  buffer.writeUInt32LE(size, 12);
  return buffer;
}

function centralEntry(nameBuffer, crc, size, localOffset, { descriptor }) {
  const buffer = Buffer.alloc(46 + nameBuffer.length);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4); // version made by
  buffer.writeUInt16LE(20, 6); // version needed
  buffer.writeUInt16LE(descriptor ? 0x0808 : 0x0800, 8);
  buffer.writeUInt16LE(0, 10); // STORE
  buffer.writeUInt16LE(dosDateTime().time, 12);
  buffer.writeUInt16LE(dosDateTime().date, 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(nameBuffer.length, 28);
  buffer.writeUInt16LE(0, 30); // extra length
  buffer.writeUInt16LE(0, 32); // comment length
  buffer.writeUInt16LE(0, 34); // disk number start
  buffer.writeUInt16LE(0, 36); // internal attrs
  buffer.writeUInt32LE(0, 38); // external attrs
  buffer.writeUInt32LE(localOffset, 42);
  nameBuffer.copy(buffer, 46);
  return buffer;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4); // disk number
  buffer.writeUInt16LE(0, 6); // disk with central directory
  buffer.writeUInt16LE(entryCount, 8);
  buffer.writeUInt16LE(entryCount, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  buffer.writeUInt16LE(0, 20); // comment length
  return buffer;
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[\\/]/g, '_');
}

async function* zipEntries(entries) {
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(sanitizeName(entry.name), 'utf8');
    const localOffset = offset;

    if (entry.content !== undefined && entry.content !== null) {
      const data = Buffer.from(String(entry.content), 'utf8');
      const crc = crc32(data);
      const header = localHeader(nameBuffer, crc, data.length, { descriptor: false });
      yield header;
      yield data;
      central.push(centralEntry(nameBuffer, crc, data.length, localOffset, { descriptor: false }));
      offset += header.length + data.length;
      continue;
    }

    const stat = fs.statSync(entry.path);
    yield localHeader(nameBuffer, 0, 0, { descriptor: true });
    offset += 30 + nameBuffer.length;
    const hasher = createCrc();
    for await (const chunk of fs.createReadStream(entry.path)) {
      hasher.update(chunk);
      yield chunk;
      offset += chunk.length;
    }
    const crc = hasher.digest();
    const descriptor = dataDescriptor(crc, stat.size);
    yield descriptor;
    offset += descriptor.length;
    central.push(centralEntry(nameBuffer, crc, stat.size, localOffset, { descriptor: true }));
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of central) {
    yield entry;
    centralSize += entry.length;
  }
  yield endOfCentralDirectory(central.length, centralSize, centralOffset);
}

export async function pipeZipToResponse(entries, response) {
  try {
    await pipeline(zipEntries(entries), response);
  } catch {
    // 客户端断开或打包中断时静默结束，避免向已断开的连接写入
    if (!response.destroyed) response.destroy();
  }
}
