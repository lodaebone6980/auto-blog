import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

const JOB_STATUSES = new Set([
  '대기중',
  '본문 생성 완료',
  'QR 생성 필요',
  'QR 생성 완료',
  '에디터 삽입 완료',
  '검수 필요',
  '오류',
]);

function makeNaverQrName(keyword, campaignName) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeKeyword = String(keyword || '키워드').trim().replace(/\s+/g, '_');
  const safeCampaign = String(campaignName || '기본').trim().replace(/\s+/g, '_');
  return `${safeKeyword}_${date}_${safeCampaign}`;
}

function normalizeJobInput(body = {}) {
  const scores = body.scores || {};
  const qrStatus = body.qr_status || body.qrStatus || 'QR 생성 필요';
  const generationStatus = body.generation_status || body.generationStatus || '대기중';
  const editorStatus = body.editor_status || body.editorStatus || '검수 필요';

  return {
    keyword: body.keyword || body.targetKeyword,
    category: body.category || 'general',
    platform: body.platform || 'blog',
    source_url: body.source_url || body.sourceUrl || null,
    cta_url: body.cta_url || body.ctaUrl || null,
    qr_target_url: body.qr_target_url || body.qrTargetUrl || body.cta_url || body.ctaUrl || null,
    tone: body.tone || body.toneOption || null,
    campaign_name: body.campaign_name || body.campaignName || null,
    title: body.title || null,
    body: body.body || body.content || null,
    plain_text: body.plain_text || body.plainText || null,
    char_count: body.char_count ?? body.charCount ?? 0,
    kw_count: body.kw_count ?? body.kwCount ?? 0,
    image_count: body.image_count ?? body.imageCount ?? 0,
    seo_score: body.seo_score ?? scores.seo ?? 0,
    geo_score: body.geo_score ?? scores.geo ?? 0,
    aeo_score: body.aeo_score ?? scores.aeo ?? 0,
    total_score: body.total_score ?? scores.total ?? 0,
    naver_qr_name: body.naver_qr_name || body.naverQrName || null,
    naver_qr_image_url: body.naver_qr_image_url || body.naverQrImageUrl || null,
    naver_qr_manage_url: body.naver_qr_manage_url || body.naverQrManageUrl || null,
    qr_status: JOB_STATUSES.has(qrStatus) ? qrStatus : 'QR 생성 필요',
    generation_status: JOB_STATUSES.has(generationStatus) ? generationStatus : '대기중',
    editor_status: JOB_STATUSES.has(editorStatus) ? editorStatus : '검수 필요',
    sheet_row_id: body.sheet_row_id || body.sheetRowId || null,
    sheet_sync_status: body.sheet_sync_status || body.sheetSyncStatus || '대기중',
    notion_url: body.notion_url || body.notionUrl || null,
    error_message: body.error_message || body.errorMessage || null,
  };
}

function jobToSheetPayload(job) {
  return {
    id: job.id,
    keyword: job.keyword,
    category: job.category,
    platform: job.platform,
    title: job.title,
    sourceUrl: job.source_url,
    ctaUrl: job.cta_url,
    qrTargetUrl: job.qr_target_url,
    naverQrName: job.naver_qr_name,
    naverQrImageUrl: job.naver_qr_image_url,
    naverQrManageUrl: job.naver_qr_manage_url,
    qrStatus: job.qr_status,
    generationStatus: job.generation_status,
    editorStatus: job.editor_status,
    sheetSyncStatus: job.sheet_sync_status,
    charCount: job.char_count,
    kwCount: job.kw_count,
    imageCount: job.image_count,
    seoScore: job.seo_score,
    geoScore: job.geo_score,
    aeoScore: job.aeo_score,
    totalScore: job.total_score,
    updatedAt: job.updated_at,
  };
}

async function addJobEvent(jobId, eventType, message, payload = {}) {
  await pool.query(
    `INSERT INTO content_job_events (job_id, event_type, message, payload)
     VALUES ($1, $2, $3, $4)`,
    [jobId, eventType, message, payload]
  );
}

async function syncJobToGoogleSheet(job) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    await pool.query(
      `UPDATE content_jobs
       SET sheet_sync_status = '설정필요',
           updated_at = NOW()
       WHERE id = $1`,
      [job.id]
    );
    await addJobEvent(job.id, 'sheet_sync_skipped', 'Google Sheets webhook URL이 설정되지 않았습니다');
    return { ok: false, skipped: true, status: '설정필요', message: 'GOOGLE_SHEETS_WEBHOOK_URL is not configured' };
  }

  const payload = {
    type: 'content_job_upsert',
    job: jobToSheetPayload(job),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Sheets webhook failed (${response.status}): ${text}`);
    }

    await pool.query(
      `UPDATE content_jobs
       SET sheet_sync_status = '동기화 완료',
           sheet_synced_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [job.id]
    );
    await addJobEvent(job.id, 'sheet_sync', 'Google Sheets 동기화 완료', payload);
    return { ok: true, status: '동기화 완료' };
  } catch (err) {
    await pool.query(
      `UPDATE content_jobs
       SET sheet_sync_status = '오류',
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, err.message]
    );
    await addJobEvent(job.id, 'sheet_sync_error', err.message, payload);
    return { ok: false, status: '오류', message: err.message };
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function pickColumn(row, headers, candidates) {
  for (const name of candidates) {
    const idx = headers.indexOf(name);
    if (idx >= 0) return row[idx]?.trim() || null;
  }
  return null;
}

// --- Post List ---
router.get('/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM tracked_posts ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Create/Update Post ---
router.post('/posts', async (req, res) => {
  try {
    const { url, title, keyword, category, platform, char_count, image_count,
            seo_score, geo_score, aeo_score, total_score } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO tracked_posts (url, title, keyword, category, platform,
        char_count, image_count, seo_score, geo_score, aeo_score, total_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title,
         seo_score = EXCLUDED.seo_score,
         geo_score = EXCLUDED.geo_score,
         aeo_score = EXCLUDED.aeo_score,
         total_score = EXCLUDED.total_score,
         updated_at = NOW()
       RETURNING *`,
      [url, title, keyword, category || 'general', platform || 'blog',
       char_count || 0, image_count || 0,
       seo_score || 0, geo_score || 0, aeo_score || 0, total_score || 0]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Post Detail + Rankings ---
router.get('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const post = await pool.query('SELECT * FROM tracked_posts WHERE id = $1', [id]);
    if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

    const rankings = await pool.query(
      'SELECT * FROM ranking_records WHERE post_id = $1 ORDER BY checked_at DESC LIMIT 30',
      [id]
    );
    const views = await pool.query(
      'SELECT * FROM view_records WHERE post_id = $1 ORDER BY recorded_at DESC LIMIT 30',
      [id]
    );
    const feedbacks = await pool.query(
      'SELECT * FROM feedbacks WHERE post_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({
      ...post.rows[0],
      rankings: rankings.rows,
      views: views.rows,
      feedbacks: feedbacks.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Delete Post ---
router.delete('/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tracked_posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Content Jobs (draft + Naver QR + Google Sheets workflow) ---
router.get('/content-jobs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
    const { status, keyword } = req.query;
    const where = [];
    const values = [];

    if (status) {
      values.push(status);
      where.push(`(generation_status = $${values.length} OR qr_status = $${values.length} OR sheet_sync_status = $${values.length})`);
    }
    if (keyword) {
      values.push(`%${keyword}%`);
      where.push(`keyword ILIKE $${values.length}`);
    }

    values.push(limit);
    const { rows } = await pool.query(
      `SELECT *
       FROM content_jobs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs', async (req, res) => {
  try {
    const job = normalizeJobInput(req.body);
    if (!job.keyword) {
      return res.status(400).json({ error: 'keyword is required' });
    }

    const qrName = job.naver_qr_name || makeNaverQrName(job.keyword, job.campaign_name);
    const generationStatus = job.title || job.body ? '본문 생성 완료' : job.generation_status;

    const { rows } = await pool.query(
      `INSERT INTO content_jobs (
        keyword, category, platform, source_url, cta_url, qr_target_url, tone, campaign_name,
        title, body, plain_text, char_count, kw_count, image_count,
        seo_score, geo_score, aeo_score, total_score,
        naver_qr_name, naver_qr_image_url, naver_qr_manage_url,
        qr_status, generation_status, editor_status, sheet_row_id, sheet_sync_status,
        notion_url, error_message
       )
       VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,
        $19,$20,$21,
        $22,$23,$24,$25,$26,
        $27,$28
       )
       RETURNING *`,
      [
        job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
        job.tone, job.campaign_name, job.title, job.body, job.plain_text,
        job.char_count, job.kw_count, job.image_count,
        job.seo_score, job.geo_score, job.aeo_score, job.total_score,
        qrName, job.naver_qr_image_url, job.naver_qr_manage_url,
        job.qr_status, generationStatus, job.editor_status, job.sheet_row_id,
        job.sheet_sync_status, job.notion_url, job.error_message,
      ]
    );

    await addJobEvent(rows[0].id, 'created', '작업이 등록되었습니다', { source: req.body.source || 'single' });
    const sheetSync = req.body.syncSheet === false ? null : await syncJobToGoogleSheet(rows[0]);
    const updated = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [rows[0].id]);

    res.json({ job: updated.rows[0], sheetSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/content-jobs/:id', async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [req.params.id]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Content job not found' });

    const events = await pool.query(
      'SELECT * FROM content_job_events WHERE job_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ ...job.rows[0], events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/content-jobs/:id', async (req, res) => {
  try {
    const allowed = [
      'keyword', 'category', 'platform', 'source_url', 'cta_url', 'qr_target_url', 'tone',
      'campaign_name', 'title', 'body', 'plain_text', 'char_count', 'kw_count', 'image_count',
      'seo_score', 'geo_score', 'aeo_score', 'total_score', 'naver_qr_name',
      'naver_qr_image_url', 'naver_qr_manage_url', 'qr_status', 'generation_status',
      'editor_status', 'sheet_row_id', 'sheet_sync_status', 'notion_url', 'error_message',
    ];
    const normalized = normalizeJobInput(req.body);
    const aliases = {
      source_url: ['source_url', 'sourceUrl'],
      cta_url: ['cta_url', 'ctaUrl'],
      qr_target_url: ['qr_target_url', 'qrTargetUrl'],
      campaign_name: ['campaign_name', 'campaignName'],
      plain_text: ['plain_text', 'plainText'],
      char_count: ['char_count', 'charCount'],
      kw_count: ['kw_count', 'kwCount'],
      image_count: ['image_count', 'imageCount'],
      seo_score: ['seo_score', 'seoScore', 'scores'],
      geo_score: ['geo_score', 'geoScore', 'scores'],
      aeo_score: ['aeo_score', 'aeoScore', 'scores'],
      total_score: ['total_score', 'totalScore', 'scores'],
      naver_qr_name: ['naver_qr_name', 'naverQrName'],
      naver_qr_image_url: ['naver_qr_image_url', 'naverQrImageUrl'],
      naver_qr_manage_url: ['naver_qr_manage_url', 'naverQrManageUrl'],
      qr_status: ['qr_status', 'qrStatus'],
      generation_status: ['generation_status', 'generationStatus'],
      editor_status: ['editor_status', 'editorStatus'],
      sheet_row_id: ['sheet_row_id', 'sheetRowId'],
      sheet_sync_status: ['sheet_sync_status', 'sheetSyncStatus'],
      notion_url: ['notion_url', 'notionUrl'],
      error_message: ['error_message', 'errorMessage'],
    };
    const values = [];
    const sets = [];

    for (const field of allowed) {
      const names = aliases[field] || [field];
      const hasIncomingField = names.some((name) => Object.prototype.hasOwnProperty.call(req.body, name));
      if (hasIncomingField) {
        if (normalized[field] === undefined) continue;
        values.push(normalized[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }

    if (sets.length === 0) {
      const current = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [req.params.id]);
      if (current.rows.length === 0) return res.status(404).json({ error: 'Content job not found' });
      return res.json(current.rows[0]);
    }

    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Content job not found' });

    await addJobEvent(rows[0].id, 'updated', '작업 정보가 업데이트되었습니다', req.body);
    const sheetSync = req.body.syncSheet === false ? null : await syncJobToGoogleSheet(rows[0]);
    const updated = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [rows[0].id]);
    res.json({ job: updated.rows[0], sheetSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs/:id/qr', async (req, res) => {
  try {
    const { naver_qr_image_url, naver_qr_manage_url, qr_status } = normalizeJobInput({
      ...req.body,
      qr_status: req.body.qr_status || 'QR 생성 완료',
    });

    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET naver_qr_image_url = COALESCE($2, naver_qr_image_url),
           naver_qr_manage_url = COALESCE($3, naver_qr_manage_url),
           qr_status = $4,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, naver_qr_image_url, naver_qr_manage_url, qr_status]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Content job not found' });

    await addJobEvent(rows[0].id, 'qr_saved', '네이버 QR 정보가 저장되었습니다', req.body);
    const sheetSync = req.body.syncSheet === false ? null : await syncJobToGoogleSheet(rows[0]);
    const updated = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [rows[0].id]);
    res.json({ job: updated.rows[0], sheetSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs/:id/sync-sheet', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Content job not found' });
    const sheetSync = await syncJobToGoogleSheet(rows[0]);
    const updated = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [req.params.id]);
    res.json({ job: updated.rows[0], sheetSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs/sheets/pull', async (_req, res) => {
  try {
    const csvUrl = process.env.GOOGLE_SHEETS_CSV_URL;
    if (!csvUrl) {
      return res.status(400).json({ error: 'GOOGLE_SHEETS_CSV_URL is not configured' });
    }

    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error(`Google Sheets CSV fetch failed (${response.status})`);

    const csvText = await response.text();
    const rows = parseCsv(csvText);
    if (rows.length < 2) return res.json({ imported: 0, skipped: 0 });

    const headers = rows[0].map((h) => h.trim());
    let imported = 0;
    let skipped = 0;

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const sheetRowId = pickColumn(row, headers, ['id', 'ID', '행ID']) || String(i + 1);
      const keyword = pickColumn(row, headers, ['keyword', '키워드', '메인키워드']);
      if (!keyword) {
        skipped += 1;
        continue;
      }

      const existing = await pool.query(
        'SELECT id FROM content_jobs WHERE sheet_row_id = $1 LIMIT 1',
        [sheetRowId]
      );
      if (existing.rows.length > 0) {
        skipped += 1;
        continue;
      }

      const job = normalizeJobInput({
        keyword,
        category: pickColumn(row, headers, ['category', '카테고리']) || 'general',
        platform: pickColumn(row, headers, ['platform', '플랫폼']) || 'blog',
        source_url: pickColumn(row, headers, ['source_url', '참고URL', '원본URL']),
        cta_url: pickColumn(row, headers, ['cta_url', 'CTA링크', '링크']),
        qr_target_url: pickColumn(row, headers, ['qr_target_url', 'QR링크', 'QR연결링크']),
        campaign_name: pickColumn(row, headers, ['campaign_name', '캠페인명']),
        tone: pickColumn(row, headers, ['tone', '톤', '어체']),
        sheet_row_id: sheetRowId,
        source: 'google_sheet',
        syncSheet: false,
      });

      const qrName = makeNaverQrName(job.keyword, job.campaign_name);
      const created = await pool.query(
        `INSERT INTO content_jobs (
          keyword, category, platform, source_url, cta_url, qr_target_url,
          tone, campaign_name, naver_qr_name, sheet_row_id, sheet_sync_status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'시트에서 가져옴')
        RETURNING *`,
        [
          job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
          job.tone, job.campaign_name, qrName, sheetRowId,
        ]
      );
      await addJobEvent(created.rows[0].id, 'sheet_import', 'Google Sheets 행을 작업으로 가져왔습니다', { sheetRowId });
      imported += 1;
    }

    res.json({ imported, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs/:id/notion-export', async (req, res) => {
  try {
    const notionUrl = req.body.notion_url || req.body.notionUrl || null;
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET notion_url = COALESCE($2, notion_url),
           notion_exported_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, notionUrl]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Content job not found' });
    await addJobEvent(rows[0].id, 'notion_export', 'Notion 수동 내보내기 상태가 저장되었습니다', req.body);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add Ranking Record ---
router.post('/rankings', async (req, res) => {
  try {
    const { post_id, keyword, position, page, search_type } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO ranking_records (post_id, keyword, position, page, search_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [post_id, keyword, position, page || 1, search_type || 'blog']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add View Record ---
router.post('/views', async (req, res) => {
  try {
    const { post_id, views } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO view_records (post_id, views) VALUES ($1,$2) RETURNING *',
      [post_id, views]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard Stats ---
router.get('/stats', async (req, res) => {
  try {
    const totalPosts = await pool.query('SELECT COUNT(*) FROM tracked_posts');
    const avgScore = await pool.query('SELECT AVG(total_score) as avg FROM tracked_posts');
    const recentRankings = await pool.query(
      `SELECT r.*, t.title, t.keyword
       FROM ranking_records r
       JOIN tracked_posts t ON r.post_id = t.id
       ORDER BY r.checked_at DESC LIMIT 10`
    );
    const pendingFeedbacks = await pool.query(
      'SELECT COUNT(*) FROM feedbacks WHERE applied = FALSE'
    );
    const contentJobs = await pool.query('SELECT COUNT(*) FROM content_jobs');
    const qrReady = await pool.query("SELECT COUNT(*) FROM content_jobs WHERE qr_status = 'QR 생성 완료'");
    const qrNeeded = await pool.query("SELECT COUNT(*) FROM content_jobs WHERE qr_status = 'QR 생성 필요'");
    const sheetErrors = await pool.query("SELECT COUNT(*) FROM content_jobs WHERE sheet_sync_status = '오류'");

    res.json({
      totalPosts: parseInt(totalPosts.rows[0].count),
      avgScore: parseFloat(avgScore.rows[0].avg || 0).toFixed(1),
      recentRankings: recentRankings.rows,
      pendingFeedbacks: parseInt(pendingFeedbacks.rows[0].count),
      contentJobs: parseInt(contentJobs.rows[0].count),
      qrReady: parseInt(qrReady.rows[0].count),
      qrNeeded: parseInt(qrNeeded.rows[0].count),
      sheetErrors: parseInt(sheetErrors.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
