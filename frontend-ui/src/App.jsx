/**
 * src/App.jsx — TenderSync Pro | Root Component
 * ===============================================
 * Boot sequence:
 *   1. DB initialises  →
 *   2. SplashScreen (15 seconds)  →
 *   3. First-run setup wizard (if needed)  →
 *   4. Main Dashboard
 */

import { useState, useEffect } from 'react';
import SplashScreen from './components/SplashScreen';
import Dashboard from './components/Dashboard';
import { getSetting, setSetting } from './store/db';

function SetupScreen({ onComplete }) {
  const [step, setStep]   = useState(0);
  const [extId, setExtId] = useState('');
  const [error, setError] = useState('');

  const handleFinish = async () => {
    if (!extId.trim()) { setError('Paste your Extension ID to continue.'); return; }
    await setSetting('extensionId', extId.trim());
    await setSetting('setupDone', true);
    onComplete(extId.trim());
  };

  const STEPS = [
    {
      icon: '📦',
      title: 'Install the Chrome Extension',
      desc: 'Load the /chrome-extension folder in Chrome via chrome://extensions → "Load Unpacked". This is the scraping engine that runs inside your browser.',
    },
    {
      icon: '🔑',
      title: 'Copy your Extension ID',
      desc: 'After loading, Chrome shows a 32-character ID under the extension name. Copy it.',
    },
    {
      icon: '🔌',
      title: 'Paste it here to connect',
      desc: 'Links the dashboard to your local extension. Scraper runs in your browser — no IP blocks, no CORS.',
      action: (
        <div style={{ marginTop: 14 }}>
          <input
            style={stp.input}
            placeholder="e.g. abcdefghijklmnopqrstuvwxyz012345"
            value={extId}
            onChange={e => { setExtId(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleFinish()}
            autoFocus
          />
          {error && <p style={{ color:'#ef4444', fontSize:12, marginTop:6 }}>{error}</p>}
        </div>
      ),
    },
  ];

  return (
    <div style={stp.overlay}>
      <div style={stp.card}>
        <div style={stp.logo}>🏛️</div>
        <h1 style={stp.h1}>TENDERSYNC PRO</h1>
        <p style={stp.sub}>Enterprise AI Procurement Suite</p>
        <p style={stp.sub2}>Designed &amp; Engineered By Ankur Nagwan</p>

        <div style={stp.stepsWrap}>
          {STEPS.map((s, i) => (
            <div
              key={i}
              style={{
                ...stp.step,
                opacity:     step >= i ? 1 : 0.35,
                borderColor: step === i ? '#3b82f6' : step > i ? '#22c55e' : 'rgba(255,255,255,0.08)',
                background:  step === i ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)',
                cursor: 'pointer',
              }}
              onClick={() => setStep(i)}
            >
              <div style={stp.stepIcon}>{step > i ? '✅' : s.icon}</div>
              <div style={{ flex:1 }}>
                <div style={stp.stepTitle}>{s.title}</div>
                <div style={stp.stepDesc}>{s.desc}</div>
                {step === i && s.action}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', gap:10, marginTop:8 }}>
          {step < STEPS.length - 1 ? (
            <button style={stp.btn} onClick={() => setStep(s => s + 1)}>Next →</button>
          ) : (
            <button style={{ ...stp.btn, background:'#16a34a' }} onClick={handleFinish}>
              🚀 Launch Dashboard
            </button>
          )}
          <button style={stp.btnSkip} onClick={() => onComplete('')}>Skip setup</button>
        </div>

        <div style={stp.footer}>
          Runs 100% locally · Zero server cost · No data leaves your machine
        </div>
      </div>
    </div>
  );
}

// ── App states ────────────────────────────────────────────────────────────────
const STATE = { LOADING:'loading', SPLASH:'splash', SETUP:'setup', APP:'app' };

export default function App() {
  const [appState, setAppState] = useState(STATE.LOADING);

  // Determine if setup was previously completed
  useEffect(() => {
    getSetting('setupDone', false).then(done => {
      setAppState(STATE.SPLASH); // always show splash first
      // Store setup status for after splash
      window.__setupDone = !!done;
    });
  }, []);

  const handleSplashComplete = () => {
    setAppState(window.__setupDone ? STATE.APP : STATE.SETUP);
  };

  const handleSetupComplete = () => {
    setAppState(STATE.APP);
  };

  if (appState === STATE.LOADING) {
    return (
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        height:'100vh', background:'#0a0f1e',
      }}>
        <div style={{ color:'#3b82f6', fontSize:28 }}>⚡</div>
      </div>
    );
  }

  if (appState === STATE.SPLASH) {
    return <SplashScreen onComplete={handleSplashComplete} />;
  }

  if (appState === STATE.SETUP) {
    return <SetupScreen onComplete={handleSetupComplete} />;
  }

  return <Dashboard />;
}

// ── Setup screen styles ────────────────────────────────────────────────────────
const stp = {
  overlay:   { display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'radial-gradient(ellipse at 50% 0%, #0d1f3c 0%, #0a0f1e 60%)', padding:24 },
  card:      { background:'rgba(15,23,42,0.95)', border:'1px solid rgba(59,130,246,0.2)', borderRadius:18, padding:'36px 40px', maxWidth:560, width:'100%', textAlign:'center', boxShadow:'0 0 80px rgba(59,130,246,0.08)' },
  logo:      { fontSize:44, marginBottom:12 },
  h1:        { fontSize:22, fontWeight:800, color:'#f8fafc', margin:0, letterSpacing:'2px', fontFamily:"'JetBrains Mono','Consolas',monospace" },
  sub:       { fontSize:13, color:'#475569', margin:'6px 0 2px' },
  sub2:      { fontSize:11, color:'#334155', margin:'0 0 28px', fontFamily:'monospace' },
  stepsWrap: { display:'flex', flexDirection:'column', gap:10, marginBottom:20, textAlign:'left' },
  step:      { display:'flex', alignItems:'flex-start', gap:14, padding:'14px 16px', borderRadius:10, border:'1px solid', transition:'all 0.2s' },
  stepIcon:  { fontSize:20, flexShrink:0, marginTop:2 },
  stepTitle: { fontSize:13, fontWeight:700, color:'#e2e8f0', marginBottom:3 },
  stepDesc:  { fontSize:12, color:'#64748b', lineHeight:1.5 },
  input:     { width:'100%', background:'rgba(255,255,255,0.06)', border:'1px solid rgba(59,130,246,0.4)', borderRadius:8, padding:'10px 14px', color:'#f8fafc', fontSize:13, outline:'none', fontFamily:'monospace', boxSizing:'border-box' },
  btn:       { flex:1, padding:'12px 20px', background:'#1d4ed8', color:'white', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'JetBrains Mono','Consolas',monospace" },
  btnSkip:   { padding:'12px 20px', background:'rgba(255,255,255,0.04)', color:'#475569', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, fontSize:13, cursor:'pointer' },
  footer:    { marginTop:20, fontSize:10, color:'#1e3a5f', letterSpacing:'0.5px' },
};
