import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Switch, Modal, Button, message } from 'antd';
import {
  HomeOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
  SafetyOutlined,
  MailOutlined,
  SettingOutlined,
  SearchOutlined,
  UserOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  SwapOutlined,
  FileTextOutlined,
  LinkOutlined,
  DownOutlined,
  BellOutlined,
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

  const toggleKillSwitch = (checked: boolean) => {
    setKillSwitch(checked);
    message.info(checked ? 'Kill switch activated — execution halted' : 'Agent active — execution resumed');
  };

  const verifyLedger = () => {
    setLedgerModalOpen(true);
    setLedgerVerified(null);
    setTimeout(() => setLedgerVerified(true), 1500);
  };

  const navItems = [
    { key: '/', label: 'Home' },
    { key: '/trace', label: 'Decisions' },
    { key: '/batch', label: 'Measurement' },
  ];

  const mainItems: SidebarItem[] = [
    { key: '/', icon: <HomeOutlined />, label: 'Home' },
    { key: '/trace', icon: <SwapOutlined />, label: 'Decisions' },
    { key: '/batch', icon: <BarChartOutlined />, label: 'Recovery Impact' },
    { key: '/exceptions', icon: <FileTextOutlined />, label: 'Exception Queue' },
  ];

  const productItems: SidebarItem[] = [
    { key: '/rules', icon: <SafetyOutlined />, label: 'Guardrail Audit', badge: 'New Update' },
    { key: '/emails', icon: <MailOutlined />, label: 'Email Outreach' },
    { key: '/ledger', icon: <LinkOutlined />, label: 'Audit Ledger' },
  ];

  const isActive = (key: string) => location.pathname === key;

  const getActiveNav = () => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (path === '/trace' || path === '/exceptions' || path === '/rules' || path === '/emails') return '/trace';
    if (path === '/batch') return '/batch';
    return '/';
  };
  const activeNav = getActiveNav();

  return (
    <div className="min-h-screen flex flex-col">
      {/* ═══════ TOP NAV BAR ═══════ */}
      <header className="h-[56px] flex items-center justify-between px-6 shrink-0 bg-white border-b border-[#e8e8e8]">
        {/* Left — logo + nav */}
        <div className="flex items-center h-full gap-5">
          {/* Logo */}
          <div
            className="flex items-center cursor-pointer select-none shrink-0"
            onClick={() => navigate('/')}
          >
            <img className="h-[30px]" src={Logo} alt="Logo" />
          </div>

          {/* Divider */}
          <div className="w-[1px] h-[24px] bg-[#e8e8e8]" />

          {/* Nav items */}
          <nav className="flex items-center h-full gap-1">
            {navItems.map((item) => {
              const active = activeNav === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => navigate(item.key)}
                  className={`
                    border-0 cursor-pointer h-full flex items-center px-4 bg-transparent relative
                    text-[13.5px] tracking-[-0.01em] transition-colors duration-150
                    ${active
                      ? 'text-[#1b1f2b] font-semibold'
                      : 'text-[#6b7280] hover:text-[#1b1f2b]'
                    }
                  `}
                >
                  {item.label}
                  {active && (
                    <div
                      className="absolute bottom-0 left-4 right-4 h-[2px] rounded-t-full"
                      style={{ background: '#1b1f2b' }}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right — search + controls */}
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="flex items-center h-[34px] w-[240px] rounded-lg border border-[#e8e8e8] px-3 bg-[#fafafa] transition-colors duration-150 focus-within:border-[#c0c0c0] focus-within:bg-white">
            <SearchOutlined className="text-[#9ca3af] text-[13px] mr-2 shrink-0" />
            <input
              type="text"
              placeholder="Search..."
              className="bg-transparent border-0 outline-none text-[13px] text-[#1b1f2b] placeholder:text-[#9ca3af] w-full"
            />
            <kbd className="text-[10px] text-[#9ca3af] bg-white border border-[#e8e8e8] rounded px-1.5 py-0.5 ml-1 shrink-0 font-mono">/</kbd>
          </div>

          {/* Notification */}
          <button className="w-[34px] h-[34px] rounded-lg border border-transparent hover:border-[#e8e8e8] hover:bg-[#fafafa] flex items-center justify-center bg-transparent cursor-pointer transition-all duration-150 relative">
            <BellOutlined className="text-[15px] text-[#6b7280]" />
            <span className="absolute top-[7px] right-[8px] w-[6px] h-[6px] rounded-full bg-[#1b1f2b]" />
          </button>

          {/* Divider */}
          <div className="w-[1px] h-[24px] bg-[#e8e8e8] mx-1" />

          {/* Profile */}
          <button className="flex items-center gap-2.5 h-[34px] rounded-lg px-2 border border-transparent hover:border-[#e8e8e8] hover:bg-[#fafafa] bg-transparent cursor-pointer transition-all duration-150">
            <div className="w-[26px] h-[26px] rounded-full bg-[#1b1f2b] flex items-center justify-center">
              <span className="text-[11px] font-semibold text-white leading-none">RA</span>
            </div>
            <DownOutlined className="text-[8px] text-[#9ca3af]" />
          </button>
        </div>
      </header>

      {/* ═══════ BODY ═══════ */}
      <div className="flex flex-1 overflow-hidden bg-[#F7F6F6]">
        {/* ═══════ SIDEBAR ═══════ */}
        <aside className="w-[250px] bg-white m-3 mr-0 rounded-2xl border border-[#e8e8e8] flex flex-col shrink-0 overflow-y-auto">
          <nav className="flex-1 pt-2 pb-4">
            {mainItems.map((item) => (
              <div
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`
                  flex items-center gap-3 mx-2.5 px-3 h-[34px] mb-1 cursor-pointer text-[13px] transition-colors rounded-lg
                  ${isActive(item.key)
                    ? 'bg-[#e8e8e8] font-semibold text-[#1b1f2b]'
                    : 'text-[#3b4055] hover:bg-[#ededed]'
                  }
                `}
              >
                <span className={`text-[15px] ${isActive(item.key) ? 'text-[#1b1f2b]' : 'text-[#7b8294]'}`}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
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
                onClick={() => item.key === '/ledger' ? verifyLedger() : navigate(item.key)}
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

            <div className="flex items-center gap-1.5 mx-2.5 px-3 h-[38px] cursor-pointer text-[13px] font-semibold text-[#3b4055] hover:bg-[#ededed] rounded-lg">
              <span>+2 More</span>
              <DownOutlined className="text-[9px]" />
            </div>
          </nav>

          {/* Bottom */}
          <div className="border-t border-[#e5e8ec]">
            <div className="flex items-center justify-between px-5 h-[46px]">
              <div className="flex items-center gap-2.5">
                <ExclamationCircleOutlined className={`text-[15px] ${killSwitch ? 'text-red-500' : 'text-[#7b8294]'}`} />
                <span className="text-[13px] text-[#3b4055]">Kill Switch</span>
              </div>
              <Switch
                checked={killSwitch}
                onChange={toggleKillSwitch}
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
        ) : (
          <div className="flex flex-col items-center py-8 gap-3">
            <CheckCircleOutlined className="text-4xl text-[#2da44e]" />
            <span className="text-lg font-semibold text-[#1b1f2b]">Hash chain intact</span>
            <span className="text-[#7b8294] text-sm">2,847 entries verified. No tampering detected.</span>
            <code className="text-xs text-[#7b8294] mt-2 bg-[#f5f5f5] px-3 py-1 rounded">
              HEAD: a3f8c2e9...91b4e7d1
            </code>
          </div>
        )}
      </Modal>
    </div>
  );
}
