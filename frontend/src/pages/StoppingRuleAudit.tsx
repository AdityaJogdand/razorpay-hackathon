import { Table, Tag, Typography, Progress } from 'antd';
import { useNavigate } from 'react-router-dom';
import { MOCK_STOPPING_RULES, type StoppingRule } from '../mock/data';

export default function StoppingRuleAudit() {
  const navigate = useNavigate();

  const totalEvaluated = MOCK_STOPPING_RULES.reduce((sum, r) => sum + r.times_evaluated, 0);
  const totalFired = MOCK_STOPPING_RULES.reduce((sum, r) => sum + r.times_fired, 0);
  const overrideRules = MOCK_STOPPING_RULES.filter((r) => r.times_fired > 0 && r.id !== 'G6');

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
      render: (v: string) => <code className="text-xs text-slate-400">{v}</code>,
    },
    {
      title: 'Rule',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: StoppingRule) => (
        <div>
          <div className="text-sm font-medium text-slate-700">{name}</div>
          <div className="text-xs text-slate-400">{record.description}</div>
        </div>
      ),
    },
    {
      title: 'Evaluated',
      dataIndex: 'times_evaluated',
      key: 'times_evaluated',
      width: 100,
      sorter: (a: StoppingRule, b: StoppingRule) => a.times_evaluated - b.times_evaluated,
      render: (v: number) => <span className="text-sm text-slate-600">{v.toLocaleString()}</span>,
    },
    {
      title: 'Fired',
      dataIndex: 'times_fired',
      key: 'times_fired',
      width: 80,
      sorter: (a: StoppingRule, b: StoppingRule) => a.times_fired - b.times_fired,
      defaultSortOrder: 'descend' as const,
      render: (v: number) => (
        <span className={`text-sm font-semibold ${v > 0 ? 'text-amber-600' : 'text-slate-300'}`}>
          {v.toLocaleString()}
        </span>
      ),
    },
    {
      title: 'Fire Rate',
      dataIndex: 'fire_rate',
      key: 'fire_rate',
      width: 140,
      sorter: (a: StoppingRule, b: StoppingRule) => a.fire_rate - b.fire_rate,
      render: (v: number) => (
        <Progress
          percent={Math.min(v, 100)}
          size="small"
          strokeColor={v > 50 ? '#ef4444' : v > 10 ? '#f59e0b' : '#94a3b8'}
          format={() => `${v}%`}
          className="w-24"
        />
      ),
    },
    {
      title: 'Examples',
      key: 'examples',
      width: 160,
      render: (_: unknown, record: StoppingRule) =>
        record.example_txn_ids.length > 0 ? (
          <div className="flex gap-1 flex-wrap">
            {record.example_txn_ids.slice(0, 2).map((id) => (
              <Tag
                key={id}
                className="cursor-pointer text-xs m-0"
                color="blue"
                onClick={() => navigate('/trace')}
              >
                {id}
              </Tag>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        ),
    },
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Typography.Title level={4} className="!mb-1 !text-slate-800">Guardrail Audit</Typography.Title>
        <div className="text-sm text-slate-500">
          How stopping rules governed agent decisions this batch
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { value: totalEvaluated.toLocaleString(), label: 'Rules Evaluated', color: 'text-slate-700' },
          { value: totalFired.toLocaleString(), label: 'Rules Fired', color: 'text-amber-600' },
          { value: `${((totalFired / totalEvaluated) * 100).toFixed(1)}%`, label: 'Overall Fire Rate', color: 'text-slate-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-4 text-center">
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
            <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-lg">
        <Table
          dataSource={MOCK_STOPPING_RULES}
          columns={columns}
          rowKey="id"
          pagination={false}
        />
      </div>

      {/* Agent narrative */}
      <div className="bg-slate-50 border-l-3 border-l-blue-500 rounded-r-md px-5 py-4 text-sm text-slate-600 leading-relaxed mt-6">
        The "Hard decline: no retry" rule fired {MOCK_STOPPING_RULES[0].times_fired} times.
        In {overrideRules.reduce((s, r) => s + r.times_fired, 0) - MOCK_STOPPING_RULES[0].times_fired - MOCK_STOPPING_RULES[5].times_fired} cases,
        the agent initially recommended an action that a guardrail corrected.
        This demonstrates the safety architecture: the agent reasons freely, but deterministic rules enforce boundaries.
      </div>
    </div>
  );
}
