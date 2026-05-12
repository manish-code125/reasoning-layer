'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PromptSummary, RiskLevel } from '@/lib/types';
import { fetchPrompts } from '@/lib/api';

const RISK_BADGE: Record<RiskLevel, string> = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  high: 'bg-orange-100 text-orange-700 border border-orange-200',
  medium: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  low: 'bg-green-100 text-green-700 border border-green-200',
};

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

export default function TracesPage() {
  const router = useRouter();
  const [traces, setTraces] = useState<PromptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [lookupId, setLookupId] = useState('');

  useEffect(() => {
    fetchPrompts().then((data) => {
      setTraces(data);
      setLoading(false);
    });
  }, []);

  function openTrace(id: string) {
    if (id.trim()) router.push(`/traces/${id.trim()}`);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <span className="font-semibold text-gray-800">Decision Trace Portal</span>
          </div>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Lookup by ID */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
          <p className="text-sm font-medium text-gray-700 mb-3">Open trace by ID</p>
          <form
            onSubmit={(e) => { e.preventDefault(); openTrace(lookupId); }}
            className="flex gap-3"
          >
            <input
              type="text"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="e.g. 60fb9884-c89e-4f38-9790-85b8481ccdc2"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Open
            </button>
          </form>
        </div>

        {/* Trace list */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Recent Traces</h2>

          {loading ? (
            <div className="text-sm text-gray-500 py-12 text-center">Loading traces…</div>
          ) : traces.length === 0 ? (
            <div className="text-sm text-gray-400 py-12 text-center bg-white rounded-xl border border-gray-200">
              No traces found. Enter a trace ID above to open one directly.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
              {traces.map((t) => (
                <button
                  key={t.prompt_id}
                  onClick={() => openTrace(t.prompt_id)}
                  className="w-full px-5 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors text-left"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono text-gray-400 mb-1 truncate">{t.prompt_id}</p>
                    <p className="text-sm text-gray-800 line-clamp-1">{t.content}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {t.domain && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                        {t.domain}
                      </span>
                    )}
                    {t.risk_level && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_BADGE[t.risk_level]}`}>
                        {t.risk_level}
                      </span>
                    )}
                    {t.question_count !== undefined && (
                      <span className="text-xs text-gray-400">{t.question_count}Q</span>
                    )}
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
