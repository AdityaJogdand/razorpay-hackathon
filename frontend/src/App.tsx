import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import AppLayout from './layout/AppLayout';
import BatchSummary from './pages/BatchSummary';
import DecisionTrace from './pages/DecisionTrace';
import ExceptionQueue from './pages/ExceptionQueue';
import StoppingRuleAudit from './pages/StoppingRuleAudit';

function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: '#2563eb' },
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Navigate to="/batch" replace />} />
            <Route path="/batch" element={<BatchSummary />} />
            <Route path="/trace" element={<DecisionTrace />} />
            <Route path="/exceptions" element={<ExceptionQueue />} />
            <Route path="/rules" element={<StoppingRuleAudit />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
