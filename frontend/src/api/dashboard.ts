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
  outcome: 'recovered' | 'failed' | 'pending' | 'suppressed';
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
