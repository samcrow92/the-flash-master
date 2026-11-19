/**
 * Minimal ZIP reader for the folder archives EWM's file content service sends (`IFilesystemContentService …&format=zip`,
 * the web UI's "Download as zip"). Stored and deflated entries; no ZIP64 or encryption (EWM doesn't use them for this).
 * Node's zlib does the inflating, so no dependency is added.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry { path: string; folder: boolean; size: number; data(): Buffer }

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error("the archive is too large (ZIP64); pick a smaller folder");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error("damaged zip archive");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    const folder = name.endsWith("/");
    const path = name.replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").includes("..")) continue;
    out.push({
      path, folder, size,
      data: () => {
        if (folder) return Buffer.alloc(0);
        if (buf.readUInt32LE(loc) !== LOC) throw new Error(`damaged zip entry ${path}`);
        const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`${path}: unsupported zip compression ${method}`);
      },
    });
  }
  return out;
}
