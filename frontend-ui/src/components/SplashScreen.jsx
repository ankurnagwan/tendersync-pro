/**
 * src/components/SplashScreen.jsx
 * ================================
 * TENDERSYNC PRO — Branded intro splash screen
 * Stays visible for exactly 15 seconds, then fades out and calls onComplete().
 *
 * Shows:
 *   ✦ Animated tech-shield SVG logo (draw-on stroke, circuit nodes, scan line)
 *   ✦ TENDERSYNC PRO title with staggered text reveal
 *   ✦ Tagline: Enterprise AI Procurement Suite
 *   ✦ Developer credit: Designed & Engineered By Ankur Nagwan
 *   ✦ Version badge: v2.0 — Enterprise Edition
 *   ✦ Live progress bar with stage labels and countdown timer
 *   ✦ Animated dot-grid background + corner accent lines
 */

import { useEffect, useState, useRef } from 'react';

const TOTAL_MS      = 15000;   // exact display duration
const FADE_START_MS = 14400;   // begin fade 600ms before end

const LOAD_STAGES = [
  { at: 0,     label: 'Initialising secure environment…'    },
  { at: 2200,  label: 'Loading procurement intelligence…'   },
  { at: 4500,  label: 'Connecting to GeM data layer…'       },
  { at: 6800,  label: 'Configuring AI analysis pipeline…'   },
  { at: 9200,  label: 'Verifying extension bridge…'         },
  { at: 11500, label: 'Finalising dashboard modules…'       },
  { at: 13500, label: 'Ready.'                              },
];

const NODE_POSITIONS = [
  [55, 38], [39, 51], [71, 51],
  [44, 67], [66, 67], [55, 79],
];

const WIRE_PATHS = [
  'M55 38 L39 51', 'M55 38 L71 51',
  'M39 51 L71 51',
  'M39 51 L44 67', 'M71 51 L66 67',
  'M44 67 L66 67',
  'M44 67 L55 79', 'M66 67 L55 79',
];

export default function SplashScreen({ onComplete }) {
  const [progress,    setProgress]    = useState(0);
  const [stageLabel,  setStageLabel]  = useState(LOAD_STAGES[0].label);
  const [fading,      setFading]      = useState(false);
  const [shieldIn,    setShieldIn]    = useState(false);
  const [textIn,      setTextIn]      = useState(false);
  const [progressIn,  setProgressIn]  = useState(false);

  const startRef = useRef(null);
  const rafRef   = useRef(null);
  const timers   = useRef([]);

  useEffect(() => {
    startRef.current = performance.now();

    const t = (fn, ms) => { const id = setTimeout(fn, ms); timers.current.push(id); };

    t(() => setShieldIn(true),    250);
    t(() => setTextIn(true),      900);
    t(() => setProgressIn(true),  1300);

    LOAD_STAGES.forEach(s => t(() => setStageLabel(s.label), s.at));

    t(() => setFading(true),     FADE_START_MS);
    t(() => onComplete?.(),      TOTAL_MS);

    const tick = (now) => {
      const elapsed = now - startRef.current;
      setProgress(Math.min((elapsed / TOTAL_MS) * 100, 100));
      if (elapsed < TOTAL_MS) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      timers.current.forEach(clearTimeout);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [onComplete]);

  const secondsLeft = Math.max(
    0,
    Math.ceil(((TOTAL_MS - (progress / 100) * TOTAL_MS) / 1000))
  );

  return (
    <>
      <style>{`
        @keyframes ts-grid-pulse {
          0%,100% { opacity:.05 } 50% { opacity:.1 }
        }
        @keyframes ts-scan {
          0%   { transform:translateY(-52px); opacity:.65 }
          100% { transform:translateY(52px);  opacity:0  }
        }
        @keyframes ts-node {
          0%,100% { r:2;   opacity:.4 }
          50%      { r:3.5; opacity:1  }
        }
        @keyframes ts-ring {
          0%   { r:46; opacity:.25 }
          100% { r:68; opacity:0   }
        }
        @keyframes ts-shimmer {
          0%   { left:-100% }
          100% { left:200%  }
        }
        @keyframes ts-label-blink {
          0%,100% { opacity:1 } 50% { opacity:.45 }
        }
        @keyframes ts-fade-up {
          from { opacity:0; transform:translateY(18px) }
          to   { opacity:1; transform:translateY(0)    }
        }
        @keyframes ts-fade-in {
          from { opacity:0 } to { opacity:1 }
        }
        @keyframes ts-badge {
          from { opacity:0; transform:scale(.9) }
          to   { opacity:1; transform:scale(1)  }
        }
      `}</style>

      {/* ── Root overlay ── */}
      <div style={{
        position:   'fixed',
        inset:       0,
        background: '#0a0f1e',
        display:    'flex',
        flexDirection: 'column',
        alignItems:  'center',
        justifyContent: 'center',
        zIndex:      9999,
        overflow:    'hidden',
        opacity:     fading ? 0 : 1,
        transition:  fading ? 'opacity 0.65s cubic-bezier(0.4,0,0.2,1)' : 'none',
      }}>

        {/* Dot-grid background */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: 'radial-gradient(circle, rgba(59,130,246,0.18) 1px, transparent 1px)',
          backgroundSize: '30px 30px',
          animation: 'ts-grid-pulse 4s ease-in-out infinite',
        }} />

        {/* Corner brackets */}
        {[
          { top:28,    left:28,    borderTop:'1px solid rgba(59,130,246,.35)', borderLeft:'1px solid rgba(59,130,246,.35)' },
          { top:28,    right:28,   borderTop:'1px solid rgba(59,130,246,.35)', borderRight:'1px solid rgba(59,130,246,.35)' },
          { bottom:28, left:28,    borderBottom:'1px solid rgba(59,130,246,.35)', borderLeft:'1px solid rgba(59,130,246,.35)' },
          { bottom:28, right:28,   borderBottom:'1px solid rgba(59,130,246,.35)', borderRight:'1px solid rgba(59,130,246,.35)' },
        ].map((st, i) => (
          <div key={i} style={{ position:'absolute', width:38, height:38, ...st, zIndex:1 }} />
        ))}

        {/* Content stack */}
        <div style={{
          position: 'relative', zIndex: 2,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 34, padding: '0 24px', maxWidth: 540, width: '100%',
        }}>

          {/* ── Tech Shield ── */}
          <div style={{
            opacity:    shieldIn ? 1 : 0,
            transform:  shieldIn ? 'scale(1)' : 'scale(0.6)',
            transition: 'opacity .75s ease, transform .75s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <svg width="118" height="128" viewBox="0 0 110 122" fill="none"
              xmlns="http://www.w3.org/2000/svg" role="img" aria-label="TenderSync Pro shield logo">

              {/* Pulsing ring */}
              <circle cx="55" cy="61" r="46" fill="none"
                stroke="rgba(59,130,246,0.18)" strokeWidth="1"
                style={{ animation: 'ts-ring 2.6s ease-out infinite' }} />

              {/* Shield outer — draw-on */}
              <path
                d="M55 7 L93 20 L93 63 Q93 89 55 104 Q17 89 17 63 L17 20 Z"
                fill="rgba(59,130,246,0.07)"
                stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round"
                strokeDasharray="385"
                style={{
                  strokeDashoffset: shieldIn ? 0 : 385,
                  transition: 'stroke-dashoffset 1.5s cubic-bezier(0.4,0,0.2,1) 0.1s',
                }}
              />

              {/* Shield inner border */}
              <path
                d="M55 17 L85 28 L85 62 Q85 82 55 95 Q25 82 25 62 L25 28 Z"
                fill="none"
                stroke="rgba(59,130,246,0.28)" strokeWidth="0.8"
                strokeDasharray="195"
                style={{
                  strokeDashoffset: shieldIn ? 0 : 195,
                  transition: 'stroke-dashoffset 1.3s cubic-bezier(0.4,0,0.2,1) 0.4s',
                }}
              />

              {/* Wires */}
              <path
                d={WIRE_PATHS.join(' ')}
                stroke="rgba(59,130,246,0.45)" strokeWidth="0.8" fill="none"
                style={{
                  opacity:    shieldIn ? 1 : 0,
                  transition: 'opacity 0.4s ease 1.1s',
                }}
              />

              {/* Nodes */}
              {NODE_POSITIONS.map(([cx, cy], i) => (
                <circle key={i} cx={cx} cy={cy} r="2.5" fill={i === 5 ? '#60a5fa' : '#3b82f6'}
                  style={{
                    opacity: shieldIn ? 1 : 0,
                    transition: `opacity 0.3s ease ${0.9 + i * 0.1}s`,
                    animation: shieldIn ? `ts-node 2.1s ease-in-out infinite ${i * 0.28}s` : 'none',
                  }}
                />
              ))}

              {/* Scan line */}
              <clipPath id="shieldClip2">
                <path d="M55 17 L85 28 L85 62 Q85 82 55 95 Q25 82 25 62 L25 28 Z" />
              </clipPath>
              {shieldIn && (
                <rect x="17" y="0" width="76" height="3"
                  fill="rgba(96,165,250,0.55)"
                  clipPath="url(#shieldClip2)"
                  style={{ animation: 'ts-scan 2.5s linear infinite' }}
                />
              )}
            </svg>
          </div>

          {/* ── Text block ── */}
          <div style={{
            textAlign: 'center',
            opacity:    textIn ? 1 : 0,
            transform:  textIn ? 'translateY(0)' : 'translateY(18px)',
            transition: 'opacity .7s ease, transform .7s ease',
            fontFamily: "'JetBrains Mono','Consolas',monospace",
          }}>
            {/* Version badge */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'rgba(59,130,246,0.11)',
              border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: 20, padding: '3px 14px', marginBottom: 18,
              animation: textIn ? 'ts-badge .5s ease .15s both' : 'none',
            }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:'#3b82f6', display:'inline-block' }} />
              <span style={{ fontSize:10, color:'#60a5fa', letterSpacing:'1.5px', fontWeight:600 }}>
                v2.0 — ENTERPRISE EDITION
              </span>
            </div>

            {/* Main title */}
            <div style={{
              fontSize: 'clamp(40px,8vw,58px)', fontWeight: 800,
              letterSpacing: '-1px', color: '#f8fafc', lineHeight: 1,
              animation: textIn ? 'ts-fade-up .7s ease .05s both' : 'none',
            }}>
              TENDER<span style={{ color:'#3b82f6' }}>SYNC</span>
            </div>
            <div style={{
              fontSize: 'clamp(40px,8vw,58px)', fontWeight: 800,
              letterSpacing: '5px', color: '#f8fafc', lineHeight: 1.05,
              animation: textIn ? 'ts-fade-up .7s ease .15s both' : 'none',
            }}>
              PRO
            </div>

            {/* Divider */}
            <div style={{
              width:48, height:2, background:'#3b82f6',
              margin:'16px auto 14px',
              animation: textIn ? 'ts-fade-in .5s ease .4s both' : 'none',
            }} />

            {/* Tagline */}
            <div style={{
              fontSize:18, color:'#94a3b8',
              letterSpacing:'3px', textTransform:'uppercase',
              animation: textIn ? 'ts-fade-up .6s ease .3s both' : 'none',
            }}>
              Enterprise AI Procurement Suite
            </div>

            {/* Developer credit */}
            <div style={{
              marginTop:12, fontSize:15, color:'#64748b', letterSpacing:'0.8px',
              animation: textIn ? 'ts-fade-up .6s ease .45s both' : 'none',
            }}>
              Designed &amp; Engineered By{' '}
              <span style={{ color:'#60a5fa', fontWeight:700 }}>Ankur Nagwan</span>
            </div>
          </div>

          {/* ── Progress bar ── */}
          <div style={{
            width:'100%', maxWidth:420,
            opacity: progressIn ? 1 : 0,
            transition: 'opacity .5s ease',
          }}>
            {/* Label + percent */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <span style={{
                fontSize:10, color:'#475569', letterSpacing:'.5px', fontFamily:'monospace',
                animation:'ts-label-blink 1.6s ease-in-out infinite',
              }}>
                {stageLabel}
              </span>
              <span style={{
                fontSize:12, color:'#3b82f6', fontWeight:700, fontFamily:'monospace',
                fontVariantNumeric:'tabular-nums', minWidth:36, textAlign:'right',
              }}>
                {Math.round(progress)}%
              </span>
            </div>

            {/* Track */}
            <div style={{
              height:4, background:'rgba(255,255,255,0.06)',
              borderRadius:2, overflow:'hidden',
            }}>
              <div style={{
                height:'100%', width:`${progress}%`,
                background:'#3b82f6', borderRadius:2,
                transition:'width .08s linear',
                position:'relative', overflow:'hidden',
              }}>
                <div style={{
                  position:'absolute', top:0, left:'-100%',
                  width:'55%', height:'100%',
                  background:'rgba(255,255,255,0.32)',
                  borderRadius:2,
                  animation:'ts-shimmer 1.9s ease-in-out infinite',
                }} />
              </div>
            </div>

            {/* Time remaining */}
            <div style={{
              textAlign:'right', marginTop:6,
              fontSize:10, color:'#334155', fontFamily:'monospace',
            }}>
              {secondsLeft > 0 ? `${secondsLeft}s remaining` : 'Launching dashboard…'}
            </div>
          </div>
        </div>

        {/* Footer bar */}
        <div style={{
          position:'absolute', bottom:22, left:0, right:0,
          textAlign:'center', fontSize:9, color:'#1e3a5f',
          fontFamily:'monospace', letterSpacing:'1.2px',
          opacity: progressIn ? 1 : 0, transition:'opacity .5s ease .8s',
          zIndex:2,
        }}>
          TENDERSYNC PRO · ENTERPRISE AI PROCUREMENT · © 2025 ANKUR NAGWAN
        </div>

      </div>
    </>
  );
}
