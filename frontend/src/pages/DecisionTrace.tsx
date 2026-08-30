import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Drawer, Tooltip, Timeline, Spin, Empty, Alert, Input, Select, Button } from 'antd';
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
  SearchOutlined,
  FilterOutlined,
  SortAscendingOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
} from 'recharts';
import type { Transaction, FailureClass } from '../types/transaction';
import { fetchDashboardEvents, fetchDashboardSummary, type DashboardEvent, type DashboardSummary } from '../api/dashboard';
import clockSvg from '../assets/clock.svg';
import xCircleSvg from '../assets/x-circle.svg';
import sealCheckSvg from '../assets/seal-check.svg';

const CLASS_BORDER: Record<FailureClass, string> = {
  HARD: '#1b1f2b',
  SOFT: '#9ca3af',
  MANDATE: '#528FF0',
  UNKNOWN: '#d1d5db',
};

function apiEventToTransaction(e: DashboardEvent): Transaction {
  const actionStr = e.guardrail.final_action || e.agent.proposed_action || e.policy_action || 'Unknown';
  const retrySchedule = e.agent.retry_schedule;
  let retryTiming: string | undefined;
  if (retrySchedule && retrySchedule.length > 0) {
    retryTiming = retrySchedule.map((h) => (h < 1 ? `${Math.round(h * 60)}min` : `${h}h`)).join(' → ');
  }

  return {
    id: e.transaction_id || e.id.slice(0, 12),
    amount: e.amount_paise,
    currency: e.currency,
    customer_id: e.customer_id,
    customer_email: e.customer_email,
    merchant: e.merchant_id,
    instrument: `${e.instrument_type} ${e.instrument_token.slice(-4)}`,
    decline_code: e.decline_code,
    decline_reason: e.decline_reason,
    failure_class: e.failure_class as FailureClass,
    confidence: e.classification_confidence,
    agent_reasoning: e.agent.reasoning || 'No reasoning available',
    proposed_action: formatAction(actionStr),
    retry_timing: retryTiming,
    guardrail_status: e.guardrail.status as 'approved' | 'overridden',
    guardrail_checks: (e.guardrail.checks || []).map((c) => ({
      rule: c.rule,
      passed: c.passed,
      detail: c.detail,
    })),
    guardrail_override_reason: e.guardrail.override_reason || undefined,
    shacl: e.guardrail.shacl ? {
      conforms: e.guardrail.shacl.conforms,
      engine: e.guardrail.shacl.engine,
      ontology: e.guardrail.shacl.ontology,
      shapes: e.guardrail.shacl.shapes,
      data_graph_turtle: e.guardrail.shacl.data_graph_turtle,
      results_text: e.guardrail.shacl.results_text,
    } : undefined,
    outcome: e.outcome as Transaction['outcome'],
    outcome_detail: e.outcome_detail,
    failed_at: e.failed_at,
    resolved_at: e.actions.find((a) => a.status === 'SUCCEEDED')?.executed_at || undefined,
    email_draft: e.agent.email_draft
      ? {
          subject: e.agent.email_draft.subject,
          body: e.agent.email_draft.body,
          status: e.outcome === 'suppressed' ? 'suppressed' as const : 'sent' as const,
        }
      : undefined,
  };
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    RETRY: 'Retry',
    CONTACT_EMAIL: 'Email contact',
    REAUTH_REQUEST: 'Re-auth request',
    ESCALATE_HUMAN: 'Escalate to human',
  };
  return map[action] || action;
}

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

function humanReason(reason: string): string {
  return reason.replace(/\s*\(code\s+\S+\)\s*$/, '');
}

type SortKey = 'amount_asc' | 'amount_desc' | 'time_asc' | 'time_desc' | '';
type ChartGranularity = 'day' | 'month' | 'year';

// ---- Recovered-amount trend helpers ----

function bucketKey(date: Date, granularity: ChartGranularity): string {
  if (granularity === 'day') return date.toISOString().slice(0, 10); // YYYY-MM-DD
  if (granularity === 'month') return date.toISOString().slice(0, 7); // YYYY-MM
  return String(date.getFullYear()); // YYYY
}

function bucketLabel(key: string, granularity: ChartGranularity): string {
  if (granularity === 'day') {
    return new Date(key).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  }
  return key;
}

function buildRecoveredChartData(transactions: Transaction[], granularity: ChartGranularity) {
  const totals: Record<string, number> = {};
  transactions.forEach((t) => {
    if (t.outcome !== 'recovered') return;
    const raw = t.resolved_at || t.failed_at;
    if (!raw) return;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return;
    const key = bucketKey(d, granularity);
    totals[key] = (totals[key] || 0) + t.amount;
  });

  const bucketCount = granularity === 'day' ? 7 : granularity === 'month' ? 6 : 5;
  const now = new Date();
  const keys: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const d = new Date(now);
    if (granularity === 'day') d.setDate(d.getDate() - i);
    else if (granularity === 'month') d.setMonth(d.getMonth() - i);
    else d.setFullYear(d.getFullYear() - i);
    keys.push(bucketKey(d, granularity));
  }

  return keys.map((key) => ({
    label: bucketLabel(key, granularity),
    amount: Math.round((totals[key] || 0) / 100),
  }));
}

export default function DecisionTrace() {
  const navigate = useNavigate();
  const [drawerTxn, setDrawerTxn] = useState<Transaction | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const aboveTableRef = useRef<HTMLDivElement>(null);
  const [tableScrollY, setTableScrollY] = useState(300);

  // Filter / sort / page state
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState<string>('');
  const [filterOutcome, setFilterOutcome] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  // Recovered-amount trend chart state
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>('day');

  const loadData = async () => {
    try {
      const [eventsRes, summaryRes] = await Promise.all([
        fetchDashboardEvents({ limit: 50 }),
        fetchDashboardSummary(),
      ]);
      setTransactions(eventsRes.events.map(apiEventToTransaction));
      setSummary(summaryRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to backend');
    }
  };

  useEffect(() => {
    let cancelled = false;
    loadData().finally(() => { if (!cancelled) setLoading(false); });

    function connectWs() {
      const wsUrl = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/^http/, 'ws') + '/ws/dashboard';
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onmessage = () => { loadData(); };
      ws.onclose = () => { if (!cancelled) setTimeout(connectWs, 3000); };
      ws.onerror = () => ws.close();
    }

    connectWs();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const recalc = () => {
      if (aboveTableRef.current) {
        const bottom = aboveTableRef.current.getBoundingClientRect().bottom;
        setTableScrollY(Math.max(200, window.innerHeight - bottom - 24));
      }
    };
    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [loading, error]);

  const recoveredChartData = useMemo(
    () => buildRecoveredChartData(transactions, chartGranularity),
    [transactions, chartGranularity]
  );

  // Derived: filtered + sorted rows
  const displayedTransactions = (() => {
    let rows = [...transactions];

    // Search: match id, merchant, email, decline_reason, decline_code
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((t) =>
        t.id.toLowerCase().includes(q) ||
        t.merchant.toLowerCase().includes(q) ||
        t.customer_email.toLowerCase().includes(q) ||
        t.decline_reason.toLowerCase().includes(q) ||
        t.decline_code.toLowerCase().includes(q)
      );
    }

    // Filter by failure class
    if (filterClass) {
      rows = rows.filter((t) => t.failure_class === filterClass);
    }

    // Filter by outcome
    if (filterOutcome) {
      rows = rows.filter((t) => t.outcome === filterOutcome);
    }

    // Sort
    if (sortKey === 'amount_asc') rows.sort((a, b) => a.amount - b.amount);
    if (sortKey === 'amount_desc') rows.sort((a, b) => b.amount - a.amount);
    if (sortKey === 'time_asc') rows.sort((a, b) => new Date(a.failed_at).getTime() - new Date(b.failed_at).getTime());
    if (sortKey === 'time_desc') rows.sort((a, b) => new Date(b.failed_at).getTime() - new Date(a.failed_at).getTime());

    return rows;
  })();

  const hasFilters = search || filterClass || filterOutcome || sortKey;

  const totalPages = Math.ceil(displayedTransactions.length / PAGE_SIZE);
  const pagedTransactions = displayedTransactions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset to page 1 whenever filters change
  useEffect(() => { setCurrentPage(1); }, [search, filterClass, filterOutcome, sortKey]);

  const recoveredAmount = summary
    ? summary.recovered_amount_paise
    : transactions.filter((t) => t.outcome === 'recovered').reduce((sum, t) => sum + t.amount, 0);

  const suppressedCount = summary
    ? summary.override_count
    : transactions.filter((t) => t.guardrail_status === 'overridden' || t.outcome === 'suppressed').length;

  const pendingCount = summary
    ? summary.pending_count
    : transactions.filter((t) => t.outcome === 'pending').length;

  const failedCount = summary
    ? summary.exception_count
    : transactions.filter((t) => t.failure_class === 'UNKNOWN').length;

  const recoveredCount = summary
    ? summary.recovered_count
    : transactions.filter((t) => t.outcome === 'recovered').length;

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
            icon: <img src={xCircleSvg} alt="" className="w-[12px] h-[12px]" />,
            style: 'text-[#9ca3af]',
          },
          pending: {
            label: 'Pending',
            icon: <img src={clockSvg} alt="" className="w-[12px] h-[12px]" />,
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ height: '80vh' }}>
        <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="#d9d9d9" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
        </svg>
        <p className="text-[15px] font-semibold text-[#6b7280] mt-5">Backend Unavailable</p>
        <p className="text-[13px] text-[#9ca3af] mt-1 text-center max-w-xs">
          Could not connect to the server. Make sure the backend is running on <code className="text-[12px] bg-[#f3f4f6] px-1.5 py-0.5 rounded">localhost:8000</code>
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-4 py-1.5 text-[13px] font-medium text-[#528FF0] border border-[#528FF0] rounded-md hover:bg-[#528FF0] hover:text-white transition-colors cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: '100vh', overflow: 'hidden' }}>

      <div ref={aboveTableRef} className="flex-none">

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

        {/* TOP CARD: Recovered Amount */}
        <div className="bg-white rounded-lg border border-[#e5e8ec] px-6 py-5 mb-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] text-[#3b4055] font-semibold">Recovered Amount</span>
              <Tooltip title="Total amount recovered by the agent through retries and customer outreach">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>

            {/* Day / Month / Year toggle */}
            <div className="flex items-center gap-0.5 bg-[#f5f6f8] rounded-md p-0.5">
              {(['day', 'month', 'year'] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setChartGranularity(g)}
                  className={`text-[11px] px-2 py-1 rounded transition-colors cursor-pointer border-0 ${
                    chartGranularity === g
                      ? 'bg-white text-[#1b1f2b] font-semibold shadow-sm'
                      : 'bg-transparent text-[#9ca3af] hover:text-[#3b4055]'
                  }`}
                >
                  {g === 'day' ? 'Day' : g === 'month' ? 'Month' : 'Year'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-end justify-between gap-6">
            <div>
              <div className="mb-1">
                <span className="text-[36px] font-extrabold text-[#1b1f2b] tracking-tight leading-none">
                  ₹{Math.floor(recoveredAmount / 100).toLocaleString('en-IN')}
                </span>
                <span className="text-[20px] text-[#7b8294] font-medium leading-none">
                  .{String(recoveredAmount % 100).padStart(2, '0')}
                </span>
              </div>
              <div className="text-[13px] text-[#7b8294]">
                from {recoveredCount} recovered payments
              </div>
            </div>

            {/* Trend chart */}
            <div style={{ width: 240, height: 72 }} className="shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={recoveredChartData} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
                  <defs>
                    <linearGradient id="recoveredGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#528FF0" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#528FF0" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis hide domain={[0, 'auto']} />
                  <RechartsTooltip
                    formatter={(value: number) => [`₹${value.toLocaleString('en-IN')}`, 'Recovered']}
                    labelStyle={{ fontSize: 11, color: '#6b7280' }}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e8ec' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke="#528FF0"
                    strokeWidth={2}
                    fill="url(#recoveredGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* THREE SUMMARY CARDS */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-[#e5e8ec] p-5">
            <div className="flex items-center gap-2 mb-4">
              <WarningFilled className="text-[#d97706] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Guardrail Overrides</span>
              <Tooltip title="Decisions where the guardrail corrected the agent's proposal">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <div className="mb-1">
              <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{suppressedCount}</span>
            </div>
            <div className="text-[13px] text-[#7b8294]">overridden decisions</div>
          </div>

          <div className="bg-white rounded-lg border border-[#e5e8ec] p-5">
            <div className="flex items-center gap-2 mb-4">
              <ClockCircleOutlined className="text-[#528FF0] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Pending</span>
              <Tooltip title="Transactions awaiting resolution">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <div className="mb-1">
              <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{pendingCount}</span>
            </div>
            <div className="text-[13px] text-[#7b8294]">awaiting action</div>
          </div>

          <div className="bg-white rounded-lg border border-[#e5e8ec] p-5">
            <div className="flex items-center gap-2 mb-4">
              <CloseCircleFilled className="text-[#dc2626] text-[14px]" />
              <span className="text-[14px] text-[#1b1f2b] font-semibold">Exceptions</span>
              <Tooltip title="UNKNOWN classifications routed to human review">
                <InfoCircleOutlined className="text-[#c4c9d4] text-[12px] cursor-help" />
              </Tooltip>
            </div>
            <div className="mb-1">
              <span className="text-[32px] font-extrabold text-[#1b1f2b] leading-none">{failedCount}</span>
            </div>
            <div className="text-[13px] text-[#7b8294]">need human review</div>
          </div>
        </div>

        {/* Tab bar + search/filter/sort bar */}
        <div className="mb-3">
          <div className="border-b border-[#e5e8ec] flex gap-6 mb-3">
            <button className="text-[13px] font-semibold text-[#1b1f2b] pb-2.5 border-b-2 border-[#1b1f2b] bg-transparent cursor-pointer px-0">
              Decisions
            </button>
            <button className="text-[13px] text-[#7b8294] pb-2.5 border-b-2 border-transparent bg-transparent cursor-pointer px-0 hover:text-[#3b4055]">
              Suppressions
            </button>
          </div>

          {/* Search + Filter + Sort row */}
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search by ID, merchant, email, reason…"
              prefix={<SearchOutlined className="text-[#c4c9d4] text-[12px]" />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 260, fontSize: 12, height: 30 }}
            />

            <Select
              placeholder={<span className="flex items-center gap-1"><FilterOutlined className="text-[11px]" /> Class</span>}
              value={filterClass || undefined}
              onChange={(v) => setFilterClass(v ?? '')}
              allowClear
              style={{ width: 120, fontSize: 12 }}
              size="small"
              options={[
                { value: 'HARD', label: 'Hard' },
                { value: 'SOFT', label: 'Soft' },
                { value: 'MANDATE', label: 'Mandate' },
                { value: 'UNKNOWN', label: 'Unknown' },
              ]}
            />

            <Select
              placeholder={<span className="flex items-center gap-1"><FilterOutlined className="text-[11px]" /> Status</span>}
              value={filterOutcome || undefined}
              onChange={(v) => setFilterOutcome(v ?? '')}
              allowClear
              style={{ width: 130, fontSize: 12 }}
              size="small"
              options={[
                { value: 'recovered', label: 'Recovered' },
                { value: 'pending', label: 'Pending' },
                { value: 'failed', label: 'Failed' },
                { value: 'suppressed', label: 'Suppressed' },
              ]}
            />

            <Select
              placeholder={<span className="flex items-center gap-1"><SortAscendingOutlined className="text-[11px]" /> Sort</span>}
              value={sortKey || undefined}
              onChange={(v) => setSortKey((v ?? '') as SortKey)}
              allowClear
              style={{ width: 150, fontSize: 12 }}
              size="small"
              options={[
                { value: 'amount_desc', label: 'Amount: High → Low' },
                { value: 'amount_asc', label: 'Amount: Low → High' },
                { value: 'time_desc', label: 'Newest first' },
                { value: 'time_asc', label: 'Oldest first' },
              ]}
            />

            {hasFilters && (
              <button
                onClick={() => { setSearch(''); setFilterClass(''); setFilterOutcome(''); setSortKey(''); }}
                className="text-[12px] text-[#9ca3af] hover:text-[#1b1f2b] bg-transparent border-0 cursor-pointer px-1 transition-colors"
              >
                Clear
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              <span className="text-[12px] text-[#9ca3af]">
                {displayedTransactions.length === 0 ? '0' : `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, displayedTransactions.length)}`} of {displayedTransactions.length}
              </span>
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="w-[26px] h-[26px] rounded border border-[#e5e8ec] bg-white flex items-center justify-center text-[#3b4055] hover:bg-[#f5f5f5] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <span className="text-[11px]">‹</span>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                  if (idx > 0 && typeof arr[idx - 1] === 'number' && (p as number) - (arr[idx - 1] as number) > 1) acc.push('...');
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === '...' ? (
                    <span key={`ellipsis-${i}`} className="text-[12px] text-[#9ca3af] px-0.5">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setCurrentPage(p as number)}
                      className={`w-[26px] h-[26px] rounded border flex items-center justify-center text-[12px] cursor-pointer transition-colors ${
                        currentPage === p
                          ? 'border-[#1b1f2b] bg-[#1b1f2b] text-white'
                          : 'border-[#e5e8ec] bg-white text-[#3b4055] hover:bg-[#f5f5f5]'
                      }`}
                    >
                      {p}
                    </button>
                  )
                )}
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages || totalPages === 0}
                className="w-[26px] h-[26px] rounded border border-[#e5e8ec] bg-white flex items-center justify-center text-[#3b4055] hover:bg-[#f5f5f5] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <span className="text-[11px]">›</span>
              </button>
            </div>
          </div>
        </div>

      </div>{/* end aboveTableRef */}

      {/* TABLE — only this scrolls */}
      {transactions.length === 0 ? (
        <Empty description="No failure events found. Ingest some data via POST /ingest/webhook" />
      ) : (
        <div className="overflow-auto rounded-lg border border-[#e5e8ec] bg-white" style={{ flex: '1 1 0', minHeight: 0 }}>
          {displayedTransactions.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <Empty description="No results match your filters" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <Table
              dataSource={pagedTransactions}
              columns={columns}
              rowKey="id"
              pagination={false}
              size="small"
              scroll={{ x: 950, y: tableScrollY }}
              onRow={(record) => ({
                onClick: () => setDrawerTxn(record),
                className: `cursor-pointer transition-colors hover:bg-[#fafafa] ${
                  record.guardrail_status === 'overridden' ? '!bg-[#fefcf7] hover:!bg-[#fdf8ed]' : ''
                }`,
              })}
              style={{ fontSize: 13 }}
              className="decisions-table"
            />
          )}
        </div>
      )}

      {/* DETAIL DRAWER */}
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

function DetailBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1b1f2b] border border-[#e5e8ec] rounded-full px-2.5 py-[3px]">
      {icon}
      {label}
    </span>
  );
}

function TransactionDetail({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const actionType = getActionType(txn.proposed_action);
  const [showGuardrailChecks, setShowGuardrailChecks] = useState(false);
  const [showShaclDetails, setShowShaclDetails] = useState(false);
  const [showDataGraph, setShowDataGraph] = useState(false);

  const outcomeIcon: Record<string, React.ReactNode> = {
    recovered: <CheckCircleFilled className="text-[13px] text-[#22c55e]" />,
    failed: <img src={xCircleSvg} alt="" className="w-[14px] h-[14px]" />,
    pending: <img src={clockSvg} alt="" className="w-[14px] h-[14px]" />,
    suppressed: <StopOutlined className="text-[13px] text-[#9ca3af]" />,
  };

  const classIcon: Record<string, React.ReactNode> = {
    HARD: <img src={xCircleSvg} alt="" className="w-[12px] h-[12px]" />,
    SOFT: <WarningFilled className="text-[11px] text-[#f59e0b]" />,
    MANDATE: <ExclamationCircleOutlined className="text-[11px] text-[#528FF0]" />,
    UNKNOWN: <InfoCircleOutlined className="text-[11px] text-[#9ca3af]" />,
  };

  return (
    <div className="overflow-y-auto" style={{ height: '100vh' }}>

      {/* ── Top card ── */}
      <div className="m-5 mb-0 rounded-xl border border-[#e5e8ec] bg-white">
        {/* Close */}
        <div className="flex justify-end px-4 pt-3">
          <button onClick={onClose} className="text-[#9ca3af] hover:text-[#1b1f2b] bg-transparent border-0 cursor-pointer text-[16px] leading-none transition-colors">×</button>
        </div>

        <div className="px-6 pb-6">
          {/* Merchant + ID */}
          <div className="flex items-center gap-2 mb-1 text-[14px]">
            <span className="font-semibold text-[#1b1f2b]">{txn.merchant}</span>
            <span className="text-[#d1d5db]">·</span>
            <span className="font-mono text-[#9ca3af] text-[13px]">{txn.id}</span>
          </div>

          {/* Amount */}
          <div className="text-[36px] font-extrabold text-[#1b1f2b] leading-none tracking-tight mb-5">
            ₹{(txn.amount / 100).toLocaleString('en-IN')}
          </div>

          {/* Semantic badges row */}
          <div className="flex items-center flex-wrap gap-2 mb-5">
            <DetailBadge icon={outcomeIcon[txn.outcome]} label={txn.outcome === 'recovered' ? 'Recovered' : txn.outcome === 'failed' ? 'Failed' : txn.outcome === 'suppressed' ? 'Suppressed' : 'Pending'} />
            <DetailBadge icon={classIcon[txn.failure_class]} label={`${txn.failure_class} decline`} />
            <DetailBadge icon={<img src={sealCheckSvg} alt="" className="w-[13px] h-[13px]" />} label={`${Math.round(txn.confidence * 100)}% confidence`} />
          </div>

          {/* Failure reason */}
          <div className="mb-5">
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Failure Reason</div>
            <div className="text-[15px] font-semibold text-[#1b1f2b] leading-snug">
              {humanReason(txn.decline_reason)}
            </div>
            <div className="text-[12px] text-[#9ca3af] mt-1 font-mono">{txn.decline_code}</div>
          </div>

          {/* Recommended action */}
          <div className="mb-5">
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Recommended Action</div>
            <div className="flex items-center gap-2">
              <span className="text-[#528FF0]">{ACTION_ICON[actionType] || <ArrowRightOutlined />}</span>
              <span className="text-[15px] font-semibold text-[#1b1f2b]">{txn.proposed_action}</span>
              {txn.retry_timing && <span className="text-[12px] text-[#9ca3af]">({txn.retry_timing})</span>}
            </div>
            {txn.guardrail_status === 'overridden' && (
              <div className="flex items-center gap-1 mt-1">
                <WarningFilled className="text-[11px] text-[#f59e0b]" />
                <span className="text-[12px] text-[#9ca3af]">Guardrail overridden</span>
              </div>
            )}
          </div>

          {/* Status */}
          <div>
            <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Status</div>
            <div className="flex items-center gap-2">
              {outcomeIcon[txn.outcome]}
              <span className="text-[15px] font-semibold text-[#1b1f2b]">{txn.outcome_detail}</span>
            </div>
          </div>
        </div>

        {/* Compact meta footer */}
        <div className="px-6 py-2.5 border-t border-[#f0f0f0] flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#9ca3af]">
          <span>{txn.instrument}</span>
          <span>·</span>
          <span>{txn.customer_email}</span>
          <span>·</span>
          <span>{new Date(txn.failed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      {/* ── Bottom card ── */}
      <div className="m-5 rounded-xl border border-[#e5e8ec] bg-white">

        {/* Agent Decision */}
        <div className="px-6 py-5">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Agent Decision</div>
          <div className="text-[13px] text-[#4b5563] leading-[1.7]">
            {txn.agent_reasoning}
          </div>
        </div>

        {/* Guardrail */}
        <div className="px-6 py-4 border-t border-[#f0f0f0]">
          <button
            onClick={() => setShowGuardrailChecks(!showGuardrailChecks)}
            className="w-full flex items-center justify-between bg-transparent border-0 cursor-pointer p-0"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">Guardrail</span>
              <span className={`text-[11px] ${txn.guardrail_checks.every((c) => c.passed) ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                {txn.guardrail_status === 'overridden'
                  ? 'Override applied'
                  : `${txn.guardrail_checks.filter((c) => c.passed).length}/${txn.guardrail_checks.length} passed`}
              </span>
            </div>
            <RightOutlined
              className="text-[9px] text-[#9ca3af] transition-transform"
              style={{ transform: showGuardrailChecks ? 'rotate(90deg)' : 'none' }}
            />
          </button>

          {showGuardrailChecks && (
            <div className="mt-3 space-y-2.5">
              {txn.guardrail_checks.map((check, i) => {
                const friendlyName: Record<string, string> = {
                  'hard_no_retry': 'Don\u2019t retry dead cards',
                  'mandate_no_retry': 'Don\u2019t retry revoked mandates',
                  'max_retry_count': 'Retry limit not exceeded',
                  'retry_window': 'Within retry time window',
                  'contact_frequency_cap': 'Contact limit not exceeded',
                  'customer_opt_out': 'Customer allows communication',
                  'no_email_on_file': 'Email address available',
                  'unknown_must_escalate': 'Unknown failures need human review',
                  'kill_switch': 'System is active',
                  'rbi_pre_debit_notification': 'RBI pre-debit notification sent',
                  'card_network_do_not_retry': 'Card network retry allowed',
                  'rbi_email_transparency': 'RBI email transparency',
                };
                const policyRef: Record<string, string> = {
                  'hard_no_retry': 'Visa Core Rules 2024 · Mastercard Rules',
                  'mandate_no_retry': 'RBI e-Mandate Framework · NPCI UPI',
                  'max_retry_count': 'Visa 15/30d · MC 10-25/30d · NPCI 5/txn',
                  'retry_window': 'Visa/Mastercard 30-day · NPCI 48h',
                  'contact_frequency_cap': 'RBI Digital Lending Guidelines',
                  'customer_opt_out': 'RBI Customer Protection · IT Act §43A',
                  'no_email_on_file': 'RBI Digital Lending Guidelines',
                  'unknown_must_escalate': 'RBI Risk Management Framework',
                  'kill_switch': 'RBI Business Continuity Planning',
                  'rbi_pre_debit_notification': 'RBI e-Mandate · NPCI OC-151',
                  'card_network_do_not_retry': 'Visa/Mastercard Do-Not-Retry List',
                  'rbi_email_transparency': 'RBI/DOR/2022-23/145',
                };
                const label = friendlyName[check.rule] || check.rule.replace(/_/g, ' ');
                const policy = policyRef[check.rule];
                return (
                  <div key={i} className="flex items-start gap-2">
                    {check.passed ? (
                      <img src={sealCheckSvg} alt="" className="w-[13px] h-[13px] shrink-0 mt-[3px]" />
                    ) : (
                      <img src={xCircleSvg} alt="" className="w-[13px] h-[13px] shrink-0 mt-[3px]" />
                    )}
                    <div>
                      <div className="text-[12.5px] text-[#4b5563]">{label}</div>
                      {policy && (
                        <div className="text-[10px] text-[#528FF0] mt-0.5">{policy}</div>
                      )}
                      {check.detail && (
                        <div className="text-[11px] text-[#9ca3af] mt-0.5">{check.detail}</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {txn.guardrail_override_reason && (
                <div className="mt-2 pt-2 border-t border-[#f0f0f0] text-[12px] text-[#4b5563]">
                  <WarningFilled className="text-[11px] text-[#f59e0b] mr-1.5" />
                  {txn.guardrail_override_reason}
                </div>
              )}
            </div>
          )}
        </div>

        {/* SHACL Validation */}
        {txn.shacl && (
          <div className="px-6 py-4 border-t border-[#f0f0f0]">
            <button
              onClick={() => setShowShaclDetails(!showShaclDetails)}
              className="w-full flex items-center justify-between bg-transparent border-0 cursor-pointer p-0"
            >
              <div className="flex items-center gap-2.5">
                <span className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">SHACL Validation</span>
                <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  txn.shacl.conforms
                    ? 'bg-[#f0fdf4] text-[#22c55e]'
                    : 'bg-[#fef2f2] text-[#ef4444]'
                }`}>
                  {txn.shacl.conforms ? 'Conforms' : 'Violations found'}
                </span>
              </div>
              <RightOutlined
                className="text-[9px] text-[#9ca3af] transition-transform"
                style={{ transform: showShaclDetails ? 'rotate(90deg)' : 'none' }}
              />
            </button>

            {showShaclDetails && (
              <div className="mt-3">
                {/* Engine info */}
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="bg-[#f8f9fb] rounded-lg px-3 py-2.5">
                    <div className="text-[9px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-0.5">Engine</div>
                    <div className="text-[12px] font-semibold text-[#1b1f2b]">{txn.shacl.engine}</div>
                  </div>
                  <div className="bg-[#f8f9fb] rounded-lg px-3 py-2.5">
                    <div className="text-[9px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-0.5">Ontology</div>
                    <div className="text-[12px] font-semibold text-[#1b1f2b]">{txn.shacl.ontology}</div>
                  </div>
                  <div className="bg-[#f8f9fb] rounded-lg px-3 py-2.5">
                    <div className="text-[9px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-0.5">Shapes</div>
                    <div className="text-[12px] font-semibold text-[#1b1f2b]">{txn.shacl.shapes}</div>
                  </div>
                </div>

                {/* Conformance result */}
                <div className={`rounded-lg border px-4 py-3 mb-3 ${
                  txn.shacl.conforms
                    ? 'border-[#bbf7d0] bg-[#f0fdf4]'
                    : 'border-[#fecaca] bg-[#fef2f2]'
                }`}>
                  <div className="flex items-center gap-2">
                    {txn.shacl.conforms ? (
                      <CheckCircleFilled className="text-[14px] text-[#22c55e]" />
                    ) : (
                      <CloseCircleFilled className="text-[14px] text-[#ef4444]" />
                    )}
                    <span className="text-[13px] font-semibold text-[#1b1f2b]">
                      {txn.shacl.conforms
                        ? 'Proposal conforms to all SHACL constraints'
                        : 'Proposal violated SHACL constraints — guardrail override applied'}
                    </span>
                  </div>
                </div>

                {/* SHACL results text */}
                {txn.shacl.results_text && (
                  <div className="mb-3">
                    <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Validation Report</div>
                    <pre className="bg-[#1b1f2b] text-[#e5e8ec] text-[11px] leading-[1.6] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
                      {txn.shacl.results_text}
                    </pre>
                  </div>
                )}

                {/* RDF Data Graph */}
                {txn.shacl.data_graph_turtle && (
                  <div>
                    <button
                      onClick={() => setShowDataGraph(!showDataGraph)}
                      className="flex items-center gap-1.5 text-[11px] font-semibold text-[#528FF0] bg-transparent border-0 cursor-pointer p-0 mb-1.5 hover:text-[#4280e0] transition-colors"
                    >
                      <RightOutlined
                        className="text-[8px] transition-transform"
                        style={{ transform: showDataGraph ? 'rotate(90deg)' : 'none' }}
                      />
                      RDF Data Graph (Turtle)
                    </button>
                    {showDataGraph && (
                      <pre className="bg-[#1b1f2b] text-[#a5d6ff] text-[11px] leading-[1.6] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[250px] overflow-y-auto">
                        {txn.shacl.data_graph_turtle}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Email Draft */}
        {txn.email_draft && (
          <div className="px-6 py-5 border-t border-[#f0f0f0]">
            {/* Header */}
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <MailOutlined className="text-[13px] text-[#528FF0]" />
                <span className="text-[13px] font-semibold text-[#1b1f2b]">Email Draft</span>
              </div>
              {txn.email_draft.status === 'suppressed' && (
                <span className="text-[11px] text-[#9ca3af] border border-[#e5e8ec] rounded-full px-2 py-0.5">Suppressed</span>
              )}
            </div>

            {/* Context label */}
            <div className="text-[11.5px] text-[#9ca3af] mb-3">
              {humanReason(txn.decline_reason)} · Agent recommended {txn.proposed_action.toLowerCase()}
            </div>

            {/* Email content */}
            <div className={`border border-[#e5e8ec] rounded-lg p-4 ${txn.email_draft.status === 'suppressed' ? 'opacity-40' : ''}`}>
              <div className="text-[11.5px] text-[#9ca3af] mb-1">To: {txn.customer_email}</div>
              <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2.5">{txn.email_draft.subject}</div>
              <div className="text-[12px] text-[#6b7280] leading-[1.65] whitespace-pre-line border-t border-[#f0f0f0] pt-2.5">
                {txn.email_draft.body}
              </div>
            </div>

            {/* Approval actions */}
            <div className="flex items-center gap-2 mt-4">
              <button className="text-[12px] font-semibold text-white bg-[#1b1f2b] border-0 rounded-lg px-4 py-2 cursor-pointer hover:opacity-90 transition-opacity">
                Allow Once
              </button>
              <button className="text-[12px] font-semibold text-[#1b1f2b] bg-white border border-[#e5e8ec] rounded-lg px-4 py-2 cursor-pointer hover:bg-[#f9fafb] transition-colors">
                Allow Always
              </button>
              <button className="text-[12px] font-semibold text-[#ef4444] bg-white border border-[#e5e8ec] rounded-lg px-4 py-2 cursor-pointer hover:bg-[#f9fafb] transition-colors ml-auto">
                Deny
              </button>
            </div>

            {/* Permission explanation */}
            <div className="text-[10.5px] text-[#9ca3af] mt-2.5 leading-[1.5]">
              <span className="font-semibold">Allow Once</span> sends this email only.
              <span className="font-semibold ml-1.5">Allow Always</span> auto-sends future emails for this decline type.
              <span className="font-semibold ml-1.5">Deny</span> blocks this email and flags it for review.
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="px-6 py-5 border-t border-[#f0f0f0]">
          <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-3">Timeline</div>
          <Timeline
            items={[
              {
                color: '#d1d5db',
                children: <span className="text-[12.5px] text-[#4b5563]">Ingested at {new Date(txn.failed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>,
              },
              {
                color: '#d1d5db',
                children: <span className="text-[12.5px] text-[#4b5563]">Classified as <span className="font-semibold">{txn.failure_class}</span></span>,
              },
              {
                color: '#528FF0',
                children: <span className="text-[12.5px] text-[#4b5563]">Agent proposed <span className="font-semibold">{txn.proposed_action}</span></span>,
              },
              {
                color: txn.guardrail_status === 'overridden' ? '#f59e0b' : '#22c55e',
                children: (
                  <span className="text-[12.5px] text-[#4b5563]">
                    SHACL guardrail: {txn.guardrail_status === 'overridden' ? 'Override applied' : 'Approved'}
                    {txn.shacl && (
                      <span className={`ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        txn.shacl.conforms ? 'bg-[#f0fdf4] text-[#22c55e]' : 'bg-[#fef2f2] text-[#ef4444]'
                      }`}>
                        {txn.shacl.conforms ? 'conforms' : 'violations'}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                color: txn.outcome === 'recovered' ? '#22c55e' : '#d1d5db',
                children: <span className="text-[12.5px] text-[#4b5563]">{txn.outcome_detail}</span>,
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}