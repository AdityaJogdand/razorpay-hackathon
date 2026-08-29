import { useState } from 'react';
import { Table, Tag, Drawer, Descriptions, Timeline, Collapse, Tooltip } from 'antd';
import {
  InfoCircleOutlined,
  RightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  WarningFilled,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { MOCK_TRANSACTIONS, type Transaction, type FailureClass } from '../mock/data';

const CLASS_TAG: Record<FailureClass, { color: string; text: string }> = {
  HARD: { color: '#f3f4f6', text: '#374151' },
  SOFT: { color: '#f3f4f6', text: '#374151' },
  MANDATE: { color: '#f3f4f6', text: '#374151' },
  UNKNOWN: { color: '#f3f4f6', text: '#374151' },
};

function formatAmount(paise: number): string {
  const rupees = paise / 100;
  const whole = Math.floor(rupees);
  const decimal = String(paise % 100).padStart(2, '0');
  return { whole: whole.toLocaleString('en-IN'), decimal };
}

function AmountDisplay({ paise, className = '' }: { paise: number; className?: string }) {
  const { whole, decimal } = formatAmount(paise);
  return (
    <span className={className}>
      <span className="text-[11px] align-top">₹</span>
      <span className="text-[22px] font-bold text-[#1b1f2b]">{whole}</span>
      <span className="text-[14px] text-[#7b8294]">.{decimal}</span>
    </span>
  );
}

// Summary cards data
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
      width: 200,
      render: (_: string, record: Transaction) => (
        <div>
          <div className="font-mono text-[13px] font-semibold text-[#1b1f2b]">{record.id}</div>
          <div className="text-[12px] text-[#7b8294] mt-0.5">{record.merchant}</div>
        </div>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      render: (v: number) => (
        <span className="text-[14px] font-semibold text-[#1b1f2b]">
          ₹{(v / 100).toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      title: 'Failure',
      key: 'failure',
      width: 200,
      render: (_: unknown, record: Transaction) => (
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide"
              style={{ background: CLASS_TAG[record.failure_class].color, color: CLASS_TAG[record.failure_class].text }}
            >
              {record.failure_class}
            </span>
            <span className="text-[11px] text-[#7b8294]">{Math.round(record.confidence * 100)}%</span>
          </div>
          <div className="text-[12px] font-mono text-[#7b8294] mt-1">{record.decline_code}</div>
        </div>
      ),
    },
    {
      title: 'Action',
      dataIndex: 'proposed_action',
      key: 'proposed_action',
      width: 180,
      render: (action: string) => (
        <span className="text-[12px] text-[#3b4055]">{action}</span>
      ),
    },
    {
      title: 'Guardrail',
      dataIndex: 'guardrail_status',
      key: 'guardrail_status',
      width: 100,
      render: (status: string) =>
        status === 'overridden' ? (
          <div className="flex items-center gap-1.5">
            <span className="w-[6px] h-[6px] rounded-full bg-[#1b1f2b] shrink-0" />
            <span className="text-[12px] font-medium text-[#1b1f2b]">Override</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="w-[6px] h-[6px] rounded-full bg-[#9ca3af] shrink-0" />
            <span className="text-[12px] text-[#7b8294]">Passed</span>
          </div>
        ),
    },
    {
      title: 'Outcome',
      dataIndex: 'outcome',
      key: 'outcome',
      width: 110,
      render: (outcome: string) => {
        const map: Record<string, { label: string; color: string; bg: string }> = {
          recovered: { label: 'Recovered', color: '#166534', bg: '#f0fdf4' },
          failed: { label: 'Failed', color: '#991b1b', bg: '#fef2f2' },
          pending: { label: 'Pending', color: '#6b7280', bg: '#f3f4f6' },
          suppressed: { label: 'Suppressed', color: '#92400e', bg: '#fffbeb' },
        };
        const m = map[outcome] || map.pending;
        return (
          <span
            className="text-[11px] font-medium px-2 py-1 rounded-full"
            style={{ color: m.color, background: m.bg }}
          >
            {m.label}
          </span>
        );
      },
    },
    {
      title: '',
      key: 'action',
      width: 32,
      render: () => <RightOutlined className="text-[#c4c9d4] text-[10px]" />,
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
        {/* Guardrail Overrides */}
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

        {/* Pending */}
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

        {/* Unknown / Exceptions */}
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

      <div className="bg-white rounded-lg border border-[#e5e8ec]">
        <Table
          dataSource={MOCK_TRANSACTIONS}
          columns={columns}
          rowKey="id"
          pagination={false}
          size="small"
          onRow={(record) => ({
            onClick: () => setDrawerTxn(record),
            style: { cursor: 'pointer' },
          })}
          rowClassName={(record) =>
            record.guardrail_status === 'overridden' ? 'bg-[#fffdf5]' : ''
          }
          style={{ fontSize: 13 }}
        />
      </div>

      {/* ========== DETAIL DRAWER ========== */}
      <Drawer
        title={
          drawerTxn ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-[15px]">{drawerTxn.id}</span>
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded"
                style={{
                  background: CLASS_TAG[drawerTxn.failure_class].color,
                  color: CLASS_TAG[drawerTxn.failure_class].text,
                }}
              >
                {drawerTxn.failure_class}
              </span>
              <span className="text-[12px] text-[#7b8294]">
                {Math.round(drawerTxn.confidence * 100)}% confidence
              </span>
            </div>
          ) : null
        }
        open={!!drawerTxn}
        onClose={() => setDrawerTxn(null)}
        width={560}
        styles={{ body: { padding: 0 } }}
      >
        {drawerTxn && <TransactionDetail txn={drawerTxn} />}
      </Drawer>
    </div>
  );
}

function TransactionDetail({ txn }: { txn: Transaction }) {
  return (
    <div className="divide-y divide-[#e5e8ec]">
      {/* Transaction Context */}
      <div className="p-5">
        <Descriptions
          size="small"
          column={2}
          labelStyle={{ color: '#7b8294', fontSize: 12, fontWeight: 500 }}
          contentStyle={{ color: '#1b1f2b', fontSize: 13 }}
        >
          <Descriptions.Item label="Amount">
            ₹{(txn.amount / 100).toLocaleString('en-IN')}
          </Descriptions.Item>
          <Descriptions.Item label="Merchant">{txn.merchant}</Descriptions.Item>
          <Descriptions.Item label="Instrument">{txn.instrument}</Descriptions.Item>
          <Descriptions.Item label="Customer">{txn.customer_email}</Descriptions.Item>
          <Descriptions.Item label="Decline Code">
            <code className="text-[12px] bg-[#f5f5f5] px-1.5 py-0.5 rounded">{txn.decline_code}</code>
          </Descriptions.Item>
          <Descriptions.Item label="Reason">{txn.decline_reason}</Descriptions.Item>
        </Descriptions>
      </div>

      {/* Agent Reasoning */}
      <div className="p-5">
        <div className="text-[11px] font-bold text-[#7b8294] uppercase tracking-wider mb-3">
          Agent Reasoning
        </div>
        <div className="bg-[#f8f9fa] border-l-[3px] border-l-[#528FF0] rounded-r px-4 py-3 text-[13px] text-[#3b4055] leading-[1.7]">
          {txn.agent_reasoning}
        </div>
        <div className="mt-3 flex gap-4 text-[13px]">
          <span>
            <span className="text-[#7b8294]">Action: </span>
            <span className="font-medium text-[#1b1f2b]">{txn.proposed_action}</span>
          </span>
          {txn.retry_timing && (
            <span>
              <span className="text-[#7b8294]">Timing: </span>
              <span className="text-[#1b1f2b]">{txn.retry_timing}</span>
            </span>
          )}
        </div>
      </div>

      {/* Guardrail Validation */}
      <div className="p-5">
        <div className="text-[11px] font-bold text-[#7b8294] uppercase tracking-wider mb-3">
          Guardrail Validation
        </div>
        <div
          className={`rounded-md px-4 py-3 border ${
            txn.guardrail_status === 'overridden'
              ? 'bg-[#fffdf5] border-[#ffc107]'
              : 'bg-[#f0fdf4] border-[#86efac]'
          }`}
        >
          <div className="flex items-center gap-2 mb-2.5 text-[13px] font-semibold">
            {txn.guardrail_status === 'overridden' ? (
              <>
                <WarningFilled className="text-[#d97706]" />
                <span className="text-[#856404]">Override Applied</span>
              </>
            ) : (
              <>
                <CheckCircleFilled className="text-[#2da44e]" />
                <span className="text-[#166534]">All Checks Passed</span>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            {txn.guardrail_checks.map((check, i) => (
              <div key={i}>
                <div className="flex items-center gap-2 text-[13px]">
                  {check.passed ? (
                    <CheckCircleFilled className="text-[#2da44e] text-[11px]" />
                  ) : (
                    <CloseCircleFilled className="text-[#dc2626] text-[11px]" />
                  )}
                  <span className={check.passed ? 'text-[#3b4055]' : 'text-[#dc2626] font-medium'}>
                    {check.rule}
                  </span>
                </div>
                {check.detail && (
                  <div className="ml-[22px] mt-1 text-[12px] text-[#856404] bg-[#fef9e7] px-3 py-1.5 rounded">
                    {check.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
          {txn.guardrail_override_reason && (
            <div className="mt-3 pt-2.5 border-t border-[#ffc107] text-[12px] text-[#856404]">
              <span className="font-semibold">Result: </span>
              {txn.guardrail_override_reason}
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="p-5">
        <div className="text-[11px] font-bold text-[#7b8294] uppercase tracking-wider mb-3">
          Timeline
        </div>
        <Timeline
          items={[
            {
              color: '#528FF0',
              children: <span className="text-[13px] text-[#3b4055]">Ingested at {new Date(txn.failed_at).toLocaleTimeString()}</span>,
            },
            {
              color: '#528FF0',
              children: (
                <span className="text-[13px] text-[#3b4055]">
                  Classified as{' '}
                  <span
                    className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
                    style={{
                      background: CLASS_TAG[txn.failure_class].color,
                      color: CLASS_TAG[txn.failure_class].text,
                    }}
                  >
                    {txn.failure_class}
                  </span>
                </span>
              ),
            },
            {
              color: '#528FF0',
              children: <span className="text-[13px] text-[#3b4055]">Agent proposed: {txn.proposed_action}</span>,
            },
            {
              color: txn.guardrail_status === 'overridden' ? '#d97706' : '#2da44e',
              children: (
                <span className="text-[13px] text-[#3b4055]">
                  Guardrail: {txn.guardrail_status === 'overridden' ? 'Override applied' : 'Approved'}
                </span>
              ),
            },
            {
              color: txn.outcome === 'recovered' ? '#2da44e' : '#7b8294',
              children: <span className="text-[13px] text-[#3b4055]">{txn.outcome_detail}</span>,
            },
          ]}
        />
      </div>

      {/* Email Preview */}
      {txn.email_draft && (
        <div className="p-5">
          <div className="text-[11px] font-bold text-[#7b8294] uppercase tracking-wider mb-3 flex items-center gap-2">
            Agent-Drafted Email
            {txn.email_draft.status === 'suppressed' && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#fef2f2] text-[#dc2626] normal-case tracking-normal">
                Suppressed
              </span>
            )}
          </div>
          <div className={`bg-[#f8f9fa] border border-[#e5e8ec] rounded-md p-4 ${txn.email_draft.status === 'suppressed' ? 'opacity-60' : ''}`}>
            <div className="text-[12px] text-[#7b8294] mb-1">
              To: {txn.customer_email}
            </div>
            <div className="text-[13px] font-medium text-[#1b1f2b] mb-3">
              {txn.email_draft.subject}
            </div>
            <div className="text-[13px] text-[#3b4055] leading-[1.6] whitespace-pre-line border-t border-[#e5e8ec] pt-3">
              {txn.email_draft.body}
            </div>
          </div>
          {txn.email_draft.suppression_reason && (
            <div className="mt-2 text-[12px] text-[#856404] bg-[#fef9e7] px-3 py-2 rounded border border-[#ffc107]">
              {txn.email_draft.suppression_reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
