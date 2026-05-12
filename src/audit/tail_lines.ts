import { open } from 'node:fs/promises';

// Returns the last `n` non-blank lines of a file, read from the END backward
// so a 100MB file isn't materialized just to extract the tail.
//
// Read in 64KB chunks from the end until we have enough newlines (or hit
// the start). Decode UTF-8 once at the end so multi-byte sequences split
// across chunk boundaries stitch back together correctly.
export async function tailLines(filePath: string, n: number): Promise<string[]> {
  const CHUNK = 64 * 1024;

  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch {
    return [];
  }

  try {
    const stat = await fh.stat();
    let pos = stat.size;
    if (pos === 0) return [];

    const buffers: Buffer[] = [];
    let newlines = 0;

    while (pos > 0 && newlines <= n) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, pos);
      buffers.unshift(buf);
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a /* \n */) newlines++;
      }
    }

    const text = Buffer.concat(buffers).toString('utf8');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}
