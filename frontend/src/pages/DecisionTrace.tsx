import { useState } from 'react';
import { Table, Drawer, Tooltip, Timeline } from 'antd';
import {
  InfoCircleOutlined,
  RightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  WarningFilled,
  ClockCircleOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  MailOutlined,
  ExclamationCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { MOCK_TRANSACTIONS, type Transaction, type FailureClass } from '../mock/data';

const CLASS_BORDER: Record<FailureClass, string> = {
  HARD: '#1b1f2b',
  SOFT: '#9ca3af',
  MANDATE: '#528FF0',
  UNKNOWN: '#d1d5db',
};

const ACTION_ICON: Record<string, React.ReactNode> = {
  retry: <ReloadOutlined className="text-[11px]" />,
  email: <MailOutlined className="text-[11px]" />,
  escalate: <ExclamationCircleOutlined className="text-[11px]" />,
  suppress: <StopOutlined className="text-[11px]" />,
};

function getActionType(action: string): string {
  const lower = action.toLowerCase();
  if (lower.includes('retry')) return 'retry';
  if (lower.includes('email') || lower.includes('contact')) return 'email';
  if (lower.includes('escalate') || lower.includes('human')) return 'escalate';
  return 'suppress';
}

// Strip the parenthetical code from decline_reason for cleaner display
function humanReason(reason: string): string {
  return reason.replace(/\s*\(code\s+\S+\)\s*$/, '');
}

// Summary data
const recoveredAmount = MOCK_TRANSACTIONS
  .filter((t) => t.outcome === 'recovered')
  .reduce((sum, t) => sum + t.amount, 0);

const suppressedCount = MOCK_TRANSACTIONS.filter(
  (t) => t.guardrail_status === 'overridden' || t.outcome === 'suppressed'
).length;

const pendingCount = MOCK_TRANSACTIONS.filter((t) => t.outcome === 'pending').length;
const failedCount = MOCK_TRANSACTIONS.filter((t) => t.failure_class === 'UNKNOWN').length;

export default function DecisionTrace() {
  const [drawerTxn, setDrawerTxn] = useState<Transaction | null>(null);

  const columns = [
    {
      title: 'Transaction',
      dataIndex: 'id',
      key: 'id',
      width: 170,
      render: (_: string, record: Transaction) => (
        <div>
          <div className="text-[13px] font-semibold text-[#1b1f2b] font-mono">{record.id}</div>
          <div className="text-[11.5px] text-[#9ca3af] mt-0.5">{record.merchant} · {record.instrument}</div>
        </div>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 100,
      align: 'right' as const,
      render: (v: number) => (
        <span className="text-[13px] font-semibold text-[#1b1f2b] tabular-nums">
          ₹{(v / 100).toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      title: 'Reason',
      key: 'reason',
      width: 220,
      render: (_: unknown, record: Transaction) => (
        <div
          className="pl-2.5"
          style={{ borderLeft: `2px solid ${CLASS_BORDER[record.failure_class]}` }}
        >
          <div className="text-[12.5px] text-[#1b1f2b]">{humanReason(record.decline_reason)}</div>
          <div className="text-[11px] text-[#9ca3af] font-mono mt-0.5">{record.decline_code} · {record.failure_class}</div>
        </div>
      ),
    },
    {
      title: 'Action',
      key: 'action_col',
      width: 160,
      render: (_: unknown, record: Transaction) => {
        const type = getActionType(record.proposed_action);
        return (
          <div className="flex items-center gap-2">
            <span className="text-[#6b7280]">{ACTION_ICON[type]}</span>
            <span className="text-[12.5px] text-[#3b4055]">{record.proposed_action}</span>
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 140,
      render: (_: unknown, record: Transaction) => {
        const outcomeMap: Record<string, { label: string; icon: React.ReactNode; style: string }> = {
          recovered: {
            label: 'Recovered',
            icon: <CheckCircleFilled className="text-[11px] text-[#22c55e]" />,
            style: 'text-[#1b1f2b] font-medium',
          },
          failed: {
            label: 'Failed',
            icon: <CloseCircleFilled className="text-[11px]" />,
            style: 'text-[#9ca3af]',
          },
          pending: {
            label: 'Pending',
            icon: <ClockCircleOutlined className="text-[11px]" />,
            style: 'text-[#9ca3af]',
          },
          suppressed: {
            label: 'Suppressed',
            icon: <StopOutlined className="text-[11px]" />,
            style: 'text-[#9ca3af]',
          },
        };
        const o = outcomeMap[record.outcome] || outcomeMap.pending;
        const isOverride = record.guardrail_status === 'overridden';

        return (
          <div className="space-y-1">
            <div className={`flex items-center gap-1.5 ${o.style}`}>
              {o.icon}
              <span className="text-[12px]">{o.label}</span>
            </div>
            {isOverride && (
              <div className="flex items-center gap-1 ml-[18px]">
                <span className="text-[10.5px] text-[#9ca3af]">Guardrail override</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: '',
      key: 'chevron',
      width: 28,
      render: () => <ArrowRightOutlined className="text-[#d1d5db] text-[10px]" />,
    },
  ];

  return (
    <div>
      {/* Page Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-[#1b1f2b]">Overview</span>
          <span className="text-[#528FF0] text-[13px] cursor-pointer">Today ▾</span>
        </div>
        <a className="text-[#528FF0] text-[13px] flex items-center gap-1 no-underline cursor-pointer">
          Documentation <RightOutlined className="text-[9px]" />
        </a>
      </div>

      {/* ========== TOP CARD: Recovered Amount ========== */}
      <div className="bg-white rounded-lg border border-[#e5e8ec] px-6 py-5 mb-4">
        <div className="flex items-center gap-1.5 mb-3">
          <span className="text-[14px] text-[#3b4055] font-semibold">Recovered Amount</span>
          <Tooltip title="Total amount recovered by the agent through retries and customer outreach">
            <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
          </Tooltip>
        </div>
        <div className="mb-1">
          <span className="text-[36px] font-extrabold text-[#1b1f2b] tracking-tight leading-none">
            ₹{Math.floor(recoveredAmount / 100).toLocaleString('en-IN')}
          </span>
          <span className="text-[20px] text-[#7b8294] font-medium leading-none">
            .{String(recoveredAmount % 100).padStart(2, '0')}
          </span>
        </div>
        <div className="text-[13px] text-[#7b8294]">
          from {MOCK_TRANSACTIONS.filter((t) => t.outcome === 'recovered').length} recovered payments
        </div>
      </div>

      {/* ========== THREE SUMMARY CARDS ========== */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-[#e5e8ec] p-5 cursor-pointer hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <WarningFilled className="text-[#d97706] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Guardrail Overrides</span>
              <Tooltip title="Decisions where the guardrail corrected the agent's proposal">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <RightOutlined className="text-[#c4c9d4] text-[10px]" />
          </div>
          <div className="mb-1">
            <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{suppressedCount}</span>
          </div>
          <div className="text-[13px] text-[#7b8294]">overridden decisions</div>
        </div>

        <div className="bg-white rounded-lg border border-[#e5e8ec] p-5 cursor-pointer hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ClockCircleOutlined className="text-[#528FF0] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Pending</span>
              <Tooltip title="Transactions awaiting resolution">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <RightOutlined className="text-[#c4c9d4] text-[10px]" />
          </div>
          <div className="mb-1">
            <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{pendingCount}</span>
          </div>
          <div className="text-[13px] text-[#7b8294]">awaiting action</div>
        </div>

        <div className="bg-white rounded-lg border border-[#e5e8ec] p-5 cursor-pointer hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CloseCircleFilled className="text-[#dc2626] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Exceptions</span>
              <Tooltip title="UNKNOWN classifications routed to human review">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <RightOutlined className="text-[#c4c9d4] text-[10px]" />
          </div>
          <div className="mb-1">
            <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{failedCount}</span>
          </div>
          <div className="text-[13px] text-[#7b8294]">need human review</div>
        </div>
      </div>

      {/* ========== TRANSACTIONS TABLE ========== */}
      <div className="mb-4">
        <div className="border-b border-[#e5e8ec] flex gap-6">
          <button className="text-[13px] font-semibold text-[#1b1f2b] pb-2.5 border-b-2 border-[#1b1f2b] bg-transparent cursor-pointer px-0">
            Decisions
          </button>
          <button className="text-[13px] text-[#7b8294] pb-2.5 border-b-2 border-transparent bg-transparent cursor-pointer px-0 hover:text-[#3b4055]">
            Suppressions
          </button>
        </div>
      </div>

      <Table
        dataSource={MOCK_TRANSACTIONS}
        columns={columns}
        rowKey="id"
        pagination={false}
        size="small"
        onRow={(record) => ({
          onClick: () => setDrawerTxn(record),
          className: `cursor-pointer transition-colors hover:bg-[#fafafa] ${
            record.guardrail_status === 'overridden' ? '!bg-[#fefcf7] hover:!bg-[#fdf8ed]' : ''
          }`,
        })}
        style={{ fontSize: 13 }}
        className="decisions-table"
      />

      {/* ========== DETAIL DRAWER ========== */}
      <Drawer
        open={!!drawerTxn}
        onClose={() => setDrawerTxn(null)}
        width={520}
        styles={{
          header: { display: 'none' },
          body: { padding: 0 },
        }}
      >
        {drawerTxn && <TransactionDetail txn={drawerTxn} onClose={() => setDrawerTxn(null)} />}
      </Drawer>
    </div>
  );
}

function TransactionDetail({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const actionType = getActionType(txn.proposed_action);

  return (
    <div>
      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-5 border-b border-[#f0f0f0]">
        <div className="flex items-center justify-between mb-4">
          <span className="font-mono text-[14px] font-semibold text-[#1b1f2b]">{txn.id}</span>
          <button
            onClick={onClose}
            className="text-[#9ca3af] hover:text-[#1b1f2b] bg-transparent border-0 cursor-pointer text-[18px] leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <div className="flex items-baseline gap-3 mb-3">
          <span className="text-[28px] font-bold text-[#1b1f2b] leading-none tracking-tight">
            ₹{(txn.amount / 100).toLocaleString('en-IN')}
          </span>
          <span className="text-[13px] text-[#9ca3af]">{txn.merchant}</span>
        </div>

        <div className="flex items-center gap-3 text-[12.5px]">
          <span className="text-[#6b7280]">{txn.instrument}</span>
          <span className="text-[#d1d5db]">·</span>
          <span className="text-[#6b7280]">{txn.customer_email}</span>
          <span className="text-[#d1d5db]">·</span>
          <span className="text-[#9ca3af]">{new Date(txn.failed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      {/* ── Failure reason ── */}
      <div className="px-6 py-4 border-b border-[#f0f0f0]">
        <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Failure</div>
        <div
          className="pl-3 py-1"
          style={{ borderLeft: `2px solid ${CLASS_BORDER[txn.failure_class]}` }}
        >
          <div className="text-[13.5px] text-[#1b1f2b] font-medium">{humanReason(txn.decline_reason)}</div>
          <div className="text-[11.5px] text-[#9ca3af] font-mono mt-1">{txn.decline_code} · {txn.failure_class} · {Math.round(txn.confidence * 100)}% confidence</div>
        </div>
      </div>

      {/* ── Agent recommendation ── */}
      <div className="px-6 py-4 border-b border-[#f0f0f0]">
        <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Recommendation</div>

        <div className="flex items-center gap-2 mb-3">
          <span className="text-[#6b7280]">{ACTION_ICON[actionType]}</span>
          <span className="text-[13.5px] font-medium text-[#1b1f2b]">{txn.proposed_action}</span>
          {txn.retry_timing && (
            <span className="text-[11.5px] text-[#9ca3af] ml-1">({txn.retry_timing})</span>
          )}
        </div>

        <div className="text-[12.5px] text-[#6b7280] leading-[1.65] bg-[#fafafa] rounded-lg px-4 py-3">
          {txn.agent_reasoning}
        </div>
      </div>

      {/* ── Guardrail ── */}
      <div className="px-6 py-4 border-b border-[#f0f0f0]">
        <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Guardrail</div>

        <div className="flex items-center gap-2 mb-3">
          {txn.guardrail_status === 'overridden' ? (
            <>
              <span className="w-[6px] h-[6px] rounded-full bg-[#1b1f2b]" />
              <span className="text-[13px] font-medium text-[#1b1f2b]">Override applied</span>
            </>
          ) : (
            <>
              <span className="w-[6px] h-[6px] rounded-full bg-[#9ca3af]" />
              <span className="text-[13px] text-[#6b7280]">All checks passed</span>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          {txn.guardrail_checks.map((check, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 text-[12.5px]">
                {check.passed ? (
                  <CheckCircleFilled className="text-[#c4c9d4] text-[11px] shrink-0" />
                ) : (
                  <CloseCircleFilled className="text-[#1b1f2b] text-[11px] shrink-0" />
                )}
                <span className={check.passed ? 'text-[#6b7280]' : 'text-[#1b1f2b] font-medium'}>
                  {check.rule}
                </span>
              </div>
              {check.detail && (
                <div className="ml-[22px] mt-1 text-[11.5px] text-[#6b7280] bg-[#fafafa] px-3 py-2 rounded">
                  {check.detail}
                </div>
              )}
            </div>
          ))}
        </div>

        {txn.guardrail_override_reason && (
          <div className="mt-3 pt-3 border-t border-[#f0f0f0] text-[12px] text-[#6b7280]">
            <span className="font-medium text-[#1b1f2b]">Result: </span>
            {txn.guardrail_override_reason}
          </div>
        )}
      </div>

      {/* ── Timeline ── */}
      <div className="px-6 py-4 border-b border-[#f0f0f0]">
        <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-3">Timeline</div>
        <Timeline
          items={[
            {
              color: '#d1d5db',
              children: <span className="text-[12.5px] text-[#6b7280]">Ingested at {new Date(txn.failed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>,
            },
            {
              color: '#d1d5db',
              children: (
                <span className="text-[12.5px] text-[#6b7280]">
                  Classified as <span className="font-medium text-[#1b1f2b]">{txn.failure_class}</span>
                </span>
              ),
            },
            {
              color: '#d1d5db',
              children: <span className="text-[12.5px] text-[#6b7280]">Agent proposed: {txn.proposed_action}</span>,
            },
            {
              color: txn.guardrail_status === 'overridden' ? '#1b1f2b' : '#d1d5db',
              children: (
                <span className="text-[12.5px] text-[#6b7280]">
                  Guardrail: {txn.guardrail_status === 'overridden' ? <span className="font-medium text-[#1b1f2b]">Override applied</span> : 'Approved'}
                </span>
              ),
            },
            {
              color: txn.outcome === 'recovered' ? '#1b1f2b' : '#d1d5db',
              children: <span className="text-[12.5px] text-[#6b7280]">{txn.outcome_detail}</span>,
            },
          ]}
        />
      </div>

      {/* ── Email preview ── */}
      {txn.email_draft && (
        <div className="px-6 py-4">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2 flex items-center gap-2">
            Email Draft
            {txn.email_draft.status === 'suppressed' && (
              <span className="text-[10px] font-medium text-[#9ca3af] bg-[#f3f4f6] px-1.5 py-0.5 rounded normal-case tracking-normal">
                Suppressed
              </span>
            )}
          </div>

          <div className={`bg-[#fafafa] border border-[#f0f0f0] rounded-lg p-4 ${txn.email_draft.status === 'suppressed' ? 'opacity-50' : ''}`}>
            <div className="text-[11.5px] text-[#9ca3af] mb-1">To: {txn.customer_email}</div>
            <div className="text-[13px] font-medium text-[#1b1f2b] mb-3">{txn.email_draft.subject}</div>
            <div className="text-[12.5px] text-[#6b7280] leading-[1.6] whitespace-pre-line border-t border-[#f0f0f0] pt-3">
              {txn.email_draft.body}
            </div>
          </div>

          {txn.email_draft.suppression_reason && (
            <div className="mt-2 text-[11.5px] text-[#6b7280] bg-[#fafafa] px-3 py-2 rounded">
              {txn.email_draft.suppression_reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
