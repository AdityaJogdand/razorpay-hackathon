import { Typography } from 'antd';

export default function StoppingRuleAudit() {
  return (
    <div>
      <Typography.Title level={2}>Stopping Rule Audit</Typography.Title>
      <Typography.Text type="secondary">
        Which rules fired, how often, what they suppressed
      </Typography.Text>
    </div>
  );
}
