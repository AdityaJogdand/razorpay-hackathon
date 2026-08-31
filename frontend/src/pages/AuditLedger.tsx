import { useState, useEffect } from 'react';
import { Spin, Tag } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { verifyLedger, fetchLedgerCount } from '../api/dashboard';

export default function AuditLedger() {
  const [verified, setVerified] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [ledgerInfo, setLedgerInfo] = useState<{ entries: number; hash: string } | null>(null);
  const [totalEntries, setTotalEntries] = useState<number | null>(null);

  useEffect(() => {
    fetchLedgerCount()
      .then((data) => setTotalEntries(data.count))
      .catch(() => {});
  }, []);

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
      setLedgerInfo({ entries: 0, hash: 'unavailable — backend unreachable' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Audit Ledger</span>
        <span className="text-[12px] text-[#9ca3af]">Hash-chained tamper-evident audit trail</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#1b1f2b]">{totalEntries !== null ? totalEntries.toLocaleString() : '—'}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Ledger Entries</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#528FF0]">SHA-256</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Hash Algorithm</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#22c55e]">
            {verified === null ? '—' : verified ? 'Valid' : 'Failed'}
          </div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Chain Status</div>
        </div>
      </div>

      {/* How it works */}
      <div className="border border-[#e5e8ec] rounded-lg p-6 mb-6">
        <div className="text-[13px] font-semibold text-[#1b1f2b] mb-4">How the Audit Ledger Works</div>
        <div className="grid grid-cols-3 gap-6">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[#eff6ff] flex items-center justify-center shrink-0">
              <LinkOutlined className="text-[#528FF0]" />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#1b1f2b] mb-1">Hash Chain</div>
              <div className="text-[12px] text-[#7b8294] leading-relaxed">
                Every event is hashed with SHA-256. Each entry's hash includes the previous entry's hash, creating an immutable chain.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[#f0fdf4] flex items-center justify-center shrink-0">
              <SafetyOutlined className="text-[#22c55e]" />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#1b1f2b] mb-1">Tamper Detection</div>
              <div className="text-[12px] text-[#7b8294] leading-relaxed">
                Modifying any past entry breaks the hash chain. Verification walks the entire chain to detect tampering.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[#f5f3ff] flex items-center justify-center shrink-0">
              <SafetyOutlined className="text-[#7c3aed]" />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#1b1f2b] mb-1">Full Coverage</div>
              <div className="text-[12px] text-[#7b8294] leading-relaxed">
                Agent proposals, guardrail results, suppressions, and execution outcomes are all recorded in the ledger.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Event types logged */}
      <div className="border border-[#e5e8ec] rounded-lg p-6 mb-6">
        <div className="text-[13px] font-semibold text-[#1b1f2b] mb-4">Event Types Recorded</div>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Classification', color: '#528FF0' },
            { label: 'Agent Proposal', color: '#7c3aed' },
            { label: 'Guardrail Result', color: '#22c55e' },
            { label: 'Suppression', color: '#d97706' },
            { label: 'Action Executed', color: '#ef4444' },
            { label: 'Action Outcome', color: '#1b1f2b' },
            { label: 'Config Change', color: '#6b7280' },
          ].map((t) => (
            <Tag key={t.label} color={t.color} className="text-[12px] px-3 py-1">{t.label}</Tag>
          ))}
        </div>
      </div>

      {/* Verify section */}
      <div className="border border-[#e5e8ec] rounded-lg p-6">
        <div className="text-[13px] font-semibold text-[#1b1f2b] mb-4">Verify Integrity</div>

        <button
          onClick={handleVerify}
          disabled={verifying}
          className="px-6 py-2.5 text-[13px] font-semibold text-white bg-[#528FF0] rounded-lg hover:bg-[#4280e0] transition-colors cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed mb-4"
        >
          {verifying ? 'Verifying...' : 'Verify Hash Chain'}
        </button>

        {verifying && (
          <div className="flex items-center gap-3 py-4">
            <Spin />
            <span className="text-[13px] text-[#7b8294]">Walking hash chain and verifying entries...</span>
          </div>
        )}

        {verified !== null && !verifying && (
          <div className={`rounded-lg p-6 ${verified ? 'bg-[#f0fdf4] border border-[#bbf7d0]' : 'bg-[#fef2f2] border border-[#fecaca]'}`}>
            <div className="flex items-center gap-3 mb-3">
              {verified ? (
                <CheckCircleOutlined className="text-[28px] text-[#22c55e]" />
              ) : (
                <CloseCircleOutlined className="text-[28px] text-[#ef4444]" />
              )}
              <span className="text-[16px] font-semibold text-[#1b1f2b]">
                {verified ? 'Hash chain intact' : 'Verification failed'}
              </span>
            </div>
            <div className="text-[13px] text-[#7b8294] mb-2">
              {verified
                ? `${ledgerInfo?.entries.toLocaleString() || 0} entries verified. No tampering detected.`
                : ledgerInfo?.hash === 'unavailable — backend unreachable'
                  ? 'Backend unreachable. Cannot verify ledger integrity.'
                  : 'Hash chain integrity check failed. Possible tampering detected.'}
            </div>
            {ledgerInfo?.hash && ledgerInfo.hash !== 'unavailable — backend unreachable' && (
              <code className="text-[11px] text-[#7b8294] bg-white/80 px-3 py-1.5 rounded border border-[#e5e8ec]">
                HEAD: {ledgerInfo.hash.length > 16 ? `${ledgerInfo.hash.slice(0, 8)}...${ledgerInfo.hash.slice(-8)}` : ledgerInfo.hash}
              </code>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
