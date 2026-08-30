import { useState, useEffect } from 'react';
import { Spin, Tooltip } from 'antd';
import {
  InfoCircleOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { fetchOPE, type OPEResult } from '../api/dashboard';

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip, Legend);

function formatRupees(paise: number): string {
  return '\u20B9' + (paise / 100).toLocaleString('en-IN');
}

function ComparisonRow({ label, agent, baseline, unit, lower_better }: {
  label: string; agent: string; baseline: string; unit?: string; lower_better?: boolean;
}) {
  const a = parseFloat(agent);
  const b = parseFloat(baseline);
  const isBetter = lower_better ? a < b : a > b;

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-[#f0f1f3] last:border-0">
      <span className="text-[13px] text-[#7b8294]">{label}</span>
      <div className="flex items-center gap-8">
        <div className="text-right w-20">
          <span className="text-[13px] text-[#9ca3af]">{baseline}{unit}</span>
        </div>
        <div className="text-right w-20 flex items-center justify-end gap-1">
          <span className="text-[13px] font-semibold text-[#1b1f2b]">{agent}{unit}</span>
          {isBetter ? (
            <ArrowUpOutlined className="text-[#22c55e] text-[10px]" />
          ) : (
            <ArrowDownOutlined className="text-[#ef4444] text-[10px]" />
          )}
        </div>
      </div>
    </div>
  );
}

export default function BatchSummary() {
  const [data, setData] = useState<OPEResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<'dr' | 'ips'>('dr');

  useEffect(() => {
    setLoading(true);
    fetchOPE({ method, split: 'holdout' })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [method]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Spin size="large" /></div>;
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ height: '60vh' }}>
        <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="#d9d9d9" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
        </svg>
        <p className="text-[15px] font-semibold text-[#6b7280] mt-5">Backend Unavailable</p>
        <p className="text-[13px] text-[#9ca3af] mt-1">Could not run OPE evaluation</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-1.5 text-[13px] font-medium text-[#528FF0] border border-[#528FF0] rounded-md hover:bg-[#528FF0] hover:text-white transition-colors cursor-pointer">Retry</button>
      </div>
    );
  }

  if (data.n_transactions === 0) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ height: '60vh' }}>
        <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="#d9d9d9" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
        </svg>
        <p className="text-[15px] font-semibold text-[#6b7280] mt-5">No Processed Transactions</p>
        <p className="text-[13px] text-[#9ca3af] mt-1">Ingest transactions through the agent pipeline to see OPE results</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-1.5 text-[13px] font-medium text-[#528FF0] border border-[#528FF0] rounded-md hover:bg-[#528FF0] hover:text-white transition-colors cursor-pointer">Refresh</button>
      </div>
    );
  }

  const s = data;
  const lift = s.agent_recovery_rate - s.baseline_recovery_rate;
  const classOrder = Object.keys(s.by_class);
  const chartAgentData = classOrder.map((c) => s.by_class[c]?.agent_rate ?? 0);
  const chartBaselineData = classOrder.map((c) => s.by_class[c]?.baseline_rate ?? 0);

  return (
    <div className="flex flex-col h-full overflow-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-none">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Recovery Impact</span>
        <div className="flex items-center gap-1 bg-[#f5f6f8] rounded-md p-0.5">
          {(['dr', 'ips'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`text-[11px] px-2.5 py-1 rounded transition-colors cursor-pointer border-0 ${
                method === m
                  ? 'bg-white text-[#1b1f2b] font-semibold shadow-sm'
                  : 'bg-transparent text-[#9ca3af] hover:text-[#3b4055]'
              }`}
            >
              {m === 'dr' ? 'Doubly Robust' : 'IPS'}
            </button>
          ))}
        </div>
      </div>

      {/* Hero — Incremental Recovery */}
      <div className="bg-white rounded-lg border border-[#e5e8ec] px-6 py-6 mb-4 text-center flex-none">
        <div className="text-[12px] text-[#7b8294] uppercase tracking-wider mb-2 flex items-center justify-center gap-1">
          Incremental Recovery
          <Tooltip title={`Estimated via ${s.method} off-policy evaluation against stochastic baseline on ${s.n_transactions} holdout transactions`}>
            <InfoCircleOutlined className="text-[#c4c9d4] text-[11px] cursor-help" />
          </Tooltip>
        </div>
        <div className="text-[40px] font-extrabold text-[#1b1f2b] tracking-tight leading-none">
          {formatRupees(s.incremental_recovery_paise)}
        </div>
        <div className="text-[12px] text-[#9ca3af] mt-2">
          95% CI: [{formatRupees(s.ci_lower_paise)} &mdash; {formatRupees(s.ci_upper_paise)}]
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-3 mb-5 flex-none">
        {[
          { value: `${s.agent_recovery_rate}%`, label: 'Recovery Rate', sub: `vs ${s.baseline_recovery_rate}% baseline`, color: '#22c55e' },
          { value: String(s.attempts_saved), label: 'Attempts Saved', sub: 'wasted retries prevented', color: '#528FF0' },
          { value: String(s.contacts_suppressed), label: 'Contacts Suppressed', sub: 'unnecessary emails avoided', color: '#d97706' },
          { value: `${s.agreement_rate}%`, label: 'Agreement Rate', sub: 'agent-guardrail alignment', color: '#1b1f2b' },
        ].map((stat) => (
          <div key={stat.label} className="bg-white rounded-lg border border-[#e5e8ec] px-4 py-3.5 text-center">
            <div className="text-[24px] font-extrabold leading-none" style={{ color: stat.color }}>{stat.value}</div>
            <div className="text-[10px] text-[#9ca3af] uppercase tracking-wider mt-1.5">{stat.label}</div>
            <div className="text-[10px] text-[#c4c9d4] mt-0.5">{stat.sub}</div>
          </div>
        ))}
      </div>

      {/* Agent vs Baseline + Chart — side by side */}
      <div className="grid grid-cols-2 gap-4 mb-5 flex-none">
        {/* Comparison */}
        <div className="bg-white rounded-lg border border-[#e5e8ec] p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-semibold text-[#1b1f2b]">Agent vs Baseline</span>
            <div className="flex items-center gap-4 text-[10px] text-[#9ca3af]">
              <span>Baseline</span>
              <span className="font-semibold text-[#1b1f2b]">Agent</span>
            </div>
          </div>
          <ComparisonRow label="Recovery Rate" agent={`${s.agent_recovery_rate}`} baseline={`${s.baseline_recovery_rate}`} unit="%" />
          <ComparisonRow label="Attempts / Recovery" agent={`${s.agent_attempts_per_recovery}`} baseline={`${s.baseline_attempts_per_recovery}`} lower_better />
          <ComparisonRow label="Customer Contacts" agent={`${s.agent_contacts}`} baseline={`${s.baseline_contacts}`} lower_better />
          <ComparisonRow label="Avg Time to Recovery" agent={`${s.avg_time_to_recovery_agent_hours}h`} baseline={`${s.avg_time_to_recovery_baseline_hours}h`} lower_better />
        </div>

        {/* Chart */}
        <div className="bg-white rounded-lg border border-[#e5e8ec] p-5">
          <span className="text-[13px] font-semibold text-[#1b1f2b] block mb-3">Recovery Rate by Classification</span>
          <div className="h-48">
            <Bar
              data={{
                labels: classOrder,
                datasets: [
                  {
                    label: 'Agent',
                    data: chartAgentData,
                    backgroundColor: '#528FF0',
                    borderRadius: 3,
                    barPercentage: 0.6,
                  },
                  {
                    label: 'Baseline',
                    data: chartBaselineData,
                    backgroundColor: '#e5e8ec',
                    borderRadius: 3,
                    barPercentage: 0.6,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    position: 'top' as const,
                    labels: {
                      usePointStyle: true,
                      pointStyle: 'rectRounded',
                      padding: 16,
                      font: { size: 11 },
                      color: '#7b8294',
                    },
                  },
                  tooltip: {
                    callbacks: {
                      label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}%`,
                    },
                  },
                },
                scales: {
                  y: {
                    beginAtZero: true,
                    ticks: {
                      callback: (v) => `${v}%`,
                      color: '#9ca3af',
                      font: { size: 10 },
                    },
                    grid: { color: '#f5f6f8' },
                    border: { display: false },
                  },
                  x: {
                    ticks: { color: '#7b8294', font: { size: 11 } },
                    grid: { display: false },
                    border: { display: false },
                  },
                },
              }}
            />
          </div>
        </div>
      </div>

      {/* Narrative */}
      <div className="bg-[#f8f9fb] border-l-[3px] border-l-[#528FF0] rounded-r-md px-5 py-3.5 text-[13px] text-[#3b4055] leading-relaxed flex-none">
        The {s.method.toLowerCase()} estimator shows a <span className="font-semibold">+{lift.toFixed(1)}pp lift</span> in
        recovery rate over the stochastic baseline. <span className="font-semibold">{s.attempts_saved}</span> retry
        attempts were saved that the baseline would have wasted on dead instruments.{' '}
        <span className="font-semibold">{s.contacts_suppressed}</span> customers were not contacted because the agent
        determined outreach was unnecessary. The agent and guardrails agreed on{' '}
        <span className="font-semibold">{s.agreement_rate}%</span> of decisions.
      </div>

      {/* Classification Breakdown */}
      <div className={`grid gap-3 mt-5 flex-none`} style={{ gridTemplateColumns: `repeat(${classOrder.length}, minmax(0, 1fr))` }}>
        {classOrder.map((cls) => {
          const d = s.by_class[cls];
          const total = d?.total ?? 0;
          const agentRate = d?.agent_rate ?? 0;
          const baselineRate = d?.baseline_rate ?? 0;
          return (
            <div key={cls} className="bg-white rounded-lg border border-[#e5e8ec] px-4 py-3.5 text-center">
              <span className="text-[11px] font-semibold text-[#7b8294] uppercase tracking-wider">{cls}</span>
              <div className="text-[22px] font-extrabold text-[#1b1f2b] leading-none mt-1">{total}</div>
              <div className="text-[11px] text-[#22c55e] font-medium mt-0.5">{agentRate}% recovered</div>
              <div className="text-[10px] text-[#c4c9d4] mt-0.5">vs {baselineRate}% baseline</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
