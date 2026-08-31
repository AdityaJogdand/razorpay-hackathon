import { useState, useEffect } from 'react';
import { Drawer, Spin, Empty, Tag, Button, Progress, Tooltip, message } from 'antd';
import {
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
} from '@ant-design/icons';
import {
  fetchMandateSequences,
  fetchMandateStats,
  createMandateSequence,
  advanceMandateSequence,
  approveEmail,
  denyEmail,
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

const ACTION_TYPE_LABELS: Record<string, string> = {
  REAUTH_REQUEST: 'Re-auth email',
  CONTACT_EMAIL: 'Email sent',
  RETRY: 'Payment retry',
  ESCALATE_HUMAN: ESCALATE_LABEL,
};

const ACTION_STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: 'Sent',
  FAILED: 'Failed',
  PENDING_APPROVAL: 'Awaiting approval',
  SCHEDULED: 'Scheduled',
  EXECUTING: 'Executing',
  SUPPRESSED: 'Suppressed',
  UNRESOLVED: 'Escalated',
  DENIED: 'Denied',
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

  if (actions.length === 0) {
    const firstStep = steps[0];
    return {
      status: 'not_started',
      label: 'Not started',
      color: '#7b8294',
      icon: <ExclamationCircleOutlined className="text-[14px]" />,
      nextAction: firstStep ? STEP_TYPE_LABELS[firstStep.step_type] || firstStep.description : null,
    };
  }

  const hasPending = actions.some(a => a.status === 'PENDING_APPROVAL');
  const hasUnresolved = actions.some(a => a.status === 'UNRESOLVED');
  const allTerminal = actions.every(a =>
    ['SUCCEEDED', 'FAILED', 'DENIED', 'SUPPRESSED', 'UNRESOLVED'].includes(a.status)
  );
  const lastAction = actions[actions.length - 1];

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

  if (current_step > total_steps && allTerminal) {
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

type StepVisual = 'completed' | 'current' | 'pending' | 'upcoming' | 'failed' | 'escalated' | 'waiting';

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

  // Positional fallback
  const actionByPosition = new Map<number, MandateSequence['actions'][number]>();
  actionableIndices.forEach((stepIdx, actionIdx) => {
    if (actionIdx < actions.length) {
      actionByPosition.set(stepIdx, actions[actionIdx]);
    }
  });

  return steps.map((step, stepIdx) => {
    const isWait = step.step_type === 'WAIT';

    // Try explicit mapping first, then positional
    const matched = actionByStepNumber.get(step.step_number) ?? actionByPosition.get(stepIdx) ?? null;

    if (isWait) {
      if (step.status === 'COMPLETED') return { visual: 'completed', matchedAction: null, errorDetail: null };
      if (step.status === 'IN_PROGRESS') return { visual: 'waiting', matchedAction: null, errorDetail: null };
      // Only mark WAIT as completed if the next actionable step's action is in a terminal state
      // (not just PENDING_APPROVAL — that means the advance skipped the wait)
      const nextActionableIdx = actionableIndices.find(ai => ai > stepIdx);
      if (nextActionableIdx !== undefined) {
        const nextAction = actionByStepNumber.get(steps[nextActionableIdx].step_number)
          ?? actionByPosition.get(nextActionableIdx);
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
          ?? actionByPosition.get(prevActionableIdx);
        if (prevAction && ['SUCCEEDED', 'FAILED', 'PENDING_APPROVAL'].includes(prevAction.status)) {
          return { visual: 'waiting', matchedAction: null, errorDetail: null };
        }
      }
      return { visual: 'upcoming', matchedAction: null, errorDetail: null };
    }

    // Actionable step — determine visual from matched action
    if (!matched) {
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

const STEP_VISUAL_NODE: Record<StepVisual, { bg: string; text: string; connector: string; icon: React.ReactNode }> = {
  completed: {
    bg: 'bg-[#22c55e]', text: 'text-white', connector: 'bg-[#86efac]',
    icon: <CheckCircleFilled />,
  },
  current: {
    bg: 'bg-[#528FF0]', text: 'text-white', connector: 'bg-[#e5e8ec]',
    icon: <PlayCircleOutlined />,
  },
  pending: {
    bg: 'bg-white border-2 border-[#c4cdd5]', text: 'text-[#7b8294]', connector: 'bg-[#e5e8ec]',
    icon: <ClockCircleOutlined />,
  },
  upcoming: {
    bg: 'bg-[#f1f5f9]', text: 'text-[#94a3b8]', connector: 'bg-[#e5e8ec]',
    icon: null,
  },
  failed: {
    bg: 'bg-[#ef4444]', text: 'text-white', connector: 'bg-[#fecaca]',
    icon: <CloseCircleFilled />,
  },
  escalated: {
    bg: 'bg-[#f59e0b]', text: 'text-white', connector: 'bg-[#fde68a]',
    icon: <WarningFilled />,
  },
  waiting: {
    bg: 'bg-[#f1f5f9]', text: 'text-[#94a3b8]', connector: 'bg-[#e5e8ec]',
    icon: <ClockCircleOutlined />,
  },
};

// Step description text color by visual state
const STEP_TEXT_COLOR: Record<StepVisual, string> = {
  completed: 'text-[#1b1f2b]',
  current: 'text-[#1b1f2b]',
  pending: 'text-[#1b1f2b]',
  upcoming: 'text-[#94a3b8]',
  failed: 'text-[#ef4444]',
  escalated: 'text-[#92400e]',
  waiting: 'text-[#94a3b8]',
};


// ── Helpers ──

/** Compute a deadline date from the most recent action timestamp + delay hours. */
function computeWaitDeadline(
  delayHours: number,
  stepIndex: number,
  steps: MandateSequenceStep[],
  actions: MandateSequence['actions'],
): string | null {
  // Find the most recent action that precedes this wait step
  // Walk backward from this step to find the last actionable step's action
  let precedingActionTime: string | null = null;

  // Try the latest action's executed_at or scheduled_at
  for (let i = actions.length - 1; i >= 0; i--) {
    const t = actions[i].executed_at || actions[i].scheduled_at;
    if (t) { precedingActionTime = t; break; }
  }

  if (!precedingActionTime) return null;

  const base = new Date(precedingActionTime);
  const deadline = new Date(base.getTime() + delayHours * 60 * 60 * 1000);
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

  const load = async () => {
    setLoading(true);
    try {
      const [seqData, statsData] = await Promise.all([
        fetchMandateSequences({ limit: 100 }),
        fetchMandateStats(),
      ]);
      setSequences(seqData.sequences);
      setStats(statsData);
    } catch {
      message.error('Failed to load mandate data');
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
      await load();
      if (selectedSeq?.event_id === eventId) {
        const updated = sequences.find(s => s.event_id === eventId);
        if (updated) setSelectedSeq(updated);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to advance';
      message.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleApproveEmail = async (seq: MandateSequence) => {
    const pendingAction = seq.actions.find(a => a.status === 'PENDING_APPROVAL');
    if (!pendingAction) {
      message.warning('No pending email to approve');
      return;
    }
    setActionLoading(seq.event_id);
    try {
      await approveEmail(pendingAction.id);
      message.success('Email approved and sent');
      await load();
      // Refresh drawer data
      const updated = sequences.find(s => s.event_id === seq.event_id);
      if (updated) setSelectedSeq(updated);
    } catch {
      message.error('Failed to approve email');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDenyEmail = async (seq: MandateSequence) => {
    const pendingAction = seq.actions.find(a => a.status === 'PENDING_APPROVAL');
    if (!pendingAction) return;
    setActionLoading(seq.event_id);
    try {
      await denyEmail(pendingAction.id);
      message.info('Email denied');
      await load();
      const updated = sequences.find(s => s.event_id === seq.event_id);
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
                <th className="px-4 py-3 font-semibold">Sequence Progress</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
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
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {statusInfo.status !== 'completed' && statusInfo.status !== 'failed' && (
                        statusInfo.status === 'not_started' ? (
                          <Button
                            size="small"
                            type="primary"
                            icon={<PlayCircleOutlined />}
                            loading={actionLoading === seq.event_id}
                            onClick={() => handleStartSequence(seq.event_id)}
                            className="text-[11px]"
                          >
                            Start
                          </Button>
                        ) : statusInfo.status !== 'awaiting_approval' ? (
                          <Button
                            size="small"
                            icon={<ArrowRightOutlined />}
                            loading={actionLoading === seq.event_id}
                            onClick={() => handleAdvance(seq.event_id)}
                            className="text-[11px]"
                          >
                            Next Step
                          </Button>
                        ) : null
                      )}
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
  onApproveEmail: (seq: MandateSequence) => void;
  onDenyEmail: (seq: MandateSequence) => void;
  loading: string | null;
}) {
  const statusInfo = deriveSequenceStatus(seq);
  const stepVisuals = deriveAllStepVisuals(seq.steps, seq.actions);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(true);

  // Extract pending email draft for preview
  const pendingAction = seq.actions.find(a => a.status === 'PENDING_APPROVAL');
  const pendingOutcome = pendingAction?.outcome && typeof pendingAction.outcome === 'object'
    ? pendingAction.outcome as Record<string, unknown>
    : null;
  const emailDraft = pendingOutcome?.email_draft as { subject: string; body: string } | undefined;
  const customerEmail = pendingOutcome?.customer_email as string | undefined;

  const progressPercent = statusInfo.status === 'completed' ? 100
    : seq.total_steps > 0 ? Math.round(((seq.current_step - 1) / seq.total_steps) * 100)
    : 0;

  const progressColor =
    statusInfo.status === 'completed' ? '#15803d' :
    statusInfo.status === 'failed' || statusInfo.status === 'blocked' ? '#b91c1c' :
    statusInfo.status === 'escalated' ? '#b45309' :
    '#1b1f2b';

  const isTerminal = statusInfo.status === 'completed' || statusInfo.status === 'failed';

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

        {/* ── Recovery Sequence (primary visual) ── */}
        <h3 className="text-[13px] font-semibold text-[#1b1f2b] m-0 mb-4">Recovery Sequence</h3>
        <div>
          {seq.steps.map((step, i) => {
            const { visual, matchedAction, errorDetail } = stepVisuals[i];
            const nodeConfig = STEP_VISUAL_NODE[visual];
            const isLast = i === seq.steps.length - 1;
            const isWait = step.step_type === 'WAIT';
            const stepLabel = STEP_TYPE_LABELS[step.step_type] || step.step_type;
            const textColor = STEP_TEXT_COLOR[visual];

            // Compute wait deadline for active/upcoming waits
            let waitDeadline: string | null = null;
            if (isWait && (visual === 'waiting' || visual === 'current')) {
              waitDeadline = computeWaitDeadline(step.delay_hours, i, seq.steps, seq.actions);
            }

            return (
              <div key={step.step_number} className="flex gap-3">
                {/* Node + connector */}
                <div className="flex flex-col items-center w-6 shrink-0">
                  <div className={`${isWait ? 'w-[18px] h-[18px] mt-[3px]' : 'w-6 h-6'} rounded-full flex items-center justify-center text-[11px] shrink-0 ${nodeConfig.bg} ${nodeConfig.text}`}>
                    {nodeConfig.icon || <span className="font-semibold text-[10px]">{step.step_number}</span>}
                  </div>
                  {!isLast && (
                    <div className={`w-0.5 flex-1 min-h-[20px] ${nodeConfig.connector}`} />
                  )}
                </div>

                {/* Content */}
                <div className={`flex-1 ${isLast ? 'pb-0' : 'pb-3'} min-w-0`}>
                  {isWait ? (
                    // Wait step — compact, shows deadline when active
                    <div className="pt-[2px]">
                      <span className={`text-[12px] italic ${textColor}`}>
                        {visual === 'completed'
                          ? `Waited ${step.delay_hours >= 24 ? `${Math.round(step.delay_hours / 24)}d` : `${step.delay_hours}h`}`
                          : visual === 'waiting' || visual === 'current'
                            ? waitDeadline
                              ? `Paused — resumes ${waitDeadline}`
                              : `Paused — awaiting ${step.delay_hours >= 24 ? `${Math.round(step.delay_hours / 24)} day${Math.round(step.delay_hours / 24) > 1 ? 's' : ''}` : `${step.delay_hours}h`}`
                            : step.delay_hours >= 24
                              ? `Wait ${Math.round(step.delay_hours / 24)} day${Math.round(step.delay_hours / 24) > 1 ? 's' : ''}`
                              : `Wait ${step.delay_hours}h`
                        }
                      </span>
                      {step.regulatory_basis && (
                        <Tooltip title={step.regulatory_basis}>
                          <SafetyOutlined className="ml-1.5 text-[10px] text-[#b0b7c3] cursor-help" />
                        </Tooltip>
                      )}
                    </div>
                  ) : (
                    // Actionable step
                    <>
                      {/* Description — primary text */}
                      <div className={`text-[13px] font-medium leading-snug ${textColor}`}>
                        {step.description}
                      </div>

                      {/* Step type label — secondary */}
                      <div className="text-[11px] text-[#b0b7c3] mt-0.5">{stepLabel}</div>

                      {/* Failed step: inline error detail from matched action */}
                      {visual === 'failed' && errorDetail && (
                        <div className="mt-1.5 flex items-start gap-1.5 bg-[#fef2f2] border border-[#fecaca] rounded px-2.5 py-1.5">
                          <CloseCircleFilled className="text-[11px] text-[#ef4444] mt-[1px] shrink-0" />
                          <span className="text-[11px] text-[#991b1b] leading-snug">{errorDetail}</span>
                        </div>
                      )}

                      {/* Failed step: show timestamp from matched action */}
                      {visual === 'failed' && matchedAction?.executed_at && (
                        <div className="text-[10px] text-[#b0b7c3] mt-1">
                          Failed {new Date(matchedAction.executed_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </div>
                      )}

                      {/* Completed step: show timestamp from matched action */}
                      {visual === 'completed' && matchedAction?.executed_at && (
                        <div className="text-[10px] text-[#b0b7c3] mt-1">
                          {new Date(matchedAction.executed_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </div>
                      )}

                      {/* Escalated step: inline note */}
                      {visual === 'escalated' && (
                        <div className="mt-1.5 flex items-center gap-1.5 bg-[#fffbeb] border border-[#fde68a] rounded px-2.5 py-1.5">
                          <WarningFilled className="text-[11px] text-[#f59e0b] shrink-0" />
                          <span className="text-[11px] text-[#92400e] leading-snug">Awaiting human review</span>
                        </div>
                      )}

                      {/* Current step with pending approval */}
                      {visual === 'current' && matchedAction?.status === 'PENDING_APPROVAL' && (
                        <div className="mt-1.5 flex items-center gap-1.5 bg-[#f8f9fa] border border-[#e5e8ec] rounded px-2.5 py-1.5">
                          <ClockCircleOutlined className="text-[11px] text-[#7b8294] shrink-0" />
                          <span className="text-[11px] text-[#3b4055] leading-snug">Awaiting approval</span>
                        </div>
                      )}

                      {/* Regulatory note — inline, concise, neutral color */}
                      {step.regulatory_basis && visual !== 'failed' && (
                        <Tooltip title={step.regulatory_basis}>
                          <span className="inline-flex items-center gap-1 text-[10px] text-[#b0b7c3] mt-1 cursor-help">
                            <SafetyOutlined className="text-[9px]" />
                            {step.regulatory_basis.length > 55
                              ? step.regulatory_basis.slice(0, 55) + '...'
                              : step.regulatory_basis}
                          </span>
                        </Tooltip>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Execution Log (compact, secondary) ── */}
        {seq.actions.length > 0 && (
          <div className="mt-6 pt-5 border-t border-[#f1f5f9]">
            <h3 className="text-[11px] font-semibold text-[#b0b7c3] uppercase tracking-wider m-0 mb-2">
              Execution Log
            </h3>
            <div className="space-y-px">
              {seq.actions.map((action) => (
                <div
                  key={action.id}
                  className="flex items-center justify-between px-2.5 py-1.5 text-[11px]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <ActionStatusDot status={action.status} />
                    <span className="text-[#3b4055] font-medium truncate">
                      {ACTION_TYPE_LABELS[action.action_type] || action.action_type}
                    </span>
                    <span className="text-[#b0b7c3] shrink-0">
                      {(action.executed_at || action.scheduled_at) && new Date(action.executed_at || action.scheduled_at!).toLocaleString(undefined, {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <span className={`font-medium shrink-0 ml-2 ${
                    action.status === 'SUCCEEDED' ? 'text-[#22c55e]' :
                    action.status === 'FAILED' || action.status === 'DENIED' ? 'text-[#ef4444]' :
                    action.status === 'UNRESOLVED' ? 'text-[#f59e0b]' :
                    'text-[#7b8294]'
                  }`}>
                    {ACTION_STATUS_LABELS[action.status] || action.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

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
      </div>

      {/* ── Sticky footer ── */}
      {!isTerminal && (
        <div className="border-t border-[#e5e8ec] bg-white shrink-0">
          {statusInfo.status === 'awaiting_approval' ? (
            <div>
              {emailDraft && (
                <div className="mx-6 mt-4 mb-2 bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg">
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                    onClick={() => setEmailPreviewOpen(v => !v)}
                  >
                    <MailOutlined className="text-[13px] text-[#7b8294]" />
                    <span className="text-[12px] font-semibold text-[#1b1f2b]">Email Preview</span>
                    {customerEmail && (
                      <span className="text-[11px] text-[#7b8294]">
                        — {customerEmail.replace(/(.{2}).*(@.*)/, '$1***$2')}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-[#7b8294]">
                      {emailPreviewOpen ? <DownOutlined /> : <RightOutlined />}
                    </span>
                  </div>
                  {emailPreviewOpen && (
                    <div className="border-t border-[#e5e8ec]">
                      <div className="bg-white px-3 py-2 border-b border-[#e5e8ec]">
                        <span className="text-[12px] font-medium text-[#1b1f2b]">{emailDraft.subject}</span>
                      </div>
                      <div className="bg-white px-3 py-2.5 text-[12px] text-[#3b4055] leading-relaxed whitespace-pre-wrap max-h-[120px] overflow-y-auto rounded-b-lg">
                        {emailDraft.body}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3 px-6 py-3">
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={loading === seq.event_id}
                  onClick={() => onApproveEmail(seq)}
                  style={{ flex: 1, backgroundColor: '#1b1f2b', borderColor: '#1b1f2b' }}
                >
                  Approve & Send
                </Button>
                <Button
                  danger
                  ghost
                  icon={<CloseCircleFilled />}
                  loading={loading === seq.event_id}
                  onClick={() => onDenyEmail(seq)}
                  style={{ flex: 1 }}
                >
                  Deny
                </Button>
              </div>
            </div>
          ) : statusInfo.status === 'escalated' ? (
            <div className="flex items-center gap-2 text-[13px] text-[#92400e]">
              <WarningFilled className="text-[#f59e0b]" />
              <span>Escalated — awaiting human review</span>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="primary"
                icon={statusInfo.status === 'not_started' ? <PlayCircleOutlined /> : <ArrowRightOutlined />}
                loading={loading === seq.event_id}
                onClick={() => statusInfo.status === 'not_started' ? onStart(seq.event_id) : onAdvance(seq.event_id)}
                className="flex-1"
              >
                {statusInfo.status === 'not_started'
                  ? 'Start Recovery Sequence'
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
              ) : statusInfo.status !== 'not_started' ? (
                <Tooltip title="Close this sequence without further action">
                  <Button
                    icon={<CheckOutlined />}
                    onClick={() => message.info('Marked as resolved')}
                  >
                    Mark resolved
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

function ActionStatusDot({ status }: { status: string }) {
  const color =
    status === 'SUCCEEDED' ? '#22c55e' :
    status === 'FAILED' || status === 'DENIED' ? '#ef4444' :
    status === 'UNRESOLVED' ? '#f59e0b' :
    '#9ca3af';

  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}
