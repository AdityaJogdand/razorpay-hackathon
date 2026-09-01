import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { InputNumber, Input, Select, Spin, message } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  WarningFilled,
  MailOutlined,
  DownOutlined,
  RightOutlined,
  ThunderboltOutlined,
  ShoppingCartOutlined,
  CreditCardOutlined,
  SwapOutlined,
  DollarOutlined,
} from '@ant-design/icons';
import {
  simulatePayment,
  simulateRecovery,
  approveEmail,
  fetchDashboardEvents,
  simulateCheckoutAbandon,
  sendCheckoutRecovery,
  completeCheckout,
  previewCheckoutEmail,
  fetchCheckoutEvents,
  type DashboardEvent,
  type CheckoutEvent,
} from '../api/dashboard';

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

type FailureType = 'SOFT' | 'HARD' | 'MANDATE' | 'UNKNOWN';
type SimSection = 'payment' | 'checkout';

const FAILURE_TYPES: { key: FailureType; label: string; desc: string; color: string; bg: string }[] = [
  { key: 'SOFT', label: 'Soft Decline', desc: 'Temporary issue (timeout, insufficient funds). Agent retries automatically.', color: '#d97706', bg: '#fffbeb' },
  { key: 'HARD', label: 'Hard Decline', desc: 'Permanent issue (card expired). Agent sends recovery email via SMTP.', color: '#ef4444', bg: '#fef2f2' },
  { key: 'MANDATE', label: 'Mandate Failure', desc: 'UPI/e-mandate lifecycle issue. Triggers NPCI-compliant recovery sequence.', color: '#7c3aed', bg: '#f5f3ff' },
  { key: 'UNKNOWN', label: 'Unknown Error', desc: 'Unrecognized code. Escalated to human review queue.', color: '#6b7280', bg: '#f9fafb' },
];

const MANDATE_SUB_TYPES = [
  { value: 'NOT_FOUND', label: 'U40 — Mandate Not Found' },
  { value: 'REVOKED', label: 'U37 — Mandate Revoked' },
  { value: 'PAUSED', label: 'U38 — Mandate Paused' },
  { value: 'EXPIRED', label: 'U39 — Mandate Expired' },
  { value: 'DEBIT_LIMIT', label: 'U41 — Debit Limit Breached' },
  { value: 'PRE_DEBIT', label: 'U47 — Pre-Debit Not Sent' },
  { value: 'STOP_PAYMENT', label: 'R0 — Stop Payment Order' },
];

const CHECKOUT_STAGES = [
  { value: 'LANDING', label: 'Drop at landing page' },
  { value: 'CONTACT', label: 'Drop at contact info' },
  { value: 'ADDRESS', label: 'Drop at address' },
  { value: 'PAYMENT', label: 'Drop at payment selection' },
  { value: 'INITIATED', label: 'Drop during payment flow' },
  { value: 'FAILED', label: 'Payment attempt failed' },
];

interface SimResult {
  simulation: {
    transaction_id: string;
    failure_type: string;
    mandate_sub_type: string | null;
    amount_paise: number;
    amount_display: string;
    customer_email: string;
    error_code: string;
    error_description: string;
  };
  ingest: {
    event_id: string;
    failure_class: string;
    classification_source: string;
    confidence: number;
    plan_summary: { actions: number; suppressions: number; action_types: string[]; suppression_rules: string[] };
  };
  agent: {
    proposed_action?: string;
    reasoning?: string;
    confidence?: number;
    retry_schedule?: number[];
    has_email_draft?: boolean;
    email_draft?: { subject: string; body: string } | null;
  };
  guardrail: {
    approved?: boolean;
    overridden?: boolean;
    final_action?: string;
    override_reason?: string;
    checks?: Array<{ rule: string; passed: boolean; detail?: string }>;
  };
  execution: Array<{
    action_type: string;
    status: string;
    detail: string;
    retry_number?: number;
  }>;
  mandate_sequence?: {
    sub_type: string;
    retryable: boolean;
    total_steps: number;
    description: string;
  } | null;
}

type PaymentPhase = 'input' | 'simulating' | 'result' | 'approving' | 'approved' | 'recovering' | 'recovered';

interface CheckoutSimResult {
  event: {
    id: string;
    product_name: string;
    amount_display: string;
    customer_email: string | null;
    drop_off_stage: string;
    drop_off_stage_label: string;
    drop_off_reason: string;
    checkout_id: string;
    recovery_emails_sent: number;
    recovered: boolean;
    recovery_actions: Array<{
      id: string;
      type: string;
      stage: string;
      email?: { subject: string; body: string };
      sent_to?: string;
      sent_at: string;
      status: string;
    }>;
  };
  recovery_eligible: boolean;
}

type CheckoutPhase = 'input' | 'simulating' | 'abandoned' | 'previewing' | 'sending' | 'email_sent' | 'recovering' | 'recovered';

// ── Shared history entry ──
interface HistoryEntry {
  id: string;
  type: 'payment' | 'checkout';
  label: string;
  amount_display: string;
  failure_class: string;
  status: 'pending' | 'email_sent' | 'recovered' | 'auto_recovered' | 'escalated';
  event_id: string;
  transaction_id?: string;
  checkout_id?: string;
  email?: string;
  created_at: string;
}

// ═══════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════

export default function PaymentSimulator() {
  const [activeSection, setActiveSection] = useState<SimSection>('payment');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);

  // Load existing events from backend on mount
  useEffect(() => {
    const loadHistory = async () => {
      const entries: HistoryEntry[] = [];
      try {
        const [paymentData, checkoutData] = await Promise.all([
          fetchDashboardEvents({ limit: 50 }),
          fetchCheckoutEvents({ limit: 50 }),
        ]);

        // Payment events
        for (const evt of paymentData.events) {
          const e = evt as DashboardEvent;
          const hasRecovery = e.outcome === 'recovered';
          const hasPendingEmail = e.actions?.some(a => a.status === 'PENDING_APPROVAL');
          const hasEmailSent = e.actions?.some(a =>
            (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && a.status === 'SUCCEEDED'
          );
          const isEscalated = e.outcome === 'escalated' || e.actions?.some(a => a.action_type === 'ESCALATE_HUMAN');
          const autoRec = e.outcome === 'recovered' && e.actions?.some(a => a.action_type === 'RETRY' && a.status === 'SUCCEEDED') && !hasEmailSent;

          let status: HistoryEntry['status'] = 'pending';
          if (hasRecovery) status = autoRec ? 'auto_recovered' : 'recovered';
          else if (isEscalated) status = 'escalated';
          else if (hasEmailSent) status = 'email_sent';
          else if (hasPendingEmail) status = 'pending';

          entries.push({
            id: e.id,
            type: 'payment',
            label: `${e.failure_class} — ${e.decline_code}`,
            amount_display: `\u20B9${(e.amount_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
            failure_class: e.failure_class,
            status,
            event_id: e.id,
            transaction_id: e.transaction_id,
            email: e.customer_email,
            created_at: e.failed_at,
          });
        }

        // Checkout events
        for (const evt of checkoutData.events) {
          const e = evt as CheckoutEvent;
          let status: HistoryEntry['status'] = 'pending';
          if (e.recovered) status = 'recovered';
          else if (e.recovery_emails_sent > 0) status = 'email_sent';
          else if (!e.customer_email) status = 'escalated';

          entries.push({
            id: e.id,
            type: 'checkout',
            label: `${e.drop_off_stage_label} — ${e.product_name}`,
            amount_display: e.amount_display,
            failure_class: 'CHECKOUT',
            status,
            event_id: e.id,
            checkout_id: e.checkout_id,
            email: e.customer_email || undefined,
            created_at: e.abandoned_at,
          });
        }

        // Sort by created_at descending
        entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        setHistory(entries);
      } catch {
        // silent — history is best-effort
      }
    };
    loadHistory();
  }, []);

  const addToHistory = useCallback((entry: HistoryEntry) => {
    setHistory(prev => [entry, ...prev.filter(h => h.event_id !== entry.event_id)]);
  }, []);

  const updateHistoryStatus = useCallback((eventId: string, status: HistoryEntry['status']) => {
    setHistory(prev => prev.map(h => h.event_id === eventId ? { ...h, status } : h));
  }, []);

  const handleHistoryRecover = async (entry: HistoryEntry) => {
    setRecoveringId(entry.event_id);
    try {
      if (entry.type === 'payment') {
        await simulateRecovery(entry.event_id);
      } else {
        await completeCheckout(entry.event_id);
      }
      updateHistoryStatus(entry.event_id, 'recovered');
      message.success(`${entry.amount_display} recovered — dashboard updated!`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Recovery failed';
      if (msg.includes('409') || msg.includes('Already')) {
        updateHistoryStatus(entry.event_id, 'recovered');
        message.info('Already recovered');
      } else {
        message.error(msg);
      }
    } finally {
      setRecoveringId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-[22px] font-bold text-[#1b1f2b] m-0">Simulation Hub</h1>
        <p className="text-[13px] text-[#7b8294] m-0 mt-1">Full lifecycle demo — simulate failures, review agent decisions, approve emails, recover payments</p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 mb-5">
        {[
          { key: 'payment' as SimSection, icon: <CreditCardOutlined />, label: 'Payment Failures', desc: 'Soft, Hard, Mandate, Unknown' },
          { key: 'checkout' as SimSection, icon: <ShoppingCartOutlined />, label: 'Checkout Abandonment', desc: '6-stage funnel recovery' },
        ].map(tab => (
          <div
            key={tab.key}
            onClick={() => setActiveSection(tab.key)}
            className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-all ${
              activeSection === tab.key
                ? 'border-[#528FF0] bg-[#eff6ff] border-2'
                : 'border-[#e5e8ec] hover:border-[#c4c9d4]'
            }`}
          >
            <span className={`text-[18px] ${activeSection === tab.key ? 'text-[#528FF0]' : 'text-[#7b8294]'}`}>{tab.icon}</span>
            <div>
              <div className={`text-[13px] font-semibold ${activeSection === tab.key ? 'text-[#528FF0]' : 'text-[#1b1f2b]'}`}>{tab.label}</div>
              <div className="text-[11px] text-[#7b8294]">{tab.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Section content */}
      {activeSection === 'payment'
        ? <PaymentSection addToHistory={addToHistory} updateHistoryStatus={updateHistoryStatus} />
        : <CheckoutSection addToHistory={addToHistory} updateHistoryStatus={updateHistoryStatus} />
      }

      {/* ═══════ Simulation History ═══════ */}
      {history.length > 0 && (
        <div className="mt-6 border border-[#e5e8ec] rounded-lg overflow-hidden">
          <div className="bg-[#f8f9fa] px-4 py-2.5 border-b border-[#e5e8ec]">
            <span className="text-[12px] font-semibold text-[#1b1f2b] uppercase tracking-wider">
              Simulation History
            </span>
            <span className="text-[11px] text-[#7b8294] ml-2">
              {history.filter(h => h.status === 'recovered' || h.status === 'auto_recovered').length}/{history.length} recovered
            </span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-[11px] font-semibold text-[#7b8294] uppercase tracking-wider bg-white">
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Transaction</th>
                <th className="text-left px-4 py-2">Amount</th>
                <th className="text-left px-4 py-2">Class</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-right px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id} className="border-t border-[#f0f0f0] hover:bg-[#f8f9fa] transition-colors">
                  <td className="px-4 py-2.5">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                      entry.type === 'payment'
                        ? 'text-[#528FF0] bg-[#eff6ff]'
                        : 'text-[#7c3aed] bg-[#f5f3ff]'
                    }`}>
                      {entry.type === 'payment' ? 'Payment' : 'Checkout'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="text-[12px] font-mono text-[#1b1f2b]">
                      {entry.transaction_id || entry.checkout_id || '—'}
                    </div>
                    <div className="text-[11px] text-[#7b8294]">{entry.label}</div>
                  </td>
                  <td className="px-4 py-2.5 text-[13px] font-semibold text-[#1b1f2b]">
                    {entry.amount_display}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[11px] font-semibold ${
                      entry.failure_class === 'SOFT' ? 'text-[#d97706]' :
                      entry.failure_class === 'HARD' ? 'text-[#ef4444]' :
                      entry.failure_class === 'MANDATE' ? 'text-[#7c3aed]' :
                      entry.failure_class === 'CHECKOUT' ? 'text-[#0ea5e9]' :
                      'text-[#6b7280]'
                    }`}>
                      {entry.failure_class}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {entry.status === 'recovered' || entry.status === 'auto_recovered' ? (
                      <span className="text-[11px] font-semibold text-[#15803d] bg-[#15803d14] px-2 py-0.5 rounded border border-[#15803d30]">
                        <CheckCircleFilled className="mr-1" />Recovered
                      </span>
                    ) : entry.status === 'escalated' ? (
                      <span className="text-[11px] font-semibold text-[#d97706] bg-[#fffbeb] px-2 py-0.5 rounded border border-[#d9770630]">
                        Escalated
                      </span>
                    ) : entry.status === 'email_sent' ? (
                      <span className="text-[11px] font-semibold text-[#528FF0] bg-[#eff6ff] px-2 py-0.5 rounded border border-[#528FF030]">
                        Email Sent
                      </span>
                    ) : (
                      <span className="text-[11px] font-semibold text-[#d97706] bg-[#fffbeb] px-2 py-0.5 rounded border border-[#d9770630]">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {(entry.status === 'pending' || entry.status === 'email_sent') && (
                      <button
                        onClick={() => handleHistoryRecover(entry)}
                        disabled={recoveringId === entry.event_id}
                        className="px-3 py-1.5 text-[11px] font-semibold text-white bg-[#22c55e] rounded-lg hover:bg-[#16a34a] transition-colors cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {recoveringId === entry.event_id ? (
                          <Spin size="small" />
                        ) : (
                          <><DollarOutlined className="mr-1" />Recover</>
                        )}
                      </button>
                    )}
                    {(entry.status === 'recovered' || entry.status === 'auto_recovered') && (
                      <span className="text-[11px] text-[#15803d]">
                        <CheckCircleFilled /> Done
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Payment Failure Section
// ═══════════════════════════════════════════════

interface SectionProps {
  addToHistory: (entry: HistoryEntry) => void;
  updateHistoryStatus: (eventId: string, status: HistoryEntry['status']) => void;
}

function PaymentSection({ addToHistory, updateHistoryStatus }: SectionProps) {
  const navigate = useNavigate();
  const [selectedType, setSelectedType] = useState<FailureType>('SOFT');
  const [mandateSubType, setMandateSubType] = useState('NOT_FOUND');
  const [amount, setAmount] = useState(4999);
  const [email, setEmail] = useState('demo@razorpay.com');
  const [phase, setPhase] = useState<PaymentPhase>('input');
  const [result, setResult] = useState<SimResult | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<{ amount_display: string; payment_id: string } | null>(null);
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(true);
  const [emailDraft, setEmailDraft] = useState<{ subject: string; body: string } | null>(null);
  const [loadingStep, setLoadingStep] = useState(0);

  const LOADING_STEPS = [
    { label: 'Ingesting payment failure...', color: '#ef4444' },
    { label: 'Classifying decline code...', color: '#528FF0' },
    { label: 'Agent reasoning about recovery...', color: '#7c3aed' },
    { label: 'Running guardrail checks...', color: '#22c55e' },
    { label: 'Drafting recovery email...', color: '#d97706' },
  ];

  const handleSimulate = async () => {
    setPhase('simulating');
    setResult(null);
    setRecoveryResult(null);
    setEmailDraft(null);
    setLoadingStep(0);

    // Animate through loading steps
    const stepInterval = setInterval(() => {
      setLoadingStep(prev => {
        if (prev < LOADING_STEPS.length - 1) return prev + 1;
        return prev;
      });
    }, 1200);

    try {
      const res = await simulatePayment({
        failure_type: selectedType,
        mandate_sub_type: selectedType === 'MANDATE' ? mandateSubType : undefined,
        amount_paise: Math.round(amount * 100),
        customer_email: email,
      });
      const simResult = res as SimResult;
      setResult(simResult);
      setPhase('result');

      // Determine initial status for history
      const exec0 = simResult.execution?.[0];
      const autoRec = exec0?.status === 'SUCCEEDED' && exec0?.action_type === 'RETRY';
      const escalated = exec0?.action_type === 'ESCALATE_HUMAN';
      const historyStatus: HistoryEntry['status'] = autoRec ? 'auto_recovered' : escalated ? 'escalated' : 'pending';

      addToHistory({
        id: simResult.ingest.event_id,
        type: 'payment',
        label: `${simResult.ingest.failure_class} — ${simResult.simulation.error_code}`,
        amount_display: simResult.simulation.amount_display,
        failure_class: simResult.ingest.failure_class,
        status: historyStatus,
        event_id: simResult.ingest.event_id,
        transaction_id: simResult.simulation.transaction_id,
        email: simResult.simulation.customer_email,
        created_at: new Date().toISOString(),
      });

      // Fetch email draft if there's a pending email
      const pendingEmail = simResult.execution?.find(
        e => e.status === 'PENDING_APPROVAL' && (e.action_type === 'REAUTH_REQUEST' || e.action_type === 'CONTACT_EMAIL')
      );
      if (pendingEmail) {
        try {
          const eventsData = await fetchDashboardEvents({ limit: 5 });
          const matchingEvent = eventsData.events.find((e: Record<string, unknown>) => e.id === simResult.ingest.event_id);
          if (matchingEvent?.agent?.email_draft) {
            setEmailDraft(matchingEvent.agent.email_draft);
          }
        } catch { /* email preview is best-effort */ }
      }

      clearInterval(stepInterval);
      message.success('Payment simulated — agent pipeline complete');
    } catch (err) {
      clearInterval(stepInterval);
      message.error(err instanceof Error ? err.message : 'Simulation failed');
      setPhase('input');
    }
  };

  const handleApproveEmail = async () => {
    if (!result) return;
    setPhase('approving');
    try {
      const eventsData = await fetchDashboardEvents({ limit: 5 });
      const matchingEvent = eventsData.events.find((e: Record<string, unknown>) => e.id === result.ingest.event_id);
      const actions = (matchingEvent as Record<string, unknown>)?.actions as Array<{ id: string; status: string; action_type: string }> | undefined;
      const pendingAction = actions?.find(
        a => a.status === 'PENDING_APPROVAL' && (a.action_type === 'REAUTH_REQUEST' || a.action_type === 'CONTACT_EMAIL')
      );

      if (!pendingAction) {
        message.warning('Could not find pending action — check Decisions dashboard');
        setPhase('result');
        return;
      }

      await approveEmail(pendingAction.id);
      setPhase('approved');
      updateHistoryStatus(result.ingest.event_id, 'email_sent');
      message.success('Email approved and sent via SMTP');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Approval failed');
      setPhase('result');
    }
  };

  const handleRecovery = async () => {
    if (!result) return;
    setPhase('recovering');
    try {
      const res = await simulateRecovery(result.ingest.event_id);
      setRecoveryResult({ amount_display: res.amount_display, payment_id: res.payment_id });
      setPhase('recovered');
      updateHistoryStatus(result.ingest.event_id, 'recovered');
      message.success('Payment recovered — dashboard updated!');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Recovery failed';
      if (errMsg.includes('409') || errMsg.includes('Already')) {
        message.info('Already recovered');
        setPhase('recovered');
        updateHistoryStatus(result.ingest.event_id, 'recovered');
      } else {
        message.error(errMsg);
        setPhase('approved');
      }
    }
  };

  const handleReset = () => {
    setPhase('input');
    setResult(null);
    setRecoveryResult(null);
    setEmailDraft(null);
  };

  const executionOutcome = result?.execution?.[0];
  const isRecovered = executionOutcome?.status === 'SUCCEEDED' && executionOutcome?.action_type === 'RETRY';
  const isEmailPending = executionOutcome?.status === 'PENDING_APPROVAL';
  const isEscalated = executionOutcome?.action_type === 'ESCALATE_HUMAN';
  const showApproveButton = isEmailPending && (phase === 'result');
  const autoRecovered = isRecovered && phase === 'result';

  return (
    <div className="grid grid-cols-[1fr_1fr] gap-6">
      {/* Left: Input */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">Select Failure Type</div>
          {phase !== 'input' && (
            <button onClick={handleReset} className="px-3 py-1 text-[11px] font-medium text-[#7b8294] bg-white border border-[#e5e8ec] rounded-lg hover:bg-[#f8fafc] cursor-pointer transition-colors">
              Reset
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {FAILURE_TYPES.map((ft) => (
            <div
              key={ft.key}
              onClick={() => { setSelectedType(ft.key); if (phase !== 'input') handleReset(); }}
              className={`p-3 rounded-lg border cursor-pointer transition-all ${
                selectedType === ft.key ? 'border-2 shadow-sm' : 'border-[#e5e8ec] hover:border-[#c4c9d4]'
              }`}
              style={selectedType === ft.key ? { borderColor: ft.color, backgroundColor: ft.bg } : {}}
            >
              <div className="text-[13px] font-semibold" style={{ color: ft.color }}>{ft.label}</div>
              <div className="text-[11px] text-[#7b8294] mt-0.5 leading-snug">{ft.desc}</div>
            </div>
          ))}
        </div>

        {selectedType === 'MANDATE' && (
          <div className="mb-4">
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">NPCI Decline Code</div>
            <Select value={mandateSubType} onChange={setMandateSubType} options={MANDATE_SUB_TYPES} style={{ width: '100%' }} size="middle" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Amount (INR)</div>
            <InputNumber value={amount} onChange={(v) => setAmount(v || 4999)} min={1} max={100000} prefix={'\u20B9'} style={{ width: '100%' }} />
          </div>
          <div>
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Customer Email</div>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>

        <button
          onClick={handleSimulate}
          disabled={phase === 'simulating'}
          className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#528FF0] rounded-lg hover:bg-[#4280e0] transition-colors cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === 'simulating' ? 'Simulating...' : 'Simulate Failed Payment'}
        </button>

        {phase === 'simulating' && (
          <div className="mt-4 border border-[#e5e8ec] rounded-lg p-4">
            <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-3">Agent Pipeline</div>
            <div className="space-y-2.5">
              {LOADING_STEPS.map((step, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${
                    i < loadingStep ? 'bg-[#22c55e]' :
                    i === loadingStep ? 'border-2 animate-pulse' :
                    'bg-[#e5e8ec]'
                  }`}
                    style={i === loadingStep ? { borderColor: step.color } : {}}
                  >
                    {i < loadingStep && <CheckCircleFilled className="text-white text-[9px]" />}
                    {i === loadingStep && (
                      <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: step.color }} />
                    )}
                  </div>
                  <span className={`text-[12px] transition-all duration-300 ${
                    i < loadingStep ? 'text-[#22c55e] line-through' :
                    i === loadingStep ? 'font-semibold' :
                    'text-[#c4c9d4]'
                  }`}
                    style={i === loadingStep ? { color: step.color } : {}}
                  >
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lifecycle flow indicator */}
        {result && (
          <div className="mt-4 border border-[#e5e8ec] rounded-lg p-3">
            <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Demo Lifecycle</div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <StepDot done label="Fail" />
              <StepLine />
              <StepDot done label="Classify" />
              <StepLine />
              <StepDot done label="Agent" />
              <StepLine />
              <StepDot done label="Guardrail" />
              <StepLine />
              <StepDot done={!isEmailPending || phase !== 'result'} active={isEmailPending && phase === 'result'} label={isEscalated ? 'Escalate' : isRecovered || autoRecovered ? 'Retry' : 'Email'} />
              {!isEscalated && (
                <>
                  <StepLine />
                  <StepDot
                    done={phase === 'recovered' || autoRecovered}
                    active={phase === 'approved' || phase === 'recovering'}
                    label="Recover"
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right: Result */}
      <div className="min-h-[400px]">
        {!result && phase === 'input' && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <p className="text-[13px] text-[#9ca3af] mt-3">Select a failure type and click simulate</p>
            <p className="text-[11px] text-[#c4c9d4] mt-1">Full lifecycle: fail → classify → agent → guardrail → email → recover</p>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {/* Step 1: Payment Failed */}
            <div className="border border-[#e5e8ec] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full bg-[#ef4444] text-white text-[10px] font-bold flex items-center justify-center">1</div>
                <span className="text-[13px] font-semibold text-[#1b1f2b]">Payment Failed</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <span className="text-[#9ca3af]">Transaction</span>
                <span className="text-[#1b1f2b] font-mono text-[11px]">{result.simulation.transaction_id}</span>
                <span className="text-[#9ca3af]">Amount</span>
                <span className="text-[#1b1f2b] font-semibold">{result.simulation.amount_display}</span>
                <span className="text-[#9ca3af]">Error</span>
                <span className="text-[#ef4444] text-[11px]">{result.simulation.error_code}</span>
                <span className="text-[#9ca3af]">Email</span>
                <span className="text-[#1b1f2b] text-[11px]">{result.simulation.customer_email}</span>
              </div>
            </div>

            {/* Step 2: Classified */}
            <div className="border border-[#e5e8ec] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full bg-[#528FF0] text-white text-[10px] font-bold flex items-center justify-center">2</div>
                <span className="text-[13px] font-semibold text-[#1b1f2b]">Classified</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <span className="text-[#9ca3af]">Class</span>
                <span className={`font-semibold ${
                  result.ingest.failure_class === 'SOFT' ? 'text-[#d97706]' :
                  result.ingest.failure_class === 'HARD' ? 'text-[#ef4444]' :
                  result.ingest.failure_class === 'MANDATE' ? 'text-[#7c3aed]' : 'text-[#6b7280]'
                }`}>{result.ingest.failure_class}</span>
                <span className="text-[#9ca3af]">Confidence</span>
                <span className="text-[#1b1f2b]">{Math.round(result.ingest.confidence * 100)}%</span>
                {result.mandate_sequence && (
                  <>
                    <span className="text-[#9ca3af]">Mandate</span>
                    <span className="text-[#7c3aed] font-medium">{result.mandate_sequence.sub_type} — {result.mandate_sequence.description.split('—')[0]?.trim()}</span>
                  </>
                )}
              </div>
            </div>

            {/* Step 3: Agent Reasoning */}
            {result.agent?.reasoning && (
              <div className="border border-[#e5e8ec] rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-5 h-5 rounded-full bg-[#7c3aed] text-white text-[10px] font-bold flex items-center justify-center">3</div>
                  <span className="text-[13px] font-semibold text-[#1b1f2b]">Agent Reasoning</span>
                </div>
                <p className="text-[12px] text-[#3b4055] leading-relaxed mb-2">{result.agent.reasoning}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  <span className="text-[#9ca3af]">Proposed Action</span>
                  <span className="text-[#1b1f2b] font-semibold">{result.agent.proposed_action?.replace(/_/g, ' ')}</span>
                  <span className="text-[#9ca3af]">Confidence</span>
                  <span className="text-[#1b1f2b]">{Math.round((result.agent.confidence || 0) * 100)}%</span>
                </div>
              </div>
            )}

            {/* Step 4: Guardrail Validation */}
            {result.guardrail?.checks && result.guardrail.checks.length > 0 && (
              <div className={`border rounded-lg p-4 ${result.guardrail.overridden ? 'border-[#f59e0b] bg-[#fffbeb]' : 'border-[#e5e8ec]'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${result.guardrail.overridden ? 'bg-[#f59e0b]' : 'bg-[#22c55e]'}`}>4</div>
                  <span className="text-[13px] font-semibold text-[#1b1f2b]">
                    Guardrail {result.guardrail.overridden ? 'Override' : 'Approved'}
                  </span>
                </div>
                <div className="space-y-1.5 mb-2">
                  {result.guardrail.checks.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      {c.passed
                        ? <CheckCircleFilled className="text-[#22c55e] text-[11px]" />
                        : <CloseCircleFilled className="text-[#ef4444] text-[11px]" />
                      }
                      <span className="text-[#3b4055]">{c.rule}</span>
                      {c.detail && <span className="text-[#9ca3af] text-[11px]">— {c.detail}</span>}
                    </div>
                  ))}
                </div>
                {result.guardrail.overridden && result.guardrail.override_reason && (
                  <div className="flex items-start gap-2 mt-2 pt-2 border-t border-[#f59e0b]/30">
                    <WarningFilled className="text-[#f59e0b] text-[11px] mt-0.5" />
                    <span className="text-[11px] text-[#92400e]">{result.guardrail.override_reason}</span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] mt-2">
                  <span className="text-[#9ca3af]">Final Action</span>
                  <span className="text-[#1b1f2b] font-semibold">{result.guardrail.final_action?.replace(/_/g, ' ')}</span>
                </div>
              </div>
            )}

            {/* Step 5: Execution + Email Preview */}
            <div className={`border rounded-lg p-4 ${
              autoRecovered || phase === 'recovered' ? 'border-[#22c55e] bg-[#f0fdf4]' :
              isEmailPending && phase === 'result' ? 'border-[#d97706] bg-[#fffbeb]' :
              phase === 'approved' || phase === 'recovering' ? 'border-[#528FF0] bg-[#eff6ff]' :
              isEscalated ? 'border-[#d97706] bg-[#fffbeb]' :
              'border-[#e5e8ec]'
            }`}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${
                  autoRecovered || phase === 'recovered' ? 'bg-[#22c55e]' :
                  isEmailPending && phase === 'result' ? 'bg-[#d97706]' :
                  phase === 'approved' ? 'bg-[#528FF0]' :
                  isEscalated ? 'bg-[#d97706]' : 'bg-[#6b7280]'
                }`}>5</div>
                <span className="text-[13px] font-semibold text-[#1b1f2b]">
                  {phase === 'recovered' || autoRecovered ? 'Payment Recovered' :
                   phase === 'approved' ? 'Email Sent — Awaiting Customer' :
                   phase === 'approving' ? 'Sending Email...' :
                   isEmailPending && phase === 'result' ? 'Email Draft Ready' :
                   isEscalated ? 'Escalated to Human Review' :
                   isRecovered ? 'Payment Recovered via Retry' :
                   executionOutcome ? 'Action Executed' : 'No Execution'}
                </span>
              </div>

              {executionOutcome && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  <span className="text-[#9ca3af]">Action</span>
                  <span className="text-[#1b1f2b]">{executionOutcome.action_type.replace(/_/g, ' ')}</span>
                  <span className="text-[#9ca3af]">Status</span>
                  <span className={`font-semibold ${
                    executionOutcome.status === 'SUCCEEDED' ? 'text-[#22c55e]' :
                    executionOutcome.status === 'PENDING_APPROVAL' ? 'text-[#d97706]' :
                    'text-[#1b1f2b]'
                  }`}>
                    {phase === 'approved' ? 'SENT' :
                     phase === 'recovered' ? 'RECOVERED' :
                     executionOutcome.status === 'PENDING_APPROVAL' ? 'AWAITING APPROVAL' :
                     executionOutcome.status}
                  </span>
                  {(phase === 'recovered' || autoRecovered) && (
                    <>
                      <span className="text-[#9ca3af]">Recovered</span>
                      <span className="text-[#22c55e] font-bold">{recoveryResult?.amount_display || result.simulation.amount_display}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Email preview — shown before approve button */}
            {showApproveButton && emailDraft && (
              <div className="bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg">
                <div
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                  onClick={() => setEmailPreviewOpen(v => !v)}
                >
                  <MailOutlined className="text-[13px] text-[#7b8294]" />
                  <span className="text-[12px] font-semibold text-[#1b1f2b]">Email Preview</span>
                  <span className="text-[11px] text-[#7b8294]">— {result.simulation.customer_email}</span>
                  <span className="ml-auto text-[11px] text-[#7b8294]">
                    {emailPreviewOpen ? <DownOutlined /> : <RightOutlined />}
                  </span>
                </div>
                {emailPreviewOpen && (
                  <div className="border-t border-[#e5e8ec]">
                    <div className="bg-white px-3 py-2 border-b border-[#e5e8ec]">
                      <span className="text-[12px] font-medium text-[#1b1f2b]">{emailDraft.subject}</span>
                    </div>
                    <div className="bg-white px-3 py-2.5 text-[13px] text-[#3b4055] leading-relaxed whitespace-pre-wrap max-h-[240px] overflow-y-auto">
                      {emailDraft.body}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Recovery banner */}
            {(phase === 'recovered' || autoRecovered) && (
              <div className="bg-[#f0fdf4] border border-[#bbf7d0] rounded-lg p-4 text-center">
                <CheckCircleFilled className="text-[24px] text-[#22c55e]" />
                <div className="text-[14px] font-semibold text-[#15803d] mt-2">
                  {recoveryResult?.amount_display || result.simulation.amount_display} Recovered
                </div>
                <div className="text-[11px] text-[#166534] mt-1">
                  {autoRecovered
                    ? 'Automatic retry succeeded — payment captured'
                    : 'Customer responded to recovery email — payment captured'}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-2 mt-1">
              {showApproveButton && (
                <>
                  <p className="text-[12px] text-[#92400e] m-0">
                    {emailDraft ? 'Review the email above, then approve to send via SMTP.' : `Email draft is ready. Approve to send via SMTP to ${result.simulation.customer_email}`}
                  </p>
                  <button
                    onClick={handleApproveEmail}
                    disabled={phase === 'approving'}
                    className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#d97706] rounded-lg hover:bg-[#b45309] transition-colors cursor-pointer border-0 disabled:opacity-50"
                  >
                    {phase === 'approving' ? 'Sending...' : 'Approve & Send Email'}
                  </button>
                </>
              )}

              {phase === 'approved' && (
                <>
                  <p className="text-[12px] text-[#1e40af] m-0">
                    Email sent to {result.simulation.customer_email}. Simulate the customer updating their payment method and paying.
                  </p>
                  <button
                    onClick={handleRecovery}
                    disabled={phase === 'recovering'}
                    className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#22c55e] rounded-lg hover:bg-[#16a34a] transition-colors cursor-pointer border-0 disabled:opacity-50"
                  >
                    Simulate Customer Recovery
                  </button>
                </>
              )}

              {phase === 'result' && isRecovered && (
                <p className="text-[12px] text-[#15803d] m-0">
                  Agent automatically retried the payment and it succeeded.
                </p>
              )}

              {/* Navigation buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => navigate('/trace')}
                  className="flex-1 py-2 text-[12px] font-semibold text-white bg-[#528FF0] rounded-lg hover:bg-[#4280e0] transition-colors cursor-pointer border-0"
                >
                  View in Decisions
                </button>
                {result.ingest.failure_class === 'MANDATE' && (
                  <button
                    onClick={() => navigate('/mandates')}
                    className="flex-1 py-2 text-[12px] font-semibold text-[#7c3aed] bg-white border border-[#7c3aed] rounded-lg hover:bg-[#f5f3ff] transition-colors cursor-pointer"
                  >
                    Mandate Sequencer
                  </button>
                )}
                {result.ingest.failure_class === 'UNKNOWN' && (
                  <button
                    onClick={() => navigate('/exceptions')}
                    className="flex-1 py-2 text-[12px] font-semibold text-[#d97706] bg-white border border-[#d97706] rounded-lg hover:bg-[#fffbeb] transition-colors cursor-pointer"
                  >
                    Exception Queue
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Checkout Abandonment Section
// ═══════════════════════════════════════════════

function CheckoutSection({ addToHistory, updateHistoryStatus }: SectionProps) {
  const navigate = useNavigate();
  const [stage, setStage] = useState('PAYMENT');
  const [amount, setAmount] = useState(2499);
  const [email, setEmail] = useState('demo@razorpay.com');
  const [product, setProduct] = useState('Annual Premium Plan');
  const [phase, setPhase] = useState<CheckoutPhase>('input');
  const [simResult, setSimResult] = useState<CheckoutSimResult | null>(null);
  const [emailPreview, setEmailPreview] = useState<{ subject: string; body: string } | null>(null);
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(true);
  const [sentEmails, setSentEmails] = useState<Array<{ num: number; email: { subject: string; body: string }; sent_at: string }>>([]);
  const [viewingSentEmail, setViewingSentEmail] = useState<number | null>(null);

  const handleSimulate = async () => {
    setPhase('simulating');
    setSimResult(null);
    setEmailPreview(null);
    setSentEmails([]);
    try {
      const res = await simulateCheckoutAbandon({
        drop_off_stage: stage,
        amount_paise: Math.round(amount * 100),
        customer_email: email,
        product_name: product,
      });
      const checkoutRes = res as CheckoutSimResult;
      setSimResult(checkoutRes);
      setPhase('abandoned');

      addToHistory({
        id: checkoutRes.event.id,
        type: 'checkout',
        label: `${checkoutRes.event.drop_off_stage_label} — ${checkoutRes.event.product_name}`,
        amount_display: checkoutRes.event.amount_display,
        failure_class: 'CHECKOUT',
        status: checkoutRes.recovery_eligible ? 'pending' : 'escalated',
        event_id: checkoutRes.event.id,
        checkout_id: checkoutRes.event.checkout_id,
        email: checkoutRes.event.customer_email || undefined,
        created_at: new Date().toISOString(),
      });

      // Load email preview if recovery eligible
      if (checkoutRes.recovery_eligible) {
        try {
          const preview = await previewCheckoutEmail(checkoutRes.event.id);
          setEmailPreview(preview.email);
        } catch { /* best-effort */ }
      }

      message.success('Checkout abandonment simulated');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Simulation failed');
      setPhase('input');
    }
  };

  const handleSendRecovery = async () => {
    if (!simResult) return;
    setPhase('sending');
    try {
      const res = await sendCheckoutRecovery(simResult.event.id);
      const emailNum = res.email_number;
      setSentEmails(prev => [...prev, { num: emailNum, email: res.email, sent_at: new Date().toISOString() }]);
      simResult.event.recovery_emails_sent = emailNum;
      setPhase('email_sent');
      updateHistoryStatus(simResult.event.id, 'email_sent');
      message.success(`Recovery email #${emailNum} sent`);

      // Load next email preview if more emails available
      if (res.remaining_emails > 0) {
        try {
          const preview = await previewCheckoutEmail(simResult.event.id);
          setEmailPreview(preview.email);
        } catch {
          setEmailPreview(null);
        }
      } else {
        setEmailPreview(null);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to send');
      setPhase('abandoned');
    }
  };

  const handleComplete = async () => {
    if (!simResult) return;
    setPhase('recovering');
    try {
      await completeCheckout(simResult.event.id);
      simResult.event.recovered = true;
      setPhase('recovered');
      updateHistoryStatus(simResult.event.id, 'recovered');
      message.success('Checkout completed — payment recovered! Dashboard updated.');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed');
      setPhase('email_sent');
    }
  };

  const handleReset = () => {
    setPhase('input');
    setSimResult(null);
    setEmailPreview(null);
    setSentEmails([]);
    setViewingSentEmail(null);
  };

  const emailsSent = simResult?.event.recovery_emails_sent || 0;
  const canSendMore = emailsSent < 3 && simResult?.recovery_eligible && !simResult?.event.recovered;

  return (
    <div className="grid grid-cols-[1fr_1fr] gap-6">
      {/* Left: Input */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">Checkout Drop-off Config</div>
          {phase !== 'input' && (
            <button onClick={handleReset} className="px-3 py-1 text-[11px] font-medium text-[#7b8294] bg-white border border-[#e5e8ec] rounded-lg hover:bg-[#f8fafc] cursor-pointer transition-colors">
              Reset
            </button>
          )}
        </div>

        <div className="mb-4">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Drop-off Stage</div>
          <Select value={stage} onChange={setStage} options={CHECKOUT_STAGES} style={{ width: '100%' }} size="middle" />
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Amount (INR)</div>
            <InputNumber value={amount} onChange={(v) => setAmount(v || 2499)} min={1} max={100000} prefix={'\u20B9'} style={{ width: '100%' }} />
          </div>
          <div>
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Customer Email</div>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Product Name</div>
          <Input value={product} onChange={(e) => setProduct(e.target.value)} />
        </div>

        <button
          onClick={handleSimulate}
          disabled={phase === 'simulating'}
          className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#528FF0] rounded-lg hover:bg-[#4280e0] transition-colors cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === 'simulating' ? 'Simulating...' : 'Simulate Checkout Abandonment'}
        </button>

        {phase === 'simulating' && (
          <div className="flex items-center justify-center py-8">
            <Spin size="large" />
            <span className="ml-3 text-[13px] text-[#7b8294]">Creating abandoned checkout...</span>
          </div>
        )}

        {/* Lifecycle flow indicator */}
        {simResult && (
          <div className="mt-4 border border-[#e5e8ec] rounded-lg p-3">
            <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Recovery Lifecycle</div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <StepDot done label="Abandon" />
              <StepLine />
              <StepDot done={emailsSent >= 1} active={phase === 'abandoned' && emailsSent === 0} label="Email 1" />
              <StepLine />
              <StepDot done={emailsSent >= 2} active={emailsSent === 1 && phase === 'email_sent'} label="Email 2" />
              <StepLine />
              <StepDot done={emailsSent >= 3} active={emailsSent === 2 && phase === 'email_sent'} label="Email 3" />
              <StepLine />
              <StepDot done={phase === 'recovered'} active={phase === 'recovering'} label="Recover" />
            </div>
          </div>
        )}
      </div>

      {/* Right: Result */}
      <div className="min-h-[400px]">
        {!simResult && phase === 'input' && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ShoppingCartOutlined className="text-[48px] text-[#d1d5db]" />
            <p className="text-[13px] text-[#9ca3af] mt-3">Configure a checkout drop-off scenario</p>
            <p className="text-[11px] text-[#c4c9d4] mt-1">Abandon → email sequence → customer return → recovered</p>
          </div>
        )}

        {simResult && (
          <div className="space-y-3">
            {/* Step 1: Checkout Abandoned */}
            <div className="border border-[#e5e8ec] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full bg-[#ef4444] text-white text-[10px] font-bold flex items-center justify-center">1</div>
                <span className="text-[13px] font-semibold text-[#1b1f2b]">Checkout Abandoned</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <span className="text-[#9ca3af]">Product</span>
                <span className="text-[#1b1f2b] font-medium">{simResult.event.product_name}</span>
                <span className="text-[#9ca3af]">Amount</span>
                <span className="text-[#1b1f2b] font-semibold">{simResult.event.amount_display}</span>
                <span className="text-[#9ca3af]">Drop-off</span>
                <span className="text-[#ef4444] font-medium">{simResult.event.drop_off_stage_label}</span>
                <span className="text-[#9ca3af]">Reason</span>
                <span className="text-[#3b4055] text-[11px]">{simResult.event.drop_off_reason}</span>
                <span className="text-[#9ca3af]">Checkout ID</span>
                <span className="text-[#1b1f2b] font-mono text-[11px]">{simResult.event.checkout_id}</span>
                {!simResult.recovery_eligible && (
                  <>
                    <span className="text-[#9ca3af]">Recovery</span>
                    <span className="text-[#94a3b8]">Not eligible — no contact info captured</span>
                  </>
                )}
              </div>
            </div>

            {/* Sent emails */}
            {sentEmails.length > 0 && (
              <div className="border border-[#e5e8ec] rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${phase === 'recovered' ? 'bg-[#22c55e]' : 'bg-[#528FF0]'}`}>2</div>
                  <span className="text-[13px] font-semibold text-[#1b1f2b]">Recovery Emails Sent</span>
                  <span className="text-[11px] text-[#7b8294] ml-auto">{sentEmails.length}/3</span>
                </div>
                <div className="space-y-2">
                  {sentEmails.map(se => (
                    <div key={se.num} className="border border-[#e5e8ec] rounded-lg overflow-hidden">
                      <div
                        className="flex items-center gap-2 px-3 py-2 bg-[#f8f9fa] cursor-pointer select-none hover:bg-[#eef1f5] transition-colors"
                        onClick={() => setViewingSentEmail(viewingSentEmail === se.num ? null : se.num)}
                      >
                        <CheckCircleFilled className="text-[#22c55e] text-[11px]" />
                        <span className="text-[12px] font-medium text-[#1b1f2b]">Email #{se.num}: {se.email.subject}</span>
                        <span className="ml-auto text-[11px] text-[#7b8294]">
                          {viewingSentEmail === se.num ? <DownOutlined /> : <RightOutlined />}
                        </span>
                      </div>
                      {viewingSentEmail === se.num && (
                        <div className="bg-white px-3 py-2.5 text-[13px] text-[#3b4055] leading-relaxed whitespace-pre-wrap border-t border-[#e5e8ec] max-h-[200px] overflow-y-auto">
                          {se.email.body}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Next email preview */}
            {canSendMore && emailPreview && (
              <div className="bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg">
                <div
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                  onClick={() => setEmailPreviewOpen(v => !v)}
                >
                  <MailOutlined className="text-[13px] text-[#7b8294]" />
                  <span className="text-[12px] font-semibold text-[#1b1f2b]">
                    Email #{emailsSent + 1} Preview
                  </span>
                  <span className="text-[11px] text-[#7b8294]">— {simResult.event.customer_email}</span>
                  <span className="ml-auto text-[11px] text-[#7b8294]">
                    {emailPreviewOpen ? <DownOutlined /> : <RightOutlined />}
                  </span>
                </div>
                {emailPreviewOpen && (
                  <div className="border-t border-[#e5e8ec]">
                    <div className="bg-white px-3 py-2 border-b border-[#e5e8ec]">
                      <span className="text-[12px] font-medium text-[#1b1f2b]">{emailPreview.subject}</span>
                    </div>
                    <div className="bg-white px-3 py-2.5 text-[13px] text-[#3b4055] leading-relaxed whitespace-pre-wrap max-h-[240px] overflow-y-auto">
                      {emailPreview.body}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Recovery banner */}
            {phase === 'recovered' && (
              <div className="bg-[#f0fdf4] border border-[#bbf7d0] rounded-lg p-4 text-center">
                <CheckCircleFilled className="text-[24px] text-[#22c55e]" />
                <div className="text-[14px] font-semibold text-[#15803d] mt-2">
                  {simResult.event.amount_display} Recovered
                </div>
                <div className="text-[11px] text-[#166534] mt-1">
                  Customer returned and completed checkout after recovery outreach
                </div>
              </div>
            )}

            {/* Not eligible banner */}
            {!simResult.recovery_eligible && (
              <div className="bg-[#f9fafb] border border-[#e5e8ec] rounded-lg p-4 text-center">
                <div className="text-[13px] text-[#94a3b8]">
                  No contact info captured at landing stage — recovery email cannot be sent
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-2 mt-1">
              {canSendMore && (
                <button
                  onClick={handleSendRecovery}
                  disabled={phase === 'sending'}
                  className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#d97706] rounded-lg hover:bg-[#b45309] transition-colors cursor-pointer border-0 disabled:opacity-50"
                >
                  {phase === 'sending' ? 'Sending...' : `Approve & Send Email #${emailsSent + 1}`}
                </button>
              )}

              {emailsSent > 0 && !simResult.event.recovered && (
                <button
                  onClick={handleComplete}
                  disabled={phase === 'recovering'}
                  className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#22c55e] rounded-lg hover:bg-[#16a34a] transition-colors cursor-pointer border-0 disabled:opacity-50"
                >
                  {phase === 'recovering' ? 'Processing...' : 'Simulate Customer Completing Checkout'}
                </button>
              )}

              {/* Navigation */}
              <button
                onClick={() => navigate('/checkout')}
                className="w-full py-2 text-[12px] font-semibold text-white bg-[#528FF0] rounded-lg hover:bg-[#4280e0] transition-colors cursor-pointer border-0"
              >
                View in Checkout Recovery
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Shared Components
// ═══════════════════════════════════════════════

function StepDot({ done, active, label }: { done?: boolean; active?: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={`w-3 h-3 rounded-full ${
        done ? 'bg-[#22c55e]' : active ? 'bg-[#528FF0] animate-pulse' : 'bg-[#e5e8ec]'
      }`} />
      <span className={`text-[9px] ${done ? 'text-[#22c55e]' : active ? 'text-[#528FF0]' : 'text-[#b0b7c3]'} font-medium`}>{label}</span>
    </div>
  );
}

function StepLine() {
  return <div className="w-4 h-px bg-[#e5e8ec] mt-[-8px]" />;
}
