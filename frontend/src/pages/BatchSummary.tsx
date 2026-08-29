import { Tag, Typography } from 'antd';
import {
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
import { MOCK_BATCH_STATS } from '../mock/data';

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip, Legend);

const s = MOCK_BATCH_STATS;

function formatRupees(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN');
}

function ComparisonRow({ label, agent, baseline, unit, lower_better }: {
  label: string; agent: string; baseline: string; unit?: string; lower_better?: boolean;
}) {
  const isBetter = lower_better
    ? parseFloat(agent) < parseFloat(baseline)
    : parseFloat(agent) > parseFloat(baseline);

  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <div className="flex items-center gap-8">
        <div className="text-right w-24">
          <span className="text-sm text-slate-400">{baseline}{unit}</span>
        </div>
        <div className="text-right w-24 flex items-center justify-end gap-1">
          <span className="text-sm font-semibold text-slate-800">{agent}{unit}</span>
          {isBetter ? (
            <ArrowUpOutlined className="text-green-500 text-xs" />
          ) : (
            <ArrowDownOutlined className="text-red-500 text-xs" />
          )}
        </div>
      </div>
    </div>
  );
}

export default function BatchSummary() {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Hero Metric */}
      <div className="text-center py-12">
        <div className="text-sm text-slate-400 uppercase tracking-wider mb-2">Incremental Recovery</div>
        <div className="text-5xl font-extrabold text-slate-900 tracking-tight">
          {formatRupees(s.incremental_recovery)}
        </div>
        <div className="text-sm text-slate-400 mt-2">
          95% CI: [{formatRupees(s.ci_lower)} &mdash; {formatRupees(s.ci_upper)}]
        </div>
        <div className="text-xs text-slate-300 mt-1">
          Estimated via {s.ope_method} off-policy evaluation against stochastic baseline
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          { value: `${s.agent_recovery_rate}%`, label: 'Recovery Rate', sub: `vs ${s.baseline_recovery_rate}% baseline`, color: 'text-green-600' },
          { value: s.attempts_saved.toLocaleString(), label: 'Attempts Saved', sub: 'wasted retries prevented', color: 'text-blue-600' },
          { value: s.contacts_suppressed.toLocaleString(), label: 'Contacts Suppressed', sub: 'unnecessary emails avoided', color: 'text-amber-600' },
          { value: `${s.agreement_rate}%`, label: 'Agreement Rate', sub: 'agent-guardrail alignment', color: 'text-slate-700' },
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-5 text-center">
            <div className={`text-3xl font-bold ${stat.color} tracking-tight`}>{stat.value}</div>
            <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">{stat.label}</div>
            <div className="text-xs text-slate-300 mt-0.5">{stat.sub}</div>
          </div>
        ))}
      </div>

      {/* Agent vs Baseline Comparison */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <Typography.Title level={5} className="!mb-0 !text-slate-700">Agent vs Baseline</Typography.Title>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span>Baseline</span>
            <span className="font-semibold text-slate-600">Agent</span>
          </div>
        </div>
        <ComparisonRow label="Recovery Rate" agent={`${s.agent_recovery_rate}`} baseline={`${s.baseline_recovery_rate}`} unit="%" />
        <ComparisonRow label="Attempts per Recovery" agent={`${s.agent_attempts_per_recovery}`} baseline={`${s.baseline_attempts_per_recovery}`} lower_better />
        <ComparisonRow label="Customer Contacts" agent={`${s.agent_contacts}`} baseline={`${s.baseline_contacts}`} lower_better />
        <ComparisonRow label="Avg Time to Recovery" agent={s.avg_time_to_recovery_agent} baseline={s.avg_time_to_recovery_baseline} lower_better />
      </div>

      {/* Recovery by Classification Chart */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 mb-8">
        <Typography.Title level={5} className="!mb-4 !text-slate-700">Recovery Rate by Classification</Typography.Title>
        <div className="h-64">
          <Bar
            data={{
              labels: ['SOFT', 'HARD', 'MANDATE', 'UNKNOWN'],
              datasets: [
                {
                  label: 'Agent',
                  data: [52, 4, 28, 0],
                  backgroundColor: '#2563eb',
                  borderRadius: 4,
                  barPercentage: 0.6,
                },
                {
                  label: 'Baseline',
                  data: [35, 12, 15, 0],
                  backgroundColor: '#cbd5e1',
                  borderRadius: 4,
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
                    padding: 20,
                    font: { size: 12, family: 'Inter' },
                    color: '#64748b',
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
                  max: 60,
                  ticks: {
                    callback: (v) => `${v}%`,
                    color: '#94a3b8',
                    font: { size: 11 },
                  },
                  grid: { color: '#f1f5f9' },
                  border: { display: false },
                },
                x: {
                  ticks: { color: '#64748b', font: { size: 12 } },
                  grid: { display: false },
                  border: { display: false },
                },
              },
            }}
          />
        </div>
      </div>

      {/* Agent narrative */}
      <div className="bg-slate-50 border-l-3 border-l-blue-500 rounded-r-md px-5 py-4 text-sm text-slate-600 leading-relaxed mb-8">
        The doubly-robust estimator shows a +{(s.agent_recovery_rate - s.baseline_recovery_rate).toFixed(1)}pp lift
        in recovery rate. {s.attempts_saved} retry attempts were saved that the baseline would have wasted on
        dead instruments. {s.contacts_suppressed} customers were not contacted because the agent determined
        outreach was unnecessary. The agent and guardrails agreed on {s.agreement_rate}% of decisions.
      </div>

      {/* Classification Breakdown */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <Typography.Title level={5} className="!mb-4 !text-slate-700">By Classification</Typography.Title>
        <div className="grid grid-cols-4 gap-4">
          {[
            { cls: 'SOFT', count: 800, rate: '52%', color: 'orange' as const, note: 'Retry success rate' },
            { cls: 'HARD', count: 600, rate: '4%', color: 'red' as const, note: 'Correctly suppressed' },
            { cls: 'MANDATE', count: 300, rate: '28%', color: 'blue' as const, note: 'Re-authorized via email' },
            { cls: 'UNKNOWN', count: 300, rate: '—', color: 'default' as const, note: 'Routed to human queue' },
          ].map((item) => (
            <div key={item.cls} className="text-center py-3">
              <Tag color={item.color} className="mb-2">{item.cls}</Tag>
              <div className="text-2xl font-bold text-slate-800">{item.count}</div>
              <div className="text-xs text-slate-400">{item.rate} recovered</div>
              <div className="text-xs text-slate-300">{item.note}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
