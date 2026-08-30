import { useState, useEffect } from 'react';
import { Select, Spin, Drawer } from 'antd';
import { fetchDashboardEvents, type DashboardEvent } from '../api/dashboard';
import clockSvg from '../assets/clock.svg';
import xCircleSvg from '../assets/x-circle.svg';
import sealCheckSvg from '../assets/seal-check.svg';
import warningSvg from '../assets/warning.svg';

function formatAmount(paise: number): string {
  return '\u20B9' + (paise / 100).toLocaleString('en-IN');
}

const friendlyName: Record<string, string> = {
  hard_no_retry: 'Don\u2019t retry dead cards',
  mandate_no_retry: 'Don\u2019t retry revoked mandates',
  max_retry_count: 'Retry limit not exceeded',
  retry_window: 'Within retry time window',
  contact_frequency_cap: 'Contact limit not exceeded',
  customer_opt_out: 'Customer allows communication',
  no_email_on_file: 'Email address available',
  unknown_must_escalate: 'Unknown failures need human review',
  kill_switch: 'System is active',
};

export default function ExceptionQueue() {
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('exception_resolved');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawerEvent, setDrawerEvent] = useState<DashboardEvent | null>(null);

  useEffect(() => {
    if (resolved.size > 0) {
      localStorage.setItem('exception_resolved', JSON.stringify([...resolved]));
    }
  }, [resolved]);

  useEffect(() => {
    fetchDashboardEvents({ limit: 200, failure_class: 'UNKNOWN' })
      .then((res) => setEvents(res.events))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const pendingCount = events.filter((e) => !resolved.has(e.id)).length;
  const resolvedCount = resolved.size;
  const totalValue = events.reduce((s, e) => s + e.amount_paise, 0);
  const avgConfidence = events.length > 0
    ? events.reduce((s, e) => s + e.classification_confidence, 0) / events.length
    : 0;

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Spin size="large" /></div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ height: '60vh' }}>
        <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="#d9d9d9" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
        </svg>
        <p className="text-[15px] font-semibold text-[#6b7280] mt-5">Backend Unavailable</p>
        <p className="text-[13px] text-[#9ca3af] mt-1">Could not load exception queue</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-1.5 text-[13px] font-medium text-[#528FF0] border border-[#528FF0] rounded-md hover:bg-[#528FF0] hover:text-white transition-colors cursor-pointer">Retry</button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 mb-5">
          <span className="text-[15px] font-semibold text-[#1b1f2b]">Exception Queue</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center -mt-10">
          <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill="#d9d9d9" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
          </svg>
          <p className="text-[15px] font-semibold text-[#1b1f2b] mt-5">All clear</p>
          <p className="text-[13px] text-[#9ca3af] mt-1">No unclassified failures require human review</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-none">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Exception Queue</span>
      </div>

      {/* Banner */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 bg-[#fef9ee] border border-[#f5e6c8] rounded-lg px-5 py-3 mb-4 flex-none">
          <img src={warningSvg} alt="" className="w-[18px] h-[18px] shrink-0" />
          <span className="text-[13px] text-[#1b1f2b]">
            <span className="font-semibold">{pendingCount} transaction{pendingCount !== 1 ? 's' : ''}</span> could not be classified and require{pendingCount === 1 ? 's' : ''} human review
          </span>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-4 gap-3 mb-5 flex-none">
        {[
          { label: 'Pending Review', value: String(pendingCount), color: '#1b1f2b' },
          { label: 'Resolved', value: String(resolvedCount), color: '#22c55e' },
          { label: 'Value at Risk', value: formatAmount(totalValue), color: '#1b1f2b' },
          { label: 'Avg. Confidence', value: `${Math.round(avgConfidence * 100)}%`, color: avgConfidence < 0.5 ? '#ef4444' : '#1b1f2b' },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-white rounded-lg border border-[#e5e8ec] px-4 py-3">
            <div className="text-[11px] text-[#7b8294] mb-0.5">{kpi.label}</div>
            <div className="text-[22px] font-extrabold leading-none" style={{ color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Column Header */}
      <div className="flex items-center px-4 py-1.5 text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider flex-none select-none">
        <div className="w-[100px] shrink-0">Amount</div>
        <div className="flex-1 min-w-0 pl-3">Failure</div>
        <div className="w-[60px] shrink-0 text-center">Conf.</div>
        <div className="w-[150px] shrink-0 text-center">Recommendation</div>
        <div className="w-[130px] shrink-0 text-center">Status</div>
      </div>

      {/* Queue */}
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[#e5e8ec]">
        {events.map((event, idx) => {
          const isResolved = resolved.has(event.id);
          const isExpanded = expandedId === event.id;
          const action = event.agent.proposed_action || event.policy_action || '';
          const confidence = Math.round(event.classification_confidence * 100);
          const isEscalate = action === 'ESCALATE_HUMAN';

          return (
            <div
              key={event.id}
              className={`bg-white ${idx > 0 ? 'border-t border-[#eef0f3]' : ''} ${isResolved ? 'opacity-40' : ''}`}
            >
              <div
                className={`flex items-center px-4 py-2.5 cursor-pointer transition-all duration-100 group ${isExpanded ? 'bg-[#f8f9fb]' : 'hover:bg-[#f8f9fb]'}`}
                onClick={() => setExpandedId(isExpanded ? null : event.id)}
              >
                {/* Amount */}
                <div className="w-[100px] shrink-0">
                  <div className="text-[13px] font-semibold text-[#1b1f2b] tabular-nums">{formatAmount(event.amount_paise)}</div>
                  <div className="text-[10px] text-[#b0b5c0] mt-0.5 font-mono truncate">{event.transaction_id.slice(0, 14)}</div>
                </div>

                {/* Failure Reason — primary */}
                <div className="flex-1 min-w-0 pl-3 pr-4">
                  <div className="text-[12px] text-[#1b1f2b] truncate">{event.decline_reason}</div>
                  <code className="text-[10px] text-[#b0b5c0]">{event.decline_code}</code>
                </div>

                {/* Confidence */}
                <div className="w-[60px] shrink-0 text-center">
                  <span className={`text-[12px] font-semibold tabular-nums ${confidence < 50 ? 'text-[#ef4444]' : confidence < 70 ? 'text-[#d97706]' : 'text-[#22c55e]'}`}>
                    {confidence}%
                  </span>
                </div>

                {/* Recommendation */}
                <div className="w-[150px] shrink-0 text-center">
                  {action ? (
                    <span className={`text-[11px] font-medium ${isEscalate ? 'text-[#c2410c]' : 'text-[#1b1f2b]'}`}>
                      {isEscalate ? 'Escalate to human' : action.replace(/_/g, ' ')}
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#c4c9d4]">&mdash;</span>
                  )}
                </div>

                {/* Status + Chevron */}
                <div className="w-[130px] shrink-0 flex items-center justify-center gap-2 whitespace-nowrap">
                  {isResolved ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#22c55e]">
                      <img src={sealCheckSvg} alt="" className="w-[12px] h-[12px]" />
                      Resolved
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#d97706]">
                      <img src={clockSvg} alt="" className="w-[12px] h-[12px]" />
                      Needs review
                    </span>
                  )}
                  <span className={`text-[12px] text-[#c4c9d4] transition-transform duration-100 inline-block leading-none ${isExpanded ? 'rotate-90' : ''} group-hover:text-[#9ca3af]`}>&#8250;</span>
                </div>
              </div>

              {/* Expanded */}
              {isExpanded && (
                <div className="border-t border-[#eef0f3] px-5 py-4 bg-[#f8f9fb]">
                  <div className="grid grid-cols-[1fr_1fr] gap-8">
                    {/* Left */}
                    <div>
                      {event.agent.reasoning && (
                        <div className="mb-4">
                          <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Agent Analysis</div>
                          <div className="text-[13px] text-[#3b4055] leading-[1.6]">{event.agent.reasoning}</div>
                        </div>
                      )}
                      {event.guardrail.checks.length > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">
                            Guardrail Checks
                            <span className={`ml-1.5 text-[10px] font-semibold ${event.guardrail.checks.every((c) => c.passed) ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                              {event.guardrail.checks.filter((c) => c.passed).length}/{event.guardrail.checks.length} passed
                            </span>
                          </div>
                          <div className="space-y-1">
                            {event.guardrail.checks.map((c, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-[12px]">
                                <img src={c.passed ? sealCheckSvg : xCircleSvg} alt="" className="w-[13px] h-[13px]" />
                                <span className="text-[#3b4055]">{friendlyName[c.rule] || c.rule}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Right */}
                    <div>
                      <div className="mb-4">
                        <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5">Transaction Details</div>
                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                          <span className="text-[#9ca3af]">Customer</span>
                          <span className="text-[#1b1f2b] truncate">{event.customer_email || event.customer_id}</span>
                          <span className="text-[#9ca3af]">Instrument</span>
                          <span className="text-[#1b1f2b]">{event.instrument_type}</span>
                          <span className="text-[#9ca3af]">Failed</span>
                          <span className="text-[#1b1f2b]">{new Date(event.failed_at).toLocaleString()}</span>
                          <span className="text-[#9ca3af]">Source</span>
                          <span className="text-[#1b1f2b]">{event.classification_source}</span>
                        </div>
                      </div>

                      {!isResolved ? (
                        <div>
                          <div className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Resolve</div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={(e) => { e.stopPropagation(); setResolved(new Set(resolved).add(event.id)); }}
                              className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#528FF0] rounded-md hover:bg-[#4280e0] transition-colors cursor-pointer border-0"
                            >
                              Approve as SOFT
                            </button>
                            <Select
                              placeholder="Override"
                              size="small"
                              style={{ width: 145 }}
                              options={[
                                { value: 'HARD', label: 'Override \u2192 HARD' },
                                { value: 'SOFT', label: 'Override \u2192 SOFT' },
                                { value: 'MANDATE', label: 'Override \u2192 MANDATE' },
                              ]}
                              onChange={() => setResolved(new Set(resolved).add(event.id))}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <button
                              onClick={(e) => { e.stopPropagation(); setResolved(new Set(resolved).add(event.id)); }}
                              className="px-3 py-1.5 text-[12px] font-medium text-[#3b4055] bg-white border border-[#e5e8ec] rounded-md hover:bg-[#f5f6f8] transition-colors cursor-pointer"
                            >
                              Escalate
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-[13px] text-[#22c55e] font-medium">
                          <img src={sealCheckSvg} alt="" className="w-[15px] h-[15px]" />
                          Resolved
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Drawer */}
      <Drawer
        open={!!drawerEvent}
        onClose={() => setDrawerEvent(null)}
        width={480}
        title={null}
        closable
        styles={{ body: { padding: '20px' } }}
      >
        {drawerEvent && (
          <div>
            <div className="mb-4">
              <div className="text-[12px] text-[#9ca3af] mb-1">{drawerEvent.merchant_id} &middot; {drawerEvent.transaction_id}</div>
              <div className="text-[28px] font-extrabold text-[#1b1f2b]">{formatAmount(drawerEvent.amount_paise)}</div>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-5">
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f5f6f8] text-[11px] font-medium text-[#1b1f2b]">
                <img src={xCircleSvg} alt="" className="w-[12px] h-[12px]" /> UNKNOWN
              </span>
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f5f6f8] text-[11px] font-medium text-[#1b1f2b]">
                <img src={sealCheckSvg} alt="" className="w-[12px] h-[12px]" /> {Math.round(drawerEvent.classification_confidence * 100)}% confidence
              </span>
            </div>
            <div className="mb-4">
              <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1">Failure Reason</div>
              <div className="text-[13px] text-[#1b1f2b]">{drawerEvent.decline_reason}</div>
              <code className="text-[11px] text-[#7b8294] mt-1 block">{drawerEvent.decline_code}</code>
            </div>
            {drawerEvent.agent.reasoning && (
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-1">Agent Reasoning</div>
                <div className="bg-[#f9fafb] rounded-lg p-3 text-[13px] text-[#3b4055] leading-relaxed">{drawerEvent.agent.reasoning}</div>
              </div>
            )}
            {drawerEvent.guardrail.checks.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Guardrail Checks</div>
                <div className="space-y-1.5">
                  {drawerEvent.guardrail.checks.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <img src={c.passed ? sealCheckSvg : xCircleSvg} alt="" className="w-[14px] h-[14px]" />
                      <span className="text-[#3b4055]">{friendlyName[c.rule] || c.rule}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {drawerEvent.actions.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider mb-2">Actions</div>
                {drawerEvent.actions.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-[12px] py-1.5 border-b border-[#f0f0f0] last:border-0">
                    <span className="text-[#3b4055]">{a.action_type.replace(/_/g, ' ')}</span>
                    <span className={`text-[11px] font-medium ${a.status === 'SUCCEEDED' ? 'text-[#22c55e]' : a.status === 'FAILED' ? 'text-[#ef4444]' : 'text-[#528FF0]'}`}>{a.status}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-[#e5e8ec] pt-3 mt-4 grid grid-cols-2 gap-y-2 text-[12px]">
              <div className="text-[#9ca3af]">Customer</div>
              <div className="text-[#1b1f2b]">{drawerEvent.customer_email || drawerEvent.customer_id}</div>
              <div className="text-[#9ca3af]">Instrument</div>
              <div className="text-[#1b1f2b]">{drawerEvent.instrument_type}</div>
              <div className="text-[#9ca3af]">Failed At</div>
              <div className="text-[#1b1f2b]">{new Date(drawerEvent.failed_at).toLocaleString()}</div>
              <div className="text-[#9ca3af]">Classification Source</div>
              <div className="text-[#1b1f2b]">{drawerEvent.classification_source}</div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
