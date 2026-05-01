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
        source_link_id INTEGER,
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
        keyword_candidates JSONB DEFAULT '[]',
        main_keyword TEXT,
        corrected_main_keyword TEXT,
        category_guess TEXT,
        structure_json JSONB DEFAULT '{}',
        tone_summary TEXT,
        blog_name TEXT,
        blog_id TEXT,
        blog_home_url TEXT,
        blog_title TEXT,
        blog_nickname TEXT,
        today_view_count INTEGER,
        total_view_count INTEGER,
        today_view_source TEXT,
        total_view_source TEXT,
        post_view_count INTEGER,
        post_view_source TEXT,
        view_count_checked_at TIMESTAMPTZ,
        quote_blocks JSONB DEFAULT '[]',
        repeated_terms JSONB DEFAULT '[]',
        quote_repeated_terms JSONB DEFAULT '[]',
        fetch_status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Collection batches created from pasted URL lists
      CREATE TABLE IF NOT EXISTS collection_batches (
        id SERIAL PRIMARY KEY,
        name TEXT,
        raw_input TEXT,
        status TEXT DEFAULT '대기중',
        total_count INTEGER DEFAULT 0,
        pending_count INTEGER DEFAULT 0,
        collecting_count INTEGER DEFAULT 0,
        collected_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Individual source links processed by the extension collector
      CREATE TABLE IF NOT EXISTS source_links (
        id SERIAL PRIMARY KEY,
        batch_id INTEGER REFERENCES collection_batches(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        platform_guess TEXT,
        status TEXT DEFAULT '대기중',
        source_analysis_id INTEGER,
        error_message TEXT,
        collected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(batch_id, url)
      );

      -- Collected blogs grouped by category for daily view tracking
      CREATE TABLE IF NOT EXISTS collected_blogs (
        id SERIAL PRIMARY KEY,
        platform TEXT DEFAULT 'blog',
        blog_id TEXT,
        category TEXT DEFAULT 'general',
        blog_name TEXT,
        blog_title TEXT,
        blog_nickname TEXT,
        home_url TEXT,
        latest_source_link_id INTEGER REFERENCES source_links(id) ON DELETE SET NULL,
        latest_source_analysis_id INTEGER REFERENCES source_analyses(id) ON DELETE SET NULL,
        last_today_view_count INTEGER,
        last_total_view_count INTEGER,
        last_daily_view_count INTEGER,
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(platform, blog_id, category)
      );

      -- Daily blog view snapshots. KST date is stored in snapshot_date.
      CREATE TABLE IF NOT EXISTS blog_view_snapshots (
        id SERIAL PRIMARY KEY,
        collected_blog_id INTEGER REFERENCES collected_blogs(id) ON DELETE CASCADE,
        snapshot_date DATE NOT NULL,
        today_view_count INTEGER,
        total_view_count INTEGER,
        previous_total_view_count INTEGER,
        daily_view_count INTEGER,
        source TEXT,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(collected_blog_id, snapshot_date)
      );

      -- Collected Naver Cafe posts for view count monitoring.
      CREATE TABLE IF NOT EXISTS collected_cafe_posts (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        cafe_id TEXT,
        cafe_name TEXT,
        article_id TEXT,
        title TEXT,
        category TEXT DEFAULT 'general',
        latest_source_link_id INTEGER REFERENCES source_links(id) ON DELETE SET NULL,
        latest_source_analysis_id INTEGER REFERENCES source_analyses(id) ON DELETE SET NULL,
        last_view_count INTEGER,
        last_daily_increase INTEGER,
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Daily Naver Cafe post view snapshots. Only rows with 10+ views are actively tracked.
      CREATE TABLE IF NOT EXISTS cafe_post_view_snapshots (
        id SERIAL PRIMARY KEY,
        cafe_post_id INTEGER REFERENCES collected_cafe_posts(id) ON DELETE CASCADE,
        snapshot_date DATE NOT NULL,
        view_count INTEGER,
        previous_view_count INTEGER,
        daily_increase INTEGER,
        source TEXT,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(cafe_post_id, snapshot_date)
      );

      -- Rewrite jobs generated from collected source patterns.
      CREATE TABLE IF NOT EXISTS rewrite_jobs (
        id SERIAL PRIMARY KEY,
        target_keyword TEXT NOT NULL,
        target_topic TEXT,
        platform TEXT DEFAULT 'blog',
        category TEXT DEFAULT 'general',
        cta_url TEXT,
        use_naver_qr BOOLEAN DEFAULT FALSE,
        use_ai_images BOOLEAN DEFAULT FALSE,
        source_analysis_ids JSONB DEFAULT '[]',
        settings_json JSONB DEFAULT '{}',
        status TEXT DEFAULT '대기중',
        pattern_json JSONB DEFAULT '{}',
        title TEXT,
        body TEXT,
        plain_text TEXT,
        char_count INTEGER DEFAULT 0,
        kw_count INTEGER DEFAULT 0,
        image_count INTEGER DEFAULT 0,
        quote_count INTEGER DEFAULT 0,
        seo_score REAL DEFAULT 0,
        geo_score REAL DEFAULT 0,
        aeo_score REAL DEFAULT 0,
        total_score REAL DEFAULT 0,
        similarity_risk REAL DEFAULT 0,
        images_json JSONB DEFAULT '[]',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rewrite_job_events (
        id SERIAL PRIMARY KEY,
        rewrite_job_id INTEGER REFERENCES rewrite_jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        message TEXT,
        payload JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS source_link_id INTEGER;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS keyword_candidates JSONB DEFAULT '[]';
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS main_keyword TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS corrected_main_keyword TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS category_guess TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS structure_json JSONB DEFAULT '{}';
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS tone_summary TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS blog_name TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS blog_id TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS blog_home_url TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS blog_title TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS blog_nickname TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS today_view_count INTEGER;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS total_view_count INTEGER;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS today_view_source TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS total_view_source TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS post_view_count INTEGER;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS post_view_source TEXT;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS view_count_checked_at TIMESTAMPTZ;
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS quote_blocks JSONB DEFAULT '[]';
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS repeated_terms JSONB DEFAULT '[]';
      ALTER TABLE source_analyses ADD COLUMN IF NOT EXISTS quote_repeated_terms JSONB DEFAULT '[]';
      ALTER TABLE rewrite_jobs ADD COLUMN IF NOT EXISTS settings_json JSONB DEFAULT '{}';

      -- Collapse previously duplicated blog rows before adding the one-blog constraint.
      WITH duplicate_blogs AS (
        SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY platform, blog_id
                   ORDER BY updated_at DESC NULLS LAST, id DESC
                 ) AS row_no
          FROM collected_blogs
          WHERE blog_id IS NOT NULL
        ) ranked
        WHERE row_no > 1
      )
      DELETE FROM blog_view_snapshots bvs
      USING duplicate_blogs db
      WHERE bvs.collected_blog_id = db.id;

      WITH duplicate_blogs AS (
        SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY platform, blog_id
                   ORDER BY updated_at DESC NULLS LAST, id DESC
                 ) AS row_no
          FROM collected_blogs
          WHERE blog_id IS NOT NULL
        ) ranked
        WHERE row_no > 1
      )
      DELETE FROM collected_blogs cb
      USING duplicate_blogs db
      WHERE cb.id = db.id;

      -- Keep one queue row per exact source URL so the same article is not learned twice.
      WITH duplicate_links AS (
        SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY url
                   ORDER BY collected_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
                 ) AS row_no
          FROM source_links
        ) ranked
        WHERE row_no > 1
      )
      DELETE FROM source_links sl
      USING duplicate_links dl
      WHERE sl.id = dl.id;

      WITH counts AS (
        SELECT
          cb.id AS batch_id,
          COUNT(sl.id)::int AS total_count,
          COUNT(*) FILTER (WHERE sl.status = '대기중')::int AS pending_count,
          COUNT(*) FILTER (WHERE sl.status = '수집중')::int AS collecting_count,
          COUNT(*) FILTER (WHERE sl.status = '수집완료')::int AS collected_count,
          COUNT(*) FILTER (WHERE sl.status = '오류')::int AS failed_count
        FROM collection_batches cb
        LEFT JOIN source_links sl ON sl.batch_id = cb.id
        GROUP BY cb.id
      )
      UPDATE collection_batches cb
      SET total_count = counts.total_count,
          pending_count = counts.pending_count,
          collecting_count = counts.collecting_count,
          collected_count = counts.collected_count,
          failed_count = counts.failed_count,
          status = CASE
            WHEN counts.total_count = counts.collected_count + counts.failed_count THEN '완료'
            WHEN counts.collecting_count > 0 THEN '수집중'
            ELSE '대기중'
          END,
          updated_at = NOW()
      FROM counts
      WHERE cb.id = counts.batch_id;

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
      CREATE INDEX IF NOT EXISTS idx_source_analyses_source_link_id ON source_analyses(source_link_id);
      CREATE INDEX IF NOT EXISTS idx_collection_batches_created_at ON collection_batches(created_at);
      CREATE INDEX IF NOT EXISTS idx_source_links_batch_id ON source_links(batch_id);
      CREATE INDEX IF NOT EXISTS idx_source_links_status ON source_links(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_source_links_url_unique ON source_links(url);
      CREATE INDEX IF NOT EXISTS idx_collected_blogs_category ON collected_blogs(category);
      CREATE INDEX IF NOT EXISTS idx_collected_blogs_blog_id ON collected_blogs(blog_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collected_blogs_platform_blog_id_unique ON collected_blogs(platform, blog_id);
      CREATE INDEX IF NOT EXISTS idx_blog_view_snapshots_blog_date ON blog_view_snapshots(collected_blog_id, snapshot_date DESC);
      CREATE INDEX IF NOT EXISTS idx_collected_cafe_posts_category ON collected_cafe_posts(category);
      CREATE INDEX IF NOT EXISTS idx_collected_cafe_posts_last_view ON collected_cafe_posts(last_view_count DESC);
      CREATE INDEX IF NOT EXISTS idx_cafe_post_view_snapshots_post_date ON cafe_post_view_snapshots(cafe_post_id, snapshot_date DESC);
      CREATE INDEX IF NOT EXISTS idx_rewrite_jobs_created_at ON rewrite_jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rewrite_jobs_status ON rewrite_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_rewrite_jobs_keyword ON rewrite_jobs(target_keyword);
      CREATE INDEX IF NOT EXISTS idx_rewrite_job_events_job_id ON rewrite_job_events(rewrite_job_id);
    `);
    console.log('[DB] Tables initialized successfully');
  } finally {
    client.release();
  }
}

export default pool;
