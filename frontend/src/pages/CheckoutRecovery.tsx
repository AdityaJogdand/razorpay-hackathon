import { useState, useEffect } from 'react';
import { Button, Tag, Drawer, Empty, Spin, message, Progress, Tooltip } from 'antd';
import {
  ShoppingCartOutlined,
  MailOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  ReloadOutlined,
  UserOutlined,
  CreditCardOutlined,
  MobileOutlined,
  EnvironmentOutlined,
  DownOutlined,
  RightOutlined,
  CheckOutlined,
  CloseCircleFilled,
} from '@ant-design/icons';
import {
  fetchCheckoutEvents,
  fetchCheckoutStats,
  sendCheckoutRecovery,
  previewCheckoutEmail,
  completeCheckout,
  type CheckoutEvent,
  type CheckoutStats,
} from '../api/dashboard';

// ── Constants ──

const STAGE_ICONS: Record<string, React.ReactNode> = {
  LANDING: <ShoppingCartOutlined />,
  CONTACT: <UserOutlined />,
  ADDRESS: <EnvironmentOutlined />,
  PAYMENT: <CreditCardOutlined />,
  INITIATED: <MobileOutlined />,
  FAILED: <CloseCircleFilled />,
};

const STAGE_COLORS: Record<string, string> = {
  LANDING: '#475569',
  CONTACT: '#6366f1',
  ADDRESS: '#8b5cf6',
  PAYMENT: '#0ea5e9',
  INITIATED: '#ef4444',
  FAILED: '#dc2626',
};

const RECOVERY_STAGE_LABELS: Record<string, string> = {
  NONE: 'Not started',
  '1H_SENT': '1st reminder sent',
  '24H_SENT': '2nd reminder sent',
  '72H_SENT': 'Final reminder sent',
  RECOVERED: 'Recovered',
  EXPIRED: 'Expired',
};

// ── Component ──

export default function CheckoutRecovery() {
  const [events, setEvents] = useState<CheckoutEvent[]>([]);
  const [stats, setStats] = useState<CheckoutStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CheckoutEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = async () => {
    try {
      const [eventsData, statsData] = await Promise.all([
        fetchCheckoutEvents(),
        fetchCheckoutStats(),
      ]);
      setEvents(eventsData.events);
      setStats(statsData);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const reloadAndRefreshDrawer = async (eventId: string) => {
    const [eventsData, statsData] = await Promise.all([
      fetchCheckoutEvents(),
      fetchCheckoutStats(),
    ]);
    setEvents(eventsData.events);
    setStats(statsData);
    const updated = eventsData.events.find(e => e.id === eventId);
    if (updated) setSelectedEvent(updated);
  };

  const handleSendRecovery = async (eventId: string) => {
    setActionLoading(eventId);
    try {
      const result = await sendCheckoutRecovery(eventId);
      message.success(`Recovery email #${result.email_number} sent`);
      await reloadAndRefreshDrawer(eventId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send';
      message.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleComplete = async (eventId: string) => {
    setActionLoading(eventId);
    try {
      await completeCheckout(eventId);
      message.success('Checkout completed — payment recovered!');
      await reloadAndRefreshDrawer(eventId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed';
      message.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const openDrawer = (event: CheckoutEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-[22px] font-bold text-[#1b1f2b] m-0">Checkout Drop-off Recovery</h1>
          <p className="text-[13px] text-[#7b8294] m-0 mt-1">Track and recover abandoned checkouts with automated email sequences</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && stats.total_abandoned > 0 && (
        <>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="border border-[#e5e8ec] rounded-lg px-5 py-4">
              <div className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider">Recovered</div>
              <div className="text-[32px] font-extrabold text-[#15803d] mt-1">{stats.recovered_count}</div>
              <div className="text-[12px] text-[#7b8294] mt-0.5">{stats.recovered_amount_display} recovered</div>
            </div>
            <div className="border border-[#e5e8ec] rounded-lg px-5 py-4">
              <div className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider">Abandoned</div>
              <div className="text-[32px] font-extrabold text-[#1b1f2b] mt-1">{stats.total_abandoned}</div>
              <div className="text-[12px] text-[#7b8294] mt-0.5">{stats.total_amount_display} at risk</div>
            </div>
            <div className="border border-[#e5e8ec] rounded-lg px-5 py-4">
              <div className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider">Recoverable</div>
              <div className="text-[32px] font-extrabold text-[#528FF0] mt-1">{stats.recoverable_count}</div>
              <div className="text-[12px] text-[#7b8294] mt-0.5">Have contact info</div>
            </div>
            <div className="border border-[#e5e8ec] rounded-lg px-5 py-4">
              <div className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider">Recovery Rate</div>
              <div className="text-[32px] font-extrabold text-[#1b1f2b] mt-1">{stats.recovery_rate}%</div>
              <div className="text-[12px] text-[#7b8294] mt-0.5">Of recoverable checkouts</div>
            </div>
          </div>

          {/* Funnel */}
          <div className="border border-[#e5e8ec] rounded-lg p-5 mb-6">
            <h3 className="text-[13px] font-semibold text-[#1b1f2b] m-0 mb-4">Drop-off Funnel</h3>
            <div className="flex items-end gap-1 h-[100px]">
              {stats.funnel.map((stage) => {
                const maxCount = Math.max(...stats.funnel.map(s => s.count), 1);
                const height = Math.max((stage.count / maxCount) * 100, 8);
                return (
                  <Tooltip key={stage.stage} title={`${stage.label}: ${stage.count} (${stage.percent}%)`}>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-[11px] font-semibold text-[#1b1f2b]">{stage.count}</span>
                      <div
                        className="w-full rounded-t-md transition-all"
                        style={{
                          height: `${height}%`,
                          backgroundColor: STAGE_COLORS[stage.stage] || '#94a3b8',
                          opacity: 0.8,
                        }}
                      />
                      <span className="text-[10px] text-[#7b8294] text-center leading-tight mt-1">
                        {stage.label.split(' ').slice(0, 2).join(' ')}
                      </span>
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Events table */}
      {events.length === 0 ? (
        <Empty
          description="No abandoned checkouts yet — use the Simulation page to create test events"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <div className="border border-[#e5e8ec] rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-[#f8f9fa] text-[11px] font-semibold text-[#7b8294] uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Checkout</th>
                <th className="text-left px-4 py-2.5">Drop-off Stage</th>
                <th className="text-left px-4 py-2.5">Amount</th>
                <th className="text-left px-4 py-2.5">Recovery</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-right px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.id}
                  className="border-t border-[#f0f0f0] hover:bg-[#f8f9fa] cursor-pointer transition-colors"
                  onClick={() => openDrawer(event)}
                >
                  <td className="px-4 py-3">
                    <div className="text-[13px] font-medium text-[#1b1f2b]">{event.product_name}</div>
                    <div className="text-[11px] text-[#7b8294]">
                      {event.customer_email
                        ? event.customer_email.replace(/(.{2}).*(@.*)/, '$1***$2')
                        : 'No contact info'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Tag
                      style={{
                        color: STAGE_COLORS[event.drop_off_stage],
                        backgroundColor: `${STAGE_COLORS[event.drop_off_stage]}14`,
                        border: `1px solid ${STAGE_COLORS[event.drop_off_stage]}30`,
                        fontSize: '11px',
                        fontWeight: 600,
                      }}
                    >
                      {STAGE_ICONS[event.drop_off_stage]} {event.drop_off_stage_label}
                    </Tag>
                  </td>
                  <td className="px-4 py-3 text-[13px] font-medium text-[#1b1f2b]">
                    {event.amount_display}
                  </td>
                  <td className="px-4 py-3">
                    {event.recovery_emails_sent > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <Progress
                          percent={Math.round((event.recovery_emails_sent / 3) * 100)}
                          size="small"
                          showInfo={false}
                          strokeColor={event.recovered ? '#15803d' : '#528FF0'}
                          style={{ width: 60, margin: 0 }}
                        />
                        <span className="text-[11px] text-[#7b8294]">{event.recovery_emails_sent}/3</span>
                      </div>
                    ) : (
                      <span className="text-[11px] text-[#94a3b8]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {event.recovered ? (
                      <Tag style={{ color: '#15803d', backgroundColor: '#15803d18', border: '1px solid #15803d30', fontSize: '11px', fontWeight: 600 }}>
                        <CheckCircleFilled /> Recovered
                      </Tag>
                    ) : !event.customer_email ? (
                      <Tag style={{ fontSize: '11px', color: '#94a3b8' }}>No contact</Tag>
                    ) : (
                      <Tag style={{ fontSize: '11px', color: '#7b8294' }}>
                        <ClockCircleOutlined /> {RECOVERY_STAGE_LABELS[event.recovery_stage] || 'Pending'}
                      </Tag>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!event.recovered && event.customer_email && event.recovery_emails_sent < 3 && (
                      <Button
                        size="small"
                        type="link"
                        icon={<MailOutlined />}
                        loading={actionLoading === event.id}
                        onClick={(e) => { e.stopPropagation(); handleSendRecovery(event.id); }}
                      >
                        Send
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Drawer */}
      <Drawer
        title={null}
        placement="right"
        width={460}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        closable
        styles={{ body: { padding: 0 }, header: { display: 'none' } }}
      >
        {selectedEvent && (
          <CheckoutDetail
            event={selectedEvent}
            onSendRecovery={handleSendRecovery}
            onComplete={handleComplete}
            loading={actionLoading}
          />
        )}
      </Drawer>
    </div>
  );
}


// ═══════════════════════════════════════════════
// Drawer detail component
// ═══════════════════════════════════════════════

function CheckoutDetail({
  event,
  onSendRecovery,
  onComplete,
  loading,
}: {
  event: CheckoutEvent;
  onSendRecovery: (id: string) => void;
  onComplete: (id: string) => void;
  loading: string | null;
}) {
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(true);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [nextEmail, setNextEmail] = useState<{ subject: string; body: string } | null>(null);
  const [viewingSentEmail, setViewingSentEmail] = useState<number | null>(null);
  const [nextEmailTo, setNextEmailTo] = useState<string | null>(null);
  const stageColor = STAGE_COLORS[event.drop_off_stage] || '#94a3b8';
  const canSendEmail = !event.recovered && event.customer_email && event.recovery_emails_sent < 3;
  const canComplete = !event.recovered && event.recovery_emails_sent > 0;

  // Get last sent email for preview
  const lastEmailAction = [...event.recovery_actions]
    .reverse()
    .find(a => a.type.startsWith('RECOVERY_EMAIL'));

  // Load next email preview
  useEffect(() => {
    if (canSendEmail) {
      previewCheckoutEmail(event.id)
        .then(res => { setNextEmail(res.email); setNextEmailTo(res.sent_to); })
        .catch(() => setNextEmail(null));
    } else {
      setNextEmail(null);
    }
  }, [event.id, event.recovery_emails_sent, canSendEmail]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-[#e5e8ec]">
        <div className="flex items-center gap-2 mb-2">
          <Tag color={stageColor} style={{ color: '#fff', border: 'none', fontSize: '11px' }}>
            {event.drop_off_stage_label}
          </Tag>
          {event.recovered && (
            <Tag color="#15803d" style={{ color: '#fff', border: 'none', fontSize: '11px' }}>
              <CheckCircleFilled /> Recovered
            </Tag>
          )}
        </div>
        <h2 className="text-[17px] font-semibold text-[#1b1f2b] m-0 mb-1">{event.product_name}</h2>
        <div className="text-[14px] text-[#3b4055]">
          {event.amount_display}
          {event.customer_email && (
            <span className="text-[#7b8294]"> · {event.customer_email.replace(/(.{2}).*(@.*)/, '$1***$2')}</span>
          )}
        </div>
        <div className="text-[12px] text-[#7b8294] mt-1">{event.checkout_id}</div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Drop-off reason */}
        <div className="px-6 py-4 border-b border-[#e5e8ec]">
          <h3 className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider m-0 mb-2">
            Why they left
          </h3>
          <div className="bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg px-3 py-2.5">
            <div className="text-[13px] text-[#1b1f2b]">{event.drop_off_reason}</div>
            <div className="text-[11px] text-[#7b8294] mt-1">
              Dropped at: {event.drop_off_stage_label} ·{' '}
              {new Date(event.abandoned_at).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
              })}
            </div>
          </div>
        </div>

        {/* No contact info banner */}
        {!event.customer_email && (
          <div className="mx-6 mt-4 mb-0 bg-[#f9fafb] border border-[#e5e8ec] rounded-lg px-4 py-3 flex items-start gap-2.5">
            <CloseCircleFilled className="text-[#94a3b8] text-[14px] mt-0.5 shrink-0" />
            <div>
              <div className="text-[13px] font-medium text-[#1b1f2b]">Recovery not possible</div>
              <div className="text-[12px] text-[#7b8294] mt-0.5">
                Customer dropped off before entering contact info. No email or phone number was captured, so automated recovery cannot be triggered.
              </div>
            </div>
          </div>
        )}

        {/* Recovery progress */}
        <div className="px-6 py-4 border-b border-[#e5e8ec]">
          <h3 className="text-[12px] font-semibold text-[#7b8294] uppercase tracking-wider m-0 mb-3">
            Recovery Sequence
          </h3>
          <div className="space-y-0">
            {[
              { label: '1st reminder (1h)', stage: '1H_SENT', num: 1 },
              { label: '2nd reminder (24h)', stage: '24H_SENT', num: 2 },
              { label: 'Final reminder (72h)', stage: '72H_SENT', num: 3 },
            ].map((step, i) => {
              const sent = event.recovery_emails_sent >= step.num;
              const isCurrent = event.recovery_emails_sent === step.num - 1 && !event.recovered;
              const emailAction = event.recovery_actions.find(a => a.type === `RECOVERY_EMAIL_${step.num}`);

              return (
                <div key={step.stage} className="flex items-start gap-3">
                  {/* Node */}
                  <div className="flex flex-col items-center w-5 shrink-0">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                      event.recovered && sent ? 'bg-[#15803d] text-white' :
                      sent ? 'bg-[#22c55e] text-white' :
                      isCurrent ? 'bg-white border-2 border-[#c4cdd5] text-[#7b8294]' :
                      'bg-[#f1f5f9] text-[#94a3b8]'
                    }`}>
                      {sent ? <CheckCircleFilled /> :
                       isCurrent ? <MailOutlined style={{ fontSize: 10 }} /> :
                       <span className="font-semibold">{step.num}</span>}
                    </div>
                    {i < 2 && <div className={`w-0.5 h-6 ${sent ? 'bg-[#86efac]' : 'bg-[#e5e8ec]'}`} />}
                  </div>
                  {/* Content */}
                  <div className="flex-1 pb-2 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] ${sent ? 'text-[#1b1f2b]' : 'text-[#94a3b8]'}`}>
                        {step.label}
                      </span>
                      {emailAction?.email && (
                        <span
                          className="text-[11px] text-[#528FF0] cursor-pointer hover:underline select-none"
                          onClick={() => setViewingSentEmail(viewingSentEmail === step.num ? null : step.num)}
                        >
                          {viewingSentEmail === step.num ? 'Hide' : 'View email'}
                        </span>
                      )}
                    </div>
                    {emailAction && (
                      <div className="text-[11px] text-[#7b8294]">
                        Sent {new Date(emailAction.sent_at).toLocaleString('en-IN', {
                          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </div>
                    )}
                    {viewingSentEmail === step.num && emailAction?.email && (
                      <div className="mt-2 border border-[#e5e8ec] rounded-lg overflow-hidden">
                        <div className="bg-[#f8f9fa] px-3 py-1.5 border-b border-[#e5e8ec]">
                          <span className="text-[12px] font-medium text-[#1b1f2b]">{emailAction.email.subject}</span>
                        </div>
                        <div className="bg-white px-3 py-2 text-[12px] text-[#3b4055] leading-relaxed whitespace-pre-wrap">
                          {emailAction.email.body}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Recovery step */}
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center w-5 shrink-0">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                  event.recovered ? 'bg-[#15803d] text-white' : 'bg-[#f1f5f9] text-[#94a3b8]'
                }`}>
                  {event.recovered ? <CheckCircleFilled /> : <ShoppingCartOutlined style={{ fontSize: 10 }} />}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] ${event.recovered ? 'text-[#15803d] font-medium' : 'text-[#94a3b8]'}`}>
                  {event.recovered ? 'Checkout completed' : 'Awaiting customer return'}
                </div>
                {event.recovered_at && (
                  <div className="text-[11px] text-[#7b8294]">
                    {new Date(event.recovered_at).toLocaleString('en-IN', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Sticky footer */}
      {!event.recovered && (
        <div className="border-t border-[#e5e8ec] bg-white shrink-0">
          {/* Next email preview */}
          {canSendEmail && nextEmail && (
            <div className="mx-6 mt-4 mb-2 bg-[#f8f9fa] border border-[#e5e8ec] rounded-lg">
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                onClick={() => setEmailPreviewOpen(v => !v)}
              >
                <MailOutlined className="text-[13px] text-[#7b8294]" />
                <span className="text-[12px] font-semibold text-[#1b1f2b]">
                  Email #{event.recovery_emails_sent + 1} Preview
                </span>
                {nextEmailTo && (
                  <span className="text-[11px] text-[#7b8294]">
                    — {nextEmailTo.replace(/(.{2}).*(@.*)/, '$1***$2')}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-[#7b8294]">
                  {emailPreviewOpen ? <DownOutlined /> : <RightOutlined />}
                </span>
              </div>
              {emailPreviewOpen && (
                <div className="border-t border-[#e5e8ec]">
                  <div className="bg-white px-3 py-2 border-b border-[#e5e8ec]">
                    <span className="text-[12px] font-medium text-[#1b1f2b]">{nextEmail.subject}</span>
                  </div>
                  <div className={`bg-white px-3 py-2.5 text-[13px] text-[#3b4055] leading-relaxed whitespace-pre-wrap overflow-y-auto ${emailExpanded ? '' : 'max-h-[240px]'}`}
                    style={emailExpanded ? {} : {}}
                  >
                    {nextEmail.body}
                  </div>
                  <div
                    className="bg-[#f8f9fa] px-3 py-2 text-center border-t border-[#e5e8ec] rounded-b-lg cursor-pointer select-none hover:bg-[#eef1f5] transition-colors"
                    onClick={() => setEmailExpanded(v => !v)}
                  >
                    <span className="text-[12px] font-medium text-[#3b4055]">
                      {emailExpanded ? '▲ Collapse email' : '▼ Expand full email'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-3 px-6 py-3">
            {canSendEmail && (
              <Button
                type="primary"
                icon={<MailOutlined />}
                loading={loading === event.id}
                onClick={() => onSendRecovery(event.id)}
                style={{ flex: 1, backgroundColor: '#1b1f2b', borderColor: '#1b1f2b' }}
              >
                Approve & Send Email #{event.recovery_emails_sent + 1}
              </Button>
            )}
            {canComplete && (
              <Button
                type={canSendEmail ? 'default' : 'primary'}
                icon={<CheckOutlined />}
                loading={loading === event.id}
                onClick={() => onComplete(event.id)}
                style={canSendEmail
                  ? { flex: 0 }
                  : { flex: 1, backgroundColor: '#22c55e', borderColor: '#22c55e' }
                }
              >
                {canSendEmail ? 'Mark Recovered' : 'Simulate Customer Payment'}
              </Button>
            )}
            {!canSendEmail && !canComplete && (
              <div className="text-[13px] text-[#94a3b8] text-center w-full">
                No contact info captured — recovery not possible
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
