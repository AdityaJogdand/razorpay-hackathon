import { useState } from 'react';
import { Table, Tag, Button, Typography, Space, Select, Progress } from 'antd';
import {
  CheckOutlined,
  EditOutlined,
  ForwardOutlined,
} from '@ant-design/icons';
import { MOCK_TRANSACTIONS, type Transaction, type FailureClass } from '../mock/data';

const unknowns = MOCK_TRANSACTIONS.filter((t) => t.failure_class === 'UNKNOWN');

const CLASS_COLORS: Record<FailureClass, string> = {
  HARD: 'red',
  SOFT: 'orange',
  MANDATE: 'blue',
  UNKNOWN: 'default',
};

function formatAmount(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN');
}

export default function ExceptionQueue() {
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const pendingCount = unknowns.filter((t) => !resolved.has(t.id)).length;

  const columns = [
    {
      title: 'Transaction',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => <span className="font-mono text-xs">{id}</span>,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: (v: number) => <span className="font-semibold">{formatAmount(v)}</span>,
    },
    {
      title: 'Decline Code',
      dataIndex: 'decline_code',
      key: 'decline_code',
      render: (v: string) => <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{v}</code>,
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      key: 'confidence',
      render: (v: number) => (
        <Progress
          percent={Math.round(v * 100)}
          size="small"
          strokeColor={v < 0.5 ? '#ef4444' : v < 0.7 ? '#f59e0b' : '#22c55e'}
          className="w-20"
        />
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, record: Transaction) =>
        resolved.has(record.id) ? (
          <Tag color="green">Resolved</Tag>
        ) : (
          <Tag color="gold">Pending Review</Tag>
        ),
    },
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Typography.Title level={4} className="!mb-1 !text-slate-800">Exception Queue</Typography.Title>
        <div className="text-sm text-slate-500">
          {pendingCount} of {MOCK_TRANSACTIONS.length.toLocaleString()} transactions require human review
          ({((pendingCount / MOCK_TRANSACTIONS.length) * 100).toFixed(2)}%)
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg">
        <Table
          dataSource={unknowns}
          columns={columns}
          rowKey="id"
          pagination={false}
          expandable={{
            expandedRowRender: (record: Transaction) => (
              <div className="py-3 px-2">
                {/* Agent's explanation */}
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Agent's Analysis
                </div>
                <div className="bg-slate-50 border-l-3 border-l-slate-400 rounded-r px-4 py-3 text-sm text-slate-600 leading-relaxed mb-4">
                  {record.agent_reasoning}
                </div>

                {/* Agent's best guess */}
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-slate-500">Agent's best guess:</span>
                  <Tag color="orange">SOFT</Tag>
                  <span className="text-xs text-slate-400">({Math.round(record.confidence * 100)}% confidence)</span>
                </div>

                {/* Action buttons */}
                {!resolved.has(record.id) ? (
                  <Space>
                    <Button
                      type="primary"
                      size="small"
                      icon={<CheckOutlined />}
                      onClick={() => setResolved(new Set(resolved).add(record.id))}
                    >
                      Approve as SOFT
                    </Button>
                    <Select
                      placeholder="Override classification"
                      size="small"
                      style={{ width: 180 }}
                      options={[
                        { value: 'HARD', label: 'Override → HARD' },
                        { value: 'SOFT', label: 'Override → SOFT' },
                        { value: 'MANDATE', label: 'Override → MANDATE' },
                      ]}
                      onChange={() => setResolved(new Set(resolved).add(record.id))}
                    />
                    <Button size="small" icon={<ForwardOutlined />}>
                      Escalate
                    </Button>
                  </Space>
                ) : (
                  <Tag color="green" icon={<CheckOutlined />}>Resolved</Tag>
                )}
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
