import { DEFAULT_PAGE_SIZE } from '@ff/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface HealthResult {
  reachable: boolean;
  database: string;
}

/**
 * Phase 0 placeholder. Its only job is to prove the three pieces are wired:
 * the web app renders, it can import from @ff/shared, and it can reach the API.
 * Replaced by the real app shell in Phase 4 (CLAUDE.md §12).
 */
async function readApiHealth(): Promise<HealthResult> {
  try {
    const response = await fetch(`${API_URL}/api/health`, { cache: 'no-store' });
    const body: unknown = await response.json();
    const database =
      typeof body === 'object' &&
      body !== null &&
      'data' in body &&
      typeof body.data === 'object' &&
      body.data !== null &&
      'database' in body.data
        ? String(body.data.database)
        : 'unknown';
    return { reachable: response.ok, database };
  } catch {
    return { reachable: false, database: 'unreachable' };
  }
}

export default async function HomePage() {
  const health = await readApiHealth();

  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-xl font-semibold">Freight Forwarding ERP</h1>
      <p className="mt-2 text-sm text-slate-600">
        Phase 0 scaffold. No business logic yet.
      </p>

      <dl className="mt-8 divide-y divide-slate-200 border-y border-slate-200 text-sm">
        <div className="flex justify-between py-2">
          <dt className="text-slate-600">Web app</dt>
          <dd className="font-mono tabular-nums">running</dd>
        </div>
        <div className="flex justify-between py-2">
          <dt className="text-slate-600">API</dt>
          <dd className="font-mono tabular-nums">
            {health.reachable ? 'reachable' : 'unreachable'}
          </dd>
        </div>
        <div className="flex justify-between py-2">
          <dt className="text-slate-600">Database</dt>
          <dd className="font-mono tabular-nums">{health.database}</dd>
        </div>
        <div className="flex justify-between py-2">
          <dt className="text-slate-600">@ff/shared import</dt>
          <dd className="font-mono tabular-nums">
            DEFAULT_PAGE_SIZE = {DEFAULT_PAGE_SIZE}
          </dd>
        </div>
      </dl>
    </main>
  );
}
