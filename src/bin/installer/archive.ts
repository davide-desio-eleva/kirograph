/**
 * KiroGraph Archive Utilities
 *
 * Shared, cross-platform archive extraction and HTTP download helpers.
 * Pure Node.js — no external binaries required (no unzip, tar, etc.).
 * Works on all platforms without CrowdStrike or antivirus interference.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';

// ── HTTP Helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch JSON from a URL, following redirects.
 */
export function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'kirograph' } } as any, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchJson(res.headers.location!));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (c: string) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/**
 * Download a file from a URL to a local path, following redirects.
 */
export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function doGet(currentUrl: string) {
      const mod = currentUrl.startsWith('https') ? https : http;
      mod.get(currentUrl, { headers: { 'User-Agent': 'kirograph' } } as any, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location!);
        if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

// ── ZIP Extraction ────────────────────────────────────────────────────────────

/**
 * Pure Node.js ZIP extractor — no external binary required.
 * Reads the ZIP central directory to locate file entries, then extracts
 * each one using Node's built-in zlib (DEFLATE) or raw copy (STORE).
 * Includes path traversal protection.
 *
 * Supports: STORE (method 0) and DEFLATE (method 8) compression.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const buf = await fs.promises.readFile(zipPath);
  const resolvedDest = path.resolve(destDir);

  // ── Locate End of Central Directory record ────────────────────────────────
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

  const cdCount  = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // ── Walk Central Directory entries ───────────────────────────────────────
  let cdPos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) throw new Error('Invalid ZIP: bad CD signature');

    const compMethod   = buf.readUInt16LE(cdPos + 10);
    const compSize     = buf.readUInt32LE(cdPos + 20);
    const uncompSize   = buf.readUInt32LE(cdPos + 24);
    const fileNameLen  = buf.readUInt16LE(cdPos + 28);
    const extraLen     = buf.readUInt16LE(cdPos + 30);
    const commentLen   = buf.readUInt16LE(cdPos + 32);
    const localOffset  = buf.readUInt32LE(cdPos + 42);
    const fileName     = buf.slice(cdPos + 46, cdPos + 46 + fileNameLen).toString('utf8');

    cdPos += 46 + fileNameLen + extraLen + commentLen;

    // Skip directory entries
    if (fileName.endsWith('/') || (uncompSize === 0 && compSize === 0)) continue;

    // Prevent path traversal
    const destPath = path.resolve(resolvedDest, fileName);
    if (!destPath.startsWith(resolvedDest + path.sep) && destPath !== resolvedDest) continue;

    // ── Read Local File Header to find data offset ────────────────────────
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP: bad LFH signature');
    const localFileNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen    = buf.readUInt16LE(localOffset + 28);
    const dataOffset       = localOffset + 30 + localFileNameLen + localExtraLen;

    const compData = buf.slice(dataOffset, dataOffset + compSize);

    // ── Decompress ────────────────────────────────────────────────────────
    let fileData: Buffer;
    if (compMethod === 0) {
      fileData = compData;
    } else if (compMethod === 8) {
      fileData = await new Promise<Buffer>((resolve, reject) => {
        zlib.inflateRaw(compData, (err, result) => err ? reject(err) : resolve(result));
      });
    } else {
      continue; // Unsupported compression method — skip
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, fileData);
  }
}

// ── Tar.gz Extraction ─────────────────────────────────────────────────────────

export interface TarExtractOptions {
  /** Strip this prefix from entry names (e.g. 'typesense-dashboard-gh-pages/'). */
  stripPrefix?: string;
  /** Only extract this specific file (by basename). Returns the file content via callback. */
  findFile?: string;
}

/**
 * Extract a tar.gz archive from a URL directly to a destination directory.
 * Streams the download → gunzip → tar extraction without writing the archive to disk.
 * Includes path traversal protection.
 *
 * @param url - URL of the .tar.gz file
 * @param destDir - Directory to extract files into
 * @param opts - Optional: strip prefix from paths, or find a specific file
 * @returns Buffer of the found file if opts.findFile is set, otherwise void
 */
export function extractTarGzFromUrl(
  url: string,
  destDir: string,
  opts?: TarExtractOptions
): Promise<Buffer | void> {
  const resolvedDest = path.resolve(destDir);

  return new Promise((resolve, reject) => {
    fs.mkdirSync(resolvedDest, { recursive: true });

    function doGet(currentUrl: string) {
      const mod = currentUrl.startsWith('https') ? https : http;
      mod.get(currentUrl, { headers: { 'User-Agent': 'kirograph' } } as any, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doGet(res.headers.location!);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);

        let tarBuffer = Buffer.alloc(0);
        let offset = 0;
        let foundFile: Buffer | null = null;

        function extractEntries(final = false) {
          while (offset + 512 <= tarBuffer.length) {
            const header    = tarBuffer.slice(offset, offset + 512);
            const nameRaw   = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
            const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
            const typeFlag  = header[156];
            const size      = parseInt(sizeOctal, 8) || 0;
            const dataStart = offset + 512;
            const dataEnd   = dataStart + size;

            if (nameRaw === '') { offset += 512; continue; }

            // Strip prefix if configured
            const relName = opts?.stripPrefix && nameRaw.startsWith(opts.stripPrefix)
              ? nameRaw.slice(opts.stripPrefix.length)
              : nameRaw;

            // If looking for a specific file
            if (opts?.findFile && path.basename(nameRaw) === opts.findFile) {
              if (tarBuffer.length >= dataEnd || final) {
                foundFile = tarBuffer.slice(dataStart, dataEnd);
                resolve(foundFile);
                return;
              }
              return; // Wait for more data
            }

            const destPath = path.resolve(resolvedDest, relName);

            // Prevent path traversal
            if (!destPath.startsWith(resolvedDest + path.sep) && destPath !== resolvedDest) {
              offset = dataStart + Math.ceil(size / 512) * 512;
              continue;
            }

            // Directory entry
            if (typeFlag === 53 || nameRaw.endsWith('/')) {
              try { fs.mkdirSync(destPath, { recursive: true }); } catch { /* ignore */ }
              offset = dataStart;
              continue;
            }

            // File entry — wait for full data
            if (tarBuffer.length < dataEnd && !final) return;

            if (relName && !relName.endsWith('/')) {
              try {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.writeFileSync(destPath, tarBuffer.slice(dataStart, dataEnd));
              } catch { /* skip unwritable entries */ }
            }

            offset = dataStart + Math.ceil(size / 512) * 512;
          }
        }

        gunzip.on('data', (chunk: Buffer) => {
          tarBuffer = Buffer.concat([tarBuffer, chunk]);
          extractEntries();
        });
        gunzip.on('end', () => {
          extractEntries(true);
          if (opts?.findFile && !foundFile) {
            reject(new Error(`${opts.findFile} not found in archive`));
          } else {
            resolve(foundFile ?? undefined);
          }
        });
        gunzip.on('error', reject);
      }).on('error', reject);
    }

    doGet(url);
  });
}

/**
 * Extract a single binary from a tar.gz URL and write it to destPath.
 * Useful for downloading server binaries (e.g. Typesense).
 */
export async function extractBinaryFromTarGz(
  url: string,
  binaryName: string,
  destPath: string
): Promise<void> {
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  const content = await extractTarGzFromUrl(url, destDir, { findFile: binaryName });
  if (content && Buffer.isBuffer(content)) {
    fs.writeFileSync(destPath, content);
    try { fs.chmodSync(destPath, 0o755); } catch { /* Windows doesn't support chmod */ }
  }
}
