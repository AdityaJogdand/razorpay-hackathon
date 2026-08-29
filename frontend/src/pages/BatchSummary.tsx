import { Typography } from 'antd';

export default function BatchSummary() {
  return (
    <div>
      <Typography.Title level={2}>Batch Summary</Typography.Title>
      <Typography.Text type="secondary">
        Rupees recovered, attempts saved, contacts suppressed
      </Typography.Text>
    </div>
  );
}
