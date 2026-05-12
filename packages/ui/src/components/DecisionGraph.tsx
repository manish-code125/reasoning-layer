'use client';

import React, { useEffect, useState } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Handle,
  Position,
  NodeProps,
  BackgroundVariant,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';
import type { TraceData, RiskLevel, QuestionStatus } from '@/lib/types';

// ─── Dimensions used by dagre for layout ───────────────────────────────────
const DIMS = {
  prompt:   { w: 320, h: 130 },
  question: { w: 270, h: 150 },
  decision: { w: 250, h: 95  },
  enriched: { w: 320, h: 110 },
};

// ─── Colour maps ────────────────────────────────────────────────────────────
const RISK_BORDER: Record<RiskLevel, string> = {
  critical: 'border-red-400',
  high:     'border-orange-400',
  medium:   'border-yellow-400',
  low:      'border-green-400',
};

const RISK_PILL: Record<RiskLevel, string> = {
  critical: 'bg-red-100 text-red-700',
  high:     'bg-orange-100 text-orange-700',
  medium:   'bg-yellow-100 text-yellow-700',
  low:      'bg-green-100 text-green-700',
};

const STATUS_CFG: Record<QuestionStatus, { border: string; pill: string; icon: string; label: string }> = {
  answered: { border: 'border-green-400',  pill: 'bg-green-100 text-green-700',   icon: '✓', label: 'Answered'       },
  routed:   { border: 'border-purple-400', pill: 'bg-purple-100 text-purple-700', icon: '→', label: 'Routed to Slack' },
  skipped:  { border: 'border-gray-300',   pill: 'bg-gray-100 text-gray-500',     icon: '—', label: 'Skipped'         },
  pending:  { border: 'border-gray-300',   pill: 'bg-gray-100 text-gray-400',     icon: '○', label: 'Pending'         },
};

// ─── Node components ────────────────────────────────────────────────────────
function PromptNode({ data }: NodeProps) {
  return (
    <div className="bg-white border-2 border-blue-500 rounded-xl shadow-md px-4 py-3" style={{ width: DIMS.prompt.w }}>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-400" />
      <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-1">Prompt</div>
      <p className="text-xs text-gray-700 leading-relaxed line-clamp-3">{data.content}</p>
      <div className="flex gap-1.5 mt-2">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${RISK_PILL[data.risk_level as RiskLevel]}`}>
          {data.risk_level}
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{data.domain}</span>
      </div>
    </div>
  );
}

function QuestionNode({ data }: NodeProps) {
  const riskLevel = (data.risk_level ?? 'high') as RiskLevel;
  return (
    <div className={`bg-white border-2 ${RISK_BORDER[riskLevel]} rounded-xl shadow-md px-4 py-3`} style={{ width: DIMS.question.w }}>
      <Handle type="target" position={Position.Top} className="!bg-gray-300" />
      <Handle type="source" position={Position.Bottom} className="!bg-gray-300" />
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Q{data.index + 1}</span>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${RISK_PILL[riskLevel]}`}>
          {data.risk_level}
        </span>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed line-clamp-4">{data.text}</p>
      {data.should_escalate && (
        <span className="mt-2 inline-block text-[10px] text-amber-600 font-semibold">⚠ Escalate</span>
      )}
    </div>
  );
}

function DecisionNode({ data }: NodeProps) {
  const status = (data.status ?? 'pending') as QuestionStatus;
  const cfg = STATUS_CFG[status];
  return (
    <div className={`bg-white border-2 ${cfg.border} rounded-xl shadow-sm px-4 py-2.5`} style={{ width: DIMS.decision.w }}>
      <Handle type="target" position={Position.Top} className="!bg-gray-300" />
      <Handle type="source" position={Position.Bottom} className="!bg-gray-300" />
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cfg.pill}`}>
        {cfg.icon} {cfg.label}
      </span>
      {data.answer && (
        <p className="mt-1.5 text-[11px] text-gray-500 italic line-clamp-2">"{data.answer}"</p>
      )}
    </div>
  );
}

function EnrichedNode({ data }: NodeProps) {
  return (
    <div className="bg-white border-2 border-teal-500 rounded-xl shadow-md px-4 py-3" style={{ width: DIMS.enriched.w }}>
      <Handle type="target" position={Position.Top} className="!bg-teal-400" />
      <div className="text-[10px] font-bold uppercase tracking-widest text-teal-600 mb-1">✓ Enriched Context</div>
      <p className="text-xs text-gray-500 line-clamp-3">{data.preview ?? 'All decisions merged into enriched context.'}</p>
    </div>
  );
}

const NODE_TYPES = {
  promptNode:   PromptNode,
  questionNode: QuestionNode,
  decisionNode: DecisionNode,
  enrichedNode: EnrichedNode,
};

// ─── Layout ─────────────────────────────────────────────────────────────────
function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 90, nodesep: 50, marginx: 40, marginy: 40 });

  nodes.forEach((n) => {
    const d = DIMS[n.type?.replace('Node', '') as keyof typeof DIMS] ?? { w: 260, h: 110 };
    g.setNode(n.id, { width: d.w, height: d.h });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    const d = DIMS[n.type?.replace('Node', '') as keyof typeof DIMS] ?? { w: 260, h: 110 };
    return { ...n, position: { x: pos.x - d.w / 2, y: pos.y - d.h / 2 } };
  });
}

// ─── Build graph from trace ──────────────────────────────────────────────────
function buildGraph(trace: TraceData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Root prompt node
  nodes.push({
    id: 'prompt',
    type: 'promptNode',
    position: { x: 0, y: 0 },
    data: {
      content: trace.content,
      risk_level: trace.analysis.risk_level,
      domain: trace.analysis.domain,
    },
  });

  trace.questions.forEach((q, i) => {
    const qid = `q-${i}`;
    const did = `d-${i}`;
    const status = q.status ?? 'pending';

    // Question node
    nodes.push({
      id: qid,
      type: 'questionNode',
      position: { x: 0, y: 0 },
      data: { index: i, text: q.text, risk_level: q.risk_level, should_escalate: q.should_escalate },
    });

    // Decision node
    nodes.push({
      id: did,
      type: 'decisionNode',
      position: { x: 0, y: 0 },
      data: { status, answer: q.answer },
    });

    // prompt → question
    edges.push({
      id: `e-prompt-${qid}`,
      source: 'prompt',
      target: qid,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
      style: { stroke: '#94a3b8', strokeWidth: 1.5 },
    });

    // question → decision
    edges.push({
      id: `e-${qid}-${did}`,
      source: qid,
      target: did,
      animated: status === 'pending',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
      style: { stroke: '#cbd5e1', strokeWidth: 1.5, strokeDasharray: status === 'pending' ? '4 3' : undefined },
    });

    // decision → enriched (if enriched exists)
    if (trace.enriched_prompt) {
      edges.push({
        id: `e-${did}-enriched`,
        source: did,
        target: 'enriched',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#5eead4' },
        style: { stroke: '#5eead4', strokeWidth: 1.5 },
      });
    }
  });

  // Enriched context node
  if (trace.enriched_prompt) {
    nodes.push({
      id: 'enriched',
      type: 'enrichedNode',
      position: { x: 0, y: 0 },
      data: { preview: trace.enriched_prompt.slice(0, 140) },
    });
  }

  return { nodes: applyDagreLayout(nodes, edges), edges };
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function DecisionGraph({ trace }: { trace: TraceData }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(trace);
    setNodes(n);
    setEdges(e);
  }, [trace]);

  return (
    <div className="w-full h-full" style={{ height: 'calc(100vh - 180px)' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
        <Controls className="!shadow-sm !border !border-gray-200 !rounded-lg overflow-hidden" />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'promptNode') return '#3b82f6';
            if (n.type === 'enrichedNode') return '#14b8a6';
            if (n.type === 'decisionNode') {
              const s = n.data?.status;
              if (s === 'answered') return '#22c55e';
              if (s === 'routed')   return '#a855f7';
              return '#d1d5db';
            }
            const r = n.data?.risk_level;
            if (r === 'critical') return '#f87171';
            if (r === 'high')     return '#fb923c';
            return '#fbbf24';
          }}
          className="!rounded-lg !border !border-gray-200 !shadow-sm"
          maskColor="rgba(241,245,249,0.7)"
        />
      </ReactFlow>
    </div>
  );
}
