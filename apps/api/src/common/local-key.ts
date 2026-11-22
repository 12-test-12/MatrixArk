import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function localKey(directory: string, filename: string, create = false): Buffer {
  const path = join(directory, filename);
  if (create) {
    try {
      return localKey(directory, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${filename}-${randomBytes(12).toString('hex')}`);
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try {
      // Publish the complete key atomically so the API and Worker use the same key.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(temporary);
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('凭据密钥文件无效');
  return key;
}
