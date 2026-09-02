import { useState, useEffect } from 'react';
import { Spin, Tag, Drawer, Tooltip, message } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, LoadingOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { fetchRecurringFailures, triggerSubscriptionRecovery, type SubscriptionFailure, type SubscriptionStats } from '../api/dashboard';

const DIAGNOSIS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  structural: { color: '#dc2626', bg: '#fef2f2', label: 'Structural' },
  chronic: { color: '#d97706', bg: '#fffbeb', label: 'Chronic' },
  temporary: { color: '#528FF0', bg: '#eff6ff', label: 'Temporary' },
};

const URGENCY_TAG: Record<string, string> = {
  high: 'red',
  medium: 'orange',
  low: 'green',
};

// Primary recovery action definitions
const PRIMARY_ACTIONS: Record<string, { label: string; description: string }> = {
  REQUEST_CARD_UPDATE: { label: 'Request Card Update', description: 'Customer must update their expired or invalid card' },
  RE_AUTH_MANDATE: { label: 'Re-authorize Mandate', description: 'Customer must set up a new payment mandate' },
  ESCALATE_TO_SUPPORT: { label: 'Escalate to Support', description: 'Manual intervention required after repeated failures' },
  SEND_PAYMENT_LINK: { label: 'Send Payment Link', description: 'Direct payment link to bypass failing billing path' },
  AUTO_RETRY: { label: 'Auto Retry', description: 'Automatic retry via agent pipeline' },
};

// Supporting outreach channel mapping
const OUTREACH_FOR_ACTION: Record<string, string> = {
  REQUEST_CARD_UPDATE: 'Payment-method update email',
  RE_AUTH_MANDATE: 'Mandate re-authorization email',
  SEND_PAYMENT_LINK: 'Payment link email',
  ESCALATE_TO_SUPPORT: 'Support ticket escalation',
  AUTO_RETRY: 'Scheduled gateway retry',
};

// Explicit action states matching backend state
const ACTION_EXPLICIT_STATUS: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  RECOMMENDED: { label: 'Recommended', color: '#4b5563', bg: '#f3f4f6', icon: ExclamationCircleFilled },
  SCHEDULED: { label: 'Scheduled', color: '#2563eb', bg: '#eff6ff', icon: LoadingOutlined },
  TRIGGERED: { label: 'Triggered', color: '#7c3aed', bg: '#f5f3ff', icon: LoadingOutlined },
  COMPLETED: { label: 'Completed', color: '#16a34a', bg: '#f0fdf4', icon: CheckCircleFilled },
  SUCCEEDED: { label: 'Completed', color: '#16a34a', bg: '#f0fdf4', icon: CheckCircleFilled },
  FAILED: { label: 'Failed', color: '#dc2626', bg: '#fef2f2', icon: CloseCircleFilled },
};

export default function SubscriptionRecovery() {
  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState<SubscriptionFailure[]>([]);
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [selectedSub, setSelectedSub] = useState<SubscriptionFailure | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [triggeringAction, setTriggeringAction] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const data = await fetchRecurringFailures();
      setSubscriptions(data.subscriptions);
      setStats(data.stats);
    } catch {
      setSubscriptions([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleTrigger = async (sub: SubscriptionFailure) => {
    const eventId = sub.latest_failure.id;
    const action = sub.recommendation.action;
    if (action === 'AUTO_RETRY') return;
    setTriggeringAction(sub.group_key);
    try {
      const result = await triggerSubscriptionRecovery(eventId, action);
      const statusInfo = ACTION_EXPLICIT_STATUS[result.status] || ACTION_EXPLICIT_STATUS.SCHEDULED;
      message.success(`${sub.recommendation.label}: ${statusInfo.label}`);
      await loadData();
      if (selectedSub?.group_key === sub.group_key) {
        const updated = (await fetchRecurringFailures()).subscriptions.find(s => s.group_key === sub.group_key);
        if (updated) setSelectedSub(updated);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Action failed');
    } finally {
      setTriggeringAction(null);
    }
  };

  const openDetail = (sub: SubscriptionFailure) => {
    setSelectedSub(sub);
    setDrawerOpen(true);
  };

  const renderFlowHierarchy = (sub: SubscriptionFailure) => {
    const isStructural = sub.recommendation.diagnosis === 'structural' || sub.failures.some(f => f.failure_class === 'HARD' || f.failure_class === 'MANDATE');
    const rootCause = sub.latest_failure.decline_reason || (sub.latest_failure.failure_class === 'HARD' ? 'Expired Card' : sub.latest_failure.failure_class === 'MANDATE' ? 'Revoked Mandate' : sub.latest_failure.decline_code);
    const primary = PRIMARY_ACTIONS[sub.recommendation.action] || { label: sub.recommendation.label, description: '' };
    const outreach = OUTREACH_FOR_ACTION[sub.recommendation.action] || 'Email Outreach';

    const steps = [
      { text: `${sub.failure_count} failures`, bg: 'bg-[#f3f4f6]', color: 'text-[#374151]' },
      { text: rootCause, bg: 'bg-[#fef2f2]', color: 'text-[#dc2626]' },
      { text: isStructural ? 'Structural Failure' : `${sub.recommendation.diagnosis.toUpperCase()} Failure`, bg: 'bg-[#fef2f2]', color: 'text-[#dc2626]' },
      { text: sub.recommendation.retryable ? 'Retryable' : 'Not Retryable', bg: sub.recommendation.retryable ? 'bg-[#eff6ff]' : 'bg-[#fef2f2]', color: sub.recommendation.retryable ? 'text-[#2563eb]' : 'text-[#dc2626]' },
      { text: primary.label, bg: 'bg-[#1b1f2b]', color: 'text-white font-medium' },
      { text: outreach, bg: 'bg-[#f3f4f6]', color: 'text-[#4b5563]' },
    ];

    return (
      <div className="flex items-center gap-1 flex-wrap text-[11px] py-1.5 px-2 bg.fafafa border border-[#e5e8ec] rounded-md my-2">
        {steps.map((step, idx) => (
          <div key={idx} className="flex items-center gap-1">
            <span className={`px-2 py-0.5 rounded ${step.bg} ${step.color} whitespace-nowrap`}>
              {step.text}
            </span>
            {idx < steps.length - 1 && (
              <ArrowRightOutlined className="text-[8px] text-[#9ca3af]" />
            )}
          </div>
        ))}
      </div>
    );
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spin size="large" /></div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Subscription Recovery</span>
        <span className="text-[12px] text-[#9ca3af]">Detect recurring payment failures, diagnose root cause, trigger recovery</span>
      </div>

      {/* Stats */}
      <div className="space-y-3 mb-6">
        {/* Revenue at Risk — full width hero */}
        <Tooltip title="Net revenue at risk (total minus recovered)">
          <div className="border border-[#e5e8ec] rounded-lg px-8 py-9 bg-white shadow-xs flex items-center gap-6">
            {(() => {
              const totalAtRisk = stats?.total_at_risk_paise ?? 0;
              const recoveredPaise = subscriptions
                .filter(s => s.triggered_action?.status === 'SUCCEEDED' || s.existing_actions?.some(a => a.status === 'SUCCEEDED'))
                .reduce((sum, s) => sum + s.total_amount_paise, 0);
              const netAtRisk = Math.max(0, totalAtRisk - recoveredPaise);
              const recoveryPct = totalAtRisk > 0 ? Math.round((recoveredPaise / totalAtRisk) * 100) : 0;
              return (
                <div>
                  <div className="text-[13px] text-[#7b8294] font-medium uppercase tracking-wider mb-3">Revenue at Risk</div>
                  <div className="text-[44px] font-extrabold text-[#1b1f2b] leading-none">
                    ₹{(netAtRisk / 100).toLocaleString('en-IN')}
                  </div>
                  <div className="text-[12px] text-[#9ca3af] mt-3">
                    {subscriptions.length} subscription{subscriptions.length !== 1 ? 's' : ''} with recurring failures
                    {recoveredPaise > 0 && (
                      <span className="text-[#22c55e] ml-1.5 font-medium">
                        · ₹{(recoveredPaise / 100).toLocaleString('en-IN')} recovered ({recoveryPct}%)
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </Tooltip>

        {/* Secondary stats — single row */}
        <div className="grid grid-cols-4 gap-3">
          <Tooltip title="Total recurring failure groups (subscriptions with 2+ failed attempts)">
            <div className="border border-[#e5e8ec] rounded-lg p-4 text-center bg-white shadow-xs">
              <div className="text-[24px] font-extrabold text-[#1b1f2b]">{stats?.recurring_groups ?? 0}</div>
              <div className="text-[9px] text-[#9ca3af] uppercase tracking-wider mt-0.5 font-medium">Recurring Groups</div>
            </div>
          </Tooltip>
          <Tooltip title="Groups whose root cause is a permanent failure (expired card, revoked mandate)">
            <div className="border border-[#e5e8ec] rounded-lg p-4 text-center bg-white shadow-xs">
              <div className="text-[24px] font-extrabold text-[#1b1f2b]">{stats?.structural_count ?? 0}</div>
              <div className="text-[9px] text-[#9ca3af] uppercase tracking-wider mt-0.5 font-medium">Structural</div>
            </div>
          </Tooltip>
          <Tooltip title="Groups with 3+ unresolved payment failures">
            <div className="border border-[#e5e8ec] rounded-lg p-4 text-center bg-white shadow-xs">
              <div className="text-[24px] font-extrabold text-[#1b1f2b]">{stats?.chronic_count ?? 0}</div>
              <div className="text-[9px] text-[#9ca3af] uppercase tracking-wider mt-0.5 font-medium">Chronic</div>
            </div>
          </Tooltip>
          <Tooltip title="Recovery actions triggered through agent → guardrail → execution pipeline">
            <div className="border border-[#e5e8ec] rounded-lg p-4 text-center bg-white shadow-xs">
              <div className="text-[24px] font-extrabold text-[#1b1f2b]">{stats?.actions_triggered ?? 0}</div>
              <div className="text-[9px] text-[#9ca3af] uppercase tracking-wider mt-0.5 font-medium">Actions Triggered</div>
            </div>
          </Tooltip>
        </div>
      </div>

      {/* List */}
      <div className="text-[13px] font-semibold text-[#1b1f2b] mb-3">
        Recurring Failure Groups
        <span className="text-[11px] font-normal text-[#9ca3af] ml-2">
          grouped by subscription / instrument + merchant
        </span>
      </div>

      {subscriptions.length === 0 ? (
        <div className="border border-[#e5e8ec] rounded-lg px-5 py-10 text-center bg-white">
          <div className="text-[13px] text-[#9ca3af]">No recurring payment failures detected. Simulate multiple payments with the same email to create a pattern.</div>
        </div>
      ) : (
        <div className="space-y-3 overflow-y-auto flex-1 pr-1">
          {subscriptions.map((sub) => {
            const diag = DIAGNOSIS_STYLE[sub.recommendation.diagnosis] || DIAGNOSIS_STYLE.temporary;
            const primary = PRIMARY_ACTIONS[sub.recommendation.action] || { label: sub.recommendation.label, description: '' };
            const outreachName = OUTREACH_FOR_ACTION[sub.recommendation.action] || 'Email Outreach';
            const isTriggering = triggeringAction === sub.group_key;

            // Compute current explicit action status
            let currentStatus = 'RECOMMENDED';
            if (sub.triggered_action?.status) {
              currentStatus = sub.triggered_action.status;
            } else if (sub.existing_actions.length > 0) {
              currentStatus = sub.existing_actions[0].status;
            }
            const statusObj = ACTION_EXPLICIT_STATUS[currentStatus] || ACTION_EXPLICIT_STATUS.RECOMMENDED;
            const StatusIcon = statusObj.icon;

            return (
              <div
                key={sub.group_key}
                className="border border-[#e5e8ec] bg-white rounded-lg p-4 hover:border-[#c4c9d4] transition-all cursor-pointer shadow-2xs"
                onClick={() => openDetail(sub)}
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-[#1b1f2b]">{sub.customer_email || sub.customer_id}</span>
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded" style={{ color: diag.color, backgroundColor: diag.bg }}>
                      {diag.label} Failure
                    </span>
                    <Tag color={URGENCY_TAG[sub.recommendation.urgency]} className="text-[10px] m-0 font-semibold uppercase">
                      {sub.recommendation.urgency} Urgency
                    </Tag>
                    {!sub.recommendation.retryable && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#fef2f2] text-[#dc2626]">Not Retryable</span>
                    )}
                  </div>
                  <div className="text-[14px] font-extrabold text-[#1b1f2b]">
                    ₹{(sub.total_amount_paise / 100).toLocaleString('en-IN')}
                  </div>
                </div>

                {/* Compact PS Requirement Flow Banner */}
                {renderFlowHierarchy(sub)}

                {/* Card footer details */}
                <div className="flex items-center justify-between pt-2 border-t border-[#f3f4f6]">
                  <div className="text-[11px] text-[#9ca3af] flex items-center gap-2">
                    {sub.subscription_id && (
                      <span className="font-mono bg-[#f3f4f6] text-[#374151] px-1.5 py-0.5 rounded">sub:{sub.subscription_id.slice(0, 14)}</span>
                    )}
                    <span>{sub.instrument_type} · {sub.instrument_token}</span>
                  </div>
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <span className="text-[11px] text-[#9ca3af] mr-1">Outreach: {outreachName}</span>
                    {currentStatus !== 'RECOMMENDED' ? (
                      <span className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold" style={{ color: statusObj.color, backgroundColor: statusObj.bg }}>
                        <StatusIcon />
                        {statusObj.label}
                      </span>
                    ) : sub.recommendation.action !== 'AUTO_RETRY' ? (
                      <button
                        onClick={() => handleTrigger(sub)}
                        disabled={isTriggering}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                          isTriggering
                            ? 'bg-[#e5e8ec] text-[#9ca3af] cursor-not-allowed'
                            : 'bg-[#1b1f2b] text-white hover:bg-[#2d3348]'
                        }`}
                      >
                        {isTriggering ? <><LoadingOutlined /> Triggering...</> : `Trigger ${primary.label}`}
                      </button>
                    ) : (
                      <span className="text-[11px] text-[#9ca3af]">Auto retry scheduled</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Drawer */}
      <Drawer
        title={<span className="font-semibold text-[#1b1f2b]">Subscription Recovery Detail</span>}
        placement="right"
        width={580}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        {selectedSub && (() => {
          const primaryAction = PRIMARY_ACTIONS[selectedSub.recommendation.action] || { label: selectedSub.recommendation.label, description: selectedSub.recommendation.description };
          const outreachName = OUTREACH_FOR_ACTION[selectedSub.recommendation.action] || 'Email Outreach';
          const isTriggering = triggeringAction === selectedSub.group_key;

          let currentStatus = 'RECOMMENDED';
          let actionTimestamp: string | null = null;

          if (selectedSub.triggered_action) {
            currentStatus = selectedSub.triggered_action.status || 'TRIGGERED';
            actionTimestamp = selectedSub.triggered_action.triggered_at;
          } else if (selectedSub.existing_actions.length > 0) {
            const latestAct = selectedSub.existing_actions[0];
            currentStatus = latestAct.status;
            actionTimestamp = latestAct.executed_at;
          }

          const statusObj = ACTION_EXPLICIT_STATUS[currentStatus] || ACTION_EXPLICIT_STATUS.RECOMMENDED;
          const StatusIcon = statusObj.icon;
          const hasTriggeredAction = currentStatus !== 'RECOMMENDED';

          // Chronological ordering (Oldest -> Newest)
          const chronologicalFailures = [...selectedSub.failures].reverse();

          return (
            <div className="space-y-5">
              {/* PS Flow Breadcrumb */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af] mb-1">
                  Recovery Flow Blueprint
                </div>
                {renderFlowHierarchy(selectedSub)}
              </div>

              {/* Diagnosis */}
              <div className="border border-[#e5e8ec] rounded-lg p-4 bg-white">
                <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2 flex items-center justify-between">
                  <span>Diagnosis</span>
                  <span className="text-[11px] text-[#9ca3af]">Root Cause Analysis</span>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  {(() => {
                    const d = DIAGNOSIS_STYLE[selectedSub.recommendation.diagnosis] || DIAGNOSIS_STYLE.temporary;
                    return <span className="text-[12px] font-semibold px-2.5 py-0.5 rounded" style={{ color: d.color, backgroundColor: d.bg }}>{d.label} Failure</span>;
                  })()}
                  <Tag color={URGENCY_TAG[selectedSub.recommendation.urgency]} className="font-semibold uppercase text-[11px]">
                    {selectedSub.recommendation.urgency} Urgency
                  </Tag>
                  {!selectedSub.recommendation.retryable && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[#fef2f2] text-[#dc2626]">
                      Not Retryable
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-[#374151] bg-[#f9fafb] p-3 rounded border border-[#f0f0f0] leading-relaxed font-medium">
                  {selectedSub.recommendation.description}
                </div>
              </div>

              {/* Subscription Context */}
              <div className="border border-[#e5e8ec] rounded-lg p-4 bg-white">
                <div className="text-[13px] font-semibold text-[#1b1f2b] mb-3">Subscription Context</div>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <div><span className="text-[#9ca3af]">Customer Email:</span> <div className="font-medium text-[#1b1f2b] mt-0.5">{selectedSub.customer_email}</div></div>
                  <div><span className="text-[#9ca3af]">Customer ID:</span> <div className="font-mono text-[#1b1f2b] mt-0.5">{selectedSub.customer_id.slice(0, 16)}</div></div>
                  <div><span className="text-[#9ca3af]">Instrument:</span> <div className="font-medium text-[#1b1f2b] mt-0.5">{selectedSub.instrument_type} ({selectedSub.instrument_token})</div></div>
                  {selectedSub.subscription_id && (
                    <div><span className="text-[#9ca3af]">Subscription ID:</span> <div className="font-mono text-[#1b1f2b] mt-0.5">{selectedSub.subscription_id}</div></div>
                  )}
                  <div><span className="text-[#9ca3af]">Unresolved Failures:</span> <div className="text-[#dc2626] font-bold mt-0.5">{selectedSub.failure_count} attempts</div></div>
                  <div><span className="text-[#9ca3af]">Total Revenue at Risk:</span> <div className="text-[#1b1f2b] font-bold mt-0.5">₹{(selectedSub.total_amount_paise / 100).toLocaleString('en-IN')}</div></div>
                </div>
              </div>

              {/* Recovery Action (Primary Recovery vs Supporting Outreach) */}
              <div className="border border-[#e5e8ec] rounded-lg p-4 bg-white shadow-2xs">
                <div className="text-[13px] font-semibold text-[#1b1f2b] mb-1">
                  Recovery Action
                </div>
                <div className="text-[11px] text-[#9ca3af] mb-3">
                  Executed via agent → guardrail → execution pipeline with tamper-proof audit ledger
                </div>

                <div className="space-y-3">
                  {/* Primary Recovery */}
                  <div className="border border-[#e5e8ec] rounded-lg p-3 bg-white">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af] mb-1">
                      Primary Recovery Action
                    </div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[14px] font-bold text-[#1b1f2b]">
                        {primaryAction.label}
                      </span>
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[#fef2f2] text-[#dc2626]">
                        Required Action
                      </span>
                    </div>
                    <div className="text-[12px] text-[#4b5563] mb-3 leading-relaxed">
                      {primaryAction.description}
                    </div>

                    {!hasTriggeredAction && selectedSub.recommendation.action !== 'AUTO_RETRY' && (
                      <button
                        onClick={() => handleTrigger(selectedSub)}
                        disabled={isTriggering}
                        className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold transition-colors ${
                          isTriggering
                            ? 'bg-[#e5e8ec] text-[#9ca3af] cursor-not-allowed'
                            : 'bg-[#1b1f2b] text-white hover:bg-[#2d3348]'
                        }`}
                      >
                        {isTriggering ? <><LoadingOutlined /> Triggering {primaryAction.label}...</> : `Trigger ${primaryAction.label}`}
                      </button>
                    )}
                  </div>

                  {/* Supporting Outreach */}
                  <div className="border border-[#e5e8ec] rounded-lg p-3 bg-[#fafafa]">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af] mb-1">
                      Supporting Outreach Channel
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[12px] font-semibold text-[#1b1f2b]">
                          {outreachName}
                        </div>
                        <div className="text-[11px] text-[#6b7280] mt-0.5">
                          {selectedSub.recommendation.action === 'REQUEST_CARD_UPDATE' || selectedSub.recommendation.action === 'RE_AUTH_MANDATE'
                            ? 'Delivered via Email Outreach (REAUTH_REQUEST)'
                            : selectedSub.recommendation.action === 'SEND_PAYMENT_LINK'
                            ? 'Delivered via Email Outreach (CONTACT_EMAIL)'
                            : 'Delivered via Support Ticket (ESCALATE_HUMAN)'}
                        </div>
                      </div>
                      <div>
                        <span
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-semibold"
                          style={{ color: statusObj.color, backgroundColor: statusObj.bg }}
                        >
                          <StatusIcon />
                          {statusObj.label}
                        </span>
                      </div>
                    </div>
                    {actionTimestamp && (
                      <div className="text-[11px] text-[#9ca3af] mt-2 pt-2 border-t border-[#e5e8ec]">
                        Action timestamp: {new Date(actionTimestamp).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Failure History - Chronological order with explicit HARD vs SOFT distinction */}
              <div className="border border-[#e5e8ec] rounded-lg p-4 bg-white">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[13px] font-semibold text-[#1b1f2b]">Failure History</div>
                  <div className="text-[11px] font-medium text-[#dc2626] bg-[#fef2f2] px-2 py-0.5 rounded">
                    {selectedSub.failure_count} failures across this subscription
                  </div>
                </div>

                <div className="space-y-2">
                  {chronologicalFailures.map((f, i) => {
                    const isHard = f.failure_class === 'HARD';
                    const isMandate = f.failure_class === 'MANDATE';
                    const isRootCause = isHard || isMandate || (i === chronologicalFailures.length - 1 && selectedSub.recommendation.diagnosis === 'structural');

                    return (
                      <div
                        key={f.id || i}
                        className={`rounded-lg px-4 py-3 border transition-all ${
                          isRootCause
                            ? 'border-[#dc2626] bg-[#fef2f2]/40 shadow-2xs'
                            : 'border-[#e5e8ec] bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold text-[#6b7280]">
                              Attempt #{i + 1} {i === chronologicalFailures.length - 1 ? '(Latest)' : ''}
                            </span>
                            <span className="font-mono text-[10px] text-[#9ca3af]">{f.transaction_id}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isRootCause && (
                              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#dc2626] text-white">
                                Root Cause
                              </span>
                            )}
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                              isHard ? 'bg-[#dc2626] text-white' : isMandate ? 'bg-[#7c3aed] text-white' : 'bg-[#fffbeb] text-[#d97706] border border-[#fef3c7]'
                            }`}>
                              {f.failure_class === 'HARD' ? 'HARD DECLINE' : f.failure_class === 'MANDATE' ? 'MANDATE DECLINE' : 'SOFT DECLINE'}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[12px] mt-1">
                          <span className="font-bold text-[#1b1f2b]">₹{(f.amount_paise / 100).toLocaleString('en-IN')}</span>
                          <span className="text-[#374151] font-medium">{f.decline_reason || f.decline_code}</span>
                        </div>

                        {f.failed_at && (
                          <div className="text-[10px] text-[#9ca3af] mt-1 pt-1 border-t border-[#f0f0f0]">
                            Failed at {new Date(f.failed_at).toLocaleString()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}
      </Drawer>
    </div>
  );
}
