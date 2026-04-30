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
  console.error('[DB] Unexpected error:', err.message);
});

export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Tracked Posts
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

      -- Ranking Records
      CREATE TABLE IF NOT EXISTS ranking_records (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES tracked_posts(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        position INTEGER,
        page INTEGER DEFAULT 1,
        search_type TEXT DEFAULT 'blog',
        checked_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- View Records
      CREATE TABLE IF NOT EXISTS view_records (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES tracked_posts(id) ON DELETE CASCADE,
        views INTEGER DEFAULT 0,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Feedbacks (AI improvement suggestions)
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

      -- References (competitor collection)
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

      -- Category Pattern DB (learning results)
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

      -- Source Analysis (URL/text learning before draft generation)
      CREATE TABLE IF NOT EXISTS source_analyses (
        id SERIAL PRIMARY KEY,
        source_url TEXT,
        source_text_preview TEXT,
        keyword TEXT,
        category TEXT,
        platform TEXT DEFAULT 'blog',
        title TEXT,
        plain_text TEXT,
        char_count INTEGER DEFAULT 0,
        kw_count INTEGER DEFAULT 0,
        image_count INTEGER DEFAULT 0,
        subheadings JSONB DEFAULT '[]',
        links JSONB DEFAULT '[]',
        has_video BOOLEAN DEFAULT FALSE,
        platform_guess TEXT,
        fetch_status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Content Jobs (generated drafts + QR + sheet sync)
      CREATE TABLE IF NOT EXISTS content_jobs (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        platform TEXT DEFAULT 'blog',
        source_url TEXT,
        cta_url TEXT,
        qr_target_url TEXT,
        tone TEXT,
        campaign_name TEXT,
        title TEXT,
        body TEXT,
        plain_text TEXT,
        char_count INTEGER DEFAULT 0,
        kw_count INTEGER DEFAULT 0,
        image_count INTEGER DEFAULT 0,
        seo_score REAL DEFAULT 0,
        geo_score REAL DEFAULT 0,
        aeo_score REAL DEFAULT 0,
        total_score REAL DEFAULT 0,
        naver_qr_name TEXT,
        naver_qr_image_url TEXT,
        naver_qr_manage_url TEXT,
        qr_status TEXT DEFAULT 'QR 생성 필요',
        generation_status TEXT DEFAULT '대기중',
        editor_status TEXT DEFAULT '검수 필요',
        sheet_row_id TEXT,
        sheet_sync_status TEXT DEFAULT '대기중',
        sheet_synced_at TIMESTAMPTZ,
        notion_url TEXT,
        notion_exported_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS source_analysis_id INTEGER;
      ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS publish_account_id TEXT;
      ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS publish_account_label TEXT;
      ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS learning_status TEXT DEFAULT '학습 필요';
      ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS login_status TEXT DEFAULT '계정 확인 필요';

      -- Content Job Event Log
      CREATE TABLE IF NOT EXISTS content_job_events (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES content_jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        message TEXT,
        payload JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_ranking_post_id ON ranking_records(post_id);
      CREATE INDEX IF NOT EXISTS idx_ranking_checked_at ON ranking_records(checked_at);
      CREATE INDEX IF NOT EXISTS idx_views_post_id ON view_records(post_id);
      CREATE INDEX IF NOT EXISTS idx_feedbacks_post_id ON feedbacks(post_id);
      CREATE INDEX IF NOT EXISTS idx_content_jobs_created_at ON content_jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_content_jobs_keyword ON content_jobs(keyword);
      CREATE INDEX IF NOT EXISTS idx_content_jobs_qr_status ON content_jobs(qr_status);
      CREATE INDEX IF NOT EXISTS idx_content_jobs_sheet_sync_status ON content_jobs(sheet_sync_status);
      CREATE INDEX IF NOT EXISTS idx_content_job_events_job_id ON content_job_events(job_id);
      CREATE INDEX IF NOT EXISTS idx_source_analyses_created_at ON source_analyses(created_at);
      CREATE INDEX IF NOT EXISTS idx_source_analyses_keyword ON source_analyses(keyword);
    `);
    console.log('[DB] Tables initialized successfully');
  } finally {
    client.release();
  }
}

export default pool;
