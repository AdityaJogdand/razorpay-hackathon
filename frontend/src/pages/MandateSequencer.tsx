import { useState, useEffect } from 'react';
import { Drawer, Spin, Empty, Tag, Button, Progress, Tooltip, message } from 'antd';                                                import {
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleOutlined,
  PlayCircleOutlined,
  ExclamationCircleOutlined,
  WarningFilled,
  ReloadOutlined,
  SafetyOutlined,
  ArrowRightOutlined,
  DownOutlined,
  RightOutlined,
  UndoOutlined,
  CheckOutlined,
  MailOutlined,
  EditOutlined,
} from '@ant-design/icons';
import {
  fetchMandateSequences,
  fetchMandateStats,
  createMandateSequence,
  advanceMandateSequence,
  approveEmail,
  denyEmail,
  updateEmailDraft,
  type MandateSequence,
  type MandateSequenceStep,
  type MandateStats,
} from '../api/dashboard';

// ── Constants ──

const ESCALATE_LABEL = 'Escalate to team';

const SUB_TYPE_COLORS: Record<string, string> = {
  REVOKED: '#ef4444',
  PAUSED: '#f59e0b',
  EXPIRED: '#8b5cf6',
  NOT_FOUND: '#6366f1',
  DEBIT_LIMIT: '#ec4899',
  DATE_MISMATCH: '#14b8a6',
  CREATION_REJECTED: '#f97316',
  MOD_REJECTED: '#f97316',
  AMOUNT_EXCEEDED: '#ec4899',
  PSP_REJECTED: '#6b7280',
  PRE_DEBIT: '#3b82f6',
  STOP_PAYMENT: '#ef4444',
  DEBIT_NOT_ALLOWED: '#9ca3af',
};

const STEP_TYPE_LABELS: Record<string, string> = {
  SEND_PRE_DEBIT_NOTIFICATION: 'Pre-debit notification',
  WAIT: 'Waiting period',
  SEND_REAUTH_EMAIL: 'Re-authorization email',
  RETRY_DEBIT: 'Retry payment',
  RETRY_WITH_LOWER_AMOUNT: 'Retry (reduced amount)',
  ESCALATE_HUMAN: ESCALATE_LABEL,
  SEND_MANDATE_RENEWAL_LINK: 'Mandate renewal link',
  SCHEDULE_CORRECT_DATE: 'Reschedule to correct date',
  CLOSE_NO_RECOVERY: 'Close — no recovery',
};

// Map step types to the action types they produce for correlation
const STEP_TO_ACTION_TYPE: Record<string, string[]> = {
  SEND_PRE_DEBIT_NOTIFICATION: ['CONTACT_EMAIL'],
  SEND_REAUTH_EMAIL: ['REAUTH_REQUEST'],
  SEND_MANDATE_RENEWAL_LINK: ['REAUTH_REQUEST'],
  RETRY_DEBIT: ['RETRY'],
  RETRY_WITH_LOWER_AMOUNT: ['RETRY'],
  ESCALATE_HUMAN: ['ESCALATE_HUMAN'],
  SCHEDULE_CORRECT_DATE: ['ESCALATE_HUMAN'],
  CLOSE_NO_RECOVERY: ['ESCALATE_HUMAN'],
};

// ── Sequence-level status derivation ──

type SequenceStatus =
  | 'not_started'
  | 'in_progress'
  | 'awaiting_approval'
  | 'blocked'
  | 'escalated'
  | 'completed'
  | 'failed';

interface SequenceStatusInfo {
  status: SequenceStatus;
  label: string;
  color: string;
  icon: React.ReactNode;
  nextAction: string | null;
}

function deriveSequenceStatus(seq: MandateSequence): SequenceStatusInfo {
  const { actions, steps, current_step, total_steps } = seq;
  const sequenceActions = actions.filter(action => {
    const outcome = action.outcome;
    return Boolean(outcome && typeof outcome === 'object' && (outcome as Record<string, unknown>).mandate_sequence);
  });
  const relevantActions = sequenceActions.length > 0 ? sequenceActions : actions;

  if (relevantActions.length === 0) {
    const firstStep = steps[0];
    return {
      status: 'not_started',
      label: 'Not started',
      color: '#7b8294',
      icon: <ExclamationCircleOutlined className="text-[14px]" />,
      nextAction: firstStep ? STEP_TYPE_LABELS[firstStep.step_type] || firstStep.description : null,
    };
  }

  const hasPending = relevantActions.some(a => a.status === 'PENDING_APPROVAL');
  const hasUnresolved = relevantActions.some(a => a.status === 'UNRESOLVED');
  const lastAction = relevantActions[relevantActions.length - 1];

  if (seq.recovered) {
    return {
      status: 'completed',
      label: 'Payment recovered',
      color: '#15803d',
      icon: <CheckCircleFilled className="text-[14px]" />,
      nextAction: null,
    };
  }

  if (hasPending) {
    return {
      status: 'awaiting_approval',
      label: 'Awaiting approval',
      color: '#7b8294',
      icon: <ClockCircleOutlined className="text-[14px]" />,
      nextAction: 'Review and approve pending email',
    };
  }

  if (hasUnresolved) {
    return {
      status: 'escalated',
      label: 'Escalated',
      color: '#b45309',
      icon: <WarningFilled className="text-[14px]" />,
      nextAction: 'Awaiting human review',
    };
  }

  if (current_step > total_steps) {
    const lastNonWait = [...actions].reverse().find(a => a.action_type !== 'WAIT');
    if (lastNonWait?.status === 'FAILED' || lastNonWait?.status === 'DENIED') {
      return {
        status: 'failed',
        label: 'Recovery failed',
        color: '#b91c1c',
        icon: <CloseCircleFilled className="text-[14px]" />,
        nextAction: null,
      };
    }
    return {
      status: 'completed',
      label: 'Sequence complete',
      color: '#15803d',
      icon: <CheckCircleFilled className="text-[14px]" />,
      nextAction: null,
    };
  }

  if (lastAction?.status === 'FAILED') {
    const nextStep = steps.find(s => s.step_number >= current_step && s.step_type !== 'WAIT');
    return {
      status: 'blocked',
      label: 'Blocked — last step failed',
      color: '#b91c1c',
      icon: <CloseCircleFilled className="text-[14px]" />,
      nextAction: nextStep ? STEP_TYPE_LABELS[nextStep.step_type] || nextStep.description : ESCALATE_LABEL,
    };
  }

  const nextStep = steps.find(s => s.step_number >= current_step && s.step_type !== 'WAIT');
  return {
    status: 'in_progress',
    label: `Step ${current_step} of ${total_steps}`,
    color: '#7b8294',
    icon: <PlayCircleOutlined className="text-[14px]" />,
    nextAction: nextStep ? STEP_TYPE_LABELS[nextStep.step_type] || nextStep.description : null,
  };
}

// ── Step-level visual derivation ──
//
// Correlates steps to actions by position order:
// Walk through non-WAIT steps and actions in parallel.
// The Nth non-WAIT step maps to the Nth action.

type StepVisual = 'completed' | 'current' | 'pending' | 'upcoming' | 'skipped' | 'failed' | 'escalated' | 'waiting';

interface StepVisualInfo {
  visual: StepVisual;
  /** The action that executed this step, if any */
  matchedAction: MandateSequence['actions'][number] | null;
  /** For failed steps, the error reason */
  errorDetail: string | null;
}

function deriveAllStepVisuals(
  steps: MandateSequenceStep[],
  actions: MandateSequence['actions'],
): StepVisualInfo[] {
  // Build a positional mapping: Nth actionable step -> Nth action
  const actionableIndices: number[] = [];
  steps.forEach((s, i) => {
    if (s.step_type !== 'WAIT') actionableIndices.push(i);
  });

  // Also try outcome.step_number for explicit mapping
  const actionByStepNumber = new Map<number, MandateSequence['actions'][number]>();
  for (const a of actions) {
    const sn = a.outcome && typeof a.outcome === 'object'
      ? (a.outcome as Record<string, unknown>).step_number
      : undefined;
    if (typeof sn === 'number') {
      // Last action for a given step wins
      actionByStepNumber.set(sn, a);
    }
  }

  // A legacy agent email can stand in for the first outreach step only. Do
  // not map untagged actions to later steps: those may be unrelated policy
  // actions and would make a future email appear before its wait completes.
  const actionByTypeFallback = new Map<number, MandateSequence['actions'][number]>();
  const explicitlyMapped = new Set(actionByStepNumber.values());
  const firstActionableIdx = actionableIndices[0];
  if (firstActionableIdx !== undefined) {
    const firstStep = steps[firstActionableIdx];
    if (!actionByStepNumber.has(firstStep.step_number)) {
      const expectedTypes = STEP_TO_ACTION_TYPE[firstStep.step_type] || [];
      const matchedAction = [...actions].reverse().find(action =>
        !explicitlyMapped.has(action) && expectedTypes.includes(action.action_type)
      );
      if (matchedAction) actionByTypeFallback.set(firstActionableIdx, matchedAction);
    }
  }

  return steps.map((step, stepIdx) => {
    const isWait = step.step_type === 'WAIT';

    // Try explicit mapping first, then positional
    const matched = actionByStepNumber.get(step.step_number) ?? actionByTypeFallback.get(stepIdx) ?? null;

    if (isWait) {
      if (step.status === 'COMPLETED') return { visual: 'completed', matchedAction: null, errorDetail: null };
      if (step.status === 'IN_PROGRESS') return { visual: 'waiting', matchedAction: null, errorDetail: null };
      // Only mark WAIT as completed if the next actionable step's action is in a terminal state
      // (not just PENDING_APPROVAL — that means the advance skipped the wait)
      const nextActionableIdx = actionableIndices.find(ai => ai > stepIdx);
      if (nextActionableIdx !== undefined) {
        const nextAction = actionByStepNumber.get(steps[nextActionableIdx].step_number)
          ?? actionByTypeFallback.get(nextActionableIdx);
        if (nextAction) {
          const terminalStatuses = ['SUCCEEDED', 'FAILED', 'UNRESOLVED', 'DENIED'];
          if (terminalStatuses.includes(nextAction.status)) {
            return { visual: 'completed', matchedAction: null, errorDetail: null };
          }
          // Next step exists but is still pending — wait period hasn't elapsed
          return { visual: 'waiting', matchedAction: null, errorDetail: null };
        }
      }
      // Check if the previous actionable step is done — if so, this wait is active
      const prevActionableIdx = [...actionableIndices].reverse().find(ai => ai < stepIdx);
      if (prevActionableIdx !== undefined) {
        const prevAction = actionByStepNumber.get(steps[prevActionableIdx].step_number)
          ?? actionByTypeFallback.get(prevActionableIdx);
        if (prevAction && ['SUCCEEDED', 'FAILED', 'PENDING_APPROVAL'].includes(prevAction.status)) {
          return { visual: 'waiting', matchedAction: null, errorDetail: null };
        }
      }
      return { visual: 'upcoming', matchedAction: null, errorDetail: null };
    }

    // Actionable step — determine visual from matched action
    if (!matched) {
      if (step.status === 'SKIPPED') return { visual: 'skipped', matchedAction: null, errorDetail: null };
      if (step.status === 'IN_PROGRESS') return { visual: 'current', matchedAction: null, errorDetail: null };
      if (step.status === 'COMPLETED') return { visual: 'completed', matchedAction: null, errorDetail: null };
      if (step.status === 'FAILED') return { visual: 'failed', matchedAction: null, errorDetail: null };
      return { visual: 'upcoming', matchedAction: null, errorDetail: null };
    }

    // We have a matched action — derive from its status
    if (matched.status === 'FAILED' || matched.status === 'DENIED') {
      const err = matched.outcome && typeof matched.outcome === 'object'
        ? (matched.outcome as Record<string, unknown>).error as string | undefined
        : undefined;
      return {
        visual: 'failed',
        matchedAction: matched,
        errorDetail: err || (matched.status === 'DENIED' ? 'Denied by reviewer' : 'Action failed'),
      };
    }
    if (matched.status === 'UNRESOLVED') {
      return { visual: 'escalated', matchedAction: matched, errorDetail: null };
    }
    if (matched.status === 'PENDING_APPROVAL') {
      return { visual: 'pending', matchedAction: matched, errorDetail: null };
    }
    if (matched.status === 'SUCCEEDED') {
      return { visual: 'completed', matchedAction: matched, errorDetail: null };
    }
    // SCHEDULED, EXECUTING
    return { visual: 'current', matchedAction: matched, errorDetail: null };
  });
}



// ── Helpers ──

function getWaitDeadline(
  delayHours: number,
  precedingAction: MandateSequence['actions'][number] | null | undefined,
): Date | null {
  const timestamp = precedingAction?.executed_at || precedingAction?.scheduled_at;
  if (!timestamp) return null;
  return new Date(new Date(timestamp).getTime() + delayHours * 60 * 60 * 1000);
}

function formatWaitDeadline(deadline: Date): string {
  return deadline.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}


// ── Main component (table page — unchanged) ──

export default function MandateSequencer() {
  const [sequences, setSequences] = useState<MandateSequence[]>([]);
  const [stats, setStats] = useState<MandateStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSeq, setSelectedSeq] = useState<MandateSequence | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = async (): Promise<MandateSequence[]> => {
    setLoading(true);
    try {
      const [seqData, statsData] = await Promise.all([
        fetchMandateSequences({ limit: 100 }),
        fetchMandateStats(),
      ]);
      setSequences(seqData.sequences);
      setStats(statsData);
      return seqData.sequences;
    } catch {
      message.error('Failed to load mandate data');
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleStartSequence = async (eventId: string) => {
    setActionLoading(eventId);
    try {
      await createMandateSequence(eventId);
      message.success('Mandate sequence started');
      await load();
    } catch {
      message.error('Failed to start sequence');
    } finally {
      setActionLoading(null);
    }
  };

  const handleAdvance = async (eventId: string) => {
    setActionLoading(eventId);
    try {
      await advanceMandateSequence(eventId);
      message.success('Sequence advanced');
      const freshSequences = await load();
      const updated = freshSequences.find(s => s.event_id === eventId);
      if (updated) setSelectedSeq(updated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to advance';
      message.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleApproveEmail = async (seq: MandateSequence, actionId: string) => {
    const pendingAction = seq.actions.find(a => a.id === actionId && a.status === 'PENDING_APPROVAL');
    if (!pendingAction) throw new Error('This email is no longer awaiting approval');
    setActionLoading(seq.event_id);
    try {
      await approveEmail(pendingAction.id);
      message.success('Email approved and sent');
      const freshSequences = await load();
      const updated = freshSequences.find(s => s.event_id === seq.event_id);
      if (updated) setSelectedSeq(updated);
    } catch {
      message.error('Failed to approve email');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDenyEmail = async (seq: MandateSequence, actionId: string) => {
    const pendingAction = seq.actions.find(a => a.id === actionId && a.status === 'PENDING_APPROVAL');
    if (!pendingAction) throw new Error('This email is no longer awaiting approval');
    setActionLoading(seq.event_id);
    try {
      await denyEmail(pendingAction.id);
      message.info('Email denied');
      const freshSequences = await load();
      const updated = freshSequences.find(s => s.event_id === seq.event_id);
      if (updated) setSelectedSeq(updated);
    } catch {
      message.error('Failed to deny email');
    } finally {
      setActionLoading(null);
    }
  };

  const openDrawer = (seq: MandateSequence) => {
    setSelectedSeq(seq);
    setDrawerOpen(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-[15px] font-semibold text-[#1b1f2b] m-0">Mandate Retry Sequencer</h1>
          <p className="text-[13px] text-[#7b8294] m-0 mt-1">
            NPCI-compliant multi-step recovery sequences for mandate failures
          </p>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={load}
          size="small"
          className="text-[13px]"
        >
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Mandates"
            value={stats.total_mandate_events}
            sub={`₹${(stats.total_amount_paise / 100).toLocaleString('en-IN')} at risk`}
            color="#528FF0"
          />
          <StatCard
            label="Retryable"
            value={stats.retryable_count}
            sub="Can attempt recovery"
            color="#22c55e"
          />
          <StatCard
            label="Non-Retryable"
            value={stats.non_retryable_count}
            sub="Requires re-authorization"
            color="#ef4444"
          />
          <StatCard
            label="Sub-Types"
            value={Object.keys(stats.by_sub_type).length}
            sub="Distinct failure modes"
            color="#8b5cf6"
          />
        </div>
      )}

      {/* Sub-type breakdown */}
      {stats && Object.keys(stats.by_sub_type).length > 0 && (
        <div className="border border-[#e5e8ec] rounded-lg p-5 mb-6">
          <h3 className="text-[13px] font-semibold text-[#1b1f2b] m-0 mb-3">Failure Sub-Type Breakdown</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.by_sub_type).map(([key, val]) => (
              <div
                key={key}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#e5e8ec] bg-[#fafafa]"
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: SUB_TYPE_COLORS[key] || '#9ca3af' }}
                />
                <span className="text-[12px] font-medium text-[#1b1f2b]">{val.label}</span>
                <span className="text-[12px] font-bold text-[#1b1f2b]">{val.count}</span>
                {val.retryable ? (
                  <Tag color="green" className="text-[10px] m-0 leading-tight">Retryable</Tag>
                ) : (
                  <Tag color="red" className="text-[10px] m-0 leading-tight">No Retry</Tag>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sequences Table */}
      {sequences.length === 0 ? (
        <Empty description="No mandate failures found" />
      ) : (
        <div className="border border-[#e5e8ec] rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#f8fafc] text-[#64748b] text-left">
                <th className="px-4 py-3 font-semibold">Transaction</th>
                <th className="px-4 py-3 font-semibold">Sub-Type</th>
                <th className="px-4 py-3 font-semibold">Amount</th>
                <th className="px-4 py-3 font-semibold">Progress</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((seq) => {
                const statusInfo = deriveSequenceStatus(seq);
                const progress = seq.total_steps > 0
                  ? Math.round(((seq.current_step - 1) / seq.total_steps) * 100)
                  : 0;

                return (
                  <tr
                    key={seq.event_id}
                    className="border-t border-[#e5e8ec] hover:bg-[#f8fafc] cursor-pointer transition-colors"
                    onClick={() => openDrawer(seq)}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#1b1f2b]">
                        {seq.transaction_id?.slice(0, 16) || seq.event_id.slice(0, 12)}
                      </div>
                      <div className="text-[11px] text-[#7b8294]">{seq.decline_code}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Tag
                        className="text-[11px] m-0"
                        style={{
                          color: '#fff',
                          backgroundColor: SUB_TYPE_COLORS[seq.sub_type] || '#9ca3af',
                          border: 'none',
                        }}
                      >
                        {seq.sub_type_label}
                      </Tag>
                      {seq.retryable && (
                        <span className="ml-1.5 text-[10px] text-[#22c55e] font-medium">Retryable</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-[#1b1f2b]">
                      ₹{(seq.amount_paise / 100).toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Progress
                          percent={statusInfo.status === 'completed' ? 100 : progress}
                          size="small"
                          showInfo={false}
                          strokeColor={
                            statusInfo.status === 'completed' ? '#15803d' :
                            statusInfo.status === 'failed' || statusInfo.status === 'blocked' ? '#b91c1c' :
                            '#1b1f2b'
                          }
                          className="w-20 m-0"
                        />
                        <span className="text-[11px] text-[#7b8294]">
                          {statusInfo.status === 'completed' ? 'Done' :
                           statusInfo.status === 'not_started' ? '—' :
                           `${seq.current_step}/${seq.total_steps}`}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1" style={{ color: statusInfo.color }}>
                        {statusInfo.icon}
                        <span className="text-[12px]">{statusInfo.label}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <RightOutlined className="text-[10px] text-[#c4cdd5]" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Drawer */}
      <Drawer
        title={null}
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={520}
        styles={{ body: { padding: 0 } }}
      >
        {selectedSeq && (
          <SequenceDetail
            seq={selectedSeq}
            onAdvance={handleAdvance}
            onStart={handleStartSequence}
            onApproveEmail={handleApproveEmail}
            onDenyEmail={handleDenyEmail}
            loading={actionLoading}
          />
        )}
      </Drawer>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  return (
    <div className="border border-[#e5e8ec] rounded-lg p-5 bg-white">
      <div className="text-[13px] font-semibold text-[#7b8294] mb-2">{label}</div>
      <div className="text-[28px] font-extrabold" style={{ color }}>{value}</div>
      <div className="text-[12px] text-[#7b8294] mt-1">{sub}</div>
    </div>
  );
}


// ═══════════════════════════════════════════════
// Detail Drawer
// ═══════════════════════════════════════════════

function SequenceDetail({
  seq,
  onAdvance,
  onStart,
  onApproveEmail,
  onDenyEmail,
  loading,
}: {
  seq: MandateSequence;
  onAdvance: (eventId: string) => void;
  onStart: (eventId: string) => void;
  onApproveEmail: (seq: MandateSequence, actionId: string) => Promise<void>;
  onDenyEmail: (seq: MandateSequence, actionId: string) => Promise<void>;
  loading: string | null;
}) {
  const statusInfo = deriveSequenceStatus(seq);
  const stepVisuals = deriveAllStepVisuals(seq.steps, seq.actions);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [emailActionState, setEmailActionState] = useState<'idle' | 'loading' | 'approved' | 'denied'>('idle');
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [emailEdits, setEmailEdits] = useState<Record<string, { subject: string; body: string }>>({});
  const [savingEmailId, setSavingEmailId] = useState<string | null>(null);

  // Match previews to the actions attached to actual email steps. This keeps
  // unrelated agent drafts out while supporting older sequence actions that
  // predate the mandate_sequence metadata.
  const emailStepActionIds = new Set(
    seq.steps.flatMap((step, index) => {
      const isEmailStep = step.step_type === 'SEND_REAUTH_EMAIL'
        || step.step_type === 'SEND_MANDATE_RENEWAL_LINK'
        || step.step_type === 'SEND_PRE_DEBIT_NOTIFICATION';
      const actionId = stepVisuals[index]?.matchedAction?.id;
      return isEmailStep && actionId ? [actionId] : [];
    }),
  );
  const emailActions = seq.actions.filter(action => emailStepActionIds.has(action.id));

  const progressPercent = statusInfo.status === 'completed' ? 100
    : seq.total_steps > 0 ? Math.round(((seq.current_step - 1) / seq.total_steps) * 100)
    : 0;

  const progressColor =
    statusInfo.status === 'completed' ? '#15803d' :
    statusInfo.status === 'failed' || statusInfo.status === 'blocked' ? '#b91c1c' :
    statusInfo.status === 'escalated' ? '#b45309' :
    '#1b1f2b';

  const isTerminal = statusInfo.status === 'completed' || statusInfo.status === 'failed';
  const currentStepIndex = seq.steps.findIndex(step => step.step_number === seq.current_step);
  const currentStep = currentStepIndex >= 0 ? seq.steps[currentStepIndex] : null;
  const activeWaitDeadline = currentStep?.step_type === 'WAIT'
    ? getWaitDeadline(currentStep.delay_hours, stepVisuals[currentStepIndex - 1]?.matchedAction)
    : null;
  const isWaitingForCadence = Boolean(activeWaitDeadline && activeWaitDeadline.getTime() > Date.now());

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-5 border-b border-[#e5e8ec]">
        {/* Row 1: sub-type tag + retryability */}
        <div className="flex items-center gap-2 mb-2.5">
          <Tag
            style={{
              color: '#fff',
              backgroundColor: SUB_TYPE_COLORS[seq.sub_type] || '#9ca3af',
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {seq.sub_type_label}
          </Tag>
          {seq.retryable ? (
            <Tag color="green" className="text-[10px]">Retryable</Tag>
          ) : (
            <Tag color="red" className="text-[10px]">No Retry</Tag>
          )}
        </div>

        {/* Row 2: human-readable description */}
        <h2 className="text-[17px] font-semibold text-[#1b1f2b] m-0 leading-snug">
          {seq.description}
        </h2>

        {/* Row 3: amount + customer */}
        <p className="text-[14px] text-[#7b8294] m-0 mt-2">
          ₹{(seq.amount_paise / 100).toLocaleString('en-IN')}
          {seq.customer_email && <> &middot; {seq.customer_email}</>}
        </p>

        {/* Row 4: technical IDs — mono, tertiary */}
        <p className="text-[11px] text-[#b0b7c3] m-0 mt-1 font-mono">
          {seq.transaction_id} &middot; {seq.decline_code}
        </p>

        {/* Row 5: status + next action */}
        <div className="mt-4 flex items-center gap-3">
          <div className="flex items-center gap-1.5" style={{ color: statusInfo.color }}>
            {statusInfo.icon}
            <span className="text-[13px] font-semibold">{statusInfo.label}</span>
          </div>
          {statusInfo.nextAction && (
            <>
              <span className="text-[#d1d5db]">&rarr;</span>
              <span className="text-[12px] text-[#7b8294]">
                Next: {statusInfo.nextAction}
              </span>
            </>
          )}
        </div>

        {/* Row 6: progress bar */}
        <div className="mt-3">
          <Progress
            percent={progressPercent}
            strokeColor={progressColor}
            showInfo={false}
            size="small"
            className="m-0"
          />
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-6 py-5">

        {/* ── Regulatory callout — single, fully visible ── */}
        {seq.regulatory_note && (
          <div className="bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg px-4 py-3 mb-5">
            <div className="flex items-start gap-2.5">
              <SafetyOutlined className="text-[13px] text-[#7b8294] mt-0.5 shrink-0" />
              <div className="text-[12px] text-[#3b4055] leading-relaxed">
                {seq.regulatory_note}
              </div>
            </div>
          </div>
        )}

        {/* ── Recovery Steps ── */}
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-[13px] font-semibold text-[#1b1f2b] m-0">Recovery Steps</h3>
          <span className="text-[11px] text-[#9aa3b2]">{seq.total_steps} steps</span>
        </div>
        <div className="relative">
          {/* The muted rail is always visible; colored segments show the completed/current path. */}
          <div className="absolute left-[14px] top-4 bottom-4 w-px bg-[#e1e7ef]" aria-hidden="true" />
          {seq.steps.map((step, stepIndex) => {
            const { visual, matchedAction, errorDetail } = stepVisuals[stepIndex];
            const isWait = step.step_type === 'WAIT';
            const isLast = stepIndex === seq.steps.length - 1;
            const isDone = visual === 'completed';
            const isFailed = visual === 'failed';
            const isCurrent = visual === 'current';
            const isApproval = visual === 'pending';
            const isEscalated = visual === 'escalated';
            const isSkipped = visual === 'skipped';
            const isExpanded = expandedStep === step.step_number;
            const title = STEP_TYPE_LABELS[step.step_type] || step.description;
            const timestamp = matchedAction?.executed_at
              ? new Date(matchedAction.executed_at).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })
              : null;
            const status = isDone ? 'Completed'
              : isFailed ? 'Needs attention'
              : isEscalated ? 'Escalated'
              : isApproval ? 'Review needed'
              : isCurrent ? 'In progress'
              : isSkipped ? 'Not needed'
              : 'Upcoming';
            const statusClass = isDone ? 'bg-[#ecfdf3] text-[#16803c] ring-[#bbf7d0]'
              : isFailed ? 'bg-[#fef2f2] text-[#c24141] ring-[#fecaca]'
              : isEscalated ? 'bg-[#fff7ed] text-[#b45309] ring-[#fed7aa]'
              : isApproval ? 'bg-[#fffbeb] text-[#a16207] ring-[#fde68a]'
              : isCurrent ? 'bg-[#eaf2ff] text-[#2563c9] ring-[#bfdbfe]'
              : isSkipped ? 'bg-[#f8fafc] text-[#8793a3] ring-[#e2e8f0]'
              : 'bg-[#f8fafc] text-[#718096] ring-[#e2e8f0]';
            const connectorClass = isDone ? 'bg-[#22a55a]'
              : isCurrent ? 'bg-[#528ff0]'
              : 'bg-transparent';

            if (isWait) {
              const waitLabel = step.delay_hours >= 24
                ? `${Math.round(step.delay_hours / 24)} day interval`
                : `${step.delay_hours} hour interval`;
              const deadline = visual === 'waiting'
                ? getWaitDeadline(step.delay_hours, stepVisuals[stepIndex - 1]?.matchedAction)
                : null;
              return (
                <div key={step.step_number} className="relative min-h-10 pl-11 pr-1 py-1.5">
                  {!isLast && <div className={`absolute left-[14px] top-0 bottom-0 w-px ${isDone ? 'bg-[#22a55a]' : 'bg-transparent'}`} aria-hidden="true" />}
                  <div className={`absolute left-[7px] top-3 flex h-[15px] w-[15px] items-center justify-center rounded-full border bg-white ${
                    visual === 'waiting' ? 'border-[#9dbff8] text-[#528ff0]' : 'border-[#d9e1ea] text-[#98a3b3]'
                  }`}>
                    <ClockCircleOutlined className="text-[9px]" />
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium text-[#7b8294]">{waitLabel}</span>
                    {deadline && <span className="text-[#a0a8b5]">until {formatWaitDeadline(deadline)}</span>}
                  </div>
                </div>
              );
            }

            return (
              <div key={step.step_number} className="relative pl-11 pr-1 py-1">
                {!isLast && <div className={`absolute left-[14px] top-8 bottom-[-5px] w-px ${connectorClass}`} aria-hidden="true" />}
                <div className={`absolute left-0 top-3 flex h-7 w-7 items-center justify-center rounded-full border-2 text-[11px] font-semibold shadow-[0_1px_2px_rgba(16,24,40,0.06)] ${
                  isDone ? 'border-[#22a55a] bg-[#22a55a] text-white' :
                  isFailed ? 'border-[#ef4444] bg-[#ef4444] text-white' :
                  isEscalated ? 'border-[#f59e0b] bg-[#f59e0b] text-white' :
                  isCurrent ? 'border-[#528ff0] bg-[#528ff0] text-white ring-4 ring-[#eaf2ff]' :
                  isApproval ? 'border-[#d8a42d] bg-white text-[#b7791f]' :
                  isSkipped ? 'border-[#d4dde7] bg-[#f8fafc] text-[#95a1b1]' :
                  'border-[#cdd6e1] bg-white text-[#7b8796]'
                }`}>
                  {isDone ? <CheckOutlined className="text-[11px]" /> :
                   isFailed ? <CloseCircleFilled className="text-[12px]" /> :
                   isEscalated ? <WarningFilled className="text-[11px]" /> : step.step_number}
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedStep(isExpanded ? null : step.step_number)}
                  className={`group w-full rounded-lg border text-left transition-all duration-200 cursor-pointer ${
                    isCurrent ? 'border-[#bfdbfe] bg-[#f5f9ff] px-3.5 py-3 shadow-[0_1px_2px_rgba(37,99,235,0.08)] hover:border-[#93c5fd] hover:shadow-[0_4px_12px_rgba(37,99,235,0.10)]' :
                    'border-transparent bg-transparent px-3.5 py-2.5 hover:border-[#e5eaf0] hover:bg-[#fafbfd]'
                  }`}
                  aria-expanded={isExpanded}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className={`text-[13px] font-semibold leading-snug ${isFailed ? 'text-[#c24141]' : 'text-[#242b38]'}`}>{title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${statusClass}`}>{status}</span>
                        {timestamp && <span className="text-[11px] text-[#98a3b3]">{timestamp}</span>}
                      </div>
                    </div>
                    <RightOutlined className={`shrink-0 text-[10px] text-[#aab3c0] transition-transform duration-200 group-hover:text-[#607086] ${isExpanded ? 'rotate-90' : ''}`} />
                  </div>
                  {isExpanded && (
                    <div className="mt-2.5 border-t border-[#e8edf3] pt-2.5 text-[12px] leading-relaxed text-[#687385]">
                      <div>{step.description}</div>
                      {errorDetail && <div className="mt-1.5 font-medium text-[#c24141]">{errorDetail}</div>}
                      {matchedAction?.scheduled_at && !timestamp && (
                        <div className="mt-1.5 text-[#8b96a5]">Scheduled for {new Date(matchedAction.scheduled_at).toLocaleString()}</div>
                      )}
                    </div>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* ── Agent Reasoning (collapsible) ── */}
        {seq.agent_reasoning && (
          <div className="mt-5">
            <button
              onClick={() => setReasoningOpen(!reasoningOpen)}
              className="flex items-center gap-1.5 text-[12px] font-medium text-[#7b8294] hover:text-[#3b4055] transition-colors bg-transparent border-none cursor-pointer p-0"
            >
              {reasoningOpen ? <DownOutlined className="text-[9px]" /> : <RightOutlined className="text-[9px]" />}
              Why this sequence?
            </button>
            {reasoningOpen && (
              <div className="mt-2 bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg px-4 py-3">
                <div className="text-[12px] text-[#3b4055] leading-relaxed whitespace-pre-wrap">
                  {seq.agent_reasoning}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Email messages — one receipt/draft per email action ── */}
        {emailActions.length > 0 && (
          <div className="mt-5 pt-5 border-t border-[#f0f0f0]">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-[13px] font-semibold text-[#1b1f2b] m-0">Email messages</h3>
              <span className="text-[11px] text-[#9aa3b2]">{emailActions.length} {emailActions.length === 1 ? 'message' : 'messages'}</span>
            </div>
            <div className="space-y-3">
              {emailActions.map((action, index) => {
                const outcome = action.outcome && typeof action.outcome === 'object'
                  ? action.outcome as Record<string, unknown>
                  : null;
                const storedDraft = (outcome?.email_draft as { subject: string; body: string } | undefined)
                  || (index === 0 ? seq.agent_email_draft || undefined : undefined);
                const draft = emailEdits[action.id] || storedDraft;
                const recipient = (outcome?.customer_email as string | undefined) || seq.customer_email;
                const isPending = action.status === 'PENDING_APPROVAL' && emailActionState === 'idle';
                const isSending = action.status === 'PENDING_APPROVAL' && emailActionState === 'loading';
                const isSent = action.status === 'SUCCEEDED' || (action.status === 'PENDING_APPROVAL' && emailActionState === 'approved');
                const isDenied = action.status === 'DENIED' || (action.status === 'PENDING_APPROVAL' && emailActionState === 'denied');
                const label = isSent ? 'Sent' : isDenied ? 'Denied' : isSending ? 'Sending' : 'Review needed';
                const labelClass = isSent ? 'bg-[#ecfdf3] text-[#16803c] ring-[#bbf7d0]'
                  : isDenied ? 'bg-[#fef2f2] text-[#c24141] ring-[#fecaca]'
                  : 'bg-[#fffbeb] text-[#a16207] ring-[#fde68a]';
                const sentAt = action.executed_at || action.scheduled_at;

                return (
                  <div key={action.id} className="rounded-lg border border-[#e5e8ec] bg-white p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {isSent ? <CheckCircleFilled className="text-[15px] text-[#22a55a]" /> :
                         isDenied ? <CloseCircleFilled className="text-[15px] text-[#ef4444]" /> :
                         <MailOutlined className="text-[15px] text-[#528ff0]" />}
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-[#242b38]">{index === 0 ? 'Recovery email' : `Recovery email ${index + 1}`}</div>
                          {sentAt && <div className="mt-0.5 text-[10px] text-[#9aa3b2]">{new Date(sentAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${labelClass}`}>{label}</span>
                    </div>

                    <div className="mt-3 rounded-md border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] text-[#9aa3b2]">To: {recipient}</div>
                        {isPending && editingEmailId !== action.id && (
                          <button
                            onClick={() => {
                              if (storedDraft) setEmailEdits((current) => ({ ...current, [action.id]: current[action.id] || storedDraft }));
                              setEditingEmailId(action.id);
                            }}
                            disabled={!draft}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#528FF0] bg-transparent border-0 cursor-pointer hover:text-[#2563eb] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <EditOutlined /> Edit email
                          </button>
                        )}
                      </div>
                      {draft && editingEmailId === action.id ? (
                        <div className="mt-2 space-y-2">
                          <input
                            value={draft.subject}
                            onChange={(event) => setEmailEdits((current) => ({
                              ...current,
                              [action.id]: { ...draft, subject: event.target.value },
                            }))}
                            className="w-full rounded-md border border-[#dbe3ec] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#293241] outline-none focus:border-[#528ff0]"
                            aria-label="Email subject"
                          />
                          <textarea
                            value={draft.body}
                            onChange={(event) => setEmailEdits((current) => ({
                              ...current,
                              [action.id]: { ...draft, body: event.target.value },
                            }))}
                            className="min-h-32 w-full resize-y rounded-md border border-[#dbe3ec] bg-white px-2.5 py-2 text-[11.5px] leading-[1.6] text-[#697588] outline-none focus:border-[#528ff0]"
                            aria-label="Email body"
                          />
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setEditingEmailId(null)} className="rounded-md border border-[#dbe3ec] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#687385] cursor-pointer">Cancel</button>
                            <button
                              disabled={savingEmailId === action.id || !draft.subject.trim() || !draft.body.trim()}
                              onClick={async () => {
                                setSavingEmailId(action.id);
                                try {
                                  const saved = await updateEmailDraft(action.id, draft);
                                  setEmailEdits((current) => ({ ...current, [action.id]: { subject: saved.subject, body: saved.body } }));
                                  setEditingEmailId(null);
                                  message.success('Email draft saved');
                                } catch {
                                  message.error('Could not save the email draft');
                                } finally {
                                  setSavingEmailId(null);
                                }
                              }}
                              className="rounded-md border-0 bg-[#1b1f2b] px-2.5 py-1 text-[11px] font-semibold text-white cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                            >{savingEmailId === action.id ? 'Saving…' : 'Save changes'}</button>
                          </div>
                        </div>
                      ) : draft ? (
                        <>
                          <div className="mt-1 text-[12px] font-semibold text-[#293241]">{draft.subject}</div>
                          <div className="mt-2 border-t border-[#edf0f3] pt-2 text-[11.5px] leading-[1.6] whitespace-pre-line text-[#697588]">{draft.body}</div>
                        </>
                      ) : (
                        <div className="mt-1 text-[11.5px] text-[#7b8294]">Message copy is not available yet.</div>
                      )}
                    </div>

                    {isPending && (
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={async () => {
                            setEmailActionState('loading');
                            try {
                              await onApproveEmail(seq, action.id);
                              setEmailActionState('approved');
                            } catch {
                              setEmailActionState('idle');
                            }
                          }}
                          className="flex-1 rounded-md border-0 bg-[#1b1f2b] px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer hover:opacity-90"
                        >Approve & Send</button>
                        <button
                          onClick={async () => {
                            setEmailActionState('loading');
                            try {
                              await onDenyEmail(seq, action.id);
                              setEmailActionState('denied');
                            } catch {
                              setEmailActionState('idle');
                            }
                          }}
                          className="flex-1 rounded-md border border-[#e5e8ec] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#c24141] cursor-pointer hover:bg-[#fef2f2]"
                        >Deny</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky footer ── */}
      {!isTerminal && statusInfo.status !== 'awaiting_approval' && (
        <div className="border-t border-[#e5e8ec] bg-white shrink-0">
          {statusInfo.status === 'escalated' ? (
            <div className="flex items-center gap-2 text-[13px] text-[#92400e] px-6 py-4">
              <WarningFilled className="text-[#f59e0b]" />
              <span>Escalated — awaiting human review</span>
            </div>
          ) : (
            <div className="flex gap-2 px-6 py-4">
              <Button
                type="primary"
                icon={statusInfo.status === 'not_started' ? <PlayCircleOutlined /> : <ArrowRightOutlined />}
                loading={loading === seq.event_id}
                disabled={isWaitingForCadence}
                onClick={() => statusInfo.status === 'not_started' ? onStart(seq.event_id) : onAdvance(seq.event_id)}
                className="flex-1"
              >
                {statusInfo.status === 'not_started'
                  ? 'Start Recovery Sequence'
                  : isWaitingForCadence && activeWaitDeadline
                    ? `Waiting until ${formatWaitDeadline(activeWaitDeadline)}`
                  : `Advance — ${statusInfo.nextAction || 'Next step'}`}
              </Button>
              {statusInfo.status === 'blocked' ? (
                <Tooltip title="Retry the failed step">
                  <Button
                    icon={<UndoOutlined />}
                    onClick={() => onAdvance(seq.event_id)}
                    loading={loading === seq.event_id}
                  >
                    Retry step
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Terminal states: allow manual retry or reopen */}
      {isTerminal && (
        <div className="px-6 py-4 border-t border-[#e5e8ec] bg-white shrink-0">
          <div className="flex gap-2">
            {statusInfo.status === 'failed' && (
              <Button
                icon={<UndoOutlined />}
                onClick={() => onAdvance(seq.event_id)}
                loading={loading === seq.event_id}
                className="flex-1"
              >
                Retry manually
              </Button>
            )}
            <Button
              icon={<CheckOutlined />}
              onClick={() => message.info('Marked as resolved')}
              className={statusInfo.status === 'failed' ? '' : 'flex-1'}
            >
              Mark resolved
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
