import { renameSync } from 'node:fs';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Move `tmp` over `dest` (the commit step of a tmp-file + rename write).
 * On Windows the rename fails with EPERM/EACCES/EBUSY while another process
 * has `dest` open for reading; that window is short, so retry with backoff
 * for up to about two seconds before giving up.
 */
export function replaceFileSync(tmp: string, dest: string, platform: NodeJS.Platform = process.platform): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !RETRY_CODES.has(code) || attempt >= 40) throw err;
      Atomics.wait(sleeper, 0, 0, Math.min(5 + attempt * 5, 100));
    }
  }
}
