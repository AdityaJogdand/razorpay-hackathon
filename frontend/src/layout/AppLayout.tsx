import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Switch, Modal, Button, message } from 'antd';
import { toggleKillSwitch, verifyLedger as verifyLedgerApi, fetchHealthCheck } from '../api/dashboard';
import {
  BarChartOutlined,
  SafetyOutlined,
  MailOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SwapOutlined,
  FileTextOutlined,
  LinkOutlined,
  ThunderboltOutlined,
  ShoppingCartOutlined,
  PhoneOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import Logo from '../assets/razor-pay-logo.png';

interface SidebarItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [killSwitch, setKillSwitch] = useState(false);
  const [ledgerModalOpen, setLedgerModalOpen] = useState(false);
  const [ledgerVerified, setLedgerVerified] = useState<boolean | null>(null);
  const [ledgerInfo, setLedgerInfo] = useState<{ entries: number; hash: string } | null>(null);

  useEffect(() => {
    fetchHealthCheck()
      .then((data) => setKillSwitch(data.kill_switch))
      .catch(() => {});
  }, []);

  const handleKillSwitch = async (checked: boolean) => {
    setKillSwitch(checked);
    message.info(checked ? 'Kill switch activated — execution halted' : 'Agent active — execution resumed');
    try {
      await toggleKillSwitch(checked);
    } catch {
      message.warning('Backend unreachable — toggle saved locally only');
    }
  };

  const verifyLedger = async () => {
    setLedgerModalOpen(true);
    setLedgerVerified(null);
    setLedgerInfo(null);
    try {
      const result = await verifyLedgerApi();
      setLedgerVerified(result.valid);
      setLedgerInfo({ entries: result.entries_checked, hash: result.head_hash });
    } catch {
      setLedgerVerified(false);
      setLedgerInfo({ entries: 0, hash: 'unavailable — backend unreachable' });
    }
  };

  const recoveryItems: SidebarItem[] = [
    { key: '/trace', icon: <SwapOutlined />, label: 'Decision Traces' },
    { key: '/exceptions', icon: <FileTextOutlined />, label: 'Exception Queue' },
    { key: '/mandates', icon: <BarChartOutlined />, label: 'Mandate Sequencer' },
    { key: '/checkout', icon: <ShoppingCartOutlined />, label: 'Checkout Recovery' },
{
  key: '/voice',
  icon: <PhoneOutlined className="scale-x-[-1]" />,
  label: 'Voice Recovery'
},
    { key: '/subscriptions', icon: <SyncOutlined />, label: 'Subscription Recovery' },
  ];

  const auditItems: SidebarItem[] = [
    { key: '/rules', icon: <SafetyOutlined />, label: 'Guardrail Audit' },
    { key: '/emails', icon: <MailOutlined />, label: 'Email Outreach' },
    { key: '/ledger', icon: <LinkOutlined />, label: 'Audit Ledger' },
  ];

  const toolItems: SidebarItem[] = [
    { key: '/simulate', icon: <ThunderboltOutlined />, label: 'Simulation Hub' },
  ];

  const isActive = (key: string) => location.pathname === key;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#F7F6F6]">

      {/* ═══════ BODY ═══════ */}
      <div className="flex flex-1 overflow-hidden">
        {/* ═══════ SIDEBAR ═══════ */}
        <aside className="w-[240px] h-[calc(100vh-24px)] sticky top-3 self-start bg-white m-3 mr-0 rounded-2xl border border-[#e8e8e8] flex flex-col shrink-0 overflow-hidden">
          <nav className="flex-1 pt-2 pb-4 overflow-y-auto">
            <img src={Logo} alt="Razorpay Logo" className="h-10 w-auto mx-6 mb-5" />

            <SidebarSection label="Recovery">
              {recoveryItems.map((item) => (
                <SidebarLink key={item.key} item={item} active={isActive(item.key) || (item.key === '/trace' && location.pathname === '/')} onClick={() => navigate(item.key)} />
              ))}
            </SidebarSection>

            <SidebarSection label="Safety & Audit">
              {auditItems.map((item) => (
                <SidebarLink key={item.key} item={item} active={isActive(item.key)} onClick={() => navigate(item.key)} />
              ))}
            </SidebarSection>

            <SidebarSection label="Tools">
              {toolItems.map((item) => (
                <SidebarLink key={item.key} item={item} active={isActive(item.key)} onClick={() => navigate(item.key)} />
              ))}
            </SidebarSection>
          </nav>

          {/* Bottom */}
          <div className="border-t border-[#e5e8ec] bg-white shrink-0">
            <div className="flex items-center justify-between px-5 h-[46px]">
              <div className="flex items-center gap-2.5">
                <ExclamationCircleOutlined className={`text-[15px] ${killSwitch ? 'text-red-500' : 'text-[#7b8294]'}`} />
                <span className="text-[13px] text-[#3b4055]">Kill Switch</span>
              </div>
              <Switch
                checked={killSwitch}
                onChange={handleKillSwitch}
                size="small"
                style={killSwitch ? { backgroundColor: '#ef4444' } : { backgroundColor: '#528FF0' }}
              />
            </div>
            <div
              className="flex items-center gap-2.5 px-5 h-[46px] cursor-pointer hover:bg-[#ededed] border-t border-[#e5e8ec]"
              onClick={verifyLedger}
            >
              <SettingOutlined className="text-[15px] text-[#7b8294]" />
              <span className="text-[13px] text-[#3b4055]">Ledger Integrity Verification</span>
            </div>
          </div>
        </aside>

        {/* ═══════ MAIN CONTENT ═══════ */}
        <main className="flex-1 bg-[#F7F6F6] overflow-y-auto">
          {killSwitch && (
            <div className="bg-[#fef3cd] border-b border-[#ffc107] px-6 py-2 text-[13px] text-[#856404] flex items-center gap-2">
              <ExclamationCircleOutlined />
              Agent execution halted. Triage and planning continue, but no actions will be executed.
            </div>
          )}
          <div className="p-4">
            <div className="bg-white rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]" style={{ minHeight: 'calc(100vh - 56px)' }}>
              <Outlet />
            </div>
          </div>
        </main>
      </div>

      {/* ═══════ LEDGER MODAL ═══════  */}
      <Modal
        title="Ledger Integrity Verification"
        open={ledgerModalOpen}
        onCancel={() => setLedgerModalOpen(false)}
        footer={<Button onClick={() => setLedgerModalOpen(false)}>Close</Button>}
        width={440}
      >
        {ledgerVerified === null ? (
          <div className="flex flex-col items-center py-8 gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#e5e8ec] border-t-[#528FF0]" />
            <span className="text-[#7b8294] text-sm">Verifying hash chain...</span>
          </div>
        ) : ledgerVerified ? (
          <div className="flex flex-col items-center py-8 gap-3">
            <CheckCircleOutlined className="text-4xl text-[#2da44e]" />
            <span className="text-lg font-semibold text-[#1b1f2b]">Hash chain intact</span>
            <span className="text-[#7b8294] text-sm">
              {ledgerInfo ? `${ledgerInfo.entries.toLocaleString()} entries verified` : '0 entries verified'}. No tampering detected.
            </span>
            <code className="text-xs text-[#7b8294] mt-2 bg-[#f5f5f5] px-3 py-1 rounded">
              HEAD: {ledgerInfo?.hash ? `${ledgerInfo.hash.slice(0, 8)}...${ledgerInfo.hash.slice(-8)}` : 'N/A'}
            </code>
          </div>
        ) : (
          <div className="flex flex-col items-center py-8 gap-3">
            <CloseCircleOutlined className="text-4xl text-[#ef4444]" />
            <span className="text-lg font-semibold text-[#1b1f2b]">Verification failed</span>
            <span className="text-[#7b8294] text-sm">
              {ledgerInfo?.hash === 'unavailable — backend unreachable'
                ? 'Backend unreachable. Cannot verify ledger integrity.'
                : 'Hash chain integrity check failed. Possible tampering detected.'}
            </span>
          </div>
        )}
      </Modal>
    </div>
  );
}

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-5 pt-4 pb-1.5">
        <span className="text-[10px] font-bold text-[#9ca3af] uppercase tracking-[0.8px]">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function SidebarLink({ item, active, onClick }: { item: SidebarItem; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`
        flex items-center gap-2.5 mx-2.5 px-3 h-[34px] cursor-pointer text-[13px] transition-all rounded-lg whitespace-nowrap
        ${active
          ? 'bg-[#1b1f2b] text-white font-medium'
          : 'text-[#3b4055] hover:bg-[#f5f5f5]'
        }
      `}
    >
      <span className={`text-[14px] shrink-0 ${active ? 'text-white' : 'text-[#9ca3af]'}`}>
        {item.icon}
      </span>
      <span>{item.label}</span>
    </div>
  );
}
