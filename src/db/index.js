import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] 예기치 않은 에러:', err.message);
});

export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- 추적 포스트
      CREATE TABLE IF NOT EXISTS tracked_posts (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        keyword TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        platform TEXT DEFAULT 'blog',
        char_count INTEGER DEFAULT 0,
        image_count INTEGER DEFAULT 0,
        seo_score REAL DEFAULT 0,
        geo_score REAL DEFAULT 0,
        aeo_score REAL DEFAULT 0,
        total_score REAL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 순위 기록
      CREATE TABLE IF NOT EXISTS ranking_records (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES tracked_posts(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        position INTEGER,
        page INTEGER DEFAULT 1,
        search_type TEXT DEFAULT 'blog',
        checked_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 조회수 기록
      CREATE TABLE IF NOT EXISTS view_records (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES tracked_posts(id) ON DELETE CASCADE,
        views INTEGER DEFAULT 0,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 피드백 (AI 개선 제안)
      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES tracked_posts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        before_text TEXT,
        after_text TEXT,
        applied BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 레퍼런스 (경쟁글 수집)
      CREATE TABLE IF NOT EXISTS references_data (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT,
        keyword TEXT,
        category TEXT,
        char_count INTEGER DEFAULT 0,
        image_count INTEGER DEFAULT 0,
        subheadings JSONB DEFAULT '[]',
        seo_score REAL DEFAULT 0,
        geo_score REAL DEFAULT 0,
        aeo_score REAL DEFAULT 0,
        collected_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 카테고리 패턴 DB (학습 결과)
      CREATE TABLE IF NOT EXISTS pattern_stats (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL UNIQUE,
        sample_count INTEGER DEFAULT 0,
        avg_char_count REAL DEFAULT 0,
        avg_image_count REAL DEFAULT 0,
        avg_kw_repeat REAL DEFAULT 0,
        avg_subheading_count REAL DEFAULT 0,
        top_score REAL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 인덱스
      CREATE INDEX IF NOT EXISTS idx_ranking_post_id ON ranking_records(post_id);
      CREATE INDEX IF NOT EXISTS idx_ranking_checked_at ON ranking_records(checked_at);
      CREATE INDEX IF NOT EXISTS idx_views_post_id ON view_records(post_id);
      CREATE INDEX IF NOT EXISTS idx_feedbacks_post_id ON feedbacks(post_id);
    `);
    console.log('[DB] 테이블 초기화 완료');
  } finally {
    client.release();
  }
}

export default pool;
