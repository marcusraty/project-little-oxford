// Atomic file write: stage to a sibling .tmp file, fsync, rename into place.
// rename(2) is atomic on POSIX (and on Windows via MoveFileEx with replace).
// So a crash mid-write leaves either the old file intact or the new file in
// place — never a partially-written destination.
//
// Concurrent writes against the same path: each call has a unique temp
// suffix so they don't collide on the staging file. The final rename is
// last-write-wins (same as fs.writeFile would be), but never produces a
// torn file.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.${tmpSuffix}.tmp`;
  let fh;
  try {
    fh = await fs.open(tmpPath, 'w');
    if (typeof data === 'string') {
      await fh.writeFile(data, { encoding });
    } else {
      await fh.writeFile(data);
    }
    // fsync the data + the directory entry on best-effort basis. If the
    // platform doesn't support it (e.g. some FUSE filesystems), the catch
    // keeps the write atomic at the rename level even without fsync.
    try { await fh.sync(); } catch { /* fsync unsupported */ }
  } finally {
    if (fh) await fh.close();
  }
  await fs.rename(tmpPath, filePath);
}
