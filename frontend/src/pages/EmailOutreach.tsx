import { useState } from 'react';
import { Typography, Segmented, Tag, Drawer, Empty } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  MailOutlined,
} from '@ant-design/icons';
import { MOCK_TRANSACTIONS } from '../mock/data';

const emailTxns = MOCK_TRANSACTIONS.filter((t) => t.email_draft);
const sentEmails = emailTxns.filter((t) => t.email_draft!.status === 'sent');
const suppressedEmails = emailTxns.filter((t) => t.email_draft!.status === 'suppressed');

type FilterType = 'All' | 'Sent' | 'Suppressed';

export default function EmailOutreach() {
  const [filter, setFilter] = useState<FilterType>('All');
  const [drawerTxn, setDrawerTxn] = useState<typeof emailTxns[0] | null>(null);

  const displayed = filter === 'All' ? emailTxns
    : filter === 'Sent' ? sentEmails
    : suppressedEmails;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Typography.Title level={4} className="!mb-1 !text-slate-800">Email Outreach</Typography.Title>
        <div className="text-sm text-slate-500">
          Agent-drafted emails sent and suppressed this batch
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-slate-700">{emailTxns.length}</div>
          <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">Emails Drafted</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{sentEmails.length}</div>
          <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">Sent</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-amber-600">{suppressedEmails.length}</div>
          <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">Suppressed</div>
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
          <Empty description="No emails match this filter" />
        ) : (
          displayed.map((t) => (
            <div
              key={t.id}
              className="bg-white border border-slate-200 rounded-lg px-5 py-4 flex items-start justify-between cursor-pointer hover:border-slate-300 transition-colors"
              onClick={() => setDrawerTxn(t)}
            >
              <div className="flex items-start gap-3 flex-1">
                <div className="mt-0.5">
                  {t.email_draft!.status === 'sent' ? (
                    <CheckCircleFilled className="text-green-500" />
                  ) : (
                    <CloseCircleFilled className="text-amber-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs text-slate-400">{t.id}</span>
                    <Tag color={t.email_draft!.status === 'sent' ? 'green' : 'gold'} className="text-xs m-0">
                      {t.email_draft!.status === 'sent' ? 'Sent' : 'Suppressed'}
                    </Tag>
                  </div>
                  <div className="text-sm text-slate-700 mb-0.5">
                    <span className="text-slate-400">Subject:</span> {t.email_draft!.subject}
                  </div>
                  <div className="text-xs text-slate-400">
                    {t.customer_email} &middot; {t.merchant}
                    {t.email_draft!.suppression_reason && (
                      <span className="text-amber-600 ml-2">
                        — {t.email_draft!.suppression_reason}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <MailOutlined className="text-slate-300 mt-1" />
            </div>
          ))
        )}
      </div>

      {/* Email Preview Drawer */}
      <Drawer
        title="Email Preview"
        open={!!drawerTxn}
        onClose={() => setDrawerTxn(null)}
        width={520}
      >
        {drawerTxn?.email_draft && (
          <div>
            {drawerTxn.email_draft.status === 'suppressed' && (
              <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 mb-4 text-sm text-amber-700">
                This email was suppressed: {drawerTxn.email_draft.suppression_reason}
              </div>
            )}

            <div className="space-y-3 mb-6">
              <div className="flex text-sm">
                <span className="text-slate-400 w-16">To:</span>
                <span className="text-slate-700">{drawerTxn.customer_email}</span>
              </div>
              <div className="flex text-sm">
                <span className="text-slate-400 w-16">Subject:</span>
                <span className="text-slate-700 font-medium">{drawerTxn.email_draft.subject}</span>
              </div>
              <div className="flex text-sm">
                <span className="text-slate-400 w-16">Status:</span>
                <Tag color={drawerTxn.email_draft.status === 'sent' ? 'green' : 'gold'}>
                  {drawerTxn.email_draft.status === 'sent' ? 'Sent' : 'Suppressed'}
                </Tag>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className={`bg-slate-50 border border-slate-200 rounded-md p-5 text-sm leading-relaxed whitespace-pre-line ${drawerTxn.email_draft.status === 'suppressed' ? 'opacity-60' : ''}`}>
                {drawerTxn.email_draft.body}
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-400">
              Transaction: {drawerTxn.id} &middot; {drawerTxn.merchant} &middot; ₹{(drawerTxn.amount / 100).toLocaleString('en-IN')}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
