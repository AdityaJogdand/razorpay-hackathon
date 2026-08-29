import { Typography } from 'antd';

export default function ExceptionQueue() {
  return (
    <div>
      <Typography.Title level={2}>Exception Queue</Typography.Title>
      <Typography.Text type="secondary">
        UNKNOWN classifications awaiting human review
      </Typography.Text>
    </div>
  );
}
