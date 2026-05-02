import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

const JOB_STATUSES = new Set([
  '대기중',
  '본문 생성 완료',
  'QR 생성 필요',
  'QR 미사용',
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

function extractElementByClass(html = '', className = '') {
  const classPattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`, 'i');
  const match = classPattern.exec(html);
  if (!match) return '';

  const tagName = match[1].toLowerCase();
  let depth = 0;
  const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = match.index;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html))) {
    const isClose = tagMatch[0].startsWith('</');
    depth += isClose ? -1 : 1;
    if (depth === 0) return html.slice(match.index, tagPattern.lastIndex);
  }
  return html.slice(match.index);
}

function extractNaverBodyHtml(html = '') {
  return extractElementByClass(html, 'se-main-container')
    || extractElementByClass(html, 'post_ct')
    || extractElementByClass(html, 'se_doc_viewer')
    || '';
}

function extractAttribute(html = '', attrName = '') {
  const match = html.match(new RegExp(`${escapeRegExp(attrName)}=["']([^"']+)["']`, 'i'));
  return match ? decodeHtmlEntities(match[1]) : '';
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

function countBodyImages(html = '') {
  const sources = new Set();

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\s(?:src|data-src)=["']([^"']+)["']/i)?.[1];
    if (src && !/blank|spacer|icon|profile|emoticon/i.test(src)) sources.add(src.split('?')[0]);
  }

  for (const match of html.matchAll(/data-linkdata='([^']+)'/gi)) {
    const src = match[1].match(/"src"\s*:\s*"([^"]+)"/i)?.[1];
    if (src) sources.add(src.split('?')[0]);
  }

  const seImageModules = (html.match(/\bse-module-image\b/gi) || []).length;
  return Math.max(sources.size, seImageModules);
}

function extractQuoteBlocks(html = '') {
  const blocks = [];
  for (const match of html.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi)) {
    const text = stripHtml(match[1]);
    if (text) blocks.push(text);
  }

  if (blocks.length === 0) {
    for (const match of html.matchAll(/<div\b[^>]*class=["'][^"']*\bse-quote\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
      const text = stripHtml(match[1]);
      if (text) blocks.push(text);
    }
  }

  return [...new Set(blocks)].slice(0, 30);
}

function inferRepeatedTerms(text = '', minCount = 2) {
  const banned = new Set([
    '있습니다', '합니다', '됩니다', '입니다', '주세요', '같습니다', '했습니다',
    '있는', '없는', '그리고', '하지만', '그래서', '이번', '오늘', '바로',
    '같은', '통해', '아니라', '이런', '저런', '그런', '먼저', '때문에',
    '있고', '것이', '보면', '조금', '정말', '매우', '많이', '여러',
    '대한', '위해', '정도', '경우', '부분', '관련', '실제로', '특히',
  ]);
  const tokens = tokenizeKoreanText(text)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => {
      if (!token || banned.has(token)) return false;
      if (/(습니다|합니다|됩니다|입니다|주세요|했어요|해요|네요|군요)$/.test(token) && token.length <= 7) return false;
      return true;
    });
  const counts = new Map();

  for (let size = 1; size <= 3; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const term = tokens.slice(i, i + size).join(' ');
      if (term.length < 2 || term.length > 30) continue;
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || b.term.length - a.term.length)
    .slice(0, 30);
}

function extractBlogName(html = '', mobileHtml = '') {
  return extractAttribute(mobileHtml, 'blogName')
    || stripHtml(html.match(/<strong\b[^>]*class=["'][^"']*\buser_blog_name\b[^"']*["'][^>]*>([\s\S]*?)<\/strong>/i)?.[1] || '')
    || pickMetaContent(html, 'og:site_name')
    || '';
}

function cleanNaverBlogTitle(value = '') {
  return decodeHtmlEntities(value)
    .replace(/^네이버\s*블로그\s*\|\s*/i, '')
    .replace(/\s*:\s*네이버\s*블로그\s*$/i, '')
    .trim();
}

function extractNaverBlogId(sourceUrl = '') {
  if (!/blog\.naver\.com/i.test(sourceUrl || '')) return '';
  try {
    const url = new URL(sourceUrl);
    const queryBlogId = url.searchParams.get('blogId');
    if (queryBlogId) return queryBlogId;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] && !/\.naver$/i.test(parts[0]) && !/Post(List|View)\.naver/i.test(parts[0])) return parts[0];
  } catch {
    return '';
  }
  return '';
}

function naverBlogHomeUrl(sourceUrl = '') {
  const blogId = extractNaverBlogId(sourceUrl);
  return blogId ? `https://m.blog.naver.com/${blogId}` : null;
}

function extractBlogIdentity({ sourceUrl = '', html = '', mobileHtml = '', blogHomeHtml = '' } = {}) {
  const blogId = extractNaverBlogId(sourceUrl);
  const nickname = pickMetaContent(mobileHtml, 'naverblog:nickname')
    || pickMetaContent(blogHomeHtml, 'naverblog:nickname')
    || '';
  const rawTitle = extractAttribute(mobileHtml, 'blogName')
    || cleanNaverBlogTitle(pickMetaContent(blogHomeHtml, 'og:title'))
    || cleanNaverBlogTitle(pickMetaContent(mobileHtml, 'og:site_name'))
    || extractBlogName(html, mobileHtml);
  const blogTitle = cleanNaverBlogTitle(rawTitle);
  const blogName = nickname || blogTitle || blogId || '';

  return {
    blogId,
    blogHomeUrl: naverBlogHomeUrl(sourceUrl),
    blogName,
    blogTitle,
    blogNickname: nickname,
  };
}

function extractTodayViewCount(mobileHtml = '') {
  const patterns = [
    /(?:todayViewCount|todayReadCount|todayVisitorCount|todayCount)\s*[:=]\s*["']?([0-9,]+)/i,
    /(?:postViewCount|viewCount|readCount)\s*[:=]\s*["']?([0-9,]+)/i,
    /(?:오늘\s*)?(?:조회수|조회|방문자|방문)\D{0,30}([0-9,]+)/,
  ];

  for (const pattern of patterns) {
    const match = mobileHtml.match(pattern);
    if (match) {
      const value = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function extractBlogVisitorCounts(blogHomeHtml = '') {
  if (!blogHomeHtml) return { todayViewCount: null, totalViewCount: null, source: null };

  const visible = blogHomeHtml.match(/오늘\s*([0-9,]+)[\s\S]{0,120}?전체\s*([0-9,]+)/);
  if (visible) {
    return {
      todayViewCount: parseInt(visible[1].replace(/,/g, ''), 10),
      totalViewCount: parseInt(visible[2].replace(/,/g, ''), 10),
      source: 'm.blog.naver.com',
    };
  }

  const todayJson = blogHomeHtml.match(/"todayVisitor"\s*:\s*([0-9]+)/i);
  const totalJson = blogHomeHtml.match(/"totalVisitor"\s*:\s*([0-9]+)/i);
  const todayViewCount = todayJson ? parseInt(todayJson[1], 10) : null;
  const totalViewCount = totalJson ? parseInt(totalJson[1], 10) : null;
  return {
    todayViewCount: Number.isFinite(todayViewCount) ? todayViewCount : null,
    totalViewCount: Number.isFinite(totalViewCount) ? totalViewCount : null,
    source: todayJson || totalJson ? 'm.blog.naver.com' : null,
  };
}

function normalizeSourceUrl(sourceUrl = '') {
  try {
    const url = new URL(sourceUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function extractCafeIdentity(sourceUrl = '', html = '') {
  let cafeId = '';
  let articleId = '';
  try {
    const url = new URL(sourceUrl);
    const cafePath = url.pathname.match(/\/cafes\/([^/]+)\/articles\/([^/?#]+)/i);
    if (cafePath) {
      cafeId = cafePath[1];
      articleId = cafePath[2];
    }
    const clubId = url.searchParams.get('clubid') || url.searchParams.get('clubId');
    const articleIdParam = url.searchParams.get('articleid') || url.searchParams.get('articleId') || url.searchParams.get('articleid');
    if (clubId) cafeId = clubId;
    if (articleIdParam) articleId = articleIdParam;
    if (!cafeId) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] && !['ArticleRead.nhn', 'ArticleRead.naver'].includes(parts[0])) cafeId = parts[0];
      if (!articleId && /^\d+$/.test(parts.at(-1) || '')) articleId = parts.at(-1);
    }
  } catch {
    // ignore malformed URLs
  }

  const cafeName = pickMetaContent(html, 'og:site_name')
    || stripHtml(html.match(/<h1\b[^>]*class=["'][^"']*cafe_name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    || '';

  return { cafeId, articleId, cafeName: cleanNaverBlogTitle(cafeName) };
}

function extractCafePostViewCount(html = '') {
  if (!html) return null;
  const text = stripHtml(html);
  const patterns = [
    /(?:조회수|조회)\s*[:：]?\s*([0-9,]+)/,
    /(?:viewCount|readCount|articleReadCount)\s*[:=]\s*["']?([0-9,]+)/i,
    /"readCount"\s*:\s*([0-9]+)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern) || text.match(pattern);
    if (match) {
      const value = parseInt(String(match[1]).replace(/,/g, ''), 10);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
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
  const compactTitle = title.replace(/\s/g, '');
  const context = guessCategoryFromText(text, title);
  const contextTerms = {
    'IT/테크': ['테스트', '검사', '링크', '유형', '사이트', '앱', 'ai'],
    '맛집': ['맛집', '메뉴', '가격', '후기', '예약'],
    '여행': ['여행', '숙소', '일정', '코스', '호텔'],
    '건강/의료': ['병원', '증상', '건강', '치료', '검진'],
    '재테크/금융': ['금리', '대출', '주식', '투자', '보험'],
    '육아/육품': ['육아', '아이', '아기', '유아'],
    '부동산': ['아파트', '분양', '전세', '청약', '부동산'],
    '정부정책': ['지원금', '신청', '지급', '대상', '정책'],
  }[context] || [];

  for (let size = 1; size <= 3; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const phrase = tokens.slice(i, i + size).join(' ');
      if (phrase.replace(/\s/g, '').length < 2 || phrase.length > 30) continue;
      const compactPhrase = phrase.replace(/\s/g, '');
      const base = size === 1 ? 0.75 : size === 2 ? 3.2 : 3.9;
      const titleBoost = title.includes(phrase) ? 7 : 0;
      const compactTitleBoost = compactTitle.includes(compactPhrase) ? 3 : 0;
      const headingBoost = subheadings.some((heading) => heading.includes(phrase)) ? 4 : 0;
      const contextBoost = contextTerms.some((term) => phrase.includes(term) || term.includes(phrase)) ? 2.2 : 0;
      const oneWordPenalty = size === 1 && !contextTerms.some((term) => term === phrase) ? 1.1 : 0;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
      scores.set(phrase, (scores.get(phrase) || 0) + base + titleBoost + compactTitleBoost + headingBoost + contextBoost - oneWordPenalty);
    }
  }

  return [...scores.entries()]
    .map(([keyword, score]) => {
      const wordCount = keyword.split(/\s+/).length;
      const compactKeyword = keyword.replace(/\s/g, '');
      return {
        keyword,
        score: Number(score.toFixed(2)),
        count: counts.get(keyword) || 0,
        wordCount,
        context,
        contextMatched: contextTerms.some((term) => keyword.includes(term) || term.includes(keyword)),
        titleMatched: compactTitle.includes(compactKeyword),
      };
    })
    .filter((item) => (
      item.count >= 2
      || item.titleMatched
      || (item.wordCount >= 2 && item.contextMatched)
    ))
    .sort((a, b) => b.score - a.score || b.wordCount - a.wordCount || b.count - a.count)
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

function naverMobileUrl(sourceUrl) {
  if (!/blog\.naver\.com/i.test(sourceUrl || '')) return null;
  const url = new URL(sourceUrl);
  const pathMatch = url.pathname.match(/^\/([^/]+)\/(\d+)/);
  if (pathMatch) return `https://m.blog.naver.com/${pathMatch[1]}/${pathMatch[2]}`;
  const blogId = url.searchParams.get('blogId');
  const logNo = url.searchParams.get('logNo');
  if (blogId && logNo) return `https://m.blog.naver.com/${blogId}/${logNo}`;
  return sourceUrl.replace('https://blog.naver.com/', 'https://m.blog.naver.com/');
}

async function fetchNaverMobileHtml(sourceUrl) {
  const mobileUrl = naverMobileUrl(sourceUrl);
  if (!mobileUrl) return '';
  try {
    const response = await fetch(mobileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 NaviWrite/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
      },
      redirect: 'follow',
    });
    if (!response.ok) return '';
    return (await response.text()).slice(0, 1_500_000);
  } catch {
    return '';
  }
}

async function fetchNaverBlogHomeHtml(sourceUrl) {
  const homeUrl = naverBlogHomeUrl(sourceUrl);
  if (!homeUrl) return '';
  try {
    const response = await fetch(homeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 NaviWrite/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
      },
      redirect: 'follow',
    });
    if (!response.ok) return '';
    return (await response.text()).slice(0, 1_500_000);
  } catch {
    return '';
  }
}

function buildSourceAnalysis({ sourceUrl, sourceText, html, mobileHtml = '', blogHomeHtml = '', keyword, category, platform, fetchStatus, errorMessage }) {
  const title = html ? extractTitle(html, sourceUrl || '붙여넣기 원문') : '붙여넣기 원문';
  const bodyHtml = html ? (extractNaverBodyHtml(html) || html) : '';
  const plainText = sourceText ? decodeHtmlEntities(sourceText) : stripHtml(bodyHtml || html || '');
  const compactText = plainText.replace(/\s/g, '');
  const imageCount = bodyHtml ? countBodyImages(bodyHtml) : html ? (html.match(/<img\b/gi) || []).length : 0;
  const subheadings = bodyHtml ? extractHeadings(bodyHtml) : html ? extractHeadings(html) : [];
  const links = bodyHtml ? extractLinks(bodyHtml) : html ? extractLinks(html) : [];
  const quoteBlocks = bodyHtml ? extractQuoteBlocks(bodyHtml) : [];
  const quoteText = quoteBlocks.join('\n');
  const keywordCandidates = inferKeywordCandidates({ title, text: plainText, subheadings });
  const mainKeyword = keyword || keywordCandidates[0]?.keyword || '';
  const kwCount = mainKeyword ? (plainText.match(new RegExp(escapeRegExp(mainKeyword), 'gi')) || []).length : 0;
  const categoryGuess = category && category !== 'general' ? category : guessCategoryFromText(plainText, title);
  const structure = summarizeStructure({
    text: plainText,
    subheadings,
    links,
    imageCount,
    hasVideo: bodyHtml ? /<video\b|youtube\.com|tv\.naver\.com|<iframe\b|attachVideoInfo/i.test(`${bodyHtml} ${mobileHtml}`) : html ? /<video\b|youtube\.com|tv\.naver\.com|<iframe\b/i.test(html) : false,
  });
  const blogIdentity = extractBlogIdentity({ sourceUrl, html, mobileHtml, blogHomeHtml });
  const blogVisitorCounts = extractBlogVisitorCounts(blogHomeHtml);
  const todayViewCount = blogVisitorCounts.todayViewCount ?? extractTodayViewCount(mobileHtml);
  const totalViewCount = blogVisitorCounts.totalViewCount;
  const cafeIdentity = extractCafeIdentity(sourceUrl, html);
  const postViewCount = guessPlatform(sourceUrl, platform) === 'cafe' ? extractCafePostViewCount(html) : null;

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
    blogId: blogIdentity.blogId,
    blogHomeUrl: blogIdentity.blogHomeUrl,
    blogName: blogIdentity.blogName,
    blogTitle: blogIdentity.blogTitle,
    blogNickname: blogIdentity.blogNickname,
    todayViewCount,
    totalViewCount,
    todayViewSource: todayViewCount === null ? null : (blogVisitorCounts.source || 'm.blog.naver.com'),
    totalViewSource: totalViewCount === null ? null : (blogVisitorCounts.source || 'm.blog.naver.com'),
    cafeId: cafeIdentity.cafeId,
    cafeArticleId: cafeIdentity.articleId,
    cafeName: cafeIdentity.cafeName,
    postViewCount,
    postViewSource: postViewCount === null ? null : 'cafe.naver.com',
    viewCountCheckedAt: mobileHtml || blogHomeHtml || postViewCount !== null ? new Date().toISOString() : null,
    quoteBlocks,
    repeatedTerms: inferRepeatedTerms(plainText, 2),
    quoteRepeatedTerms: quoteText ? inferRepeatedTerms(quoteText, 2) : [],
    fetchStatus,
    errorMessage,
  };
}

function kstDateString(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function recordBlogViewSnapshot(collectedBlog, counts = {}) {
  if (!collectedBlog?.id) return null;

  const todayViewCount = Number.isFinite(counts.todayViewCount) ? counts.todayViewCount : null;
  const totalViewCount = Number.isFinite(counts.totalViewCount) ? counts.totalViewCount : null;
  if (todayViewCount === null && totalViewCount === null) return null;

  const snapshotDate = counts.snapshotDate || kstDateString();
  const isDayClosed = Boolean(counts.isDayClosed);
  const previous = await pool.query(
    `SELECT total_view_count
     FROM blog_view_snapshots
     WHERE collected_blog_id = $1
       AND snapshot_date < $2
       AND total_view_count IS NOT NULL
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [collectedBlog.id, snapshotDate]
  );
  const previousTotalViewCount = previous.rows[0]?.total_view_count ?? null;
  const explicitDailyViewCount = Number.isFinite(counts.dailyViewCount) ? counts.dailyViewCount : null;
  const dailyViewCount = explicitDailyViewCount !== null
    ? explicitDailyViewCount
    : totalViewCount !== null && previousTotalViewCount !== null
      ? Math.max(0, totalViewCount - previousTotalViewCount)
      : todayViewCount;
  const dailyViewSource = counts.dailyViewSource || (isDayClosed ? 'naver_today_counter_day_close' : 'realtime_total_delta_or_today');

  const { rows } = await pool.query(
    `INSERT INTO blog_view_snapshots (
       collected_blog_id, snapshot_date, today_view_count, total_view_count,
       previous_total_view_count, daily_view_count, is_day_closed, daily_view_source, source, checked_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (collected_blog_id, snapshot_date)
     DO UPDATE SET
       today_view_count = EXCLUDED.today_view_count,
       total_view_count = EXCLUDED.total_view_count,
       previous_total_view_count = EXCLUDED.previous_total_view_count,
       daily_view_count = CASE
         WHEN blog_view_snapshots.is_day_closed = TRUE AND EXCLUDED.is_day_closed = FALSE
           THEN blog_view_snapshots.daily_view_count
         ELSE EXCLUDED.daily_view_count
       END,
       is_day_closed = blog_view_snapshots.is_day_closed OR EXCLUDED.is_day_closed,
       daily_view_source = CASE
         WHEN blog_view_snapshots.is_day_closed = TRUE AND EXCLUDED.is_day_closed = FALSE
           THEN blog_view_snapshots.daily_view_source
         ELSE EXCLUDED.daily_view_source
       END,
       source = EXCLUDED.source,
       checked_at = NOW()
     RETURNING *`,
    [
      collectedBlog.id,
      snapshotDate,
      todayViewCount,
      totalViewCount,
      previousTotalViewCount,
      dailyViewCount,
      isDayClosed,
      dailyViewSource,
      counts.source || 'm.blog.naver.com',
    ]
  );

  await pool.query(
    `UPDATE collected_blogs
     SET last_today_view_count = $2,
         last_total_view_count = $3,
         last_daily_view_count = $4,
         last_checked_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [collectedBlog.id, todayViewCount, totalViewCount, rows[0]?.daily_view_count ?? dailyViewCount]
  );

  return rows[0] || null;
}

async function upsertCollectedBlogFromAnalysis(link, analysis) {
  const platform = analysis.platform_guess || analysis.platform || guessPlatform(analysis.source_url || link?.url, 'blog');
  const blogId = analysis.blog_id || extractNaverBlogId(analysis.source_url || link?.url || '');
  const homeUrl = analysis.blog_home_url || naverBlogHomeUrl(analysis.source_url || link?.url || '');
  const category = analysis.category_guess || analysis.category || 'general';
  if (platform !== 'blog' || (!blogId && !homeUrl)) return null;

  const blogName = analysis.blog_name || analysis.blog_nickname || analysis.blog_title || blogId || homeUrl;
  const { rows } = await pool.query(
    `INSERT INTO collected_blogs (
       platform, blog_id, category, blog_name, blog_title, blog_nickname, home_url,
       latest_source_link_id, latest_source_analysis_id,
       last_today_view_count, last_total_view_count, last_checked_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (platform, blog_id)
     DO UPDATE SET
       category = EXCLUDED.category,
       blog_name = EXCLUDED.blog_name,
       blog_title = EXCLUDED.blog_title,
       blog_nickname = EXCLUDED.blog_nickname,
       home_url = EXCLUDED.home_url,
       latest_source_link_id = EXCLUDED.latest_source_link_id,
       latest_source_analysis_id = EXCLUDED.latest_source_analysis_id,
       last_today_view_count = EXCLUDED.last_today_view_count,
       last_total_view_count = EXCLUDED.last_total_view_count,
       last_checked_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      platform,
      blogId || homeUrl,
      category,
      blogName,
      analysis.blog_title || null,
      analysis.blog_nickname || null,
      homeUrl,
      link?.id || analysis.source_link_id || null,
      analysis.id,
      analysis.today_view_count ?? null,
      analysis.total_view_count ?? null,
    ]
  );

  const collectedBlog = rows[0] || null;
  if (collectedBlog) {
    await recordBlogViewSnapshot(collectedBlog, {
      todayViewCount: analysis.today_view_count,
      totalViewCount: analysis.total_view_count,
      source: analysis.total_view_source || analysis.today_view_source || 'm.blog.naver.com',
    });
  }
  return collectedBlog;
}

async function refreshCollectedBlogViews(blog, options = {}) {
  if (!blog?.home_url) throw new Error('블로그 홈 URL이 없습니다');
  const html = await fetchNaverBlogHomeHtml(blog.home_url);
  const counts = extractBlogVisitorCounts(html);
  if (counts.todayViewCount === null && counts.totalViewCount === null) {
    throw new Error('공개 방문자 카운터를 찾지 못했습니다');
  }
  const isDayClosed = options.mode === 'day-close';
  const snapshot = await recordBlogViewSnapshot(blog, {
    ...counts,
    snapshotDate: options.snapshotDate || kstDateString(),
    dailyViewCount: isDayClosed && Number.isFinite(counts.todayViewCount) ? counts.todayViewCount : undefined,
    isDayClosed,
    dailyViewSource: isDayClosed ? 'naver_today_counter_day_close' : undefined,
  });
  return { blog, snapshot };
}

async function snapshotCollectedBlogs({ limit = 100, category = null, mode = 'realtime', snapshotDate = null } = {}) {
  const values = [];
  const where = [`platform = 'blog'`, `home_url IS NOT NULL`];
  if (category) {
    values.push(category);
    where.push(`category = $${values.length}`);
  }
  values.push(Math.min(Number(limit) || 100, 300));
  const { rows } = await pool.query(
    `SELECT *
     FROM collected_blogs
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${values.length}`,
    values
  );

  const results = [];
  for (const blog of rows) {
    try {
      results.push({ ok: true, ...(await refreshCollectedBlogViews(blog, { mode, snapshotDate })) });
    } catch (err) {
      results.push({ ok: false, blog, error: err.message });
    }
  }
  return results;
}

async function recordCafePostViewSnapshot(cafePost, viewCount, source = 'cafe.naver.com') {
  if (!cafePost?.id || !Number.isFinite(viewCount) || viewCount < 10) return null;

  const snapshotDate = kstDateString();
  const previous = await pool.query(
    `SELECT view_count
     FROM cafe_post_view_snapshots
     WHERE cafe_post_id = $1
       AND snapshot_date < $2
       AND view_count IS NOT NULL
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [cafePost.id, snapshotDate]
  );
  const previousViewCount = previous.rows[0]?.view_count ?? null;
  const dailyIncrease = previousViewCount === null ? viewCount : Math.max(0, viewCount - previousViewCount);

  const { rows } = await pool.query(
    `INSERT INTO cafe_post_view_snapshots (
       cafe_post_id, snapshot_date, view_count, previous_view_count, daily_increase, source, checked_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (cafe_post_id, snapshot_date)
     DO UPDATE SET
       view_count = EXCLUDED.view_count,
       previous_view_count = EXCLUDED.previous_view_count,
       daily_increase = EXCLUDED.daily_increase,
       source = EXCLUDED.source,
       checked_at = NOW()
     RETURNING *`,
    [cafePost.id, snapshotDate, viewCount, previousViewCount, dailyIncrease, source]
  );

  await pool.query(
    `UPDATE collected_cafe_posts
     SET last_view_count = $2,
         last_daily_increase = $3,
         last_checked_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [cafePost.id, viewCount, dailyIncrease]
  );

  return rows[0] || null;
}

async function upsertCollectedCafePostFromAnalysis(link, analysis) {
  const platform = analysis.platform_guess || analysis.platform || guessPlatform(analysis.source_url || link?.url, 'web');
  if (platform !== 'cafe') return null;
  const viewCount = analysis.post_view_count ?? analysis.postViewCount ?? null;
  if (!Number.isFinite(viewCount) || viewCount < 10) return null;

  const identity = {
    cafeId: analysis.cafe_id || analysis.cafeId || extractCafeIdentity(analysis.source_url || link?.url || '').cafeId,
    articleId: analysis.cafe_article_id || analysis.cafeArticleId || extractCafeIdentity(analysis.source_url || link?.url || '').articleId,
    cafeName: analysis.cafe_name || analysis.cafeName || '',
  };
  const url = normalizeSourceUrl(analysis.source_url || link?.url || '');
  const { rows } = await pool.query(
    `INSERT INTO collected_cafe_posts (
       url, cafe_id, cafe_name, article_id, title, category,
       latest_source_link_id, latest_source_analysis_id, last_view_count, last_checked_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (url)
     DO UPDATE SET
       cafe_id = EXCLUDED.cafe_id,
       cafe_name = EXCLUDED.cafe_name,
       article_id = EXCLUDED.article_id,
       title = EXCLUDED.title,
       category = EXCLUDED.category,
       latest_source_link_id = EXCLUDED.latest_source_link_id,
       latest_source_analysis_id = EXCLUDED.latest_source_analysis_id,
       last_view_count = EXCLUDED.last_view_count,
       last_checked_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      url,
      identity.cafeId || null,
      identity.cafeName || null,
      identity.articleId || null,
      analysis.title || null,
      analysis.category_guess || analysis.category || 'general',
      link?.id || analysis.source_link_id || null,
      analysis.id,
      viewCount,
    ]
  );

  const cafePost = rows[0] || null;
  if (cafePost) await recordCafePostViewSnapshot(cafePost, viewCount, analysis.post_view_source || analysis.postViewSource || 'cafe.naver.com');
  return cafePost;
}

async function refreshCollectedCafePostViews(cafePost) {
  const html = await fetchSourceHtml(cafePost.url);
  const viewCount = extractCafePostViewCount(html);
  if (!Number.isFinite(viewCount)) throw new Error('공개 카페 조회수를 찾지 못했습니다');
  if (viewCount < 10) return { cafePost, skipped: true, viewCount };
  const snapshot = await recordCafePostViewSnapshot(cafePost, viewCount, 'cafe.naver.com');
  return { cafePost, snapshot, viewCount };
}

async function snapshotCollectedCafePosts({ limit = 100, category = null } = {}) {
  const values = [];
  const where = [`last_view_count >= 10`];
  if (category) {
    values.push(category);
    where.push(`category = $${values.length}`);
  }
  values.push(Math.min(Number(limit) || 100, 300));
  const { rows } = await pool.query(
    `SELECT *
     FROM collected_cafe_posts
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${values.length}`,
    values
  );

  const results = [];
  for (const cafePost of rows) {
    try {
      results.push({ ok: true, ...(await refreshCollectedCafePostViews(cafePost)) });
    } catch (err) {
      results.push({ ok: false, cafePost, error: err.message });
    }
  }
  return results;
}

function parseTargetKeywords(input = '') {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))].slice(0, 50);
  }
  return [...new Set(String(input)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 50);
}

function normalizeIdList(input = []) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((item) => parseInt(item, 10)).filter(Number.isFinite))].slice(0, 50);
}

function normalizeKeywordValue(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function normalizeTitleValue(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 90);
}

function effectiveMainKeyword(row = {}) {
  return normalizeKeywordValue(row.corrected_main_keyword || row.main_keyword || row.keyword || '');
}

function countKeywordInText(text = '', keyword = '') {
  const safeKeyword = normalizeKeywordValue(keyword);
  if (!safeKeyword) return 0;
  return (String(text || '').match(new RegExp(escapeRegExp(safeKeyword), 'gi')) || []).length;
}

function averageNumber(values = [], fallback = 0) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length === 0) return fallback;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function medianNumber(values = [], fallback = 0) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (numbers.length === 0) return fallback;
  const mid = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[mid] : Math.round((numbers[mid - 1] + numbers[mid]) / 2);
}

function roundToNearest(value, unit = 10) {
  return Math.round(Number(value || 0) / unit) * unit;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseRewriteSettings(input = {}) {
  const raw = parseJsonObject(input, {});
  return {
    ...DEFAULT_REWRITE_SETTINGS,
    ...raw,
    targetCharCount: clampNumber(parseInt(raw.targetCharCount ?? raw.target_char_count ?? DEFAULT_REWRITE_SETTINGS.targetCharCount, 10) || DEFAULT_REWRITE_SETTINGS.targetCharCount, 1200, 5000),
    sectionCharCount: clampNumber(parseInt(raw.sectionCharCount ?? raw.section_char_count ?? DEFAULT_REWRITE_SETTINGS.sectionCharCount, 10) || DEFAULT_REWRITE_SETTINGS.sectionCharCount, 150, 700),
    sectionCount: clampNumber(parseInt(raw.sectionCount ?? raw.section_count ?? DEFAULT_REWRITE_SETTINGS.sectionCount, 10) || DEFAULT_REWRITE_SETTINGS.sectionCount, 3, 10),
    targetKwCount: clampNumber(parseInt(raw.targetKwCount ?? raw.keywordRepeatCount ?? raw.target_kw_count ?? DEFAULT_REWRITE_SETTINGS.targetKwCount, 10) || DEFAULT_REWRITE_SETTINGS.targetKwCount, 5, 30),
    imageCount: clampNumber(parseInt(raw.imageCount ?? raw.image_count ?? DEFAULT_REWRITE_SETTINGS.imageCount, 10) || DEFAULT_REWRITE_SETTINGS.imageCount, 0, 20),
    benchmarkUrl: raw.benchmarkUrl || raw.benchmark_url || DEFAULT_REWRITE_SETTINGS.benchmarkUrl,
  };
}

function extractNaverPostListJson(raw = '') {
  try {
    return JSON.parse(raw);
  } catch {
    const match = String(raw).match(/"postList"\s*:\s*(\[[\s\S]*?\])\s*,\s*"countPerPage"/);
    if (!match) return { postList: [] };
    try {
      return { postList: JSON.parse(match[1]) };
    } catch {
      return { postList: [] };
    }
  }
}

async function fetchNaverRecentPosts(sourceUrl, limit = 20) {
  const blogId = extractNaverBlogId(sourceUrl);
  if (!blogId) throw new Error('네이버 블로그 URL에서 blogId를 찾지 못했습니다');
  const safeLimit = clampNumber(parseInt(limit, 10) || 20, 1, 30);
  const listUrl = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${encodeURIComponent(blogId)}&viewdate=&currentPage=1&categoryNo=0&parentCategoryNo=&countPerPage=${safeLimit}`;
  const response = await fetch(listUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 NaviWrite/1.0',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`최근 글 목록 응답 오류 (${response.status})`);
  const parsed = extractNaverPostListJson(await response.text());
  return (parsed.postList || []).slice(0, safeLimit).map((post) => {
    const title = decodeHtmlEntities(decodeURIComponent(String(post.title || '').replace(/\+/g, ' ')));
    const url = `https://blog.naver.com/${blogId}/${post.logNo}`;
    return {
      blogId,
      logNo: post.logNo,
      title,
      url,
      categoryNo: post.categoryNo || null,
      addDate: post.addDate || null,
    };
  }).filter((post) => post.logNo);
}

async function benchmarkRewriteSettingsFromUrl(sourceUrl, limit = 20) {
  const posts = await fetchNaverRecentPosts(sourceUrl, limit);
  const analyses = [];
  for (const post of posts) {
    const mobileHtml = await fetchNaverMobileHtml(post.url);
    if (!mobileHtml) continue;
    const analysis = buildSourceAnalysis({
      sourceUrl: post.url,
      html: mobileHtml,
      mobileHtml,
      platform: 'blog',
      fetchStatus: 'benchmark_collected',
      errorMessage: null,
    });
    if (analysis.charCount < 80) continue;
    analyses.push({
      ...analysis,
      logNo: post.logNo,
      addDate: post.addDate,
      categoryNo: post.categoryNo,
    });
  }

  const sectionCounts = analyses.map((item) => Array.isArray(item.quoteBlocks) ? item.quoteBlocks.length : 0).filter((value) => value > 0);
  const summary = {
    sampleCount: analyses.length,
    medianCharCount: medianNumber(analyses.map((item) => item.charCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianCharCount),
    averageCharCount: averageNumber(analyses.map((item) => item.charCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianCharCount),
    medianSectionCount: medianNumber(sectionCounts, DEFAULT_REWRITE_SETTINGS.benchmarkMedianSectionCount),
    averageSectionCount: averageNumber(sectionCounts, DEFAULT_REWRITE_SETTINGS.benchmarkMedianSectionCount),
    medianKwCount: medianNumber(analyses.map((item) => item.kwCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianKwCount),
    averageKwCount: averageNumber(analyses.map((item) => item.kwCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianKwCount),
    medianImageCount: medianNumber(analyses.map((item) => item.imageCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianImageCount),
    averageImageCount: averageNumber(analyses.map((item) => item.imageCount), DEFAULT_REWRITE_SETTINGS.benchmarkMedianImageCount),
  };

  const targetCharCount = clampNumber(Math.max(2200, roundToNearest(summary.medianCharCount, 100)), 1200, 5000);
  const sectionCount = clampNumber(summary.medianSectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount, 3, 10);
  const settings = parseRewriteSettings({
    targetCharCount,
    sectionCharCount: clampNumber(roundToNearest(targetCharCount / sectionCount, 10), 150, 700),
    sectionCount,
    targetKwCount: Math.min(summary.medianKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount, DEFAULT_REWRITE_SETTINGS.targetKwCount),
    imageCount: summary.medianImageCount || DEFAULT_REWRITE_SETTINGS.imageCount,
    benchmarkUrl: sourceUrl,
    benchmarkSampleCount: summary.sampleCount,
    benchmarkMedianCharCount: summary.medianCharCount,
    benchmarkMedianSectionCount: summary.medianSectionCount,
    benchmarkMedianSectionCharCount: clampNumber(roundToNearest(summary.medianCharCount / Math.max(summary.medianSectionCount, 1), 10), 150, 700),
    benchmarkMedianKwCount: summary.medianKwCount,
    benchmarkMedianImageCount: summary.medianImageCount,
  });

  return {
    settings,
    summary,
    posts: analyses.map((item) => ({
      sourceUrl: item.sourceUrl,
      title: item.title,
      mainKeyword: item.mainKeyword,
      categoryGuess: item.categoryGuess,
      charCount: item.charCount,
      kwCount: item.kwCount,
      imageCount: item.imageCount,
      sectionCount: Array.isArray(item.quoteBlocks) ? item.quoteBlocks.length : 0,
    })),
  };
}

function buildRewritePattern(analyses = [], settingsInput = {}) {
  const settings = parseRewriteSettings(settingsInput);
  const quoteCounts = analyses.map((row) => Array.isArray(row.quote_blocks) ? row.quote_blocks.length : 0);
  const structureRows = analyses.map((row) => row.structure_json || {});
  const paragraphCount = averageNumber(structureRows.map((item) => item.paragraphCount), 24);
  const tones = analyses.map((row) => row.tone_summary).filter(Boolean);
  const tone = tones[0] || '정보형 존댓말';
  const platforms = analyses.map((row) => row.platform_guess || row.platform).filter(Boolean);
  const platform = platforms[0] || 'blog';
  const sourceTitles = analyses.map((row) => row.title).filter(Boolean).slice(0, 20);
  const sourceKeywords = [...new Set(analyses.map(effectiveMainKeyword).filter(Boolean))].slice(0, 20);
  const sourceActionTerms = inferTitleActionTerms(sourceTitles.join(' '));
  const sourceTextSamples = analyses
    .map((row) => String(row.plain_text || row.source_text_preview || '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 120)
    .map((text) => text.slice(0, 5000))
    .slice(0, 10);
  const targetKwCount = clampNumber((settings.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount) + 1, 5, 31);

  return {
    sampleCount: analyses.length,
    benchmark: {
      averageCharCount: averageNumber(analyses.map((row) => row.char_count), settings.benchmarkMedianCharCount),
      averageKwCount: averageNumber(analyses.map((row) => row.kw_count), settings.benchmarkMedianKwCount),
      averageImageCount: averageNumber(analyses.map((row) => row.image_count), settings.benchmarkMedianImageCount),
      averageSectionCount: Math.round(averageNumber(quoteCounts, settings.benchmarkMedianSectionCount) || averageNumber(structureRows.map((item) => item.headingCount), settings.benchmarkMedianSectionCount) || settings.benchmarkMedianSectionCount),
    },
    targetCharCount: settings.targetCharCount,
    sectionCharCount: settings.sectionCharCount,
    targetKwCount,
    keywordRepeatBuffer: 1,
    imageCount: settings.imageCount,
    quoteCount: settings.sectionCount,
    sectionCount: settings.sectionCount,
    paragraphCount,
    tone,
    platform,
    sourceTitles,
    sourceKeywords,
    sourceActionTerms,
    sourceTextSamples,
    settings,
    structure: {
      introParagraphs: 3,
      ctaAfterIntro: true,
      imageAfterEachSection: true,
      conclusionParagraphs: 3,
    },
  };
}

const TITLE_ACTION_TERMS = [
  '신청', '방법', '대상', '기준', '지급일', '사용처', '결과', '유형', '링크', '사이트',
  '예매', '티켓팅', '예약', '일정', '가격', '후기', '확인', '정리', '총정리', '바로가기',
  '비교', '조건', '기간', '재고', '판매처', '추천',
];

function inferTitleActionTerms(text = '') {
  const source = String(text || '');
  return TITLE_ACTION_TERMS
    .map((term) => ({
      term,
      count: (source.match(new RegExp(escapeRegExp(term), 'g')) || []).length,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || TITLE_ACTION_TERMS.indexOf(a.term) - TITLE_ACTION_TERMS.indexOf(b.term))
    .map((item) => item.term)
    .slice(0, 5);
}

function titleIntentTail(keyword = '', topic = '', actionTerms = []) {
  const source = `${keyword} ${topic} ${actionTerms.join(' ')}`;
  if (/신청|지원금|환급|급여|수당|정책|대상|지급/.test(source)) return '대상 기준 신청 방법 정리';
  if (/예매|티켓팅|공연|콘서트|예약|티켓/.test(source)) return '일정 예매 방법 티켓팅 정리';
  if (/테스트|검사|유형|결과|성격|링크|사이트/.test(source)) return '링크 결과 유형 확인 방법';
  if (/가격|재고|판매처|팝콘|상품|제품|구매/.test(source)) return '가격 재고 판매처 확인';
  if (/맛집|카페|라면|메뉴|식당|후기/.test(source)) return '메뉴 가격 후기 정리';
  const compact = actionTerms.filter((term) => !keyword.includes(term)).slice(0, 3).join(' ');
  return compact ? `${compact} 핵심 정리` : '기준 방법 핵심 정리';
}

function makeRewriteTitle(keyword, topic = '', platform = 'blog', pattern = {}) {
  const cleanKeyword = normalizeKeywordValue(keyword);
  const cleanTopic = normalizeKeywordValue(topic);
  const subject = cleanTopic && !cleanTopic.includes(cleanKeyword) ? `${cleanKeyword} ${cleanTopic}` : cleanKeyword;
  const actionTerms = Array.isArray(pattern.sourceActionTerms) ? pattern.sourceActionTerms : [];
  const title = `${subject} ${titleIntentTail(cleanKeyword, cleanTopic, actionTerms)}`.replace(/\s+/g, ' ').trim();
  if (platform === 'cafe') return `${title} 실제 확인 후기`.slice(0, 76);
  return title.slice(0, 70);
}

function naverSearchCredentials(body = {}) {
  const clientId = String(body.naverClientId || body.naver_client_id || process.env.NAVER_CLIENT_ID || '').trim();
  const clientSecret = String(body.naverClientSecret || body.naver_client_secret || process.env.NAVER_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function naverSearchEndpoint(platform = 'blog') {
  if (platform === 'cafe') return 'https://openapi.naver.com/v1/search/cafearticle.json';
  if (platform === 'web' || platform === 'premium' || platform === 'brunch') return 'https://openapi.naver.com/v1/search/webkr.json';
  return 'https://openapi.naver.com/v1/search/blog.json';
}

async function fetchNaverSearchResults({ query, platform = 'blog', credentials, display = 5 }) {
  if (!credentials || !query) return { enabled: false, total: null, items: [] };
  const url = new URL(naverSearchEndpoint(platform));
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(clampNumber(display, 1, 20)));
  url.searchParams.set('start', '1');
  url.searchParams.set('sort', 'sim');

  const response = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': credentials.clientId,
      'X-Naver-Client-Secret': credentials.clientSecret,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Naver Search API ${response.status}: ${text.slice(0, 160)}`);
  }
  const data = await response.json();
  return {
    enabled: true,
    total: data.total ?? null,
    items: Array.isArray(data.items)
      ? data.items.map((item) => ({
          title: stripHtml(item.title || ''),
          link: item.link || '',
          description: stripHtml(item.description || ''),
        }))
      : [],
  };
}

const TITLE_RECOMMENDATION_ACTIONS = [
  '링크', '결과', '유형', '확인', '방법', '정리', '신청', '대상', '기준', '지급일',
  '일정', '예매', '가격', '후기', '추천', '비교', '주의사항', '바로가기',
];

function titleRecommendationActions(text = '') {
  const picked = TITLE_RECOMMENDATION_ACTIONS
    .map((term) => ({
      term,
      count: (String(text || '').match(new RegExp(escapeRegExp(term), 'g')) || []).length,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || TITLE_RECOMMENDATION_ACTIONS.indexOf(a.term) - TITLE_RECOMMENDATION_ACTIONS.indexOf(b.term))
    .map((item) => item.term);
  return [...new Set([...picked, ...inferTitleActionTerms(text)])].slice(0, 6);
}

function compactTitleCandidate(value = '') {
  return normalizeTitleValue(value)
    .replace(/\s+(정리|확인|방법|알아보기)\s+\1/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateTitleCandidates({ keyword, topic = '', platform = 'blog', category = '', analyses = [] }) {
  const cleanKeyword = normalizeKeywordValue(keyword);
  const cleanTopic = normalizeTitleValue(topic);
  const sourceTitles = analyses.map((row) => row.title).filter(Boolean);
  const sourceText = [
    ...sourceTitles,
    ...analyses.flatMap((row) => Array.isArray(row.subheadings) ? row.subheadings : []),
    category,
    cleanTopic,
  ].join(' ');
  const actions = titleRecommendationActions(sourceText);
  const tail = titleIntentTail(cleanKeyword, cleanTopic, actions);
  const subject = cleanTopic && !cleanTopic.includes(cleanKeyword) ? `${cleanKeyword} ${cleanTopic}` : cleanKeyword;
  const candidates = [
    `${subject} ${tail}`,
    `${cleanKeyword} ${actions.slice(0, 3).join(' ')} 정리`,
    `${cleanKeyword} ${cleanTopic || '핵심'} 확인 방법`,
    `${cleanKeyword} 바로가기 링크 결과 정리`,
    `${cleanKeyword} 대상 기준 신청 방법`,
    `${cleanKeyword} 일정 예매 가격 확인`,
    `${cleanKeyword} 후기 주의사항 총정리`,
    `${cleanKeyword} ${category || '정보'} 최신 기준 정리`,
    makeRewriteTitle(cleanKeyword, cleanTopic, platform, { sourceActionTerms: actions }),
    ...sourceTitles.slice(0, 4).map((title) => `${cleanKeyword} ${titleRecommendationActions(title).slice(0, 3).join(' ')} 정리`),
  ];

  return [...new Set(candidates.map(compactTitleCandidate).filter((title) => {
    if (!title || !title.includes(cleanKeyword)) return false;
    return title.replace(/\s/g, '').length >= cleanKeyword.replace(/\s/g, '').length + 4;
  }))].slice(0, 12);
}

function wordSet(value = '') {
  return new Set(tokenizeKoreanText(value).map((token) => token.toLowerCase()));
}

function overlapRatio(a = '', b = '') {
  const aWords = wordSet(a);
  const bWords = wordSet(b);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let hits = 0;
  for (const word of aWords) if (bWords.has(word)) hits += 1;
  return hits / Math.max(aWords.size, 1);
}

function textShingles(value = '', size = 5) {
  const tokens = tokenizeKoreanText(value)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
  const shingles = new Set();
  for (let i = 0; i <= tokens.length - size; i += 1) {
    shingles.add(tokens.slice(i, i + size).join(' '));
  }
  return shingles;
}

function jaccardSetRatio(aSet, bSet) {
  if (!aSet?.size || !bSet?.size) return 0;
  let intersection = 0;
  for (const item of aSet) if (bSet.has(item)) intersection += 1;
  return intersection / Math.max(aSet.size + bSet.size - intersection, 1);
}

function scoreTitleCandidate({ title, keyword, topic = '', actionTerms = [], sourceTitles = [], serpTitles = [], total = null }) {
  const compact = title.replace(/\s/g, '');
  const length = compact.length;
  const keywordAtFront = title.startsWith(keyword);
  const actionHitCount = actionTerms.filter((term) => title.includes(term)).length;
  const titleTerms = titleRecommendationActions(title);
  const sourceOverlap = Math.max(0, ...sourceTitles.map((sourceTitle) => overlapRatio(title, sourceTitle)));
  const serpOverlap = Math.max(0, ...serpTitles.map((serpTitle) => overlapRatio(title, serpTitle)));
  const exactSerpDuplicate = serpTitles.some((serpTitle) => serpTitle.replace(/\s/g, '') === compact);
  const hasTopic = topic ? title.includes(topic.split(/\s+/)[0]) : true;

  let seoScore = 54;
  if (keywordAtFront) seoScore += 14;
  if (title.includes(keyword)) seoScore += 10;
  if (actionHitCount >= 2) seoScore += 8;
  if (length >= 16 && length <= 34) seoScore += 8;
  if (length > 44) seoScore -= 8;
  if (exactSerpDuplicate) seoScore -= 30;
  seoScore -= Math.round(Math.max(sourceOverlap - 0.55, 0) * 35);
  seoScore -= Math.round(Math.max(serpOverlap - 0.72, 0) * 25);

  let aeoScore = 58 + Math.min(18, titleTerms.length * 4);
  if (/방법|확인|정리|기준|대상|결과|링크/.test(title)) aeoScore += 12;
  if (!hasTopic) aeoScore -= 4;

  let geoScore = 57 + Math.min(15, actionHitCount * 5);
  if (total !== null && Number(total) > 0) geoScore += 5;
  if (sourceOverlap > 0.7) geoScore -= 10;

  const duplicateRisk = clampNumber(Math.round((sourceOverlap * 45) + (serpOverlap * 35) + (exactSerpDuplicate ? 30 : 0)), 0, 100);
  seoScore = clampNumber(Math.round(seoScore), 0, 100);
  aeoScore = clampNumber(Math.round(aeoScore), 0, 100);
  geoScore = clampNumber(Math.round(geoScore), 0, 100);
  const score = clampNumber(Math.round((seoScore * 0.45) + (aeoScore * 0.3) + (geoScore * 0.25) - duplicateRisk * 0.12), 0, 100);

  const reasons = [];
  if (keywordAtFront) reasons.push('메인 키워드 전면 배치');
  if (actionHitCount > 0) reasons.push(`행동유도어 ${actionHitCount}개 반영`);
  if (length >= 16 && length <= 34) reasons.push('네이버형 제목 길이 적정');
  if (duplicateRisk >= 45) reasons.push('유사 제목 위험 확인 필요');
  if (exactSerpDuplicate) reasons.push('검색 결과 동일 제목 감지');

  return { score, seoScore, aeoScore, geoScore, duplicateRisk, reasons };
}

function makeSectionTitles(keyword, topic, count) {
  const subject = topic || keyword;
  const base = [
    `${keyword} 먼저 확인해야 할 부분`,
    `${subject} 핵심 기준`,
    `${keyword} 진행 방법`,
    `${subject} 주의할 점`,
    `${keyword} 자주 묻는 질문`,
    `${subject} 실제 활용 팁`,
    `${keyword} 비교 포인트`,
    `${subject} 최종 체크`,
    `${keyword} 놓치기 쉬운 부분`,
  ];
  return base.slice(0, count);
}

function escapeSvgText(value = '') {
  return decodeHtmlEntities(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeTemplateImage({ keyword, section, subtitle, index, platform }) {
  const palettes = [
    { bg: '#ffffff', primary: '#1f5f4a', accent: '#d8ebe4', text: '#111827' },
    { bg: '#fbfdff', primary: '#1d4ed8', accent: '#dbeafe', text: '#172554' },
    { bg: '#fffdf7', primary: '#b45309', accent: '#fef3c7', text: '#1f2937' },
    { bg: '#fdfbff', primary: '#7c3aed', accent: '#ede9fe', text: '#1f133d' },
    { bg: '#fffafa', primary: '#be123c', accent: '#ffe4e6', text: '#1f2937' },
    { bg: '#f8fffb', primary: '#047857', accent: '#d1fae5', text: '#102a1f' },
  ];
  const seed = String(keyword || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) + index * 7;
  const palette = platform === 'cafe' ? palettes[(seed + 1) % palettes.length] : palettes[seed % palettes.length];
  const { bg, primary, accent, text } = palette;
  const layout = index % 3;
  const badge = index === 0 ? '대표' : `SEC ${String(index).padStart(2, '0')}`;
  const safeKeyword = escapeSvgText(String(keyword || '').slice(0, 16));
  const safeSection = escapeSvgText(String(section || '').slice(0, 18));
  const safeSubtitle = escapeSvgText(String(subtitle || '핵심만 정리').slice(0, 20));
  const layoutSvg = layout === 1
    ? `
    <rect x="50" y="104" width="400" height="8" rx="4" fill="${primary}" opacity="0.18"/>
    <text x="250" y="182" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="40" font-weight="900" fill="${text}">${safeKeyword}</text>
    <rect x="76" y="230" width="348" height="62" rx="12" fill="${primary}"/>
    <text x="250" y="261" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#fff">${safeSection}</text>
    <rect x="102" y="328" width="296" height="42" rx="21" fill="${accent}"/>
    <text x="250" y="349" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="17" font-weight="800" fill="${primary}">${safeSubtitle}</text>`
    : layout === 2
      ? `
    <circle cx="250" cy="194" r="82" fill="${accent}"/>
    <text x="250" y="188" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="40" font-weight="900" fill="${text}">${safeKeyword}</text>
    <text x="250" y="242" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="23" font-weight="900" fill="${primary}">${safeSection}</text>
    <rect x="70" y="323" width="360" height="50" rx="8" fill="${primary}"/>
    <text x="250" y="348" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#fff">${safeSubtitle}</text>`
      : `
    <text x="250" y="190" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="42" font-weight="900" fill="${text}">${safeKeyword}</text>
    <rect x="60" y="228" width="380" height="52" rx="5" fill="${primary}"/>
    <text x="250" y="254" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="23" font-weight="900" fill="#fff">${safeSection}</text>
    <rect x="82" y="318" width="336" height="44" rx="5" fill="${accent}"/>
    <text x="250" y="340" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="${primary}">${safeSubtitle}</text>`;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
    <rect width="500" height="500" fill="${bg}"/>
    <rect x="34" y="34" width="104" height="34" rx="8" fill="${primary}"/>
    <text x="86" y="57" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="15" font-weight="800" fill="#fff">${badge}</text>
    ${layoutSvg}
    <rect x="78" y="406" width="344" height="5" fill="${primary}" opacity="0.22"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function buildRewriteDraft({ keyword, topic, platform, ctaUrl, useNaverQr, useAiImages = true, pattern, customTitle = '' }) {
  const title = normalizeTitleValue(customTitle) || makeRewriteTitle(keyword, topic, platform, pattern);
  const bodySectionCount = Math.max(1, (pattern.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount) - 1);
  const sectionTitles = makeSectionTitles(keyword, topic, bodySectionCount);
  const subject = topic || '이 내용';
  const targetSectionChars = pattern.sectionCharCount || DEFAULT_REWRITE_SETTINGS.sectionCharCount;
  const desiredKwCount = pattern.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount;
  const searchIntent = titleIntentTail(keyword, topic, pattern.sourceActionTerms || []);
  const sourceKeywordHint = Array.isArray(pattern.sourceKeywords)
    ? pattern.sourceKeywords.filter((item) => item && item !== keyword).slice(0, 3).join(', ')
    : '';
  const intro = [
    `${subject}을 알아보다 보면 정보는 많은데 정작 지금 나에게 필요한 기준을 한 번에 잡기 어렵습니다.`,
    `그래서 이번 글은 ${keyword}를 중심으로 핵심 흐름과 확인 순서, 놓치기 쉬운 부분을 새롭게 정리했습니다.`,
    `검색 의도는 ${searchIntent}에 맞추고, 주제 범위는 ${sourceKeywordHint || keyword} 흐름 안에서 벗어나지 않게 잡았습니다.`,
    `아래 내용은 참고 글의 문장을 가져온 것이 아니라 글 구성과 분량, 반복 밀도만 반영해 새로 작성한 초안입니다.`,
  ];
  const cta = ctaUrl
    ? [`지금 바로 아래에서 ${keyword} 관련 내용을 확인하세요.`, ctaUrl]
    : [`필요한 부분부터 차근차근 확인해 보세요.`];
  const bodyParts = [title, ''];
  if (useAiImages) {
    bodyParts.push(`[대표이미지: ${title}]`);
    bodyParts.push('');
  }
  bodyParts.push(...intro, '', ...cta, '');

  const makeSectionBody = (section, index) => {
    const sentences = [
      `${index + 1}. ${section}에서는 ${keyword}를 판단할 때 먼저 봐야 할 기준을 간단히 나눠서 정리합니다.`,
      `${subject}은 한 가지 조건만 보고 결정하기보다 상황, 목적, 진행 시점까지 같이 비교해야 결과가 자연스럽습니다.`,
      `특히 검색자가 궁금해하는 지점은 “그래서 내가 지금 무엇을 하면 되는가”이기 때문에 설명은 짧게 끊고 실제 확인 순서 중심으로 배치하는 편이 좋습니다.`,
      `이 단계에서는 ${keyword}의 핵심 기준을 먼저 확인하고, 예외가 생길 수 있는 부분은 따로 표시해두는 방식이 안정적입니다.`,
      `너무 많은 정보를 한꺼번에 넣기보다 필요한 항목을 순서대로 보여주면 모바일에서도 읽는 흐름이 끊기지 않습니다.`,
      `마지막으로 실제 적용 전에는 날짜, 대상, 조건처럼 바뀔 수 있는 값만 한 번 더 확인하는 편이 좋습니다.`,
    ];
    const selected = [];
    while (selected.join('').replace(/\s/g, '').length < targetSectionChars && selected.length < sentences.length) {
      selected.push(sentences[selected.length]);
    }
    return selected;
  };

  const extraImageSlots = Math.max(0, (pattern.imageCount || 0) - 1 - sectionTitles.length);
  let extraImageCursor = 0;

  sectionTitles.forEach((section, index) => {
    bodyParts.push(`> ${section}`);
    bodyParts.push('');
    bodyParts.push(...makeSectionBody(section, index));
    bodyParts.push('');
    if (useAiImages) {
      bodyParts.push(`[이미지 ${index + 1}: ${section}]`);
      bodyParts.push('');
      if (extraImageCursor < extraImageSlots) {
        bodyParts.push(`[보조 이미지 ${extraImageCursor + 1}: ${section} 핵심 카드]`);
        bodyParts.push('');
        extraImageCursor += 1;
      }
    }
  });

  bodyParts.push('> 마무리');
  bodyParts.push('');
  bodyParts.push(`${keyword}는 단순히 정보만 많이 나열한다고 읽히는 주제가 아닙니다.`);
  bodyParts.push(`처음에는 ${subject}의 핵심 기준을 잡고, 중간에는 실제 확인 방법과 주의사항을 배치한 뒤, 마지막에는 바로 실행할 수 있는 요약으로 닫는 구성이 안정적입니다.`);
  bodyParts.push(useNaverQr ? `QR을 함께 넣는다면 도입 CTA 이후나 두 번째 섹션 뒤에 배치하는 흐름이 가장 자연스럽습니다.` : `CTA 링크가 있다면 도입부 직후와 마무리 직전에 한 번씩만 배치하는 편이 깔끔합니다.`);

  let body = bodyParts.join('\n');
  let plainText = body.replace(/\[(?:대표이미지|이미지|보조 이미지)[^\]]+\]/g, '').replace(/^>\s*/gm, '').trim();
  let charCount = plainText.replace(/\s/g, '').length;
  let kwCount = (plainText.match(new RegExp(escapeRegExp(keyword), 'gi')) || []).length;
  const reinforcement = [
    `${keyword}를 볼 때는 핵심 조건과 실제 확인 순서를 함께 두면 판단이 훨씬 쉬워집니다.`,
    `${keyword} 관련 내용은 한 번에 결론을 내리기보다 최신 기준을 확인한 뒤 적용하는 쪽이 안전합니다.`,
    `${keyword}는 검색자가 바로 실행할 수 있는 정보가 앞쪽에 놓일수록 체감 만족도가 높아집니다.`,
  ];
  let reinforcementIndex = 0;
  while ((kwCount < desiredKwCount || charCount < pattern.targetCharCount * 0.92) && reinforcementIndex < 9) {
    body += `\n${reinforcement[reinforcementIndex % reinforcement.length]}`;
    plainText = body.replace(/\[(?:대표이미지|이미지|보조 이미지)[^\]]+\]/g, '').replace(/^>\s*/gm, '').trim();
    charCount = plainText.replace(/\s/g, '').length;
    kwCount = (plainText.match(new RegExp(escapeRegExp(keyword), 'gi')) || []).length;
    reinforcementIndex += 1;
  }
  const images = useAiImages
    ? Array.from({ length: Math.max(0, pattern.imageCount || 0) }, (_, index) => {
        if (index === 0) return makeTemplateImage({ keyword, section: title, subtitle: '새 글 초안', index, platform });
        const section = sectionTitles[(index - 1) % Math.max(sectionTitles.length, 1)] || title;
        return makeTemplateImage({ keyword, section, subtitle: `${index}번째 핵심`, index, platform });
      })
    : [];

  return {
    title,
    body,
    plainText,
    charCount,
    kwCount,
    imageCount: images.length,
    quoteCount: sectionTitles.length + 1,
    images,
  };
}

function scoreRewriteOutput(output, pattern) {
  const charFit = 100 - Math.min(60, Math.abs(output.charCount - pattern.targetCharCount) / Math.max(pattern.targetCharCount, 1) * 100);
  const kwFit = 100 - Math.min(50, Math.abs(output.kwCount - pattern.targetKwCount) * 5);
  const imageFit = 100 - Math.min(40, Math.abs(output.imageCount - pattern.imageCount) * 8);
  const seo = Math.round((charFit * 0.35) + (kwFit * 0.4) + (imageFit * 0.25));
  const geo = Math.round(Math.min(100, seo + 3));
  const aeo = Math.round(Math.min(100, 70 + output.quoteCount * 3));
  const total = Math.round((seo + geo + aeo) / 3);
  return { seo, geo, aeo, total };
}

function estimateRewriteSimilarityRisk(output, pattern = {}) {
  const text = `${output.title || ''}\n${output.plainText || ''}`;
  const sourceTitles = Array.isArray(pattern.sourceTitles) ? pattern.sourceTitles : [];
  const sourceTextSamples = Array.isArray(pattern.sourceTextSamples) ? pattern.sourceTextSamples : [];
  const exactTitleHits = sourceTitles.filter((title) => {
    const normalized = String(title || '').replace(/\s+/g, ' ').trim();
    return normalized.length >= 16 && text.includes(normalized);
  }).length;
  const copiedHeadingHits = sourceTitles.filter((title) => {
    const compact = String(title || '').replace(/\s+/g, '');
    return compact.length >= 14 && text.replace(/\s+/g, '').includes(compact);
  }).length;
  const outputShingles = textShingles(text, 5);
  const maxTextOverlap = Math.max(
    0,
    ...sourceTextSamples.map((sample) => jaccardSetRatio(outputShingles, textShingles(sample, 5)))
  );
  const paragraphHits = String(output.plainText || '')
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 45)
    .filter((part) => sourceTextSamples.some((sample) => sample.includes(part.slice(0, 45))))
    .length;
  return clampNumber(
    Math.round(3 + exactTitleHits * 12 + copiedHeadingHits * 8 + maxTextOverlap * 85 + paragraphHits * 10),
    2,
    92
  );
}

async function addRewriteEvent(rewriteJobId, eventType, message, payload = {}) {
  await pool.query(
    `INSERT INTO rewrite_job_events (rewrite_job_id, event_type, message, payload)
     VALUES ($1,$2,$3,$4)`,
    [rewriteJobId, eventType, message, JSON.stringify(payload || {})]
  );
}

async function processRewriteJob(jobId) {
  const jobResult = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [jobId]);
  if (jobResult.rows.length === 0) throw new Error('Rewrite job not found');
  const job = jobResult.rows[0];
  const sourceIds = Array.isArray(job.source_analysis_ids) ? job.source_analysis_ids : [];

  await pool.query("UPDATE rewrite_jobs SET status = '패턴 분석중', updated_at = NOW() WHERE id = $1", [jobId]);
  await addRewriteEvent(jobId, 'pattern_started', '선택한 수집글 패턴 분석을 시작했습니다', { sourceIds });

  const analyses = sourceIds.length
    ? (await pool.query('SELECT * FROM source_analyses WHERE id = ANY($1::int[])', [sourceIds])).rows
    : [];
  const settings = parseRewriteSettings(job.settings_json);
  const pattern = buildRewritePattern(analyses, settings);

  await pool.query(
    "UPDATE rewrite_jobs SET status = '초안 생성중', pattern_json = $2, updated_at = NOW() WHERE id = $1",
    [jobId, JSON.stringify(pattern)]
  );
  await addRewriteEvent(jobId, 'draft_started', '재각색 초안을 생성합니다', { pattern });

  const output = buildRewriteDraft({
    keyword: job.target_keyword,
    topic: job.target_topic,
    platform: job.platform,
    ctaUrl: job.cta_url,
    useNaverQr: job.use_naver_qr,
    useAiImages: job.use_ai_images,
    pattern,
    customTitle: job.custom_title,
  });

  await pool.query("UPDATE rewrite_jobs SET status = '이미지 생성중', updated_at = NOW() WHERE id = $1", [jobId]);
  await addRewriteEvent(jobId, 'images_generated', '템플릿 이미지 세트를 생성했습니다', { count: output.images.length });

  const scores = scoreRewriteOutput(output, pattern);
  const similarityRisk = estimateRewriteSimilarityRisk(output, pattern);
  const finalStatus = similarityRisk >= 45 ? '검수 필요' : '완료';
  const { rows } = await pool.query(
    `UPDATE rewrite_jobs
     SET status = $2,
         title = $3,
         body = $4,
         plain_text = $5,
         char_count = $6,
         kw_count = $7,
         image_count = $8,
         quote_count = $9,
         seo_score = $10,
         geo_score = $11,
         aeo_score = $12,
         total_score = $13,
         similarity_risk = $14,
         images_json = $15,
         error_message = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      jobId,
      finalStatus,
      output.title,
      output.body,
      output.plainText,
      output.charCount,
      output.kwCount,
      output.imageCount,
      output.quoteCount,
      scores.seo,
      scores.geo,
      scores.aeo,
      scores.total,
      similarityRisk,
      JSON.stringify(output.images.map((url, index) => ({ index, type: 'template-svg', url }))),
    ]
  );

  await addRewriteEvent(jobId, 'completed', '재각색 작업이 완료되었습니다', { finalStatus, scores, similarityRisk });
  return rows[0];
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function saveCollectionAnalysis(link, analysis, fetchStatus = 'server_collected') {
  const inserted = await pool.query(
    `INSERT INTO source_analyses (
      source_link_id, source_url, source_text_preview, keyword, category, platform, title,
      plain_text, char_count, kw_count, image_count, subheadings, links, has_video,
      platform_guess, keyword_candidates, main_keyword, category_guess, structure_json,
      tone_summary, blog_name, blog_id, blog_home_url, blog_title, blog_nickname,
      today_view_count, total_view_count, today_view_source, total_view_source,
      post_view_count, post_view_source, view_count_checked_at,
      quote_blocks, repeated_terms, quote_repeated_terms, fetch_status, error_message
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
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
      analysis.blogName || null,
      analysis.blogId || null,
      analysis.blogHomeUrl || null,
      analysis.blogTitle || null,
      analysis.blogNickname || null,
      analysis.todayViewCount,
      analysis.totalViewCount,
      analysis.todayViewSource || null,
      analysis.totalViewSource || null,
      analysis.postViewCount,
      analysis.postViewSource || null,
      analysis.viewCountCheckedAt || null,
      JSON.stringify(analysis.quoteBlocks || []),
      JSON.stringify(analysis.repeatedTerms || []),
      JSON.stringify(analysis.quoteRepeatedTerms || []),
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
  let collectedBlog = null;
  let collectedCafePost = null;
  try {
    collectedBlog = await upsertCollectedBlogFromAnalysis(updated.rows[0], saved);
  } catch (err) {
    console.warn('[collections] collected blog upsert failed:', err.message);
  }
  try {
    collectedCafePost = await upsertCollectedCafePostFromAnalysis(updated.rows[0], saved);
  } catch (err) {
    console.warn('[collections] collected cafe post upsert failed:', err.message);
  }

  return {
    link: updated.rows[0],
    batch,
    collectedBlog,
    collectedCafePost,
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
      blogName: saved.blog_name,
      blogId: saved.blog_id,
      blogHomeUrl: saved.blog_home_url,
      blogTitle: saved.blog_title,
      blogNickname: saved.blog_nickname,
      todayViewCount: saved.today_view_count,
      totalViewCount: saved.total_view_count,
      postViewCount: saved.post_view_count,
      quoteBlocks: saved.quote_blocks || [],
      repeatedTerms: saved.repeated_terms || [],
      quoteRepeatedTerms: saved.quote_repeated_terms || [],
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
    const mobileHtml = await fetchNaverMobileHtml(link.url);
    const blogHomeHtml = await fetchNaverBlogHomeHtml(link.url);
    const analysis = buildSourceAnalysis({
      sourceUrl: link.url,
      html,
      mobileHtml,
      blogHomeHtml,
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

function normalizeTenantId(value = '') {
  return String(value || 'owner').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'owner';
}

function tenantIdFromReq(req) {
  return normalizeTenantId(req.headers['x-naviwrite-tenant'] || req.query.tenantId || req.body?.tenantId || 'owner');
}

function normalizePublishMode(value = '') {
  const mode = String(value || '').toLowerCase();
  if (['now', 'immediate', '즉시발행'].includes(mode)) return 'immediate';
  if (['scheduled', '예약발행'].includes(mode)) return 'scheduled';
  return 'draft';
}

function normalizePublishStatus(value = '') {
  const status = String(value || '').trim();
  const allowed = new Set(['초안대기', '발행대기', '예약대기', '발행중', '발행완료', 'RSS확인완료', '성과추적중', '오류']);
  return allowed.has(status) ? status : '초안대기';
}

function normalizeOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDelaySeconds(value, fallback, min, max) {
  return clampNumber(parseInt(value, 10) || fallback, min, max);
}

function normalizeRssUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const blogId = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  return blogId ? `https://rss.blog.naver.com/${blogId}.xml` : null;
}

function normalizeJobInput(body = {}) {
  const scores = body.scores || {};
  const qrStatus = body.qr_status || body.qrStatus || 'QR 생성 필요';
  const generationStatus = body.generation_status || body.generationStatus || '대기중';
  const editorStatus = body.editor_status || body.editorStatus || '검수 필요';
  const publishMode = normalizePublishMode(body.publish_mode || body.publishMode);
  const publishStatus = body.publish_status || body.publishStatus
    || (publishMode === 'scheduled' ? '예약대기' : publishMode === 'immediate' ? '발행대기' : '초안대기');

  return {
    tenant_id: normalizeTenantId(body.tenant_id || body.tenantId || 'owner'),
    created_by_user_id: body.created_by_user_id || body.createdByUserId || null,
    rewrite_job_id: body.rewrite_job_id || body.rewriteJobId || null,
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
    publish_account_platform: body.publish_account_platform || body.publishAccountPlatform || body.platform || 'blog',
    learning_status: body.learning_status || body.learningStatus || '학습 필요',
    login_status: body.login_status || body.loginStatus || '계정 확인 필요',
    publish_mode: publishMode,
    scheduled_at: normalizeOptionalDate(body.scheduled_at || body.scheduledAt),
    publish_status: normalizePublishStatus(publishStatus),
    action_delay_min_seconds: normalizeDelaySeconds(body.action_delay_min_seconds ?? body.actionDelayMinSeconds, 1, 0, 30),
    action_delay_max_seconds: normalizeDelaySeconds(body.action_delay_max_seconds ?? body.actionDelayMaxSeconds, 3, 1, 60),
    between_posts_delay_minutes: normalizeDelaySeconds(body.between_posts_delay_minutes ?? body.betweenPostsDelayMinutes, 45, 1, 240),
    rss_url: normalizeRssUrl(body.rss_url || body.rssUrl),
    rss_match_status: body.rss_match_status || body.rssMatchStatus || null,
    rss_match_score: body.rss_match_score ?? body.rssMatchScore ?? 0,
    rss_item_title: body.rss_item_title || body.rssItemTitle || null,
    rss_item_published_at: normalizeOptionalDate(body.rss_item_published_at || body.rssItemPublishedAt),
    published_url: body.published_url || body.publishedUrl || null,
    published_at: normalizeOptionalDate(body.published_at || body.publishedAt),
    obsidian_export_status: body.obsidian_export_status || body.obsidianExportStatus || '관리자전용',
  };
}

function jobToSheetPayload(job) {
  return {
    id: job.id,
    tenantId: job.tenant_id,
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
    publishMode: job.publish_mode,
    scheduledAt: job.scheduled_at,
    publishStatus: job.publish_status,
    publishedUrl: job.published_url,
    rssUrl: job.rss_url,
    rssMatchStatus: job.rss_match_status,
    rssMatchScore: job.rss_match_score,
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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rssUrlForJob(job = {}) {
  if (job.rss_url) return job.rss_url;
  const source = job.published_url || job.source_url || '';
  const blogId = extractNaverBlogId(source);
  return blogId ? `https://rss.blog.naver.com/${blogId}.xml` : null;
}

function extractXmlTag(xml = '', tag = '') {
  const match = String(xml).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return '';
  return decodeHtmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function parseRssItems(xml = '') {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    const title = stripHtml(extractXmlTag(block, 'title'));
    const link = stripHtml(extractXmlTag(block, 'link'));
    const pubDate = stripHtml(extractXmlTag(block, 'pubDate'));
    const description = stripHtml(extractXmlTag(block, 'description'));
    const date = pubDate ? new Date(pubDate) : null;
    return {
      title,
      link,
      pubDate: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      description,
    };
  }).filter((item) => item.title || item.link).slice(0, 20);
}

function scorePublicationMatch(job = {}, item = {}) {
  const titleScore = overlapRatio(job.title || job.keyword || '', item.title || '');
  const keywordHit = item.title?.includes(job.keyword) ? 0.25 : 0;
  const linkHint = job.published_url && item.link === job.published_url ? 0.35 : 0;
  return clampNumber(Math.round((titleScore + keywordHit + linkHint) * 100), 0, 100);
}

async function saveGeneratedImagesForContentJob({ tenantId, contentJobId, rewriteJob }) {
  const images = parseJsonArray(rewriteJob.images_json);
  if (images.length === 0) return [];

  await pool.query('DELETE FROM generated_images WHERE content_job_id = $1', [contentJobId]);
  const saved = [];
  for (const image of images) {
    const index = Number(image.index || 0);
    const { rows } = await pool.query(
      `INSERT INTO generated_images (
         tenant_id, content_job_id, rewrite_job_id, image_type, section_no,
         prompt, storage_provider, file_path, public_url, data_url, width, height, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'생성완료')
       RETURNING *`,
      [
        tenantId,
        contentJobId,
        rewriteJob.id,
        index === 0 ? 'cover' : 'section',
        index,
        image.prompt || image.title || `${rewriteJob.target_keyword} image ${index}`,
        String(image.url || '').startsWith('data:') ? 'data-url' : 'external-url',
        `generated/${tenantId}/job-${contentJobId}/image-${String(index).padStart(2, '0')}.svg`,
        String(image.url || '').startsWith('data:') ? null : image.url,
        String(image.url || '').startsWith('data:') ? image.url : null,
        500,
        500,
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

function buildObsidianMarkdown(job = {}, images = []) {
  const frontmatter = [
    '---',
    `tenant: ${job.tenant_id || 'owner'}`,
    `keyword: ${JSON.stringify(job.keyword || '')}`,
    `platform: ${job.platform || 'blog'}`,
    `category: ${JSON.stringify(job.category || '')}`,
    `publish_mode: ${job.publish_mode || 'draft'}`,
    `publish_status: ${JSON.stringify(job.publish_status || '')}`,
    `scheduled_at: ${job.scheduled_at || ''}`,
    `published_url: ${job.published_url || ''}`,
    `rss_url: ${job.rss_url || ''}`,
    `seo_score: ${Math.round(Number(job.seo_score || 0))}`,
    `geo_score: ${Math.round(Number(job.geo_score || 0))}`,
    `aeo_score: ${Math.round(Number(job.aeo_score || 0))}`,
    `created_at: ${job.created_at || ''}`,
    '---',
    '',
  ].join('\n');
  const imageList = images.length
    ? images.map((image) => `- ${image.image_type} #${image.section_no}: ${image.file_path || image.public_url || 'data-url'}`).join('\n')
    : '- 이미지 없음';
  return `${frontmatter}# ${job.title || job.keyword}\n\n## 발행 정보\n\n- 계정: ${job.publish_account_label || '-'}\n- 모드: ${job.publish_mode || 'draft'}\n- 상태: ${job.publish_status || '-'}\n- URL: ${job.published_url || '-'}\n\n## 키워드/성과\n\n- 메인 키워드: ${job.keyword || '-'}\n- 글자수: ${job.char_count || 0}\n- KW 반복: ${job.kw_count || 0}\n- 이미지: ${job.image_count || 0}\n\n## 이미지\n\n${imageList}\n\n## 본문\n\n${job.plain_text || job.body || ''}\n`;
}

function isOwnerTenant(req) {
  return tenantIdFromReq(req) === 'owner' || String(req.headers['x-naviwrite-role'] || '').toLowerCase() === 'owner';
}

async function loadTenantContentJob(req, id) {
  const tenantId = tenantIdFromReq(req);
  const { rows } = await pool.query(
    `SELECT *
     FROM content_jobs
     WHERE id = $1
       AND COALESCE(tenant_id, 'owner') = $2
     LIMIT 1`,
    [id, tenantId]
  );
  return rows[0] || null;
}

async function loadGeneratedImages(contentJobId) {
  const { rows } = await pool.query(
    `SELECT *
     FROM generated_images
     WHERE content_job_id = $1
     ORDER BY image_type = 'cover' DESC, section_no ASC, id ASC`,
    [contentJobId]
  );
  return rows;
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
  let mobileHtml = '';
  let blogHomeHtml = '';
  let fetchStatus = sourceText ? 'text_provided' : 'fetched';
  let errorMessage = null;

  try {
    if (sourceUrl) {
      html = await fetchSourceHtml(sourceUrl);
      mobileHtml = await fetchNaverMobileHtml(sourceUrl);
      blogHomeHtml = await fetchNaverBlogHomeHtml(sourceUrl);
    }
  } catch (err) {
    fetchStatus = 'fetch_failed';
    errorMessage = err.message;
  }

  const analysis = buildSourceAnalysis({
    sourceUrl,
    sourceText,
    html,
    mobileHtml,
    blogHomeHtml,
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
        tone_summary, blog_name, blog_id, blog_home_url, blog_title, blog_nickname,
        today_view_count, total_view_count, today_view_source, total_view_source,
        post_view_count, post_view_source, view_count_checked_at,
        quote_blocks, repeated_terms, quote_repeated_terms, fetch_status, error_message
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
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
        analysis.blogName,
        analysis.blogId,
        analysis.blogHomeUrl,
        analysis.blogTitle,
        analysis.blogNickname,
        analysis.todayViewCount,
        analysis.totalViewCount,
        analysis.todayViewSource,
        analysis.totalViewSource,
        analysis.postViewCount,
        analysis.postViewSource,
        analysis.viewCountCheckedAt,
        JSON.stringify(analysis.quoteBlocks),
        JSON.stringify(analysis.repeatedTerms),
        JSON.stringify(analysis.quoteRepeatedTerms),
        analysis.fetchStatus,
        analysis.errorMessage,
      ]
    );
    let collectedBlog = null;
    let collectedCafePost = null;
    try {
      collectedBlog = await upsertCollectedBlogFromAnalysis({ id: null, url: sourceUrl }, rows[0]);
    } catch (err) {
      console.warn('[source analyze] collected blog upsert failed:', err.message);
    }
    try {
      collectedCafePost = await upsertCollectedCafePostFromAnalysis({ id: null, url: sourceUrl }, rows[0]);
    } catch (err) {
      console.warn('[source analyze] collected cafe post upsert failed:', err.message);
    }

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
        blogName: rows[0].blog_name,
        blogId: rows[0].blog_id,
        blogHomeUrl: rows[0].blog_home_url,
        blogTitle: rows[0].blog_title,
        blogNickname: rows[0].blog_nickname,
        todayViewCount: rows[0].today_view_count,
        totalViewCount: rows[0].total_view_count,
        postViewCount: rows[0].post_view_count,
        quoteBlocks: rows[0].quote_blocks || [],
        repeatedTerms: rows[0].repeated_terms || [],
        quoteRepeatedTerms: rows[0].quote_repeated_terms || [],
        fetchStatus: rows[0].fetch_status,
        errorMessage: rows[0].error_message,
        createdAt: rows[0].created_at,
      },
      collectedBlog,
      collectedCafePost,
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
         ON CONFLICT (url) DO NOTHING
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
              sa.corrected_main_keyword,
              sa.category_guess,
              sa.char_count,
              sa.kw_count,
              sa.image_count,
              sa.subheadings,
              sa.keyword_candidates,
              sa.blog_name,
              sa.blog_id,
              sa.blog_home_url,
              sa.blog_title,
              sa.blog_nickname,
              sa.today_view_count,
              sa.total_view_count,
              sa.today_view_source,
              sa.total_view_source,
              sa.post_view_count,
              sa.post_view_source,
              sa.view_count_checked_at,
              sa.quote_blocks,
              sa.repeated_terms,
              sa.quote_repeated_terms,
              rj.id AS rewrite_job_id,
              rj.status AS rewrite_status,
              rj.title AS rewrite_title,
              rj.target_keyword AS rewrite_target_keyword,
              rj.char_count AS rewrite_char_count,
              rj.kw_count AS rewrite_kw_count,
              rj.image_count AS rewrite_image_count,
              rj.total_score AS rewrite_total_score,
              rj.similarity_risk AS rewrite_similarity_risk,
              rj.created_at AS rewrite_created_at,
              cj.id AS content_job_id,
              cj.publish_status,
              cj.published_url,
              cj.generation_status AS content_generation_status,
              cj.qr_status AS content_qr_status
       FROM source_links sl
       LEFT JOIN collection_batches cb ON cb.id = sl.batch_id
       LEFT JOIN source_analyses sa ON sa.id = sl.source_analysis_id
       LEFT JOIN LATERAL (
         SELECT *
         FROM rewrite_jobs rj
         WHERE sa.id IS NOT NULL
           AND rj.source_analysis_ids @> jsonb_build_array(sa.id)
         ORDER BY jsonb_array_length(rj.source_analysis_ids) ASC, rj.created_at DESC
         LIMIT 1
       ) rj ON TRUE
       LEFT JOIN LATERAL (
         SELECT *
         FROM content_jobs cj
         WHERE cj.rewrite_job_id = rj.id
         ORDER BY cj.created_at DESC
         LIMIT 1
       ) cj ON TRUE
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

router.patch('/collections/links/:id/main-keyword', async (req, res) => {
  try {
    const correctedMainKeyword = normalizeKeywordValue(
      req.body?.correctedMainKeyword ?? req.body?.corrected_main_keyword ?? ''
    );
    const current = await pool.query(
      `SELECT sl.id, sl.source_analysis_id, sa.plain_text, sa.main_keyword, sa.keyword
       FROM source_links sl
       LEFT JOIN source_analyses sa ON sa.id = sl.source_analysis_id
       WHERE sl.id = $1`,
      [req.params.id]
    );
    if (current.rows.length === 0) return res.status(404).json({ error: 'Source link not found' });
    const row = current.rows[0];
    if (!row.source_analysis_id) return res.status(400).json({ error: '수집완료 후 수정할 수 있습니다' });

    const effectiveKeyword = correctedMainKeyword || row.main_keyword || row.keyword || '';
    const kwCount = countKeywordInText(row.plain_text || '', effectiveKeyword);
    const { rows } = await pool.query(
      `UPDATE source_analyses
       SET corrected_main_keyword = $2,
           keyword = $3,
           kw_count = $4
       WHERE id = $1
       RETURNING id, main_keyword, corrected_main_keyword, keyword, kw_count`,
      [row.source_analysis_id, correctedMainKeyword || null, effectiveKeyword || null, kwCount]
    );
    res.json({ ok: true, analysis: rows[0] });
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
    const quoteBlocks = Array.isArray(body.quoteBlocks) ? body.quoteBlocks.filter(Boolean).slice(0, 30) : [];
    const repeatedTerms = Array.isArray(body.repeatedTerms) ? body.repeatedTerms.slice(0, 30) : inferRepeatedTerms(text, 2);
    const quoteRepeatedTerms = Array.isArray(body.quoteRepeatedTerms)
      ? body.quoteRepeatedTerms.slice(0, 30)
      : quoteBlocks.length ? inferRepeatedTerms(quoteBlocks.join('\n'), 2) : [];
    const blogHomeHtml = await fetchNaverBlogHomeHtml(link.url);
    const blogIdentity = extractBlogIdentity({ sourceUrl: link.url, blogHomeHtml });
    const blogVisitorCounts = extractBlogVisitorCounts(blogHomeHtml);
    const todayViewCount = body.todayViewCount ?? blogVisitorCounts.todayViewCount ?? null;
    const totalViewCount = body.totalViewCount ?? blogVisitorCounts.totalViewCount ?? null;
    const todayViewSource = body.todayViewSource || (todayViewCount === null ? null : blogVisitorCounts.source || 'm.blog.naver.com');
    const totalViewSource = body.totalViewSource || (totalViewCount === null ? null : blogVisitorCounts.source || 'm.blog.naver.com');
    const postViewCount = body.postViewCount ?? body.viewCount ?? null;
    const postViewSource = body.postViewSource || (postViewCount === null ? null : 'cafe.naver.com');

    const inserted = await pool.query(
      `INSERT INTO source_analyses (
        source_link_id, source_url, source_text_preview, keyword, category, platform, title,
        plain_text, char_count, kw_count, image_count, subheadings, links, has_video,
        platform_guess, keyword_candidates, main_keyword, category_guess, structure_json,
        tone_summary, blog_name, blog_id, blog_home_url, blog_title, blog_nickname,
        today_view_count, total_view_count, today_view_source, total_view_source,
        post_view_count, post_view_source, view_count_checked_at,
        quote_blocks, repeated_terms, quote_repeated_terms, fetch_status, error_message
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,'extension_collected',NULL)
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
        body.blogName || blogIdentity.blogName || null,
        body.blogId || blogIdentity.blogId || null,
        body.blogHomeUrl || blogIdentity.blogHomeUrl || null,
        body.blogTitle || blogIdentity.blogTitle || null,
        body.blogNickname || blogIdentity.blogNickname || null,
        todayViewCount,
        totalViewCount,
        todayViewSource,
        totalViewSource,
        postViewCount,
        postViewSource,
        body.viewCountCheckedAt || (blogHomeHtml || postViewCount !== null ? new Date().toISOString() : null),
        JSON.stringify(quoteBlocks),
        JSON.stringify(repeatedTerms),
        JSON.stringify(quoteRepeatedTerms),
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
    let collectedBlog = null;
    let collectedCafePost = null;
    try {
      collectedBlog = await upsertCollectedBlogFromAnalysis(updated.rows[0], analysis);
    } catch (err) {
      console.warn('[extension collection] collected blog upsert failed:', err.message);
    }
    try {
      collectedCafePost = await upsertCollectedCafePostFromAnalysis(updated.rows[0], analysis);
    } catch (err) {
      console.warn('[extension collection] collected cafe post upsert failed:', err.message);
    }

    res.json({
      link: updated.rows[0],
      batch,
      collectedBlog,
      collectedCafePost,
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
        blogName: analysis.blog_name,
        blogId: analysis.blog_id,
        blogHomeUrl: analysis.blog_home_url,
        blogTitle: analysis.blog_title,
        blogNickname: analysis.blog_nickname,
        todayViewCount: analysis.today_view_count,
        totalViewCount: analysis.total_view_count,
        postViewCount: analysis.post_view_count,
        quoteBlocks: analysis.quote_blocks || [],
        repeatedTerms: analysis.repeated_terms || [],
        quoteRepeatedTerms: analysis.quote_repeated_terms || [],
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

router.get('/collections/blogs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
    const values = [];
    const where = [];
    if (req.query.category) {
      values.push(req.query.category);
      where.push(`cb.category = $${values.length}`);
    }
    values.push(limit);

    const { rows } = await pool.query(
      `SELECT cb.*,
              latest.snapshot_date,
              latest.today_view_count,
              latest.total_view_count,
              latest.previous_total_view_count,
              latest.daily_view_count,
              latest.source AS snapshot_source,
              latest.checked_at AS snapshot_checked_at
       FROM collected_blogs cb
       LEFT JOIN LATERAL (
         SELECT *
         FROM blog_view_snapshots bvs
         WHERE bvs.collected_blog_id = cb.id
         ORDER BY bvs.snapshot_date DESC
         LIMIT 1
       ) latest ON TRUE
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY cb.category ASC, cb.updated_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/collections/blogs/snapshot-daily', async (req, res) => {
  try {
    const results = await snapshotCollectedBlogs({
      limit: req.body?.limit || req.query.limit || 100,
      category: req.body?.category || req.query.category || null,
      mode: req.body?.mode || req.query.mode || 'realtime',
    });
    res.json({
      ok: true,
      snapshotDate: kstDateString(),
      processed: results.length,
      collected: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/views/status', async (req, res) => {
  try {
    const platform = req.query.platform === 'cafe' ? 'cafe' : 'blog';
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);

    if (platform === 'cafe') {
      const { rows } = await pool.query(
        `SELECT ccp.*,
                latest.snapshot_date,
                latest.view_count,
                latest.previous_view_count,
                latest.daily_increase,
                latest.source AS snapshot_source,
                latest.checked_at AS snapshot_checked_at
         FROM collected_cafe_posts ccp
         LEFT JOIN LATERAL (
           SELECT *
           FROM cafe_post_view_snapshots cpvs
           WHERE cpvs.cafe_post_id = ccp.id
           ORDER BY cpvs.snapshot_date DESC
           LIMIT 1
         ) latest ON TRUE
         WHERE COALESCE(ccp.last_view_count, 0) >= 10
         ORDER BY COALESCE(latest.daily_increase, ccp.last_daily_increase, 0) DESC,
                  ccp.updated_at DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({
        platform,
        items: rows,
        stats: {
          total: rows.length,
          overThreshold: rows.filter((item) => Number(item.last_view_count || item.view_count || 0) >= 10).length,
          totalIncrease: rows.reduce((sum, item) => sum + Number(item.daily_increase || item.last_daily_increase || 0), 0),
        },
      });
    }

    const { rows } = await pool.query(
      `SELECT cb.*,
              latest.snapshot_date,
              latest.today_view_count,
              latest.total_view_count,
              latest.previous_total_view_count,
              latest.daily_view_count,
              latest.is_day_closed,
              latest.daily_view_source,
              latest.source AS snapshot_source,
              latest.checked_at AS snapshot_checked_at,
              closed.snapshot_date AS closed_snapshot_date,
              closed.daily_view_count AS closed_daily_view_count,
              closed.daily_view_source AS closed_daily_view_source,
              closed.checked_at AS closed_checked_at
       FROM collected_blogs cb
       LEFT JOIN LATERAL (
         SELECT *
         FROM blog_view_snapshots bvs
         WHERE bvs.collected_blog_id = cb.id
         ORDER BY bvs.snapshot_date DESC
         LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT *
         FROM blog_view_snapshots bvs
         WHERE bvs.collected_blog_id = cb.id
           AND bvs.is_day_closed = TRUE
         ORDER BY bvs.snapshot_date DESC
         LIMIT 1
       ) closed ON TRUE
       ORDER BY cb.updated_at DESC
       LIMIT $1`,
      [limit]
    );
    const startDate = kstDateString(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
    const history = await pool.query(
      `SELECT snapshot_date,
              SUM(COALESCE(daily_view_count, 0))::int AS daily_view_count,
              COUNT(*)::int AS blog_count
       FROM blog_view_snapshots
       WHERE is_day_closed = TRUE
         AND snapshot_date >= $1
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`,
      [startDate]
    );
    const blogIds = rows.map((item) => item.id).filter(Boolean);
    const perBlogHistory = blogIds.length
      ? await pool.query(
        `SELECT bvs.collected_blog_id,
                cb.blog_name,
                cb.blog_title,
                cb.blog_nickname,
                cb.blog_id,
                bvs.snapshot_date,
                COALESCE(bvs.daily_view_count, 0)::int AS daily_view_count
         FROM blog_view_snapshots bvs
         JOIN collected_blogs cb ON cb.id = bvs.collected_blog_id
         WHERE bvs.is_day_closed = TRUE
           AND bvs.snapshot_date >= $1
           AND bvs.collected_blog_id = ANY($2::int[])
         ORDER BY bvs.snapshot_date ASC, cb.updated_at DESC`,
        [startDate, blogIds]
      )
      : { rows: [] };
    const closedDailyViews = rows.reduce((sum, item) => sum + Number(item.closed_daily_view_count || 0), 0);
    return res.json({
      platform,
      items: rows,
      history: history.rows,
      perBlogHistory: perBlogHistory.rows,
      stats: {
        total: rows.length,
        realtimeTotalViews: rows.reduce((sum, item) => sum + Number(item.last_total_view_count || item.total_view_count || 0), 0),
        todayCurrentViews: rows.reduce((sum, item) => sum + Number(item.last_today_view_count || item.today_view_count || 0), 0),
        closedDailyViews,
        dailyViews: closedDailyViews,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/views/status/refresh', async (req, res) => {
  try {
    const platform = req.body?.platform || req.query.platform || 'blog';
    const limit = req.body?.limit || req.query.limit || 100;
    const category = req.body?.category || req.query.category || null;
    const results = platform === 'cafe'
      ? await snapshotCollectedCafePosts({ limit, category })
      : await snapshotCollectedBlogs({ limit, category });
    res.json({
      ok: true,
      platform: platform === 'cafe' ? 'cafe' : 'blog',
      snapshotDate: kstDateString(),
      processed: results.length,
      collected: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rewrite-settings/benchmark', async (req, res) => {
  try {
    const url = req.query.url || DEFAULT_REWRITE_SETTINGS.benchmarkUrl;
    const limit = clampNumber(parseInt(req.query.limit || '20', 10) || 20, 1, 30);
    const result = await benchmarkRewriteSettingsFromUrl(url, limit);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/title-recommendations', async (req, res) => {
  try {
    const sourceAnalysisIds = normalizeIdList(req.body?.sourceAnalysisIds);
    const sourceLinkIds = normalizeIdList(req.body?.sourceLinkIds);
    let resolvedSourceAnalysisIds = [...sourceAnalysisIds];

    if (sourceLinkIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT source_analysis_id
         FROM source_links
         WHERE id = ANY($1::int[])
           AND source_analysis_id IS NOT NULL`,
        [sourceLinkIds]
      );
      resolvedSourceAnalysisIds = [
        ...new Set([
          ...resolvedSourceAnalysisIds,
          ...rows.map((row) => row.source_analysis_id).filter(Boolean),
        ]),
      ];
    }

    const analyses = resolvedSourceAnalysisIds.length
      ? (await pool.query('SELECT * FROM source_analyses WHERE id = ANY($1::int[])', [resolvedSourceAnalysisIds])).rows
      : [];
    const platform = normalizePlatform(req.body?.platform || analyses[0]?.platform_guess || analyses[0]?.platform || 'blog');
    const category = req.body?.category || analyses[0]?.category_guess || analyses[0]?.category || 'general';
    const topic = normalizeTitleValue(req.body?.topic || req.body?.targetTopic || '');
    const keyword = normalizeKeywordValue(
      req.body?.keyword
      || req.body?.targetKeyword
      || analyses.map(effectiveMainKeyword).find(Boolean)
      || ''
    );

    if (!keyword) {
      return res.status(400).json({ error: '추천할 메인 키워드가 없습니다. 수집 링크를 선택하거나 키워드를 입력하세요.' });
    }

    const sourceTitles = analyses.map((row) => row.title).filter(Boolean).slice(0, 20);
    const sourceActionTerms = titleRecommendationActions(`${sourceTitles.join(' ')} ${topic} ${category}`);
    const credentials = naverSearchCredentials(req.body);
    let hasNaverSearch = Boolean(credentials);
    let naverWarning = '';
    let baseSearch = { total: null, items: [] };

    if (credentials) {
      try {
        baseSearch = await fetchNaverSearchResults({ query: keyword, platform, credentials, display: 10 });
      } catch (err) {
        hasNaverSearch = false;
        naverWarning = err.message;
      }
    }

    const baseSerpTitles = baseSearch.items.map((item) => item.title).filter(Boolean);
    const candidates = generateTitleCandidates({ keyword, topic, platform, category, analyses })
      .slice(0, clampNumber(parseInt(req.body?.limit || '8', 10) || 8, 4, 12));

    const scored = [];
    for (const title of candidates) {
      let candidateSearch = { total: null, items: [] };
      let candidateWarning = '';
      if (credentials && hasNaverSearch) {
        try {
          candidateSearch = await fetchNaverSearchResults({ query: title, platform, credentials, display: 5 });
        } catch (err) {
          candidateWarning = err.message;
        }
      }
      const serpTitles = candidateSearch.items.length
        ? candidateSearch.items.map((item) => item.title).filter(Boolean)
        : baseSerpTitles;
      const score = scoreTitleCandidate({
        title,
        keyword,
        topic,
        actionTerms: sourceActionTerms,
        sourceTitles,
        serpTitles,
        total: candidateSearch.total ?? baseSearch.total,
      });
      scored.push({
        title,
        ...score,
        serp: {
          total: candidateSearch.total ?? baseSearch.total,
          topTitles: serpTitles.slice(0, 5),
        },
        warning: candidateWarning,
      });
    }

    scored.sort((a, b) => b.score - a.score || a.duplicateRisk - b.duplicateRisk);

    res.json({
      ok: true,
      keyword,
      topic,
      platform,
      category,
      hasNaverSearch,
      naverWarning,
      sourceActionTerms,
      serpTopTerms: titleRecommendationActions(baseSerpTitles.join(' ')),
      candidates: scored,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rewrite-jobs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
    const values = [];
    const where = [];
    if (req.query.status) {
      values.push(req.query.status);
      where.push(`status = $${values.length}`);
    }
    values.push(limit);
    const { rows } = await pool.query(
      `SELECT *
       FROM rewrite_jobs
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

router.get('/rewrite-jobs/:id', async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });
    const events = await pool.query(
      'SELECT * FROM rewrite_job_events WHERE rewrite_job_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ ...job.rows[0], events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs', async (req, res) => {
  try {
    const rawKeywordInput = req.body?.targetKeywords || req.body?.keywordsText || req.body?.keyword || '';
    let keywords = parseTargetKeywords(rawKeywordInput);
    const hasExplicitKeywords = keywords.length > 0;

    const sourceAnalysisIds = normalizeIdList(req.body?.sourceAnalysisIds);
    const sourceLinkIds = normalizeIdList(req.body?.sourceLinkIds);
    let resolvedSourceAnalysisIds = [...sourceAnalysisIds];
    if (sourceLinkIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT source_analysis_id
         FROM source_links
         WHERE id = ANY($1::int[])
           AND source_analysis_id IS NOT NULL`,
        [sourceLinkIds]
      );
      resolvedSourceAnalysisIds = [
        ...new Set([
          ...resolvedSourceAnalysisIds,
          ...rows.map((row) => row.source_analysis_id).filter(Boolean),
        ]),
      ];
    }
    const sourceRows = resolvedSourceAnalysisIds.length
      ? (await pool.query(
          `SELECT *
           FROM source_analyses
           WHERE id = ANY($1::int[])
           ORDER BY array_position($1::int[], id)`,
          [resolvedSourceAnalysisIds]
        )).rows
      : [];
    const sourceRowMode = Boolean(req.body?.sourceRowMode || req.body?.source_row_mode) || (!hasExplicitKeywords && sourceRows.length > 0);
    if (!hasExplicitKeywords && sourceRows.length > 0) {
      keywords = sourceRows.map(effectiveMainKeyword).filter(Boolean);
    }
    if (keywords.length === 0) return res.status(400).json({ error: '재각색할 키워드를 입력하거나 수집완료 링크를 선택해 주세요' });

    const platform = normalizePlatform(req.body?.platform || 'blog');
    const category = req.body?.category || 'general';
    const targetTopic = req.body?.targetTopic || req.body?.topic || '';
    const ctaUrl = req.body?.ctaUrl || req.body?.cta_url || null;
    const useNaverQr = Boolean(req.body?.useNaverQr || req.body?.use_naver_qr);
    const useAiImages = Boolean(req.body?.useAiImages || req.body?.use_ai_images);
    const rewriteSettings = parseRewriteSettings(req.body?.rewriteSettings || req.body?.settings || {});
    const customTitle = normalizeTitleValue(req.body?.customTitle || req.body?.custom_title || req.body?.recommendedTitle || '');

    const rewriteSpecs = sourceRowMode
      ? sourceRows
          .map((row) => ({
            keyword: effectiveMainKeyword(row),
            sourceAnalysisIds: [row.id],
            platform: normalizePlatform(row.platform_guess || row.platform || platform),
            category: row.category_guess || row.category || category,
            targetTopic: targetTopic || '',
          }))
          .filter((spec) => spec.keyword)
      : keywords.map((keyword) => ({
          keyword,
          sourceAnalysisIds: resolvedSourceAnalysisIds,
          platform,
          category,
          targetTopic,
        }));

    const insertedJobs = [];
    for (const spec of rewriteSpecs) {
      const { rows } = await pool.query(
        `INSERT INTO rewrite_jobs (
          target_keyword, target_topic, platform, category, cta_url,
          use_naver_qr, use_ai_images, source_analysis_ids, settings_json, custom_title, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'대기중')
        RETURNING *`,
        [
          spec.keyword,
          spec.targetTopic,
          spec.platform,
          spec.category,
          ctaUrl,
          useNaverQr,
          useAiImages,
          JSON.stringify(spec.sourceAnalysisIds),
          JSON.stringify(rewriteSettings),
          rewriteSpecs.length === 1 ? customTitle : '',
        ]
      );
      await addRewriteEvent(rows[0].id, 'created', '재각색 작업이 등록되었습니다', {
        sourceAnalysisIds: spec.sourceAnalysisIds,
        rewriteSettings,
        sourceRowMode,
      });
      insertedJobs.push(rows[0]);
    }

    const concurrency = clampNumber(parseInt(req.body?.concurrency || '3', 10) || 3, 1, 5);
    const processed = await mapLimit(insertedJobs, concurrency, async (job) => {
      try {
        return await processRewriteJob(job.id);
      } catch (err) {
        const failed = await pool.query(
          `UPDATE rewrite_jobs
           SET status = '오류',
               error_message = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [job.id, err.message]
        );
        await addRewriteEvent(job.id, 'error', '재각색 작업 중 오류가 발생했습니다', { error: err.message });
        return failed.rows[0] || { ...job, status: '오류', error_message: err.message };
      }
    });

    res.json({
      ok: true,
      created: insertedJobs.length,
      processed: processed.length,
      concurrency,
      jobs: processed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs/:id/process', async (req, res) => {
  try {
    const job = await processRewriteJob(req.params.id);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs/:id/to-content-job', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const rewrite = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (rewrite.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });
    const rewriteJob = rewrite.rows[0];
    const input = normalizeJobInput({
      ...req.body,
      tenantId,
      rewriteJobId: rewriteJob.id,
      keyword: rewriteJob.target_keyword,
      category: rewriteJob.category,
      platform: rewriteJob.platform,
      ctaUrl: rewriteJob.cta_url,
      qrTargetUrl: rewriteJob.cta_url,
      title: rewriteJob.title,
      body: rewriteJob.body,
      plainText: rewriteJob.plain_text,
      charCount: rewriteJob.char_count,
      kwCount: rewriteJob.kw_count,
      imageCount: rewriteJob.image_count,
      scores: {
        seo: rewriteJob.seo_score,
        geo: rewriteJob.geo_score,
        aeo: rewriteJob.aeo_score,
        total: rewriteJob.total_score,
      },
      qrStatus: rewriteJob.use_naver_qr ? 'QR 생성 필요' : 'QR 미사용',
      generationStatus: '본문 생성 완료',
      publishMode: req.body?.publishMode || req.body?.publish_mode || 'draft',
      rssUrl: req.body?.rssUrl || req.body?.rss_url || null,
      obsidianExportStatus: '관리자전용',
    });
    const qrName = makeNaverQrName(input.keyword, input.campaign_name || 'rewrite');
    const { rows } = await pool.query(
      `INSERT INTO content_jobs (
         tenant_id, rewrite_job_id, keyword, category, platform, cta_url, qr_target_url,
         title, body, plain_text, char_count, kw_count, image_count,
         seo_score, geo_score, aeo_score, total_score,
         naver_qr_name, qr_status, generation_status, editor_status,
         publish_mode, scheduled_at, publish_status, publish_account_id,
         publish_account_label, publish_account_platform, action_delay_min_seconds,
         action_delay_max_seconds, between_posts_delay_minutes, rss_url, obsidian_export_status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       RETURNING *`,
      [
        input.tenant_id, input.rewrite_job_id, input.keyword, input.category, input.platform,
        input.cta_url, input.qr_target_url, input.title, input.body, input.plain_text,
        input.char_count, input.kw_count, input.image_count, input.seo_score, input.geo_score,
        input.aeo_score, input.total_score, qrName, input.qr_status, input.generation_status,
        input.editor_status, input.publish_mode, input.scheduled_at, input.publish_status,
        input.publish_account_id, input.publish_account_label, input.publish_account_platform,
        input.action_delay_min_seconds, input.action_delay_max_seconds, input.between_posts_delay_minutes,
        input.rss_url, input.obsidian_export_status,
      ]
    );
    const images = await saveGeneratedImagesForContentJob({ tenantId, contentJobId: rows[0].id, rewriteJob });
    await addJobEvent(rows[0].id, 'publish_queue_created', '재각색 작업을 발행 큐로 보냈습니다', {
      rewriteJobId: rewriteJob.id,
      imageCount: images.length,
    });
    res.json({ ok: true, job: rows[0], images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Publish Queue (rewrite -> editor -> RSS confirmation -> owner Obsidian export) ---
router.get('/publish-queue', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const limit = Math.min(parseInt(req.query.limit || '120', 10), 300);
    const { status, mode, keyword } = req.query;
    const where = [`COALESCE(cj.tenant_id, 'owner') = $1`];
    const values = [tenantId];

    if (status) {
      values.push(status);
      where.push(`cj.publish_status = $${values.length}`);
    }
    if (mode) {
      values.push(mode);
      where.push(`cj.publish_mode = $${values.length}`);
    }
    if (keyword) {
      values.push(`%${keyword}%`);
      where.push(`(cj.keyword ILIKE $${values.length} OR cj.title ILIKE $${values.length})`);
    }

    values.push(limit);
    const { rows } = await pool.query(
      `SELECT cj.*,
              COUNT(gi.id)::int AS generated_image_count,
              MAX(gi.created_at) AS last_image_created_at
       FROM content_jobs cj
       LEFT JOIN generated_images gi ON gi.content_job_id = cj.id
       WHERE ${where.join(' AND ')}
       GROUP BY cj.id
       ORDER BY
         CASE cj.publish_status
           WHEN '발행중' THEN 1
           WHEN '발행대기' THEN 2
           WHEN '예약대기' THEN 3
           WHEN '초안대기' THEN 4
           ELSE 9
         END,
         cj.scheduled_at NULLS LAST,
         cj.created_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/publish-queue/:id/images', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    const images = await loadGeneratedImages(job.id);
    res.json({ jobId: job.id, images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/publish-queue/:id', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const input = normalizeJobInput({ ...job, ...req.body, tenantId: tenantIdFromReq(req) });
    if (Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt') && !req.body.scheduledAt) input.scheduled_at = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'scheduled_at') && !req.body.scheduled_at) input.scheduled_at = null;
    const fieldAliases = {
      publish_mode: ['publish_mode', 'publishMode'],
      scheduled_at: ['scheduled_at', 'scheduledAt'],
      publish_status: ['publish_status', 'publishStatus'],
      publish_account_id: ['publish_account_id', 'publishAccountId'],
      publish_account_label: ['publish_account_label', 'publishAccountLabel'],
      publish_account_platform: ['publish_account_platform', 'publishAccountPlatform'],
      action_delay_min_seconds: ['action_delay_min_seconds', 'actionDelayMinSeconds'],
      action_delay_max_seconds: ['action_delay_max_seconds', 'actionDelayMaxSeconds'],
      between_posts_delay_minutes: ['between_posts_delay_minutes', 'betweenPostsDelayMinutes'],
      rss_url: ['rss_url', 'rssUrl'],
      published_url: ['published_url', 'publishedUrl'],
      published_at: ['published_at', 'publishedAt'],
      obsidian_export_status: ['obsidian_export_status', 'obsidianExportStatus'],
    };
    const values = [];
    const sets = [];

    for (const [field, names] of Object.entries(fieldAliases)) {
      const hasField = names.some((name) => Object.prototype.hasOwnProperty.call(req.body, name));
      if (!hasField) continue;
      values.push(input[field]);
      sets.push(`${field} = $${values.length}`);
    }

    if (sets.length === 0) return res.json({ job });

    values.push(job.id);
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    await addJobEvent(job.id, 'publish_queue_updated', 'Publish queue settings updated', req.body);
    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/mark-published', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const publishedUrl = req.body.publishedUrl || req.body.published_url || job.published_url;
    const publishedAt = normalizeOptionalDate(req.body.publishedAt || req.body.published_at) || new Date().toISOString();
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET published_url = COALESCE($2, published_url),
           published_at = $3,
           publish_status = '발행완료',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, publishedUrl || null, publishedAt]
    );
    await addJobEvent(job.id, 'published_marked', 'Published URL/status saved', { publishedUrl, publishedAt });
    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/rss-check', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const rssUrl = normalizeRssUrl(req.body.rssUrl || req.body.rss_url) || rssUrlForJob(job);
    if (!rssUrl) return res.status(400).json({ error: 'rss_url is required' });

    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'NaviWrite/1.0 RSS checker',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`RSS fetch failed (${response.status})`);

    const xml = await response.text();
    const items = parseRssItems(xml).map((item) => ({
      ...item,
      score: scorePublicationMatch(job, item),
    }));
    const best = items.sort((a, b) => b.score - a.score)[0] || null;
    const matched = Boolean(best && best.score >= 45);

    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET rss_url = $2,
           rss_checked_at = NOW(),
           rss_match_status = $3,
           rss_match_score = $4,
           rss_item_title = $5,
           rss_item_published_at = $6,
           published_url = CASE WHEN $7::boolean THEN COALESCE($8, published_url) ELSE published_url END,
           published_at = CASE WHEN $7::boolean THEN COALESCE($9::timestamptz, published_at) ELSE published_at END,
           publish_status = CASE WHEN $7::boolean THEN 'RSS확인완료' ELSE publish_status END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        job.id,
        rssUrl,
        matched ? 'matched' : 'not_matched',
        best?.score || 0,
        best?.title || null,
        best?.pubDate || null,
        matched,
        best?.link || null,
        best?.pubDate || null,
      ]
    );

    await addJobEvent(job.id, 'rss_checked', matched ? 'RSS matched published post' : 'RSS checked without strong match', {
      rssUrl,
      best,
      itemCount: items.length,
    });
    res.json({ job: rows[0], rssUrl, matched, best, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/publish-queue/:id/obsidian-markdown', async (req, res) => {
  try {
    if (!isOwnerTenant(req)) return res.status(403).json({ error: 'Obsidian export is owner-only' });
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    const images = await loadGeneratedImages(job.id);
    const markdown = buildObsidianMarkdown(job, images);
    res.json({ jobId: job.id, markdown, images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/obsidian-export', async (req, res) => {
  try {
    if (!isOwnerTenant(req)) return res.status(403).json({ error: 'Obsidian export is owner-only' });
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    const images = await loadGeneratedImages(job.id);
    const markdown = buildObsidianMarkdown(job, images);
    const title = job.title || job.keyword || `content-job-${job.id}`;
    const filePath = req.body.filePath || req.body.file_path || `${kstDateString()}-${String(title).replace(/[\\/:*?"<>|]+/g, '').slice(0, 70)}.md`;

    await pool.query(
      `INSERT INTO obsidian_exports (tenant_id, content_job_id, export_scope, vault_hint, markdown_title, markdown_body, file_path)
       VALUES ($1,$2,'owner-only',$3,$4,$5,$6)`,
      [job.tenant_id || 'owner', job.id, req.body.vaultHint || req.body.vault_hint || null, title, markdown, filePath]
    );
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET obsidian_export_status = '내보내기 완료',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id]
    );
    await addJobEvent(job.id, 'obsidian_export', 'Owner Obsidian markdown generated', { filePath });
    res.json({ job: rows[0], markdown, filePath, images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/metrics', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    const metricDate = normalizeOptionalDate(req.body.metricDate || req.body.metric_date)?.slice(0, 10) || kstDateString();
    const rankKeyword = req.body.rankKeyword || req.body.rank_keyword || job.keyword || '';
    const publishedUrl = req.body.publishedUrl || req.body.published_url || job.published_url;
    if (!publishedUrl) return res.status(400).json({ error: 'published_url is required' });

    const { rows } = await pool.query(
      `INSERT INTO published_post_metrics (
         tenant_id, content_job_id, published_url, metric_date, view_count,
         like_count, comment_count, scrap_count, rank_keyword, rank_position, source
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (content_job_id, metric_date, (COALESCE(rank_keyword, '')))
       DO UPDATE SET
         view_count = EXCLUDED.view_count,
         like_count = EXCLUDED.like_count,
         comment_count = EXCLUDED.comment_count,
         scrap_count = EXCLUDED.scrap_count,
         rank_position = EXCLUDED.rank_position,
         source = EXCLUDED.source,
         checked_at = NOW()
       RETURNING *`,
      [
        job.tenant_id || tenantIdFromReq(req),
        job.id,
        publishedUrl,
        metricDate,
        req.body.viewCount ?? req.body.view_count ?? null,
        req.body.likeCount ?? req.body.like_count ?? null,
        req.body.commentCount ?? req.body.comment_count ?? null,
        req.body.scrapCount ?? req.body.scrap_count ?? null,
        rankKeyword,
        req.body.rankPosition ?? req.body.rank_position ?? null,
        req.body.source || 'manual',
      ]
    );
    res.json({ metric: rows[0] });
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
    const tenantId = tenantIdFromReq(req);

    values.push(tenantId);
    where.push(`COALESCE(tenant_id, 'owner') = $${values.length}`);

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
    const job = normalizeJobInput({ ...req.body, tenantId: tenantIdFromReq(req) });
    if (!job.keyword) {
      return res.status(400).json({ error: 'keyword is required' });
    }

    const qrName = job.naver_qr_name || makeNaverQrName(job.keyword, job.campaign_name);
    const generationStatus = job.title || job.body ? '본문 생성 완료' : job.generation_status;

    const { rows } = await pool.query(
      `INSERT INTO content_jobs (
        tenant_id, created_by_user_id, rewrite_job_id,
        keyword, category, platform, source_url, cta_url, qr_target_url, tone, campaign_name,
        title, body, plain_text, char_count, kw_count, image_count,
        seo_score, geo_score, aeo_score, total_score,
        naver_qr_name, naver_qr_image_url, naver_qr_manage_url,
        qr_status, generation_status, editor_status, sheet_row_id, sheet_sync_status,
        notion_url, error_message, source_analysis_id, publish_account_id,
        publish_account_label, publish_account_platform, learning_status, login_status,
        publish_mode, scheduled_at, publish_status, action_delay_min_seconds,
        action_delay_max_seconds, between_posts_delay_minutes, rss_url,
        published_url, published_at, obsidian_export_status
       )
       VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,
        $22,$23,$24,
        $25,$26,$27,$28,$29,
        $30,$31,$32,$33,$34,
        $35,$36,$37,$38,
        $39,$40,$41,
        $42,$43,$44,
        $45,$46,$47
       )
       RETURNING *`,
      [
        job.tenant_id, job.created_by_user_id, job.rewrite_job_id,
        job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
        job.tone, job.campaign_name, job.title, job.body, job.plain_text,
        job.char_count, job.kw_count, job.image_count,
        job.seo_score, job.geo_score, job.aeo_score, job.total_score,
        qrName, job.naver_qr_image_url, job.naver_qr_manage_url,
        job.qr_status, generationStatus, job.editor_status, job.sheet_row_id,
        job.sheet_sync_status, job.notion_url, job.error_message, job.source_analysis_id,
        job.publish_account_id, job.publish_account_label, job.publish_account_platform,
        job.learning_status, job.login_status, job.publish_mode, job.scheduled_at,
        job.publish_status, job.action_delay_min_seconds, job.action_delay_max_seconds,
        job.between_posts_delay_minutes, job.rss_url, job.published_url,
        job.published_at, job.obsidian_export_status,
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
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const events = await pool.query(
      'SELECT * FROM content_job_events WHERE job_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ ...job, events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/content-jobs/:id', async (req, res) => {
  try {
    const currentJob = await loadTenantContentJob(req, req.params.id);
    if (!currentJob) return res.status(404).json({ error: 'Content job not found' });

    const allowed = [
      'keyword', 'category', 'platform', 'source_url', 'cta_url', 'qr_target_url', 'tone',
      'campaign_name', 'title', 'body', 'plain_text', 'char_count', 'kw_count', 'image_count',
      'seo_score', 'geo_score', 'aeo_score', 'total_score', 'naver_qr_name',
      'naver_qr_image_url', 'naver_qr_manage_url', 'qr_status', 'generation_status',
      'editor_status', 'sheet_row_id', 'sheet_sync_status', 'notion_url', 'error_message',
      'source_analysis_id', 'publish_account_id', 'publish_account_label',
      'publish_account_platform', 'learning_status', 'login_status', 'publish_mode',
      'scheduled_at', 'publish_status', 'action_delay_min_seconds',
      'action_delay_max_seconds', 'between_posts_delay_minutes', 'rss_url',
      'published_url', 'published_at', 'obsidian_export_status',
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
      publish_account_platform: ['publish_account_platform', 'publishAccountPlatform'],
      learning_status: ['learning_status', 'learningStatus'],
      login_status: ['login_status', 'loginStatus'],
      publish_mode: ['publish_mode', 'publishMode'],
      scheduled_at: ['scheduled_at', 'scheduledAt'],
      publish_status: ['publish_status', 'publishStatus'],
      action_delay_min_seconds: ['action_delay_min_seconds', 'actionDelayMinSeconds'],
      action_delay_max_seconds: ['action_delay_max_seconds', 'actionDelayMaxSeconds'],
      between_posts_delay_minutes: ['between_posts_delay_minutes', 'betweenPostsDelayMinutes'],
      rss_url: ['rss_url', 'rssUrl'],
      published_url: ['published_url', 'publishedUrl'],
      published_at: ['published_at', 'publishedAt'],
      obsidian_export_status: ['obsidian_export_status', 'obsidianExportStatus'],
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
      return res.json(currentJob);
    }

    values.push(currentJob.id);
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
    const currentJob = await loadTenantContentJob(req, req.params.id);
    if (!currentJob) return res.status(404).json({ error: 'Content job not found' });

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
      [currentJob.id, naver_qr_image_url, naver_qr_manage_url, qr_status]
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
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    const sheetSync = await syncJobToGoogleSheet(job);
    const updated = await pool.query('SELECT * FROM content_jobs WHERE id = $1', [job.id]);
    res.json({ job: updated.rows[0], sheetSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-jobs/sheets/pull', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
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
        `SELECT id FROM content_jobs
         WHERE sheet_row_id = $1
           AND COALESCE(tenant_id, 'owner') = $2
         LIMIT 1`,
        [sheetRowId, tenantId]
      );
      if (existing.rows.length > 0) {
        skipped += 1;
        continue;
      }

      const job = normalizeJobInput({
        tenantId,
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
          tenant_id, keyword, category, platform, source_url, cta_url, qr_target_url,
          tone, campaign_name, naver_qr_name, sheet_row_id, sheet_sync_status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'시트에서 가져옴')
        RETURNING *`,
        [
          job.tenant_id, job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
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
    const currentJob = await loadTenantContentJob(req, req.params.id);
    if (!currentJob) return res.status(404).json({ error: 'Content job not found' });

    const notionUrl = req.body.notion_url || req.body.notionUrl || null;
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET notion_url = COALESCE($2, notion_url),
           notion_exported_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [currentJob.id, notionUrl]
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

let collectionSchedulerStarted = false;
let lastBlogSnapshotDate = null;
let lastBlogCloseDate = null;

export function startCollectionSchedulers() {
  if (collectionSchedulerStarted) return;
  collectionSchedulerStarted = true;

  const tick = async () => {
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstHour = kstNow.getUTCHours();
    const kstMinute = kstNow.getUTCMinutes();
    const today = kstNow.toISOString().slice(0, 10);
    if (kstHour === 23 && kstMinute >= 55 && lastBlogCloseDate !== today) {
      lastBlogCloseDate = today;
      try {
        const blogResults = await snapshotCollectedBlogs({ limit: 300, mode: 'day-close', snapshotDate: today });
        console.log(`[collections] day-close blog snapshots: ${blogResults.filter((item) => item.ok).length}/${blogResults.length}`);
      } catch (err) {
        console.warn('[collections] day-close view snapshot failed:', err.message);
      }
    }
    if (kstHour === 0 && kstMinute >= 5 && lastBlogSnapshotDate !== today) {
      lastBlogSnapshotDate = today;
      try {
        const blogResults = await snapshotCollectedBlogs({ limit: 300 });
        const cafeResults = await snapshotCollectedCafePosts({ limit: 300 });
        console.log(`[collections] daily blog snapshots: ${blogResults.filter((item) => item.ok).length}/${blogResults.length}`);
        console.log(`[collections] daily cafe snapshots: ${cafeResults.filter((item) => item.ok).length}/${cafeResults.length}`);
      } catch (err) {
        console.warn('[collections] daily view snapshot failed:', err.message);
      }
    }
  };

  const interval = setInterval(tick, 60 * 1000);
  interval.unref?.();
  const initial = setTimeout(tick, 15 * 1000);
  initial.unref?.();
}

export default router;
