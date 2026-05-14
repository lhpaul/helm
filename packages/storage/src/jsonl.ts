import { appendFile, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Appends a JSON-serialized entry as a single line to a .jsonl file.
 * Creates parent directories if they don't exist.
 */
export async function appendJsonl<T>(path: string, entry: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Reads and parses all entries from a .jsonl file.
 * Returns [] if the file does not exist (ENOENT).
 * Throws if any line contains invalid JSON (corrupted log is a real error).
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}
