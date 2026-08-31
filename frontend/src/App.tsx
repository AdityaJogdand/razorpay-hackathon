import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import AppLayout from './layout/AppLayout';
import BatchSummary from './pages/BatchSummary';
import DecisionTrace from './pages/DecisionTrace';
import ExceptionQueue from './pages/ExceptionQueue';
import StoppingRuleAudit from './pages/StoppingRuleAudit';
import EmailOutreach from './pages/EmailOutreach';
import PaymentSimulator from './pages/PaymentSimulator';
import AuditLedger from './pages/AuditLedger';
import MandateSequencer from './pages/MandateSequencer';

const themeConfig = {
  token: {
    colorPrimary: '#2563eb',
    borderRadius: 6,
    colorBgContainer: '#ffffff',
    colorBorder: '#e5e7eb',
    colorText: '#1a1d23',
    colorTextSecondary: '#6b7280',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  components: {
    Table: {
      headerBg: '#f8fafc',
      headerColor: '#64748b',
      rowHoverBg: '#f8fafc',
    },
    Card: {
      paddingLG: 20,
    },
  },
};

function App() {
  return (
    <ConfigProvider theme={themeConfig}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<DecisionTrace />} />
            <Route path="/trace" element={<DecisionTrace />} />
            <Route path="/batch" element={<BatchSummary />} />
            <Route path="/exceptions" element={<ExceptionQueue />} />
            <Route path="/rules" element={<StoppingRuleAudit />} />
            <Route path="/emails" element={<EmailOutreach />} />
            <Route path="/simulate" element={<PaymentSimulator />} />
            <Route path="/ledger" element={<AuditLedger />} />
            <Route path="/mandates" element={<MandateSequencer />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
