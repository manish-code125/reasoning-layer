import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PromptAnalysis, GeneratedQuestion } from "../types.js";
import {
  CLASSIFIER_SYSTEM,
  QUESTION_SYSTEM,
  buildClassifierPrompt,
  buildQuestionPrompt,
} from "./prompts.js";

// Classifier uses Haiku — fast, cheap, excellent at extracting structured JSON.
// Question gen uses Sonnet — better reasoning on subtle architectural tradeoffs.
// Both overridable via env for cost/quality tuning.
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5-20251001";
const QUESTION_MODEL = process.env.QUESTION_MODEL ?? "claude-sonnet-4-6";

const client = new Anthropic();

// Claude occasionally wraps JSON in ```json ... ``` despite "no markdown" instructions.
// Strip fences defensively so the caller always receives clean JSON text.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1].trim() : text.trim();
}

const AnalysisSchema = z.object({
  domain: z.string().min(1),
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  architectural_impact: z.enum(["none", "low", "medium", "high"]),
  product_ambiguity: z.enum(["none", "low", "medium", "high"]),
  surfaced_concerns: z.array(z.string()),
});

const QuestionsSchema = z.array(
  z.object({
    text: z.string().min(10),
    category: z.enum(["architectural", "product", "infra", "compliance", "ux"]),
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    should_escalate: z.boolean(),
    suggested_entry_type: z.enum(["decision", "wont_do", "table", "branch", "rollback", "observation"]).default("decision"),
  })
);

export async function classifyPrompt(params: {
  content: string;
  repoPath?: string | null;
  openFilePath?: string | null;
  language?: string | null;
  readmeSnippet?: string | null;
}): Promise<PromptAnalysis> {
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 512,
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: buildClassifierPrompt(params) }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "";
  return AnalysisSchema.parse(JSON.parse(extractJson(raw)));
}

export async function generateQuestions(params: {
  content: string;
  analysis: PromptAnalysis;
  count?: number;
}): Promise<GeneratedQuestion[]> {
  const count = params.count ?? deriveQuestionCount(params.analysis.risk_level);

  const response = await client.messages.create({
    model: QUESTION_MODEL,
    max_tokens: 1536,
    system: QUESTION_SYSTEM,
    messages: [
      { role: "user", content: buildQuestionPrompt({ ...params, count }) },
    ],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "[]";
  const questions = QuestionsSchema.parse(JSON.parse(extractJson(raw)));

  // LLM occasionally returns one extra question — enforce the count ceiling.
  return questions.slice(0, count);
}

// More risk → more questions. Matches the spec's 3–6 range.
function deriveQuestionCount(riskLevel: string): number {
  return ({ low: 3, medium: 4, high: 5, critical: 6 } as Record<string, number>)[riskLevel] ?? 4;
}
