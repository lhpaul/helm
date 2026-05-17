import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { WorkflowEvent } from '../lib/api.js';
import { usePolling } from '../hooks/usePolling.js';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
      {stage}
    </span>
  );
}

function HistoryRow({ event, index }: { event: WorkflowEvent; index: number }) {
  return (
    <tr className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">
        {event.fromStage ?? <span className="italic text-gray-300">created</span>}
      </td>
      <td className="px-2 py-2 text-xs text-gray-400">→</td>
      <td className="whitespace-nowrap px-4 py-2 text-xs font-medium text-gray-900">
        {event.toStage}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">{formatDate(event.at)}</td>
      <td className="px-4 py-2 text-xs text-gray-400">{event.triggeredBy}</td>
      <td className="px-4 py-2 text-xs text-gray-400 italic">
        {event.note ?? <span className="not-italic text-gray-300">—</span>}
      </td>
    </tr>
  );
}

export function ItemDetail() {
  const { id } = useParams<{ id: string }>();

  const fetcher = useCallback((): ReturnType<typeof api.getItem> => {
    if (!id) {
      return Promise.resolve({
        ok: false,
        error: { type: 'network', message: 'Missing item id in route.' },
      });
    }
    return api.getItem(id);
  }, [id]);
  const { data: item, error, loading } = usePolling(fetcher, id ? 5_000 : null);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  // Full-page error only when there's no prior data — transient poll failures
  // show an inline warning so the last-known content stays visible.
  if (error && !item) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
          <Link to="/" className="mt-4 block text-sm text-indigo-600 hover:text-indigo-800">
            ← Back to board
          </Link>
        </div>
      </div>
    );
  }

  if (!item) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <Link
          to="/"
          className="mb-3 block text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          ← Back to board
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-mono text-xl font-semibold text-gray-900">{item.externalId}</h1>
            <p className="mt-1 text-xs text-gray-400">{item.productSlug}</p>
          </div>
          <StageBadge stage={item.currentStage} />
        </div>
      </header>

      {/* History table */}
      <main className="mx-auto max-w-4xl p-6">
        {error && (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
            ⚠ {error} — showing last known data.
          </p>
        )}
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Transition history</h2>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">From</th>
                <th className="px-2 py-2" />
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">To</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">When</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Actor</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Note</th>
              </tr>
            </thead>
            <tbody>
              {[...item.history].reverse().map((event, i) => (
                <HistoryRow
                  key={`${event.at}-${event.fromStage ?? 'created'}-${event.toStage}-${event.triggeredBy}`}
                  event={event}
                  index={i}
                />
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
