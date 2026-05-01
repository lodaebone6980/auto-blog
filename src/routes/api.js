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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(text = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return String(text)
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === '#') {
        const isHex = entity[1]?.toLowerCase() === 'x';
        const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      return named[entity.toLowerCase()] || '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

function pickMetaContent(html, property) {
  const safeProperty = escapeRegExp(property);
  const meta = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${safeProperty}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'));
  return meta ? decodeHtmlEntities(meta[1]) : '';
}

function extractTitle(html, fallback = '') {
  const ogTitle = pickMetaContent(html, 'og:title');
  if (ogTitle) return ogTitle;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripHtml(title[1]) : fallback;
}

function extractHeadings(html) {
  return [...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean)
    .slice(0, 20);
}

function extractLinks(html) {
  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((href) => href && !href.startsWith('#') && !href.startsWith('javascript:'))
    .slice(0, 40);
}

function guessPlatform(sourceUrl, fallback = 'blog') {
  if (!sourceUrl) return fallback;
  if (/cafe\.naver\.com/i.test(sourceUrl)) return 'cafe';
  if (/blog\.naver\.com|m\.blog\.naver\.com/i.test(sourceUrl)) return 'blog';
  if (/brunch\.co\.kr/i.test(sourceUrl)) return 'brunch';
  if (/contents\.premium\.naver\.com/i.test(sourceUrl)) return 'premium';
  return fallback || 'web';
}

function normalizePlatform(value, sourceUrl) {
  const guessed = guessPlatform(sourceUrl, 'web');
  const allowed = new Set(['blog', 'cafe', 'premium', 'brunch', 'web']);
  return allowed.has(value) ? value : guessed;
}

function parseUrlsFromInput(input = '') {
  const seen = new Set();
  return String(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((line) => /^https?:\/\//i.test(line))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function tokenizeKoreanText(text = '') {
  const stopwords = new Set([
    '그리고', '하지만', '그래서', '이번', '오늘', '정리', '확인', '방법', '정보', '내용',
    '정도', '경우', '부분', '바로', '아래', '위해', '대한', '있는', '없는', '하면',
    '합니다', '했습니다', '됩니다', '있습니다', '있어요', '때문', '이후', '관련',
    '네이버', '블로그', '카페', '브런치', '프리미엄', '콘텐츠',
  ]);

  return String(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .match(/[가-힣A-Za-z0-9][가-힣A-Za-z0-9.+#/-]{1,}/g)?.map((token) => token.trim())
    .filter((token) => {
      if (token.length < 2 || token.length > 24) return false;
      if (/^\d+$/.test(token)) return false;
      if (stopwords.has(token)) return false;
      return true;
    }) || [];
}

function inferKeywordCandidates({ title = '', text = '', subheadings = [] }) {
  const source = [title, subheadings.join(' '), text].join(' ');
  const tokens = tokenizeKoreanText(source);
  const scores = new Map();
  const counts = new Map();

  for (let size = 1; size <= 3; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const phrase = tokens.slice(i, i + size).join(' ');
      if (phrase.replace(/\s/g, '').length < 2 || phrase.length > 30) continue;
      const base = size === 1 ? 1 : size === 2 ? 2.4 : 3;
      const titleBoost = title.includes(phrase) ? 7 : 0;
      const headingBoost = subheadings.some((heading) => heading.includes(phrase)) ? 4 : 0;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
      scores.set(phrase, (scores.get(phrase) || 0) + base + titleBoost + headingBoost);
    }
  }

  return [...scores.entries()]
    .map(([keyword, score]) => ({ keyword, score: Number(score.toFixed(2)), count: counts.get(keyword) || 0 }))
    .filter((item) => item.count >= 2 || title.includes(item.keyword))
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 10);
}

function guessCategoryFromText(text = '', title = '') {
  const source = `${title} ${text}`.toLowerCase();
  const banks = [
    ['IT/테크', ['테스트', '앱', '사이트', '링크', 'ai', '스마트폰', '프로그램', '검사', '유형']],
    ['맛집', ['맛집', '메뉴', '가격', '식당', '카페', '예약', '후기']],
    ['여행', ['여행', '숙소', '일정', '항공', '호텔', '코스', '관광']],
    ['건강/의료', ['병원', '증상', '건강', '치료', '검진', '의료', '질환']],
    ['재테크/금융', ['금리', '대출', '주식', '코인', '투자', '은행', '보험']],
    ['육아/육품', ['육아', '아이', '아기', '유아', '장난감', '어린이']],
    ['부동산', ['아파트', '분양', '임대', '전세', '매매', '청약', '부동산']],
    ['정부정책', ['지원금', '신청', '지급', '대상', '정부', '정책', '복지']],
  ];

  let best = { category: 'IT/테크', score: 0 };
  for (const [category, words] of banks) {
    const score = words.reduce((sum, word) => sum + (source.includes(word.toLowerCase()) ? 1 : 0), 0);
    if (score > best.score) best = { category, score };
  }
  return best.category;
}

function summarizeStructure({ text = '', subheadings = [], links = [], imageCount = 0, hasVideo = false }) {
  const paragraphs = String(text).split(/\n{2,}|[.!?。]\s+/).map((p) => p.trim()).filter(Boolean);
  return {
    paragraphCount: paragraphs.length,
    avgParagraphLength: paragraphs.length
      ? Math.round(paragraphs.reduce((sum, p) => sum + p.length, 0) / paragraphs.length)
      : 0,
    headingCount: subheadings.length,
    headings: subheadings.slice(0, 12),
    linkCount: links.length,
    imageCount,
    hasVideo,
    introPreview: String(text).trim().slice(0, 180),
  };
}

function summarizeTone(text = '') {
  const source = String(text);
  const polite = (source.match(/습니다|합니다|하세요|드립니다/g) || []).length;
  const casual = (source.match(/해요|이에요|죠|거예요|네요/g) || []).length;
  if (polite >= casual * 1.4) return '정보형 존댓말';
  if (casual > polite) return '경험담형 부드러운 말투';
  return '설명형 혼합 톤';
}

async function refreshCollectionBatchCounts(batchId) {
  if (!batchId) return null;
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_count,
       COUNT(*) FILTER (WHERE status = '대기중')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = '수집중')::int AS collecting_count,
       COUNT(*) FILTER (WHERE status = '수집완료')::int AS collected_count,
       COUNT(*) FILTER (WHERE status = '오류')::int AS failed_count
     FROM source_links
     WHERE batch_id = $1`,
    [batchId]
  );
  const counts = rows[0];
  const status =
    counts.total_count === counts.collected_count + counts.failed_count
      ? '완료'
      : counts.collecting_count > 0
        ? '수집중'
        : '대기중';
  const updated = await pool.query(
    `UPDATE collection_batches
     SET total_count = $2,
         pending_count = $3,
         collecting_count = $4,
         collected_count = $5,
         failed_count = $6,
         status = $7,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      batchId,
      counts.total_count,
      counts.pending_count,
      counts.collecting_count,
      counts.collected_count,
      counts.failed_count,
      status,
    ]
  );
  return updated.rows[0] || null;
}

async function fetchSourceHtml(sourceUrl) {
  const url = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('http/https URL만 분석할 수 있습니다');
  }

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NaviWrite/1.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`원문 URL 응답 오류 (${response.status})`);
  }

  let html = await response.text();
  const frameMatch = html.match(/<iframe[^>]+(?:id|name)=["']mainFrame["'][^>]+src=["']([^"']+)["']/i);
  if (frameMatch) {
    const frameUrl = new URL(frameMatch[1], url).toString();
    const frameResponse = await fetch(frameUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NaviWrite/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
      },
      redirect: 'follow',
    });
    if (frameResponse.ok) html = await frameResponse.text();
  }

  return html.slice(0, 1_500_000);
}

function buildSourceAnalysis({ sourceUrl, sourceText, html, keyword, category, platform, fetchStatus, errorMessage }) {
  const title = html ? extractTitle(html, sourceUrl || '붙여넣기 원문') : '붙여넣기 원문';
  const plainText = sourceText ? decodeHtmlEntities(sourceText) : stripHtml(html || '');
  const compactText = plainText.replace(/\s/g, '');
  const imageCount = html ? (html.match(/<img\b/gi) || []).length : 0;
  const subheadings = html ? extractHeadings(html) : [];
  const links = html ? extractLinks(html) : [];
  const keywordCandidates = inferKeywordCandidates({ title, text: plainText, subheadings });
  const mainKeyword = keyword || keywordCandidates[0]?.keyword || '';
  const kwCount = mainKeyword ? (plainText.match(new RegExp(escapeRegExp(mainKeyword), 'gi')) || []).length : 0;
  const categoryGuess = category && category !== 'general' ? category : guessCategoryFromText(plainText, title);
  const structure = summarizeStructure({
    text: plainText,
    subheadings,
    links,
    imageCount,
    hasVideo: html ? /<video\b|youtube\.com|tv\.naver\.com|<iframe\b/i.test(html) : false,
  });

  return {
    sourceUrl: sourceUrl || null,
    sourceTextPreview: plainText.slice(0, 500),
    keyword: mainKeyword,
    category: categoryGuess,
    platform: normalizePlatform(platform, sourceUrl),
    title,
    plainText: plainText.slice(0, 12000),
    charCount: compactText.length,
    kwCount,
    imageCount,
    subheadings,
    links,
    hasVideo: structure.hasVideo,
    platformGuess: guessPlatform(sourceUrl, platform),
    keywordCandidates,
    mainKeyword,
    categoryGuess,
    structure,
    toneSummary: summarizeTone(plainText),
    fetchStatus,
    errorMessage,
  };
}

async function saveCollectionAnalysis(link, analysis, fetchStatus = 'server_collected') {
  const inserted = await pool.query(
    `INSERT INTO source_analyses (
      source_link_id, source_url, source_text_preview, keyword, category, platform, title,
      plain_text, char_count, kw_count, image_count, subheadings, links, has_video,
      platform_guess, keyword_candidates, main_keyword, category_guess, structure_json,
      tone_summary, fetch_status, error_message
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [
      link.id,
      analysis.sourceUrl || link.url,
      analysis.sourceTextPreview,
      analysis.keyword,
      analysis.category,
      analysis.platform,
      analysis.title,
      analysis.plainText,
      analysis.charCount,
      analysis.kwCount,
      analysis.imageCount,
      JSON.stringify(analysis.subheadings || []),
      JSON.stringify(analysis.links || []),
      analysis.hasVideo,
      analysis.platformGuess,
      JSON.stringify(analysis.keywordCandidates || []),
      analysis.mainKeyword,
      analysis.categoryGuess,
      JSON.stringify(analysis.structure || {}),
      analysis.toneSummary,
      fetchStatus,
      analysis.errorMessage || null,
    ]
  );

  const saved = inserted.rows[0];
  const updated = await pool.query(
    `UPDATE source_links
     SET status = '수집완료',
         platform_guess = $2,
         source_analysis_id = $3,
         collected_at = NOW(),
         updated_at = NOW(),
         error_message = NULL
     WHERE id = $1
     RETURNING *`,
    [link.id, analysis.platformGuess, saved.id]
  );
  const batch = await refreshCollectionBatchCounts(link.batch_id);

  return {
    link: updated.rows[0],
    batch,
    analysis: {
      id: saved.id,
      sourceUrl: saved.source_url,
      title: saved.title,
      mainKeyword: saved.main_keyword,
      categoryGuess: saved.category_guess,
      platformGuess: saved.platform_guess,
      charCount: saved.char_count,
      kwCount: saved.kw_count,
      imageCount: saved.image_count,
      subheadings: saved.subheadings || [],
      keywordCandidates: saved.keyword_candidates || [],
      structure: saved.structure_json || {},
      toneSummary: saved.tone_summary,
    },
  };
}

async function collectSourceLinkOnServer(link) {
  await pool.query(
    `UPDATE source_links
     SET status = '수집중',
         error_message = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [link.id]
  );
  await refreshCollectionBatchCounts(link.batch_id);

  try {
    const html = await fetchSourceHtml(link.url);
    const analysis = buildSourceAnalysis({
      sourceUrl: link.url,
      html,
      platform: link.platform_guess || guessPlatform(link.url, 'web'),
      fetchStatus: 'server_collected',
      errorMessage: null,
    });

    if (!analysis.plainText || analysis.plainText.replace(/\s/g, '').length < 80) {
      throw new Error('본문을 충분히 읽지 못했습니다. 로그인/비공개/차단 페이지일 수 있습니다.');
    }

    return await saveCollectionAnalysis(link, analysis, 'server_collected');
  } catch (err) {
    const failed = await pool.query(
      `UPDATE source_links
       SET status = '오류',
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [link.id, err.message]
    );
    await refreshCollectionBatchCounts(link.batch_id);
    return {
      link: failed.rows[0] || link,
      error: err.message,
    };
  }
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
    source_analysis_id: body.source_analysis_id || body.sourceAnalysisId || null,
    publish_account_id: body.publish_account_id || body.publishAccountId || null,
    publish_account_label: body.publish_account_label || body.publishAccountLabel || null,
    learning_status: body.learning_status || body.learningStatus || '학습 필요',
    login_status: body.login_status || body.loginStatus || '계정 확인 필요',
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
    sourceAnalysisId: job.source_analysis_id,
    publishAccountId: job.publish_account_id,
    publishAccountLabel: job.publish_account_label,
    learningStatus: job.learning_status,
    loginStatus: job.login_status,
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

// --- Source URL/Text Learning ---
router.post('/content-jobs/source/analyze', async (req, res) => {
  const { sourceUrl, sourceText, keyword, category = 'general', platform = 'blog' } = req.body || {};

  if (!sourceUrl && !sourceText) {
    return res.status(400).json({ error: 'sourceUrl or sourceText is required' });
  }

  let html = '';
  let fetchStatus = sourceText ? 'text_provided' : 'fetched';
  let errorMessage = null;

  try {
    if (sourceUrl) {
      html = await fetchSourceHtml(sourceUrl);
    }
  } catch (err) {
    fetchStatus = 'fetch_failed';
    errorMessage = err.message;
  }

  const analysis = buildSourceAnalysis({
    sourceUrl,
    sourceText,
    html,
    keyword,
    category,
    platform,
    fetchStatus,
    errorMessage,
  });

  try {
    const { rows } = await pool.query(
      `INSERT INTO source_analyses (
        source_url, source_text_preview, keyword, category, platform, title, plain_text,
        char_count, kw_count, image_count, subheadings, links, has_video,
        platform_guess, keyword_candidates, main_keyword, category_guess, structure_json,
        tone_summary, fetch_status, error_message
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        analysis.sourceUrl,
        analysis.sourceTextPreview,
        analysis.keyword,
        analysis.category,
        analysis.platform,
        analysis.title,
        analysis.plainText,
        analysis.charCount,
        analysis.kwCount,
        analysis.imageCount,
        JSON.stringify(analysis.subheadings),
        JSON.stringify(analysis.links),
        analysis.hasVideo,
        analysis.platformGuess,
        JSON.stringify(analysis.keywordCandidates),
        analysis.mainKeyword,
        analysis.categoryGuess,
        JSON.stringify(analysis.structure),
        analysis.toneSummary,
        analysis.fetchStatus,
        analysis.errorMessage,
      ]
    );

    res.json({
      analysis: {
        id: rows[0].id,
        sourceUrl: rows[0].source_url,
        keyword: rows[0].keyword,
        category: rows[0].category,
        platform: rows[0].platform,
        title: rows[0].title,
        plainText: rows[0].plain_text,
        charCount: rows[0].char_count,
        kwCount: rows[0].kw_count,
        imageCount: rows[0].image_count,
        subheadings: rows[0].subheadings || [],
        links: rows[0].links || [],
        hasVideo: rows[0].has_video,
        platformGuess: rows[0].platform_guess,
        keywordCandidates: rows[0].keyword_candidates || [],
        mainKeyword: rows[0].main_keyword,
        categoryGuess: rows[0].category_guess,
        structure: rows[0].structure_json || {},
        toneSummary: rows[0].tone_summary,
        fetchStatus: rows[0].fetch_status,
        errorMessage: rows[0].error_message,
        createdAt: rows[0].created_at,
      },
      recommendations: {
        nextStep: '발행 계정과 채널을 확인한 뒤 글 생성을 진행하세요.',
        qrPosition: '도입 CTA 이후 또는 2번째 섹션 뒤',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Collection batches and extension queue ---
router.get('/collections/batches', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const { rows } = await pool.query(
      `SELECT *
       FROM collection_batches
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/collections/batches', async (req, res) => {
  try {
    const rawInput = req.body?.urlsText || req.body?.rawInput || '';
    const links = Array.isArray(req.body?.links) ? req.body.links : parseUrlsFromInput(rawInput);
    const uniqueLinks = [...new Set(links.map((url) => String(url).trim()).filter((url) => /^https?:\/\//i.test(url)))];

    if (uniqueLinks.length === 0) {
      return res.status(400).json({ error: '등록할 URL이 없습니다' });
    }

    const batch = await pool.query(
      `INSERT INTO collection_batches (name, raw_input, total_count, pending_count, status)
       VALUES ($1,$2,$3,$3,'대기중')
       RETURNING *`,
      [req.body?.name || `수집 배치 ${new Date().toLocaleString('ko-KR')}`, rawInput || uniqueLinks.join('\n'), uniqueLinks.length]
    );

    let inserted = 0;
    for (const url of uniqueLinks) {
      const result = await pool.query(
        `INSERT INTO source_links (batch_id, url, platform_guess, status)
         VALUES ($1,$2,$3,'대기중')
         ON CONFLICT (batch_id, url) DO NOTHING
         RETURNING id`,
        [batch.rows[0].id, url, guessPlatform(url, 'web')]
      );
      inserted += result.rowCount;
    }

    const updatedBatch = await refreshCollectionBatchCounts(batch.rows[0].id);
    res.json({ batch: updatedBatch || batch.rows[0], inserted, skipped: uniqueLinks.length - inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/collections/process-pending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit || req.query.limit || '10', 10), 30);
    const batchId = req.body?.batchId || req.query.batchId || null;
    const values = [];
    const where = [`status IN ('대기중','오류')`];

    if (batchId) {
      values.push(batchId);
      where.push(`batch_id = $${values.length}`);
    }

    values.push(limit);
    const { rows } = await pool.query(
      `SELECT *
       FROM source_links
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC
       LIMIT $${values.length}`,
      values
    );

    const results = [];
    for (const link of rows) {
      results.push(await collectSourceLinkOnServer(link));
    }

    res.json({
      ok: true,
      requested: limit,
      processed: results.length,
      collected: results.filter((item) => !item.error).length,
      failed: results.filter((item) => item.error).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/collections/links', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
    const values = [];
    const where = [];

    if (req.query.status) {
      values.push(req.query.status);
      where.push(`sl.status = $${values.length}`);
    }
    if (req.query.batchId) {
      values.push(req.query.batchId);
      where.push(`sl.batch_id = $${values.length}`);
    }

    values.push(limit);
    const { rows } = await pool.query(
      `SELECT sl.*,
              cb.name AS batch_name,
              sa.main_keyword,
              sa.category_guess,
              sa.char_count,
              sa.kw_count,
              sa.image_count,
              sa.subheadings,
              sa.keyword_candidates
       FROM source_links sl
       LEFT JOIN collection_batches cb ON cb.id = sl.batch_id
       LEFT JOIN source_analyses sa ON sa.id = sl.source_analysis_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sl.created_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/collections/links/:id/claim', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE source_links
       SET status = '수집중',
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('대기중','오류')
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '수집 가능한 링크가 없습니다' });
    await refreshCollectionBatchCounts(rows[0].batch_id);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/collections/links/:id/status', async (req, res) => {
  try {
    const status = req.body?.status || '오류';
    const { rows } = await pool.query(
      `UPDATE source_links
       SET status = $2,
           error_message = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, status, req.body?.errorMessage || req.body?.error_message || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Source link not found' });
    await refreshCollectionBatchCounts(rows[0].batch_id);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/collections/links/:id/analysis', async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM source_links WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Source link not found' });
    const link = current.rows[0];
    const body = req.body || {};
    const text = decodeHtmlEntities(body.text || body.plainText || '');
    const title = body.title || '';
    const subheadings = Array.isArray(body.subheadings) ? body.subheadings.filter(Boolean) : [];
    const links = Array.isArray(body.links) ? body.links.filter(Boolean).slice(0, 80) : [];
    const keywordCandidates = inferKeywordCandidates({ title, text, subheadings });
    const mainKeyword = body.mainKeyword || keywordCandidates[0]?.keyword || '';
    const categoryGuess = body.categoryGuess || guessCategoryFromText(text, title);
    const platformGuess = normalizePlatform(body.platform, link.url);
    const imageCount = Number(body.imageCount || 0);
    const hasVideo = Boolean(body.hasVideo);
    const charCount = Number(body.charCount || text.replace(/\s/g, '').length);
    const kwCount = mainKeyword ? (text.match(new RegExp(escapeRegExp(mainKeyword), 'gi')) || []).length : 0;
    const structure = summarizeStructure({ text, subheadings, links, imageCount, hasVideo });

    const inserted = await pool.query(
      `INSERT INTO source_analyses (
        source_link_id, source_url, source_text_preview, keyword, category, platform, title,
        plain_text, char_count, kw_count, image_count, subheadings, links, has_video,
        platform_guess, keyword_candidates, main_keyword, category_guess, structure_json,
        tone_summary, fetch_status, error_message
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'extension_collected',NULL)
       RETURNING *`,
      [
        link.id,
        body.url || link.url,
        text.slice(0, 500),
        mainKeyword,
        categoryGuess,
        platformGuess,
        title,
        text.slice(0, 12000),
        charCount,
        kwCount,
        imageCount,
        JSON.stringify(subheadings.slice(0, 40)),
        JSON.stringify(links),
        hasVideo,
        platformGuess,
        JSON.stringify(keywordCandidates),
        mainKeyword,
        categoryGuess,
        JSON.stringify(structure),
        summarizeTone(text),
      ]
    );

    const analysis = inserted.rows[0];
    const updated = await pool.query(
      `UPDATE source_links
       SET status = '수집완료',
           platform_guess = $2,
           source_analysis_id = $3,
           collected_at = NOW(),
           updated_at = NOW(),
           error_message = NULL
       WHERE id = $1
       RETURNING *`,
      [link.id, platformGuess, analysis.id]
    );
    const batch = await refreshCollectionBatchCounts(link.batch_id);

    res.json({
      link: updated.rows[0],
      batch,
      analysis: {
        id: analysis.id,
        sourceUrl: analysis.source_url,
        title: analysis.title,
        mainKeyword: analysis.main_keyword,
        categoryGuess: analysis.category_guess,
        platformGuess: analysis.platform_guess,
        charCount: analysis.char_count,
        kwCount: analysis.kw_count,
        imageCount: analysis.image_count,
        subheadings: analysis.subheadings || [],
        keywordCandidates: analysis.keyword_candidates || [],
        structure: analysis.structure_json || {},
        toneSummary: analysis.tone_summary,
      },
    });
  } catch (err) {
    const failed = await pool.query(
      `UPDATE source_links
       SET status = '오류', error_message = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING batch_id`,
      [req.params.id, err.message]
    ).catch(() => ({ rows: [] }));
    if (failed.rows[0]?.batch_id) await refreshCollectionBatchCounts(failed.rows[0].batch_id);
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
        notion_url, error_message, source_analysis_id, publish_account_id,
        publish_account_label, learning_status, login_status
       )
       VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,
        $19,$20,$21,
        $22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,$32,$33
       )
       RETURNING *`,
      [
        job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
        job.tone, job.campaign_name, job.title, job.body, job.plain_text,
        job.char_count, job.kw_count, job.image_count,
        job.seo_score, job.geo_score, job.aeo_score, job.total_score,
        qrName, job.naver_qr_image_url, job.naver_qr_manage_url,
        job.qr_status, generationStatus, job.editor_status, job.sheet_row_id,
        job.sheet_sync_status, job.notion_url, job.error_message, job.source_analysis_id,
        job.publish_account_id, job.publish_account_label, job.learning_status, job.login_status,
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
      'source_analysis_id', 'publish_account_id', 'publish_account_label',
      'learning_status', 'login_status',
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
      source_analysis_id: ['source_analysis_id', 'sourceAnalysisId'],
      publish_account_id: ['publish_account_id', 'publishAccountId'],
      publish_account_label: ['publish_account_label', 'publishAccountLabel'],
      learning_status: ['learning_status', 'learningStatus'],
      login_status: ['login_status', 'loginStatus'],
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
