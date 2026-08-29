import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Layout,
  Menu,
  Switch,
  Tag,
  Typography,
  Space,
} from 'antd';
import {
  DashboardOutlined,
  ApartmentOutlined,
  WarningOutlined,
  AuditOutlined,
} from '@ant-design/icons';
import axios from 'axios';

const { Header, Sider, Content } = Layout;
const API = 'http://localhost:8000';

const menuItems = [
  { key: '/batch', icon: <DashboardOutlined />, label: 'Batch Summary' },
  { key: '/trace', icon: <ApartmentOutlined />, label: 'Decision Trace' },
  { key: '/exceptions', icon: <WarningOutlined />, label: 'Exception Queue' },
  { key: '/rules', icon: <AuditOutlined />, label: 'Stopping Rules' },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [killSwitch, setKillSwitch] = useState(false);

  useEffect(() => {
    axios.get(`${API}/health`).then((r) => {
      setKillSwitch(r.data.kill_switch);
    }).catch(() => {});
  }, []);

  const toggleKillSwitch = async (checked: boolean) => {
    try {
      await axios.post(`${API}/config/kill-switch`, { enabled: checked });
      setKillSwitch(checked);
    } catch {
      // fail silently for now
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={60}>
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <Typography.Text strong style={{ color: '#fff', fontSize: 14 }}>
            Recovery Agent
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Space>
            <Typography.Text>Kill Switch</Typography.Text>
            <Switch
              checked={killSwitch}
              onChange={toggleKillSwitch}
              checkedChildren="ON"
              unCheckedChildren="OFF"
            />
            {killSwitch ? (
              <Tag color="red">EXECUTION HALTED</Tag>
            ) : (
              <Tag color="green">ACTIVE</Tag>
            )}
          </Space>
        </Header>
        <Content style={{ margin: 24, padding: 24, background: '#fff', borderRadius: 8 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
