import { useState, useEffect, useMemo } from 'react';
import { Spin, Input } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  SafetyOutlined,
  ReloadOutlined,
  SearchOutlined,
  LeftOutlined,
  RightOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  StopOutlined,
  SettingOutlined,
  FileSearchOutlined,
  AuditOutlined,
  PlayCircleOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { verifyLedger, fetchLedgerCount, fetchLedgerRecent, type LedgerEntry } from '../api/dashboard';

// Human-friendly event type config
const EVENT_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
  CLASSIFICATION:     { icon: <FileSearchOutlined />,   label: 'Classified',       color: '#2563eb', bg: '#eff6ff' },
  TRIAGE:             { icon: <FileSearchOutlined />,   label: 'Triaged',          color: '#2563eb', bg: '#eff6ff' },
  AGENT_PROPOSAL:     { icon: <RobotOutlined />,        label: 'Agent Decision',   color: '#7c3aed', bg: '#f5f3ff' },
  GUARDRAIL_RESULT:   { icon: <SafetyOutlined />,       label: 'Guardrail Check',  color: '#16a34a', bg: '#f0fdf4' },
  SUPPRESSION:        { icon: <StopOutlined />,         label: 'Suppressed',       color: '#d97706', bg: '#fffbeb' },
  ACTION_EXECUTED:    { icon: <ThunderboltOutlined />,   label: 'Executed',         color: '#dc2626', bg: '#fef2f2' },
  ACTION_SCHEDULED:   { icon: <PlayCircleOutlined />,   label: 'Scheduled',        color: '#0ea5e9', bg: '#f0f9ff' },
  ACTION_OUTCOME:     { icon: <CheckCircleOutlined />,  label: 'Outcome',          color: '#1b1f2b', bg: '#f8fafc' },
  PLAN_CREATED:       { icon: <AuditOutlined />,        label: 'Plan Created',     color: '#6b7280', bg: '#f8fafc' },
  CONFIG_CHANGE:      { icon: <SettingOutlined />,      label: 'Config Change',    color: '#6b7280', bg: '#f8fafc' },
};

// Better summaries for unclear backend output
function cleanSummary(eventType: string, raw: string): string {
  if (raw === eventType || raw === `${eventType} ?` || raw === eventType.replace(/_/g, ' ')) {
    // Backend returned the event type as-is — make it human-readable
    const map: Record<string, string> = {
      TRIAGE: 'Payment failure triaged and queued for processing',
      PLAN_CREATED: 'Recovery plan created with scheduled actions',
      ACTION_SCHEDULED: 'Action scheduled for execution',
    };
    return map[eventType] || eventType.replace(/_/g, ' ').toLowerCase();
  }
  // Fix "Guardrail ?" → "Guardrail check passed"
  if (raw === 'Guardrail ?') return 'Guardrail validation passed';
  return raw;
}

const PAGE_SIZE = 25;
const FILTER_TYPES = ['CLASSIFICATION', 'TRIAGE', 'AGENT_PROPOSAL', 'GUARDRAIL_RESULT', 'SUPPRESSION', 'ACTION_EXECUTED', 'ACTION_SCHEDULED', 'PLAN_CREATED'];

export default function AuditLedger() {
  const [verified, setVerified] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [ledgerInfo, setLedgerInfo] = useState<{ entries: number; hash: string } | null>(null);
  const [totalEntries, setTotalEntries] = useState<number | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const loadData = async () => {
    setLoadingEntries(true);
    try {
      const [countData, entriesData] = await Promise.all([
        fetchLedgerCount(),
        fetchLedgerRecent(200),
      ]);
      setTotalEntries(countData.count);
      setEntries(entriesData);
    } catch {
      // silent
    } finally {
      setLoadingEntries(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    let result = entries;
    if (typeFilter) {
      result = result.filter((e) => e.event_type === typeFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          cleanSummary(e.event_type, e.data_summary).toLowerCase().includes(q) ||
          e.entity_id.toLowerCase().includes(q) ||
          e.event_type.toLowerCase().includes(q),
      );
    }
    return result;
  }, [entries, typeFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [search, typeFilter]);

  const handleVerify = async () => {
    setVerifying(true);
    setVerified(null);
    setLedgerInfo(null);
    try {
      const result = await verifyLedger();
      setVerified(result.valid);
      setLedgerInfo({ entries: result.entries_checked, hash: result.head_hash });
    } catch {
      setVerified(false);
      setLedgerInfo({ entries: 0, hash: 'unavailable' });
    } finally {
      setVerifying(false);
    }
  };

  // Group consecutive entries by entity_id for visual grouping
  const getEntityGroup = (index: number): 'first' | 'middle' | 'last' | 'solo' => {
    const curr = paged[index]?.entity_id;
    const prev = paged[index - 1]?.entity_id;
    const next = paged[index + 1]?.entity_id;
    if (curr !== prev && curr !== next) return 'solo';
    if (curr !== prev) return 'first';
    if (curr !== next) return 'last';
    return 'middle';
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-[15px] font-semibold text-[#1b1f2b] m-0">Audit Ledger</h1>
          <p className="text-[13px] text-[#7b8294] m-0 mt-1">
            Every agent decision is recorded in a tamper-proof hash chain
          </p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[#3b4055] bg-white border border-[#e5e8ec] rounded-lg cursor-pointer hover:bg-[#f8fafc] transition-colors"
        >
          <ReloadOutlined className="text-[11px]" /> Refresh
        </button>
      </div>

      {/* Integrity banner — always visible, acts as CTA to verify */}
      <div
        className={`rounded-lg px-5 py-4 mb-5 flex items-center gap-4 cursor-pointer transition-colors ${
          verified === true
            ? 'bg-[#f0fdf4] border border-[#bbf7d0]'
            : verified === false
            ? 'bg-[#fef2f2] border border-[#fecaca]'
            : 'bg-[#f8fafc] border border-[#e5e8ec] hover:bg-[#f3f4f6]'
        }`}
        onClick={!verifying ? handleVerify : undefined}
      >
        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
          verified === true ? 'bg-[#22c55e]/10' : verified === false ? 'bg-[#ef4444]/10' : 'bg-[#e5e8ec]'
        }`}>
          {verifying ? (
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-[#e5e8ec] border-t-[#528FF0]" />
          ) : verified === true ? (
            <CheckCircleOutlined className="text-[18px] text-[#22c55e]" />
          ) : verified === false ? (
            <CloseCircleOutlined className="text-[18px] text-[#ef4444]" />
          ) : (
            <LinkOutlined className="text-[16px] text-[#9ca3af]" />
          )}
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[#1b1f2b]">
            {verifying
              ? 'Verifying hash chain...'
              : verified === true
              ? 'Hash chain intact — no tampering detected'
              : verified === false
              ? 'Verification failed — possible tampering'
              : 'Click to verify ledger integrity'}
          </div>
          <div className="text-[12px] text-[#7b8294] mt-0.5">
            {verified !== null && ledgerInfo
              ? `${ledgerInfo.entries.toLocaleString()} entries checked · SHA-256 · HEAD ${ledgerInfo.hash.slice(0, 12)}...`
              : `${totalEntries?.toLocaleString() || 0} entries recorded · SHA-256 hash chain`}
          </div>
        </div>
        {!verifying && verified === null && (
          <span className="text-[11px] font-medium text-[#528FF0] bg-[#eff6ff] border border-[#bfdbfe] rounded-md px-3 py-1.5">
            Verify
          </span>
        )}
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-3 mb-4">
        <Input
          prefix={<SearchOutlined className="text-[#c4cdd5]" />}
          placeholder="Search by action, entity, or description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          className="max-w-[300px]"
          size="small"
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setTypeFilter(null)}
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
              !typeFilter
                ? 'bg-[#1b1f2b] text-white border-[#1b1f2b]'
                : 'bg-white text-[#6b7280] border-[#e5e8ec] hover:border-[#c4cdd5]'
            }`}
          >
            All
          </button>
          {FILTER_TYPES.map((type) => {
            const cfg = EVENT_CONFIG[type];
            if (!cfg) return null;
            const active = typeFilter === type;
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(active ? null : type)}
                className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
                  active
                    ? 'bg-[#1b1f2b] text-white border-[#1b1f2b]'
                    : 'bg-white text-[#6b7280] border-[#e5e8ec] hover:border-[#c4cdd5]'
                }`}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto text-[11px] text-[#9ca3af]">
          {filtered.length} of {entries.length}
        </div>
      </div>

      {/* Timeline-style entries */}
      <div className="border border-[#e5e8ec] rounded-lg overflow-hidden">
        {loadingEntries ? (
          <div className="flex items-center justify-center py-16">
            <Spin />
          </div>
        ) : paged.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <InboxOutlined className="text-[28px] text-[#d1d5db] mb-3" />
            <span className="text-[13px] text-[#9ca3af]">
              {entries.length === 0 ? 'No ledger entries yet — simulate a payment to get started' : 'No entries match your search'}
            </span>
          </div>
        ) : (
          <div>
            {paged.map((entry, i) => {
              const cfg = EVENT_CONFIG[entry.event_type] || { icon: <AuditOutlined />, label: entry.event_type, color: '#6b7280', bg: '#f8fafc' };
              const summary = cleanSummary(entry.event_type, entry.data_summary);
              const group = getEntityGroup(i);
              const showEntityHeader = group === 'first' || group === 'solo';

              return (
                <div key={entry.id}>
                  {/* Entity group header — shows transaction ID when a new group starts */}
                  {showEntityHeader && i > 0 && (
                    <div className="border-t-2 border-[#e5e8ec]" />
                  )}
                  <div className={`flex items-start gap-3 px-5 py-3 ${i > 0 && !showEntityHeader ? 'border-t border-[#f5f5f5]' : i > 0 ? 'border-t border-[#e5e8ec]' : ''} hover:bg-[#fafbfc] transition-colors`}>
                    {/* Icon */}
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 text-[12px]"
                      style={{ backgroundColor: cfg.bg, color: cfg.color }}
                    >
                      {cfg.icon}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[12px] font-semibold text-[#1b1f2b]">{cfg.label}</span>
                        <span className="text-[11px] text-[#c4cdd5]">·</span>
                        <span className="text-[11px] text-[#9ca3af]">
                          {new Date(entry.created_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="text-[12px] text-[#4b5563] leading-relaxed">
                        {summary}
                      </div>
                      {showEntityHeader && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <code className="text-[10px] text-[#9ca3af] font-mono bg-[#f5f7fa] px-1.5 py-0.5 rounded">
                            {entry.entity_id.slice(0, 8)}...
                          </code>
                        </div>
                      )}
                    </div>

                    {/* Hash */}
                    <div className="shrink-0 text-right">
                      <code className="text-[10px] text-[#c4cdd5] font-mono">
                        #{entry.entry_hash}
                      </code>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#e5e8ec] bg-[#f8fafc]">
            <span className="text-[11px] text-[#9ca3af]">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-[#e5e8ec] bg-white text-[#6b7280] text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#f3f4f6] transition-colors"
              >
                <LeftOutlined className="text-[9px]" />
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pageNum: number;
                if (totalPages <= 7) {
                  pageNum = i + 1;
                } else if (page <= 4) {
                  pageNum = i + 1;
                } else if (page >= totalPages - 3) {
                  pageNum = totalPages - 6 + i;
                } else {
                  pageNum = page - 3 + i;
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className={`w-7 h-7 rounded-md text-[11px] font-medium cursor-pointer transition-colors ${
                      page === pageNum
                        ? 'bg-[#1b1f2b] text-white border border-[#1b1f2b]'
                        : 'bg-white text-[#6b7280] border border-[#e5e8ec] hover:bg-[#f3f4f6]'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-[#e5e8ec] bg-white text-[#6b7280] text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#f3f4f6] transition-colors"
              >
                <RightOutlined className="text-[9px]" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
