import { useState, useEffect, useRef } from 'react';
import { Spin, Tag, message, Select } from 'antd';
import { PhoneOutlined, SoundOutlined, CheckCircleFilled, PlayCircleOutlined } from '@ant-design/icons';
import { fetchDashboardEvents, fetchVoiceOptions, type DashboardEvent, type VoiceOption } from '../api/dashboard';
import api from '../api/client';

function buildScript(amt: string, fc: string, reason: string): string {
  const r = reason ? reason.toLowerCase() : '';
  if (fc === 'HARD') {
    return (
      `Hello! I'm calling from Razorpay regarding your recent payment of Rs ${amt}. ` +
      `Unfortunately, the payment could not be processed because ${r || 'your card was declined by the issuing bank'}. ` +
      `You may need to contact your bank or use a different payment method to resolve this. ` +
      `Once that's sorted, you should be able to complete the payment without any issues. ` +
      `If you need any help, our support team is here for you. Thank you!`
    );
  }
  if (fc === 'MANDATE') {
    return (
      `Hello! I'm calling from Razorpay about your auto-payment of Rs ${amt}. ` +
      `It looks like the payment couldn't go through because ${r || 'there seems to be an issue with your payment mandate'}. ` +
      `Could you please check your bank app and verify that your mandate is still active? ` +
      `If it has expired, you'll need to set up a new one. ` +
      `Feel free to reach out if you need any assistance. Thank you!`
    );
  }
  return (
    `Hello! I'm calling from Razorpay regarding your payment of Rs ${amt}. ` +
    `It looks like the payment didn't go through because ${r || 'of a temporary issue on the payment network'}. ` +
    `Don't worry, this seems to be a temporary issue. ` +
    `Could you please try the payment once more? ` +
    `If the problem persists, our team is ready to help. Thank you!`
  );
}

export default function VoiceRecovery() {
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<DashboardEvent | null>(null);
  const [script, setScript] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [callSent, setCallSent] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const loadData = async () => {
    try {
      const data = await fetchDashboardEvents({ limit: 200 });
      setEvents(data.events.filter((e) => e.outcome !== 'recovered'));
    } catch { setEvents([]); } finally { setLoading(false); }
  };

  const loadVoices = async () => {
    try {
      const v = await fetchVoiceOptions();
      const list = Array.isArray(v) ? v : [];
      setVoices(list);
      if (list.length > 0) setSelectedVoice(list[0].voice_id);
    } catch {
      const d: VoiceOption[] = [
        { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'Female', style: 'Reassuring' },
        { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', gender: 'Male', style: 'Warm' },
      ];
      setVoices(d);
      setSelectedVoice(d[0].voice_id);
    }
  };

  useEffect(() => {
    loadData();
    loadVoices();
    const ws = new WebSocket(`ws://${window.location.hostname}:8000/ws/dashboard`);
    ws.onmessage = () => loadData();
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  const handleSelect = (event: DashboardEvent) => {
    setSelectedEvent(event);
    setScript('');
    setAudioUrl(null);
    setCallSent(false);
    setGeneratingScript(true);
    const amt = (event.amount_paise / 100).toLocaleString('en-IN');
    setScript(buildScript(amt, event.failure_class, event.decline_reason));
    setGeneratingScript(false);
  };

  const handleSynthesize = async () => {
    if (!selectedEvent || !script) return;
    setSynthesizing(true);
    setAudioUrl(null);
    try {
      const response = await api.post(
        `/voice/synthesize/${selectedEvent.id}`,
        { script, voice_id: selectedVoice },
        { responseType: 'blob' },
      );
      const blob = new Blob([response.data], { type: 'audio/mpeg' });
      setAudioUrl(URL.createObjectURL(blob));
    } catch {
      message.warning('Audio synthesis unavailable. Check ElevenLabs API key.');
    } finally {
      setSynthesizing(false);
    }
  };

  const fc = (c: string) => c === 'HARD' ? 'red' : c === 'MANDATE' ? 'purple' : c === 'SOFT' ? 'orange' : 'default';

  if (loading) return <div className="flex items-center justify-center h-64"><Spin size="large" /></div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[15px] font-semibold text-[#1b1f2b]">Voice Recovery</span>
        <span className="text-[12px] text-[#9ca3af]">AI-powered voice calls for payment recovery</span>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#1b1f2b]">{events.length}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Pending Failures</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#528FF0]">{selectedEvent ? 1 : 0}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Script Generated</div>
        </div>
        <div className="border border-[#e5e8ec] rounded-lg p-5 text-center">
          <div className="text-[32px] font-extrabold text-[#22c55e]">{callSent ? 1 : 0}</div>
          <div className="text-[11px] text-[#9ca3af] uppercase tracking-wider mt-1">Calls Initiated</div>
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
        {/* Left: Event List */}
        <div className="w-[300px] shrink-0 flex flex-col">
          <div className="text-[13px] font-semibold text-[#1b1f2b] mb-3">Select a failed payment</div>
          <div className="space-y-2 overflow-y-auto flex-1 pr-1">
            {events.length === 0 ? (
              <div className="border border-[#e5e8ec] rounded-lg px-5 py-10 text-center">
                <div className="text-[13px] text-[#9ca3af]">No pending payment failures. Simulate one to get started.</div>
              </div>
            ) : events.map((e) => (
              <div
                key={e.id}
                onClick={() => handleSelect(e)}
                className={`border rounded-lg px-4 py-3 cursor-pointer transition-colors ${selectedEvent?.id === e.id ? 'border-[#528FF0] bg-[#f0f5ff]' : 'border-[#e5e8ec] hover:border-[#c4c9d4]'}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[11px] text-[#9ca3af]">{e.transaction_id || e.id.slice(0, 12)}</span>
                  <Tag color={fc(e.failure_class)} className="text-[11px] m-0">{e.failure_class}</Tag>
                </div>
                <div className="text-[13px] text-[#1b1f2b]">Rs {(e.amount_paise / 100).toLocaleString('en-IN')}</div>
                <div className="text-[11px] text-[#9ca3af] mt-0.5">{e.customer_email}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Script + Audio */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selectedEvent ? (
            <div className="border border-[#e5e8ec] rounded-lg flex items-center justify-center flex-1">
              <div className="text-center">
                <div className="w-[56px] h-[56px] rounded-full bg-[#f3f4f6] flex items-center justify-center mx-auto mb-3">
                  <PhoneOutlined className="text-[24px] text-[#9ca3af]" style={{ transform: 'scaleX(-1)' }} />
                </div>
                <div className="text-[13px] text-[#9ca3af]">Select a payment to generate a recovery call script</div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 flex-1">
              {/* Script Header */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-semibold text-[#1b1f2b]">Call Script</div>
                  <div className="text-[11px] text-[#9ca3af]">
                    {selectedEvent.transaction_id} — {selectedEvent.customer_email} — Rs {(selectedEvent.amount_paise / 100).toLocaleString('en-IN')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Tag color={fc(selectedEvent.failure_class)}>{selectedEvent.failure_class}</Tag>
                  {selectedEvent.decline_reason && <span className="text-[11px] text-[#7b8294]">{selectedEvent.decline_reason}</span>}
                </div>
              </div>

              {/* Script Textarea */}
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                className="border border-[#e5e8ec] rounded-lg p-4 text-[13px] text-[#1b1f2b] leading-relaxed resize-none flex-1 min-h-[180px] focus:outline-none focus:border-[#528FF0] transition-colors"
                placeholder="Script will appear here..."
              />

              {/* Voice Selection + Synthesize */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[12px] text-[#9ca3af] shrink-0">Voice:</span>
                  <Select value={selectedVoice} onChange={setSelectedVoice} className="flex-1" size="small" options={(voices || []).map((v) => ({ value: v.voice_id, label: `${v.name} (${v.gender} - ${v.style})` }))} />
                </div>
                <button
                  onClick={handleSynthesize}
                  disabled={!script || synthesizing}
                  className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${!script || synthesizing ? 'bg-[#e5e8ec] text-[#9ca3af] cursor-not-allowed' : 'bg-[#528FF0] text-white hover:bg-[#4080e0]'}`}
                >
                  <SoundOutlined />
                  {synthesizing ? 'Synthesizing...' : 'Synthesize Audio'}
                </button>
              </div>

              {/* Audio Player */}
              {audioUrl && (
                <div className="border border-[#e5e8ec] rounded-lg px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <PlayCircleOutlined className="text-[#528FF0]" />
                    <span className="text-[12px] font-semibold text-[#1b1f2b]">Preview Audio</span>
                  </div>
                  <audio controls src={audioUrl} className="w-full" />
                </div>
              )}

              {/* Call Button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setCallSent(true); message.success('Voice call initiated. Customer will be contacted shortly.'); }}
                  disabled={callSent}
                  className={`flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-medium transition-colors ${callSent ? 'bg-[#dcfce7] text-[#16a34a] cursor-default' : 'bg-[#1b1f2b] text-white hover:bg-[#2d3348]'}`}
                >
                  {callSent ? <><CheckCircleFilled /> Call Initiated</> : <><PhoneOutlined /> Call Customer</>}
                </button>
                {callSent && <span className="text-[11px] text-[#9ca3af]">Customer will receive the call shortly</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
