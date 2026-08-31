import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Switch, Modal, Button, message } from 'antd';
import { toggleKillSwitch, verifyLedger as verifyLedgerApi, fetchHealthCheck } from '../api/dashboard';
import {
  HomeOutlined,
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

  const mainItems: SidebarItem[] = [
    { key: '/', icon: <HomeOutlined />, label: 'Home' },
    { key: '/trace', icon: <SwapOutlined />, label: 'Decisions' },
      // { key: '/batch', icon: <BarChartOutlined />, label: 'Recovery Impact' },
    { key: '/exceptions', icon: <FileTextOutlined />, label: 'Exception Queue' },
    { key: '/mandates', icon: <BarChartOutlined />, label: 'Mandate Sequencer', badge: 'New' },
    { key: '/simulate', icon: <ThunderboltOutlined />, label: 'Gateway Simulator' },
  ];

  const productItems: SidebarItem[] = [
    { key: '/rules', icon: <SafetyOutlined />, label: 'Guardrail Audit', badge: 'New Update' },
    { key: '/emails', icon: <MailOutlined />, label: 'Email Outreach' },
    { key: '/ledger', icon: <LinkOutlined />, label: 'Audit Ledger' },
  ];

  const isActive = (key: string) => location.pathname === key;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#F7F6F6]">

      {/* ═══════ BODY ═══════ */}
      <div className="flex flex-1 overflow-hidden">
        {/* ═══════ SIDEBAR ═══════ */}
        <aside className="w-[250px] h-[calc(100vh-24px)] sticky top-3 self-start bg-white m-3 mr-0 rounded-2xl border border-[#e8e8e8] flex flex-col shrink-0 overflow-hidden">
          <nav className="flex-1 pt-2 pb-4 overflow-y-auto">
            <img src={Logo} alt="Razorpay Logo" className="h-10 w-auto mx-6 mb-4" />
            {mainItems.map((item) => (
              <div
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`
                  flex items-center gap-3 mx-2.5 px-3 h-[34px] mb-1 cursor-pointer text-[13px] transition-colors rounded-lg whitespace-nowrap
                  ${isActive(item.key)
                    ? 'bg-[#e8e8e8] font-semibold text-[#1b1f2b]'
                    : 'text-[#3b4055] hover:bg-[#ededed]'
                  }
                `}
              >
                <span className={`text-[15px] shrink-0 ${isActive(item.key) ? 'text-[#1b1f2b]' : 'text-[#7b8294]'}`}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.badge && (
                  <span className="text-[11px] font-semibold text-[#1a8b4f] bg-[#e6f4ea] px-2 py-0.5 rounded ml-auto shrink-0">
                    {item.badge}
                  </span>
                )}
              </div>
            ))}

            <div className="px-6 pt-5 pb-1.5">
              <span className="text-[11px] font-bold text-[#1a8b4f] uppercase tracking-[0.5px]">
                Safety & Audit
              </span>
            </div>

            {productItems.map((item) => (
              <div
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`
                  flex items-center gap-3 mx-2.5 px-3 h-[34px] mb-1 cursor-pointer text-[13px] transition-colors rounded-lg whitespace-nowrap
                  ${isActive(item.key)
                    ? 'bg-[#e8e8e8] font-semibold text-[#1b1f2b]'
                    : 'text-[#3b4055] hover:bg-[#ededed]'
                  }
                `}
              >
                <span className={`text-[15px] shrink-0 ${isActive(item.key) ? 'text-[#1b1f2b]' : 'text-[#7b8294]'}`}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.badge && (
                  <span className="text-[11px] font-semibold text-[#1a8b4f] bg-[#e6f4ea] px-2 py-0.5 rounded ml-auto shrink-0">
                    {item.badge}
                  </span>
                )}
              </div>
            ))}

         
          
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
              onClick={() => {}}
            >
              <SettingOutlined className="text-[15px] text-[#7b8294]" />
              <span className="text-[13px] text-[#3b4055]">Account & Settings</span>
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
            <div className="bg-white rounded-2xl p-6 min-h-[calc(100vh-150px)] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <Outlet />
            </div>
          </div>
        </main>
      </div>

      {/* ═══════ LEDGER MODAL ═══════ */}
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
