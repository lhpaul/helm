import type { HaystackTriageFinding } from './types.js';

const PROVIDER = 'haystack';

function readPath(finding: HaystackTriageFinding): string | undefined {
  const source = finding.source;
  if (!source || typeof source !== 'object') return undefined;
  const candidate = source.path ?? source.file ?? source.filepath ?? source.filename ?? undefined;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function readLine(finding: HaystackTriageFinding): number | undefined {
  const source = finding.source;
  if (!source || typeof source !== 'object') return undefined;
  const line = source.line ?? source.startLine;
  return typeof line === 'number' && Number.isFinite(line) ? line : undefined;
}

function readNativeId(finding: HaystackTriageFinding): string | undefined {
  if (finding.id !== undefined && finding.id !== null && `${finding.id}`.length > 0) {
    return `${finding.id}`;
  }
  const source = finding.source;
  if (source && typeof source === 'object' && source.id !== undefined && source.id !== null) {
    const sourceId = `${source.id}`;
    return sourceId.length > 0 ? sourceId : undefined;
  }
  return undefined;
}

/**
 * Stable ledger key per ADR-036: provider-native id when available, else
 * canonical signature (provider, path, category, line) — never summary text.
 */
export function stableHaystackFindingId(finding: HaystackTriageFinding): string {
  const nativeId = readNativeId(finding);
  if (nativeId) return `${PROVIDER}:${nativeId}`;

  const category = finding.category?.trim() || '__UNKNOWN__';
  const path = readPath(finding) ?? '';
  const line = readLine(finding);
  const linePart = line !== undefined ? String(line) : '';
  return `${PROVIDER}:${path}:${category}:${linePart}`;
}

export function extractHaystackFindingPath(finding: HaystackTriageFinding): string | undefined {
  return readPath(finding);
}
