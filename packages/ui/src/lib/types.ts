export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type QuestionStatus = 'pending' | 'answered' | 'routed' | 'skipped';

export interface PromptSummary {
  prompt_id: string;
  content: string;
  created_at?: string;
  risk_level?: RiskLevel;
  domain?: string;
  question_count?: number;
}

export interface Question {
  question_id: string | null;
  text: string;
  risk_level: RiskLevel;
  should_escalate: boolean;
  status?: QuestionStatus;
  answer?: string;
  rationale?: string;
  slack_routed?: boolean;
  decision_id?: string;
}

export interface TraceData {
  prompt_id: string;
  content: string;
  analysis: {
    risk_level: RiskLevel;
    domain: string;
  };
  questions: Question[];
  enriched_prompt?: string;
}
