import api from './client';

export interface DashboardEvent {
  id: string;
  transaction_id: string;
  merchant_id: string;
  customer_id: string;
  customer_email: string;
  instrument_type: string;
  instrument_token: string;
  amount_paise: number;
  currency: string;
  decline_code: string;
  decline_reason: string;
  failure_class: 'HARD' | 'SOFT' | 'MANDATE' | 'UNKNOWN';
  classification_confidence: number;
  classification_source: string;
  failed_at: string;
  agent: {
    proposed_action: string;
    reasoning: string;
    confidence: number;
    retry_schedule: number[] | null;
    has_email_draft: boolean;
    email_draft: { subject: string; body: string } | null;
  };
  guardrail: {
    status: 'approved' | 'overridden';
    checks: Array<{ rule: string; passed: boolean; detail?: string }>;
    override_reason: string | null;
    final_action: string;
    shacl?: {
      conforms: boolean;
      engine: string;
      ontology: string;
      shapes: string;
      data_graph_turtle?: string;
      results_text?: string;
    } | null;
  };
  policy_action: string;
  outcome: 'recovered' | 'failed' | 'pending' | 'suppressed' | 'contacted' | 'escalated';
  outcome_detail: string;
  recovered_amount: number;
  actions: Array<{
    id: string;
    action_type: string;
    status: string;
    scheduled_at: string | null;
    executed_at: string | null;
    retry_number: number | null;
    outcome: Record<string, unknown> | null;
  }>;
  suppressions: Array<{
    rule_name: string;
    reason: string;
    action_type: string;
  }>;
}

export interface DashboardSummary {
  total_events: number;
  recovered_amount_paise: number;
  recovered_count: number;
  pending_count: number;
  override_count: number;
  exception_count: number;
  by_class: Record<string, number>;
  by_action_status: Record<string, number>;
}

export async function fetchDashboardEvents(params?: {
  limit?: number;
  offset?: number;
  failure_class?: string;
}): Promise<{ events: DashboardEvent[]; total: number }> {
  const { data } = await api.get('/dashboard/events', { params });
  return data;
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const { data } = await api.get('/dashboard/summary');
  return data;
}

export async function toggleKillSwitch(enabled: boolean): Promise<{ kill_switch: boolean; config_version: number }> {
  const { data } = await api.post('/config/kill-switch', { enabled });
  return data;
}

export async function verifyLedger(): Promise<{ valid: boolean; entries_checked: number; head_hash: string; broken_at: number | null }> {
  const { data } = await api.post('/ledger/verify');
  return data;
}

export async function fetchHealthCheck(): Promise<{ status: string; kill_switch: boolean; version: string }> {
  const { data } = await api.get('/health');
  return data;
}

export interface OPEResult {
  method: string;
  n_transactions: number;
  agent_recovery_rate: number;
  baseline_recovery_rate: number;
  incremental_recovery_paise: number;
  ci_lower_paise: number;
  ci_upper_paise: number;
  attempts_saved: number;
  contacts_suppressed: number;
  agreement_rate: number;
  agent_attempts_per_recovery: number;
  baseline_attempts_per_recovery: number;
  agent_contacts: number;
  baseline_contacts: number;
  avg_time_to_recovery_agent_hours: number;
  avg_time_to_recovery_baseline_hours: number;
  by_class: Record<string, { total: number; agent_rate: number; baseline_rate: number }>;
}

export interface ExceptionResolution {
  id: string;
  failure_event_id: string;
  resolution_type: string;
  resolved_by: string;
  notes: string | null;
  resolved_at: string;
}

export async function resolveException(
  eventId: string,
  resolutionType: string,
  notes?: string,
): Promise<{ id: string; failure_event_id: string; resolution_type: string; resolved_at: string }> {
  const { data } = await api.post(`/dashboard/exceptions/${eventId}/resolve`, {
    resolution_type: resolutionType,
    notes,
  });
  return data;
}

export async function fetchExceptionResolutions(): Promise<{ resolutions: ExceptionResolution[] }> {
  const { data } = await api.get('/dashboard/exceptions/resolutions');
  return data;
}

export async function fetchOPE(params?: { method?: string; split?: string }): Promise<OPEResult> {
  const { data } = await api.get('/ope/evaluate', { params });
  return data;
}

export async function runAgentPipeline(eventId: string): Promise<Record<string, unknown>> {
  const { data } = await api.post(`/agent/process/${eventId}`);
  return data;
}

export async function approveEmail(actionId: string): Promise<{ action_id: string; status: string; detail: string }> {
  const { data } = await api.post(`/agent/approve-email/${actionId}`);
  return data;
}

export async function updateEmailDraft(actionId: string, draft: { subject: string; body: string }): Promise<{ action_id: string; subject: string; body: string }> {
  const { data } = await api.put(`/agent/email-draft/${actionId}`, draft);
  return data;
}

export async function denyEmail(actionId: string): Promise<{ action_id: string; status: string; detail: string }> {
  const { data } = await api.post(`/agent/deny-email/${actionId}`);
  return data;
}

export interface SimulatePaymentRequest {
  failure_type: 'SOFT' | 'HARD' | 'MANDATE' | 'UNKNOWN';
  mandate_sub_type?: string;
  amount_paise: number;
  customer_email: string;
}

export async function simulatePayment(req: SimulatePaymentRequest): Promise<Record<string, unknown>> {
  const { data } = await api.post('/simulate/payment', req);
  return data;
}

export async function simulateRecovery(eventId: string): Promise<{
  event_id: string;
  transaction_id: string;
  amount_paise: number;
  amount_display: string;
  status: string;
  payment_id: string;
  failure_class: string;
  detail: string;
}> {
  const { data } = await api.post(`/simulate/recover/${eventId}`);
  return data;
}

export interface GuardrailRule {
  name: string;
  description: string;
  policy: string;
}

export interface GuardrailInfo {
  engine: string;
  ontology_format: string;
  shapes_format: string;
  rules: GuardrailRule[];
  regulatory_sources: Array<{ name: string; ref: string }>;
}

// Mandate Sequencer API
export interface MandateSequenceStep {
  step_number: number;
  step_type: string;
  description: string;
  delay_hours: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED' | 'FAILED';
  regulatory_basis: string;
}

export interface MandateSequence {
  event_id: string;
  transaction_id: string;
  customer_id: string;
  customer_email: string;
  amount_paise: number;
  decline_code: string;
  decline_reason: string;
  failed_at: string;
  sub_type: string;
  sub_type_label: string;
  retryable: boolean;
  max_attempts: number;
  description: string;
  regulatory_note: string;
  current_step: number;
  total_steps: number;
  steps: MandateSequenceStep[];
  actions: Array<{
    id: string;
    action_type: string;
    status: string;
    scheduled_at: string | null;
    executed_at: string | null;
    outcome: Record<string, unknown> | null;
  }>;
  agent_reasoning?: string;
}

export interface MandateStats {
  total_mandate_events: number;
  total_amount_paise: number;
  retryable_count: number;
  non_retryable_count: number;
  by_sub_type: Record<string, { count: number; label: string; retryable: boolean }>;
  action_status: Record<string, number>;
}

export async function fetchMandateSequences(params?: { limit?: number }): Promise<{ sequences: MandateSequence[]; total: number }> {
  const { data } = await api.get('/mandate/sequences', { params });
  return data;
}

export async function fetchMandateSequence(eventId: string): Promise<MandateSequence> {
  const { data } = await api.get(`/mandate/sequence/${eventId}`);
  return data;
}

export async function createMandateSequence(eventId: string): Promise<Record<string, unknown>> {
  const { data } = await api.post(`/mandate/sequence/${eventId}`);
  return data;
}

export async function advanceMandateSequence(eventId: string): Promise<Record<string, unknown>> {
  const { data } = await api.post(`/mandate/advance/${eventId}`);
  return data;
}

export async function fetchMandateStats(): Promise<MandateStats> {
  const { data } = await api.get('/mandate/stats');
  return data;
}

export async function fetchGuardrailInfo(): Promise<GuardrailInfo> {
  const { data } = await api.get('/guardrail/info');
  return data;
}

export async function fetchLedgerCount(): Promise<{ merchant_id: string; count: number }> {
  const { data } = await api.get('/ledger/count');
  return data;
}
