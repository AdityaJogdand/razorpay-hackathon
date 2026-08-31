import { useState, useEffect } from 'react';
import { Table, Tag, Progress, Spin, Empty } from 'antd';
import { useNavigate } from 'react-router-dom';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { fetchGuardrailInfo, fetchDashboardEvents, type GuardrailRule, type DashboardEvent } from '../api/dashboard';

interface RuleStats {
  name: string;
  description: string;
  policy: string;
  times_evaluated: number;
  times_fired: number;
  fire_rate: number;
  example_event_ids: string[];
}

export default function StoppingRuleAudit() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<RuleStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [guardrailInfo, eventsData] = await Promise.all([
        fetchGuardrailInfo(),
        fetchDashboardEvents({ limit: 200 }),
      ]);

      const ruleStats = buildRuleStats(guardrailInfo.rules, eventsData.events);
      setRules(ruleStats);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  };

  function buildRuleStats(ruleDefinitions: GuardrailRule[], events: DashboardEvent[]): RuleStats[] {
    const statsMap = new Map<string, { evaluated: number; fired: number; examples: string[] }>();

    for (const rule of ruleDefinitions) {
      statsMap.set(rule.name, { evaluated: 0, fired: 0, examples: [] });
    }

    for (const event of events) {
      if (!event.guardrail?.checks) continue;
      for (const check of event.guardrail.checks) {
        const ruleName = check.rule;
        let stat = statsMap.get(ruleName);
        if (!stat) {
          stat = { evaluated: 0, fired: 0, examples: [] };
          statsMap.set(ruleName, stat);
        }
        stat.evaluated++;
        if (!check.passed) {
          stat.fired++;
          if (stat.examples.length < 3) {
            stat.examples.push(event.transaction_id || event.id.slice(0, 12));
          }
        }
      }
    }

    return ruleDefinitions.map((rule) => {
      const stat = statsMap.get(rule.name) || { evaluated: 0, fired: 0, examples: [] };
      return {
        name: rule.name,
        description: rule.description,
        policy: rule.policy,
        times_evaluated: stat.evaluated,
        times_fired: stat.fired,
        fire_rate: stat.evaluated > 0 ? Math.round((stat.fired / stat.evaluated) * 1000) / 10 : 0,
        example_event_ids: stat.examples,
      };
    });
  }

  const totalEvaluated = rules.reduce((sum, r) => sum + r.times_evaluated, 0);
  const totalFired = rules.reduce((sum, r) => sum + r.times_fired, 0);

  const columns = [
    {
      title: 'Rule',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: RuleStats) => (
        <div>
          <div className="text-[13px] font-semibold text-[#1b1f2b]">{name.replace(/_/g, ' ')}</div>
          <div className="text-[11px] text-[#9ca3af]">{record.description}</div>
        </div>
      ),
    },
    {
      title: 'Policy',
      dataIndex: 'policy',
      key: 'policy',
      width: 200,
      render: (v: string) => <span className="text-[11px] text-[#7b8294] leading-snug">{v}</span>,
    },
    {
      title: 'Evaluated',
      dataIndex: 'times_evaluated',
      key: 'times_evaluated',
      width: 90,
      sorter: (a: RuleStats, b: RuleStats) => a.times_evaluated - b.times_evaluated,
      render: (v: number) => <span className="text-[13px] text-[#3b4055]">{v.toLocaleString()}</span>,
    },
    {
      title: 'Fired',
      dataIndex: 'times_fired',
      key: 'times_fired',
      width: 70,
      sorter: (a: RuleStats, b: RuleStats) => a.times_fired - b.times_fired,
      defaultSortOrder: 'descend' as const,
      render: (v: number) => (
        <span className={`text-[13px] font-semibold ${v > 0 ? 'text-[#d97706]' : 'text-[#d1d5db]'}`}>
          {v.toLocaleString()}
        </span>
      ),
    },
    {
      title: 'Fire Rate',
      dataIndex: 'fire_rate',
      key: 'fire_rate',
      width: 130,
      sorter: (a: RuleStats, b: RuleStats) => a.fire_rate - b.fire_rate,
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
      render: (_: unknown, record: RuleStats) =>
        record.example_event_ids.length > 0 ? (
          <div className="flex gap-1 flex-wrap">
            {record.example_event_ids.slice(0, 2).map((id) => (
              <Tag
                key={id}
                className="cursor-pointer text-[11px] m-0"
                color="blue"
                onClick={() => navigate('/trace')}
              >
                {id.length > 12 ? id.slice(0, 12) : id}
              </Tag>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-[#d1d5db]">—</span>
        ),
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  const overrideCount = rules.filter(r => r.times_fired > 0).length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Guardrail Audit</span>
        <span className="text-[12px] text-[#9ca3af]">How SHACL guardrail rules governed agent decisions</span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { value: totalEvaluated.toLocaleString(), label: 'Rules Evaluated', color: '#1b1f2b' },
          { value: totalFired.toLocaleString(), label: 'Rules Fired', color: '#d97706' },
          { value: totalEvaluated > 0 ? `${((totalFired / totalEvaluated) * 100).toFixed(1)}%` : '0%', label: 'Overall Fire Rate', color: '#7b8294' },
        ].map((stat, i) => (
          <div key={i} className="border border-[#e5e8ec] rounded-lg p-5 text-center">
            <div className="text-[32px] font-extrabold" style={{ color: stat.color }}>{stat.value}</div>
            <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {rules.length === 0 ? (
        <Empty description="No guardrail data yet. Simulate some payments to see rule activity." />
      ) : (
        <>
          {/* Table */}
          <div className="border border-[#e5e8ec] rounded-lg overflow-hidden">
            <Table
              dataSource={rules}
              columns={columns}
              rowKey="name"
              pagination={false}
              size="small"
            />
          </div>

          {/* Narrative */}
          {overrideCount > 0 && (
            <div className="bg-[#f8fafc] border-l-3 border-l-[#528FF0] rounded-r-md px-5 py-4 text-[13px] text-[#3b4055] leading-relaxed mt-5">
              <strong>{overrideCount}</strong> guardrail rule{overrideCount > 1 ? 's' : ''} fired across{' '}
              <strong>{totalFired}</strong> evaluations. The agent proposed actions that guardrails corrected,
              demonstrating the safety architecture: the agent reasons freely, but deterministic SHACL rules enforce regulatory boundaries.
            </div>
          )}
        </>
      )}
    </div>
  );
}
