import type { PromptSummary, TraceData } from './types';

const BASE = '/api/reasoning';

export async function fetchPrompts(): Promise<PromptSummary[]> {
  try {
    const res = await fetch(`${BASE}/prompts`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function fetchTrace(promptId: string): Promise<TraceData | null> {
  try {
    // Try a dedicated GET endpoint first; fall back to re-running analyze
    const [detailRes, enrichedRes] = await Promise.all([
      fetch(`${BASE}/prompts/${promptId}`, { cache: 'no-store' }),
      fetch(`${BASE}/prompts/${promptId}/enriched`, { cache: 'no-store' }),
    ]);

    const enrichedData = enrichedRes.ok ? await enrichedRes.json() : null;

    if (detailRes.ok) {
      const detail = await detailRes.json();
      return { ...detail, enriched_prompt: enrichedData?.enriched_prompt ?? undefined };
    }

    // Fallback: re-analyze (idempotent on the server)
    const analyzeRes = await fetch(`${BASE}/prompts/${promptId}/analyze`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!analyzeRes.ok) return null;
    const analyzed = await analyzeRes.json();

    return {
      prompt_id: promptId,
      content: analyzed.content ?? '',
      analysis: analyzed.analysis ?? { risk_level: 'high', domain: 'unknown' },
      questions: (analyzed.questions ?? []).map(
        (q: Record<string, unknown>, i: number) => ({
          question_id: q.question_id ?? q.id ?? null,
          text: q.text as string,
          risk_level: (q.risk ?? q.risk_level ?? 'high') as string,
          should_escalate: Boolean(q.escalate ?? q.should_escalate),
          status: (q.status as string | undefined) ?? 'pending',
          answer: q.answer as string | undefined,
          rationale: q.rationale as string | undefined,
        })
      ),
      enriched_prompt: enrichedData?.enriched_prompt ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function routeQuestion(questionId: string, slackId: string) {
  const res = await fetch(`${BASE}/questions/${questionId}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ developer_slack_id: slackId }),
  });
  return res.json();
}

export async function answerQuestion(questionId: string, answer: string, rationale: string) {
  const res = await fetch(`${BASE}/questions/${questionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, rationale }),
  });
  return res.json();
}
