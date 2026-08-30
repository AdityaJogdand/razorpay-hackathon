export type FailureClass = 'HARD' | 'SOFT' | 'MANDATE' | 'UNKNOWN';
export type GuardrailStatus = 'approved' | 'overridden';
export type Outcome = 'recovered' | 'failed' | 'pending' | 'suppressed';

export interface GuardrailCheck {
  rule: string;
  passed: boolean;
  detail?: string;
}

export interface ShaclValidation {
  conforms: boolean;
  engine: string;
  ontology: string;
  shapes: string;
  data_graph_turtle?: string;
  results_text?: string;
}

export interface Transaction {
  id: string;
  amount: number;
  currency: string;
  customer_id: string;
  customer_email: string;
  merchant: string;
  instrument: string;
  decline_code: string;
  decline_reason: string;
  failure_class: FailureClass;
  confidence: number;
  agent_reasoning: string;
  proposed_action: string;
  retry_timing?: string;
  guardrail_status: GuardrailStatus;
  guardrail_checks: GuardrailCheck[];
  guardrail_override_reason?: string;
  shacl?: ShaclValidation;
  outcome: Outcome;
  outcome_detail: string;
  email_draft?: {
    subject: string;
    body: string;
    status: 'sent' | 'suppressed';
    suppression_reason?: string;
  };
  failed_at: string;
  resolved_at?: string;
}
