import { useState, useEffect } from 'react';

const API = '/api';

function ScoreBar({ label, score, max = 100, color }) {
  const pct = Math.min((score / max) * 100, 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color }}>{score.toFixed(1)}</span>
      </div>
      <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'white', borderRadius: 12, padding: '20px 16px',
      border: '1px solid #e5e7eb', flex: 1, minWidth: 140
    }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || '#1B3A5C' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function App() {
  const [stats, setStats] = useState(null);
  const [posts, setPosts] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      fetch(`${API}/health`).then(r => r.json()),
      fetch(`${API}/stats`).then(r => r.json()),
      fetch(`${API}/posts`).then(r => r.json()),
    ]).then(([h, s, p]) => {
      if (h.status === 'fulfilled') setHealth(h.value);
      if (s.status === 'fulfilled') setStats(s.value);
      if (p.status === 'fulfilled') setPosts(p.value);
      setLoading(false);
    });
  }, []);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      {/* 헤더 */}
      <header style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 40, height: 40, background: 'linear-gradient(135deg, #1B3A5C, #2E75B6)',
            borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 700, fontSize: 18
          }}>A</div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1B3A5C' }}>Auto Blog</h1>
            <p style={{ fontSize: 12, color: '#6b7280' }}>NaviWrite SEO·GEO·AEO Dashboard</p>
          </div>
        </div>

        {health && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: health.status === 'ok' ? '#ecfdf5' : '#fef2f2',
            color: health.status === 'ok' ? '#059669' : '#dc2626',
            padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: health.status === 'ok' ? '#059669' : '#dc2626'
            }} />
            {health.status === 'ok' ? 'Server Online' : 'Server Error'}
          </div>
        )}
      </header>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <p>데이터를 불러오는 중...</p>
        </div>
      ) : (
        <>
          {/* 통계 카드 */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="추적 중인 포스트" value={stats?.totalPosts || 0} color="#1B3A5C" />
            <StatCard label="평균 점수" value={stats?.avgScore || '0.0'} sub="/300점" color="#2E75B6" />
            <StatCard label="대기 피드백" value={stats?.pendingFeedbacks || 0} color="#D4790E" />
          </div>

          {/* 포스트 목록 */}
          <section style={{ background: 'white', borderRadius: 16, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700 }}>추적 포스트</h2>
            </div>

            {posts.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>📝</div>
                <p style={{ fontSize: 14, marginBottom: 4 }}>아직 추적 중인 포스트가 없습니다</p>
                <p style={{ fontSize: 12 }}>NaviWrite 확장프로그램에서 포스트를 등록하세요</p>
              </div>
            ) : (
              <div>
                {posts.map((post) => (
                  <div key={post.id} style={{
                    padding: '14px 20px', borderBottom: '1px solid #f3f4f6',
                    display: 'flex', alignItems: 'center', gap: 16
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{post.title}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {post.keyword} · {post.category} · {post.platform}
                      </div>
                    </div>
                    <div style={{ width: 160 }}>
                      <ScoreBar label="SEO" score={post.seo_score} color="#1B3A5C" />
                      <ScoreBar label="GEO" score={post.geo_score} color="#2E75B6" />
                      <ScoreBar label="AEO" score={post.aeo_score} color="#2E8B57" />
                    </div>
                    <div style={{
                      fontSize: 20, fontWeight: 700,
                      color: post.total_score >= 200 ? '#2E8B57' : post.total_score >= 150 ? '#D4790E' : '#CC0000'
                    }}>
                      {post.total_score.toFixed(0)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* API 정보 */}
          <section style={{
            marginTop: 24, background: 'white', borderRadius: 16,
            border: '1px solid #e5e7eb', padding: 20
          }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>API Endpoints</h2>
            <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace', lineHeight: 2 }}>
              <div><span style={{ color: '#059669', fontWeight: 600 }}>GET</span> /api/health — 서버 상태</div>
              <div><span style={{ color: '#059669', fontWeight: 600 }}>GET</span> /api/stats — 대시보드 통계</div>
              <div><span style={{ color: '#2563eb', fontWeight: 600 }}>POST</span> /api/posts — 포스트 등록</div>
              <div><span style={{ color: '#059669', fontWeight: 600 }}>GET</span> /api/posts — 포스트 목록</div>
              <div><span style={{ color: '#2563eb', fontWeight: 600 }}>POST</span> /api/ai/analyze — AI 분석</div>
              <div><span style={{ color: '#059669', fontWeight: 600 }}>GET</span> /api/track/dashboard — 순위 대시보드</div>
              <div><span style={{ color: '#2563eb', fontWeight: 600 }}>POST</span> /api/pattern/references — 레퍼런스 저장</div>
            </div>
          </section>

          <footer style={{ textAlign: 'center', marginTop: 32, fontSize: 11, color: '#9ca3af' }}>
            Auto Blog v1.0.0 · NaviWrite Backend · Powered by Railway
          </footer>
        </>
      )}
    </div>
  );
}
