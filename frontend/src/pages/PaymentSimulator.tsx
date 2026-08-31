import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InputNumber, Input, Select, Spin, message } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons';
import { simulatePayment, simulateRecovery, approveEmail } from '../api/dashboard';

type FailureType = 'SOFT' | 'HARD' | 'MANDATE' | 'UNKNOWN';

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

type DemoPhase = 'input' | 'simulating' | 'result' | 'approving' | 'approved' | 'recovering' | 'recovered';

export default function PaymentSimulator() {
  const navigate = useNavigate();
  const [selectedType, setSelectedType] = useState<FailureType>('SOFT');
  const [mandateSubType, setMandateSubType] = useState('NOT_FOUND');
  const [amount, setAmount] = useState(4999);
  const [email, setEmail] = useState('demo@razorpay.com');
  const [phase, setPhase] = useState<DemoPhase>('input');
  const [result, setResult] = useState<SimResult | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<{ amount_display: string; payment_id: string } | null>(null);

  const handleSimulate = async () => {
    setPhase('simulating');
    setResult(null);
    setRecoveryResult(null);
    try {
      const res = await simulatePayment({
        failure_type: selectedType,
        mandate_sub_type: selectedType === 'MANDATE' ? mandateSubType : undefined,
        amount_paise: Math.round(amount * 100),
        customer_email: email,
      });
      setResult(res as SimResult);
      setPhase('result');
      message.success('Payment simulated — agent pipeline complete');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Simulation failed');
      setPhase('input');
    }
  };

  const handleApproveEmail = async () => {
    if (!result) return;
    // Find pending email action from the execution result
    const pendingEmail = result.execution?.find(
      e => e.status === 'PENDING_APPROVAL' && (e.action_type === 'REAUTH_REQUEST' || e.action_type === 'CONTACT_EMAIL')
    );
    if (!pendingEmail) {
      message.info('No pending email to approve');
      return;
    }

    setPhase('approving');
    try {
      // We need the action_id — fetch from dashboard events
      const { fetchDashboardEvents } = await import('../api/dashboard');
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
      message.success('Payment recovered!');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Recovery failed';
      if (errMsg.includes('409') || errMsg.includes('Already')) {
        message.info('Already recovered');
        setPhase('recovered');
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
  };

  const executionOutcome = result?.execution?.[0];
  const isRecovered = executionOutcome?.status === 'SUCCEEDED' && executionOutcome?.action_type === 'RETRY';
  const isEmailPending = executionOutcome?.status === 'PENDING_APPROVAL';
  const isEscalated = executionOutcome?.action_type === 'ESCALATE_HUMAN';

  // Determine which lifecycle buttons to show based on failure class
  const showApproveButton = isEmailPending && (phase === 'result');
  const showRecoverButton = (
    (phase === 'approved' || (phase === 'result' && isRecovered))
    && !recoveryResult
  );
  // For SOFT declines that auto-recovered via retry, skip straight to recovered
  const autoRecovered = isRecovered && phase === 'result';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <span className="text-[15px] font-semibold text-[#1b1f2b]">Payment Gateway Simulator</span>
          <p className="text-[12px] text-[#9ca3af] m-0 mt-0.5">Full lifecycle: fail → classify → agent → guardrail → execute → recover</p>
        </div>
        {phase !== 'input' && (
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-[12px] font-medium text-[#7b8294] bg-white border border-[#e5e8ec] rounded-lg hover:bg-[#f8fafc] cursor-pointer transition-colors"
          >
            New Simulation
          </button>
        )}
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-6">
        {/* Left: Input */}
        <div>
          <div className="mb-4">
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Select Failure Type</div>
            <div className="grid grid-cols-2 gap-2">
              {FAILURE_TYPES.map((ft) => (
                <div
                  key={ft.key}
                  onClick={() => { setSelectedType(ft.key); if (phase !== 'input') handleReset(); }}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedType === ft.key
                      ? 'border-2 shadow-sm'
                      : 'border-[#e5e8ec] hover:border-[#c4c9d4]'
                  }`}
                  style={selectedType === ft.key ? { borderColor: ft.color, backgroundColor: ft.bg } : {}}
                >
                  <div className="text-[13px] font-semibold" style={{ color: ft.color }}>{ft.label}</div>
                  <div className="text-[11px] text-[#7b8294] mt-0.5 leading-snug">{ft.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Mandate sub-type selector */}
          {selectedType === 'MANDATE' && (
            <div className="mb-4">
              <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">NPCI Decline Code</div>
              <Select
                value={mandateSubType}
                onChange={setMandateSubType}
                options={MANDATE_SUB_TYPES}
                style={{ width: '100%' }}
                size="middle"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Amount (INR)</div>
              <InputNumber
                value={amount}
                onChange={(v) => setAmount(v || 4999)}
                min={1}
                max={100000}
                prefix={'\u20B9'}
                style={{ width: '100%' }}
              />
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
            <div className="flex items-center justify-center py-8">
              <Spin size="large" />
              <span className="ml-3 text-[13px] text-[#7b8294]">Running agent pipeline...</span>
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
                  <span className="text-[#9ca3af]">Source</span>
                  <span className="text-[#1b1f2b]">{result.ingest.classification_source}</span>
                  <span className="text-[#9ca3af]">Confidence</span>
                  <span className="text-[#1b1f2b]">{Math.round(result.ingest.confidence * 100)}%</span>
                  {result.mandate_sequence && (
                    <>
                      <span className="text-[#9ca3af]">Mandate Sub-Type</span>
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

              {/* Step 5: Execution */}
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

                {!executionOutcome && (
                  <p className="text-[12px] text-[#7b8294]">No execution action taken.</p>
                )}
              </div>

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
                {/* Approve email button */}
                {showApproveButton && (
                  <>
                    <p className="text-[12px] text-[#92400e] m-0">
                      Email draft is ready. Approve to send via SMTP to {result.simulation.customer_email}
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

                {/* Recovery button — simulate customer paying after email */}
                {(phase === 'approved') && (
                  <>
                    <p className="text-[12px] text-[#1e40af] m-0">
                      Email sent to {result.simulation.customer_email}. Simulate the customer updating their payment method and paying.
                    </p>
                    <button
                      onClick={handleRecovery}
                      disabled={phase === 'recovering'}
                      className="w-full py-2.5 text-[13px] font-semibold text-white bg-[#22c55e] rounded-lg hover:bg-[#16a34a] transition-colors cursor-pointer border-0 disabled:opacity-50"
                    >
                      {phase === 'recovering' ? 'Processing...' : 'Simulate Customer Recovery'}
                    </button>
                  </>
                )}

                {/* For auto-recovered SOFT declines, offer recovery sim too if it wasn't auto */}
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
                  {isEmailPending && phase === 'result' && (
                    <button
                      onClick={() => navigate('/emails')}
                      className="flex-1 py-2 text-[12px] font-semibold text-[#d97706] bg-white border border-[#d97706] rounded-lg hover:bg-[#fffbeb] transition-colors cursor-pointer"
                    >
                      Email Outreach
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
