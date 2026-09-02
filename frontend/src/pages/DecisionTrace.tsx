import { useState, useEffect, useRef, useMemo } from 'react';
import { Table, Drawer, Tooltip, Timeline, Spin, Empty, Input, Select, Button, message } from 'antd';
import {
  InfoCircleOutlined,
  RightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  WarningFilled,
  ArrowRightOutlined,
  ReloadOutlined,
  MailOutlined,
  ExclamationCircleOutlined,
  StopOutlined,
  SearchOutlined,
  FilterOutlined,
  SortAscendingOutlined,
  EditOutlined,
  PhoneOutlined,
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
import { fetchDashboardEvents, fetchDashboardSummary, approveEmail, denyEmail, updateEmailDraft, type DashboardEvent, type DashboardSummary } from '../api/dashboard';
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
    event_id: e.id,
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
    email_draft: (() => {
      const emailAction = e.actions.find((a) =>
        a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST'
      );
      const pendingAction = e.actions.find((a) =>
        (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && (a.status === 'PENDING_APPROVAL' || a.status === 'SCHEDULED')
      );
      const deniedAction = e.actions.find((a) =>
        (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && a.status === 'DENIED'
      );
      const succeededAction = e.actions.find((a) =>
        (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && a.status === 'SUCCEEDED'
      );
      // Only show email draft if there's an actual email action — not just an agent suggestion
      if (!emailAction) return undefined;
      const draft = (emailAction.outcome as { email_draft?: { subject: string; body: string } } | null)?.email_draft || e.agent.email_draft;
      if (!draft) return undefined;
      const emailStatus = succeededAction ? 'sent' as const
        : deniedAction ? 'suppressed' as const
        : pendingAction ? 'pending_approval' as const
        : e.outcome === 'suppressed' ? 'suppressed' as const
        : 'sent' as const;
      return {
        subject: draft.subject,
        body: draft.body,
        status: emailStatus,
        suppression_reason: deniedAction ? 'Denied by human review' : undefined,
      };
    })(),
    pending_email_action_id: (() => {
      const pending = e.actions.find((a) =>
        (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && a.status === 'PENDING_APPROVAL'
      );
      if (pending) return pending.id;
      const scheduled = e.actions.find((a) =>
        (a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST') && a.status === 'SCHEDULED'
      );
      return scheduled?.id;
    })(),
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

export default function DecisionTrace() {
  const [drawerTxn, setDrawerTxn] = useState<Transaction | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Filter / sort / page state
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState<string>('');
  const [filterOutcome, setFilterOutcome] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  const loadData = async () => {
    try {
      const [eventsRes, summaryRes] = await Promise.all([
        fetchDashboardEvents({ limit: 50 }),
        fetchDashboardSummary(),
      ]);
      const refreshedTransactions = eventsRes.events.map(apiEventToTransaction);
      setTransactions(refreshedTransactions);
      setDrawerTxn((current) => current
        ? refreshedTransactions.find((transaction) => transaction.event_id === current.event_id) || current
        : null
      );
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
      ws.onmessage = () => { void loadData(); };
      ws.onclose = () => { if (!cancelled) setTimeout(connectWs, 3000); };
      ws.onerror = () => ws.close();
    }

    connectWs();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  // Derived: filtered + sorted rows
  const displayedTransactions = (() => {
    let rows = [...transactions];

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

    if (filterClass) {
      rows = rows.filter((t) => t.failure_class === filterClass);
    }

    if (filterOutcome) {
      rows = rows.filter((t) => t.outcome === filterOutcome);
    }

    if (sortKey === 'amount_asc') rows.sort((a, b) => a.amount - b.amount);
    if (sortKey === 'amount_desc') rows.sort((a, b) => b.amount - a.amount);
    if (sortKey === 'time_asc') rows.sort((a, b) => new Date(a.failed_at).getTime() - new Date(b.failed_at).getTime());
    if (sortKey === 'time_desc') rows.sort((a, b) => new Date(b.failed_at).getTime() - new Date(a.failed_at).getTime());

    return rows;
  })();

  const hasFilters = search || filterClass || filterOutcome || sortKey;
  const totalPages = Math.ceil(displayedTransactions.length / PAGE_SIZE);
  const pagedTransactions = displayedTransactions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setCurrentPage(1); }, [search, filterClass, filterOutcome, sortKey]);

  const recoveredAmount = summary
    ? summary.recovered_amount_paise
    : transactions.filter((t) => t.outcome === 'recovered').reduce((sum, t) => sum + t.amount, 0);

  const suppressedCount = summary
    ? summary.override_count
    : transactions.filter((t) => t.guardrail_status === 'overridden' || t.outcome === 'suppressed').length;

  const failedCount = summary
    ? summary.exception_count
    : transactions.filter((t) => t.failure_class === 'UNKNOWN').length;

  const recoveredCount = summary
    ? summary.recovered_count
    : transactions.filter((t) => t.outcome === 'recovered').length;

  // Build cumulative recovery chart data from transactions sorted by time
  const recoveryChartData = useMemo(() => {
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.failed_at).getTime() - new Date(b.failed_at).getTime(),
    );
    let cumRecovered = 0;
    let cumAtRisk = 0;
    const points: { label: string; recovered: number; atRisk: number }[] = [];
    for (const t of sorted) {
      cumAtRisk += t.amount;
      if (t.outcome === 'recovered') cumRecovered += t.amount;
      points.push({
        label: new Date(t.failed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        recovered: Math.floor(cumRecovered / 100),
        atRisk: Math.floor(cumAtRisk / 100),
      });
    }
    return points;
  }, [transactions]);

  const TABLE_SCROLL_Y = 300;

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
      title: 'Outreach',
      key: 'outreach',
      width: 100,
      render: (_: unknown, record: Transaction) => {
        if (record.outcome === 'recovered' || record.outcome === 'suppressed') return <span className="text-[11px] text-[#d1d5db]">—</span>;
        const rec = getOutreachRecommendation(record);
        return (
          <Tooltip title={rec.reason}>
            <div className="flex items-center gap-1.5">
              {rec.method === 'call'
                ? <PhoneOutlined className="text-[12px] text-[#22c55e]" style={{ transform: 'scaleX(-1)' }} />
                : <MailOutlined className="text-[12px] text-[#528FF0]" />
              }
              <span className="text-[12px] text-[#3b4055]">{rec.method === 'call' ? 'Call' : 'Email'}</span>
            </div>
          </Tooltip>
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
          contacted: {
            label: 'Email sent',
            icon: <MailOutlined className="text-[11px] text-[#528FF0]" />,
            style: 'text-[#528FF0] font-medium',
          },
          escalated: {
            label: 'Escalated',
            icon: <ExclamationCircleOutlined className="text-[11px] text-[#d97706]" />,
            style: 'text-[#d97706] font-medium',
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
    <div className="flex flex-col min-h-0" style={{ minHeight: 'calc(100vh - 80px)', overflow: 'visible' }}>

      <div className="flex-none">

        {/* Page Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-[15px] font-semibold text-[#1b1f2b] m-0">Recovery Overview</h1>
            <p className="text-[13px] text-[#7b8294] m-0 mt-1">Measured impact across all payment failures</p>
          </div>
        </div>

        {/* HERO ROW: 4 KPI cards */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {/* Recovered */}
          <div className="bg-white rounded-lg border border-[#e5e8ec] px-5 flex flex-col justify-center" style={{ minHeight: 140 }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] text-[#9ca3af] font-semibold uppercase tracking-wider">Recovered</div>
              <div className="text-[11px] text-[#6b7280] bg-[#f3f4f6] rounded-full px-2.5 py-0.5 font-medium">
                {summary?.recovery_rate || 0}%
              </div>
            </div>
            <div className="text-[30px] font-extrabold text-[#1b1f2b] tracking-tight leading-none mb-1.5">
              ₹{Math.floor(recoveredAmount / 100).toLocaleString('en-IN')}
            </div>
            <div className="text-[12px] text-[#16a34a] font-medium mb-3">
              {recoveredCount} {recoveredCount === 1 ? 'payment' : 'payments'} recovered
            </div>
            <div className="h-2 bg-[#f3f4f6] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#22c55e] rounded-full transition-all"
                style={{ width: `${Math.min(summary?.recovery_rate || 0, 100)}%` }}
              />
            </div>
          </div>

          {/* At Risk */}
          <div className="bg-white rounded-lg border border-[#e5e8ec] px-5 flex flex-col justify-center" style={{ minHeight: 140 }}>
            <div className="text-[11px] text-[#9ca3af] font-semibold uppercase tracking-wider mb-3">At Risk</div>
            <div className="text-[30px] font-extrabold text-[#1b1f2b] tracking-tight leading-none mb-1.5">
              ₹{Math.floor(Math.max(0, (summary?.total_at_risk_paise || 0) - recoveredAmount) / 100).toLocaleString('en-IN')}
            </div>
            <div className="text-[12px] text-[#9ca3af]">
              {transactions.length} failures tracked
              {recoveredAmount > 0 && (
                <span className="text-[#22c55e] ml-1">
                  · ₹{Math.floor(recoveredAmount / 100).toLocaleString('en-IN')} recovered
                  ({Math.round((recoveredAmount / (summary?.total_at_risk_paise || 1)) * 100)}%)
                </span>
              )}
            </div>
          </div>

          {/* Guardrail Overrides */}
          <div className="bg-white rounded-lg border border-[#e5e8ec] px-5 flex flex-col justify-center" style={{ minHeight: 140 }}>
            <div className="text-[11px] text-[#9ca3af] font-semibold uppercase tracking-wider mb-3">Overrides</div>
            <div className="text-[30px] font-extrabold text-[#1b1f2b] tracking-tight leading-none mb-1.5">
              {suppressedCount}
            </div>
            <div className="text-[12px] text-[#9ca3af]">guardrail corrections</div>
          </div>

          {/* Escalated */}
          <div className="bg-white rounded-lg border border-[#e5e8ec] px-5 flex flex-col justify-center" style={{ minHeight: 140 }}>
            <div className="text-[11px] text-[#9ca3af] font-semibold uppercase tracking-wider mb-3">Escalated</div>
            <div className="text-[30px] font-extrabold text-[#1b1f2b] tracking-tight leading-none mb-1.5">
              {summary?.escalated_count || failedCount}
            </div>
            <div className="text-[12px] text-[#9ca3af]">to human review</div>
          </div>
        </div>

        {/* Recovery Timeline Chart */}
        {/* Recovery Timeline Chart */}
        <div className="bg-white rounded-lg border border-[#e5e8ec] px-5 py-4 mb-5">
          <div className="text-[11px] text-[#9ca3af] font-semibold uppercase tracking-wider mb-3">Recovery Timeline</div>
          {recoveryChartData.length === 0 ? (
            <div className="flex items-center justify-center h-[160px] text-[13px] text-[#c4cdd5]">
              Simulate payment failures to see the recovery timeline
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={recoveryChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradAtRisk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#e5e8ec" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#e5e8ec" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="gradRecovered" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={50} tickFormatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} />
                <RechartsTooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e8ec', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                />
                <Area type="monotone" dataKey="atRisk" stroke="#d1d5db" strokeWidth={1.5} fill="url(#gradAtRisk)" />
                <Area type="monotone" dataKey="recovered" stroke="#22c55e" strokeWidth={2} fill="url(#gradRecovered)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
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
                { value: 'contacted', label: 'Email Sent' },
                { value: 'escalated', label: 'Escalated' },
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

      {/* TABLE — only this scrolls */}
      {transactions.length === 0 ? (
        <Empty description="No failure events found. Ingest some data via POST /ingest/webhook" />
      ) : (
        <div
          className="rounded-lg border border-[#e5e8ec] bg-white overflow-hidden flex-none"
          style={{ height: 344 }}
        >
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
              scroll={{ x: 950, y: TABLE_SCROLL_Y }}
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
        {drawerTxn && <TransactionDetail txn={drawerTxn} onClose={() => setDrawerTxn(null)} onRefresh={loadData} />}
      </Drawer>
    </div>
    </div>
  );
}

interface OutreachRec {
  method: 'call' | 'email';
  reason: string;
  score: number;
}

function getOutreachRecommendation(txn: Transaction): OutreachRec {
  // If email already sent but not recovered → escalate to voice call
  if (txn.outcome === 'contacted') {
    return { method: 'call', reason: 'Email already sent — escalating to voice call', score: 5 };
  }
  if (txn.outcome === 'escalated') {
    return { method: 'call', reason: 'Case escalated — needs direct customer contact', score: 5 };
  }

  // Align with agent's recommended action
  const action = (txn.proposed_action || '').toLowerCase();
  const isAgentEmail = action.includes('email') || action.includes('contact');
  const isAgentRetry = action.includes('retry');

  const amountRs = txn.amount / 100;

  // HARD/MANDATE + high value → voice call even if agent said email
  if ((txn.failure_class === 'HARD' || txn.failure_class === 'MANDATE') && amountRs >= 3000) {
    return { method: 'call', reason: `${txn.failure_class === 'HARD' ? 'Hard decline' : 'Mandate failure'} on ₹${amountRs.toLocaleString('en-IN')} — voice call for guided resolution`, score: 4 };
  }

  // If agent recommended email/contact → outreach via email
  if (isAgentEmail) {
    return { method: 'email', reason: 'Agent recommended customer outreach via email', score: 3 };
  }

  // If agent recommended retry → email as backup notification
  if (isAgentRetry) {
    return { method: 'email', reason: 'Retry scheduled — email as backup if retry fails', score: 2 };
  }

  // High-value → voice call
  if (amountRs >= 10000) {
    return { method: 'call', reason: 'High-value payment (₹' + amountRs.toLocaleString('en-IN') + ') — personal outreach recommended', score: 4 };
  }

  // Default: email
  return { method: 'email', reason: 'Standard outreach via email', score: 2 };
}

function DetailBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1b1f2b] border border-[#e5e8ec] rounded-full px-2.5 py-[3px]">
      {icon}
      {label}
    </span>
  );
}

function TransactionDetail({ txn, onClose, onRefresh }: { txn: Transaction; onClose: () => void; onRefresh: () => void }) {
  const actionType = getActionType(txn.proposed_action);
  const [showGuardrailChecks, setShowGuardrailChecks] = useState(false);
  const [showShaclDetails, setShowShaclDetails] = useState(false);
  const [showDataGraph, setShowDataGraph] = useState(false);
  const [showEmailPreview, setShowEmailPreview] = useState(false);
  const [emailAction, setEmailAction] = useState<'idle' | 'loading' | 'approved' | 'denied'>('idle');
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [draftSubject, setDraftSubject] = useState(txn.email_draft?.subject ?? '');
  const [draftBody, setDraftBody] = useState(txn.email_draft?.body ?? '');
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const outcomeIcon: Record<string, React.ReactNode> = {
    recovered: <CheckCircleFilled className="text-[13px] text-[#22c55e]" />,
    contacted: <MailOutlined className="text-[13px] text-[#528FF0]" />,
    escalated: <ExclamationCircleOutlined className="text-[13px] text-[#d97706]" />,
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
            <DetailBadge icon={outcomeIcon[txn.outcome]} label={txn.outcome === 'recovered' ? 'Recovered' : txn.outcome === 'contacted' ? 'Email Sent' : txn.outcome === 'escalated' ? 'Escalated' : txn.outcome === 'failed' ? 'Failed' : txn.outcome === 'suppressed' ? 'Suppressed' : 'Pending'} />
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

          {/* Outreach Recommendation */}
          {txn.outcome !== 'recovered' && txn.outcome !== 'suppressed' && (() => {
            const rec = getOutreachRecommendation(txn);
            const isCall = rec.method === 'call';
            return (
              <div className="mb-5">
                <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Outreach Channel</div>
                <div className="flex items-center gap-3 mb-2">
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium ${isCall ? 'bg-[#f0fdf4] text-[#22c55e] border border-[#22c55e]' : 'border border-[#e5e8ec] text-[#7b8294]'}`}>
                    <PhoneOutlined className="text-[12px]" style={{ transform: 'scaleX(-1)' }} />
                    Voice Call
                    {isCall && <span className="text-[10px] bg-[#22c55e] text-white px-1.5 py-[1px] rounded-full ml-1">Recommended</span>}
                  </div>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium ${!isCall ? 'bg-[#f0fdf4] text-[#22c55e] border border-[#22c55e]' : 'border border-[#e5e8ec] text-[#7b8294]'}`}>
                    <MailOutlined className="text-[12px]" />
                    Email
                    {!isCall && <span className="text-[10px] bg-[#22c55e] text-white px-1.5 py-[1px] rounded-full ml-1">Recommended</span>}
                  </div>
                </div>
                <div className="text-[12px] text-[#7b8294] leading-relaxed">{rec.reason}</div>
              </div>
            );
          })()}

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
          {txn.agent_reasoning === 'No reasoning available' && txn.guardrail_checks.length === 0 ? (
            <div className="flex flex-col items-center py-6 gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#e5e8ec] border-t-[#528FF0]" />
              <div className="space-y-1.5 text-center">
                <span className="text-[13px] font-medium text-[#1b1f2b] block">Agent processing...</span>
                <span className="text-[11px] text-[#7b8294] block">Reasoning about recovery strategy and drafting email</span>
              </div>
            </div>
          ) : (
            <div className="text-[13px] text-[#4b5563] leading-[1.7]">
              {txn.agent_reasoning}
            </div>
          )}
        </div>

        {/* Guardrail */}
        <div className="px-6 py-4 border-t border-[#f0f0f0]">
          <button
            onClick={() => setShowGuardrailChecks(!showGuardrailChecks)}
            className="w-full flex items-center justify-between bg-transparent border-0 cursor-pointer p-0"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">Guardrail</span>
              {txn.agent_reasoning === 'No reasoning available' && txn.guardrail_checks.length === 0 ? (
                <span className="text-[11px] text-[#7b8294]">Waiting for agent...</span>
              ) : (
                <span className={`text-[11px] ${txn.guardrail_checks.every((c) => c.passed) ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                  {txn.guardrail_status === 'overridden'
                    ? 'Override applied'
                    : `${txn.guardrail_checks.filter((c) => c.passed).length}/${txn.guardrail_checks.length} passed`}
                </span>
              )}
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
            {txn.email_draft.status === 'sent' || txn.outcome === 'contacted' ? (
              <>
                <div className="flex flex-col items-center py-5">
                  <img src={sealCheckSvg} alt="" className="w-[40px] h-[40px] mb-2" />
                  <span className="text-[15px] font-semibold text-[#22c55e]">Email Sent</span>
                  <span className="text-[11.5px] text-[#9ca3af] mt-0.5">Customer contacted successfully</span>
                  <button
                    onClick={() => setShowEmailPreview(!showEmailPreview)}
                    className="mt-3 text-[11px] font-medium text-[#528FF0] bg-transparent border border-[#528FF0] rounded-md px-3 py-1 cursor-pointer hover:bg-[#f0f5ff] transition-colors"
                  >
                    {showEmailPreview ? 'Hide Preview' : 'Preview Email'}
                  </button>
                </div>

                {showEmailPreview && (
                  <div className="border border-[#e5e8ec] rounded-lg p-4 mt-1">
                    <div className="text-[11.5px] text-[#9ca3af] mb-1">To: {txn.customer_email}</div>
                    <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2.5">{txn.email_draft.subject}</div>
                    <div className="text-[12px] text-[#6b7280] leading-[1.65] whitespace-pre-line border-t border-[#f0f0f0] pt-2.5">
                      {txn.email_draft.body}
                    </div>
                  </div>
                )}
              </>
            ) : txn.email_draft.status === 'pending_approval' && txn.pending_email_action_id ? (
              <>
                {emailAction === 'approved' ? (
                  <>
                    <div className="flex flex-col items-center py-5">
                      <img src={sealCheckSvg} alt="" className="w-[40px] h-[40px] mb-2" />
                      <span className="text-[15px] font-semibold text-[#22c55e]">Email Sent</span>
                      <span className="text-[11.5px] text-[#9ca3af] mt-0.5">Customer contacted successfully</span>
                      <button
                        onClick={() => setShowEmailPreview(!showEmailPreview)}
                        className="mt-3 text-[11px] font-medium text-[#528FF0] bg-transparent border border-[#528FF0] rounded-md px-3 py-1 cursor-pointer hover:bg-[#f0f5ff] transition-colors"
                      >
                        {showEmailPreview ? 'Hide Preview' : 'Preview Email'}
                      </button>
                    </div>
                    {showEmailPreview && (
                      <div className="border border-[#e5e8ec] rounded-lg p-4 mt-1">
                        <div className="text-[11.5px] text-[#9ca3af] mb-1">To: {txn.customer_email}</div>
                        <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2.5">{txn.email_draft.subject}</div>
                        <div className="text-[12px] text-[#6b7280] leading-[1.65] whitespace-pre-line border-t border-[#f0f0f0] pt-2.5">
                          {txn.email_draft.body}
                        </div>
                      </div>
                    )}
                  </>
                ) : emailAction === 'denied' ? (
                  <div className="flex flex-col items-center py-5">
                    <CloseCircleFilled className="text-[28px] text-[#ef4444] mb-1.5" />
                    <span className="text-[15px] font-semibold text-[#ef4444]">Email Denied</span>
                    <span className="text-[11.5px] text-[#9ca3af] mt-0.5">Email blocked by reviewer</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <MailOutlined className="text-[13px] text-[#d97706]" />
                        <span className="text-[13px] font-semibold text-[#1b1f2b]">Email Draft</span>
                      </div>
                      <span className="text-[11px] text-[#d97706] bg-[#fffbeb] border border-[#fde68a] rounded-full px-2 py-0.5 font-semibold">Awaiting Approval</span>
                    </div>

                    <div className="text-[11.5px] text-[#9ca3af] mb-3">
                      {humanReason(txn.decline_reason)} · Agent recommended {txn.proposed_action.toLowerCase()}
                    </div>

                    <div className="border border-[#e5e8ec] rounded-lg p-4">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="text-[11.5px] text-[#9ca3af]">To: {txn.customer_email}</div>
                        {!isEditingEmail && (
                          <button
                            onClick={() => setIsEditingEmail(true)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#528FF0] bg-transparent border-0 cursor-pointer hover:text-[#2563eb]"
                          >
                            <EditOutlined /> Edit email
                          </button>
                        )}
                      </div>
                      {isEditingEmail ? (
                        <div className="flex flex-col gap-3 pt-3">
                          <Input value={draftSubject} onChange={(event) => setDraftSubject(event.target.value)} placeholder="Email subject" />
                          <Input.TextArea
                            value={draftBody}
                            onChange={(event) => setDraftBody(event.target.value)}
                            autoSize={{ minRows: 6, maxRows: 12 }}
                            placeholder="Email body"
                          />
                          <div className="flex justify-end gap-2 pt-1">
                            <Button size="small" onClick={() => {
                              setDraftSubject(txn.email_draft!.subject);
                              setDraftBody(txn.email_draft!.body);
                              setIsEditingEmail(false);
                            }}>Cancel</Button>
                            <Button
                              size="small"
                              type="primary"
                              loading={isSavingEmail}
                              disabled={!draftSubject.trim() || !draftBody.trim()}
                              className="!bg-[#1b1f2b] !border-[#1b1f2b] hover:!bg-[#343a4a] hover:!border-[#343a4a]"
                              onClick={async () => {
                                setIsSavingEmail(true);
                                try {
                                  const updatedDraft = await updateEmailDraft(txn.pending_email_action_id!, {
                                    subject: draftSubject.trim(),
                                    body: draftBody.trim(),
                                  });
                                  setDraftSubject(updatedDraft.subject);
                                  setDraftBody(updatedDraft.body);
                                  setIsEditingEmail(false);
                                  onRefresh();
                                  message.success('Email draft saved');
                                } catch {
                                  message.error('Could not save the email draft. Please try again.');
                                } finally {
                                  setIsSavingEmail(false);
                                }
                              }}
                            >Save changes</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2.5">{draftSubject}</div>
                          <div className="text-[12px] text-[#6b7280] leading-[1.65] whitespace-pre-line border-t border-[#f0f0f0] pt-2.5">
                            {draftBody}
                          </div>
                        </>
                      )}
                    </div>

                    {emailAction === 'loading' ? (
                      <div className="flex items-center justify-center py-6 mt-3">
                        <Spin />
                        <span className="ml-3 text-[13px] text-[#7b8294]">Sending email...</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mt-4">
                        <button
                          onClick={async () => {
                            setEmailAction('loading');
                            try {
                              const res = await approveEmail(txn.pending_email_action_id!);
                              if (res.status === 'SUCCEEDED') {
                                setEmailAction('approved');
                              } else {
                                setEmailAction('idle');
                              }
                              setTimeout(() => onRefresh(), 1500);
                            } catch {
                              setEmailAction('idle');
                            }
                          }}
                          className="flex-1 text-[12px] font-semibold text-white bg-[#1b1f2b] border-0 rounded-lg px-4 py-2 cursor-pointer hover:opacity-90 transition-opacity"
                        >
                          Allow
                        </button>
                        <button
                          onClick={async () => {
                            setEmailAction('loading');
                            try {
                              await denyEmail(txn.pending_email_action_id!);
                              setEmailAction('denied');
                              setTimeout(() => onRefresh(), 1500);
                            } catch {
                              setEmailAction('idle');
                            }
                          }}
                          className="flex-1 text-[12px] font-semibold text-[#ef4444] bg-white border border-[#e5e8ec] rounded-lg px-4 py-2 cursor-pointer hover:bg-[#fef2f2] transition-colors"
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {/* Suppressed/Denied state */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <MailOutlined className="text-[13px] text-[#9ca3af]" />
                    <span className="text-[13px] font-semibold text-[#1b1f2b]">Email Draft</span>
                  </div>
                  <span className="text-[11px] text-[#9ca3af] border border-[#e5e8ec] rounded-full px-2 py-0.5">
                    {txn.email_draft.status === 'suppressed' ? 'Suppressed' : 'Blocked'}
                  </span>
                </div>

                <div className="text-[11.5px] text-[#9ca3af] mb-3">
                  {txn.email_draft.suppression_reason || 'Email blocked by guardrail or human review'}
                </div>

                <div className="border border-[#e5e8ec] rounded-lg p-4 opacity-40">
                  <div className="text-[11.5px] text-[#9ca3af] mb-1">To: {txn.customer_email}</div>
                  <div className="text-[13px] font-semibold text-[#1b1f2b] mb-2.5">{txn.email_draft.subject}</div>
                  <div className="text-[12px] text-[#6b7280] leading-[1.65] whitespace-pre-line border-t border-[#f0f0f0] pt-2.5">
                    {txn.email_draft.body}
                  </div>
                </div>
              </>
            )}
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
