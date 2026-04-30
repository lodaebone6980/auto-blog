import { useState, useEffect, useCallback, useMemo } from 'react';

const API = '/api';

const COLORS = {
  primary: '#1B3A5C',
  accent: '#2E75B6',
  success: '#2E8B57',
  warning: '#D4790E',
  danger: '#CC0000',
  bg: '#f5f7fa',
  card: '#ffffff',
  border: '#e5e7eb',
  textPrimary: '#1f2937',
  textSecondary: '#6b7280',
  textMuted: '#9ca3af',
};

const PERIODS = [
  { key: 'day', label: '일간' },
  { key: 'week', label: '주간' },
  { key: 'month', label: '월간' },
];

const SORT_OPTIONS = [
  { key: 'created_at', label: '날짜순' },
  { key: 'total_score', label: '총점순' },
  { key: 'seo_score', label: 'SEO순' },
  { key: 'geo_score', label: 'GEO순' },
  { key: 'aeo_score', label: 'AEO순' },
];

/* ────────────────────── Utility ────────────────────── */

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime(d) {
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function safeFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    return null;
  }
}

/* ────────────────────── Skeleton ────────────────────── */

function Skeleton({ width = '100%', height = 20, radius = 6, style = {} }) {
  return (
    <div style={{
      width, height, borderRadius: radius,
      background: 'linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite',
      ...style,
    }} />
  );
}

function SkeletonCard() {
  return (
    <div style={{ ...cardStyle, flex: 1, minWidth: 180 }}>
      <Skeleton width={80} height={14} style={{ marginBottom: 10 }} />
      <Skeleton width={60} height={32} style={{ marginBottom: 6 }} />
      <Skeleton width={50} height={12} />
    </div>
  );
}

/* ────────────────────── Score Bar ────────────────────── */

function ScoreBar({ label, score, max = 100, color }) {
  const pct = Math.min((score / max) * 100, 100);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{score.toFixed(1)}</span>
      </div>
      <div style={{ height: 5, background: '#e5e7eb', borderRadius: 3 }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color, borderRadius: 3,
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  );
}

/* ────────────────────── Stat Card ────────────────────── */

function StatCard({ label, value, change, color, icon, loading }) {
  if (loading) return <SkeletonCard />;
  const changeColor = change > 0 ? COLORS.success : change < 0 ? COLORS.danger : COLORS.textMuted;
  const changeArrow = change > 0 ? '▲' : change < 0 ? '▼' : '';
  return (
    <div style={{
      ...cardStyle, flex: 1, minWidth: 180,
      transition: 'transform 0.2s, box-shadow 0.2s',
      cursor: 'default',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: COLORS.textSecondary, fontWeight: 500 }}>{label}</span>
        {icon && <span style={{ fontSize: 18, opacity: 0.5 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, color: color || COLORS.primary, lineHeight: 1.1 }}>{value}</div>
      {change !== undefined && change !== null && (
        <div style={{ fontSize: 11, color: changeColor, marginTop: 6, fontWeight: 600 }}>
          {changeArrow} {change > 0 ? '+' : ''}{typeof change === 'number' ? change.toFixed(1) : change}% 이전 대비
        </div>
      )}
    </div>
  );
}

/* ────────────────────── SVG Line Chart ────────────────────── */

function LineChart({ data, width = 500, height = 260, title }) {
  // data: { labels: string[], series: { name, values, color }[] }
  if (!data || !data.series || data.series.length === 0) {
    return (
      <div style={{ ...cardStyle, flex: 1, minWidth: 300 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: COLORS.primary }}>{title}</div>
        <div style={{ textAlign: 'center', padding: 40, color: COLORS.textMuted, fontSize: 13 }}>데이터 없음</div>
      </div>
    );
  }

  const pad = { top: 20, right: 20, bottom: 40, left: 45 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const allVals = data.series.flatMap(s => s.values.filter(v => v != null));
  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const range = maxV - minV;

  const xStep = data.labels.length > 1 ? cw / (data.labels.length - 1) : cw / 2;

  // For ranking chart, invert Y (lower position = better = higher on chart)
  const invertY = title && title.includes('순위');
  const mapY = v => {
    if (invertY) return pad.top + ((v - minV) / range) * ch;
    return pad.top + ch - ((v - minV) / range) * ch;
  };

  const yTicks = 5;
  const yTickVals = Array.from({ length: yTicks }, (_, i) => minV + (range * i) / (yTicks - 1));

  const [hovered, setHovered] = useState(null);

  return (
    <div style={{ ...cardStyle, flex: 1, minWidth: 300 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: COLORS.primary }}>{title}</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {data.series.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <span style={{ width: 10, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            <span style={{ color: COLORS.textSecondary }}>{s.name}</span>
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
        {/* Grid lines */}
        {yTickVals.map((v, i) => {
          const y = mapY(v);
          return (
            <g key={i}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#f0f0f0" strokeWidth={1} />
              <text x={pad.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill={COLORS.textMuted}>{Math.round(v)}</text>
            </g>
          );
        })}
        {/* X labels */}
        {data.labels.map((label, i) => {
          const x = pad.left + i * xStep;
          const show = data.labels.length <= 10 || i % Math.ceil(data.labels.length / 8) === 0;
          if (!show) return null;
          return (
            <text key={i} x={x} y={height - 8} textAnchor="middle" fontSize={9} fill={COLORS.textMuted}>
              {label.length > 5 ? label.slice(5) : label}
            </text>
          );
        })}
        {/* Lines */}
        {data.series.map(s => {
          const points = s.values.map((v, i) => (v != null ? `${pad.left + i * xStep},${mapY(v)}` : null)).filter(Boolean);
          return (
            <polyline key={s.name} points={points.join(' ')} fill="none" stroke={s.color}
              strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          );
        })}
        {/* Dots */}
        {data.series.map(s =>
          s.values.map((v, i) => {
            if (v == null) return null;
            const cx = pad.left + i * xStep;
            const cy = mapY(v);
            const isHovered = hovered && hovered.series === s.name && hovered.idx === i;
            return (
              <g key={`${s.name}-${i}`}>
                <circle cx={cx} cy={cy} r={isHovered ? 5 : 3} fill={s.color} stroke="white" strokeWidth={1.5}
                  style={{ cursor: 'pointer', transition: 'r 0.15s' }}
                  onMouseEnter={() => setHovered({ series: s.name, idx: i, val: v })}
                  onMouseLeave={() => setHovered(null)}
                />
                {isHovered && (
                  <g>
                    <rect x={cx - 24} y={cy - 22} width={48} height={18} rx={4} fill={COLORS.primary} opacity={0.9} />
                    <text x={cx} y={cy - 10} textAnchor="middle" fontSize={10} fill="white" fontWeight={600}>{v}</text>
                  </g>
                )}
              </g>
            );
          })
        )}
      </svg>
    </div>
  );
}

/* ────────────────────── SVG Bar Chart ────────────────────── */

function BarChart({ data, width = 500, height = 260, title }) {
  // data: { labels: string[], values: number[], color: string }
  if (!data || !data.values || data.values.length === 0) {
    return (
      <div style={{ ...cardStyle, flex: 1, minWidth: 300 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: COLORS.primary }}>{title}</div>
        <div style={{ textAlign: 'center', padding: 40, color: COLORS.textMuted, fontSize: 13 }}>데이터 없음</div>
      </div>
    );
  }

  const pad = { top: 20, right: 20, bottom: 40, left: 45 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const maxV = Math.max(...data.values, 1);
  const barGap = 4;
  const barW = Math.max(8, (cw - barGap * data.values.length) / data.values.length);

  const yTicks = 5;
  const yTickVals = Array.from({ length: yTicks }, (_, i) => Math.round((maxV * i) / (yTicks - 1)));

  const [hoveredBar, setHoveredBar] = useState(null);

  return (
    <div style={{ ...cardStyle, flex: 1, minWidth: 300 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: COLORS.primary }}>{title}</div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
        {/* Y grid */}
        {yTickVals.map((v, i) => {
          const y = pad.top + ch - (v / maxV) * ch;
          return (
            <g key={i}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#f0f0f0" strokeWidth={1} />
              <text x={pad.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill={COLORS.textMuted}>{v}</text>
            </g>
          );
        })}
        {/* Bars */}
        {data.values.map((v, i) => {
          const x = pad.left + i * (barW + barGap) + barGap / 2;
          const barH = (v / maxV) * ch;
          const y = pad.top + ch - barH;
          const isH = hoveredBar === i;
          return (
            <g key={i}
              onMouseEnter={() => setHoveredBar(i)}
              onMouseLeave={() => setHoveredBar(null)}
              style={{ cursor: 'pointer' }}
            >
              <rect x={x} y={y} width={barW} height={barH} rx={3}
                fill={isH ? COLORS.primary : (data.color || COLORS.accent)}
                opacity={isH ? 1 : 0.8}
                style={{ transition: 'all 0.15s' }}
              />
              {isH && (
                <g>
                  <rect x={x + barW / 2 - 20} y={y - 22} width={40} height={18} rx={4} fill={COLORS.primary} opacity={0.9} />
                  <text x={x + barW / 2} y={y - 10} textAnchor="middle" fontSize={10} fill="white" fontWeight={600}>{v}</text>
                </g>
              )}
              {/* X label */}
              {(data.values.length <= 14 || i % Math.ceil(data.values.length / 8) === 0) && (
                <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize={9} fill={COLORS.textMuted}>
                  {data.labels[i]?.length > 5 ? data.labels[i].slice(5) : data.labels[i]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ────────────────────── Alert Item ────────────────────── */

function AlertItem({ alert }) {
  const isUp = alert.change < 0; // lower position = better ranking = up
  const color = isUp ? COLORS.success : COLORS.danger;
  const arrow = isUp ? '▲' : '▼';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
      borderLeft: `3px solid ${color}`, background: isUp ? '#f0fdf4' : '#fef2f2',
      borderRadius: '0 8px 8px 0', marginBottom: 6,
    }}>
      <span style={{ fontSize: 18, color, fontWeight: 700 }}>{arrow}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{alert.keyword}</div>
        <div style={{ fontSize: 11, color: COLORS.textSecondary }}>{alert.postTitle || alert.post_title || ''}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>
          {alert.oldPosition ?? alert.old_position} → {alert.newPosition ?? alert.new_position}
        </span>
        <div style={{ fontSize: 10, color: COLORS.textMuted }}>
          {Math.abs(alert.change)}위 {isUp ? '상승' : '하락'}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Feedback Item ────────────────────── */

function FeedbackItem({ fb, onApply }) {
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const typeColors = {
    seo: COLORS.primary,
    geo: COLORS.accent,
    aeo: COLORS.success,
    content: COLORS.warning,
  };

  const handleApply = async () => {
    setApplying(true);
    const res = await safeFetch(`${API}/pattern/feedbacks/${fb.id}/apply`, { method: 'PATCH' });
    setApplying(false);
    if (res) {
      setApplied(true);
      if (onApply) onApply(fb.id);
    }
  };

  return (
    <div style={{
      padding: '14px 16px', borderBottom: `1px solid ${COLORS.border}`,
      opacity: applied ? 0.5 : 1, transition: 'opacity 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
          background: (typeColors[fb.type] || COLORS.accent) + '18',
          color: typeColors[fb.type] || COLORS.accent,
          textTransform: 'uppercase',
        }}>
          {fb.type}
        </span>
        <span style={{ fontSize: 12, color: COLORS.textSecondary, flex: 1 }}>{fb.description}</span>
        <button
          onClick={handleApply}
          disabled={applying || applied}
          style={{
            padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600,
            background: applied ? COLORS.success : COLORS.accent,
            color: 'white', cursor: applied ? 'default' : 'pointer',
            opacity: applying ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          {applied ? '적용 완료' : applying ? '적용 중...' : '적용'}
        </button>
      </div>
      {(fb.before || fb.after) && (
        <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
          {fb.before && (
            <div style={{ flex: 1, padding: 8, background: '#fef2f2', borderRadius: 6, color: COLORS.danger }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Before</div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fb.before}</div>
            </div>
          )}
          {fb.after && (
            <div style={{ flex: 1, padding: 8, background: '#f0fdf4', borderRadius: 6, color: COLORS.success }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>After</div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fb.after}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────── Post Row (Expandable) ────────────────────── */

function PostRow({ post, expanded, onToggle }) {
  return (
    <div style={{ borderBottom: `1px solid ${COLORS.border}` }}>
      <div
        onClick={onToggle}
        style={{
          padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14,
          cursor: 'pointer', transition: 'background 0.15s',
          background: expanded ? '#f8fafc' : 'transparent',
        }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = '#fafbfc'; }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ fontSize: 10, color: COLORS.textMuted, transition: 'transform 0.2s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{post.title}</div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
            {post.keyword} · {post.category}{post.platform ? ` · ${post.platform}` : ''}
          </div>
        </div>
        <div style={{ width: 150, flexShrink: 0 }}>
          <ScoreBar label="SEO" score={post.seo_score || 0} color={COLORS.primary} />
          <ScoreBar label="GEO" score={post.geo_score || 0} color={COLORS.accent} />
          <ScoreBar label="AEO" score={post.aeo_score || 0} color={COLORS.success} />
        </div>
        <div style={{
          fontSize: 20, fontWeight: 800, width: 52, textAlign: 'center', flexShrink: 0,
          color: (post.total_score || 0) >= 200 ? COLORS.success : (post.total_score || 0) >= 150 ? COLORS.warning : COLORS.danger,
        }}>
          {(post.total_score || 0).toFixed(0)}
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, width: 80, textAlign: 'right', flexShrink: 0 }}>
          {formatDate(post.created_at)}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 20px 16px 40px', background: '#f8fafc' }}>
          {post.rankings && post.rankings.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: COLORS.primary }}>순위 기록</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {post.rankings.map((r, i) => (
                  <span key={i} style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 6,
                    background: COLORS.accent + '15', color: COLORS.accent,
                  }}>
                    {formatDate(r.date)}: {r.position}위
                  </span>
                ))}
              </div>
            </div>
          )}
          {post.feedbacks && post.feedbacks.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: COLORS.primary }}>피드백</div>
              {post.feedbacks.map((fb, i) => (
                <div key={i} style={{
                  fontSize: 11, padding: 8, marginBottom: 4, borderRadius: 6,
                  background: 'white', border: `1px solid ${COLORS.border}`,
                }}>
                  <span style={{
                    fontWeight: 700, marginRight: 6, padding: '1px 6px', borderRadius: 4,
                    background: COLORS.warning + '18', color: COLORS.warning, fontSize: 10,
                  }}>{fb.type}</span>
                  {fb.description}
                </div>
              ))}
            </div>
          )}
          {(!post.rankings || post.rankings.length === 0) && (!post.feedbacks || post.feedbacks.length === 0) && (
            <div style={{ fontSize: 12, color: COLORS.textMuted }}>추가 정보 없음</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ value }) {
  const colors = {
    '대기중': COLORS.textMuted,
    '본문 생성 완료': COLORS.accent,
    'QR 생성 필요': COLORS.warning,
    'QR 생성 완료': COLORS.success,
    '에디터 삽입 완료': COLORS.primary,
    '검수 필요': COLORS.warning,
    '오류': COLORS.danger,
    '동기화 완료': COLORS.success,
    '설정필요': COLORS.warning,
    '시트에서 가져옴': COLORS.accent,
  };
  const color = colors[value] || COLORS.textSecondary;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '3px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>
      {value || '대기중'}
    </span>
  );
}

function ContentJobRow({ job, onRefresh }) {
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);

  const syncSheet = async () => {
    setSyncing(true);
    await safeFetch(`${API}/content-jobs/${job.id}/sync-sheet`, { method: 'POST' });
    setSyncing(false);
    if (onRefresh) onRefresh();
  };

  const markNotionExported = async () => {
    setExporting(true);
    await safeFetch(`${API}/content-jobs/${job.id}/notion-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notion_url: job.notion_url || null }),
    });
    setExporting(false);
    if (onRefresh) onRefresh();
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(220px, 1.5fr) 110px 110px 120px minmax(160px, auto)',
      gap: 12,
      alignItems: 'center',
      padding: '13px 20px',
      borderBottom: `1px solid ${COLORS.border}`,
      background: 'white',
      minWidth: 820,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {job.title || job.keyword}
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {job.keyword} · {job.category} · {job.naver_qr_name || 'QR 이름 대기'}
        </div>
      </div>
      <StatusPill value={job.generation_status} />
      <StatusPill value={job.qr_status} />
      <StatusPill value={job.sheet_sync_status} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {job.naver_qr_manage_url && (
          <a
            href={job.naver_qr_manage_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, color: COLORS.accent, fontWeight: 700, textDecoration: 'none' }}
          >
            QR 관리
          </a>
        )}
        {job.naver_qr_image_url && (
          <a
            href={job.naver_qr_image_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, color: COLORS.success, fontWeight: 700, textDecoration: 'none' }}
          >
            이미지
          </a>
        )}
        <button
          onClick={syncSheet}
          disabled={syncing}
          style={{
            border: `1px solid ${COLORS.border}`, background: 'white', borderRadius: 6,
            padding: '4px 8px', fontSize: 10, fontWeight: 700, color: COLORS.primary,
            cursor: syncing ? 'wait' : 'pointer',
          }}
        >
          {syncing ? '동기화...' : 'Sheets'}
        </button>
        <button
          onClick={markNotionExported}
          disabled={exporting}
          style={{
            border: 0, background: COLORS.primary, borderRadius: 6,
            padding: '4px 8px', fontSize: 10, fontWeight: 700, color: 'white',
            cursor: exporting ? 'wait' : 'pointer',
          }}
        >
          {exporting ? '저장...' : 'Notion'}
        </button>
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: COLORS.textSecondary }}>
        <span>글자수 {job.char_count || 0}</span>
        <span>KW {job.kw_count || 0}</span>
        <span>이미지 {job.image_count || 0}</span>
        <span>SEO {Number(job.seo_score || 0).toFixed(1)}</span>
        <span>GEO {Number(job.geo_score || 0).toFixed(1)}</span>
        <span>AEO {Number(job.aeo_score || 0).toFixed(1)}</span>
        {job.qr_target_url && <span style={{ wordBreak: 'break-all' }}>QR 링크 {job.qr_target_url}</span>}
      </div>
    </div>
  );
}

/* ────────────────────── Shared Styles ────────────────────── */

const cardStyle = {
  background: COLORS.card,
  borderRadius: 12,
  padding: '20px 20px',
  border: `1px solid ${COLORS.border}`,
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

const sectionStyle = {
  ...cardStyle,
  marginBottom: 20,
  overflow: 'hidden',
  padding: 0,
};

/* ────────────────────── Main App ────────────────────── */

export default function App() {
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [posts, setPosts] = useState([]);
  const [contentJobs, setContentJobs] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [period, setPeriod] = useState('week');
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Posts table state
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');
  const [expandedPost, setExpandedPost] = useState(null);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Health check (polls every 30s)
  useEffect(() => {
    const check = () => safeFetch(`${API}/health`).then(r => setHealth(r));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  // Fetch main data
  const fetchData = useCallback(async () => {
    setLoading(true);
    const [s, p, j, d, a] = await Promise.all([
      safeFetch(`${API}/stats`),
      safeFetch(`${API}/posts`),
      safeFetch(`${API}/content-jobs?limit=80`),
      safeFetch(`${API}/track/dashboard?period=${period}`),
      safeFetch(`${API}/track/alerts`),
    ]);
    if (s) setStats(s);
    if (p) setPosts(Array.isArray(p) ? p : []);
    if (j) setContentJobs(Array.isArray(j) ? j : []);
    if (d) setDashboard(d);
    if (a) setAlerts(Array.isArray(a) ? a : []);
    setLoading(false);
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Filtered + sorted posts
  const filteredPosts = useMemo(() => {
    let list = [...posts];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.keyword || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      if (sortBy === 'created_at') {
        return sortDir === 'desc' ? new Date(bv) - new Date(av) : new Date(av) - new Date(bv);
      }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return list;
  }, [posts, search, sortBy, sortDir]);

  // Chart data
  const rankingChartData = useMemo(() => {
    if (!dashboard?.rankings || dashboard.rankings.length === 0) return null;
    const keywordMap = {};
    dashboard.rankings.forEach(r => {
      const kw = r.keyword || '키워드';
      if (!keywordMap[kw]) keywordMap[kw] = [];
      keywordMap[kw].push({ date: r.date, position: r.position });
    });
    const allDates = [...new Set(dashboard.rankings.map(r => r.date))].sort();
    const palette = [COLORS.primary, COLORS.accent, COLORS.success, COLORS.warning, COLORS.danger, '#8B5CF6', '#EC4899'];
    const series = Object.entries(keywordMap).map(([name, entries], i) => {
      const dateMap = {};
      entries.forEach(e => { dateMap[e.date] = e.position; });
      return {
        name,
        values: allDates.map(d => dateMap[d] ?? null),
        color: palette[i % palette.length],
      };
    });
    return { labels: allDates, series };
  }, [dashboard]);

  const viewsChartData = useMemo(() => {
    if (!dashboard?.views || dashboard.views.length === 0) return null;
    return {
      labels: dashboard.views.map(v => v.date),
      values: dashboard.views.map(v => v.count || v.views || 0),
      color: COLORS.accent,
    };
  }, [dashboard]);

  // Pending feedbacks from stats or dashboard
  const pendingFeedbacks = useMemo(() => {
    if (dashboard?.feedbacks) return dashboard.feedbacks.filter(f => f.status === 'pending' || !f.status);
    return [];
  }, [dashboard]);

  // Significant alerts (>= 3 positions)
  const significantAlerts = useMemo(() => {
    return alerts.filter(a => Math.abs(a.change) >= 3);
  }, [alerts]);

  const totalViews = useMemo(() => {
    if (dashboard?.totalViews != null) return dashboard.totalViews;
    if (dashboard?.views) return dashboard.views.reduce((s, v) => s + (v.count || v.views || 0), 0);
    return 0;
  }, [dashboard]);

  const healthOk = health && health.status === 'ok';

  return (
    <div style={{ background: COLORS.bg, minHeight: '100vh' }}>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
      `}</style>

      {/* ────── Header ────── */}
      <header style={{
        background: 'linear-gradient(135deg, #1B3A5C 0%, #2E75B6 100%)',
        padding: '16px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12,
        boxShadow: '0 2px 12px rgba(27,58,92,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, background: 'rgba(255,255,255,0.15)',
            borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 800, fontSize: 18, backdropFilter: 'blur(4px)',
          }}>N</div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 800, color: 'white', letterSpacing: '-0.3px' }}>자동발행 사이트</h1>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>NaviWrite SEO/GEO/AEO 자동 발행 관리</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a
            href="/downloads/naviwrite-extension.zip"
            download
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              height: 34, padding: '0 14px', borderRadius: 18,
              background: 'white', color: COLORS.primary, textDecoration: 'none',
              fontSize: 12, fontWeight: 800, boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
              whiteSpace: 'nowrap',
            }}
          >
            확장프로그램
          </a>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,0.12)', padding: '5px 12px', borderRadius: 20,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: healthOk ? '#4ade80' : '#f87171',
              boxShadow: healthOk ? '0 0 6px #4ade80' : '0 0 6px #f87171',
            }} />
            <span style={{ fontSize: 11, color: 'white', fontWeight: 500 }}>
              {healthOk ? '서버 정상' : health === null ? '확인 중...' : '서버 오류'}
            </span>
          </div>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontVariantNumeric: 'tabular-nums' }}>
            {formatTime(currentTime)}
          </span>
        </div>
      </header>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px' }}>

        {/* ────── Period Filter ────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20 }}>
          <span style={{ fontSize: 12, color: COLORS.textSecondary, marginRight: 8, fontWeight: 600 }}>기간 :</span>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={{
              padding: '6px 16px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600,
              background: period === p.key ? COLORS.primary : 'white',
              color: period === p.key ? 'white' : COLORS.textSecondary,
              cursor: 'pointer', transition: 'all 0.2s',
              boxShadow: period === p.key ? '0 2px 8px rgba(27,58,92,0.25)' : '0 1px 2px rgba(0,0,0,0.06)',
            }}>
              {p.label}
            </button>
          ))}
        </div>

        {/* ────── Stats Row ────── */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard loading={loading} label="전체 포스트" value={stats?.totalPosts ?? 0} change={stats?.postsChange} color={COLORS.primary} icon="📝" />
          <StatCard loading={loading} label="평균 점수" value={stats?.avgScore ?? '0.0'} change={stats?.scoreChange} color={COLORS.accent} icon="📊" />
          <StatCard loading={loading} label="총 조회수" value={totalViews.toLocaleString()} change={stats?.viewsChange ?? null} color={COLORS.success} icon="👁" />
          <StatCard loading={loading} label="대기 피드백" value={stats?.pendingFeedbacks ?? 0} change={null} color={COLORS.warning} icon="💬" />
          <StatCard loading={loading} label="글/QR 작업" value={stats?.contentJobs ?? 0} change={null} color={COLORS.primary} icon="🔗" />
          <StatCard loading={loading} label="QR 완료" value={stats?.qrReady ?? 0} change={null} color={COLORS.success} icon="▦" />
          <StatCard loading={loading} label="QR 필요" value={stats?.qrNeeded ?? 0} change={null} color={COLORS.warning} icon="!" />
          <StatCard loading={loading} label="Sheets 오류" value={stats?.sheetErrors ?? 0} change={null} color={COLORS.danger} icon="S" />
        </div>

        {/* ────── Charts ────── */}
        {!loading && (
          <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap', animation: 'fadeIn 0.4s ease' }}>
            <LineChart title="키워드 순위 추이" data={rankingChartData} />
            <BarChart title="일별 조회수 추이" data={viewsChartData} />
          </div>
        )}

        {/* ────── Content Jobs / QR / Sheets ────── */}
        <div style={{ ...sectionStyle, animation: loading ? 'none' : 'fadeIn 0.4s ease' }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ marginRight: 'auto' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.primary }}>
                글 생성 · 네이버 QR · Google Sheets <span style={{ fontSize: 12, fontWeight: 400, color: COLORS.textMuted }}>({contentJobs.length})</span>
              </h2>
              <p style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                단건 등록, 네이버 QR 생성, 시트 동기화 상태를 한 화면에서 확인합니다
              </p>
            </div>
            <button
              onClick={() => safeFetch(`${API}/content-jobs/sheets/pull`, { method: 'POST' }).then(fetchData)}
              style={{
                padding: '6px 12px', borderRadius: 8, border: `1px solid ${COLORS.accent}`,
                background: 'white', color: COLORS.accent, fontSize: 11, fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Sheets 작업 가져오기
            </button>
          </div>

          {loading ? (
            <div style={{ padding: 20 }}>
              {[1, 2].map(i => <Skeleton key={i} height={74} style={{ marginBottom: 8 }} />)}
            </div>
          ) : contentJobs.length === 0 ? (
            <div style={{ padding: 38, textAlign: 'center', color: COLORS.textMuted }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>▦</div>
              <p style={{ fontSize: 14, marginBottom: 4 }}>아직 글/QR 작업이 없습니다</p>
              <p style={{ fontSize: 12 }}>확장프로그램에서 단건 등록하거나 Google Sheets 작업을 가져오세요</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {contentJobs.map(job => (
                <ContentJobRow key={job.id} job={job} onRefresh={fetchData} />
              ))}
            </div>
          )}
        </div>

        {/* ────── Posts Table ────── */}
        <div style={{ ...sectionStyle, animation: loading ? 'none' : 'fadeIn 0.4s ease' }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.primary, marginRight: 'auto' }}>
              포스트 목록 <span style={{ fontSize: 12, fontWeight: 400, color: COLORS.textMuted }}>({filteredPosts.length})</span>
            </h2>
            <input
              type="text"
              placeholder="제목 / 키워드 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                padding: '6px 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`,
                fontSize: 12, outline: 'none', width: 200,
                transition: 'border-color 0.2s',
              }}
              onFocus={e => { e.target.style.borderColor = COLORS.accent; }}
              onBlur={e => { e.target.style.borderColor = COLORS.border; }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {SORT_OPTIONS.map(opt => (
                <button key={opt.key} onClick={() => {
                  if (sortBy === opt.key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                  else { setSortBy(opt.key); setSortDir('desc'); }
                }} style={{
                  padding: '4px 10px', borderRadius: 6, border: `1px solid ${sortBy === opt.key ? COLORS.accent : COLORS.border}`,
                  fontSize: 11, background: sortBy === opt.key ? COLORS.accent + '10' : 'white',
                  color: sortBy === opt.key ? COLORS.accent : COLORS.textSecondary,
                  cursor: 'pointer', fontWeight: sortBy === opt.key ? 600 : 400,
                  transition: 'all 0.15s',
                }}>
                  {opt.label} {sortBy === opt.key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 20 }}>
              {[1, 2, 3].map(i => <Skeleton key={i} height={56} style={{ marginBottom: 8 }} />)}
            </div>
          ) : filteredPosts.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: COLORS.textMuted }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
              <p style={{ fontSize: 14, marginBottom: 4 }}>
                {search ? '검색 결과가 없습니다' : '아직 추적 중인 포스트가 없습니다'}
              </p>
              <p style={{ fontSize: 12 }}>NaviWrite 확장프로그램에서 포스트를 등록하세요</p>
            </div>
          ) : (
            <div>
              {filteredPosts.map(post => (
                <PostRow
                  key={post.id}
                  post={post}
                  expanded={expandedPost === post.id}
                  onToggle={() => setExpandedPost(expandedPost === post.id ? null : post.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ────── Alerts Section ────── */}
        {!loading && significantAlerts.length > 0 && (
          <div style={{ ...sectionStyle, animation: 'fadeIn 0.5s ease' }}>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${COLORS.border}` }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.primary }}>
                순위 변동 알림 <span style={{ fontSize: 12, fontWeight: 400, color: COLORS.textMuted }}>({significantAlerts.length})</span>
              </h2>
            </div>
            <div style={{ padding: 12 }}>
              {significantAlerts.map((a, i) => <AlertItem key={i} alert={a} />)}
            </div>
          </div>
        )}

        {/* ────── Feedbacks Section ────── */}
        {!loading && pendingFeedbacks.length > 0 && (
          <div style={{ ...sectionStyle, animation: 'fadeIn 0.5s ease' }}>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${COLORS.border}` }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.primary }}>
                대기 중 피드백 <span style={{ fontSize: 12, fontWeight: 400, color: COLORS.textMuted }}>({pendingFeedbacks.length})</span>
              </h2>
            </div>
            <div>
              {pendingFeedbacks.map(fb => (
                <FeedbackItem
                  key={fb.id}
                  fb={fb}
                  onApply={() => {
                    setStats(prev => prev ? { ...prev, pendingFeedbacks: Math.max(0, (prev.pendingFeedbacks || 0) - 1) } : prev);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* ────── Footer ────── */}
        <footer style={{ textAlign: 'center', padding: '24px 0 16px', fontSize: 11, color: COLORS.textMuted }}>
          자동발행 사이트 v1.0.0 · NaviWrite · Powered by Railway
        </footer>
      </div>
    </div>
  );
}
