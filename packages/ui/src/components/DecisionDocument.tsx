'use client';

import React, { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TraceData, RiskLevel, QuestionStatus } from '@/lib/types';

const RISK_EMOJI: Record<RiskLevel, string>        = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
const RISK_LABEL: Record<RiskLevel, string>        = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const STATUS_EMOJI: Record<QuestionStatus, string> = { answered: '✅', routed: '📤', skipped: '⏭', pending: '⏳' };
const STATUS_LABEL: Record<QuestionStatus, string> = { answered: 'Answered', routed: 'Routed to Expert', skipped: 'Skipped', pending: 'Pending' };

function buildMarkdown(trace: TraceData): string {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const overallRisk = trace.analysis.risk_level;
  const riskEmoji = RISK_EMOJI[overallRisk];

  const answered  = trace.questions.filter(q => q.status === 'answered').length;
  const routed    = trace.questions.filter(q => q.status === 'routed').length;
  const pending   = trace.questions.filter(q => q.status === 'pending').length;
  const skipped   = trace.questions.filter(q => q.status === 'skipped').length;

  const decisionSummaryParts: string[] = [];
  if (answered)  decisionSummaryParts.push(`${answered} answered`);
  if (routed)    decisionSummaryParts.push(`${routed} routed`);
  if (pending)   decisionSummaryParts.push(`${pending} pending`);
  if (skipped)   decisionSummaryParts.push(`${skipped} skipped`);

  const decisionSummary = `${trace.questions.length} total — ${decisionSummaryParts.join(' · ')}`;

  const riskSentence = overallRisk === 'critical'
    ? `This request carries **critical risk** and requires immediate architectural review before proceeding.`
    : overallRisk === 'high'
    ? `This request carries **high risk**. Key decisions must be resolved before implementation.`
    : overallRisk === 'medium'
    ? `This request has **medium risk**. The decisions below should be reviewed with the relevant stakeholders.`
    : `This is a **low-risk** request. Decisions are documented below for traceability.`;

  const lines: string[] = [
    `# Architectural Decision Log`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Session ID** | \`${trace.prompt_id}\` |`,
    `| **Date** | ${now} |`,
    `| **Domain** | ${trace.analysis.domain ?? 'General'} |`,
    `| **Risk Level** | ${riskEmoji} **${RISK_LABEL[overallRisk]}** |`,
    `| **Decisions** | ${decisionSummary} |`,
    ``,
    `---`,
    ``,
    `## Context`,
    ``,
    `> ${trace.content.replace(/\n/g, '\n> ')}`,
    ``,
    riskSentence,
    ``,
    `---`,
    ``,
    `## Decision Records`,
    ``,
  ];

  trace.questions.forEach((q, i) => {
    const status = (q.status ?? 'pending') as QuestionStatus;
    const qRisk = q.risk_level as RiskLevel;

    lines.push(`### Decision ${i + 1} — ${q.text}`);
    lines.push(``);
    lines.push(`| Risk Level | Escalation | Status |`);
    lines.push(`|---|---|---|`);
    lines.push(`| ${RISK_EMOJI[qRisk]} ${RISK_LABEL[qRisk]} | ${q.should_escalate ? '⚠️ Required' : '✔️ Not required'} | ${STATUS_EMOJI[status]} ${STATUS_LABEL[status]} |`);
    lines.push(``);

    if (q.answer) {
      lines.push(`**Decision Made**`);
      lines.push(``);
      lines.push(`> ${q.answer.replace(/\n/g, '\n> ')}`);
      lines.push(``);
    } else {
      lines.push(`**Decision Made**`);
      lines.push(``);
      lines.push(`> *(No decision recorded yet)*`);
      lines.push(``);
    }

    if (q.rationale) {
      lines.push(`**Rationale**`);
      lines.push(``);
      lines.push(q.rationale);
      lines.push(``);
    }

    if (q.slack_routed) {
      lines.push(`*This question was escalated to subject matter experts via Slack.*`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  });

  // Summary table
  lines.push(`## Decision Summary`);
  lines.push(``);
  lines.push(`| # | Question | Risk | Status |`);
  lines.push(`|---|---|---|---|`);
  trace.questions.forEach((q, i) => {
    const status = (q.status ?? 'pending') as QuestionStatus;
    const qRisk = q.risk_level as RiskLevel;
    const truncated = q.text.length > 80 ? q.text.slice(0, 77) + '…' : q.text;
    lines.push(`| ${i + 1} | ${truncated} | ${RISK_EMOJI[qRisk]} ${RISK_LABEL[qRisk]} | ${STATUS_EMOJI[status]} ${STATUS_LABEL[status]} |`);
  });
  lines.push(``);

  if (trace.enriched_prompt) {
    lines.push(`---`);
    lines.push(``);
    lines.push(`## Enriched Execution Context`);
    lines.push(``);
    lines.push(`*The following context was injected into the final prompt based on relevant past architectural decisions.*`);
    lines.push(``);
    lines.push(trace.enriched_prompt);
    lines.push(``);
  }

  return lines.join('\n');
}

function printDocument(title: string, html: string) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 820px; margin: 48px auto; padding: 0 32px;
      color: #111827; font-size: 14px; line-height: 1.7;
    }
    h1 {
      font-size: 24px; font-weight: 700;
      border-bottom: 3px solid #1d4ed8; padding-bottom: 12px;
      color: #111827; margin-bottom: 20px;
    }
    h2 {
      font-size: 17px; font-weight: 600;
      border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;
      margin-top: 36px; margin-bottom: 16px; color: #1f2937;
    }
    h3 {
      font-size: 15px; font-weight: 600;
      color: #1e3a5f; margin-top: 28px; margin-bottom: 10px;
    }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px; }
    th, td { border: 1px solid #d1d5db; padding: 8px 14px; text-align: left; }
    th { background: #f3f4f6; font-weight: 600; color: #374151; }
    td:first-child { font-weight: 500; color: #374151; white-space: nowrap; }
    blockquote {
      border-left: 4px solid #3b82f6; margin: 12px 0; padding: 12px 18px;
      background: #eff6ff; color: #1e40af; border-radius: 4px; font-style: normal;
    }
    code {
      background: #f3f4f6; padding: 2px 6px; border-radius: 3px;
      font-size: 12px; font-family: 'Courier New', monospace; color: #374151;
    }
    strong { font-weight: 600; color: #111827; }
    em { color: #6b7280; font-style: italic; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 28px 0; }
    p { margin: 8px 0; }
    @media print {
      body { margin: 0; }
      h3 { page-break-after: avoid; }
      table, blockquote { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${html}
  <script>window.onload = function(){ window.print(); }<\/script>
</body>
</html>`);
  win.document.close();
}

export default function DecisionDocument({ trace }: { trace: TraceData }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const markdown = buildMarkdown(trace);

  function handlePrint() {
    if (!contentRef.current) return;
    printDocument(`Decision Trace — ${trace.prompt_id}`, contentRef.current.innerHTML);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">
          Rendered decision log — printable as PDF via browser print dialog.
        </p>
        <button
          onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
          </svg>
          Print / Save as PDF
        </button>
      </div>

      <div
        ref={contentRef}
        className="prose prose-sm max-w-none bg-white border border-gray-200 rounded-xl shadow-sm px-10 py-8"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children }) => (
              <table className="border-collapse w-full my-4 text-xs">{children}</table>
            ),
            th: ({ children }) => (
              <th className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold">{children}</th>
            ),
            td: ({ children }) => (
              <td className="border border-gray-200 px-3 py-2">{children}</td>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-blue-500 pl-4 bg-blue-50 py-2 rounded-r-lg text-blue-800 not-italic">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="my-6 border-gray-200" />,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
