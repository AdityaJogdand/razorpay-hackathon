import { useState, useEffect, useRef } from 'react';
import { Segmented, Drawer, Empty, Spin, Tag } from 'antd';
import {
  CheckCircleFilled,
  MailOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { fetchDashboardEvents, type DashboardEvent } from '../api/dashboard';

type FilterType = 'All' | 'Sent' | 'Suppressed';

function formatMerchant(id: string): string {
  return id.replace(/^merch_/, '').replace(/^merchant_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface EmailEntry {
  id: string;
  transaction_id: string;
  customer_email: string;
  merchant_id: string;
  amount_paise: number;
  failure_class: string;
  subject: string;
  body: string;
  status: 'sent' | 'suppressed';
  suppression_reason?: string;
  failed_at: string;
}

function extractEmails(events: DashboardEvent[]): EmailEntry[] {
  const emails: EmailEntry[] = [];
  for (const e of events) {
    if (!e.agent?.email_draft) continue;

    // Only count email-related suppressions — ignore RETRY suppressions
    const emailSuppression = e.suppressions?.find(s =>
      s.action_type === 'CONTACT_EMAIL' || s.action_type === 'REAUTH_REQUEST'
    );
    // Check if the email action itself was denied/suppressed
    const emailAction = e.actions?.find(a =>
      a.action_type === 'CONTACT_EMAIL' || a.action_type === 'REAUTH_REQUEST'
    );
    const emailDenied = emailAction?.status === 'DENIED' || emailAction?.status === 'SUPPRESSED';
    const isSuppressed = Boolean(emailSuppression) || emailDenied;
    const suppressionReason = emailSuppression?.reason || (emailDenied ? 'Denied by reviewer' : undefined);

    // Determine actual status from action
    const emailSent = emailAction?.status === 'SUCCEEDED';
    const emailPending = emailAction?.status === 'PENDING_APPROVAL' || emailAction?.status === 'SCHEDULED';

    emails.push({
      id: e.id,
      transaction_id: e.transaction_id,
      customer_email: e.customer_email,
      merchant_id: e.merchant_id,
      amount_paise: e.amount_paise,
      failure_class: e.failure_class,
      subject: e.agent.email_draft.subject,
      body: e.agent.email_draft.body,
      status: isSuppressed ? 'suppressed' : emailSent ? 'sent' : emailPending ? 'sent' : 'sent',
      suppression_reason: suppressionReason,
      failed_at: e.failed_at,
    });
  }
  return emails;
}

export default function EmailOutreach() {
  const [filter, setFilter] = useState<FilterType>('All');
  const [drawerEmail, setDrawerEmail] = useState<EmailEntry | null>(null);
  const [emails, setEmails] = useState<EmailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  const loadData = async () => {
    try {
      const data = await fetchDashboardEvents({ limit: 200 });
      setEmails(extractEmails(data.events));
    } catch {
      setEmails([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    const wsUrl = `ws://${window.location.hostname}:8000/ws/dashboard`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = () => loadData();
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  const sentEmails = emails.filter((e) => e.status === 'sent');
  const suppressedEmails = emails.filter((e) => e.status === 'suppressed');

  const displayed = filter === 'All' ? emails
    : filter === 'Sent' ? sentEmails
    : suppressedEmails;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Email Outreach</span>
        <span className="text-[12px] text-[#9ca3af]">Agent-drafted emails sent and suppressed</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#1b1f2b]">{emails.length}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Emails Drafted</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#22c55e]">{sentEmails.length}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Sent</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#d97706]">{suppressedEmails.length}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Suppressed</div>
        </div>
      </div>

      {/* Filter */}
      <div className="mb-4">
        <Segmented
          options={['All', 'Sent', 'Suppressed']}
          value={filter}
          onChange={(v) => setFilter(v as FilterType)}
        />
      </div>

      {/* Email List */}
      <div className="space-y-3">
        {displayed.length === 0 ? (
          <Empty description={emails.length === 0 ? 'No email drafts yet. Simulate a HARD or MANDATE failure to generate one.' : 'No emails match this filter'} />
        ) : (
          displayed.map((e) => (
            <div
              key={e.id}
              className="border border-[#e5e8ec] rounded-lg px-5 py-4 flex items-start justify-between cursor-pointer hover:border-[#c4c9d4] transition-colors"
              onClick={() => setDrawerEmail(e)}
            >
              <div className="flex items-start gap-3 flex-1">
                <div className="mt-0.5">
                  {e.status === 'sent' ? (
                    <CheckCircleFilled className="text-[#22c55e]" />
                  ) : (
                    <StopOutlined className="text-[#d97706]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[11px] text-[#9ca3af]">{e.transaction_id || e.id.slice(0, 12)}</span>
                    <Tag color={e.status === 'sent' ? 'green' : 'gold'} className="text-[11px] m-0">
                      {e.status === 'sent' ? 'Sent' : 'Suppressed'}
                    </Tag>
                    <Tag className="text-[11px] m-0" color={
                      e.failure_class === 'HARD' ? 'red' :
                      e.failure_class === 'MANDATE' ? 'purple' :
                      e.failure_class === 'SOFT' ? 'orange' : 'default'
                    }>{e.failure_class}</Tag>
                  </div>
                  <div className="text-[13px] text-[#1b1f2b] mb-0.5">
                    <span className="text-[#9ca3af]">Subject:</span> {e.subject}
                  </div>
                  <div className="text-[11px] text-[#9ca3af]">
                    {e.customer_email} &middot; {formatMerchant(e.merchant_id)} &middot; ₹{(e.amount_paise / 100).toLocaleString('en-IN')}
                    {e.suppression_reason && (
                      <span className="text-[#d97706] ml-2">— {e.suppression_reason}</span>
                    )}
                  </div>
                </div>
              </div>
              <MailOutlined className="text-[#d1d5db] mt-1" />
            </div>
          ))
        )}
      </div>

      {/* Email Preview Drawer */}
      <Drawer
        title="Email Preview"
        open={!!drawerEmail}
        onClose={() => setDrawerEmail(null)}
        width={520}
      >
        {drawerEmail && (
          <div>
            {drawerEmail.status === 'suppressed' && (
              <div className="bg-[#fffbeb] border border-[#fde68a] rounded-md px-4 py-3 mb-4 text-[13px] text-[#92400e]">
                This email was suppressed: {drawerEmail.suppression_reason || 'Guardrail override'}
              </div>
            )}

            <div className="space-y-3 mb-6">
              <div className="flex text-[13px]">
                <span className="text-[#9ca3af] w-16">To:</span>
                <span className="text-[#1b1f2b]">{drawerEmail.customer_email}</span>
              </div>
              <div className="flex text-[13px]">
                <span className="text-[#9ca3af] w-16">Subject:</span>
                <span className="text-[#1b1f2b] font-semibold">{drawerEmail.subject}</span>
              </div>
              <div className="flex text-[13px]">
                <span className="text-[#9ca3af] w-16">Status:</span>
                <Tag color={drawerEmail.status === 'sent' ? 'green' : 'gold'}>
                  {drawerEmail.status === 'sent' ? 'Sent' : 'Suppressed'}
                </Tag>
              </div>
            </div>

            <div className="border-t border-[#e5e8ec] pt-4">
              <div className={`bg-[#f8fafc] border border-[#e5e8ec] rounded-md p-5 text-[13px] leading-relaxed whitespace-pre-line ${drawerEmail.status === 'suppressed' ? 'opacity-60' : ''}`}>
                {drawerEmail.body}
              </div>
            </div>

            <div className="mt-4 text-[11px] text-[#9ca3af]">
              Transaction: {drawerEmail.transaction_id || drawerEmail.id.slice(0, 12)} &middot; {formatMerchant(drawerEmail.merchant_id)} &middot; ₹{(drawerEmail.amount_paise / 100).toLocaleString('en-IN')}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
