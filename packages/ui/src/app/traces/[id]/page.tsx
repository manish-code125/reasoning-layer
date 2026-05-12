'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TraceData, RiskLevel } from '@/lib/types';
import { fetchTrace } from '@/lib/api';
import DecisionGraph from '@/components/DecisionGraph';
import DecisionDocument from '@/components/DecisionDocument';

const RISK_BADGE: Record<RiskLevel, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
};

type Tab = 'graph' | 'document';

export default function TraceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('graph');
  const [promptId, setPromptId] = useState('');

  useEffect(() => {
    params.then(({ id }) => setPromptId(id));
  }, [params]);

  useEffect(() => {
    if (!promptId) return;
    fetchTrace(promptId).then((data) => {
      setTrace(data);
      setLoading(false);
    });
  }, [promptId]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-4">
          <button
            onClick={() => router.push('/traces')}
            className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Traces
          </button>

          <span className="text-gray-200">/</span>

          <span className="text-sm font-mono text-gray-500 truncate max-w-xs">{promptId}</span>

          {trace && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                {trace.analysis.domain}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_BADGE[trace.analysis.risk_level]}`}>
                {trace.analysis.risk_level}
              </span>
            </div>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
          Loading trace…
        </div>
      ) : !trace ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-gray-500 mb-3">Trace not found or API unreachable.</p>
            <button
              onClick={() => router.push('/traces')}
              className="text-sm text-blue-600 hover:underline"
            >
              Back to traces
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          {/* Prompt banner */}
          <div className="bg-white border-b border-gray-100 px-6 py-4 max-w-7xl mx-auto w-full">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Prompt</p>
            <p className="text-sm text-gray-700">{trace.content}</p>
            <p className="text-xs text-gray-400 mt-1">{trace.questions.length} questions</p>
          </div>

          {/* Tabs */}
          <div className="bg-white border-b border-gray-200">
            <div className="max-w-7xl mx-auto px-6 flex gap-1">
              {(['graph', 'document'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`py-3 px-4 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === t
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t === 'graph' ? 'Decision Graph' : 'Decision Document'}
                </button>
              ))}
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {tab === 'graph' ? (
              <DecisionGraph trace={trace} />
            ) : (
              <div className="max-w-4xl mx-auto px-6 py-8 w-full">
                <DecisionDocument trace={trace} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
