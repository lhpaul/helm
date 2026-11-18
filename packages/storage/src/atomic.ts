import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes data as JSON to path using a write-tmp-then-rename pattern.
 * Creates parent directories if they don't exist.
 * Uses a UUID-suffixed tmp file to avoid races under concurrent writes.
 * On any failure (writeFile or rename), best-effort cleans up the tmp file.
 */
export async function writeJsonAtomic<T>(path: string, data: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Reads and parses a JSON file.
 * Returns null if the file does not exist (ENOENT).
 * Throws if the file exists but contains invalid JSON.
 */
export async function readJson<T>(path: string): Promise<T | null> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Invalid JSON at "${path}"`);
  }
}
