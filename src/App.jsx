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

const DEFAULT_REWRITE_SETTINGS = {
  targetCharCount: 2200,
  sectionCharCount: 300,
  sectionCount: 7,
  targetKwCount: 15,
  imageCount: 12,
  benchmarkUrl: 'https://blog.naver.com/openmind200/224258533599',
  benchmarkSampleCount: 20,
  benchmarkMedianCharCount: 1940,
  benchmarkMedianSectionCount: 7,
  benchmarkMedianSectionCharCount: 280,
  benchmarkMedianKwCount: 19,
  benchmarkMedianImageCount: 12,
};

const VOLUME_BANDS = [
  { key: 'all', label: '전체', color: '#eef2ff', textColor: '#3730a3' },
  { key: '0-500', label: '500 이하', color: '#fee2e2', textColor: '#991b1b' },
  { key: '501-1000', label: '501~1000', color: '#ffedd5', textColor: '#9a3412' },
  { key: '1001-2000', label: '1001~2000', color: '#fef3c7', textColor: '#92400e' },
  { key: '2001-5000', label: '2001~5000', color: '#dcfce7', textColor: '#166534' },
  { key: '5000+', label: '5000 이상', color: '#dbeafe', textColor: '#1e40af' },
  { key: 'unknown', label: '미확인', color: '#e5e7eb', textColor: '#6b7280' },
];

/* ────────────────────── Utility ────────────────────── */

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateTime(d) {
  if (!d) return '-';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '-';
  return `${formatDate(date)} ${date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
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

function volumeBandFor(key) {
  return VOLUME_BANDS.find((band) => band.key === key) || VOLUME_BANDS[VOLUME_BANDS.length - 1];
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

function GuideModal({ onClose }) {
  const steps = [
    {
      title: '확장프로그램 설치',
      items: [
        '우측 상단의 확장프로그램 버튼을 눌러 zip 파일을 내려받습니다.',
        '크롬 확장 프로그램 관리 화면에서 개발자 모드를 켠 뒤 압축을 푼 폴더를 로드합니다.',
        '네이버 블로그, 카페, 프리미엄콘텐츠, 브런치 작업 전 이 사이트와 확장프로그램을 함께 열어둡니다.',
      ],
    },
    {
      title: '단건 글 등록',
      items: [
        '확장프로그램에서 키워드, 카테고리, 참고 URL, CTA 링크, QR 연결 링크를 입력합니다.',
        '톤/어체 옵션을 선택하면 예시 문장을 재사용하지 않고 새 글 구조로 생성합니다.',
        '등록된 작업은 대시보드의 글/QR 작업 목록에 바로 저장됩니다.',
      ],
    },
    {
      title: 'Google Sheets 일괄 등록',
      items: [
        '시트에 키워드, 링크, 참고 URL, 상태값을 행 단위로 입력합니다.',
        '백엔드가 시트를 읽어 작업을 생성하고 결과 요약을 다시 동기화합니다.',
        '상태가 오류로 바뀐 행은 대시보드에서 원인을 확인한 뒤 다시 실행합니다.',
      ],
    },
    {
      title: '네이버 QR 생성',
      items: [
        'QR 생성 필요 상태의 작업에서 네이버 QR 버튼을 누르면 qr.naver.com 생성 화면이 열립니다.',
        '로그인은 사용자가 직접 하고, 비밀번호는 저장하지 않습니다.',
        'QR 이름, 연결 링크, QR 이미지, 관리 URL이 수집되어 DB와 대시보드에 저장됩니다.',
      ],
    },
    {
      title: '검수와 발행',
      items: [
        '글자수, 키워드 반복수, 이미지 수, SEO/GEO/AEO 점수를 확인합니다.',
        'QR 이미지는 도입 CTA 이후 또는 2번째 섹션 뒤에 삽입하는 구성을 기본으로 봅니다.',
        'Notion은 자동 동기화하지 않고 선택한 글만 수동으로 내보냅니다.',
      ],
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guide-title"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(15, 23, 42, 0.52)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
      }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'white',
          borderRadius: 12,
          boxShadow: '0 22px 60px rgba(15,23,42,0.28)',
          border: `1px solid ${COLORS.border}`,
        }}
      >
        <div style={{
          padding: '22px 24px 16px',
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <div>
            <div style={{
              fontSize: 11,
              fontWeight: 800,
              color: COLORS.accent,
              letterSpacing: 0,
              marginBottom: 6,
            }}>
              QUICK GUIDE
            </div>
            <h2 id="guide-title" style={{ fontSize: 22, fontWeight: 850, color: COLORS.primary, marginBottom: 6 }}>
              자동발행 사이트 사용법
            </h2>
            <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              확장프로그램 설치부터 글 생성, 네이버 QR 저장, 검수까지 한 번에 확인하세요.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="사용법 닫기"
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: '#f8fafc',
              color: COLORS.textSecondary,
              fontSize: 18,
              fontWeight: 800,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>

        <div style={{ padding: '18px 24px 24px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
          }}>
            {steps.map((step, idx) => (
              <section
                key={step.title}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 10,
                  padding: 16,
                  background: idx === 0 ? '#f8fbff' : 'white',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: idx === 0 ? COLORS.primary : '#eef2f7',
                    color: idx === 0 ? 'white' : COLORS.primary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 850,
                    flex: '0 0 auto',
                  }}>
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.textPrimary }}>
                    {step.title}
                  </h3>
                </div>
                <ul style={{ listStyle: 'none', display: 'grid', gap: 8 }}>
                  {step.items.map(item => (
                    <li key={item} style={{
                      display: 'flex',
                      gap: 8,
                      fontSize: 12,
                      color: COLORS.textSecondary,
                      lineHeight: 1.55,
                    }}>
                      <span style={{ color: COLORS.success, fontWeight: 900, marginTop: 1 }}>✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div style={{
            marginTop: 14,
            padding: '13px 14px',
            borderRadius: 10,
            background: '#fff7ed',
            border: '1px solid #fed7aa',
            color: '#9a3412',
            fontSize: 12,
            lineHeight: 1.6,
          }}>
            운영 기준: DB를 원본 저장소로 사용하고 Google Sheets는 작업 큐와 결과 요약 동기화용으로 씁니다.
            네이버 QR은 화면 자동화 방식이라 로그인 세션이 필요합니다.
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ value }) {
  const colors = {
    대기중: COLORS.warning,
    수집중: COLORS.accent,
    수집완료: COLORS.success,
    '패턴 분석중': COLORS.accent,
    '초안 생성중': COLORS.accent,
    '이미지 생성중': COLORS.accent,
    완료: COLORS.success,
    '검수 필요': COLORS.warning,
    'ID/PW 미저장': COLORS.textMuted,
    'ID/PW 저장 중': COLORS.warning,
    '최초 인증 필요': COLORS.warning,
    '인증 진행 중': COLORS.accent,
    '발행 준비 완료': COLORS.success,
    '로그인 재확인 필요': COLORS.warning,
    오류: COLORS.danger,
  };
  const color = colors[value] || COLORS.textSecondary;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '3px 8px',
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 800,
      background: `${color}18`,
      color,
      whiteSpace: 'nowrap',
    }}>
      {value || '대기중'}
    </span>
  );
}

function SourceCollectionPanel({ onOpenRewrite }) {
  const [batchName, setBatchName] = useState('');
  const [urlsText, setUrlsText] = useState('');
  const [batches, setBatches] = useState([]);
  const [links, setLinks] = useState([]);
  const [selectedLinks, setSelectedLinks] = useState([]);
  const [keywordDrafts, setKeywordDrafts] = useState({});
  const [savingKeywordIds, setSavingKeywordIds] = useState([]);
  const [creating, setCreating] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState('');

  const loadCollections = useCallback(async () => {
    const [batchRes, linkRes] = await Promise.all([
      safeFetch(`${API}/collections/batches?limit=20`),
      safeFetch(`${API}/collections/links?limit=100`),
    ]);
    if (Array.isArray(batchRes)) setBatches(batchRes);
    if (Array.isArray(linkRes)) setLinks(linkRes);
  }, []);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    setKeywordDrafts((prev) => {
      const next = { ...prev };
      links.forEach((link) => {
        if (next[link.id] === undefined) next[link.id] = link.corrected_main_keyword || '';
      });
      return next;
    });
  }, [links]);

  const urlCount = useMemo(
    () => urlsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line)).length,
    [urlsText]
  );

  const processPending = async (batchId = null) => {
    setProcessing(true);
    setMessage(batchId ? '등록된 URL을 웹에서 바로 수집 중...' : '대기중 URL을 웹에서 수집 중...');
    const res = await safeFetch(`${API}/collections/process-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId, limit: 10 }),
    });
    setProcessing(false);

    if (res?.ok) {
      setMessage(`웹 수집 완료 · 성공 ${res.collected}개 · 실패 ${res.failed}개`);
      await loadCollections();
    } else {
      setMessage('웹 수집에 실패했습니다. 공개 페이지인지 확인해 주세요.');
    }
  };

  const createBatch = async () => {
    if (urlCount === 0) {
      setMessage('등록할 URL을 줄바꿈으로 입력해 주세요.');
      return;
    }

    setCreating(true);
    setMessage('');
    const res = await safeFetch(`${API}/collections/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: batchName || `수집 배치 ${new Date().toLocaleString('ko-KR')}`,
        urlsText,
      }),
    });
    setCreating(false);

    if (res?.batch) {
      setMessage(`배치 #${res.batch.id} 생성 완료 · ${res.inserted}개 등록 · 웹 수집 시작`);
      setUrlsText('');
      setBatchName('');
      await loadCollections();
      await processPending(res.batch.id);
    } else {
      setMessage('배치 생성에 실패했습니다. URL 형식을 확인해 주세요.');
    }
  };

  const stats = useMemo(() => ({
    total: links.length,
    pending: links.filter((link) => link.status === '대기중').length,
    collecting: links.filter((link) => link.status === '수집중').length,
    collected: links.filter((link) => link.status === '수집완료').length,
    failed: links.filter((link) => link.status === '오류').length,
  }), [links]);

  const selectedCount = selectedLinks.length;
  const allLinksSelected = links.length > 0 && links.every((link) => selectedLinks.includes(link.id));
  const toggleAllLinks = () => {
    setSelectedLinks(allLinksSelected ? [] : links.map((link) => link.id));
  };
  const toggleLinkSelection = (id) => {
    setSelectedLinks((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };

  const saveCorrectedKeyword = async (link) => {
    const value = (keywordDrafts[link.id] || '').trim();
    if ((link.corrected_main_keyword || '') === value) return;
    setSavingKeywordIds((prev) => [...new Set([...prev, link.id])]);
    const res = await safeFetch(`${API}/collections/links/${link.id}/main-keyword`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correctedMainKeyword: value }),
    });
    setSavingKeywordIds((prev) => prev.filter((id) => id !== link.id));
    if (res?.ok) {
      setMessage(value ? `수정 메인키워드 저장: ${value}` : '수정 메인키워드를 비웠습니다.');
      await loadCollections();
    } else {
      setMessage(res?.error || '수정 메인키워드 저장에 실패했습니다.');
    }
  };

  const formatTerms = (terms) => {
    if (!Array.isArray(terms) || terms.length === 0) return '-';
    return terms.slice(0, 3).map((item) => `${item.term || item.keyword || '-'} ${item.count || ''}`.trim()).join(', ');
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>수집/감지</h2>
            <p style={{ fontSize: 12, color: COLORS.textSecondary }}>
              URL 수집과 RSS 감지를 여기에서 처리하고, 검토한 글만 발행 생성 메뉴로 넘깁니다.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={loadCollections}
              disabled={processing}
              style={{
                height: 34,
                padding: '0 13px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: 'white',
                color: COLORS.textSecondary,
                fontSize: 12,
                fontWeight: 800,
                cursor: processing ? 'not-allowed' : 'pointer',
              }}
            >
              새로고침
            </button>
          </div>
        </div>

        <input
          value={batchName}
          onChange={(e) => setBatchName(e.target.value)}
          placeholder="배치명 예: IT/테크 상위글 1차 수집"
          style={{
            width: '100%',
            height: 38,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: '0 12px',
            fontSize: 13,
            outline: 'none',
            marginBottom: 10,
          }}
        />
        <textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder={`https://blog.naver.com/...\nhttps://cafe.naver.com/...\nhttps://contents.premium.naver.com/...\nhttps://brunch.co.kr/...`}
          rows={8}
          style={{
            width: '100%',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: 12,
            fontSize: 13,
            lineHeight: 1.55,
            resize: 'vertical',
            outline: 'none',
            marginBottom: 12,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={createBatch}
            disabled={creating || processing || urlCount === 0}
            style={{
              height: 40,
              padding: '0 18px',
              borderRadius: 9,
              border: 'none',
              background: creating || processing || urlCount === 0 ? COLORS.textMuted : COLORS.primary,
              color: 'white',
              fontSize: 13,
              fontWeight: 850,
              cursor: creating || processing || urlCount === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? '등록 중...' : processing ? '웹 수집 중...' : `등록하고 바로 수집 (${urlCount})`}
          </button>
          <button
            type="button"
            onClick={() => processPending()}
            disabled={processing || stats.pending === 0}
            style={{
              height: 40,
              padding: '0 18px',
              borderRadius: 9,
              border: `1px solid ${COLORS.border}`,
              background: processing || stats.pending === 0 ? '#f3f4f6' : 'white',
              color: processing || stats.pending === 0 ? COLORS.textMuted : COLORS.primary,
              fontSize: 13,
              fontWeight: 850,
              cursor: processing || stats.pending === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            대기중 웹 수집
          </button>
          <span style={{ fontSize: 12, color: COLORS.textSecondary }}>
            공개 페이지는 웹에서 바로 수집하고, 로그인/비공개로 막힌 글만 Runner 인증 수집으로 넘깁니다.
          </span>
          {message && <span style={{ fontSize: 12, color: message.includes('완료') ? COLORS.success : COLORS.warning, fontWeight: 700 }}>{message}</span>}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {[
          ['전체 링크', stats.total, COLORS.primary],
          ['대기중', stats.pending, COLORS.warning],
          ['수집중', stats.collecting, COLORS.accent],
          ['수집완료', stats.collected, COLORS.success],
          ['오류', stats.failed, COLORS.danger],
        ].map(([label, value, color]) => (
          <div key={label} style={{ ...cardStyle, padding: 16 }}>
            <p style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 700, marginBottom: 6 }}>{label}</p>
            <p style={{ fontSize: 28, color, fontWeight: 900, lineHeight: 1 }}>{value}</p>
          </div>
        ))}
      </div>

      <RssDetectionPanel onOpenRewrite={onOpenRewrite} />

      {stats.pending > 0 && (
        <section style={{ ...cardStyle, padding: 16, background: '#fff7ed', borderColor: '#fed7aa' }}>
          <h3 style={{ fontSize: 14, fontWeight: 850, color: '#9a3412', marginBottom: 6 }}>대기중 처리 방법</h3>
          <p style={{ fontSize: 12, color: '#9a3412', lineHeight: 1.65 }}>
            대기중은 URL이 DB 큐에만 등록된 상태입니다. 이제 <b>대기중 웹 수집</b>을 누르면 서버가 공개 페이지를 바로 가져옵니다.
            로그인, 비공개, 보안 확인이 필요한 글은 오류로 남기고 Runner 인증 수집 대상으로 분리합니다.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 10 }}>
            {[
              '1. 대기중 웹 수집 클릭',
              '2. 서버가 공개 페이지 fetch',
              '3. 본문/이미지/KW 분석 저장',
              '4. 실패 URL은 오류 사유 표시',
              '5. 필요 시 Runner 인증 수집',
            ].map((item) => (
              <div key={item} style={{ padding: '9px 10px', borderRadius: 8, background: 'white', color: '#9a3412', fontSize: 11, fontWeight: 800 }}>
                {item}
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>최근 수집 링크와 분석 결과</h3>
          <p style={{ marginTop: 4, fontSize: 11, color: COLORS.textSecondary }}>
            수집완료가 되면 블로그 닉네임/제목, 메인키워드, 글자수/KW 반복수/이미지 수, 인용구와 반복어가 이 표에 표시됩니다.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 800 }}>
              발행 생성 후보 {selectedCount}개 선택
            </span>
            <button
              type="button"
              disabled={selectedCount === 0}
              onClick={() => {
                localStorage.setItem('naviwrite.rewrite.selectedSourceLinkIds', JSON.stringify(selectedLinks));
                setMessage(`선택한 ${selectedCount}개 글을 발행 생성 메뉴로 넘겼습니다.`);
                if (onOpenRewrite) onOpenRewrite();
              }}
              style={{
                height: 30,
                padding: '0 12px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: selectedCount === 0 ? '#f3f4f6' : 'white',
                color: selectedCount === 0 ? COLORS.textMuted : COLORS.primary,
                fontSize: 11,
                fontWeight: 850,
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              선택 글 발행 생성 준비
            </button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {links.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              아직 등록된 수집 링크가 없습니다.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1510 }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                  {['선택', '상태', '수집일', '블로그', '플랫폼', '메인키워드', '수정 KW', '카테고리', '글자/KW/이미지', '인용구/반복어', 'URL', '오류'].map((head) => (
                    <th key={head} style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` }}>
                      {head === '선택' ? (
                        <input
                          type="checkbox"
                          checked={allLinksSelected}
                          onChange={toggleAllLinks}
                          aria-label="수집 링크 전체 선택 또는 해제"
                        />
                      ) : head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={selectedLinks.includes(link.id)}
                        onChange={() => toggleLinkSelection(link.id)}
                        aria-label="발행 생성 후보 선택"
                      />
                    </td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge value={link.status} /></td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary, whiteSpace: 'nowrap', fontSize: 11 }}>
                      {formatDateTime(link.collected_at || link.created_at)}
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary, maxWidth: 160 }}>
                      <p style={{ fontWeight: 800, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.blog_nickname || link.blog_name || '-'}</p>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {link.blog_title || link.blog_id || ''}
                      </p>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: COLORS.textSecondary }}>{link.platform_guess || '-'}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 800, color: COLORS.primary }}>{link.main_keyword || '-'}</td>
                    <td style={{ padding: '10px 12px', minWidth: 140 }}>
                      <input
                        value={keywordDrafts[link.id] ?? link.corrected_main_keyword ?? ''}
                        onChange={(e) => setKeywordDrafts((prev) => ({ ...prev, [link.id]: e.target.value }))}
                        onBlur={() => saveCorrectedKeyword(link)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder="필요 시 수정"
                        disabled={!link.source_analysis_id || savingKeywordIds.includes(link.id)}
                        style={{
                          width: 126,
                          height: 30,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 7,
                          padding: '0 8px',
                          fontSize: 11,
                          fontWeight: 800,
                          color: COLORS.textPrimary,
                          outline: 'none',
                          background: !link.source_analysis_id ? '#f3f4f6' : 'white',
                        }}
                      />
                    </td>
                    <td style={{ padding: '10px 12px' }}>{link.category_guess || '-'}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary }}>
                      {(link.char_count || 0).toLocaleString()} / {link.kw_count || 0} / {link.image_count || 0}
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary, maxWidth: 230 }}>
                      <p style={{ fontSize: 10, color: COLORS.textMuted }}>인용구 {Array.isArray(link.quote_blocks) ? link.quote_blocks.length : 0}개</p>
                      <p style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatTerms(link.quote_repeated_terms?.length ? link.quote_repeated_terms : link.repeated_terms)}</p>
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 340 }}>
                      <a href={link.url} target="_blank" rel="noreferrer" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {link.url}
                      </a>
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.danger, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {link.error_message || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>수집 배치</h3>
        </div>
        <div style={{ display: 'grid', gap: 8, padding: 14 }}>
          {batches.map((batch) => (
            <div key={batch.id} style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(160px, 1fr) 90px 240px 110px',
              gap: 12,
              alignItems: 'center',
              padding: 12,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              background: 'white',
            }}>
              <div>
                <p style={{ fontSize: 13, fontWeight: 850, color: COLORS.textPrimary }}>{batch.name || `배치 #${batch.id}`}</p>
                <p style={{ fontSize: 10, color: COLORS.textMuted }}>{formatDate(batch.created_at)}</p>
              </div>
              <StatusBadge value={batch.status} />
              <div style={{ height: 8, borderRadius: 999, background: '#eef2f7', overflow: 'hidden' }}>
                <div style={{
                  width: `${batch.total_count ? ((batch.collected_count + batch.failed_count) / batch.total_count) * 100 : 0}%`,
                  height: '100%',
                  background: batch.failed_count > 0 ? COLORS.warning : COLORS.success,
                }} />
              </div>
              <p style={{ fontSize: 11, color: COLORS.textSecondary, textAlign: 'right' }}>
                {batch.collected_count}/{batch.total_count} 완료
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RssDetectionPanel({ onOpenRewrite }) {
  const [rssSources, setRssSources] = useState([]);
  const [rssItems, setRssItems] = useState([]);
  const [selectedRssItemIds, setSelectedRssItemIds] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.rewrite.selectedRssItemIds') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [rssForm, setRssForm] = useState({ label: '', rssUrl: '', platform: 'blog', category: 'IT/테크' });
  const [rssVolumeFilter, setRssVolumeFilter] = useState('all');
  const [checkingRssId, setCheckingRssId] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');

  const loadRssData = useCallback(async () => {
    const [sourceRes, itemRes] = await Promise.all([
      safeFetch(`${API}/rss-sources?limit=60`),
      safeFetch(`${API}/rss-items?limit=160`),
    ]);
    if (Array.isArray(sourceRes)) setRssSources(sourceRes);
    if (Array.isArray(itemRes)) setRssItems(itemRes);
  }, []);

  useEffect(() => {
    loadRssData();
  }, [loadRssData]);

  const filteredRssItems = useMemo(
    () => rssItems.filter((item) => rssVolumeFilter === 'all' || (item.volume_band || 'unknown') === rssVolumeFilter),
    [rssItems, rssVolumeFilter]
  );
  const allRssItemsSelected = filteredRssItems.length > 0 && filteredRssItems.every((item) => selectedRssItemIds.includes(item.id));
  const selectedRssItems = useMemo(
    () => filteredRssItems.filter((item) => selectedRssItemIds.includes(item.id)),
    [filteredRssItems, selectedRssItemIds]
  );

  const loadOpsSettings = () => {
    try {
      return JSON.parse(localStorage.getItem('naviwrite.opsSettings') || localStorage.getItem('naviwrite.ops.settings') || '{}') || {};
    } catch {
      return {};
    }
  };

  const toggleRssItem = (id) => {
    setSelectedRssItemIds((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };

  const toggleAllRssItems = () => {
    setSelectedRssItemIds(allRssItemsSelected ? [] : readyRssItems.map((item) => item.id));
  };

  const createRssSource = async () => {
    if (!rssForm.rssUrl.trim()) {
      setMessage('감지할 RSS URL이나 네이버 블로그 ID를 입력해 주세요.');
      return;
    }
    const res = await safeFetch(`${API}/rss-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rssForm),
    });
    if (res?.ok) {
      setRssForm({ label: '', rssUrl: '', platform: rssForm.platform, category: rssForm.category });
      setMessage('RSS 감지 소스를 저장했습니다.');
      await loadRssData();
    } else {
      setMessage(res?.error || 'RSS 소스 저장에 실패했습니다.');
    }
  };

  const checkRssSource = async (source) => {
    const opsSettings = loadOpsSettings();
    setCheckingRssId(source.id);
    setMessage(`${source.label || source.rss_url} RSS를 확인하고 키워드 후보를 검증 중입니다.`);
    const res = await safeFetch(`${API}/rss-sources/${source.id}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        naverClientId: opsSettings.naverClientId,
        naverClientSecret: opsSettings.naverClientSecret,
        limit: 20,
      }),
    });
    setCheckingRssId(null);
    if (res?.ok) {
      setMessage(`RSS 감지 완료 · ${res.detected || 0}개 글 확인`);
      await loadRssData();
    } else {
      setMessage(res?.error || 'RSS 감지에 실패했습니다.');
    }
  };

  const updateRssItemKeyword = async (item, selectedKeyword, checkedForPublish = item.checked_for_publish) => {
    const res = await safeFetch(`${API}/rss-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedKeyword, checkedForPublish }),
    });
    if (res?.ok) {
      await loadRssData();
    } else {
      setMessage(res?.error || 'RSS 키워드 저장에 실패했습니다.');
    }
  };

  const prepareSelectedRssItems = async () => {
    if (selectedRssItems.length === 0) {
      setMessage('발행 생성으로 넘길 RSS 글을 선택해 주세요.');
      return;
    }
    setPreparing(true);
    await Promise.all(selectedRssItems.map((item) => safeFetch(`${API}/rss-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedKeyword: item.selected_keyword || item.main_keyword || '',
        checkedForPublish: true,
      }),
    })));
    localStorage.setItem('naviwrite.rewrite.selectedRssItemIds', JSON.stringify(selectedRssItems.map((item) => item.id)));
    setPreparing(false);
    setMessage(`RSS 글 ${selectedRssItems.length}개를 발행 생성 대기로 넘겼습니다.`);
    await loadRssData();
    if (onOpenRewrite) onOpenRewrite();
  };

  return (
    <section style={{ ...cardStyle, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>RSS 감지 키워드 검토</h3>
          <p style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.6 }}>
            블로그/워드프레스 RSS 새 글을 감지하고 메인키워드, 자동완성어, 검색량 밴드를 검토합니다. 선택한 글만 발행 생성 대기로 넘깁니다.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {VOLUME_BANDS.map((band) => (
            <button
              key={band.key}
              type="button"
              onClick={() => setRssVolumeFilter(band.key)}
              style={{
                height: 28,
                padding: '0 9px',
                borderRadius: 999,
                border: `1px solid ${rssVolumeFilter === band.key ? band.textColor : COLORS.border}`,
                background: band.color,
                color: band.textColor,
                fontSize: 10,
                fontWeight: 900,
                cursor: 'pointer',
              }}
            >
              {band.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 10 }}>
        <input value={rssForm.label} onChange={(e) => setRssForm({ ...rssForm, label: e.target.value })} placeholder="RSS 이름 예: 워드프레스 새 글" style={{ ...inputStyle, marginBottom: 0 }} />
        <input value={rssForm.rssUrl} onChange={(e) => setRssForm({ ...rssForm, rssUrl: e.target.value })} placeholder="RSS URL 또는 네이버 블로그 ID" style={{ ...inputStyle, marginBottom: 0 }} />
        <select value={rssForm.platform} onChange={(e) => setRssForm({ ...rssForm, platform: e.target.value })} style={{ ...inputStyle, marginBottom: 0 }}>
          <option value="blog">네이버 블로그</option>
          <option value="cafe">네이버 카페</option>
          <option value="web">워드프레스/웹</option>
        </select>
        <input value={rssForm.category} onChange={(e) => setRssForm({ ...rssForm, category: e.target.value })} placeholder="카테고리" style={{ ...inputStyle, marginBottom: 0 }} />
        <button type="button" onClick={createRssSource} style={{ ...primaryButtonStyle, marginBottom: 0 }}>RSS 추가</button>
      </div>

      {rssSources.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
          {rssSources.map((source) => (
            <div key={source.id} style={{ flex: '0 0 230px', padding: 10, borderRadius: 9, border: `1px solid ${COLORS.border}`, background: '#f8fafc' }}>
              <p style={{ fontSize: 12, fontWeight: 900, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{source.label || source.rss_url}</p>
              <p style={{ marginTop: 3, fontSize: 10, color: COLORS.textMuted }}>{source.platform} · {source.category} · {source.item_count || 0}개</p>
              <button
                type="button"
                disabled={checkingRssId === source.id}
                onClick={() => checkRssSource(source)}
                style={{ ...smallButtonStyle, marginTop: 8, width: '100%', background: checkingRssId === source.id ? '#f3f4f6' : 'white' }}
              >
                {checkingRssId === source.id ? '감지 중' : 'RSS 감지'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 900, color: COLORS.textSecondary }}>
          <input type="checkbox" checked={allRssItemsSelected} onChange={toggleAllRssItems} />
          전체 선택/해제
        </label>
        <button
          type="button"
          onClick={prepareSelectedRssItems}
          disabled={selectedRssItems.length === 0 || preparing}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 8,
            border: 'none',
            background: selectedRssItems.length === 0 || preparing ? COLORS.textMuted : COLORS.success,
            color: 'white',
            fontSize: 11,
            fontWeight: 850,
            cursor: selectedRssItems.length === 0 || preparing ? 'not-allowed' : 'pointer',
          }}
        >
          {preparing ? '넘기는 중' : `선택 RSS 발행 생성 준비 (${selectedRssItems.length})`}
        </button>
        {message && <span style={{ fontSize: 11, color: message.includes('완료') || message.includes('넘겼') ? COLORS.success : COLORS.warning, fontWeight: 800 }}>{message}</span>}
      </div>

      <div style={{ overflowX: 'auto', maxHeight: 280 }}>
        {filteredRssItems.length === 0 ? (
          <div style={{ padding: 22, textAlign: 'center', color: COLORS.textMuted, fontSize: 12 }}>아직 감지된 RSS 글이 없습니다.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1040 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                {['선택', '검색량', '상태', '제목', '선택 KW', '후보/자동완성', '발행 생성'].map((head) => (
                  <th key={head} style={{ padding: '9px 10px', borderBottom: `1px solid ${COLORS.border}` }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRssItems.map((item) => {
                const band = volumeBandFor(item.volume_band || 'unknown');
                const candidates = parseJsonList(item.keyword_candidates);
                const autocompletes = parseJsonList(item.autocomplete_keywords);
                return (
                  <tr key={item.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '9px 10px' }}>
                      <input type="checkbox" checked={selectedRssItemIds.includes(item.id)} onChange={() => toggleRssItem(item.id)} />
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 8px', borderRadius: 999, background: band.color, color: band.textColor, fontSize: 10, fontWeight: 900 }}>
                        {item.search_volume != null ? Number(item.search_volume).toLocaleString() : band.label}
                      </span>
                    </td>
                    <td style={{ padding: '9px 10px' }}><StatusBadge value={item.status} /></td>
                    <td style={{ padding: '9px 10px', maxWidth: 270 }}>
                      <a href={item.link} target="_blank" rel="noreferrer" style={{ fontWeight: 850, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{item.title || '-'}</a>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted }}>{formatDateTime(item.published_at || item.detected_at)}</p>
                    </td>
                    <td style={{ padding: '9px 10px', minWidth: 150 }}>
                      <input
                        defaultValue={item.selected_keyword || item.main_keyword || ''}
                        onBlur={(e) => updateRssItemKeyword(item, e.target.value, item.checked_for_publish)}
                        style={{ width: 138, height: 30, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '0 8px', fontSize: 11, fontWeight: 850 }}
                      />
                    </td>
                    <td style={{ padding: '9px 10px', maxWidth: 260, color: COLORS.textSecondary }}>
                      <p style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>후보 {candidates.slice(0, 3).map((candidate) => candidate.keyword).filter(Boolean).join(', ') || '-'}</p>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>자동완성 {autocompletes.slice(0, 4).join(', ') || '-'}</p>
                    </td>
                    <td style={{ padding: '9px 10px', color: COLORS.textSecondary }}>
                      {item.rewrite_job_id ? `#${item.rewrite_job_id}` : (item.checked_for_publish ? '대기중' : '-')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function RewritePanel() {
  const [links, setLinks] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [rssItems, setRssItems] = useState([]);
  const [selectedRssItemIds, setSelectedRssItemIds] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.rewrite.selectedRssItemIds') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [selectedSourceLinkIds, setSelectedSourceLinkIds] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.rewrite.selectedSourceLinkIds') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [keywordDrafts, setKeywordDrafts] = useState({});
  const [savingKeywordIds, setSavingKeywordIds] = useState([]);
  const [keywordsText, setKeywordsText] = useState('');
  const [targetTopic, setTargetTopic] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [keywordRecommendations, setKeywordRecommendations] = useState(null);
  const [recommendingKeywords, setRecommendingKeywords] = useState(false);
  const [titleRecommendations, setTitleRecommendations] = useState(null);
  const [recommendingTitle, setRecommendingTitle] = useState(false);
  const [platform, setPlatform] = useState('blog');
  const [category, setCategory] = useState('IT/테크');
  const [ctaUrl, setCtaUrl] = useState('');
  const [useNaverQr, setUseNaverQr] = useState(true);
  const [useAiImages, setUseAiImages] = useState(true);
  const [concurrency, setConcurrency] = useState(3);
  const [publishSpacingMinutes, setPublishSpacingMinutes] = useState(() => Number(localStorage.getItem('naviwrite.rewrite.publishSpacingMinutes') || 120));
  const [publishActionDelayMinutes, setPublishActionDelayMinutes] = useState(() => Number(localStorage.getItem('naviwrite.rewrite.publishActionDelayMinutes') || 1));
  const [rewriteSettings, setRewriteSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.rewrite.settings') || 'null') || {};
      return { ...DEFAULT_REWRITE_SETTINGS, ...saved };
    } catch {
      return DEFAULT_REWRITE_SETTINGS;
    }
  });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [reanalyzingKeywords, setReanalyzingKeywords] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [creatingRssJobs, setCreatingRssJobs] = useState(false);
  const [message, setMessage] = useState('');

  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const loadRewriteData = useCallback(async () => {
    setLoading(true);
    const [linkRes, jobRes, rssItemRes] = await Promise.all([
      safeFetch(`${API}/collections/links?limit=150`),
      safeFetch(`${API}/rewrite-jobs?limit=80`),
      safeFetch(`${API}/rss-items?limit=160`),
    ]);
    setLoading(false);
    if (Array.isArray(linkRes)) setLinks(linkRes);
    if (Array.isArray(jobRes)) setJobs(jobRes);
    if (Array.isArray(rssItemRes)) setRssItems(rssItemRes);
  }, []);

  useEffect(() => {
    loadRewriteData();
  }, [loadRewriteData]);

  useEffect(() => {
    setKeywordDrafts((prev) => {
      const next = { ...prev };
      links.forEach((link) => {
        if (next[link.id] === undefined) next[link.id] = link.corrected_main_keyword || '';
      });
      return next;
    });
  }, [links]);

  useEffect(() => {
    localStorage.setItem('naviwrite.rewrite.selectedSourceLinkIds', JSON.stringify(selectedSourceLinkIds));
  }, [selectedSourceLinkIds]);

  useEffect(() => {
    localStorage.setItem('naviwrite.rewrite.selectedRssItemIds', JSON.stringify(selectedRssItemIds));
  }, [selectedRssItemIds]);

  useEffect(() => {
    localStorage.setItem('naviwrite.rewrite.settings', JSON.stringify(rewriteSettings));
  }, [rewriteSettings]);

  useEffect(() => {
    localStorage.setItem('naviwrite.rewrite.publishSpacingMinutes', String(publishSpacingMinutes || 120));
  }, [publishSpacingMinutes]);

  useEffect(() => {
    localStorage.setItem('naviwrite.rewrite.publishActionDelayMinutes', String(publishActionDelayMinutes || 1));
  }, [publishActionDelayMinutes]);

  const collectedLinks = useMemo(
    () => links.filter((link) => link.status === '수집완료' && link.source_analysis_id),
    [links]
  );

  const selectedSources = useMemo(
    () => collectedLinks.filter((link) => selectedSourceLinkIds.includes(link.id)),
    [collectedLinks, selectedSourceLinkIds]
  );

  const allSourcesSelected = collectedLinks.length > 0 && collectedLinks.every((link) => selectedSourceLinkIds.includes(link.id));

  const selectedRewriteLinks = useMemo(
    () => selectedSources.filter((link) => link.rewrite_job_id),
    [selectedSources]
  );

  const readyRssItems = useMemo(
    () => rssItems.filter((item) => (
      item.checked_for_publish
      || item.status === '발행 생성 대기'
      || item.rewrite_job_id
      || selectedRssItemIds.includes(item.id)
    )),
    [rssItems, selectedRssItemIds]
  );

  const allRssItemsSelected = readyRssItems.length > 0 && readyRssItems.every((item) => selectedRssItemIds.includes(item.id));

  const selectedRssItems = useMemo(
    () => readyRssItems.filter((item) => selectedRssItemIds.includes(item.id)),
    [readyRssItems, selectedRssItemIds]
  );

  const derivedSourceKeywords = useMemo(
    () => [...new Set(selectedSources
      .map((link) => (link.corrected_main_keyword || link.main_keyword || '').trim())
      .filter(Boolean))],
    [selectedSources]
  );

  const effectiveKeywordsText = keywordsText.trim() || derivedSourceKeywords.join('\n');
  const keywordCount = useMemo(
    () => effectiveKeywordsText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean).length,
    [effectiveKeywordsText]
  );
  const rewriteJobCount = keywordsText.trim() ? keywordCount : selectedSources.length;
  const canCreateGenerationJobs = keywordCount > 0 || selectedSources.length > 0;

  const patternSummary = useMemo(() => {
    const avg = (field, fallback = 0) => {
      const values = selectedSources.map((item) => Number(item[field] || 0)).filter((value) => value > 0);
      if (values.length === 0) return fallback;
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    };
    const quoteTotal = selectedSources.reduce((sum, item) => sum + parseArray(item.quote_blocks).length, 0);
    return {
      charCount: avg('char_count'),
      kwCount: avg('kw_count'),
      imageCount: avg('image_count'),
      quoteCount: selectedSources.length ? Math.round(quoteTotal / selectedSources.length) : 0,
    };
  }, [selectedSources]);

  const toggleSource = (id) => {
    setSelectedSourceLinkIds((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };

  const toggleAllSources = () => {
    setSelectedSourceLinkIds(allSourcesSelected ? [] : collectedLinks.map((link) => link.id));
  };

  const toggleRssItem = (id) => {
    setSelectedRssItemIds((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };

  const toggleAllRssItems = () => {
    setSelectedRssItemIds(allRssItemsSelected ? [] : readyRssItems.map((item) => item.id));
  };

  const createJobsFromSelectedRssItems = async () => {
    if (selectedRssItems.length === 0) {
      setMessage('발행 생성할 RSS 감지 글을 체크해 주세요.');
      return;
    }
    setCreatingRssJobs(true);
    setMessage(`RSS 감지 글 ${selectedRssItems.length}개를 발행 생성 중입니다.`);
    const res = await safeFetch(`${API}/rss-items/to-rewrite-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemIds: selectedRssItems.map((item) => item.id),
        ctaUrl,
        useNaverQr,
        useAiImages,
        rewriteSettings,
      }),
    });
    setCreatingRssJobs(false);
    if (res?.ok) {
      setMessage(`RSS 기반 발행 생성 완료 · ${res.created || 0}개`);
      setSelectedRssItemIds([]);
      await loadRewriteData();
    } else {
      setMessage(res?.error || 'RSS 기반 발행 생성에 실패했습니다.');
    }
  };

  const saveCorrectedKeyword = async (link) => {
    const value = (keywordDrafts[link.id] || '').trim();
    if ((link.corrected_main_keyword || '') === value) return;
    setSavingKeywordIds((prev) => [...new Set([...prev, link.id])]);
    const res = await safeFetch(`${API}/collections/links/${link.id}/main-keyword`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correctedMainKeyword: value }),
    });
    setSavingKeywordIds((prev) => prev.filter((id) => id !== link.id));
    if (res?.ok) {
      setMessage(value ? `수정 메인키워드 저장: ${value}` : '수정 메인키워드를 비웠습니다.');
      await loadRewriteData();
    } else {
      setMessage(res?.error || '수정 메인키워드 저장에 실패했습니다.');
    }
  };

  const updateRewriteSetting = (key, value) => {
    setRewriteSettings((prev) => ({
      ...prev,
      [key]: key === 'benchmarkUrl' ? value : Number(value) || 0,
    }));
  };

  const resetRewriteSettings = () => {
    setRewriteSettings(DEFAULT_REWRITE_SETTINGS);
    setMessage('최근 20개 벤치마크 기준값으로 복원했습니다.');
  };

  const benchmarkRewriteSettings = async () => {
    setBenchmarking(true);
    setMessage('최근 글 20개를 읽어서 기준값을 계산 중입니다.');
    const res = await safeFetch(`${API}/rewrite-settings/benchmark?limit=20&url=${encodeURIComponent(rewriteSettings.benchmarkUrl || DEFAULT_REWRITE_SETTINGS.benchmarkUrl)}`);
    setBenchmarking(false);
    if (res?.ok && res.settings) {
      setRewriteSettings((prev) => ({ ...prev, ...res.settings }));
      setMessage(`벤치마크 완료 · ${res.summary?.sampleCount || 0}개 분석`);
    } else {
      setMessage(res?.error || '벤치마크 기준값 계산에 실패했습니다.');
    }
  };

  const loadOpsSettings = () => {
    try {
      return JSON.parse(localStorage.getItem('naviwrite.opsSettings') || localStorage.getItem('naviwrite.ops.settings') || '{}') || {};
    } catch {
      return {};
    }
  };

  const recommendTitles = async () => {
    const keyword = effectiveKeywordsText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)[0] || '';
    if (!keyword) {
      setMessage('제목 추천을 위해 메인 키워드나 수집 링크를 먼저 선택하세요.');
      return;
    }
    const opsSettings = loadOpsSettings();
    setRecommendingTitle(true);
    setMessage('네이버 검색 흐름과 수집 패턴으로 제목 조합을 계산 중입니다.');
    const res = await safeFetch(`${API}/title-recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword,
        topic: targetTopic,
        platform,
        category,
        sourceLinkIds: selectedSourceLinkIds,
        naverClientId: opsSettings.naverClientId,
        naverClientSecret: opsSettings.naverClientSecret,
        limit: 8,
      }),
    });
    setRecommendingTitle(false);
    if (res?.ok) {
      setTitleRecommendations(res);
      const suffix = res.hasNaverSearch ? '네이버 검색 API 검증 포함' : 'API 키 없음, 내부 패턴 기준';
      setMessage(`제목 추천 완료 · ${suffix}`);
    } else {
      setTitleRecommendations(null);
      setMessage(res?.error || '제목 추천에 실패했습니다.');
    }
  };

  const chooseRecommendedTitle = (title) => {
    setCustomTitle(title);
    setMessage('추천 제목을 이번 발행 생성 작업 제목으로 선택했습니다.');
  };

  const recommendKeywords = async () => {
    const hasSource = selectedSourceLinkIds.length > 0;
    const topic = targetTopic || keywordsText;
    if (!hasSource && !topic.trim()) {
      setMessage('키워드 추천을 위해 수집 링크를 선택하거나 주제를 입력하세요.');
      return;
    }
    const opsSettings = loadOpsSettings();
    setRecommendingKeywords(true);
    setMessage('원문/주제에서 검색 키워드 후보를 검증 중입니다.');
    const res = await safeFetch(`${API}/keyword-recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceLinkIds: selectedSourceLinkIds,
        sourceText: keywordsText,
        topic,
        platform,
        category,
        naverClientId: opsSettings.naverClientId,
        naverClientSecret: opsSettings.naverClientSecret,
        limit: 10,
      }),
    });
    setRecommendingKeywords(false);
    if (res?.ok) {
      setKeywordRecommendations(res);
      const suffix = res.hasNaverSearch ? '네이버 검색 API 검증 포함' : '내부 신호 기준';
      setMessage(`키워드 추천 완료 · ${suffix}`);
    } else {
      setKeywordRecommendations(null);
      setMessage(res?.error || '키워드 추천에 실패했습니다.');
    }
  };

  const chooseRecommendedKeyword = (keyword) => {
    setKeywordsText(keyword);
    setKeywordRecommendations(null);
    setMessage(`발행 생성 키워드를 '${keyword}'로 적용했습니다.`);
  };

  const createRewriteJobs = async () => {
    if (rewriteJobCount === 0) {
      setMessage('발행 생성할 메인키워드를 입력하거나 메인키워드가 잡힌 수집완료 링크를 선택해 주세요.');
      return;
    }
    if (!keywordsText.trim() && selectedSourceLinkIds.length === 0) {
      setMessage('수집글 기준 생성은 패턴으로 삼을 수집완료 링크를 1개 이상 선택해야 합니다.');
      return;
    }

    setCreating(true);
    setMessage(`발행 생성 작업 ${rewriteJobCount}개를 병렬 처리 중입니다.`);
    const res = await safeFetch(`${API}/rewrite-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywordsText: keywordsText.trim() ? keywordsText : '',
        sourceRowMode: !keywordsText.trim(),
        sourceLinkIds: selectedSourceLinkIds,
        targetTopic,
        platform,
        category,
        ctaUrl,
        useNaverQr,
        useAiImages,
        customTitle,
        rewriteSettings,
        concurrency: Number(concurrency) || 3,
      }),
    });
    setCreating(false);

    if (res?.ok) {
      setMessage(`발행 생성 완료 · 생성 ${res.created}개 · 병렬 ${res.concurrency}개`);
      setKeywordsText('');
      await loadRewriteData();
    } else {
      setMessage(res?.error || '발행 생성 작업 생성에 실패했습니다.');
    }
  };

  const reprocessJob = async (jobId) => {
    setMessage(`작업 #${jobId}을 다시 생성 중입니다.`);
    const res = await safeFetch(`${API}/rewrite-jobs/${jobId}/process`, { method: 'POST' });
    if (res?.ok) {
      setMessage(`작업 #${jobId} 재생성 완료`);
      await loadRewriteData();
    } else {
      setMessage('재생성에 실패했습니다.');
    }
  };

  const reprocessSelectedJobs = async () => {
    if (selectedRewriteLinks.length === 0) {
      setMessage('다시 생성할 발행 생성 완료 행을 체크해 주세요.');
      return;
    }
    setCreating(true);
    setMessage(`선택한 ${selectedRewriteLinks.length}개 작업을 다시 생성 중입니다.`);
    for (const link of selectedRewriteLinks) {
      await safeFetch(`${API}/rewrite-jobs/${link.rewrite_job_id}/process`, { method: 'POST' });
    }
    setCreating(false);
    setMessage(`선택한 ${selectedRewriteLinks.length}개 작업을 다시 생성했습니다.`);
    await loadRewriteData();
  };

  const reanalyzeSelectedMainKeywords = async () => {
    if (selectedSourceLinkIds.length === 0) {
      setMessage('메인 키워드를 다시 잡을 수집 링크를 체크해 주세요.');
      return;
    }
    setReanalyzingKeywords(true);
    setMessage(`선택한 ${selectedSourceLinkIds.length}개 링크의 메인 키워드를 재분석 중입니다.`);
    let updated = 0;
    for (const linkId of selectedSourceLinkIds) {
      const res = await safeFetch(`${API}/collections/links/${linkId}/recommend-main-keyword`, { method: 'POST' });
      if (res?.ok) updated += 1;
    }
    setReanalyzingKeywords(false);
    setMessage(`메인 키워드 재분석 완료 · ${updated}/${selectedSourceLinkIds.length}개 반영`);
    await loadRewriteData();
  };

  const sendRewriteIdsToPublishQueue = async (rewriteJobIds, { autoReady = false } = {}) => {
    if (!rewriteJobIds.length) {
      setMessage('발행 큐로 보낼 발행 생성 완료 행을 체크해 주세요.');
      return null;
    }
    setQueueing(true);
    setMessage(`${rewriteJobIds.length}개 작업을 ${autoReady ? '자동발행 대기' : '예약 발행 큐'}로 보내는 중입니다.`);
    const res = await safeFetch(`${API}/rewrite-jobs/to-content-jobs/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rewriteJobIds,
        publishMode: 'scheduled',
        spacingMinutes: Number(publishSpacingMinutes) || 120,
        actionDelayMinutes: Number(publishActionDelayMinutes) || 1,
        autoReady,
      }),
    });
    setQueueing(false);
    if (res?.ok) {
      const firstTime = res.firstScheduledAt ? new Date(res.firstScheduledAt).toLocaleString('ko-KR') : '즉시';
      setMessage(`${res.created || rewriteJobIds.length}개 작업을 ${autoReady ? '자동발행 대기' : '예약 발행 큐'}로 보냈습니다. 첫 시간: ${firstTime}`);
      await loadRewriteData();
      return res;
    } else {
      setMessage(res?.error || '발행 큐 저장에 실패했습니다.');
      return null;
    }
  };

  const sendToPublishQueue = async (job) => {
    await sendRewriteIdsToPublishQueue([job.id]);
  };

  const sendSelectedToPublishQueue = async () => {
    await sendRewriteIdsToPublishQueue(selectedRewriteLinks.map((link) => link.rewrite_job_id));
  };

  const queueSelectedForAutoPublish = async () => {
    const opsSettings = loadOpsSettings();
    const runnerUrl = opsSettings.runnerUrl || 'http://127.0.0.1:39271';
    const blogAccounts = Array.isArray(opsSettings.accounts)
      ? opsSettings.accounts.filter((account) => account.platform === 'blog')
      : [];
    if (blogAccounts.length === 0) {
      setMessage('운영 설정에서 네이버 블로그 계정 슬롯을 먼저 만들고 인증 창에서 로그인 체크를 해주세요.');
      return;
    }
    const res = await sendRewriteIdsToPublishQueue(
      selectedRewriteLinks.map((link) => link.rewrite_job_id),
      { autoReady: true }
    );
    if (!res?.ok) return;
    const jobIds = (res.jobs || []).map((job) => job.id);
    const apiBase = new URL(API, window.location.origin).toString().replace(/\/$/, '');
    localStorage.setItem('naviwrite.autoPublish.pendingJobIds', JSON.stringify(jobIds));
    window.postMessage({
      type: 'NAVIWRITE_AUTO_PUBLISH_WAIT',
      jobIds,
      runnerUrl,
      apiBase,
      spacingMinutes: Number(publishSpacingMinutes) || 120,
      actionDelayMinutes: Number(publishActionDelayMinutes) || 1,
    }, '*');
    const runnerRes = await safeFetch(`${runnerUrl}/publish/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase,
        jobIds,
        spacingMinutes: Number(publishSpacingMinutes) || 120,
        actionDelayMinutes: Number(publishActionDelayMinutes) || 1,
        createdAt: new Date().toISOString(),
      }),
    });
    setMessage(
      runnerRes?.ok
        ? `자동발행 대기 ${jobIds.length}개를 Runner에 저장했습니다. 딜레이 ${publishActionDelayMinutes || 1}분, 간격 ${publishSpacingMinutes || 120}분으로 실행됩니다.`
        : `자동발행 대기 ${jobIds.length}개를 DB에 저장했습니다. Runner가 꺼져 있으면 실행 PC에서 Runner를 켠 뒤 진행하세요.`
    );
  };

  const copyBody = async (job) => {
    try {
      await navigator.clipboard.writeText(job.body || job.plain_text || '');
      setMessage(`작업 #${job.id} 본문을 클립보드에 복사했습니다.`);
    } catch {
      setMessage('브라우저 권한 때문에 복사하지 못했습니다.');
    }
  };

  const formatTerms = (terms) => {
    const items = parseArray(terms);
    if (items.length === 0) return '-';
    return items.slice(0, 3).map((item) => `${item.term || item.keyword || '-'} ${item.count || ''}`.trim()).join(', ');
  };

  const formatKeywordCandidates = (link) => {
    const candidates = parseArray(link.keyword_candidates)
      .map((item) => item.keyword || item.term || '')
      .filter(Boolean)
      .slice(0, 3);
    return candidates.length ? candidates.join(', ') : '';
  };

  const jobFromSourceLink = (link) => ({
    id: link.rewrite_job_id,
    title: link.rewrite_title,
    target_keyword: link.rewrite_target_keyword,
    char_count: link.rewrite_char_count,
    kw_count: link.rewrite_kw_count,
    image_count: link.rewrite_image_count,
    total_score: link.rewrite_total_score,
    similarity_risk: link.rewrite_similarity_risk,
    status: link.rewrite_status,
  });

  const platformLabel = {
    blog: '네이버 블로그',
    cafe: '네이버 카페',
    premium: '네이버프리미엄',
    brunch: '브런치',
    web: '웹사이트',
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>발행 생성</h2>
            <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              URL 수집 글, RSS 감지 글, 직접 입력한 메인키워드를 발행 가능한 초안으로 바로 생성합니다. 문장은 새로 쓰고 수치와 발행 규칙만 반영합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={loadRewriteData}
            disabled={loading || creating}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 9,
              border: `1px solid ${COLORS.border}`,
              background: 'white',
              color: COLORS.primary,
              fontSize: 12,
              fontWeight: 850,
              cursor: loading || creating ? 'wait' : 'pointer',
            }}
          >
            새로고침
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: COLORS.textSecondary, marginBottom: 6 }}>공통 키워드 override · 보통은 비워두세요</label>
            <textarea
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder={`직접 새 글을 만들 메인키워드를 줄바꿈으로 입력하세요.\n비워두면 아래 수집 소스 표의 수정 KW, 없으면 자동 메인키워드로 각 행이 따로 생성됩니다.`}
              rows={4}
              style={{
                width: '100%',
                border: `1px solid ${COLORS.border}`,
                borderRadius: 10,
                padding: 12,
                fontSize: 13,
                lineHeight: 1.55,
                resize: 'vertical',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                onClick={recommendKeywords}
                disabled={recommendingKeywords}
                style={{
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: recommendingKeywords ? COLORS.textMuted : COLORS.primary,
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 850,
                  cursor: recommendingKeywords ? 'wait' : 'pointer',
                }}
              >
                {recommendingKeywords ? '키워드 검증중' : 'AI 키워드 추천'}
              </button>
              <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 700 }}>
                추천 버튼은 주제형 새 글을 만들 때 쓰고, 수집 글 기준 생성은 표의 행별 수정 KW가 우선입니다.
              </span>
            </div>
            {!keywordsText.trim() && derivedSourceKeywords.length > 0 && (
              <p style={{ marginTop: 6, fontSize: 11, color: COLORS.success, fontWeight: 800 }}>
                자동 사용 KW: {derivedSourceKeywords.slice(0, 5).join(', ')}{derivedSourceKeywords.length > 5 ? ` 외 ${derivedSourceKeywords.length - 5}개` : ''}
              </p>
            )}
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <details style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10, background: '#f8fafc' }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 900, color: COLORS.textSecondary }}>
                직접 키워드/고급 생성 기본값
              </summary>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: COLORS.textSecondary, marginBottom: 6 }}>직접 키워드 기본 플랫폼</label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                  style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 10px', fontSize: 12, color: COLORS.textPrimary, background: 'white' }}
                >
                  <option value="blog">네이버 블로그</option>
                  <option value="cafe">네이버 카페</option>
                  <option value="premium">네이버프리미엄</option>
                  <option value="brunch">브런치</option>
                  <option value="web">웹사이트</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: COLORS.textSecondary, marginBottom: 6 }}>초안 생성 병렬 수</label>
                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 10px', fontSize: 12, color: COLORS.textPrimary, background: 'white' }}
                >
                  {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}개</option>)}
                </select>
              </div>
              </div>
            </details>
            <input
              value={targetTopic}
              onChange={(e) => setTargetTopic(e.target.value)}
              placeholder="주제 보정값 예: 링크 결과 유형 정리"
              style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 12px', fontSize: 12, outline: 'none' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 118px', gap: 8 }}>
              <input
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="추천/고정 제목 · 비워두면 자동 생성"
                style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 12px', fontSize: 12, outline: 'none' }}
              />
              <button
                type="button"
                onClick={recommendTitles}
                disabled={recommendingTitle}
                style={{
                  height: 38,
                  borderRadius: 8,
                  border: 'none',
                  background: recommendingTitle ? COLORS.textMuted : COLORS.accent,
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 850,
                  cursor: recommendingTitle ? 'wait' : 'pointer',
                }}
              >
                {recommendingTitle ? '추천중' : 'AI 제목 추천'}
              </button>
            </div>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="카테고리 예: IT/테크"
              style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 12px', fontSize: 12, outline: 'none' }}
            />
            <input
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="CTA 링크 또는 QR 연결 링크"
              style={{ width: '100%', height: 38, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '0 12px', fontSize: 12, outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: COLORS.textSecondary, fontWeight: 800 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={useNaverQr} onChange={(e) => setUseNaverQr(e.target.checked)} />
                네이버 QR 삽입
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={useAiImages} onChange={(e) => setUseAiImages(e.target.checked)} />
                이미지 초안 생성
              </label>
            </div>
          </div>
        </div>

        {keywordRecommendations?.candidates?.length > 0 && (
          <div style={{
            marginTop: 14,
            padding: 14,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            background: '#fff',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 900, color: COLORS.primary, marginBottom: 4 }}>AI 키워드 추천</h3>
                <p style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                  {keywordRecommendations.topic || '선택 소스'} · {keywordRecommendations.hasNaverSearch ? '네이버 검색 API 검증' : '내부 제목/태그/본문 신호 기준'}
                  {keywordRecommendations.naverWarning ? ` · ${keywordRecommendations.naverWarning}` : ''}
                </p>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {keywordRecommendations.candidates.slice(0, 6).map((item, index) => (
                <div key={item.keyword} style={{
                  display: 'grid',
                  gridTemplateColumns: '34px minmax(0, 1fr) 88px 86px',
                  gap: 10,
                  alignItems: 'center',
                  padding: 10,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 9,
                  background: '#f8fafc',
                }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: COLORS.primary, color: 'white', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 900 }}>
                    {index + 1}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 900, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.keyword}
                    </p>
                    <p style={{ marginTop: 3, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      점수 {Number(item.score || 0).toFixed(0)}
                      {item.searchTotal != null ? ` · 검색결과 ${Number(item.searchTotal || 0).toLocaleString()}` : ''}
                      {item.sources?.length ? ` · ${item.sources.slice(0, 3).join(', ')}` : ''}
                    </p>
                  </div>
                  <span style={{
                    justifySelf: 'start',
                    height: 26,
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    borderRadius: 999,
                    background: item.volumeBandColor || volumeBandFor(item.volumeBand).color,
                    color: item.volumeBandTextColor || volumeBandFor(item.volumeBand).textColor,
                    fontSize: 10,
                    fontWeight: 900,
                    whiteSpace: 'nowrap',
                  }}>
                    {item.searchVolume != null ? Number(item.searchVolume).toLocaleString() : (item.volumeBandLabel || '미확인')}
                  </span>
                  <button
                    type="button"
                    onClick={() => chooseRecommendedKeyword(item.keyword)}
                    style={{ height: 30, borderRadius: 8, border: 'none', background: COLORS.accent, color: 'white', fontSize: 11, fontWeight: 850, cursor: 'pointer' }}
                  >
                    적용
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {titleRecommendations?.candidates?.length > 0 && (
          <div style={{
            marginTop: 14,
            padding: 14,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            background: '#fff',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 900, color: COLORS.primary, marginBottom: 4 }}>AI 제목 추천</h3>
                <p style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                  {titleRecommendations.keyword} · {titleRecommendations.hasNaverSearch ? '네이버 검색 API 검증' : '내부 수집 패턴 기준'}
                  {titleRecommendations.naverWarning ? ` · ${titleRecommendations.naverWarning}` : ''}
                </p>
              </div>
              <p style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 800 }}>
                행동유도어: {(titleRecommendations.sourceActionTerms || []).join(', ') || '-'}
              </p>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {titleRecommendations.candidates.slice(0, 5).map((item, index) => (
                <div key={item.title} style={{
                  display: 'grid',
                  gridTemplateColumns: '36px minmax(0, 1fr) 86px',
                  gap: 10,
                  alignItems: 'center',
                  padding: 10,
                  border: `1px solid ${customTitle === item.title ? COLORS.accent : COLORS.border}`,
                  borderRadius: 9,
                  background: customTitle === item.title ? '#eff6ff' : '#f8fafc',
                }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: COLORS.primary, color: 'white', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 900 }}>
                    {index + 1}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 900, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</p>
                    <p style={{ marginTop: 3, fontSize: 10, color: COLORS.textSecondary }}>
                      총점 {item.score} · SEO {item.seoScore} · AEO {item.aeoScore} · GEO {item.geoScore} · 유사위험 {item.duplicateRisk}
                      {item.reasons?.length ? ` · ${item.reasons.slice(0, 2).join(', ')}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => chooseRecommendedTitle(item.title)}
                    style={{
                      height: 30,
                      borderRadius: 8,
                      border: 'none',
                      background: customTitle === item.title ? COLORS.success : COLORS.accent,
                      color: 'white',
                      fontSize: 11,
                      fontWeight: 850,
                      cursor: 'pointer',
                    }}
                  >
                    {customTitle === item.title ? '선택됨' : '선택'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{
          marginTop: 14,
          padding: 14,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          background: '#ffffff',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 900, color: COLORS.primary, marginBottom: 4 }}>RSS 검토 완료 글 기준 발행 생성</h3>
              <p style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                수집/감지 메뉴에서 키워드를 검토하고 넘긴 RSS 글만 표시됩니다. 플랫폼과 카테고리는 각 RSS 행의 값을 우선 사용합니다.
              </p>
            </div>
            <button
              type="button"
              onClick={createJobsFromSelectedRssItems}
              disabled={selectedRssItems.length === 0 || creatingRssJobs}
              style={{
                height: 30,
                padding: '0 12px',
                borderRadius: 8,
                border: 'none',
                background: selectedRssItems.length === 0 || creatingRssJobs ? COLORS.textMuted : COLORS.success,
                color: 'white',
                fontSize: 11,
                fontWeight: 850,
                cursor: selectedRssItems.length === 0 || creatingRssJobs ? 'not-allowed' : 'pointer',
              }}
            >
              {creatingRssJobs ? '발행 생성 중' : `선택 RSS 발행 생성 (${selectedRssItems.length})`}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 900, color: COLORS.textSecondary }}>
              <input type="checkbox" checked={allRssItemsSelected} onChange={toggleAllRssItems} />
              전체 선택/해제
            </label>
            <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 800 }}>
              준비된 RSS {readyRssItems.length}개
            </span>
          </div>

          <div style={{ overflowX: 'auto', maxHeight: 220 }}>
            {readyRssItems.length === 0 ? (
              <div style={{ padding: 22, textAlign: 'center', color: COLORS.textMuted, fontSize: 12 }}>
                아직 발행 생성 대기로 넘어온 RSS 글이 없습니다. 수집/감지 메뉴에서 RSS 글을 선택해 넘겨주세요.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                    {['선택', '검색량', '상태', '제목', '플랫폼', '선택 KW', '작업'].map((head) => (
                      <th key={head} style={{ padding: '9px 10px', borderBottom: `1px solid ${COLORS.border}` }}>{head}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {readyRssItems.map((item) => {
                    const band = volumeBandFor(item.volume_band || 'unknown');
                    return (
                      <tr key={item.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                        <td style={{ padding: '9px 10px' }}>
                          <input type="checkbox" checked={selectedRssItemIds.includes(item.id)} onChange={() => toggleRssItem(item.id)} />
                        </td>
                        <td style={{ padding: '9px 10px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 8px', borderRadius: 999, background: band.color, color: band.textColor, fontSize: 10, fontWeight: 900 }}>
                            {item.search_volume != null ? Number(item.search_volume).toLocaleString() : band.label}
                          </span>
                        </td>
                        <td style={{ padding: '9px 10px' }}><StatusBadge value={item.status} /></td>
                        <td style={{ padding: '9px 10px', maxWidth: 320 }}>
                          <a href={item.link} target="_blank" rel="noreferrer" style={{ fontWeight: 850, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{item.title || '-'}</a>
                          <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted }}>{formatDateTime(item.published_at || item.detected_at)}</p>
                        </td>
                        <td style={{ padding: '9px 10px', color: COLORS.textSecondary }}>{platformLabel[item.platform] || item.platform || '-'}</td>
                        <td style={{ padding: '9px 10px', fontWeight: 850, color: COLORS.primary }}>{item.selected_keyword || item.main_keyword || '-'}</td>
                        <td style={{ padding: '9px 10px', color: COLORS.textSecondary }}>{item.rewrite_job_id ? `#${item.rewrite_job_id}` : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={{
          marginTop: 14,
          padding: 14,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          background: '#f8fafc',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 900, color: COLORS.primary, marginBottom: 4 }}>발행 생성 기준값</h3>
              <p style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                openmind200 최근 20개 자동 중앙값은 1,940자 · 7섹션 · 섹션당 약 280자 · KW 19회 · 이미지 12장입니다.
                운영 기본값은 2,200자 · KW 15회로 보정했습니다.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={benchmarkRewriteSettings}
                disabled={benchmarking}
                style={{
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: benchmarking ? COLORS.textMuted : COLORS.primary,
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 850,
                  cursor: benchmarking ? 'wait' : 'pointer',
                }}
              >
                {benchmarking ? '계산 중' : '최근 20개 재계산'}
              </button>
              <button
                type="button"
                onClick={resetRewriteSettings}
                style={{
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: 'white',
                  color: COLORS.primary,
                  fontSize: 11,
                  fontWeight: 850,
                  cursor: 'pointer',
                }}
              >
                기준값 복원
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10 }}>
            {[
              ['targetCharCount', '목표 글자수', '자'],
              ['sectionCharCount', '섹션당 글자수', '자'],
              ['sectionCount', '소제목 개수', '개'],
              ['targetKwCount', '키워드 반복수', '회'],
              ['imageCount', '이미지 개수', '장'],
            ].map(([key, label, unit]) => (
              <label key={key} style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 800 }}>{label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={key === 'targetCharCount' ? 1200 : 1}
                    max={key === 'targetCharCount' ? 5000 : 30}
                    value={rewriteSettings[key]}
                    onChange={(e) => updateRewriteSetting(key, e.target.value)}
                    style={{
                      width: '100%',
                      height: 36,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 8,
                      padding: '0 10px',
                      fontSize: 12,
                      fontWeight: 800,
                      color: COLORS.textPrimary,
                      outline: 'none',
                      background: 'white',
                    }}
                  />
                  <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 800 }}>{unit}</span>
                </div>
              </label>
            ))}
          </div>
          <input
            value={rewriteSettings.benchmarkUrl}
            onChange={(e) => updateRewriteSetting('benchmarkUrl', e.target.value)}
            placeholder="벤치마킹 기준 URL"
            style={{
              width: '100%',
              height: 36,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: '0 10px',
              fontSize: 11,
              color: COLORS.textSecondary,
              outline: 'none',
              marginTop: 10,
              background: 'white',
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <button
            type="button"
            onClick={createRewriteJobs}
            disabled={creating || !canCreateGenerationJobs}
            style={{
              height: 40,
              padding: '0 18px',
              borderRadius: 9,
              border: 'none',
              background: creating || !canCreateGenerationJobs ? COLORS.textMuted : COLORS.primary,
              color: 'white',
              fontSize: 13,
              fontWeight: 850,
              cursor: creating || !canCreateGenerationJobs ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? '발행 생성 중...' : `발행 생성 작업 만들기 (${rewriteJobCount})`}
          </button>
          {message && <span style={{ fontSize: 12, color: message.includes('완료') || message.includes('복사') ? COLORS.success : COLORS.warning, fontWeight: 800 }}>{message}</span>}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {[
          ['선택 소스', selectedSources.length, COLORS.primary],
          ['평균 글자수', patternSummary.charCount ? patternSummary.charCount.toLocaleString() : '-', COLORS.textPrimary],
          ['평균 KW', patternSummary.kwCount || '-', COLORS.accent],
          ['평균 이미지', patternSummary.imageCount || '-', COLORS.success],
          ['평균 인용구', patternSummary.quoteCount || '-', COLORS.warning],
        ].map(([label, value, color]) => (
          <div key={label} style={{ ...cardStyle, padding: 16 }}>
            <p style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 700, marginBottom: 6 }}>{label}</p>
            <p style={{ fontSize: 25, color, fontWeight: 900, lineHeight: 1 }}>{value}</p>
          </div>
        ))}
      </div>
      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ marginRight: 'auto' }}>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>수집 글 기준 발행 생성</h3>
            <p style={{ marginTop: 4, fontSize: 11, color: COLORS.textSecondary }}>
              수집완료 링크는 메인키워드, 구성 수치, 글자수/KW/이미지/인용구 패턴만 참고합니다. 예시 문장은 재사용하지 않습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSelectedSourceLinkIds(collectedLinks.map((link) => link.id))}
            disabled={collectedLinks.length === 0}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.primary, fontSize: 11, fontWeight: 850, cursor: collectedLinks.length === 0 ? 'not-allowed' : 'pointer' }}
          >
            전체 선택
          </button>
          <button
            type="button"
            onClick={() => setSelectedSourceLinkIds([])}
            disabled={selectedSourceLinkIds.length === 0}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.textSecondary, fontSize: 11, fontWeight: 850, cursor: selectedSourceLinkIds.length === 0 ? 'not-allowed' : 'pointer' }}
          >
            선택 해제
          </button>
          <button
            type="button"
            onClick={reanalyzeSelectedMainKeywords}
            disabled={selectedSourceLinkIds.length === 0 || reanalyzingKeywords}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.primary, fontSize: 11, fontWeight: 850, cursor: selectedSourceLinkIds.length === 0 || reanalyzingKeywords ? 'not-allowed' : 'pointer' }}
          >
            {reanalyzingKeywords ? 'KW 재분석중' : '메인 KW 재분석'}
          </button>
          <button
            type="button"
            onClick={reprocessSelectedJobs}
            disabled={selectedRewriteLinks.length === 0 || creating}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.accent, fontSize: 11, fontWeight: 850, cursor: selectedRewriteLinks.length === 0 || creating ? 'not-allowed' : 'pointer' }}
          >
            전체 다시생성
          </button>
          <button
            type="button"
            onClick={sendSelectedToPublishQueue}
            disabled={selectedRewriteLinks.length === 0 || queueing}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: selectedRewriteLinks.length === 0 || queueing ? COLORS.textMuted : COLORS.success, color: 'white', fontSize: 11, fontWeight: 850, cursor: selectedRewriteLinks.length === 0 || queueing ? 'not-allowed' : 'pointer' }}
          >
            발행큐로 보내기
          </button>
          <button
            type="button"
            onClick={queueSelectedForAutoPublish}
            disabled={selectedRewriteLinks.length === 0 || queueing}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: selectedRewriteLinks.length === 0 || queueing ? COLORS.textMuted : COLORS.primary, color: 'white', fontSize: 11, fontWeight: 850, cursor: selectedRewriteLinks.length === 0 || queueing ? 'not-allowed' : 'pointer' }}
          >
            자동발행 대기
          </button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: COLORS.textSecondary, fontWeight: 800 }}>
            간격(분)
            <input
              type="number"
              min="1"
              max="1440"
              value={publishSpacingMinutes}
              onChange={(e) => setPublishSpacingMinutes(Number(e.target.value) || 120)}
              style={{ width: 64, height: 30, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '0 7px', fontSize: 11, fontWeight: 800 }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: COLORS.textSecondary, fontWeight: 800 }}>
            딜레이(분)
            <input
              type="number"
              min="1"
              max="60"
              value={publishActionDelayMinutes}
              onChange={(e) => setPublishActionDelayMinutes(Number(e.target.value) || 1)}
              style={{ width: 58, height: 30, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '0 7px', fontSize: 11, fontWeight: 800 }}
            />
          </label>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 430 }}>
          {loading ? (
            <div style={{ padding: 20 }}>
              {[1, 2, 3].map((item) => <Skeleton key={item} height={46} style={{ marginBottom: 8 }} />)}
            </div>
          ) : collectedLinks.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              아직 발행 생성에 쓸 수집완료 링크가 없습니다.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1810 }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                  {['선택', '발행 상태', '생성 상태', '작업', '수집일', '블로그/출처', '플랫폼', '메인키워드', '수정 KW', '카테고리', '글자/KW/이미지', '인용구/반복어', 'URL'].map((head) => (
                    <th key={head} style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` }}>
                      {head === '선택' ? (
                        <input
                          type="checkbox"
                          checked={allSourcesSelected}
                          onChange={toggleAllSources}
                          aria-label="수집 글 전체 선택 또는 해제"
                        />
                      ) : head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {collectedLinks.map((link) => (
                  <tr key={link.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={selectedSourceLinkIds.includes(link.id)}
                        onChange={() => toggleSource(link.id)}
                        aria-label="수집 글 기준 발행 생성 선택"
                      />
                    </td>
                    <td style={{ padding: '10px 12px', minWidth: 125 }}>
                      <StatusBadge value={link.publish_status || (link.content_job_id ? '발행 큐' : '-')} />
                      {link.published_url && (
                        <a href={link.published_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 5, maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 10 }}>
                          발행 URL
                        </a>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', minWidth: 160 }}>
                      {link.rewrite_job_id ? (
                        <>
                          <StatusBadge value={link.rewrite_status || '대기중'} />
                          <p style={{ marginTop: 5, maxWidth: 150, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            #{link.rewrite_job_id} {link.rewrite_title || link.rewrite_target_keyword || ''}
                          </p>
                          <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textSecondary }}>
                            {Number(link.rewrite_char_count || 0).toLocaleString()}자 / KW {link.rewrite_kw_count || 0} / 이미지 {link.rewrite_image_count || 0}
                          </p>
                        </>
                      ) : (
                        <StatusBadge value="미생성" />
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', minWidth: 160 }}>
                      {link.rewrite_job_id ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => reprocessJob(link.rewrite_job_id)}
                            style={{ height: 28, padding: '0 9px', borderRadius: 7, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.primary, fontSize: 10, fontWeight: 850, cursor: 'pointer' }}
                          >
                            다시 생성
                          </button>
                          <button
                            type="button"
                            onClick={() => sendToPublishQueue(jobFromSourceLink(link))}
                            style={{ height: 28, padding: '0 9px', borderRadius: 7, border: 'none', background: COLORS.success, color: 'white', fontSize: 10, fontWeight: 850, cursor: 'pointer' }}
                          >
                            발행 큐
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: 10, color: COLORS.textMuted, fontWeight: 800 }}>체크 후 생성</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary, whiteSpace: 'nowrap', fontSize: 11 }}>
                      {formatDateTime(link.collected_at || link.created_at)}
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 180 }}>
                      <p style={{ fontWeight: 850, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.blog_nickname || link.blog_name || '-'}</p>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.blog_title || link.blog_id || link.batch_name || ''}</p>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 800, color: COLORS.textSecondary }}>{platformLabel[link.platform_guess] || link.platform_guess || '-'}</td>
                    <td style={{ padding: '10px 12px', minWidth: 150 }}>
                      <p style={{ fontWeight: 850, color: COLORS.primary }}>{link.main_keyword || '-'}</p>
                      {formatKeywordCandidates(link) && (
                        <p style={{ marginTop: 3, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.4 }}>
                          후보 {formatKeywordCandidates(link)}
                        </p>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', minWidth: 140 }}>
                      <input
                        value={keywordDrafts[link.id] ?? link.corrected_main_keyword ?? ''}
                        onChange={(e) => setKeywordDrafts((prev) => ({ ...prev, [link.id]: e.target.value }))}
                        onBlur={() => saveCorrectedKeyword(link)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder="수정 키워드"
                        disabled={savingKeywordIds.includes(link.id)}
                        style={{
                          width: 126,
                          height: 30,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 7,
                          padding: '0 8px',
                          fontSize: 11,
                          fontWeight: 800,
                          color: COLORS.textPrimary,
                          outline: 'none',
                          background: 'white',
                        }}
                      />
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary }}>{link.category_guess || '-'}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary }}>
                      {(link.char_count || 0).toLocaleString()} / {link.kw_count || 0} / {link.image_count || 0}
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary, maxWidth: 240 }}>
                      <p style={{ fontSize: 10, color: COLORS.textMuted }}>인용구 {parseArray(link.quote_blocks).length}개</p>
                      <p style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatTerms(link.quote_repeated_terms?.length ? link.quote_repeated_terms : link.repeated_terms)}</p>
                    </td>
                    <td style={{ padding: '10px 12px', maxWidth: 300 }}>
                      <a href={link.url} target="_blank" rel="noreferrer" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {link.url}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>발행 생성 작업 목록</h3>
          <p style={{ marginTop: 4, fontSize: 11, color: COLORS.textSecondary }}>
            완료된 작업은 본문, 점수, 이미지 초안을 함께 저장합니다. 발행 전에 유사도와 사실 검수 단계를 거치는 흐름으로 운영합니다.
          </p>
        </div>
        <div style={{ display: 'grid', gap: 12, padding: 14 }}>
          {jobs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              아직 생성된 발행 생성 작업이 없습니다.
            </div>
          ) : jobs.map((job) => {
            const images = parseArray(job.images_json);
            const firstImage = images[0]?.url;
            return (
              <div key={job.id} style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 10,
                background: 'white',
                padding: 14,
                display: 'grid',
                gridTemplateColumns: firstImage ? '140px minmax(0, 1fr)' : '1fr',
                gap: 14,
              }}>
                {firstImage && (
                  <img
                    src={firstImage}
                    alt={`${job.target_keyword} 대표 이미지 초안`}
                    style={{ width: 140, height: 140, borderRadius: 8, objectFit: 'cover', border: `1px solid ${COLORS.border}` }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                    <div style={{ minWidth: 0, marginRight: 'auto' }}>
                      <h4 style={{ fontSize: 14, fontWeight: 900, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {job.title || job.target_keyword}
                      </h4>
                      <p style={{ marginTop: 3, fontSize: 11, color: COLORS.textMuted }}>
                        #{job.id} · {job.target_keyword} · {platformLabel[job.platform] || job.platform} · {job.category || 'general'}
                      </p>
                    </div>
                    <StatusBadge value={job.status} />
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: COLORS.textSecondary, marginBottom: 10 }}>
                    <span>글자 {Number(job.char_count || 0).toLocaleString()}</span>
                    <span>KW {job.kw_count || 0}</span>
                    <span>이미지 {job.image_count || 0}</span>
                    <span>인용구 {job.quote_count || 0}</span>
                    <span>SEO {Number(job.seo_score || 0).toFixed(0)}</span>
                    <span>GEO {Number(job.geo_score || 0).toFixed(0)}</span>
                    <span>AEO {Number(job.aeo_score || 0).toFixed(0)}</span>
                    <span>유사도 위험 {Number(job.similarity_risk || 0).toFixed(0)}</span>
                    {job.use_naver_qr && <span>네이버 QR 사용</span>}
                  </div>

                  {job.plain_text && (
                    <div style={{
                      maxHeight: 130,
                      overflow: 'auto',
                      padding: 10,
                      borderRadius: 8,
                      background: '#f8fafc',
                      border: `1px solid ${COLORS.border}`,
                      fontSize: 11,
                      lineHeight: 1.65,
                      color: COLORS.textSecondary,
                      whiteSpace: 'pre-wrap',
                      marginBottom: 10,
                    }}>
                      {job.plain_text}
                    </div>
                  )}

                  {job.error_message && (
                    <p style={{ fontSize: 11, color: COLORS.danger, marginBottom: 10 }}>{job.error_message}</p>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => copyBody(job)}
                      disabled={!job.body && !job.plain_text}
                      style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'white', color: COLORS.primary, fontSize: 11, fontWeight: 850, cursor: !job.body && !job.plain_text ? 'not-allowed' : 'pointer' }}
                    >
                      본문 복사
                    </button>
                    <button
                      type="button"
                      onClick={() => reprocessJob(job.id)}
                      style={{ height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: COLORS.primary, color: 'white', fontSize: 11, fontWeight: 850, cursor: 'pointer' }}
                    >
                      다시 생성
                    </button>
                    <button
                      type="button"
                      onClick={() => sendToPublishQueue(job)}
                      disabled={!job.body && !job.plain_text}
                      style={{ height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: !job.body && !job.plain_text ? COLORS.textMuted : COLORS.success, color: 'white', fontSize: 11, fontWeight: 850, cursor: !job.body && !job.plain_text ? 'not-allowed' : 'pointer' }}
                    >
                      발행 큐로 보내기
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ViewStatusPanel() {
  const [platform, setPlatform] = useState('blog');
  const [data, setData] = useState({ items: [], stats: {} });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    const res = await safeFetch(`${API}/views/status?platform=${platform}&limit=100&days=30`);
    setLoading(false);
    if (res?.items) setData(res);
  }, [platform]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const refreshStatus = async () => {
    setRefreshing(true);
    setMessage(platform === 'blog' ? '블로그 조회수를 갱신 중...' : '카페 글 조회수를 갱신 중...');
    const res = await safeFetch(`${API}/views/status/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, limit: 100 }),
    });
    setRefreshing(false);
    if (res?.ok) {
      setMessage(`갱신 완료 · 성공 ${res.collected}개 · 실패 ${res.failed}개`);
      await loadStatus();
    } else {
      setMessage('조회수 갱신에 실패했습니다. 공개 URL인지 확인해 주세요.');
    }
  };

  const items = Array.isArray(data.items) ? data.items : [];
  const stats = data.stats || {};
  const history = Array.isArray(data.history) ? data.history : [];
  const perBlogHistory = Array.isArray(data.perBlogHistory) ? data.perBlogHistory : [];
  const blogLineChartData = useMemo(() => {
    const palette = [COLORS.primary, COLORS.success, COLORS.accent, COLORS.warning, '#6366f1', '#14b8a6', '#f97316', '#8b5cf6'];
    if (perBlogHistory.length === 0 && history.length > 0) {
      return {
        labels: history.map((row) => String(row.snapshot_date || '').slice(5, 10)),
        series: [{
          name: '전체',
          values: history.map((row) => Number(row.daily_view_count || 0)),
          color: COLORS.success,
        }],
      };
    }

    const dates = [...new Set(perBlogHistory.map((row) => String(row.snapshot_date || '').slice(0, 10)).filter(Boolean))].sort();
    const groups = new Map();
    perBlogHistory.forEach((row) => {
      const id = row.collected_blog_id || row.blog_id || row.blog_name;
      if (!id) return;
      const label = row.blog_nickname || row.blog_name || row.blog_title || row.blog_id || `블로그 ${id}`;
      if (!groups.has(id)) groups.set(id, { name: label, values: new Map(), total: 0 });
      const group = groups.get(id);
      const value = Number(row.daily_view_count || 0);
      group.values.set(String(row.snapshot_date || '').slice(0, 10), value);
      group.total += value;
    });

    const series = [...groups.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((group, index) => ({
        name: group.name,
        values: dates.map((date) => group.values.get(date) ?? null),
        color: palette[index % palette.length],
      }));

    return {
      labels: dates.map((date) => date.slice(5, 10)),
      series,
    };
  }, [history, perBlogHistory]);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>조회수 근황</h2>
            <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              블로그는 오늘 현재 조회수와 별도로 매일 23:55 이후 오늘 조회수를 하루 마감값으로 확정 저장합니다. 카페는 조회수 10 이상 글만 전날 대비 증가분을 추적합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshStatus}
            disabled={refreshing || loading}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 9,
              border: 'none',
              background: refreshing || loading ? COLORS.textMuted : COLORS.success,
              color: 'white',
              fontSize: 12,
              fontWeight: 850,
              cursor: refreshing || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {refreshing ? '갱신 중' : '현재 조회수 갱신'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {[
            ['blog', '블로그'],
            ['cafe', '카페'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPlatform(key)}
              style={{
                height: 34,
                padding: '0 16px',
                borderRadius: 9,
                border: `1px solid ${platform === key ? COLORS.primary : COLORS.border}`,
                background: platform === key ? COLORS.primary : 'white',
                color: platform === key ? 'white' : COLORS.textSecondary,
                fontSize: 12,
                fontWeight: 850,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
          {message && <span style={{ alignSelf: 'center', fontSize: 12, color: message.includes('완료') ? COLORS.success : COLORS.warning, fontWeight: 800 }}>{message}</span>}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {(platform === 'blog'
          ? [
              ['저장 블로그', stats.total || 0, COLORS.primary],
              ['최근 마감 1일 조회', Number(stats.closedDailyViews || stats.dailyViews || 0).toLocaleString(), COLORS.success],
              ['오늘 현재 조회', Number(stats.todayCurrentViews || 0).toLocaleString(), COLORS.accent],
              ['현재 전체 조회', Number(stats.realtimeTotalViews || 0).toLocaleString(), COLORS.textPrimary],
            ]
          : [
              ['조회 10+ 글', stats.overThreshold || stats.total || 0, COLORS.primary],
              ['전날 대비 증가', Number(stats.totalIncrease || 0).toLocaleString(), COLORS.success],
              ['추적 글', stats.total || 0, COLORS.textPrimary],
            ]
        ).map(([label, value, color]) => (
          <div key={label} style={{ ...cardStyle, padding: 16 }}>
            <p style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 700, marginBottom: 6 }}>{label}</p>
            <p style={{ fontSize: 25, color, fontWeight: 900, lineHeight: 1 }}>{value}</p>
          </div>
        ))}
      </div>

      {platform === 'blog' && (
        <LineChart
          title="블로그별 30일 일일 조회수"
          data={blogLineChartData}
        />
      )}

      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>
            {platform === 'blog' ? '블로그 조회수 기록' : '카페 글 조회수 기록'}
          </h3>
          <p style={{ marginTop: 4, fontSize: 11, color: COLORS.textSecondary }}>
            공개 페이지에서 읽을 수 있는 조회수만 기록합니다. 로그인이나 가입이 필요한 글은 Runner 인증 수집 대상으로 분리합니다.
          </p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 20 }}>
              {[1, 2, 3].map((item) => <Skeleton key={item} height={48} style={{ marginBottom: 8 }} />)}
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              {platform === 'blog' ? '아직 조회수 추적 블로그가 없습니다.' : '조회수 10 이상으로 추적 중인 카페 글이 없습니다.'}
            </div>
          ) : platform === 'blog' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1020 }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                  {['블로그', '최근 마감 1일', '오늘 현재', '전체', '마감일', '최근 확인', '홈'].map((head) => (
                    <th key={head} style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` }}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '10px 12px', maxWidth: 220 }}>
                      <p style={{ fontWeight: 850, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.blog_nickname || item.blog_name || '-'}</p>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.blog_title || item.blog_id || ''}</p>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 850, color: COLORS.accent }}>
                      {item.closed_daily_view_count == null ? '-' : `+${Number(item.closed_daily_view_count).toLocaleString()}`}
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.success, fontWeight: 800 }}>{item.last_today_view_count == null ? '-' : Number(item.last_today_view_count).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary }}>{item.last_total_view_count == null ? '-' : Number(item.last_total_view_count).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{item.closed_snapshot_date ? String(item.closed_snapshot_date).slice(0, 10) : '-'}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{item.last_checked_at ? formatDate(item.last_checked_at) : '-'}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 240 }}>
                      <a href={item.home_url} target="_blank" rel="noreferrer" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.home_url}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                  {['카페 글', '카페', '현재 조회', '전날 대비', '기준일', '최근 확인', 'URL'].map((head) => (
                    <th key={head} style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` }}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '10px 12px', maxWidth: 260 }}>
                      <p style={{ fontWeight: 850, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title || '카페 글'}</p>
                      <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted }}>{item.category || '-'}</p>
                    </td>
                    <td style={{ padding: '10px 12px', color: COLORS.textSecondary }}>{item.cafe_name || item.cafe_id || '-'}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.primary, fontWeight: 850 }}>{Number(item.last_view_count || item.view_count || 0).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.success, fontWeight: 850 }}>+{Number(item.daily_increase || item.last_daily_increase || 0).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{item.snapshot_date ? String(item.snapshot_date).slice(0, 10) : '-'}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{item.last_checked_at ? formatDate(item.last_checked_at) : '-'}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 280 }}>
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.url}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function OperationsSettingsPanelLegacy() {
  const emptySettings = {
    runnerUrl: 'http://127.0.0.1:39271',
    naverClientId: '',
    naverClientSecret: '',
    accounts: [],
    qrAccounts: [],
    vpnProfiles: [],
  };
  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.opsSettings') || 'null') || {};
      return { ...emptySettings, ...saved };
    } catch {
      return emptySettings;
    }
  });
  const [runnerStatus, setRunnerStatus] = useState({ state: 'idle', message: '' });
  const [accountForm, setAccountForm] = useState({ platform: 'blog', label: '', memo: '', usernameHint: '' });
  const [qrForm, setQrForm] = useState({ label: '', naverIdHint: '', dailyLimit: 100 });
  const [vpnForm, setVpnForm] = useState({ label: '', provider: 'nordvpn', target: '', mode: '수동 승인' });

  const saveSettings = (next) => {
    setSettings(next);
    localStorage.setItem('naviwrite.opsSettings', JSON.stringify(next));
  };

  const runnerBase = (settings.runnerUrl || 'http://127.0.0.1:39271').replace(/\/$/, '');

  const runnerRequest = async (path, opts = {}) => {
    const res = await fetch(`${runnerBase}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Runner error (${res.status})`);
    return data;
  };

  const testRunner = async () => {
    setRunnerStatus({ state: 'testing', message: 'Runner 연결 확인 중...' });
    try {
      const health = await runnerRequest('/health');
      setRunnerStatus({
        state: 'ok',
        message: `연결됨 · ${health.service} · 브라우저 ${health.browserFound ? '감지' : '미감지'}`,
      });
    } catch (err) {
      setRunnerStatus({
        state: 'fail',
        message: err instanceof Error ? err.message : 'Runner 연결 실패',
      });
    }
  };

  const updateAccount = (id, patch) => {
    saveSettings({
      ...settings,
      accounts: settings.accounts.map((account) =>
        account.id === id ? { ...account, ...patch } : account
      ),
    });
  };

  const ensureRunnerProfile = async (account) => {
    const profileId = account.runnerProfileId || account.id;
    const data = await runnerRequest('/profiles', {
      method: 'POST',
      body: JSON.stringify({
        id: profileId,
        label: account.label,
        platform: account.platform,
        targetUrl: account.memo,
        usernameHint: account.usernameHint,
        loginCheckIntervalHours: 6,
        inactivityRecheckHours: 2,
      }),
    });
    updateAccount(account.id, {
      runnerProfileId: data.profile.id,
      loginStatus: data.session?.needsLoginCheck ? '로그인 체크 필요' : data.session?.loginStatus || '로그인 체크 필요',
      runnerSyncedAt: new Date().toISOString(),
    });
    return data.profile.id;
  };

  const createRunnerProfile = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} Runner 프로필 생성 중...` });
    try {
      await ensureRunnerProfile(account);
      setRunnerStatus({ state: 'ok', message: `${account.label} 프로필을 Runner에 만들었습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '프로필 생성 실패' });
    }
  };

  const openRunnerLogin = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 로그인 창 여는 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      await runnerRequest(`/profiles/${profileId}/open-login`, { method: 'POST', body: '{}' });
      updateAccount(account.id, { loginStatus: '로그인 확인 중', runnerProfileId: profileId });
      setRunnerStatus({ state: 'ok', message: `${account.label} 전용 브라우저 프로필을 열었습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '로그인 창 열기 실패' });
    }
  };

  const markRunnerLoginChecked = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 로그인 체크 저장 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/mark-login-checked`, { method: 'POST', body: '{}' });
      updateAccount(account.id, {
        loginStatus: '로그인됨',
        runnerProfileId: profileId,
        lastCheckedAt: data.profile?.lastLoginCheckedAt || new Date().toISOString(),
      });
      setRunnerStatus({ state: 'ok', message: `${account.label} 로그인 체크 완료` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '로그인 체크 실패' });
    }
  };

  const addAccount = () => {
    if (!accountForm.label.trim()) return;
    saveSettings({
      ...settings,
      accounts: [...settings.accounts, {
        id: `acc_${Date.now()}`,
        ...accountForm,
        runnerProfileId: '',
        credentialPolicy: 'Runner 로컬 DPAPI',
        sessionPolicy: '6시간 체크 · 2시간 무활동 재확인',
        loginStatus: '로그인 체크 필요',
        lastCheckedAt: null,
      }],
    });
    setAccountForm({ platform: 'blog', label: '', memo: '', usernameHint: '' });
  };

  const addQr = () => {
    if (!qrForm.label.trim()) return;
    saveSettings({
      ...settings,
      qrAccounts: [...settings.qrAccounts, {
        id: `qr_${Date.now()}`,
        ...qrForm,
        usedToday: 0,
        status: '사용가능',
      }],
    });
    setQrForm({ label: '', naverIdHint: '', dailyLimit: 100 });
  };

  const addVpn = () => {
    if (!vpnForm.label.trim()) return;
    saveSettings({
      ...settings,
      vpnProfiles: [...settings.vpnProfiles, {
        id: `vpn_${Date.now()}`,
        ...vpnForm,
        lastPublicIp: '',
        lastCheckedAt: null,
      }],
    });
    setVpnForm({ label: '', provider: 'nordvpn', target: '', mode: '수동 승인' });
  };

  const removeItem = (key, id) => {
    saveSettings({ ...settings, [key]: settings[key].filter((item) => item.id !== id) });
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 5 }}>운영 설정</h2>
        <p style={{ fontSize: 12, color: COLORS.textSecondary }}>
          서버 DB에는 비밀번호를 저장하지 않습니다. 계정 세션과 필요 시 ID/PW는 Local Runner가 PC 안에서만 관리합니다.
        </p>
      </section>

      <section style={{ ...cardStyle, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>Local Runner 연결</h3>
            <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              Runner가 계정별 브라우저 프로필, 로그인 세션, 로컬 암호화 자격증명, VPN 명령 계획을 담당합니다.
            </p>
          </div>
          <StatusBadge value={runnerStatus.state === 'ok' ? '연결됨' : runnerStatus.state === 'fail' ? '오류' : '대기중'} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 130px', gap: 8 }}>
          <input
            value={settings.runnerUrl}
            onChange={(e) => saveSettings({ ...settings, runnerUrl: e.target.value })}
            placeholder="http://127.0.0.1:39271"
            style={{ ...inputStyle, marginBottom: 0 }}
          />
          <button type="button" onClick={testRunner} style={{ ...primaryButtonStyle, marginBottom: 0 }}>
            연결 테스트
          </button>
        </div>
        {runnerStatus.message && (
          <p style={{
            marginTop: 9,
            fontSize: 11,
            fontWeight: 700,
            color: runnerStatus.state === 'fail' ? COLORS.danger : runnerStatus.state === 'ok' ? COLORS.success : COLORS.textSecondary,
          }}>
            {runnerStatus.message}
          </p>
        )}
        <p style={{ marginTop: 8, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.6 }}>
          실행 명령: <code>node runner/server.js</code>. 이후 EXE 패키징으로 바꿀 수 있습니다.
        </p>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <section style={{ ...cardStyle, padding: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>Naver Search API</h3>
          <input
            value={settings.naverClientId || ''}
            onChange={(e) => saveSettings({ ...settings, naverClientId: e.target.value })}
            placeholder="NAVER_CLIENT_ID"
            style={inputStyle}
          />
          <input
            type="password"
            value={settings.naverClientSecret || ''}
            onChange={(e) => saveSettings({ ...settings, naverClientSecret: e.target.value })}
            placeholder="NAVER_CLIENT_SECRET"
            style={inputStyle}
          />
          <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
            제목 추천에서 네이버 블로그/카페/웹 검색 결과를 검증할 때 사용합니다. 비워두면 Railway 환경변수 값을 사용합니다.
          </p>
        </section>
        <section style={{ ...cardStyle, padding: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>발행 계정 슬롯</h3>
          <select value={accountForm.platform} onChange={(e) => setAccountForm({ ...accountForm, platform: e.target.value })} style={inputStyle}>
            <option value="blog">네이버 블로그</option>
            <option value="cafe">네이버 카페</option>
            <option value="premium">네프콘</option>
            <option value="brunch">브런치</option>
          </select>
          <input value={accountForm.label} onChange={(e) => setAccountForm({ ...accountForm, label: e.target.value })} placeholder="예: 네이버 블로그 계정 1" style={inputStyle} />
          <input value={accountForm.usernameHint} onChange={(e) => setAccountForm({ ...accountForm, usernameHint: e.target.value })} placeholder="ID 힌트 또는 담당자명. 비밀번호 입력 금지" style={inputStyle} />
          <input value={accountForm.memo} onChange={(e) => setAccountForm({ ...accountForm, memo: e.target.value })} placeholder="메모 또는 운영 채널 URL" style={inputStyle} />
          <button type="button" onClick={addAccount} style={primaryButtonStyle}>계정 슬롯 추가</button>
          <AccountSlotList
            items={settings.accounts}
            onRemove={(id) => removeItem('accounts', id)}
            onCreateProfile={createRunnerProfile}
            onOpenLogin={openRunnerLogin}
            onMarkChecked={markRunnerLoginChecked}
          />
        </section>

        <section style={{ ...cardStyle, padding: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>네이버 QR 계정 풀</h3>
          <input value={qrForm.label} onChange={(e) => setQrForm({ ...qrForm, label: e.target.value })} placeholder="예: QR 계정 1" style={inputStyle} />
          <input value={qrForm.naverIdHint} onChange={(e) => setQrForm({ ...qrForm, naverIdHint: e.target.value })} placeholder="네이버 ID 힌트" style={inputStyle} />
          <input type="number" value={qrForm.dailyLimit} onChange={(e) => setQrForm({ ...qrForm, dailyLimit: Number(e.target.value) })} placeholder="일일 한도" style={inputStyle} />
          <button type="button" onClick={addQr} style={primaryButtonStyle}>QR 계정 추가</button>
          <SettingList items={settings.qrAccounts} onRemove={(id) => removeItem('qrAccounts', id)} meta={(item) => `${item.usedToday}/${item.dailyLimit} · ${item.status}`} />
        </section>

        <section style={{ ...cardStyle, padding: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>VPN 프로필</h3>
          <input value={vpnForm.label} onChange={(e) => setVpnForm({ ...vpnForm, label: e.target.value })} placeholder="예: 블로그 계정 1 KR" style={inputStyle} />
          <select value={vpnForm.provider} onChange={(e) => setVpnForm({ ...vpnForm, provider: e.target.value })} style={inputStyle}>
            <option value="nordvpn">NordVPN CLI</option>
            <option value="mullvad">Mullvad CLI</option>
            <option value="manual">수동 전환</option>
          </select>
          <input value={vpnForm.target} onChange={(e) => setVpnForm({ ...vpnForm, target: e.target.value })} placeholder="국가/서버 예: South Korea" style={inputStyle} />
          <button type="button" onClick={addVpn} style={primaryButtonStyle}>VPN 프로필 추가</button>
          <SettingList items={settings.vpnProfiles} onRemove={(id) => removeItem('vpnProfiles', id)} meta={(item) => `${item.provider} · ${item.target || 'target 없음'} · ${item.mode}`} />
        </section>
      </div>

      <section style={{ ...cardStyle, padding: 16, background: '#fff7ed', borderColor: '#fed7aa' }}>
        <p style={{ fontSize: 12, color: '#9a3412', lineHeight: 1.65 }}>
          운영 기준: 서버는 작업과 상태만 저장합니다. 로그인 세션과 암호화된 자격증명은 Runner PC에만 저장하고,
          발행 전에는 6시간 체크 또는 2시간 무활동 기준으로 로그인 재확인을 요구합니다.
        </p>
      </section>
    </div>
  );
}

function AccountSlotList({ items, onRemove, onCreateProfile, onOpenLogin, onMarkChecked }) {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {items.length === 0 ? (
        <div style={{ padding: 16, border: `1px dashed ${COLORS.border}`, borderRadius: 9, color: COLORS.textMuted, fontSize: 12, textAlign: 'center' }}>
          아직 등록된 계정 슬롯이 없습니다.
        </div>
      ) : items.map((item) => (
        <div key={item.id} style={{ padding: 10, border: `1px solid ${COLORS.border}`, borderRadius: 9, background: 'white' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 850, color: COLORS.textPrimary }}>{item.label}</p>
              <p style={{ fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.platform} · {item.loginStatus} · {item.runnerProfileId ? `Runner ${item.runnerProfileId}` : 'Runner 미연동'}
              </p>
              <p style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>
                {item.credentialPolicy || 'Runner 로컬 DPAPI'} · {item.sessionPolicy || '6시간 체크 · 2시간 무활동 재확인'}
              </p>
            </div>
            <button type="button" onClick={() => onRemove(item.id)} style={{
              height: 28,
              padding: '0 9px',
              borderRadius: 7,
              border: 'none',
              background: '#fef2f2',
              color: COLORS.danger,
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
            }}>
              삭제
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            <button type="button" onClick={() => onCreateProfile(item)} style={smallButtonStyle}>프로필 생성</button>
            <button type="button" onClick={() => onOpenLogin(item)} style={smallButtonStyle}>로그인 열기</button>
            <button type="button" onClick={() => onMarkChecked(item)} style={{ ...smallButtonStyle, background: COLORS.success, color: 'white', borderColor: COLORS.success }}>
              체크 완료
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function OperationsSettingsPanel() {
  const emptySettings = {
    runnerUrl: 'http://127.0.0.1:39271',
    naverClientId: '',
    naverClientSecret: '',
    accounts: [],
    qrAccounts: [],
    vpnProfiles: [],
  };
  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('naviwrite.opsSettings') || 'null') || {};
      return {
        ...emptySettings,
        ...saved,
        accounts: Array.isArray(saved.accounts) ? saved.accounts : [],
        qrAccounts: Array.isArray(saved.qrAccounts) ? saved.qrAccounts : [],
        vpnProfiles: Array.isArray(saved.vpnProfiles) ? saved.vpnProfiles : [],
      };
    } catch {
      return emptySettings;
    }
  });
  const [runnerStatus, setRunnerStatus] = useState({ state: 'idle', message: '' });
  const [accountForm, setAccountForm] = useState({ platform: 'blog', label: '', memo: '', usernameHint: '', password: '' });
  const [qrForm, setQrForm] = useState({ label: '', naverIdHint: '', dailyLimit: 100 });
  const [vpnForm, setVpnForm] = useState({ label: '', provider: 'nordvpn', target: '', mode: '수동 확인' });
  const [credentialDrafts, setCredentialDrafts] = useState({});

  const saveSettings = (next) => {
    setSettings(next);
    localStorage.setItem('naviwrite.opsSettings', JSON.stringify(next));
  };

  const runnerBase = (settings.runnerUrl || 'http://127.0.0.1:39271').replace(/\/$/, '');

  const runnerRequest = async (path, opts = {}) => {
    const res = await fetch(`${runnerBase}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Runner error (${res.status})`);
    return data;
  };

  const updateAccount = (id, patch) => {
    saveSettings({
      ...settings,
      accounts: settings.accounts.map((account) =>
        account.id === id ? { ...account, ...patch } : account
      ),
    });
  };

  const applyRunnerState = (account, payload = {}) => {
    const profile = payload.profile || {};
    const plan = payload.plan || {};
    const session = payload.session || plan.session || profile.session || {};
    const credential = payload.credential || plan.credential || profile.credential || {};
    updateAccount(account.id, {
      runnerProfileId: profile.id || plan.profileId || account.runnerProfileId || account.id,
      usernameHint: credential.username || profile.usernameHint || account.usernameHint || '',
      loginStatus: session.needsLoginCheck ? '로그인 재확인 필요' : session.loginStatus || account.loginStatus || '로그인 체크 필요',
      hasCredential: Boolean(credential.hasCredential ?? profile.hasCredential ?? account.hasCredential),
      credentialUpdatedAt: credential.updatedAt || account.credentialUpdatedAt || null,
      credentialVerifiedAt: credential.verifiedAt || account.credentialVerifiedAt || null,
      runnerPlan: plan.recommendedAction || account.runnerPlan || '',
      runnerReason: plan.reason || account.runnerReason || '',
      lastCheckedAt: session.lastLoginCheckedAt || account.lastCheckedAt || null,
      runnerSyncedAt: new Date().toISOString(),
    });
  };

  const ensureRunnerProfile = async (account) => {
    const profileId = account.runnerProfileId || account.id;
    const data = await runnerRequest('/profiles', {
      method: 'POST',
      body: JSON.stringify({
        id: profileId,
        label: account.label,
        platform: account.platform,
        targetUrl: account.memo,
        usernameHint: account.usernameHint,
        loginCheckIntervalHours: 6,
        inactivityRecheckHours: 2,
      }),
    });
    applyRunnerState(account, data);
    return data.profile?.id || profileId;
  };

  const testRunner = async () => {
    setRunnerStatus({ state: 'testing', message: 'Runner 연결 확인 중...' });
    try {
      const health = await runnerRequest('/health');
      const startup = await runnerRequest('/startup-check').catch(() => null);
      const checkCount = startup?.profiles?.filter((item) => item.session?.needsLoginCheck).length || 0;
      setRunnerStatus({
        state: 'ok',
        message: `연결됨 · ${health.service} · 브라우저 ${health.browserFound ? '감지됨' : '미감지'} · 재확인 ${checkCount}개`,
      });
    } catch (err) {
      setRunnerStatus({
        state: 'fail',
        message: err instanceof Error ? err.message : 'Runner 연결 실패',
      });
    }
  };

  const createRunnerProfile = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} Runner 프로필 생성 중...` });
    try {
      await ensureRunnerProfile(account);
      setRunnerStatus({ state: 'ok', message: `${account.label} 프로필을 Runner에 저장했습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '프로필 생성 실패' });
    }
  };

  const checkRunnerSession = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 세션 상태 확인 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/session-status`);
      applyRunnerState(account, { ...data, profile: { id: profileId } });
      setRunnerStatus({ state: 'ok', message: data.plan?.reason || `${account.label} 세션 상태를 확인했습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '세션 확인 실패' });
    }
  };

  const openRunnerLogin = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 인증 창 여는 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      await runnerRequest(`/profiles/${profileId}/open-login`, { method: 'POST', body: '{}' });
      updateAccount(account.id, { loginStatus: '인증 진행 중', runnerProfileId: profileId });
      setRunnerStatus({ state: 'ok', message: `${account.label} 인증 창을 열었습니다. 네이버 보안 확인을 끝낸 뒤 인증 완료 저장을 누르세요` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '인증 창 열기 실패' });
    }
  };

  const markRunnerLoginChecked = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 인증 완료 저장 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/mark-login-checked`, { method: 'POST', body: '{}' });
      applyRunnerState(account, data);
      updateAccount(account.id, { loginStatus: '발행 준비 완료', runnerProfileId: profileId, runnerReason: '인증 완료된 브라우저 세션을 우선 사용합니다.' });
      setRunnerStatus({ state: 'ok', message: `${account.label} 인증 완료. 발행 준비 상태로 저장했습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '인증 완료 저장 실패' });
    }
  };

  const saveRunnerCredential = async (account) => {
    const draft = credentialDrafts[account.id] || {};
    if (!draft.username || !draft.password) {
      setRunnerStatus({ state: 'fail', message: 'ID와 비밀번호를 모두 입력해야 합니다' });
      return;
    }
    setRunnerStatus({ state: 'testing', message: `${account.label} 자격증명 로컬 저장 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/credentials`, {
        method: 'POST',
        body: JSON.stringify({ username: draft.username, password: draft.password }),
      });
      applyRunnerState(account, data);
      setCredentialDrafts({ ...credentialDrafts, [account.id]: { username: draft.username, password: '' } });
      setRunnerStatus({ state: 'ok', message: `${account.label} ID/PW를 Runner PC에만 암호화 저장했습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '자격증명 저장 실패' });
    }
  };

  const verifyRunnerCredential = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 로컬 자격증명 검증 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/credentials/verify`, { method: 'POST', body: '{}' });
      applyRunnerState(account, { ...data, profile: { id: profileId } });
      setRunnerStatus({ state: 'ok', message: `${account.label} 로컬 자격증명을 읽을 수 있습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '자격증명 검증 실패' });
    }
  };

  const deleteRunnerCredential = async (account) => {
    setRunnerStatus({ state: 'testing', message: `${account.label} 자격증명 삭제 중...` });
    try {
      const profileId = account.runnerProfileId || await ensureRunnerProfile(account);
      const data = await runnerRequest(`/profiles/${profileId}/credentials`, { method: 'DELETE' });
      applyRunnerState(account, data);
      setCredentialDrafts({ ...credentialDrafts, [account.id]: { username: '', password: '' } });
      setRunnerStatus({ state: 'ok', message: `${account.label} 로컬 자격증명을 삭제했습니다` });
    } catch (err) {
      setRunnerStatus({ state: 'fail', message: err instanceof Error ? err.message : '자격증명 삭제 실패' });
    }
  };

  const saveInitialCredential = async (account, baseSettings, password) => {
    const profileData = await runnerRequest('/profiles', {
      method: 'POST',
      body: JSON.stringify({
        id: account.id,
        label: account.label,
        platform: account.platform,
        targetUrl: account.memo,
        usernameHint: account.usernameHint,
        loginCheckIntervalHours: 6,
        inactivityRecheckHours: 2,
      }),
    });
    const profileId = profileData.profile?.id || account.id;
    const credentialData = await runnerRequest(`/profiles/${profileId}/credentials`, {
      method: 'POST',
      body: JSON.stringify({ username: account.usernameHint, password }),
    });
    const profile = credentialData.profile || profileData.profile || {};
    const credential = credentialData.credential || profile.credential || {};
    const plan = credentialData.plan || profileData.plan || {};
    const session = plan.session || profile.session || {};

    saveSettings({
      ...baseSettings,
      accounts: baseSettings.accounts.map((item) => item.id === account.id ? {
        ...item,
        runnerProfileId: profileId,
        usernameHint: credential.username || account.usernameHint,
        loginStatus: '최초 인증 필요',
        hasCredential: Boolean(credential.hasCredential),
        credentialUpdatedAt: credential.updatedAt || new Date().toISOString(),
        credentialVerifiedAt: credential.verifiedAt || null,
        runnerPlan: plan.recommendedAction || '',
        runnerReason: 'ID/PW는 저장됐습니다. 네이버 IP 보안/2차 인증 확인을 위해 인증 창에서 최초 로그인을 완료해 주세요.',
        runnerSyncedAt: new Date().toISOString(),
      } : item),
    });
  };

  const addAccount = async () => {
    if (!accountForm.label.trim()) return;
    if (accountForm.password && !accountForm.usernameHint.trim()) {
      setRunnerStatus({ state: 'fail', message: 'ID/PW 저장 방식은 로그인 ID가 필요합니다' });
      return;
    }

    const { password, ...safeAccountForm } = accountForm;
    const newAccount = {
      id: `acc_${Date.now()}`,
      ...safeAccountForm,
      runnerProfileId: '',
      credentialPolicy: 'Runner 로컬 DPAPI',
      sessionPolicy: '6시간 체크 · 2시간 무활동 재확인',
      loginStatus: password ? 'ID/PW 저장 중' : 'ID/PW 미저장',
      hasCredential: false,
      lastCheckedAt: null,
    };
    const nextSettings = {
      ...settings,
      accounts: [...settings.accounts, newAccount],
    };

    saveSettings(nextSettings);
    setAccountForm({ platform: 'blog', label: '', memo: '', usernameHint: '', password: '' });

    if (!password) {
      setRunnerStatus({ state: 'idle', message: '계정 슬롯을 저장했습니다. ID/PW는 아래 계정 카드에서 나중에 저장할 수 있습니다' });
      return;
    }

    setRunnerStatus({ state: 'testing', message: `${newAccount.label} ID/PW를 Runner에 저장 중...` });
    try {
      await saveInitialCredential(newAccount, nextSettings, password);
      setRunnerStatus({ state: 'ok', message: `${newAccount.label} ID/PW 저장 완료. 이제 인증 창을 열어 네이버 보안 확인을 완료하세요` });
    } catch (err) {
      setRunnerStatus({
        state: 'fail',
        message: err instanceof Error
          ? `${err.message} · 계정 슬롯은 저장됐지만 ID/PW는 저장되지 않았습니다. Runner 실행 후 다시 저장하세요.`
          : 'ID/PW 저장 실패 · Runner 실행 후 다시 저장하세요.',
      });
    }
  };

  const addQr = () => {
    if (!qrForm.label.trim()) return;
    saveSettings({
      ...settings,
      qrAccounts: [...settings.qrAccounts, {
        id: `qr_${Date.now()}`,
        ...qrForm,
        usedToday: 0,
        status: '사용가능',
      }],
    });
    setQrForm({ label: '', naverIdHint: '', dailyLimit: 100 });
  };

  const addVpn = () => {
    if (!vpnForm.label.trim()) return;
    saveSettings({
      ...settings,
      vpnProfiles: [...settings.vpnProfiles, {
        id: `vpn_${Date.now()}`,
        ...vpnForm,
        lastPublicIp: '',
        lastCheckedAt: null,
      }],
    });
    setVpnForm({ label: '', provider: 'nordvpn', target: '', mode: '수동 확인' });
  };

  const removeItem = (key, id) => {
    saveSettings({ ...settings, [key]: settings[key].filter((item) => item.id !== id) });
  };

  const updateCredentialDraft = (id, patch) => {
    setCredentialDrafts({
      ...credentialDrafts,
      [id]: { ...(credentialDrafts[id] || {}), ...patch },
    });
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 5 }}>운영 설정</h2>
        <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.65 }}>
          이 화면은 발행 계정, QR 계정, VPN 프로필을 로컬 기준으로 준비하는 곳입니다. ID/PW는 Runner PC에만 암호화 저장하고,
          네이버 IP 보안, 2차 인증, 새 환경 확인은 인증 창에서 직접 완료한 뒤 발행 준비 상태로 저장합니다.
        </p>
      </section>

      <section style={{ ...cardStyle, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>Local Runner 연결</h3>
            <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
            Runner가 계정별 브라우저 세션, 로컬 암호화 ID/PW, 인증 창 열기, VPN 명령 계획을 담당합니다.
            </p>
          </div>
          <StatusBadge value={runnerStatus.state === 'ok' ? '연결됨' : runnerStatus.state === 'fail' ? '오류' : '대기중'} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <input
            value={settings.runnerUrl}
            onChange={(e) => saveSettings({ ...settings, runnerUrl: e.target.value })}
            placeholder="http://127.0.0.1:39271"
            style={{ ...inputStyle, marginBottom: 0 }}
          />
          <button type="button" onClick={testRunner} style={{ ...primaryButtonStyle, marginBottom: 0 }}>
            연결 테스트
          </button>
          <a href="/downloads/naviwrite-runner.zip" style={{ ...primaryButtonStyle, marginBottom: 0, display: 'grid', placeItems: 'center', textDecoration: 'none', background: COLORS.success }}>
            Runner 다운로드
          </a>
        </div>
        {runnerStatus.message && (
          <p style={{
            marginTop: 9,
            fontSize: 11,
            fontWeight: 700,
            color: runnerStatus.state === 'fail' ? COLORS.danger : runnerStatus.state === 'ok' ? COLORS.success : COLORS.textSecondary,
          }}>
            {runnerStatus.message}
          </p>
        )}
        <p style={{ marginTop: 8, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.6 }}>
          실행 방식: Runner ZIP을 풀고 <code>start-runner.cmd</code>를 실행합니다. 기본 주소는 <code>http://127.0.0.1:39271</code>입니다.
        </p>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <section style={{ ...cardStyle, padding: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>발행 계정 슬롯</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <select value={accountForm.platform} onChange={(e) => setAccountForm({ ...accountForm, platform: e.target.value })} style={inputStyle}>
              <option value="blog">네이버 블로그</option>
              <option value="cafe">네이버 카페</option>
              <option value="premium">네프콘</option>
              <option value="brunch">브런치</option>
              <option value="wordpress">워드프레스</option>
            </select>
            <input value={accountForm.label} onChange={(e) => setAccountForm({ ...accountForm, label: e.target.value })} placeholder="예: 네이버 블로그 계정 1" style={inputStyle} />
          </div>
          <input value={accountForm.usernameHint} onChange={(e) => setAccountForm({ ...accountForm, usernameHint: e.target.value })} placeholder="로그인 ID" style={inputStyle} />
          <input type="password" value={accountForm.password} onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })} placeholder="비밀번호, Runner PC에만 암호화 저장" style={inputStyle} />
          <input value={accountForm.memo} onChange={(e) => setAccountForm({ ...accountForm, memo: e.target.value })} placeholder="발행 채널 URL 또는 워드프레스 사이트 URL" style={inputStyle} />
          <button type="button" onClick={addAccount} style={primaryButtonStyle}>계정 저장 + ID/PW 로컬 저장</button>
          <p style={{ marginTop: 6, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
            네이버 계열 ID/PW 저장은 로그인 완료가 아닙니다. 저장 후 인증 창을 열어 보안 확인을 끝내고 인증 완료 저장까지 눌러야 합니다.
            워드프레스는 사이트 URL, 관리자 ID, Application Password를 저장하면 발행 큐에서 API 발행을 실행할 수 있습니다.
          </p>
          <AccountSlotListV2
            items={settings.accounts}
            drafts={credentialDrafts}
            onDraftChange={updateCredentialDraft}
            onRemove={(id) => removeItem('accounts', id)}
            onCreateProfile={createRunnerProfile}
            onCheckSession={checkRunnerSession}
            onOpenLogin={openRunnerLogin}
            onMarkChecked={markRunnerLoginChecked}
            onSaveCredential={saveRunnerCredential}
            onVerifyCredential={verifyRunnerCredential}
            onDeleteCredential={deleteRunnerCredential}
          />
        </section>

        <div style={{ display: 'grid', gap: 14 }}>
          <section style={{ ...cardStyle, padding: 18 }}>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>Naver Search API</h3>
            <input
              value={settings.naverClientId || ''}
              onChange={(e) => saveSettings({ ...settings, naverClientId: e.target.value })}
              placeholder="NAVER_CLIENT_ID"
              style={inputStyle}
            />
            <input
              type="password"
              value={settings.naverClientSecret || ''}
              onChange={(e) => saveSettings({ ...settings, naverClientSecret: e.target.value })}
              placeholder="NAVER_CLIENT_SECRET"
              style={inputStyle}
            />
            <p style={{ marginTop: 2, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
              제목 추천에서 네이버 검색 결과 중복도와 행동유도어를 검증할 때 사용합니다. 비워두면 Railway 환경변수 값을 사용합니다.
            </p>
          </section>

          <section style={{ ...cardStyle, padding: 18 }}>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>네이버 QR 계정 풀</h3>
            <input value={qrForm.label} onChange={(e) => setQrForm({ ...qrForm, label: e.target.value })} placeholder="예: QR 계정 1" style={inputStyle} />
            <input value={qrForm.naverIdHint} onChange={(e) => setQrForm({ ...qrForm, naverIdHint: e.target.value })} placeholder="네이버 ID 힌트" style={inputStyle} />
            <input type="number" value={qrForm.dailyLimit} onChange={(e) => setQrForm({ ...qrForm, dailyLimit: Number(e.target.value) })} placeholder="일일 한도" style={inputStyle} />
            <button type="button" onClick={addQr} style={primaryButtonStyle}>QR 계정 추가</button>
            <SettingList items={settings.qrAccounts} onRemove={(id) => removeItem('qrAccounts', id)} meta={(item) => `${item.usedToday}/${item.dailyLimit} · ${item.status}`} />
          </section>

          <section style={{ ...cardStyle, padding: 18 }}>
            <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary, marginBottom: 12 }}>VPN 프로필</h3>
            <input value={vpnForm.label} onChange={(e) => setVpnForm({ ...vpnForm, label: e.target.value })} placeholder="예: 블로그 계정 1 KR" style={inputStyle} />
            <select value={vpnForm.provider} onChange={(e) => setVpnForm({ ...vpnForm, provider: e.target.value })} style={inputStyle}>
              <option value="nordvpn">NordVPN CLI</option>
              <option value="mullvad">Mullvad CLI</option>
              <option value="manual">수동 전환</option>
            </select>
            <input value={vpnForm.target} onChange={(e) => setVpnForm({ ...vpnForm, target: e.target.value })} placeholder="국가/서버 예: South Korea" style={inputStyle} />
            <button type="button" onClick={addVpn} style={primaryButtonStyle}>VPN 프로필 추가</button>
            <SettingList items={settings.vpnProfiles} onRemove={(id) => removeItem('vpnProfiles', id)} meta={(item) => `${item.provider} · ${item.target || 'target 없음'} · ${item.mode}`} />
          </section>
        </div>
      </div>

      <section style={{ ...cardStyle, padding: 16, background: '#fff7ed', borderColor: '#fed7aa' }}>
        <p style={{ fontSize: 12, color: '#9a3412', lineHeight: 1.65 }}>
          운영 기준: 프로그램 시작 시 Runner 연결 테스트와 세션 체크를 먼저 진행합니다. 최근 로그인 체크가 6시간을 넘었거나 2시간 이상 활동이 없으면
          해당 계정은 발행 전 재확인을 요구합니다. 저장된 자격증명은 자동 로그인 보조용 준비 단계이며, 실제 발행 자동화는 사용자 확인 흐름으로 붙입니다.
        </p>
      </section>
    </div>
  );
}

function AccountSlotListV2({
  items,
  drafts,
  onDraftChange,
  onRemove,
  onCreateProfile,
  onCheckSession,
  onOpenLogin,
  onMarkChecked,
  onSaveCredential,
  onVerifyCredential,
  onDeleteCredential,
}) {
  const platformName = {
    blog: '네이버 블로그',
    cafe: '네이버 카페',
    premium: '네프콘',
    brunch: '브런치',
    wordpress: '워드프레스',
  };

  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {items.length === 0 ? (
        <div style={{ padding: 16, border: `1px dashed ${COLORS.border}`, borderRadius: 9, color: COLORS.textMuted, fontSize: 12, textAlign: 'center' }}>
          아직 등록된 계정 슬롯이 없습니다.
        </div>
      ) : items.map((item) => {
        const draft = drafts[item.id] || {};
        const usernameValue = draft.username ?? item.usernameHint ?? '';
        return (
          <div key={item.id} style={{ padding: 12, border: `1px solid ${COLORS.border}`, borderRadius: 9, background: 'white' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 850, color: COLORS.textPrimary }}>{item.label}</p>
                <p style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>
                  {platformName[item.platform] || item.platform} · {item.loginStatus || '로그인 체크 필요'} · {item.runnerProfileId ? `Runner ${item.runnerProfileId}` : 'Runner 미연동'}
                </p>
                <p style={{ fontSize: 10, color: item.hasCredential ? COLORS.success : COLORS.textMuted, marginTop: 2 }}>
                  {item.hasCredential ? `자격증명 저장됨${item.credentialUpdatedAt ? ` · ${formatDate(item.credentialUpdatedAt)}` : ''}` : '자격증명 없음'} · {item.sessionPolicy || '6시간 체크 · 2시간 무활동 재확인'}
                </p>
                {item.runnerReason && (
                  <p style={{ fontSize: 10, color: COLORS.warning, marginTop: 4, lineHeight: 1.45 }}>{item.runnerReason}</p>
                )}
              </div>
              <button type="button" onClick={() => onRemove(item.id)} style={{
                height: 28,
                padding: '0 9px',
                borderRadius: 7,
                border: 'none',
                background: '#fef2f2',
                color: COLORS.danger,
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
              }}>
                삭제
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6, marginBottom: 10 }}>
              <button type="button" onClick={() => onCreateProfile(item)} style={smallButtonStyle}>Runner 준비</button>
              <button type="button" onClick={() => onCheckSession(item)} style={smallButtonStyle}>세션 체크</button>
              <button type="button" onClick={() => onOpenLogin(item)} style={smallButtonStyle}>인증 창 열기</button>
              <button type="button" onClick={() => onMarkChecked(item)} style={{ ...smallButtonStyle, background: COLORS.success, color: 'white', borderColor: COLORS.success }}>
                인증 완료 저장
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
              <input
                value={usernameValue}
                onChange={(e) => onDraftChange(item.id, { username: e.target.value })}
                placeholder="로그인 ID"
                style={{ ...inputStyle, marginBottom: 0, height: 34 }}
              />
              <input
                type="password"
                value={draft.password || ''}
                onChange={(e) => onDraftChange(item.id, { password: e.target.value })}
                placeholder="비밀번호, Runner에만 저장"
                style={{ ...inputStyle, marginBottom: 0, height: 34 }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: 6, marginTop: 6 }}>
              <button type="button" onClick={() => onSaveCredential(item)} style={{ ...smallButtonStyle, background: COLORS.primary, color: 'white', borderColor: COLORS.primary }}>자격증명 저장</button>
              <button type="button" onClick={() => onVerifyCredential(item)} style={smallButtonStyle}>저장 확인</button>
              <button type="button" onClick={() => onDeleteCredential(item)} style={{ ...smallButtonStyle, color: COLORS.danger }}>자격증명 삭제</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingList({ items, onRemove, meta }) {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {items.length === 0 ? (
        <div style={{ padding: 16, border: `1px dashed ${COLORS.border}`, borderRadius: 9, color: COLORS.textMuted, fontSize: 12, textAlign: 'center' }}>
          아직 등록된 항목이 없습니다.
        </div>
      ) : items.map((item) => (
        <div key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, border: `1px solid ${COLORS.border}`, borderRadius: 9 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 850, color: COLORS.textPrimary }}>{item.label}</p>
            <p style={{ fontSize: 10, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta(item)}</p>
          </div>
          <button type="button" onClick={() => onRemove(item.id)} style={{
            height: 28,
            padding: '0 9px',
            borderRadius: 7,
            border: 'none',
            background: '#fef2f2',
            color: COLORS.danger,
            fontSize: 11,
            fontWeight: 800,
            cursor: 'pointer',
          }}>
            삭제
          </button>
        </div>
      ))}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  height: 38,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: '0 11px',
  fontSize: 12,
  outline: 'none',
  marginBottom: 8,
  background: 'white',
};

const primaryButtonStyle = {
  width: '100%',
  height: 38,
  border: 'none',
  borderRadius: 8,
  background: COLORS.primary,
  color: 'white',
  fontSize: 12,
  fontWeight: 850,
  cursor: 'pointer',
};

const smallButtonStyle = {
  height: 30,
  borderRadius: 7,
  border: `1px solid ${COLORS.border}`,
  background: 'white',
  color: COLORS.textSecondary,
  fontSize: 10,
  fontWeight: 850,
  cursor: 'pointer',
};

/* ────────────────────── Main App ────────────────────── */

function toDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function loadLocalOpsAccounts() {
  const settings = loadLocalOpsSettings();
  return Array.isArray(settings.accounts) ? settings.accounts : [];
}

function loadLocalOpsSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('naviwrite.opsSettings') || '{}') || {};
    return saved;
  } catch {
    return {};
  }
}

function PublishQueuePanel() {
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [accounts, setAccounts] = useState(() => loadLocalOpsAccounts());
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState(null);
  const [message, setMessage] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    const res = await safeFetch(`${API}/publish-queue?limit=160`);
    setLoading(false);
    if (Array.isArray(res)) {
      setJobs(res);
      setDrafts((prev) => {
        const next = { ...prev };
        res.forEach((job) => {
          if (!next[job.id]) {
            next[job.id] = {
              publishMode: job.publish_mode || 'draft',
              scheduledAt: toDatetimeLocal(job.scheduled_at),
              publishAccountId: job.publish_account_id || '',
              publishAccountLabel: job.publish_account_label || '',
              publishAccountPlatform: job.publish_account_platform || job.platform || 'blog',
              actionDelayMinutes: Math.max(1, Math.round(Number(job.action_delay_max_seconds || job.action_delay_min_seconds || 60) / 60)),
              betweenPostsDelayMinutes: job.between_posts_delay_minutes || 120,
              rssUrl: job.rss_url || '',
              publishedUrl: job.published_url || '',
            };
          }
        });
        return next;
      });
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const updateDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  };

  const accountForJob = (job) => {
    const draft = drafts[job.id] || {};
    return accounts.find((item) => item.id === draft.publishAccountId);
  };

  const runnerBaseUrl = () => (loadLocalOpsSettings().runnerUrl || 'http://127.0.0.1:39271').replace(/\/$/, '');

  const absoluteApiBase = () => new URL(API, window.location.origin).toString().replace(/\/$/, '');

  const runnerJobPayload = (job, draft, account) => ({
    ...job,
    publish_mode: draft.publishMode || job.publish_mode,
    scheduled_at: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : job.scheduled_at,
    publish_account_id: account?.runnerProfileId || account?.id || draft.publishAccountId || job.publish_account_id,
    publish_account_label: account?.label || draft.publishAccountLabel || job.publish_account_label,
    publish_account_platform: account?.platform || draft.publishAccountPlatform || job.publish_account_platform || job.platform,
    action_delay_min_seconds: (Number(draft.actionDelayMinutes) || 1) * 60,
    action_delay_max_seconds: (Number(draft.actionDelayMinutes) || 1) * 60,
    between_posts_delay_minutes: Number(draft.betweenPostsDelayMinutes) || 120,
  });

  const saveQueueSettings = async (job) => {
    const draft = drafts[job.id] || {};
    const account = accounts.find((item) => item.id === draft.publishAccountId);
    setWorkingId(job.id);
    const res = await safeFetch(`${API}/publish-queue/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishMode: draft.publishMode,
        scheduledAt: draft.publishMode === 'scheduled' ? draft.scheduledAt : null,
        publishStatus: draft.publishMode === 'scheduled' ? '예약대기' : draft.publishMode === 'immediate' ? '발행대기' : '초안대기',
        publishAccountId: draft.publishAccountId,
        publishAccountLabel: account?.label || draft.publishAccountLabel || '',
        publishAccountPlatform: account?.platform || draft.publishAccountPlatform || job.platform,
        actionDelayMinSeconds: (Number(draft.actionDelayMinutes) || 1) * 60,
        actionDelayMaxSeconds: (Number(draft.actionDelayMinutes) || 1) * 60,
        betweenPostsDelayMinutes: Number(draft.betweenPostsDelayMinutes) || 120,
        rssUrl: draft.rssUrl,
        publishedUrl: draft.publishedUrl,
      }),
    });
    setWorkingId(null);
    if (res?.job) {
      setMessage(`#${job.id} 발행 설정을 저장했습니다.`);
      await loadQueue();
    } else {
      setMessage(res?.error || '발행 설정 저장에 실패했습니다.');
    }
  };

  const openEditorWithRunner = async (job) => {
    const draft = drafts[job.id] || {};
    const account = accountForJob(job);
    if (!account) {
      setMessage('작성창을 열 계정을 먼저 선택해 주세요.');
      return;
    }
    const profileId = account.runnerProfileId || account.id;
    setWorkingId(job.id);
    const res = await safeFetch(`${runnerBaseUrl()}/publish/open-editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: absoluteApiBase(),
        profileId,
        job: runnerJobPayload(job, draft, account),
      }),
    });
    setWorkingId(null);
    if (res?.ok) {
      setMessage(`#${job.id} 작성창을 열고 제목/본문을 Runner에 준비했습니다${res.prepared?.clipboardReady ? ' · 클립보드 준비됨' : ''}.`);
    } else {
      setMessage(res?.error || 'Runner 작성창 열기에 실패했습니다.');
    }
  };

  const publishWordPressWithRunner = async (job) => {
    const draft = drafts[job.id] || {};
    const account = accountForJob(job);
    if (!account) {
      setMessage('워드프레스 계정을 먼저 선택해 주세요.');
      return;
    }
    if (account.platform !== 'wordpress') {
      setMessage('워드프레스 API 발행은 워드프레스 계정 슬롯에서만 실행할 수 있습니다.');
      return;
    }
    const profileId = account.runnerProfileId || account.id;
    const wordpressStatus = draft.publishMode === 'immediate'
      ? 'publish'
      : draft.publishMode === 'scheduled'
        ? 'future'
        : 'draft';
    setWorkingId(job.id);
    const res = await safeFetch(`${runnerBaseUrl()}/publish/wordpress-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: absoluteApiBase(),
        profileId,
        execute: true,
        wordpressStatus,
        job: runnerJobPayload({ ...job, platform: 'wordpress' }, draft, account),
      }),
    });
    setWorkingId(null);
    if (res?.ok) {
      setMessage(`#${job.id} 워드프레스 ${wordpressStatus === 'publish' ? '발행' : wordpressStatus === 'future' ? '예약' : '초안 저장'} 완료`);
      await loadQueue();
    } else {
      setMessage(res?.error || '워드프레스 API 발행에 실패했습니다.');
    }
  };

  const markPublished = async (job) => {
    const draft = drafts[job.id] || {};
    if (!draft.publishedUrl) {
      setMessage('발행 URL을 먼저 입력해주세요.');
      return;
    }
    setWorkingId(job.id);
    const res = await safeFetch(`${API}/publish-queue/${job.id}/mark-published`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishedUrl: draft.publishedUrl }),
    });
    setWorkingId(null);
    if (res?.job) {
      setMessage(`#${job.id} 발행완료로 저장했습니다.`);
      await loadQueue();
    } else {
      setMessage(res?.error || '발행완료 저장에 실패했습니다.');
    }
  };

  const checkRss = async (job) => {
    const draft = drafts[job.id] || {};
    setWorkingId(job.id);
    const res = await safeFetch(`${API}/publish-queue/${job.id}/rss-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rssUrl: draft.rssUrl }),
    });
    setWorkingId(null);
    if (res?.job) {
      setMessage(res.matched ? `RSS에서 발행 글을 찾았습니다. 점수 ${res.best?.score || 0}` : 'RSS를 확인했지만 강한 매칭은 없었습니다.');
      await loadQueue();
    } else {
      setMessage(res?.error || 'RSS 확인에 실패했습니다.');
    }
  };

  const exportObsidian = async (job) => {
    setWorkingId(job.id);
    const res = await safeFetch(`${API}/publish-queue/${job.id}/obsidian-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultHint: 'NaviWrite Owner Vault' }),
    });
    setWorkingId(null);
    if (res?.markdown) {
      try {
        await navigator.clipboard.writeText(res.markdown);
        setMessage(`#${job.id} 옵시디언 Markdown을 생성하고 클립보드에 복사했습니다.`);
      } catch {
        setMessage(`#${job.id} 옵시디언 Markdown을 생성했습니다. 브라우저 권한 때문에 복사는 실패했습니다.`);
      }
      await loadQueue();
    } else {
      setMessage(res?.error || '옵시디언 내보내기에 실패했습니다.');
    }
  };

  const reloadAccounts = () => {
    setAccounts(loadLocalOpsAccounts());
    setMessage('운영 설정의 계정 슬롯을 다시 읽었습니다.');
  };

  const summary = useMemo(() => ({
    total: jobs.length,
    waiting: jobs.filter((job) => ['자동발행대기', '발행대기', '예약대기'].includes(job.publish_status)).length,
    done: jobs.filter((job) => ['발행완료', 'RSS확인완료'].includes(job.publish_status)).length,
    rss: jobs.filter((job) => job.rss_match_status === 'matched').length,
  }), [jobs]);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={{ ...cardStyle, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 850, color: COLORS.primary, marginBottom: 4 }}>발행 큐</h2>
            <p style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              발행 생성 결과를 실제 발행 단위로 관리합니다. 즉시/예약 발행, 계정 슬롯, 행동 딜레이, RSS 확인, 옵시디언 내보내기를 여기에서 확정합니다.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={reloadAccounts} style={smallButtonStyle}>계정 다시읽기</button>
            <button type="button" onClick={loadQueue} disabled={loading} style={{ ...primaryButtonStyle, width: 'auto', padding: '0 14px', marginBottom: 0 }}>
              {loading ? '불러오는 중' : '새로고침'}
            </button>
          </div>
        </div>
        {message && (
          <p style={{ marginTop: 10, fontSize: 12, fontWeight: 800, color: message.includes('실패') ? COLORS.danger : COLORS.success }}>
            {message}
          </p>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {[
          ['전체 큐', summary.total, COLORS.primary],
          ['발행 대기', summary.waiting, COLORS.warning],
          ['발행 완료', summary.done, COLORS.success],
          ['RSS 확인', summary.rss, COLORS.accent],
        ].map(([label, value, color]) => (
          <div key={label} style={{ ...cardStyle, padding: 16 }}>
            <p style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 700, marginBottom: 6 }}>{label}</p>
            <p style={{ fontSize: 26, color, fontWeight: 900, lineHeight: 1 }}>{value}</p>
          </div>
        ))}
      </div>

      <section style={sectionStyle}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
          <h3 style={{ fontSize: 15, fontWeight: 850, color: COLORS.primary }}>발행 작업 목록</h3>
          <p style={{ marginTop: 4, fontSize: 11, color: COLORS.textSecondary }}>
            기본 딜레이는 액션 사이 1분, 글 사이 120분입니다. Runner/확장프로그램은 이 DB 값을 읽어 순차 실행합니다.
          </p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 20 }}>
              {[1, 2, 3].map((item) => <Skeleton key={item} height={72} style={{ marginBottom: 8 }} />)}
            </div>
          ) : jobs.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
              아직 발행 큐에 들어온 글이 없습니다. 발행 생성 목록에서 `발행 큐로 보내기`를 눌러주세요.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1380 }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: COLORS.textSecondary, fontSize: 11, textAlign: 'left' }}>
                  {['상태', '제목/키워드', '플랫폼', '글/이미지', '발행 방식', '계정', '딜레이/간격', 'RSS/발행 URL', '작업'].map((head) => (
                    <th key={head} style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` }}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const draft = drafts[job.id] || {};
                  const busy = workingId === job.id;
                  const selectedAccount = accountForJob(job);
                  const canPublishWordPress = selectedAccount?.platform === 'wordpress';
                  return (
                    <tr key={job.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.border}`, verticalAlign: 'top' }}>
                      <td style={{ padding: '12px' }}>
                        <StatusBadge value={job.publish_status || '초안대기'} />
                        <p style={{ marginTop: 6, fontSize: 10, color: COLORS.textMuted }}>#{job.id}</p>
                      </td>
                      <td style={{ padding: '12px', maxWidth: 260 }}>
                        <p style={{ fontWeight: 900, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.title || '-'}</p>
                        <p style={{ marginTop: 3, fontSize: 10, color: COLORS.textMuted }}>{job.keyword || '-'}</p>
                        {job.rss_match_score > 0 && <p style={{ marginTop: 4, fontSize: 10, color: COLORS.accent, fontWeight: 800 }}>RSS 점수 {Number(job.rss_match_score).toFixed(0)}</p>}
                      </td>
                      <td style={{ padding: '12px', color: COLORS.textSecondary, fontWeight: 800 }}>{job.platform || '-'}</td>
                      <td style={{ padding: '12px', color: COLORS.textSecondary }}>
                        <p>{Number(job.char_count || 0).toLocaleString()}자 / KW {job.kw_count || 0}</p>
                        <p style={{ marginTop: 3 }}>이미지 {job.generated_image_count || job.image_count || 0}개</p>
                      </td>
                      <td style={{ padding: '12px', minWidth: 170 }}>
                        <select value={draft.publishMode || 'draft'} onChange={(e) => updateDraft(job.id, { publishMode: e.target.value })} style={{ ...inputStyle, height: 32, marginBottom: 6 }}>
                          <option value="draft">검수 후 발행</option>
                          <option value="immediate">즉시 발행</option>
                          <option value="scheduled">예약 발행</option>
                        </select>
                        <input type="datetime-local" value={draft.scheduledAt || ''} onChange={(e) => updateDraft(job.id, { scheduledAt: e.target.value })} disabled={draft.publishMode !== 'scheduled'} style={{ ...inputStyle, height: 32, marginBottom: 0 }} />
                      </td>
                      <td style={{ padding: '12px', minWidth: 170 }}>
                        <select value={draft.publishAccountId || ''} onChange={(e) => updateDraft(job.id, { publishAccountId: e.target.value })} style={{ ...inputStyle, height: 32, marginBottom: 6 }}>
                          <option value="">계정 선택</option>
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id}>{account.label} · {account.platform}</option>
                          ))}
                        </select>
                        <p style={{ fontSize: 10, color: COLORS.textMuted }}>{job.publish_account_label || '운영 설정에서 계정을 먼저 등록'}</p>
                      </td>
                      <td style={{ padding: '12px', minWidth: 160 }}>
                        <label style={{ display: 'grid', gap: 4, fontSize: 10, color: COLORS.textMuted, fontWeight: 800 }}>
                          액션 딜레이(분)
                          <input type="number" min="1" max="60" value={draft.actionDelayMinutes ?? 1} onChange={(e) => updateDraft(job.id, { actionDelayMinutes: e.target.value })} style={{ ...inputStyle, height: 32, marginBottom: 0 }} />
                        </label>
                        <label style={{ display: 'grid', gap: 4, fontSize: 10, color: COLORS.textMuted, fontWeight: 800, marginTop: 6 }}>
                          글 사이 간격(분)
                          <input type="number" min="1" max="1440" value={draft.betweenPostsDelayMinutes ?? 120} onChange={(e) => updateDraft(job.id, { betweenPostsDelayMinutes: e.target.value })} style={{ ...inputStyle, height: 32, marginBottom: 0 }} />
                        </label>
                      </td>
                      <td style={{ padding: '12px', minWidth: 250 }}>
                        <input value={draft.rssUrl || ''} onChange={(e) => updateDraft(job.id, { rssUrl: e.target.value })} placeholder="RSS URL 또는 블로그 ID" style={{ ...inputStyle, height: 32, marginBottom: 6 }} />
                        <input value={draft.publishedUrl || ''} onChange={(e) => updateDraft(job.id, { publishedUrl: e.target.value })} placeholder="발행 완료 URL" style={{ ...inputStyle, height: 32, marginBottom: 0 }} />
                        {job.published_url && <a href={job.published_url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 5, fontSize: 10 }}>열기</a>}
                      </td>
                      <td style={{ padding: '12px', minWidth: 260 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                          <button type="button" disabled={busy} onClick={() => saveQueueSettings(job)} style={smallButtonStyle}>저장</button>
                          <button type="button" disabled={busy} onClick={() => openEditorWithRunner(job)} style={{ ...smallButtonStyle, background: COLORS.accent, color: 'white', borderColor: COLORS.accent }}>작성창</button>
                          <button
                            type="button"
                            disabled={busy || !canPublishWordPress}
                            onClick={() => publishWordPressWithRunner(job)}
                            style={{
                              ...smallButtonStyle,
                              opacity: canPublishWordPress ? 1 : 0.45,
                              background: canPublishWordPress ? COLORS.success : 'white',
                              color: canPublishWordPress ? 'white' : COLORS.textMuted,
                              borderColor: canPublishWordPress ? COLORS.success : COLORS.border,
                            }}
                          >
                            WP 발행
                          </button>
                          <button type="button" disabled={busy} onClick={() => markPublished(job)} style={smallButtonStyle}>발행완료</button>
                          <button type="button" disabled={busy} onClick={() => checkRss(job)} style={smallButtonStyle}>RSS 확인</button>
                          <button type="button" disabled={busy} onClick={() => exportObsidian(job)} style={{ ...smallButtonStyle, background: COLORS.primary, color: 'white', borderColor: COLORS.primary }}>Obsidian</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

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
  const [guideOpen, setGuideOpen] = useState(false);
  const [activeView, setActiveView] = useState('dashboard');

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

  useEffect(() => {
    if (!guideOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') setGuideOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guideOpen]);

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

      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}

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
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              height: 34, padding: '0 14px', borderRadius: 18,
              border: '1px solid rgba(255,255,255,0.26)',
              background: 'rgba(255,255,255,0.14)', color: 'white',
              fontSize: 12, fontWeight: 800, boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
              whiteSpace: 'nowrap', cursor: 'pointer',
            }}
          >
            사용법
          </button>
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {[
            ['dashboard', '대시보드'],
            ['collect', '수집/감지'],
            ['rewrite', '발행 생성'],
            ['publish', '발행 큐'],
            ['views', '조회수 근황'],
            ['settings', '운영 설정'],
          ].map(([view, label]) => (
            <button
              key={view}
              type="button"
              onClick={() => setActiveView(view)}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 9,
                border: `1px solid ${activeView === view ? COLORS.primary : COLORS.border}`,
                background: activeView === view ? COLORS.primary : 'white',
                color: activeView === view ? 'white' : COLORS.textSecondary,
                fontSize: 12,
                fontWeight: 850,
                cursor: 'pointer',
                boxShadow: activeView === view ? '0 2px 10px rgba(27,58,92,0.18)' : '0 1px 2px rgba(0,0,0,0.04)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {activeView === 'collect' ? (
          <SourceCollectionPanel onOpenRewrite={() => setActiveView('rewrite')} />
        ) : activeView === 'rewrite' ? (
          <RewritePanel />
        ) : activeView === 'publish' ? (
          <PublishQueuePanel />
        ) : activeView === 'views' ? (
          <ViewStatusPanel />
        ) : activeView === 'settings' ? (
          <OperationsSettingsPanel />
        ) : (
          <>

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

          </>
        )}

        {/* ────── Footer ────── */}
        <footer style={{ textAlign: 'center', padding: '24px 0 16px', fontSize: 11, color: COLORS.textMuted }}>
          자동발행 사이트 v1.0.0 · NaviWrite · Powered by Railway
        </footer>
      </div>
    </div>
  );
}
