import { Router } from 'express';
import crypto from 'node:crypto';
import pool from '../db/index.js';

const router = Router();

const JOB_STATUSES = new Set([
  '대기중',
  '본문 생성 완료',
  '글생성 완료',
  'QR 생성 필요',
  'QR 미사용',
  'QR 생성 완료',
  '에디터 삽입 완료',
  '검수 필요',
  '오류',
]);

const DEFAULT_PUBLISH_STALE_LOCK_MINUTES = Math.max(
  5,
  Math.min(240, parseInt(process.env.PUBLISH_STALE_LOCK_MINUTES || '30', 10) || 30)
);

function normalizeStalePublishMinutes(value) {
  const minutes = parseInt(value ?? DEFAULT_PUBLISH_STALE_LOCK_MINUTES, 10);
  return Math.max(5, Math.min(240, Number.isFinite(minutes) ? minutes : DEFAULT_PUBLISH_STALE_LOCK_MINUTES));
}

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
  const allowed = new Set(['blog', 'cafe', 'premium', 'brunch', 'web', 'wordpress', 'qr']);
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

function decodeJsString(value = '') {
  const safe = String(value || '').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  try {
    return JSON.parse(`"${safe}"`);
  } catch {
    return decodeHtmlEntities(value);
  }
}

function restoreKeywordSpacing(rawKeyword = '', referenceText = '') {
  const cleaned = decodeHtmlEntities(decodeJsString(rawKeyword))
    .replace(/[#,|/·ㆍ_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (/\s/.test(cleaned)) return cleaned;

  const compact = cleaned.toLowerCase();
  const referenceTokens = tokenizeKoreanText(referenceText)
    .filter((token) => token.length >= 2 || /\d/.test(token));
  const knownTerms = [
    '소상공인', '추경지원금', '지원금', '500만원', '신청', '대상', '기준', '방법', '지급일',
    '테스트', '검사', '링크', '결과', '유형', '비교', '예약', '점집', '사주', '후기',
  ];
  const dictionary = [...new Set([...referenceTokens, ...knownTerms])]
    .map((term) => term.trim())
    .filter(Boolean)
    .sort((a, b) => b.replace(/\s/g, '').length - a.replace(/\s/g, '').length);

  const parts = [];
  let index = 0;
  while (index < compact.length) {
    const match = dictionary.find((term) => compact.startsWith(term.replace(/\s/g, '').toLowerCase(), index));
    if (!match) {
      parts.length = 0;
      break;
    }
    parts.push(match);
    index += match.replace(/\s/g, '').length;
  }

  return parts.length && parts.join('').replace(/\s/g, '').toLowerCase() === compact
    ? parts.join(' ')
    : cleaned;
}

function extractNaverKeywordSignals(...htmlParts) {
  const html = htmlParts.filter(Boolean).join('\n');
  if (!html) return [];
  const signals = [];
  const title = cleanNaverBlogTitle(pickMetaContent(html, 'og:title') || extractTitle(html, ''));
  const reference = `${title} ${stripHtml(extractNaverBodyHtml(html) || html).slice(0, 3000)}`;
  const addSignal = (keyword, source, weight) => {
    const restored = restoreKeywordSpacing(keyword, reference);
    if (!restored || restored.replace(/\s/g, '').length < 2) return;
    signals.push({ keyword: restored, source, weight });
  };

  const tagMatch = html.match(/gsTagName\s*=\s*["']([^"']+)["']/i);
  if (tagMatch) {
    decodeJsString(tagMatch[1]).split(',').forEach((tag, index) => {
      addSignal(tag, 'naver_tag', Math.max(24, 34 - index * 2));
    });
  }

  const searchKeywordMatches = [...html.matchAll(/"searchKeyword"\s*:\s*"([^"]+)"/gi)];
  searchKeywordMatches.forEach((match, index) => {
    addSignal(match[1], 'naver_recommendation', Math.max(26, 42 - index * 3));
  });

  return signals
    .filter((item, index, list) => list.findIndex((other) => other.keyword === item.keyword) === index)
    .slice(0, 12);
}

function inferKeywordCandidates({ title = '', text = '', subheadings = [], keywordSignals = [] }) {
  const source = [title, subheadings.join(' '), text].join(' ');
  const tokens = tokenizeKoreanText(source);
  const scores = new Map();
  const counts = new Map();
  const sources = new Map();
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

  const addScore = (keyword, amount, sourceName = '') => {
    const normalized = normalizeKeywordValue(keyword);
    if (!normalized || normalized.replace(/\s/g, '').length < 2 || normalized.length > 60) return;
    scores.set(normalized, (scores.get(normalized) || 0) + amount);
    if (sourceName) {
      const set = sources.get(normalized) || new Set();
      set.add(sourceName);
      sources.set(normalized, set);
    }
  };

  keywordSignals.forEach((signal) => {
    addScore(signal.keyword, Number(signal.weight || 28), signal.source || 'signal');
    counts.set(signal.keyword, Math.max(counts.get(signal.keyword) || 0, 1));
  });

  for (let size = 1; size <= 4; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const phrase = tokens.slice(i, i + size).join(' ');
      if (phrase.replace(/\s/g, '').length < 2 || phrase.length > 30) continue;
      const compactPhrase = phrase.replace(/\s/g, '');
      const base = size === 1 ? 0.65 : size === 2 ? 3.2 : size === 3 ? 4.1 : 3.4;
      const titleBoost = title.includes(phrase) ? 7 : 0;
      const compactTitleBoost = compactTitle.includes(compactPhrase) ? 3 : 0;
      const headingBoost = subheadings.some((heading) => heading.includes(phrase)) ? 4 : 0;
      const contextBoost = contextTerms.some((term) => phrase.includes(term) || term.includes(phrase)) ? 2.2 : 0;
      const oneWordPenalty = size === 1 && !contextTerms.some((term) => term === phrase) ? 1.1 : 0;
      const longPhrasePenalty = size >= 4 && !keywordSignals.some((signal) => signal.keyword.replace(/\s/g, '') === compactPhrase) ? 1.8 : 0;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
      addScore(phrase, base + titleBoost + compactTitleBoost + headingBoost + contextBoost - oneWordPenalty - longPhrasePenalty, 'text');
    }
  }

  const broadSingleTerms = new Set([
    '신청', '지원', '대상', '방법', '기준', '결과', '링크', '유형', '후기', '예약',
    '정리', '확인', '비교', '500만원', '지원금', '테스트',
  ]);
  const candidates = [...scores.entries()]
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
        sources: [...(sources.get(keyword) || [])],
      };
    });
  const compoundCompacts = candidates
    .filter((item) => item.wordCount >= 2)
    .map((item) => item.keyword.replace(/\s/g, '').toLowerCase());
  const actionTerms = ['신청', '방법', '대상', '조건', '지급일', '링크', '예약', '결과', '유형'];
  const signalActionCompounds = candidates
    .filter((item) => item.wordCount >= 2 && item.sources.some((sourceName) => /naver|signal/i.test(sourceName)) && actionTerms.some((term) => item.keyword.includes(term)))
    .map((item) => item.keyword.replace(/\s/g, '').toLowerCase());

  return candidates
    .map((item) => {
      const compactKeyword = item.keyword.replace(/\s/g, '').toLowerCase();
      const includedInCompound = item.wordCount === 1 && compoundCompacts.some((compound) => compound.includes(compactKeyword));
      const shorterThanSignalAction = item.wordCount < 3 && signalActionCompounds.some((compound) => compound !== compactKeyword && compound.includes(compactKeyword));
      const actionBoost = item.wordCount >= 2 && actionTerms.some((term) => item.keyword.includes(term)) ? 16 : 0;
      const broadPenalty = broadSingleTerms.has(item.keyword) ? 42 : 0;
      const compoundPenalty = includedInCompound ? 38 : 0;
      return {
        ...item,
        score: Number((item.score + actionBoost - broadPenalty - compoundPenalty - (shorterThanSignalAction ? 26 : 0)).toFixed(2)),
        broadSingle: broadSingleTerms.has(item.keyword),
      };
    })
    .filter((item) => (
      item.count >= 2
      || item.titleMatched
      || item.sources.length > 0
      || (item.wordCount >= 2 && item.contextMatched)
    ))
    .sort((a, b) => b.score - a.score || b.sources.length - a.sources.length || b.wordCount - a.wordCount || b.count - a.count)
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
  const keywordSignals = extractNaverKeywordSignals(html, mobileHtml);
  const keywordCandidates = inferKeywordCandidates({ title, text: plainText, subheadings, keywordSignals });
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
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/민생회복\s+지원금/g, '민생회복지원금')
    .replace(/민생\s+회복지원금/g, '민생회복지원금')
    .replace(/반갑\s*여행/g, '반값여행')
    .trim()
    .slice(0, 60);
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

const VISIBLE_EDITOR_PLACEHOLDER_RE = /(AI\s*활용\s*설정|사진\s*설명을?\s*입력하세요\.?|내용을\s*입력하세요\.?|출처\s*입력)/gi;
const VISIBLE_ARTICLE_MARKER_RE = /\[(?:대표\s*이미지|대표이미지|이미지|보조\s*이미지|네이버\s*QR|QR|네이버\s*동영상|동영상|링크|CTA)[^\]]*\]/gi;
const VISIBLE_IMAGE_MARKER_LINE_RE = /^\s*\[(?:대표\s*이미지|대표이미지|이미지|보조\s*이미지)[^\]]*\]\s*$/i;
const ANY_IMAGE_MARKER_LINE_RE = /^\s*\[(?:대표\s*이미지|대표이미지|이미지|보조\s*이미지)[^\]]*\]\s*$/i;
const AUTHORING_LABEL_RE = /^\s*(?:도입부\s*(?:첫|두|세)\s*문단|대표\s*이미지|요약\s*답변|답변|대답|세부\s*설명|설명|마무리\s*요약|행동\s*권장|체크리스트)\s*[:：]\s*/i;

function articlePlainText(body = '') {
  return String(body || '')
    .replace(/\[(?:대표이미지|대표 이미지|이미지|보조 이미지|네이버 QR|네이버 동영상|링크 삽입|링크 삽입 위치)[^\]]+\]/g, '')
    .replace(VISIBLE_ARTICLE_MARKER_RE, '')
    .replace(VISIBLE_EDITOR_PLACEHOLDER_RE, '')
    .replace(/^>\s*/gm, '')
    .trim();
}

function articleMetrics(body = '', keyword = '') {
  const plainText = articlePlainText(body);
  return {
    plainText,
    charCount: plainText.replace(/\s/g, '').length,
    kwCount: countKeywordInText(plainText, keyword),
  };
}

function metricTargetRange(settingsInput = {}) {
  const settings = parseRewriteSettings(settingsInput);
  return {
    targetCharCount: settings.targetCharCount,
    minCharCount: Math.round(settings.targetCharCount * 0.95),
    maxCharCount: Math.round(settings.targetCharCount * 1.12),
    sectionCharCount: settings.sectionCharCount,
    sectionCount: settings.sectionCount,
    targetKwCount: settings.targetKwCount,
    minKwCount: Math.max(5, settings.targetKwCount - 1),
    maxKwCount: settings.targetKwCount + 2,
  };
}

function rewriteCharBudgetPlan(settingsInput = {}) {
  const settings = parseRewriteSettings(settingsInput);
  const range = metricTargetRange(settings);
  const sectionCount = clampNumber(Math.round(settings.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount), 3, 10);
  const introTarget = clampNumber(Math.round(settings.targetCharCount * 0.16), 260, 430);
  const conclusionTarget = clampNumber(Math.round(settings.targetCharCount * 0.08), 140, 260);
  const bodyBudget = Math.max(600, settings.targetCharCount - introTarget - conclusionTarget);
  const sectionTarget = clampNumber(Math.round(bodyBudget / sectionCount), 220, 520);
  return {
    unit: 'Korean characters without spaces',
    targetCharCount: settings.targetCharCount,
    minCharCount: range.minCharCount,
    maxCharCount: range.maxCharCount,
    intro: { paragraphs: 3, target: introTarget, min: Math.round(introTarget * 0.85), max: Math.round(introTarget * 1.2) },
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      index: index + 1,
      target: sectionTarget,
      min: Math.round(sectionTarget * 0.82),
      max: Math.round(sectionTarget * 1.22),
      paragraphs: 2,
    })),
    conclusion: { paragraphs: 2, target: conclusionTarget, min: Math.round(conclusionTarget * 0.75), max: Math.round(conclusionTarget * 1.3) },
  };
}

function metricDistanceToRange(metrics = {}, range = {}) {
  let distance = 0;
  if (metrics.charCount < range.minCharCount) distance += range.minCharCount - metrics.charCount;
  if (metrics.charCount > range.maxCharCount) distance += metrics.charCount - range.maxCharCount;
  if (metrics.kwCount < range.minKwCount) distance += (range.minKwCount - metrics.kwCount) * 80;
  if (metrics.kwCount > range.maxKwCount) distance += (metrics.kwCount - range.maxKwCount) * 80;
  return distance;
}

function rewriteMetricSummary(row = {}) {
  const pattern = parseJsonObject(row.pattern_json, {});
  const savedSettings = parseJsonObject(row.settings_json, {});
  const patternSettings = parseJsonObject(pattern.settings, {});
  const settings = parseRewriteSettings({
    ...savedSettings,
    ...patternSettings,
    targetCharCount: pattern.targetCharCount || patternSettings.targetCharCount || savedSettings.targetCharCount,
    sectionCharCount: pattern.sectionCharCount || patternSettings.sectionCharCount || savedSettings.sectionCharCount,
    sectionCount: pattern.sectionCount || patternSettings.sectionCount || savedSettings.sectionCount,
    targetKwCount: pattern.targetKwCount || patternSettings.targetKwCount || savedSettings.targetKwCount,
    imageCount: pattern.imageCount || patternSettings.imageCount || savedSettings.imageCount,
  });
  const targetRange = metricTargetRange(settings);
  const imageTarget = clampNumber(
    parseInt(pattern.imageCount ?? settings.imageCount ?? DEFAULT_REWRITE_SETTINGS.imageCount, 10) || DEFAULT_REWRITE_SETTINGS.imageCount,
    0,
    20
  );
  const quoteTarget = clampNumber(
    parseInt(pattern.quoteCount ?? pattern.sectionCount ?? settings.sectionCount ?? DEFAULT_REWRITE_SETTINGS.sectionCount, 10) || DEFAULT_REWRITE_SETTINGS.sectionCount,
    0,
    20
  );
  const quoteMin = Math.max(0, quoteTarget - 1);
  const quoteMax = quoteTarget + 1;
  const actual = {
    charCount: Number(row.char_count || 0),
    kwCount: Number(row.kw_count || 0),
    imageCount: Number(row.image_count || 0),
    quoteCount: Number(row.quote_count || 0),
  };
  const pass = {
    charCount: actual.charCount >= targetRange.minCharCount && actual.charCount <= targetRange.maxCharCount,
    kwCount: actual.kwCount >= targetRange.minKwCount && actual.kwCount <= targetRange.maxKwCount,
    imageCount: actual.imageCount === imageTarget,
    quoteCount: actual.quoteCount >= quoteMin && actual.quoteCount <= quoteMax,
  };
  const failedKeys = Object.entries(pass)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  return {
    status: failedKeys.length ? 'review_needed' : 'passed',
    failedKeys,
    target: {
      charCount: targetRange.targetCharCount,
      minCharCount: targetRange.minCharCount,
      maxCharCount: targetRange.maxCharCount,
      sectionCharCount: targetRange.sectionCharCount,
      sectionCount: targetRange.sectionCount,
      kwCount: targetRange.targetKwCount,
      minKwCount: targetRange.minKwCount,
      maxKwCount: targetRange.maxKwCount,
      imageCount: imageTarget,
      quoteCount: quoteTarget,
      minQuoteCount: quoteMin,
      maxQuoteCount: quoteMax,
    },
    actual,
    delta: {
      charCount: actual.charCount - targetRange.targetCharCount,
      kwCount: actual.kwCount - targetRange.targetKwCount,
      imageCount: actual.imageCount - imageTarget,
      quoteCount: actual.quoteCount - quoteTarget,
    },
    pass,
  };
}

function attachRewriteMetricSummary(row = {}) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    metric_summary: rewriteMetricSummary(row),
  };
}

function metricSupplementParagraph({ keyword = '', topic = '', category = '', index = 0, includeKeyword = true } = {}) {
  const keyPhrase = includeKeyword ? normalizeKeywordValue(keyword) : (isPolicySupportKeyword(`${keyword} ${topic} ${category}`) ? '해당 지원 정보' : '이 주제');
  const subject = normalizeKeywordValue(topic) || keyPhrase;
  const isPolicy = isPolicySupportKeyword(`${keyword} ${topic} ${category}`);
  const policy = [
    `${keyPhrase}를 확인할 때는 먼저 공고명이 같은지, 신청 기간이 현재 열려 있는지, 주민등록상 주소지 기준이 맞는지를 차례대로 보는 편이 안전합니다. 비슷한 안내가 여러 곳에 올라와도 실제 적용 기준은 지자체 공고와 접수처 안내가 우선이기 때문에 마지막 단계에서 공식 페이지를 다시 확인해야 합니다.`,
    `${keyPhrase} 신청 과정에서는 대상 조건과 제출 서류를 따로 적어두면 누락을 줄일 수 있습니다. 특히 온라인 접수와 방문 접수 중 어떤 방식이 가능한지, 대리 신청이 되는지, 지급 방식이 지역화폐인지 카드 포인트인지에 따라 준비해야 할 내용이 달라질 수 있습니다.`,
    `${keyPhrase} 일정은 시작일보다 마감일을 놓치는 경우가 더 많습니다. 그래서 신청 가능 기간, 결과 확인일, 실제 지급 예정일을 한 번에 묶어두고, 변경 공지가 있는지 확인하는 흐름으로 보면 검색자가 바로 행동으로 옮기기 쉽습니다.`,
    `${keyPhrase} 대상 여부가 애매하다면 소득 기준만 보지 말고 거주 기준일, 연령, 기존 지원 수령 여부, 중복 제한 항목까지 함께 확인해야 합니다. 이 부분을 분리해서 설명하면 단순 홍보글보다 실제로 도움이 되는 정보형 글에 가까워집니다.`,
  ];
  const general = [
    `${keyPhrase}를 볼 때는 정보의 양보다 확인 순서가 더 중요합니다. 먼저 ${subject}의 핵심 조건을 잡고, 그다음 실제 이용 방법과 주의사항을 나누면 독자가 필요한 부분만 빠르게 찾아볼 수 있습니다.`,
    `${keyPhrase} 관련 글은 제목만 보고 들어온 사람이 많기 때문에 본문 중간에도 기준, 방법, 일정처럼 바로 확인할 수 있는 표현을 자연스럽게 배치하는 것이 좋습니다. 이렇게 쓰면 검색 의도와 본문 흐름이 어긋날 가능성이 줄어듭니다.`,
    `${keyPhrase}는 비슷한 표현이 반복되기 쉬운 주제라서 같은 문장을 늘리는 방식보다 확인 항목을 바꿔가며 설명해야 합니다. 조건, 절차, 예외, 마무리 요약을 분리하면 글자수도 안정적으로 맞고 유사도 위험도 낮아집니다.`,
    `${keyPhrase}를 처음 접한 사람이라면 마지막에 다시 확인해야 할 기준이 필요합니다. 그래서 본문 후반에는 핵심 조건과 실제 확인 경로를 한 번 더 정리해두면 읽고 나서 바로 다음 행동을 정하기 쉬워집니다.`,
  ];
  return (isPolicy ? policy : general)[Math.abs(index) % (isPolicy ? policy : general).length];
}

function replaceGeneratedTitleLine(body = '', rawTitle = '', cleanTitle = '') {
  const lines = String(body || '').split(/\r?\n/);
  const rawCompact = normalizeTitleValue(rawTitle).replace(/\s/g, '');
  for (let i = 0; i < Math.min(lines.length, 4); i += 1) {
    const lineCompact = normalizeTitleValue(lines[i]).replace(/\s/g, '');
    if (!lineCompact) continue;
    if (rawCompact && lineCompact === rawCompact) {
      lines[i] = cleanTitle;
      return lines.join('\n').trim();
    }
    if (cleanTitle && !lineCompact.includes(cleanTitle.replace(/\s/g, '')) && lineCompact.length <= 80) {
      lines.splice(i, 0, cleanTitle);
      return lines.join('\n').trim();
    }
    break;
  }
  return cleanTitle && !String(body || '').includes(cleanTitle)
    ? `${cleanTitle}\n\n${body}`.trim()
    : String(body || '').trim();
}

function enforceArticleMetricTargets({ body = '', title = '', keyword = '', topic = '', category = '', settings = {} } = {}) {
  const range = metricTargetRange(settings);
  let nextBody = String(body || '').trim();
  let metrics = articleMetrics(nextBody, keyword);
  const supplements = [];
  let index = 0;
  while ((metrics.charCount < range.minCharCount || metrics.kwCount < range.minKwCount) && index < 10) {
    const paragraph = metricSupplementParagraph({
      keyword,
      topic,
      category,
      index,
      includeKeyword: metrics.kwCount < range.minKwCount || metrics.kwCount < range.maxKwCount,
    });
    supplements.push(paragraph);
    nextBody = `${nextBody}\n\n${paragraph}`.trim();
    metrics = articleMetrics(nextBody, keyword);
    index += 1;
  }
  return {
    body: nextBody,
    ...metrics,
    targetRange: range,
    metricAdjusted: supplements.length > 0,
    metricSupplementCount: supplements.length,
  };
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

function plannedArticleImageCount(input = {}, sectionCountInput) {
  const rawSectionCount = Number(sectionCountInput ?? input.sectionCount ?? input.section_count ?? DEFAULT_REWRITE_SETTINGS.sectionCount);
  const sectionCount = clampNumber(Number.isFinite(rawSectionCount) && rawSectionCount > 0 ? Math.round(rawSectionCount) : DEFAULT_REWRITE_SETTINGS.sectionCount, 1, 10);
  const naturalTotal = 1 + sectionCount;
  const rawImageCount = Number(input.imageCount ?? input.image_count ?? naturalTotal);
  const requested = Number.isFinite(rawImageCount) && rawImageCount > 0 ? Math.round(rawImageCount) : naturalTotal;
  return clampNumber(Math.min(requested, naturalTotal), 1, naturalTotal);
}

function keywordVariantPool(keyword = '', topic = '') {
  const clean = normalizeKeywordValue(keyword);
  const subject = naturalTitleSubject(keyword, topic);
  const pool = new Set();
  if (/완도/.test(`${clean} ${topic}`) && /반값|반갑/.test(`${clean} ${topic}`)) {
    ['완도 여행 지원', '반값여행 신청', '완도군 여행비 지원', '여행 환급 신청', '공식 홈페이지 안내', '신청 기간 확인'].forEach((term) => pool.add(term));
  }
  if (/민생회복|지원금/.test(`${clean} ${topic}`)) {
    ['지원금 신청', '민생 지원 안내', '신청 기간 확인', '대상자 조회', '지역별 지급 기준', '공식 접수처'].forEach((term) => pool.add(term));
  }
  [subject, clean.replace(/\s*신청$/g, ''), clean.replace(/\s*방법$/g, '')]
    .map((term) => normalizeKeywordValue(term))
    .filter((term) => term && term !== clean)
    .forEach((term) => pool.add(term));
  ['대상 기준', '신청 방법', '일정 확인', '주의사항', '공식 안내'].forEach((term) => pool.add(term));
  return [...pool].filter(Boolean);
}

function limitExactKeywordRepetition(body = '', keyword = '', maxExact = 12, topic = '') {
  const cleanKeyword = normalizeKeywordValue(keyword);
  if (!cleanKeyword || maxExact <= 0) return body;
  const variants = keywordVariantPool(cleanKeyword, topic);
  if (variants.length === 0) return body;
  const pattern = new RegExp(escapeRegExp(cleanKeyword), 'g');
  let count = 0;
  return String(body || '').split('\n').map((line, lineIndex) => {
    if (lineIndex === 0 || /^\s*\[/.test(line)) return line;
    return line.replace(pattern, (match) => {
      count += 1;
      if (count <= maxExact) return match;
      return variants[(count - maxExact - 1) % variants.length] || match;
    });
  }).join('\n');
}

function limitImagePlaceholders(body = '', maxTotal = DEFAULT_REWRITE_SETTINGS.imageCount) {
  let count = 0;
  const maxImages = Math.max(0, Number(maxTotal) || 0);
  return String(body || '').split('\n').filter((line) => {
    if (ANY_IMAGE_MARKER_LINE_RE.test(line)) {
      count += 1;
      return count <= maxImages;
    }
    if (!/^\s*\[(?:대표이미지|대표 이미지|이미지|보조 이미지)\b/.test(line)) return true;
    count += 1;
    return count <= maxImages;
  }).join('\n');
}

function imageKeywordLabel(keyword = '', topic = '', index = 0) {
  if (index === 0) return normalizeKeywordValue(keyword);
  const variants = keywordVariantPool(keyword, topic);
  return variants[(index - 1) % Math.max(variants.length, 1)] || normalizeKeywordValue(keyword);
}

function imageCaptionLabel(keyword = '', section = '', index = 0) {
  const main = normalizeKeywordValue(keyword);
  const sectionText = normalizeKeywordValue(section)
    .replace(/^대표\s*이미지\s*/i, '')
    .replace(/^이미지\s*\d+\s*/i, '');
  const caption = [main, sectionText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return caption.slice(0, 58);
}

const DEFAULT_REWRITE_SETTINGS = {
  contentSkillKey: 'verified_info',
  generatorMode: 'openai',
  openaiModel: 'gpt-5-mini',
  useWebResearch: true,
  targetCharCount: 2500,
  sectionCharCount: 350,
  sectionCount: 7,
  targetKwCount: 11,
  imageCount: 8,
  benchmarkUrl: 'https://blog.naver.com/openmind200/224258533599',
  benchmarkSampleCount: 30,
  benchmarkMedianCharCount: 2480,
  benchmarkMedianSectionCount: 7,
  benchmarkMedianSectionCharCount: 350,
  benchmarkMedianKwCount: 11,
  benchmarkMedianImageCount: 8,
};

const CONTENT_SKILLS = {
  verified_info: {
    key: 'verified_info',
    name: '검색검증 정보형',
    description: '검색 유입형 글을 쓰되 주제 오염 없이 공식 기준, 비용, 기간, 신청 경로, 사용자가 바로 해야 할 행동을 먼저 확인하는 기본 스킬입니다.',
    articleGoal: 'verified_search_traffic',
    targetPlatforms: ['naver_blog', 'naver_cafe', 'wordpress'],
    imagePipeline: {
      generationTiming: 'draft_generation',
      storage: 'server_generated_images',
      editorMode: 'extension_download_blob_then_upload',
      defaultSize: '500x500',
      alignment: 'center',
      manualReviewRequired: false,
      policy: '본문 생성 단계에서 대표 이미지와 섹션 이미지를 미리 만들고, 발행 단계에서는 서버 이미지를 받아 업로드만 수행',
    },
    writingRules: {
      quotePerSection: true,
      keywordRepeatBias: 'verified_natural',
      similarityRiskTarget: 'very_low',
      ctaPlacement: '도입 CTA 이후 또는 2번째 섹션 뒤',
      promptRules: [
        'Never change the user topic into AdSense, blog monetization, or another unrelated domain unless the target keyword itself says so.',
        'SEO/Naver: title and first intro must clearly identify the exact target keyword, user intent, and action keywords without clickbait.',
        'SEO/Google: write people-first original content that adds useful checking steps, not a rehash of search snippets.',
        'AEO: each quote heading must answer one likely question directly in the first sentence, then explain conditions, exceptions, and next action.',
        'GEO: distinguish confirmed facts from verification steps. When dates, amounts, agencies, or URLs are in factPack, paraphrase them precisely; when missing, do not invent them.',
        'Length control: distribute the target character count across intro, every section, and conclusion. Do not solve short output by repeating the same warning or adding generic ending notes.',
        'Do not use fixed labels such as "답변:", "세부 설명:", "도입부 첫 문단:", or "마무리 요약:" in the final body.',
        'Do not add visible SmartEditor placeholder strings such as "내용을 입력하세요.", "출처 입력", "사진 설명을 입력하세요.", or "AI 활용 설정".',
        'Use 2-3 related keyword variants in natural sentences, but keep exact target keyword repetition within the requested range.',
        'Write each section with a different angle: 대상/조건, 신청/접수, 일정/마감, 비용/금액, 서류/주의사항, 사용처/확인절차, 요약/체크리스트.',
        'Image captions should include the section intent and one natural keyword variant under 55 Korean characters.',
      ],
      requiredFactSlots: [
        'who_is_target',
        'where_to_apply_or_check',
        'cost_or_fee',
        'period_or_duration',
        'completion_or_result_step',
        'caution_or_exclusion',
      ],
      forbiddenPatterns: [
        'unrelated_adsense_topic',
        'same_paragraph_frame_repeated',
        'answer_detail_label_repetition',
        'invented_amount_or_date',
        'editor_placeholder_text',
      ],
      obsidianLearningFields: [
        '확인된 공식 사실',
        '생성 후 사람이 고친 사실',
        '상위노출 키워드',
        '클릭을 만든 제목 조합',
        '반복이 과했던 표현',
        '다음 생성에서 금지할 문장',
      ],
    },
  },
  adsense_verified_info: {
    key: 'adsense_verified_info',
    name: '애드센스 정보검증형',
    description: '검색 유입형 글을 쓰되 공식 기준, 비용, 기간, 신청 경로, 사용자가 바로 해야 할 행동을 먼저 확인하는 스킬입니다.',
    articleGoal: 'verified_search_traffic_adsense',
    targetPlatforms: ['naver_blog', 'naver_cafe', 'wordpress'],
    imagePipeline: {
      generationTiming: 'draft_generation',
      storage: 'server_generated_images',
      editorMode: 'extension_download_blob_then_upload',
      defaultSize: '500x500',
      alignment: 'center',
      manualReviewRequired: false,
      policy: '본문 생성 단계에서 대표 이미지와 섹션 이미지를 미리 만들고, 발행 단계에서는 서버 이미지를 받아 업로드만 수행',
    },
    writingRules: {
      quotePerSection: true,
      keywordRepeatBias: 'verified_natural',
      similarityRiskTarget: 'very_low',
      ctaPlacement: '도입 CTA 이후 또는 2번째 섹션 뒤',
      promptRules: [
        'SEO/Naver: title and first intro must clearly identify the topic, target intent, and action keywords without clickbait. Avoid keyword stuffing and duplicate title-like sentences.',
        'SEO/Google: write people-first original content that adds useful checking steps, not a rehash of search snippets. Put image placeholders next to the related section text with descriptive labels.',
        'AEO: each quote heading must answer one likely question directly in the first sentence, then explain conditions, exceptions, and next action.',
        'GEO: distinguish confirmed facts from verification steps. When dates, amounts, agencies, or URLs are in factPack, paraphrase them precisely; when missing, do not invent them.',
        'Length control: distribute the target character count across intro, every section, and conclusion. Do not solve short output by repeating the same warning or adding generic ending notes.',
        '각 섹션은 먼저 구체 답을 한 문단으로 제시한 뒤 세부 설명을 이어 쓴다. 단, "요약 답변:"과 "세부 설명:" 라벨을 반복하지 않는다.',
        'AI 브리핑/관련질문형 답변처럼 각 소제목은 실제 질문 1개에 답하는 구조로 쓴다. 질문 문구를 그대로 반복하지 말고 자연스러운 소제목과 첫 문장에 녹인다.',
        '네이버 자동완성어, 검색 API 상위 제목, 관련 질문에서 나온 행동 키워드를 제목·소제목·첫 문단에 분산한다. 단, 검색어 나열처럼 보이면 안 된다.',
        '이미지 카드에는 본문 키워드와 소제목이 들어간 짧은 캡션을 붙일 수 있도록 imageCards.caption을 작성한다.',
        '공식 기준이 필요한 주제는 기관명, 과정명, 비용, 시간, 신청 경로, 등록/확인 절차를 먼저 확인한 것처럼 구조화한다.',
        '확인되지 않은 환급, 서류, 지원금, 일정, 금액을 만들지 않는다. 근거가 없으면 "공식 공지에서 최종 확인" 단계로 처리한다.',
        '금융/투자 교육 주제는 교육기관, 과정명, 수강료, 교육 시간, 수료번호 등록, 기본예탁금 또는 거래 제한을 핵심 섹션에 포함한다.',
        '정책/지원금 주제는 대상, 신청 기간, 신청 경로, 지급/환급 방식, 제외 조건, 공식 공지 확인 순서를 핵심 섹션에 포함한다.',
        '여행/행사 주제는 신청 기간, 여행 가능 기간, 비용/환급 기준, 공식 홈페이지, 증빙 자료, 마감 전 확인 사항을 핵심 섹션에 포함한다.',
        '긴 메인키워드를 모든 문단에 그대로 반복하지 말고, 2~3단어 핵심어와 보조어로 분산한다.',
      ],
      requiredFactSlots: [
        'who_is_target',
        'where_to_apply_or_check',
        'cost_or_fee',
        'period_or_duration',
        'completion_or_result_step',
        'caution_or_exclusion',
      ],
      forbiddenPatterns: [
        '기관별로 다릅니다만 반복',
        '공식 공지를 확인하세요만 반복',
        '요약 답변/세부 설명 라벨 반복',
        '환급 절차를 근거 없이 추가',
        '같은 문단 프레임 반복',
      ],
      obsidianLearningFields: [
        '확인된 공식 사실',
        '생성 후 사람이 고친 사실',
        '상위노출 키워드',
        '클릭을 만든 제목 조합',
        '반복이 과했던 표현',
        '다음 생성에서 금지할 문장',
      ],
    },
  },
  adsense_traffic: {
    key: 'adsense_traffic',
    name: '애드센스 유입용',
    description: '검색 유입을 목표로 소제목별 인용구, 반복 키워드, 서버 사전 생성 이미지를 함께 준비합니다.',
    articleGoal: 'search_traffic_adsense',
    targetPlatforms: ['naver_blog', 'naver_cafe', 'wordpress'],
    imagePipeline: {
      generationTiming: 'draft_generation',
      storage: 'server_generated_images',
      editorMode: 'extension_download_blob_then_upload',
      defaultSize: '500x500',
      alignment: 'center',
      manualReviewRequired: false,
      policy: '본문 생성 단계에서 대표 이미지와 섹션 이미지를 미리 만들고, 발행 단계에서는 서버 이미지를 받아 업로드만 수행',
    },
    writingRules: {
      quotePerSection: true,
      keywordRepeatBias: '+1',
      similarityRiskTarget: 'low',
      ctaPlacement: '도입 CTA 이후 또는 2번째 섹션 뒤',
    },
  },
  clinic_marketing_manual: {
    key: 'clinic_marketing_manual',
    name: '병의원/마케팅 수동 이미지형',
    description: '전문성/브랜드 검수가 필요한 업종용 예비 스킬입니다. 이미지는 사용자가 업로드하거나 수정한 뒤 발행합니다.',
    articleGoal: 'lead_generation_brand_marketing',
    targetPlatforms: ['naver_blog', 'wordpress'],
    imagePipeline: {
      generationTiming: 'manual_review',
      storage: 'user_uploaded_or_edited_assets',
      editorMode: 'extension_upload_reviewed_assets',
      defaultSize: 'custom',
      alignment: 'content_dependent',
      manualReviewRequired: true,
      policy: '의료/브랜드 이미지는 자동 생성본을 바로 발행하지 않고 사용자 검수/교체 후 사용',
    },
    writingRules: {
      quotePerSection: true,
      keywordRepeatBias: 'controlled',
      similarityRiskTarget: 'very_low',
      ctaPlacement: '상담/예약 문맥에 맞춰 수동 확정',
    },
  },
};

const CONTENT_SKILL_ALIASES = {
  adsense_verified_info: 'verified_info',
  adsense_traffic: 'verified_info',
};

function contentSkillFor(key = '') {
  const normalized = CONTENT_SKILL_ALIASES[key] || key || DEFAULT_REWRITE_SETTINGS.contentSkillKey;
  return CONTENT_SKILLS[normalized] || CONTENT_SKILLS.verified_info;
}

function promptSkillPayload(skill = CONTENT_SKILLS.verified_info) {
  const rules = skill.writingRules || {};
  return {
    key: skill.key,
    name: skill.name,
    articleGoal: skill.articleGoal,
    description: skill.description,
    quotePerSection: Boolean(rules.quotePerSection),
    keywordRepeatBias: rules.keywordRepeatBias || '',
    similarityRiskTarget: rules.similarityRiskTarget || 'low',
    ctaPlacement: rules.ctaPlacement || '',
    promptRules: Array.isArray(rules.promptRules) ? rules.promptRules : [],
    requiredFactSlots: Array.isArray(rules.requiredFactSlots) ? rules.requiredFactSlots : [],
    forbiddenPatterns: Array.isArray(rules.forbiddenPatterns) ? rules.forbiddenPatterns : [],
    obsidianLearningFields: Array.isArray(rules.obsidianLearningFields) ? rules.obsidianLearningFields : [],
  };
}

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
    contentSkillKey: raw.contentSkillKey || raw.content_skill_key || DEFAULT_REWRITE_SETTINGS.contentSkillKey,
    generatorMode: raw.generatorMode || raw.generator_mode || DEFAULT_REWRITE_SETTINGS.generatorMode,
    openaiModel: raw.openaiModel || raw.openai_model || DEFAULT_REWRITE_SETTINGS.openaiModel,
    useWebResearch: !['false', '0', 'off', 'no'].includes(String(raw.useWebResearch ?? raw.use_web_research ?? DEFAULT_REWRITE_SETTINGS.useWebResearch).toLowerCase()),
    targetCharCount: clampNumber(parseInt(raw.targetCharCount ?? raw.target_char_count ?? DEFAULT_REWRITE_SETTINGS.targetCharCount, 10) || DEFAULT_REWRITE_SETTINGS.targetCharCount, 1200, 5000),
    sectionCharCount: clampNumber(parseInt(raw.sectionCharCount ?? raw.section_char_count ?? DEFAULT_REWRITE_SETTINGS.sectionCharCount, 10) || DEFAULT_REWRITE_SETTINGS.sectionCharCount, 150, 700),
    sectionCount: clampNumber(parseInt(raw.sectionCount ?? raw.section_count ?? DEFAULT_REWRITE_SETTINGS.sectionCount, 10) || DEFAULT_REWRITE_SETTINGS.sectionCount, 3, 10),
    targetKwCount: clampNumber(parseInt(raw.targetKwCount ?? raw.keywordRepeatCount ?? raw.target_kw_count ?? DEFAULT_REWRITE_SETTINGS.targetKwCount, 10) || DEFAULT_REWRITE_SETTINGS.targetKwCount, 5, 30),
    imageCount: clampNumber(parseInt(raw.imageCount ?? raw.image_count ?? DEFAULT_REWRITE_SETTINGS.imageCount, 10) || DEFAULT_REWRITE_SETTINGS.imageCount, 0, 20),
    benchmarkUrl: raw.benchmarkUrl || raw.benchmark_url || DEFAULT_REWRITE_SETTINGS.benchmarkUrl,
  };
}

function buildPublishSpec(platform = 'blog', settingsInput = {}, overrides = {}) {
  const settings = parseRewriteSettings(settingsInput);
  const contentSkill = contentSkillFor(settings.contentSkillKey);
  const normalizedPlatform = normalizePlatform(platform);
  const sectionCount = settings.sectionCount;
  const plannedImageCount = plannedArticleImageCount(settings, sectionCount);
  const range = metricTargetRange(settings);
  const base = {
    mechanism: 'publish_generation',
    contentSkillKey: contentSkill.key,
    contentSkillName: contentSkill.name,
    platform: normalizedPlatform,
    structureMutation: '원문 구성 순서와 소제목 표현은 그대로 쓰지 않고 의도만 재배열',
    targetCharCount: settings.targetCharCount,
    minCharCount: range.minCharCount,
    maxCharCount: range.maxCharCount,
    sectionCharCount: settings.sectionCharCount,
    sectionCount,
    keywordRepeatCount: settings.targetKwCount + 1,
    minKeywordRepeatCount: range.minKwCount,
    maxKeywordRepeatCount: range.maxKwCount,
    thumbnailCount: 1,
    sectionImageCount: Math.max(0, plannedImageCount - 1),
    totalImageCount: plannedImageCount,
    imageSize: '500x500',
    imageAlignment: 'center',
    imageStyle: '상하좌우 여백 균형, 중앙정렬, 모바일에서 읽히는 고대비 텍스트 카드',
    imagePipeline: contentSkill.imagePipeline,
    imageEditorMode: contentSkill.imagePipeline.editorMode,
    imageStorage: contentSkill.imagePipeline.storage,
    manualImageReviewRequired: contentSkill.imagePipeline.manualReviewRequired,
    quotePerSection: normalizedPlatform === 'blog' || normalizedPlatform === 'cafe',
    quoteStyle: 'naver_quote_2',
    thumbnailCtaHyperlinkRequired: true,
    videoRequired: normalizedPlatform === 'blog',
    qrOrLinkRequired: true,
    qrPosition: '도입 CTA 이후 또는 2번째 목차 뒤',
    ctaUrlRequiredPerRow: true,
    customShortlinkFirst: true,
    fallbackNaverQr: true,
    ...overrides,
  };
  if (normalizedPlatform === 'cafe') {
    return {
      ...base,
      linkInsertionType: 'yellow_hyperlink_table',
      linkTableBackground: '#fff4b8',
      linkTableRule: '네이버 링크 위치에는 노란색 배경 표를 넣고 하이퍼링크를 연결',
    };
  }
  return {
    ...base,
    linkInsertionType: 'qr_or_plain_cta',
    linkTableBackground: null,
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
    imageCount: plannedArticleImageCount({ imageCount: summary.medianImageCount || DEFAULT_REWRITE_SETTINGS.imageCount, sectionCount }),
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
  const targetKwCount = clampNumber((settings.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount), 5, 24);
  const plannedImages = plannedArticleImageCount(settings, settings.sectionCount);

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
    keywordRepeatBuffer: 0,
    imageCount: plannedImages,
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
      imageAfterEachSection: false,
      imagePolicy: 'thumbnail_plus_first_core_sections_only',
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
  const cleanKeywordCompact = cleanKeyword.replace(/\s/g, '').toLowerCase();
  const cleanTopicCompact = cleanTopic.replace(/\s/g, '').toLowerCase();
  const subject = cleanTopic
    && cleanTopicCompact !== cleanKeywordCompact
    && !cleanTopicCompact.includes(cleanKeywordCompact)
    && !cleanKeywordCompact.includes(cleanTopicCompact)
    ? `${cleanKeyword} ${cleanTopic}`
    : cleanKeyword;
  const actionTerms = Array.isArray(pattern.sourceActionTerms) ? pattern.sourceActionTerms : [];
  const sourceKeywords = Array.isArray(pattern.sourceKeywords) ? pattern.sourceKeywords : [];
  const keywordSignals = [
    ...sourceKeywords,
    ...actionTerms.map((term) => `${cleanKeyword} ${term}`),
  ];
  const keywordPhrases = buildTitleKeywordPhrases({
    keyword: cleanKeyword,
    keywordSignals,
    actions: actionTerms,
  });
  const tail = keywordPhrases[0]
    ? `${keywordPhrases[0]} 정리`
    : titleIntentTail(cleanKeyword, cleanTopic, actionTerms);
  const title = cleanGeneratedTitle(`${subject} ${tail}`, { keyword: cleanKeyword, fallback: `${subject} ${titleIntentTail(cleanKeyword, cleanTopic, actionTerms)}` });
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

function normalizeSearchVolumeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).replace(/,/g, '').trim();
  if (!raw || raw === '-' || /^null$/i.test(raw)) return null;
  if (/^<\s*10/.test(raw)) return 9;
  const number = parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(number) ? number : null;
}

function keywordVolumeBand(volume) {
  const value = normalizeSearchVolumeNumber(volume);
  if (value === null) return { key: 'unknown', label: '검색량 미확인', color: '#e5e7eb', textColor: '#6b7280' };
  if (value <= 500) return { key: '0-500', label: '500 이하', color: '#fee2e2', textColor: '#991b1b' };
  if (value <= 1000) return { key: '501-1000', label: '501~1000', color: '#ffedd5', textColor: '#9a3412' };
  if (value <= 2000) return { key: '1001-2000', label: '1001~2000', color: '#fef3c7', textColor: '#92400e' };
  if (value <= 5000) return { key: '2001-5000', label: '2001~5000', color: '#dcfce7', textColor: '#166534' };
  return { key: '5000+', label: '5000 이상', color: '#dbeafe', textColor: '#1e40af' };
}

function naverKeywordToolCredentials(body = {}) {
  const customerId = String(
    body.customerId || body.naverCustomerId || body.naverSearchAdCustomerId
    || process.env.NAVER_SEARCHAD_CUSTOMER_ID || process.env.NAVER_AD_CUSTOMER_ID || ''
  ).trim();
  const accessLicense = String(
    body.accessLicense || body.naverAccessLicense || body.naverSearchAdAccessLicense
    || process.env.NAVER_SEARCHAD_ACCESS_LICENSE || process.env.NAVER_SEARCHAD_API_KEY || process.env.NAVER_AD_ACCESS_LICENSE || ''
  ).trim();
  const secretKey = String(
    body.secretKey || body.naverSecretKey || body.naverSearchAdSecretKey
    || process.env.NAVER_SEARCHAD_SECRET_KEY || process.env.NAVER_AD_SECRET_KEY || ''
  ).trim();
  return customerId && accessLicense && secretKey ? { customerId, accessLicense, secretKey } : null;
}

function naverSearchAdSignature({ timestamp, method, path: pathName, secretKey }) {
  return crypto.createHmac('sha256', secretKey).update(`${timestamp}.${method}.${pathName}`).digest('base64');
}

async function fetchNaverKeywordVolumes(keywords = [], credentials = null) {
  const uniqueKeywords = [...new Set(keywords.map(normalizeKeywordValue).filter(Boolean))].slice(0, 50);
  if (!credentials || uniqueKeywords.length === 0) return new Map();
  const pathName = '/keywordstool';
  const url = new URL(`https://api.searchad.naver.com${pathName}`);
  url.searchParams.set('hintKeywords', uniqueKeywords.join(','));
  url.searchParams.set('showDetail', '1');
  const timestamp = String(Date.now());
  const response = await fetch(url, {
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': credentials.accessLicense,
      'X-Customer': credentials.customerId,
      'X-Signature': naverSearchAdSignature({ timestamp, method: 'GET', path: pathName, secretKey: credentials.secretKey }),
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Naver SearchAd API ${response.status}: ${text.slice(0, 160)}`);
  }
  const data = await response.json();
  const map = new Map();
  for (const row of data.keywordList || []) {
    const keyword = normalizeKeywordValue(row.relKeyword || row.keyword || '');
    if (!keyword) continue;
    const pc = normalizeSearchVolumeNumber(row.monthlyPcQcCnt);
    const mobile = normalizeSearchVolumeNumber(row.monthlyMobileQcCnt);
    const searchVolume = (pc || 0) + (mobile || 0);
    const band = keywordVolumeBand(searchVolume);
    map.set(keyword.replace(/\s/g, '').toLowerCase(), {
      keyword,
      searchVolume,
      monthlyPcQcCnt: pc,
      monthlyMobileQcCnt: mobile,
      competition: row.compIdx || null,
      volumeBand: band.key,
      volumeBandLabel: band.label,
      volumeBandColor: band.color,
      volumeBandTextColor: band.textColor,
    });
  }
  return map;
}

function flattenAutocompletePayload(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenAutocompletePayload(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => flattenAutocompletePayload(item, out));
  return out;
}

async function fetchNaverAutocompleteKeywords(query = '') {
  const seed = normalizeKeywordValue(query);
  if (!seed) return [];
  const url = new URL('https://ac.search.naver.com/nx/ac');
  url.searchParams.set('q', seed);
  url.searchParams.set('q_enc', 'UTF-8');
  url.searchParams.set('st', '100');
  url.searchParams.set('r_format', 'json');
  url.searchParams.set('r_enc', 'UTF-8');
  url.searchParams.set('r_unicode', '0');
  url.searchParams.set('t_koreng', '1');
  url.searchParams.set('run', '2');
  url.searchParams.set('rev', '4');
  url.searchParams.set('con', '0');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 NaviWrite/1.0', Accept: 'application/json,text/plain,*/*' },
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => null);
  const seedCompact = seed.replace(/\s/g, '').toLowerCase();
  return [...new Set(flattenAutocompletePayload(data)
    .map((item) => stripHtml(item).replace(/\s+/g, ' ').trim())
    .filter((item) => {
      const compact = item.replace(/\s/g, '').toLowerCase();
      return item.length >= 2 && compact.includes(seedCompact.slice(0, Math.min(seedCompact.length, 3)));
    }))]
    .slice(0, 20);
}

function researchQuerySet(keyword = '', topic = '') {
  const seed = normalizeKeywordValue(keyword || topic);
  const subject = normalizeKeywordValue(topic || keyword);
  const queries = [
    seed,
    subject && subject !== seed ? subject : '',
    `${seed} 신청 방법`,
    `${seed} 기간`,
    `${seed} 공식`,
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 4);
}

function compactResearchItem(item = {}, query = '', rank = 0) {
  return {
    query,
    rank,
    title: stripHtml(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    description: stripHtml(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    link: String(item.link || '').trim().slice(0, 300),
  };
}

function dedupeResearchItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = (item.link || item.title || item.description || '').replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function researchUrlHost(link = '') {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function researchSourceType(link = '') {
  const host = researchUrlHost(link);
  if (!host) return 'unknown';
  if (/(^|\.)go\.kr$/.test(host) || host.endsWith('.gov.kr') || host === 'korea.kr') return 'official';
  if (host.includes('bokjiro.go.kr') || host.includes('easylaw.go.kr')) return 'official';
  if (host.endsWith('.or.kr') || host.endsWith('.re.kr')) return 'institution';
  if (host.includes('naver.com')) return 'naver';
  return 'web';
}

function researchSourcePriority(item = {}) {
  const host = researchUrlHost(item.link || '');
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  let score = 0;
  if (/(^|\.)go\.kr$/.test(host) || host.endsWith('.gov.kr')) score += 90;
  if (host === 'korea.kr') score += 85;
  if (host.includes('bokjiro.go.kr') || host.includes('easylaw.go.kr')) score += 80;
  if (host.endsWith('.or.kr') || host.endsWith('.re.kr')) score += 35;
  if (/(official|notice|policy|faq)/i.test(`${host} ${text}`)) score += 18;
  if (/(공식|공지|보도자료|정책|정부|지자체|신청|대상|기간|금액|사용처)/.test(text)) score += 14;
  if (host.includes('blog.naver.com') || host.includes('cafe.naver.com')) score -= 8;
  if (host.includes('m.site.naver.com') || host.includes('qr.naver.com')) score -= 30;
  score -= Math.max(0, Number(item.rank || 0) - 1) * 2;
  return score;
}

function compactFactText(text = '', max = 180) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]{1,40}\]/g, '')
    .trim()
    .slice(0, max);
}

function researchFactKinds(sentence = '') {
  const text = String(sentence || '');
  const checks = [
    ['dates', /(\d{4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*월|신청\s*기간|접수\s*기간|지급\s*일|사용\s*기한|마감|부터|까지|예정|일정)/],
    ['amounts', /([0-9,]+\s*(?:만\s*)?원|최대|최소|금액|지원금|지급액|환급|수강료|참가비|비용|만원|%)/],
    ['eligibility', /(대상|자격|소득|하위|기초생활수급자|차상위|한부모|건강보험료|가구|취약계층|제외|연령|거주|주민등록)/],
    ['apply', /(신청|접수|온라인|오프라인|본인\s*인증|주민센터|행정복지센터|카드사|앱|홈페이지|은행|예약|예매|티켓팅)/],
    ['usage', /(사용처|사용\s*기한|지역화폐|선불카드|신용카드|체크카드|소상공인|매장|업종|제한|환수|포인트)/],
    ['cautions', /(주의|유의|중복|허위|서류|증빙|보완|문의|공식|공지|변경|취소|환불|약관|확인)/],
  ];
  return checks.filter(([, regex]) => regex.test(text)).map(([kind]) => kind);
}

function extractResearchFactsFromText(text = '', source = {}, keyword = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const pieces = normalized
    .replace(/([.!?。]|다)\s+/g, '$1\n')
    .split(/\n+/)
    .map((piece) => compactFactText(piece, 220))
    .filter((piece) => piece.length >= 24 && piece.length <= 220);
  const facts = [];
  const seen = new Set();
  for (const piece of pieces) {
    const kinds = researchFactKinds(piece);
    if (!kinds.length) continue;
    const hasKeywordSignal = !keyword || piece.includes(keyword.split(/\s+/)[0]) || /(신청|대상|기간|금액|방법|사용처|공식|공지)/.test(piece);
    if (!hasKeywordSignal) continue;
    for (const kind of kinds) {
      const key = `${kind}:${piece.replace(/\s/g, '').slice(0, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        kind,
        text: piece,
        sourceTitle: source.title || '',
        sourceLink: source.link || '',
      });
    }
    if (facts.length >= 18) break;
  }
  return facts;
}

function bucketResearchFacts(facts = []) {
  const buckets = {
    dates: [],
    amounts: [],
    eligibility: [],
    apply: [],
    usage: [],
    cautions: [],
  };
  const seen = new Set();
  for (const fact of facts) {
    if (!buckets[fact.kind]) continue;
    const key = `${fact.kind}:${fact.text.replace(/\s/g, '').slice(0, 140)}`;
    if (seen.has(key) || buckets[fact.kind].length >= 5) continue;
    seen.add(key);
    buckets[fact.kind].push({
      text: compactFactText(fact.text, 170),
      sourceTitle: compactFactText(fact.sourceTitle, 80),
      sourceLink: fact.sourceLink,
    });
  }
  return buckets;
}

async function buildResearchFactPack({ items = [], keyword = '', topic = '' } = {}) {
  const rankedSources = dedupeResearchItems(items)
    .filter((item) => /^https?:\/\//i.test(item.link || ''))
    .filter((item) => !/(\.(png|jpe?g|gif|webp|pdf)$|m\.site\.naver\.com|qr\.naver\.com)/i.test(item.link || ''))
    .sort((a, b) => researchSourcePriority(b) - researchSourcePriority(a))
    .slice(0, 4);
  const sources = [];
  const facts = [];
  const errors = [];
  const subject = normalizeKeywordValue(keyword || topic);

  for (const item of rankedSources) {
    const host = researchUrlHost(item.link);
    const source = {
      title: item.title || host,
      link: item.link,
      host,
      sourceType: researchSourceType(item.link),
      priority: researchSourcePriority(item),
      fetched: false,
      factCount: 0,
    };
    try {
      const html = await fetchSourceHtml(item.link);
      const pageTitle = extractTitle(html, item.title || host);
      const text = stripHtml(extractNaverBodyHtml(html) || html).replace(/\s+/g, ' ').trim().slice(0, 9000);
      const pageFacts = extractResearchFactsFromText(text, { ...source, title: pageTitle }, subject);
      source.title = pageTitle || source.title;
      source.fetched = text.length > 80;
      source.factCount = pageFacts.length;
      facts.push(...pageFacts);
    } catch (err) {
      errors.push({ link: item.link, message: err.message });
    }
    sources.push(source);
  }

  const buckets = bucketResearchFacts(facts);
  const factTotal = Object.values(buckets).reduce((sum, list) => sum + list.length, 0);
  return {
    enabled: rankedSources.length > 0,
    available: factTotal > 0,
    sourceCount: sources.length,
    factCount: factTotal,
    generatedAt: new Date().toISOString(),
    sources: sources.slice(0, 4),
    facts: buckets,
    flowSlots: [
      { section: '대상/자격', factKinds: ['eligibility'] },
      { section: '금액/비용', factKinds: ['amounts'] },
      { section: '기간/일정', factKinds: ['dates'] },
      { section: '신청/접수 방법', factKinds: ['apply'] },
      { section: '사용처/환급/제한', factKinds: ['usage'] },
      { section: '주의사항/서류', factKinds: ['cautions'] },
    ],
    errors: errors.slice(0, 5),
  };
}

async function buildRewriteResearchContext({ keyword = '', topic = '', platform = 'blog', settings = {}, credentials: credentialOverride = null } = {}) {
  const enabled = settings.useWebResearch !== false;
  const seed = normalizeKeywordValue(keyword || topic);
  if (!enabled || !seed) {
    return { enabled: false, provider: enabled ? 'empty_keyword' : 'disabled', queries: [], items: [], factPack: null, autocompleteKeywords: [], errors: [] };
  }

  const queries = researchQuerySet(keyword, topic);
  const credentials = credentialOverride || naverSearchCredentials({});
  const normalizedPlatform = normalizePlatform(platform);
  const searchPlatform = normalizedPlatform === 'cafe' ? 'cafe' : normalizedPlatform === 'blog' ? 'blog' : 'web';
  const items = [];
  const totals = [];
  const errors = [];

  if (credentials) {
    for (const query of queries) {
      try {
        const result = await fetchNaverSearchResults({
          query,
          platform: searchPlatform,
          credentials,
          display: 5,
        });
        totals.push({ query, total: result.total ?? null });
        result.items.forEach((item, index) => items.push(compactResearchItem(item, query, index + 1)));
      } catch (err) {
        errors.push({ query, message: err.message });
      }
    }
  }

  let autocompleteKeywords = [];
  try {
    autocompleteKeywords = await fetchNaverAutocompleteKeywords(seed);
  } catch (err) {
    errors.push({ query: seed, message: `autocomplete: ${err.message}` });
  }
  const researchItems = dedupeResearchItems(items).slice(0, 12);
  const factPack = await buildResearchFactPack({
    items: researchItems,
    keyword: seed,
    topic,
  });
  const answerEngineSignals = buildAnswerEngineSignals({
    keyword: seed,
    topic,
    autocompleteKeywords,
    items: researchItems,
    factPack,
  });

  return {
    enabled: true,
    provider: credentials ? 'naver_search_api' : 'naver_autocomplete_only',
    queries,
    searchPlatform,
    totals,
    autocompleteKeywords: autocompleteKeywords.slice(0, 12),
    items: researchItems,
    factPack,
    answerEngineSignals,
    errors: errors.slice(0, 6),
  };
}

function buildAnswerEngineSignals({ keyword = '', topic = '', autocompleteKeywords = [], items = [], factPack = null } = {}) {
  const seed = normalizeKeywordValue(keyword || topic);
  const normalized = seed.replace(/\s+/g, ' ');
  const actionTerms = [
    '대상', '기준', '신청 방법', '신청 기간', '지급일', '금액', '사용처', '홈페이지',
    '조회', '서류', '지역', '주의사항', '결과 확인', '예약', '예매', '환급',
  ];
  const sourceText = [
    normalized,
    ...autocompleteKeywords,
    ...items.flatMap((item) => [item.title, item.description, item.query]),
  ].join(' ');
  const relatedTerms = [...new Set([
    ...autocompleteKeywords,
    ...actionTerms.filter((term) => sourceText.includes(term)).map((term) => `${normalized} ${term}`),
  ].map(normalizeKeywordValue).filter(Boolean))]
    .filter((term) => term.length >= 2)
    .slice(0, 18);

  const questionTemplates = [
    ['대상', `${normalized} 대상은 누구인가요?`],
    ['기준', `${normalized} 기준은 어떻게 확인하나요?`],
    ['신청', `${normalized} 신청 방법은 무엇인가요?`],
    ['기간', `${normalized} 신청 기간은 언제인가요?`],
    ['금액', `${normalized} 금액은 얼마인가요?`],
    ['사용처', `${normalized} 사용처는 어디인가요?`],
    ['서류', `${normalized} 준비 서류는 무엇인가요?`],
    ['주의', `${normalized} 신청 전 주의할 점은 무엇인가요?`],
  ];
  const factKinds = factPack?.facts ? Object.keys(factPack.facts).filter((key) => (factPack.facts[key] || []).length > 0) : [];
  const questions = questionTemplates
    .filter(([term]) => sourceText.includes(term) || factKinds.some((kind) => ({
      eligibility: '대상',
      amounts: '금액',
      dates: '기간',
      apply: '신청',
      usage: '사용처',
      cautions: '주의',
    }[kind] || '').includes(term)))
    .map(([, question]) => question);
  const fallbackQuestions = [
    `${normalized} 어디서 확인하나요?`,
    `${normalized} 지금 신청 가능한가요?`,
    `${normalized} 공식 기준은 어디에서 보나요?`,
  ];
  return {
    relatedSearchTerms: relatedTerms,
    relatedQuestions: [...new Set([...questions, ...fallbackQuestions])].slice(0, 10),
    briefingFormat: [
      '첫 문장에 사용자가 묻는 질문의 짧은 답을 먼저 둔다.',
      '두 번째 문단에서 조건, 예외, 확인 경로를 나눈다.',
      '마지막 문단은 사용자가 바로 할 행동 1개로 끝낸다.',
    ],
  };
}

async function enrichKeywordCandidates(candidates = [], { body = {}, seedQuery = '', limit = 20 } = {}) {
  const seed = seedQuery || candidates[0]?.keyword || '';
  let autocompleteKeywords = [];
  try {
    autocompleteKeywords = await fetchNaverAutocompleteKeywords(seed);
  } catch {
    autocompleteKeywords = [];
  }

  const byKey = new Map();
  const add = (candidate, source = '') => {
    const keyword = normalizeKeywordValue(candidate.keyword || candidate.term || candidate);
    if (!keyword) return;
    const key = keyword.replace(/\s/g, '').toLowerCase();
    const current = byKey.get(key) || { keyword, score: 0, count: 0, sources: [], category: candidate.category };
    current.score += Number(candidate.score || 0);
    current.count += Number(candidate.count || 0);
    current.searchTotal = candidate.searchTotal ?? current.searchTotal;
    current.serpTopTitles = candidate.serpTopTitles || current.serpTopTitles || [];
    current.suggestedTitles = candidate.suggestedTitles || current.suggestedTitles || [];
    current.verificationScore = Number(candidate.verificationScore || current.verificationScore || 0);
    current.sources = [...new Set([...(current.sources || []), ...(candidate.sources || []), source].filter(Boolean))];
    byKey.set(key, current);
  };

  candidates.forEach((candidate) => add(candidate));
  autocompleteKeywords.forEach((keyword, index) => add({ keyword, score: Math.max(18, 34 - index * 2) }, 'naver_autocomplete'));
  const keywordToolCredentials = naverKeywordToolCredentials(body);
  let volumeMap = new Map();
  let keywordToolWarning = '';
  if (keywordToolCredentials) {
    try {
      const toolSeeds = [
        ...byKey.values(),
        ...keywordVariantSeeds(seed).map((keyword) => ({ keyword })),
      ].map((item) => item.keyword);
      volumeMap = await fetchNaverKeywordVolumes(toolSeeds, keywordToolCredentials);
      for (const volume of volumeMap.values()) {
        if (!volume.keyword) continue;
        const score = Math.min(46, Math.log10(Number(volume.searchVolume || 0) + 1) * 8);
        add({ keyword: volume.keyword, score }, 'naver_keyword_tool');
      }
    } catch (err) {
      keywordToolWarning = err.message;
    }
  } else {
    keywordToolWarning = '키워드도구 미설정: SearchAd Customer ID, 액세스라이선스, 비밀키가 필요합니다.';
  }

  const merged = [...byKey.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, limit);

  return {
    hasKeywordTool: Boolean(keywordToolCredentials && !keywordToolWarning),
    keywordToolWarning,
    autocompleteKeywords,
    candidates: merged.map((candidate) => {
      const key = candidate.keyword.replace(/\s/g, '').toLowerCase();
      const volume = volumeMap.get(key) || {};
      const band = keywordVolumeBand(volume.searchVolume);
      return {
        ...candidate,
        score: Number(Number(candidate.score || 0).toFixed(2)),
        searchVolume: volume.searchVolume ?? null,
        monthlyPcQcCnt: volume.monthlyPcQcCnt ?? null,
        monthlyMobileQcCnt: volume.monthlyMobileQcCnt ?? null,
        competition: volume.competition ?? null,
        volumeBand: volume.volumeBand || band.key,
        volumeBandLabel: volume.volumeBandLabel || band.label,
        volumeBandColor: volume.volumeBandColor || band.color,
        volumeBandTextColor: volume.volumeBandTextColor || band.textColor,
      };
    }).sort((a, b) => {
      const av = a.searchVolume ?? -1;
      const bv = b.searchVolume ?? -1;
      if (av !== bv) return bv - av;
      return Number(b.score || 0) - Number(a.score || 0);
    }),
  };
}

const KEYWORD_DEMAND_ACTION_TERMS = [
  '신청', '신청기간', '기간', '대상', '지급일', '방법', '기준', '조건',
  '금액', '사용처', '조회', '지역', '서류', '홈페이지', '바로가기',
];

function rankKeywordRecommendations(candidates = [], { seedQuery = '', hasKeywordTool = false } = {}) {
  const seed = normalizeKeywordValue(seedQuery);
  const seedCompact = seed.replace(/\s/g, '').toLowerCase();
  const scoreCandidate = (candidate) => {
    const keyword = normalizeKeywordValue(candidate.keyword || '');
    const compact = keyword.replace(/\s/g, '').toLowerCase();
    const searchVolume = normalizeSearchVolumeNumber(candidate.searchVolume);
    const searchTotal = Number(candidate.searchTotal || 0);
    const hasVolume = searchVolume !== null;
    const containsSeed = seedCompact && compact.includes(seedCompact);
    const seedContainsKeyword = seedCompact && seedCompact.includes(compact);
    const exactSeed = seedCompact && compact === seedCompact;
    const hasStrongAction = KEYWORD_DEMAND_ACTION_TERMS.some((term) => keyword.includes(term) && !seed.includes(term));
    const verifiedDemand = hasVolume || searchTotal > 0;
    const demandValue = hasVolume ? searchVolume : searchTotal;
    const relevanceBase = containsSeed ? 1_000_000_000 : seedContainsKeyword ? 240_000_000 : 0;
    const actionBoost = hasStrongAction && verifiedDemand ? 420_000_000 : 0;
    const exactPenalty = exactSeed && !hasKeywordTool ? 160_000_000 : 0;
    const unverifiedPenalty = !verifiedDemand ? 240_000_000 : 0;
    const weakRelationPenalty = !containsSeed && !seedContainsKeyword ? 260_000_000 : 0;
    return relevanceBase + actionBoost - exactPenalty - unverifiedPenalty - weakRelationPenalty + demandValue;
  };

  return [...candidates].sort((a, b) => {
    const rankDiff = scoreCandidate(b) - scoreCandidate(a);
    if (rankDiff !== 0) return rankDiff;
    const av = normalizeSearchVolumeNumber(a.searchVolume) ?? Number(a.searchTotal || 0);
    const bv = normalizeSearchVolumeNumber(b.searchVolume) ?? Number(b.searchTotal || 0);
    if (av !== bv) return bv - av;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

async function researchKeywordsFromText({ title = '', text = '', sourceUrl = '', platform = 'blog', category = 'general', body = {}, limit = 12 }) {
  const candidateMap = new Map();
  const addCandidate = (keyword, score = 0, source = '', extra = {}) => {
    const normalized = normalizeKeywordValue(keyword);
    if (!normalized || normalized.replace(/\s/g, '').length < 2) return;
    const key = normalized.replace(/\s/g, '').toLowerCase();
    const current = candidateMap.get(key) || { keyword: normalized, score: 0, count: 0, sources: [], category };
    current.score += Number(score || 0);
    current.count += Number(extra.count || 0);
    current.sources = [...new Set([...(current.sources || []), source].filter(Boolean))];
    candidateMap.set(key, current);
  };

  inferKeywordCandidates({ title, text: `${title}\n${text}`, subheadings: [], keywordSignals: [] })
    .forEach((item) => addCandidate(item.keyword, Number(item.score || 0), 'rss_text', { count: item.count || 0 }));

  const credentials = naverSearchCredentials(body);
  const candidates = [...candidateMap.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, limit);
  for (const candidate of candidates.slice(0, 6)) {
    if (!credentials) break;
    try {
      const search = await fetchNaverSearchResults({ query: candidate.keyword, platform, credentials, display: 5 });
      candidate.searchTotal = search.total;
      candidate.serpTopTitles = search.items.map((item) => item.title).filter(Boolean).slice(0, 5);
      candidate.sources.push('naver_search_verified');
      candidate.score = Number((candidate.score + Math.min(24, Math.log10(Number(search.total || 0) + 1) * 4)).toFixed(2));
    } catch {
      break;
    }
  }

  const enriched = await enrichKeywordCandidates(candidates, {
    body,
    seedQuery: title || sourceUrl || candidates[0]?.keyword || '',
    limit,
  });
  return { ...enriched, platform, category, mainKeyword: enriched.candidates[0]?.keyword || candidates[0]?.keyword || '' };
}

const TITLE_RECOMMENDATION_ACTIONS = [
  '링크', '결과', '유형', '확인', '방법', '정리', '신청', '대상', '기준', '지급일',
  '일정', '예매', '가격', '후기', '추천', '비교', '주의사항', '바로가기',
  '기간', '금액', '사용처', '조회', '지역', '조건', '서류', '홈페이지',
  '사이트', '날짜', '시간', '장소', '혜택', '변경', '최신', '발표', '지원', '환급', '지급',
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

function keywordVariantSeeds(seed = '') {
  const keyword = normalizeKeywordValue(seed);
  if (!keyword) return [];
  const variants = [keyword];
  const compact = keyword.replace(/\s/g, '');
  if (compact !== keyword) variants.push(compact);
  if (/^\d+차\s+/.test(keyword)) {
    variants.push(keyword.replace(/^(\d+차)\s+(.+)$/, '$2 $1'));
  }
  if (/지원금/.test(keyword) && !/신청/.test(keyword)) variants.push(`${keyword} 신청`);
  if (/지원금|정책|수당|급여|환급/.test(keyword)) {
    variants.push(`${keyword} 대상`);
    variants.push(`${keyword} 지급일`);
    variants.push(`${keyword} 신청방법`);
    variants.push(`${keyword} 신청기간`);
    variants.push(`${keyword} 금액`);
    variants.push(`${keyword} 사용처`);
  }
  return [...new Set(variants.map(normalizeKeywordValue).filter(Boolean))].slice(0, 8);
}

function compactTitleCandidate(value = '') {
  let title = normalizeTitleValue(value)
    .replace(/반갑\s*여행/g, '반값여행')
    .replace(/\s*[–—-]\s*(홈페이지|공식\s*홈페이지|바로|쉽게|지금|클릭|시작|확인).*$/i, '')
    .replace(/홈페이지에서\s*/g, '')
    .replace(/쉽게\s*시작하세요/g, '')
    .replace(/지금\s*바로\s*/g, '')
    .replace(/클릭하세요|확인하세요|알아보세요|시작하세요/g, '')
    .replace(/신청방법/g, '신청 방법')
    .replace(/일정안내/g, '일정 안내')
    .replace(/공식\s*홈페이지\s*정보/g, '공식 홈페이지')
    .replace(/홈페이지\s*정보/g, '홈페이지')
    .replace(/신청\s*방법과\s*일정\s*안내/g, '신청 방법 일정 안내')
    .replace(/신청\s*방법\s*및\s*일정\s*안내/g, '신청 방법 일정 안내')
    .replace(/일정\s*안내와\s*공식\s*홈페이지/g, '일정 안내 공식 홈페이지')
    .replace(/일정\s*안내\s*및\s*공식\s*홈페이지/g, '일정 안내 공식 홈페이지')
    .replace(/대상과\s*신청\s*방법/g, '대상 신청 방법')
    .replace(/\s+(및|와|과)\s+/g, ' ')
    .replace(/\s+(정리|확인|방법|알아보기)\s+\1/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i += 1) {
    title = title.replace(/(^|\s)([^\s]+)\s+\2(?=\s|$)/g, '$1$2');
  }
  return title;
}

function cleanGeneratedTitle(value = '', { keyword = '', fallback = '' } = {}) {
  let title = compactTitleCandidate(value);
  const cleanKeyword = normalizeKeywordValue(keyword);
  if (!title || (cleanKeyword && !title.includes(cleanKeyword))) {
    title = compactTitleCandidate(fallback || `${cleanKeyword} 신청 방법 일정 안내`);
  }
  if (/신청/.test(title) && /일정/.test(title) && !/안내|정리|확인|방법/.test(title)) {
    title = compactTitleCandidate(`${title} 안내`);
  }
  return title.slice(0, 70);
}

function buildTitleKeywordPhrases({ keyword = '', keywordSignals = [], actions = [] }) {
  const cleanKeyword = normalizeKeywordValue(keyword);
  const phrases = [];
  const seen = new Set();
  const addPhrase = (terms = []) => {
    const picked = [...new Set(terms
      .map(normalizeKeywordValue)
      .filter((term) => term && !cleanKeyword.includes(term)))]
      .slice(0, 3);
    if (picked.length === 0) return;
    const phrase = picked.join(' ');
    const key = phrase.replace(/\s/g, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    phrases.push(phrase);
  };

  keywordSignals.forEach((signal) => {
    const text = normalizeKeywordValue(signal);
    const terms = TITLE_RECOMMENDATION_ACTIONS.filter((term) => text.includes(term));
    addPhrase(terms);
  });

  for (let i = 0; i < actions.length; i += 1) {
    addPhrase(actions.slice(i, i + 3));
  }

  return phrases.slice(0, 6);
}

function generateTitleCandidates({ keyword, topic = '', platform = 'blog', category = '', analyses = [], keywordSignals = [] }) {
  const cleanKeyword = normalizeKeywordValue(keyword);
  const cleanTopic = normalizeKeywordValue(topic);
  const policyIntent = isPolicySupportKeyword(`${cleanKeyword} ${cleanTopic}`);
  const cleanKeywordCompact = cleanKeyword.replace(/\s/g, '').toLowerCase();
  const cleanSignals = [...new Set(keywordSignals.map(normalizeKeywordValue).filter((item) => item && item !== cleanKeyword))]
    .filter((item) => item.replace(/\s/g, '').toLowerCase() !== cleanKeywordCompact)
    .slice(0, 5);
  const sourceTitles = analyses.map((row) => row.title).filter(Boolean);
  const sourceText = [
    ...sourceTitles,
    ...analyses.flatMap((row) => Array.isArray(row.subheadings) ? row.subheadings : []),
    ...cleanSignals,
    category,
    cleanTopic,
  ].join(' ');
  const actions = titleRecommendationActions(sourceText);
  const tail = titleIntentTail(cleanKeyword, cleanTopic, actions);
  const cleanTopicCompact = cleanTopic.replace(/\s/g, '').toLowerCase();
  const subject = cleanTopic
    && cleanTopicCompact !== cleanKeywordCompact
    && !cleanTopicCompact.includes(cleanKeywordCompact)
    && !cleanKeywordCompact.includes(cleanTopicCompact)
    ? `${cleanKeyword} ${cleanTopic}`
    : cleanKeyword;
  const signalActionTerms = cleanSignals
    .flatMap((signal) => TITLE_RECOMMENDATION_ACTIONS.filter((term) => signal.includes(term)))
    .filter((term) => !cleanKeyword.includes(term));
  const actionBlend = [...new Set([...signalActionTerms, ...actions])].slice(0, 3);
  const keywordPhrases = buildTitleKeywordPhrases({ keyword: cleanKeyword, keywordSignals: cleanSignals, actions: actionBlend });
  const hasApplyTerm = /신청/.test(cleanKeyword);
  const candidates = [
    ...(policyIntent ? [
      `${cleanKeyword} 대상 지급일 ${hasApplyTerm ? '정리' : '신청 방법'}`,
      `${cleanKeyword} ${hasApplyTerm ? '금액 사용처 정리' : '신청 대상 금액 사용처 정리'}`,
      `${cleanKeyword} ${hasApplyTerm ? '기간 지급일 확인 방법' : '신청기간 지급일 확인 방법'}`,
      `${cleanKeyword} 정부24 ${hasApplyTerm ? '방법 대상 정리' : '신청 방법 대상 정리'}`,
      `${cleanKeyword} 지역별 대상 기준 확인 방법`,
    ] : []),
    `${subject} ${tail}`,
    `${cleanKeyword} ${actionBlend.join(' ')} 정리`,
    ...keywordPhrases.map((phrase) => `${cleanKeyword} ${phrase} 정리`),
    ...keywordPhrases.slice(0, 3).map((phrase) => `${cleanKeyword} ${phrase} 확인 방법`),
    `${cleanKeyword} ${cleanTopic || '핵심'} 확인 방법`,
    ...cleanSignals.slice(0, 4).map((signal) => {
      const tailFromSignal = signal.includes(cleanKeyword)
        ? signal.replace(cleanKeyword, '').trim()
        : titleRecommendationActions(signal).filter((term) => !cleanKeyword.includes(term)).join(' ');
      return `${cleanKeyword} ${tailFromSignal || signal} 정리`;
    }),
    `${cleanKeyword} 바로가기 링크 결과 정리`,
    `${cleanKeyword} 대상 기준 신청 방법`,
    ...(!policyIntent ? [`${cleanKeyword} 일정 예매 가격 확인`, `${cleanKeyword} 후기 주의사항 총정리`] : []),
    `${cleanKeyword} ${category || '정보'} 최신 기준 정리`,
    makeRewriteTitle(cleanKeyword, cleanTopic, platform, { sourceActionTerms: actions }),
    ...sourceTitles.slice(0, 4).map((title) => `${cleanKeyword} ${titleRecommendationActions(title).slice(0, 3).join(' ')} 정리`),
  ];

  return [...new Set(candidates.map((title) => cleanGeneratedTitle(title, {
    keyword: cleanKeyword,
    fallback: `${cleanKeyword} ${titleIntentTail(cleanKeyword, cleanTopic, actions)}`,
  })).filter((title) => {
    if (!title || !title.includes(cleanKeyword)) return false;
    if (policyIntent && /예매|티켓팅|티켓|유형|결과|가격/.test(title)) return false;
    if (policyIntent && (title.match(/신청(?!기간)/g) || []).length > 1) return false;
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

function isPolicySupportKeyword(keyword = '') {
  return /민생|지원금|소비쿠폰|환급|급여|수당|바우처|고유가/.test(String(keyword || ''));
}

function rewriteIntroParagraphs({ keyword = '', subject = '', topic = '', category = '', isPolicySupport = false, variantIndex = 0 }) {
  const source = `${keyword} ${subject} ${topic} ${category}`;
  const pick = (sets) => sets[Math.abs(variantIndex) % sets.length];
  if (isPolicySupport) {
    const policyKeyword = keyword.includes('신청') ? keyword : `${keyword} 신청`;
    return pick([
      [
        `${keyword}는 비슷한 이름의 안내가 많아서 먼저 대상과 신청 기준을 나눠 보는 게 좋습니다.`,
        `특히 지원금성 정보는 중앙정부 공통 정책인지, 지자체 자체 사업인지에 따라 지급일과 사용처가 달라질 수 있습니다.`,
        `이번 글에서는 ${policyKeyword} 대상, 지급일, 금액, 사용처를 확인하는 순서 중심으로 정리하겠습니다.`,
      ],
      [
        `${keyword}를 찾다 보면 금액부터 지급일, 사용처까지 정보가 흩어져 있어 헷갈리기 쉽습니다.`,
        `이럴 때는 내 지역에서 신청 가능한지, 어떤 방식으로 지급되는지, 어디에서 쓸 수 있는지를 먼저 확인해야 합니다.`,
        `아래에서는 ${keyword} 기준과 신청 전 체크할 부분을 단계별로 살펴보겠습니다.`,
      ],
      [
        `${keyword} 관련 공지가 나오면 가장 먼저 확인해야 할 부분은 대상 여부와 실제 신청 기간입니다.`,
        `같은 지원금처럼 보여도 지역별 공고나 카드사 안내에 따라 세부 조건이 달라지는 경우가 있습니다.`,
        `그래서 이번 글에서는 ${keyword} 확인 방법을 신청 흐름에 맞춰 정리했습니다.`,
      ],
    ]);
  }
  if (/테스트|검사|유형|결과|성격|MBTI|SBTI|링크|사이트/i.test(source)) {
    return pick([
      [
        `${keyword} 관련 캡처가 SNS와 단톡방에 자주 보이길래 어떤 테스트인지 직접 흐름을 정리해봤습니다.`,
        `처음에는 익숙한 성격 검사 변형처럼 보였지만, 진행 방식과 결과 유형을 보면 확인할 포인트가 따로 있습니다.`,
        `이번 글에서는 ${keyword} 진행 방법, 결과 확인 기준, 링크 이용 시 주의할 점을 중심으로 살펴보겠습니다.`,
      ],
      [
        `${keyword}를 검색해보면 링크와 결과 이야기가 함께 나오는데, 막상 어디서 시작해야 하는지 헷갈릴 수 있습니다.`,
        `테스트형 콘텐츠는 문항 수, 결과 유형, 공유 방식만 먼저 알아도 전체 흐름을 빠르게 파악할 수 있습니다.`,
        `아래에서는 ${keyword}를 처음 해보는 분들이 확인하면 좋은 핵심만 순서대로 정리했습니다.`,
      ],
      [
        `요즘 ${keyword} 이야기가 자주 보이면서 결과 유형이나 접속 링크를 찾는 분들이 늘고 있습니다.`,
        `비슷한 이름의 페이지가 섞여 있을 수 있어 진행 전에는 공식 경로와 결과 해석 방식을 함께 보는 편이 좋습니다.`,
        `이번 글에서는 ${keyword}의 기본 구조와 확인 방법을 읽기 쉽게 정리해드리겠습니다.`,
      ],
    ]);
  }
  if (/가격|재고|판매처|구매|상품|제품|예매|예약|티켓|일정/.test(source)) {
    return pick([
      [
        `${keyword}를 알아볼 때는 가격이나 일정만 보는 것보다 실제 구매 가능 여부와 확인 경로를 함께 봐야 합니다.`,
        `비슷한 안내가 많아도 판매처, 재고, 예약 방식에 따라 체감 정보가 크게 달라질 수 있습니다.`,
        `이번 글에서는 ${keyword} 확인 순서와 놓치기 쉬운 체크 포인트를 정리했습니다.`,
      ],
      [
        `${keyword}는 검색 결과마다 정보가 조금씩 달라서 한 번에 기준을 잡아두는 편이 편합니다.`,
        `먼저 일정과 조건을 보고, 그다음 가격이나 판매처처럼 바로 행동으로 이어지는 항목을 확인하면 됩니다.`,
        `아래에서는 ${keyword}를 볼 때 필요한 핵심 기준을 순서대로 살펴보겠습니다.`,
      ],
    ]);
  }
  return pick([
    [
      `${keyword}를 찾아보면 설명은 많지만 실제로 무엇부터 확인해야 하는지 한눈에 잡히지 않을 때가 많습니다.`,
      `${subject}은 기준과 순서를 먼저 잡아두면 필요한 정보만 빠르게 걸러볼 수 있습니다.`,
      `이번 글에서는 ${keyword} 핵심 기준과 확인 방법, 주의할 부분을 순서대로 정리하겠습니다.`,
    ],
    [
      `${keyword}는 겉으로 보기엔 간단해 보여도 막상 확인하려면 비교해야 할 항목이 꽤 있습니다.`,
      `그래서 먼저 큰 기준을 잡고, 그다음 세부 조건과 실제 확인 순서를 보는 방식이 가장 깔끔합니다.`,
      `아래에서는 ${keyword}를 처음 보는 분도 이해하기 쉽게 핵심만 나눠서 살펴보겠습니다.`,
    ],
    [
      `${keyword} 관련 정보를 보다 보면 같은 표현이 반복돼도 실제로 필요한 내용은 사람마다 다를 수 있습니다.`,
      `중요한 건 지금 내 상황에서 확인해야 할 기준과 바로 실행할 수 있는 순서를 구분하는 것입니다.`,
      `이번 글에서는 ${keyword}를 판단할 때 필요한 흐름을 중심으로 정리했습니다.`,
    ],
  ]);
}

function makeSectionTitles(keyword, topic, count, variantIndex = 0) {
  const subject = topic || keyword;
  if (isPolicySupportKeyword(keyword)) {
    const policySets = [
      [
        `${keyword} 현재 먼저 확인할 부분`,
        `${keyword} 대상 기준`,
        `${keyword} 신청 방법`,
        `${keyword} 지급일과 사용처`,
        `${keyword} 지역별 차이`,
        `${keyword} 주의사항`,
        `${keyword} 자주 묻는 질문`,
        `${keyword} 최종 체크`,
      ],
      [
        `${keyword} 공식 안내 확인 순서`,
        `${keyword} 신청 대상 정리`,
        `${keyword} 온라인 방문 신청`,
        `${keyword} 금액과 지급 방식`,
        `${keyword} 지자체별 확인 포인트`,
        `${keyword} 놓치기 쉬운 부분`,
        `${keyword} 신청 전 준비물`,
        `${keyword} 마무리 요약`,
      ],
    ];
    return policySets[Math.abs(variantIndex) % policySets.length].slice(0, count);
  }
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
  const cornerLabel = index === 0 ? 'COVER' : `NAVI ${String(index).padStart(2, '0')}`;
  const safeKeyword = escapeSvgText(String(keyword || '').slice(0, 16));
  const safeSection = escapeSvgText(String(section || '').slice(0, 18));
  const safeSubtitle = escapeSvgText(String(subtitle || '핵심만 정리').slice(0, 20));
  const safeCornerLabel = escapeSvgText(cornerLabel);
  const cornerSvg = `
    <path d="M0 0 H108 L0 108 Z" fill="${accent}" opacity="0.88"/>
    <path d="M0 0 H76 L0 76 Z" fill="${primary}" opacity="0.10"/>
    <rect x="34" y="42" width="52" height="5" rx="2.5" fill="${primary}" opacity="0.72"/>
    <text x="34" y="66" text-anchor="start" font-family="Arial, sans-serif" font-size="12" font-weight="900" letter-spacing="1.2" fill="${primary}">${safeCornerLabel}</text>
    <circle cx="96" cy="35" r="4" fill="${primary}" opacity="0.48"/>`;
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
    ${cornerSvg}
    ${layoutSvg}
    <rect x="78" y="406" width="344" height="5" fill="${primary}" opacity="0.22"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function buildRewriteDraft({ keyword, topic, platform, ctaUrl, useNaverQr, useAiImages = true, pattern, customTitle = '', variantIndex = 0 }) {
  return buildRewriteDraftV2({ keyword, topic, platform, ctaUrl, useNaverQr, useAiImages, pattern, customTitle, variantIndex });
  const title = normalizeTitleValue(customTitle) || makeRewriteTitle(keyword, topic, platform, pattern);
  const bodySectionCount = Math.max(1, (pattern.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount) - 1);
  const sectionTitles = makeSectionTitles(keyword, topic, bodySectionCount, variantIndex);
  const subject = normalizeKeywordValue(topic) || normalizeKeywordValue(keyword);
  const isPolicySupport = isPolicySupportKeyword(keyword);
  const targetSectionChars = pattern.sectionCharCount || DEFAULT_REWRITE_SETTINGS.sectionCharCount;
  const desiredKwCount = pattern.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount;
  const publishSpec = buildPublishSpec(platform, pattern.settings || pattern, { hasCtaUrl: Boolean(ctaUrl), useNaverQr });
  const requiredImageCount = plannedArticleImageCount(pattern.settings || pattern, pattern.sectionCount || sectionTitles.length);
  const sectionImageLimit = Math.max(0, requiredImageCount - 1);
  const intro = rewriteIntroParagraphs({
    keyword,
    subject,
    topic,
    category: pattern.category || pattern.sourceCategory || '',
    isPolicySupport,
    variantIndex,
  });
  const linkTarget = ctaUrl || '[글별 CTA 링크 입력 필요]';
  const cta = platform === 'cafe'
    ? [
        `${keyword} 관련 확인 링크는 아래 표에서 바로 볼 수 있게 배치합니다.`,
        '| 구분 | 바로가기 |',
        '| --- | --- |',
        `| ${keyword} 확인 | ${linkTarget} |`,
        '[카페 표 스타일: 배경 #fff4b8, 링크 셀 하이퍼링크 적용]',
      ]
    : [
        `지금 바로 아래에서 ${keyword} 관련 내용을 확인하세요.`,
        linkTarget,
        useNaverQr
          ? `[네이버 QR 삽입 위치: ${linkTarget}]`
          : `[링크 삽입 위치: ${linkTarget}]`,
      ];
  const bodyParts = [title, ''];
  if (useAiImages) {
    bodyParts.push(`[대표이미지 500x500 중앙정렬: ${title}]`);
    bodyParts.push('');
  }
  bodyParts.push(...intro, '', ...cta, '');
  if (platform === 'blog') {
    bodyParts.push(`[네이버 동영상 업로드 위치: ${keyword} 핵심 요약 15초 영상]`);
    bodyParts.push('');
  }

  const makeSectionBody = (section, index) => {
    const policySentences = [
      `${index + 1}. ${section}에서는 ${keyword}를 볼 때 가장 먼저 확인해야 할 기준을 나눠서 정리합니다.`,
      `지원금 정보는 이름이 비슷해도 중앙정부 사업, 광역 지자체 사업, 시군구 자체 사업으로 갈리는 경우가 많습니다.`,
      `따라서 신청 전에는 주민등록상 주소지 공고와 정부24, 카드사 앱, 지역화폐 앱 안내를 함께 확인하는 편이 안전합니다.`,
      `대상은 보통 소득 기준, 취약계층 여부, 거주 기준일, 신청 기간을 함께 보며 지역마다 금액과 지급 방식이 달라질 수 있습니다.`,
      `지급 방식은 카드 포인트, 선불카드, 지역화폐처럼 소비처가 제한되는 구조가 많아 사용처를 먼저 확인해야 합니다.`,
      `${keyword}는 확정 공고가 나오면 일정이 빠르게 지나갈 수 있으니 신청 시작일과 마감일을 따로 적어두는 것이 좋습니다.`,
    ];
    const generalSentences = [
      `${index + 1}. ${section}에서는 ${keyword}를 판단할 때 먼저 봐야 할 기준을 간단히 나눠서 정리합니다.`,
      `${subject}은 한 가지 조건만 보고 결정하기보다 상황, 목적, 진행 시점까지 같이 비교해야 결과가 자연스럽습니다.`,
      `특히 검색자가 궁금해하는 지점은 “그래서 내가 지금 무엇을 하면 되는가”이기 때문에 설명은 짧게 끊고 실제 확인 순서 중심으로 배치하는 편이 좋습니다.`,
      `이 단계에서는 ${keyword}의 핵심 기준을 먼저 확인하고, 예외가 생길 수 있는 부분은 따로 표시해두는 방식이 안정적입니다.`,
      `너무 많은 정보를 한꺼번에 넣기보다 필요한 항목을 순서대로 보여주면 모바일에서도 읽는 흐름이 끊기지 않습니다.`,
      `마지막으로 실제 적용 전에는 날짜, 대상, 조건처럼 바뀔 수 있는 값만 한 번 더 확인하는 편이 좋습니다.`,
    ];
    const sentences = isPolicySupport ? policySentences : generalSentences;
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
      bodyParts.push(`[이미지 ${index + 1} 500x500 중앙정렬: ${section}]`);
      bodyParts.push('');
      if (extraImageCursor < extraImageSlots) {
        bodyParts.push(`[보조 이미지 ${extraImageCursor + 1} 500x500 중앙정렬: ${section} 핵심 카드]`);
        bodyParts.push('');
        extraImageCursor += 1;
      }
    }
  });

  bodyParts.push('> 마무리');
  bodyParts.push('');
  bodyParts.push(isPolicySupport
    ? `${keyword}는 지역과 시점에 따라 내용이 달라질 수 있어 공식 공고 확인이 가장 중요합니다.`
    : `${keyword}는 단순히 정보만 많이 나열한다고 읽히는 주제가 아닙니다.`);
  bodyParts.push(isPolicySupport
    ? `먼저 내 주소지 기준 대상 여부를 확인하고, 그다음 신청 기간, 지급 방식, 사용처를 순서대로 보면 헷갈릴 가능성이 줄어듭니다.`
    : `처음에는 ${subject}의 핵심 기준을 잡고, 중간에는 실제 확인 방법과 주의사항을 배치한 뒤, 마지막에는 바로 실행할 수 있는 요약으로 닫는 구성이 안정적입니다.`);
  bodyParts.push(useNaverQr ? `QR은 도입 CTA 이후나 두 번째 목차 뒤에 배치하고, 링크는 글별 CTA 컬럼값을 우선 사용합니다.` : `CTA 링크는 도입부 직후와 마무리 직전에 한 번씩만 배치하는 편이 깔끔합니다.`);

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
    ? Array.from({ length: Math.max(0, requiredImageCount) }, (_, index) => {
        if (index === 0) {
          return {
            index,
            role: 'cover',
            label: '대표 이미지',
            title,
            section: title,
            caption: imageCaptionLabel(keyword, title, index),
            prompt: `${keyword} 대표 이미지`,
            url: makeTemplateImage({ keyword, section: title, subtitle: '새 글 초안', index, platform }),
            width: 500,
            height: 500,
          };
        }
        const section = sectionTitles[(index - 1) % Math.max(sectionTitles.length, 1)] || title;
        return {
          index,
          role: 'section',
          label: `이미지 ${index}`,
          title: section,
          section,
          caption: imageCaptionLabel(keyword, section, index),
          prompt: `${keyword} ${section} 섹션 이미지`,
          url: makeTemplateImage({ keyword, section, subtitle: `${index}번째 핵심`, index, platform }),
          width: 500,
          height: 500,
        };
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
    publishSpec,
  };
}

function safeJsonFromModelText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('OpenAI 응답이 비어 있습니다.');
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('OpenAI 응답 JSON 파싱에 실패했습니다.');
  }
}

function extractOpenAiChatText(data = {}) {
  const message = data?.choices?.[0]?.message || {};
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        return part.text || part.output_text || part.input_text || part.content || '';
      })
      .join('\n')
      .trim();
  }
  return String(data.output_text || '').trim();
}

function openAiEmptyResponseMessage(data = {}, model = '') {
  const choice = data?.choices?.[0] || {};
  const finishReason = choice.finish_reason || 'unknown';
  const usage = data?.usage || {};
  const used = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
    .map((value) => Number(value || 0))
    .join('/');
  return `OpenAI 응답이 비어 있습니다. model=${model || 'unknown'}, finish_reason=${finishReason}, usage=${used}`;
}

async function fetchOpenAiChatJson({ openAi, model, messages, maxCompletionTokens, temperature = 0.6, operation = 'OpenAI' }) {
  const normalizedModel = normalizeOpenAiModel(model);
  const fallbackModel = normalizeOpenAiModel(process.env.OPENAI_FALLBACK_WRITER_MODEL || 'gpt-4.1-mini');
  const models = [normalizedModel];
  if (normalizedModel.startsWith('gpt-5') && fallbackModel && fallbackModel !== normalizedModel) models.push(fallbackModel);

  let lastError = null;
  for (const currentModel of models) {
    const requestBody = {
      model: currentModel,
      response_format: { type: 'json_object' },
      messages,
    };
    if (currentModel.startsWith('gpt-5')) {
      requestBody.max_completion_tokens = maxCompletionTokens;
    } else {
      requestBody.temperature = temperature;
      requestBody.max_tokens = maxCompletionTokens;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAi.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || `${operation} API error ${response.status}`);
    }

    const content = extractOpenAiChatText(data);
    if (content) return { data, content, model: currentModel };

    lastError = new Error(openAiEmptyResponseMessage(data, currentModel));
  }
  throw lastError || new Error(`${operation} response was empty`);
}

const GENERATED_EDITOR_PLACEHOLDER_PATTERN = '(?:내용을?\\s*입력(?:하세요)?\\.?|사진\\s*설명을?\\s*입력(?:하세요)?\\.?|출처\\s*입력|AI\\s*활용\\s*설정)';
const GENERATED_EDITOR_PLACEHOLDER_RE = new RegExp(GENERATED_EDITOR_PLACEHOLDER_PATTERN, 'gi');
const GENERATED_EDITOR_PLACEHOLDER_TEST_RE = new RegExp(GENERATED_EDITOR_PLACEHOLDER_PATTERN, 'i');

function fixCommonKoreanParticleMistakes(line = '') {
  return String(line || '')
    .replace(/(반값여행|지원금|민생회복지원금|신청|정책|사업|일정|기간|홈페이지|기준|방법|절차|공고|환급)를/g, '$1을')
    .replace(/(반값여행|지원금|민생회복지원금|신청|정책|사업|일정|기간|홈페이지|기준|방법|절차|공고|환급)는/g, '$1은');
}

function cleanGeneratedArticleBody(text = '') {
  const seenParagraphs = new Set();
  const seenNearParagraphs = [];
  return String(text || '')
    .replace(/\[글별 CTA 링크 입력 필요\]/g, '')
    .replace(/\[네이버 QR 삽입(?: 위치)?:\s*\[글별 CTA 링크 입력 필요\]\]/g, '')
    .replace(GENERATED_EDITOR_PLACEHOLDER_RE, '')
    .replace(/\b사실근거\s*\(\s*factPack\s*\)/gi, '확인 자료')
    .replace(/\bfactPack\b/gi, '확인 자료')
    .replace(/^\s*(?:도입부\s*(?:첫|두\s*번째|세\s*번째)?\s*문단|대답|답변|요약\s*답변|세부\s*설명|설명|마무리\s*요약|행동\s*권장|체크리스트)\s*[:：]\s*/gmi, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/([가-힣A-Za-z0-9][^\n]{7,80})\1+/g, '$1')
    .split(/\n+/)
    .map((line) => fixCommonKoreanParticleMistakes(line.replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
    .filter((line) => !/^>\s*$/.test(line))
    .filter((line) => !GENERATED_EDITOR_PLACEHOLDER_TEST_RE.test(line))
    .filter((line) => !/(참고 글의 문장|검색 의도는|주제 범위는|새로 작성한 초안|글 구성과 분량)/.test(line))
    .filter((line) => {
      const key = line.replace(/\s+/g, '');
      if (key.length < 18) return true;
      if (seenParagraphs.has(key)) return false;
      const nearKey = key.slice(0, 60);
      if (nearKey.length >= 36 && seenNearParagraphs.some((prev) => prev.includes(nearKey) || nearKey.includes(prev))) return false;
      seenParagraphs.add(key);
      seenNearParagraphs.push(nearKey);
      return true;
    })
    .join('\n\n')
    .trim();
}

function cleanVisibleArticleLine(line = '') {
  return String(line || '')
    .replace(VISIBLE_EDITOR_PLACEHOLDER_RE, '')
    .replace(AUTHORING_LABEL_RE, '')
    .replace(/^\s*\d+[.)]\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphArray(value = []) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\n{1,}/);
  return source
    .flatMap((item) => {
      if (Array.isArray(item)) return item;
      if (item && typeof item === 'object') return [item.text || item.body || item.content || ''];
      return String(item || '').split(/\n{2,}/);
    })
    .map(cleanVisibleArticleLine)
    .filter(Boolean)
    .filter((line) => !VISIBLE_IMAGE_MARKER_LINE_RE.test(line))
    .filter((line) => !/^>\s*$/.test(line))
    .slice(0, 24);
}

function normalizeGeneratedArticleBlocks(parsed = {}, { title = '', keyword = '', topic = '', sectionTitles = [] } = {}) {
  const root = parsed.articleBlocks || parsed.article_blocks || parsed.blocks || parsed;
  const rawSections = Array.isArray(root.sections) ? root.sections
    : Array.isArray(root.sectionBlocks) ? root.sectionBlocks
      : Array.isArray(root.section_blocks) ? root.section_blocks
        : [];
  if (!rawSections.length) return null;
  const cleanTitle = cleanVisibleArticleLine(root.title || parsed.title || title);
  const intro = paragraphArray(root.intro || root.introParagraphs || root.intro_paragraphs || root.opening || parsed.intro || []);
  const conclusion = paragraphArray(root.conclusion || root.closing || root.outro || parsed.conclusion || []);
  const sections = rawSections.map((section, index) => {
    const heading = cleanVisibleArticleLine(
      section.heading || section.title || section.quote || section.subtitle || section.name || sectionTitles[index] || `${keyword} 확인 ${index + 1}`
    ).replace(/^>\s*/, '');
    const paragraphs = paragraphArray(
      section.paragraphs || section.body || section.content || section.detail || [section.answer, section.description].filter(Boolean)
    );
    return {
      heading,
      paragraphs,
      caption: cleanVisibleArticleLine(section.caption || section.imageCaption || section.image_caption || ''),
    };
  }).filter((section) => section.heading && section.paragraphs.length);
  if (!sections.length) return null;
  return { title: cleanTitle || title, intro, sections, conclusion, keyword, topic };
}

function imageMarker(index = 0, text = '') {
  const label = index === 0 ? '대표이미지' : `이미지 ${index}`;
  return `[${label} 500x500 중앙정렬: ${cleanVisibleArticleLine(text).slice(0, 70)}]`;
}

function countVisibleImageMarkers(body = '') {
  return String(body || '').split(/\r?\n/).filter((line) => ANY_IMAGE_MARKER_LINE_RE.test(line)).length;
}

function ensureImageMarkers(body = '', { title = '', sectionTitles = [], requiredImageCount = 0 } = {}) {
  const maxImages = Math.max(0, Number(requiredImageCount) || 0);
  let lines = limitImagePlaceholders(String(body || ''), maxImages).split(/\r?\n/);
  let count = lines.filter((line) => ANY_IMAGE_MARKER_LINE_RE.test(line)).length;
  if (maxImages <= 0 || count >= maxImages) return lines.join('\n').trim();
  const hasCover = lines.some((line) => /^\s*\[(?:대표\s*이미지|대표이미지)[^\]]*\]/i.test(line));
  if (!hasCover) {
    const insertAt = lines.findIndex((line, index) => index > 0 && cleanVisibleArticleLine(line));
    lines.splice(insertAt > 0 ? insertAt : 1, 0, '', imageMarker(0, title), '');
    count += 1;
  }
  let imageIndex = Math.max(1, count);
  const headingIndexes = lines.map((line, index) => (/^>\s*\S/.test(line) ? index : -1)).filter((index) => index >= 0);
  for (let i = 0; count < maxImages && i < headingIndexes.length; i += 1) {
    const lineIndex = headingIndexes[i] + 1;
    const nextLines = lines.slice(lineIndex, lineIndex + 3);
    if (nextLines.some((line) => ANY_IMAGE_MARKER_LINE_RE.test(line))) continue;
    const section = sectionTitles[i] || lines[headingIndexes[i]].replace(/^>\s*/, '');
    lines.splice(lineIndex, 0, '', imageMarker(imageIndex, section), '');
    imageIndex += 1;
    count += 1;
  }
  while (count < maxImages) {
    lines.push('', imageMarker(imageIndex, sectionTitles[imageIndex - 1] || title));
    imageIndex += 1;
    count += 1;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildArticleBodyFromBlocks(blocks, { title = '', keyword = '', platform = 'blog', ctaUrl = '', useNaverQr = false, useAiImages = true, requiredImageCount = 0, sectionCount = 7 } = {}) {
  const finalTitle = cleanVisibleArticleLine(blocks?.title || title);
  const sections = (blocks?.sections || []).slice(0, Math.max(1, sectionCount));
  const bodyParts = [finalTitle, ''];
  if (useAiImages && requiredImageCount > 0) bodyParts.push(imageMarker(0, finalTitle), '');
  const intro = blocks?.intro?.length ? blocks.intro : paragraphArray([
    `${keyword} 정보를 찾을 때는 대상, 기간, 신청 경로를 먼저 나눠 보는 것이 좋습니다.`,
    `아래에서는 확인 순서와 주의할 부분을 실제로 점검하기 쉬운 흐름으로 정리했습니다.`,
  ]);
  bodyParts.push(...intro, '');
  if (ctaUrl) {
    bodyParts.push(`지금 바로 아래에서 ${keyword} 관련 내용을 확인하세요.`, ctaUrl);
    if (useNaverQr) bodyParts.push(`[네이버 QR 삽입: ${ctaUrl}]`);
    bodyParts.push('');
  }
  if (platform === 'blog') bodyParts.push(`[네이버 동영상 업로드 위치: ${keyword} 핵심 요약 15초 영상]`, '');
  const sectionImageLimit = Math.max(0, requiredImageCount - 1);
  sections.forEach((section, index) => {
    bodyParts.push(`> ${section.heading}`, '');
    if (useAiImages && index < sectionImageLimit) bodyParts.push(imageMarker(index + 1, section.heading), '');
    bodyParts.push(...paragraphArray(section.paragraphs), '');
  });
  const conclusion = blocks?.conclusion?.length ? blocks.conclusion : paragraphArray([
    `${keyword}는 최신 기준과 실제 접수처를 함께 확인해야 혼선을 줄일 수 있습니다.`,
    `마지막으로 신청 전에는 공고명, 기간, 대상 조건, 제출 자료를 한 번 더 대조해 보시기 바랍니다.`,
  ]);
  bodyParts.push(...conclusion);
  return bodyParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function qualityExpansionParagraph({ keyword = '', topic = '', index = 0, includeKeyword = true } = {}) {
  const key = includeKeyword ? normalizeKeywordValue(keyword) : '해당 정보';
  const subject = normalizeKeywordValue(topic) || normalizeKeywordValue(keyword) || '관련 내용';
  const variants = [
    `${key}를 확인할 때는 제목에 보이는 문구만 보지 말고 실제 공고명, 기준일, 접수처가 서로 맞는지 함께 보는 편이 안전합니다. 비슷한 안내가 여러 곳에 올라와도 최종 판단은 공식 화면에서 현재 열려 있는 메뉴와 공지 날짜를 대조한 뒤 진행하는 것이 좋습니다.`,
    `${key} 관련 절차를 진행하기 전에는 대상 조건과 예외 조건을 따로 적어두면 중간에 다시 확인하는 시간을 줄일 수 있습니다. 특히 온라인 접수와 방문 접수 중 어떤 방식이 가능한지, 본인 인증이나 추가 자료가 필요한지까지 확인해야 실제 신청 흐름이 끊기지 않습니다.`,
    `${subject} 일정은 시작일보다 마감일을 놓치는 경우가 더 많습니다. 그래서 신청 가능 기간, 결과 확인 시점, 실제 처리 예정일을 한 번에 묶어두고 변경 공지가 있는지 살펴보면 검색자가 바로 행동으로 옮기기 쉽습니다.`,
    `${key} 대상 여부가 애매하다면 한 가지 기준만 보지 말고 거주 기준일, 연령, 기존 지원 수령 여부, 중복 제한 항목까지 함께 확인해야 합니다. 이 부분을 분리해서 설명하면 단순한 안내보다 실제로 도움이 되는 정보형 글에 가까워집니다.`,
    `${subject}를 살펴볼 때는 문의처도 함께 저장해 두는 것이 좋습니다. 접수 화면에서 요구하는 항목이 예상과 다르거나 자료 보완 요청이 나올 수 있으므로, 확인 가능한 공식 연락처와 접수 번호를 남겨두면 이후 절차가 훨씬 수월합니다.`,
    `${key}는 지역이나 운영 주체에 따라 세부 표현이 달라질 수 있습니다. 따라서 같은 주제의 안내라도 금액, 기간, 신청 경로처럼 바뀔 수 있는 값은 최신 공지를 기준으로 다시 확인하고, 변동 가능성이 낮은 준비 순서만 먼저 챙기는 방식이 안정적입니다.`,
  ];
  return variants[Math.abs(index) % variants.length];
}

function insertParagraphsAcrossSections(body = '', paragraphs = []) {
  if (!paragraphs.length) return body;
  let lines = String(body || '').split(/\r?\n/);
  const headingIndexes = lines.map((line, index) => (/^>\s*\S/.test(line) ? index : -1)).filter((index) => index >= 0);
  if (!headingIndexes.length) return `${body.trim()}\n\n${paragraphs.join('\n\n')}`.trim();
  paragraphs.forEach((paragraph, index) => {
    const refreshedHeadings = lines.map((line, lineIndex) => (/^>\s*\S/.test(line) ? lineIndex : -1)).filter((lineIndex) => lineIndex >= 0);
    const targetHeading = refreshedHeadings[index % refreshedHeadings.length];
    const nextHeading = refreshedHeadings.find((lineIndex) => lineIndex > targetHeading) || lines.length;
    lines.splice(nextHeading, 0, '', paragraph, '');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function enforceRewriteQualityLocally({ title = '', body = '', keyword = '', topic = '', sectionTitles = [], settings = {}, requiredImageCount = 0 } = {}) {
  const targetRange = metricTargetRange(settings);
  let finalBody = cleanGeneratedArticleBody(body);
  finalBody = ensureImageMarkers(finalBody, { title, sectionTitles, requiredImageCount });
  finalBody = limitExactKeywordRepetition(finalBody, keyword, targetRange.maxKwCount, topic);
  let metrics = articleMetrics(finalBody, keyword);
  let addedParagraphCount = 0;
  let guard = 0;
  while ((metrics.charCount < targetRange.minCharCount || metrics.kwCount < targetRange.minKwCount) && guard < 8) {
    const includeKeyword = metrics.kwCount < targetRange.minKwCount;
    const paragraph = qualityExpansionParagraph({ keyword, topic, index: guard, includeKeyword });
    finalBody = insertParagraphsAcrossSections(finalBody, [paragraph]);
    finalBody = ensureImageMarkers(finalBody, { title, sectionTitles, requiredImageCount });
    finalBody = limitExactKeywordRepetition(finalBody, keyword, targetRange.maxKwCount, topic);
    metrics = articleMetrics(finalBody, keyword);
    addedParagraphCount += 1;
    if (metrics.charCount > targetRange.maxCharCount + 180 && metrics.kwCount >= targetRange.minKwCount) break;
    guard += 1;
  }
  finalBody = cleanGeneratedArticleBody(finalBody);
  finalBody = ensureImageMarkers(finalBody, { title, sectionTitles, requiredImageCount });
  finalBody = limitExactKeywordRepetition(finalBody, keyword, targetRange.maxKwCount, topic);
  metrics = articleMetrics(finalBody, keyword);
  return { body: finalBody, metrics, addedParagraphCount, imageMarkerCount: countVisibleImageMarkers(finalBody) };
}

function naturalDraftSubject(keyword = '', topic = '') {
  return normalizeKeywordValue(topic) || normalizeKeywordValue(keyword) || '해당 주제';
}

function naturalTitleSubject(keyword = '', topic = '') {
  return naturalDraftSubject(keyword, topic).replace(/\s*신청$/g, '').trim() || naturalDraftSubject(keyword, topic);
}

function naturalPolicyIntent(keyword = '', topic = '') {
  return /(민생|지원금|쿠폰|환급|신청|반값|여행|대상|지급|정책|바우처|고유가|보조금|급여|수당|홈페이지|기간|일정)/.test(`${keyword} ${topic}`);
}

function naturalPolicyKind(keyword = '', topic = '') {
  const source = `${keyword} ${topic}`;
  if (/여행|반값|숙박|관광|체험/.test(source)) return 'travel';
  if (/민생|지원금|쿠폰|바우처|보조금|급여|수당|지급|소비/.test(source)) return 'support';
  return 'policy';
}

function koreanParticle(value = '', consonantParticle = '은', vowelParticle = '는') {
  const last = String(value || '').trim().match(/[가-힣]$/)?.[0];
  if (!last) return vowelParticle;
  return ((last.charCodeAt(0) - 0xac00) % 28) > 0 ? consonantParticle : vowelParticle;
}

function objectParticle(value = '') {
  return koreanParticle(value, '을', '를');
}

function naturalDraftTitle(keyword = '', topic = '', platform = 'blog') {
  const subject = naturalDraftSubject(keyword, topic);
  if (naturalPolicyIntent(keyword, topic)) {
    if (/여행|반값/.test(subject)) return `${subject} 신청 방법 및 일정 안내와 공식 홈페이지 정보`;
    if (/지원금|쿠폰|바우처|급여|수당|보조금/.test(subject)) return `${subject} 신청 방법 대상 기준 지급일 정리`;
    return `${subject} 신청 방법과 기준 일정 확인`;
  }
  if (/테스트|검사|유형|결과|링크/.test(subject)) return `${subject} 링크 결과 유형 확인 방법 정리`;
  if (platform === 'cafe') return `${subject} 방법 기준 확인 정리`;
  return `${subject} 핵심 정보와 확인 방법 정리`;
}

function naturalSectionTitles(keyword = '', topic = '', count = 6, variantIndex = 0) {
  const subject = naturalTitleSubject(keyword, topic);
  const policy = naturalPolicyIntent(keyword, topic);
  const policySets = [
    [
      `${subject} 먼저 확인할 기준`,
      `${subject} 신청 대상과 조건`,
      `${subject} 공식 홈페이지 신청 방법`,
      `${subject} 일정과 기간 확인`,
      `${subject} 환급 방식과 서류 준비`,
      `${subject} 신청 전 주의사항`,
      `${subject} 핵심 요약`,
      `${subject} 자주 묻는 질문`,
    ],
    [
      `${subject} 전체 흐름 정리`,
      `${subject} 대상자 확인 방법`,
      `${subject} 온라인 신청 순서`,
      `${subject} 결과 확인과 지급 절차`,
      `${subject} 준비 서류 체크`,
      `${subject} 놓치기 쉬운 부분`,
      `${subject} 마무리 정리`,
      `${subject} 확인 포인트`,
    ],
  ];
  const generalSets = [
    [
      `${subject} 먼저 알아둘 점`,
      `${subject} 핵심 기준`,
      `${subject} 확인 방법`,
      `${subject} 주의사항`,
      `${subject} 활용 팁`,
      `${subject} 자주 묻는 질문`,
      `${subject} 최종 정리`,
    ],
    [
      `${subject} 기본 개념`,
      `${subject} 진행 순서`,
      `${subject} 결과 확인`,
      `${subject} 비교 포인트`,
      `${subject} 체크리스트`,
      `${subject} 마무리`,
    ],
  ];
  const sets = policy ? policySets : generalSets;
  return sets[Math.abs(variantIndex) % sets.length].slice(0, Math.max(1, count));
}

function naturalIntroParagraphsV2({ keyword = '', topic = '', subject = '', isPolicy = false } = {}) {
  if (isPolicy) {
    return [
      `${subject} 정보를 찾다 보면 신청 기간, 대상 기준, 공식 홈페이지 안내가 서로 섞여 있어 정작 내가 무엇부터 확인해야 하는지 헷갈릴 때가 많습니다.`,
      `특히 지원이나 환급이 걸린 내용은 지역 공고와 접수처 안내가 조금만 달라도 실제 신청 가능 여부가 달라질 수 있어 처음부터 기준을 나눠 보는 편이 안전합니다.`,
      `이번 글에서는 ${keyword} 관련해서 먼저 봐야 할 조건, 신청 순서, 일정 확인 방법, 준비 서류와 주의사항을 실제로 확인하기 쉬운 흐름으로 정리해 보겠습니다.`,
    ];
  }
  return [
    `${subject}${objectParticle(subject)} 검색하면 설명은 많지만 처음 보는 사람 입장에서는 어떤 정보가 핵심인지 바로 구분하기 어렵습니다.`,
    `그래서 이번 글은 단순 소개보다 실제로 확인해야 할 기준과 진행 순서를 앞쪽에 두고, 뒤로 갈수록 주의할 부분을 정리하는 방식으로 구성했습니다.`,
    `${keyword}${objectParticle(keyword)} 빠르게 이해하고 싶은 분이라면 아래 흐름대로 읽어보시면 필요한 부분만 골라 확인하기가 훨씬 수월합니다.`,
  ];
}

function sectionIntent(section = '') {
  if (/먼저|전체 흐름|기본 개념/.test(section)) return 'overview';
  if (/대상|조건|기준/.test(section)) return 'eligibility';
  if (/주의|놓치기|체크/.test(section)) return 'caution';
  if (/홈페이지|신청|온라인|방법|순서/.test(section)) return 'apply';
  if (/일정|기간|지급|결과/.test(section)) return 'schedule';
  if (/환급|서류|준비|영수증/.test(section)) return 'documents';
  if (/요약|정리|마무리|질문/.test(section)) return 'summary';
  return 'overview';
}

function naturalSectionExtraParagraphV2({ keyword = '', section = '', intent = 'overview', isPolicy = false } = {}) {
  if (isPolicy) {
    const policyExtra = {
      overview: `이 단계에서 ${keyword}의 운영 주체와 공고 기준일을 잡아두면 뒤에서 대상이나 일정이 달라 보일 때도 어느 안내를 우선으로 봐야 하는지 판단하기 쉽습니다.`,
      eligibility: `대상 여부가 애매하다면 단순히 키워드만 검색하기보다 공고문 안의 제외 조건까지 같이 보는 것이 좋습니다. 작은 조건 하나 때문에 신청 후 반려되는 경우도 있기 때문입니다.`,
      apply: `모바일과 PC 화면의 메뉴명이 다를 수 있으니 신청 전에는 접수 화면에서 저장이나 제출 버튼이 어디에 있는지도 확인해 두면 진행 중 실수를 줄일 수 있습니다.`,
      schedule: `달력에 신청 마감일과 결과 확인일을 따로 표시해 두면 좋습니다. 접수 기간 안에는 여유가 있어 보여도 서류 보완 요청이 들어오면 시간이 빠르게 지나갈 수 있습니다.`,
      documents: `증빙 자료는 사진으로 남겨두더라도 글자가 흐리면 다시 제출해야 할 수 있습니다. 파일명도 날짜와 사용처가 보이게 정리해 두면 나중에 확인하기 편합니다.`,
      caution: `마지막으로 안내 문구가 조금이라도 달라 보이면 이전 캡처가 아니라 현재 열려 있는 공식 페이지 기준으로 다시 확인해야 합니다. 정책성 글은 최신성이 특히 중요합니다.`,
      summary: `결국 ${keyword}는 혜택 자체보다 내 조건이 맞는지, 기간 안에 신청할 수 있는지, 제출 자료가 인정되는지를 차례대로 확인하는 것이 핵심입니다.`,
    };
    return policyExtra[intent] || policyExtra.overview;
  }
  const generalExtra = {
    overview: `${keyword}처럼 검색량이 몰리는 주제는 비슷한 설명이 반복되기 쉬워서, 처음부터 기준과 확인 순서를 분리해 두는 편이 읽는 사람에게 더 도움이 됩니다.`,
    apply: `진행 과정에서는 화면 안내를 그대로 따라가되, 중간에 저장이 되는지와 결과 확인이 가능한지를 함께 봐야 나중에 다시 찾을 때 불편함이 줄어듭니다.`,
    caution: `특히 오래된 글과 최신 글이 함께 노출되는 주제라면 날짜와 기준이 맞는지를 확인하는 것만으로도 잘못된 정보를 피할 수 있습니다.`,
    summary: `마무리에서는 처음 봤던 핵심 기준을 다시 떠올리며 내가 바로 확인해야 할 항목만 남기는 방식이 가장 깔끔합니다.`,
  };
  return generalExtra[intent] || generalExtra.overview;
}

function naturalSectionFollowupParagraphV2({ keyword = '', intent = 'overview', isPolicy = false } = {}) {
  if (isPolicy) {
    const followup = {
      overview: `그래서 ${keyword}${objectParticle(keyword)} 볼 때는 혜택 설명보다 먼저 공고의 적용 범위와 신청 가능 시점을 확인하는 편이 좋습니다. 이 순서만 잡아도 불필요한 검색을 꽤 줄일 수 있습니다.`,
      eligibility: `가족 단위나 동행 신청처럼 함께 움직이는 경우에는 대표 신청자 기준만 보는 것으로 부족할 수 있습니다. 각 참여자의 조건이 어떻게 적용되는지도 같이 확인해야 합니다.`,
      apply: `접수 완료 후에는 접수번호나 신청 내역 화면을 캡처해 두는 것도 도움이 됩니다. 나중에 결과를 조회하거나 서류를 보완할 때 기준 자료로 쓰기 쉽습니다.`,
      schedule: `여행이나 사용 기간이 정해진 사업이라면 실제 이용일과 신청 가능 기간이 서로 맞는지도 따로 봐야 합니다. 날짜가 어긋나면 혜택 대상에서 벗어날 수 있습니다.`,
      documents: `가능하다면 영수증은 원본과 사진 파일을 함께 보관해 두는 편이 안전합니다. 제출 방식이 바뀌거나 보완 요청이 생겨도 바로 대응할 수 있기 때문입니다.`,
      caution: `또한 누군가 정리해 둔 글이 편하더라도 마지막 클릭은 공식 페이지에서 하는 것이 좋습니다. 링크가 바뀌거나 접수 메뉴가 이동하는 경우가 있기 때문입니다.`,
      summary: `마지막으로 ${keyword}는 한 번 확인하고 끝내기보다 신청 전, 접수 후, 결과 확인 전으로 나눠 다시 보는 흐름이 가장 안정적입니다.`,
    };
    return followup[intent] || followup.overview;
  }
  const followup = {
    overview: `${keyword}${objectParticle(keyword)} 처음 보는 독자는 용어보다 실제로 무엇을 해야 하는지에 더 관심이 많습니다. 그래서 설명은 짧게, 확인 순서는 분명하게 잡는 편이 좋습니다.`,
    apply: `중간 단계에서 막힌다면 처음부터 다시 시작하기보다 현재 화면에서 어떤 값이 비어 있는지 확인하는 것이 먼저입니다. 작은 입력 누락이 원인인 경우가 많습니다.`,
    caution: `검색 결과가 비슷해 보여도 작성일과 기준일이 다르면 내용이 달라질 수 있습니다. 최신 기준을 확인하는 습관이 가장 확실한 안전장치입니다.`,
    summary: `${keyword} 관련 글은 마지막에 핵심만 다시 묶어주면 독자가 저장하거나 공유하기 좋습니다. 이 부분이 AEO형 답변에도 잘 맞습니다.`,
  };
  return followup[intent] || followup.overview;
}

function naturalSectionParagraphsV2({ keyword = '', subject = '', section = '', index = 0, isPolicy = false } = {}) {
  const intent = sectionIntent(section);
  if (isPolicy) {
    const policyKind = naturalPolicyKind(keyword, subject);
    const eligibilitySecond = policyKind === 'travel'
      ? `대상 기준은 공고문에서 가장 자주 바뀌는 부분이기 때문에, 블로그 글만 보고 판단하기보다 주소지와 여행 가능 기간 같은 세부 조건까지 한 번 더 대조해 보는 과정이 필요합니다.`
      : `대상 기준은 공고문에서 가장 자주 바뀌는 부분이기 때문에, 블로그 글만 보고 판단하기보다 소득 구간, 거주 지역, 연령, 기존 수급 여부를 한 번 더 대조해 보는 과정이 필요합니다.`;
    const documentSecond = policyKind === 'travel'
      ? `특히 환급형 사업은 사용처와 결제 내역이 기준에 맞아야 합니다. 숙박, 식사, 체험 비용이 모두 인정되는지 또는 일부 항목만 가능한지 공고문 기준으로 나눠 보는 것이 좋습니다.`
      : `특히 지원금성 사업은 본인 확인, 세대 기준, 카드나 지역화폐 수령 방식처럼 지급 방식과 연결된 자료가 중요합니다. 신청 전 어떤 증빙이 필요한지 먼저 확인하는 편이 좋습니다.`;
    const policyMap = {
      overview: [
        `${section}에서는 먼저 이 제도가 어떤 목적의 안내인지부터 보는 것이 좋습니다. ${keyword}처럼 지원 성격이 있는 정보는 이름은 비슷해도 운영 주체가 다르면 접수처와 기준이 달라질 수 있습니다.`,
        `따라서 글을 읽을 때는 금액이나 혜택만 보지 말고, 신청 가능한 지역인지, 대상 조건이 맞는지, 실제 접수 페이지가 열려 있는지를 함께 확인해야 합니다.`,
      ],
      eligibility: [
        `${section}을 볼 때는 거주지, 연령, 기존 지원 여부처럼 기본 조건부터 확인하는 편이 안전합니다. 같은 ${keyword} 안내라도 지역과 세대 기준에 따라 대상에서 제외될 수 있습니다.`,
        eligibilitySecond,
      ],
      apply: [
        `${section}은 실제 행동으로 이어지는 부분이라 접속 경로를 정확히 잡는 것이 중요합니다. 검색 결과에 비슷한 안내 페이지가 많다면 공식 홈페이지 안의 신청 메뉴인지 먼저 확인해야 합니다.`,
        `신청 화면에서는 기본 정보 입력, 일정 선택, 증빙 자료 제출처럼 단계가 나뉘는 경우가 많습니다. 중간에 창을 닫으면 다시 입력해야 할 수 있으니 필요한 정보는 미리 준비해 두는 편이 좋습니다.`,
      ],
      schedule: [
        `${section}은 시작일보다 마감일을 더 신경 써야 합니다. 예산이 정해진 사업은 접수 상황에 따라 조기 종료되거나 회차별로 일정이 나뉘는 경우가 있습니다.`,
        `결과 확인일이나 지급 예정일도 한 번에 고정되지 않을 수 있습니다. 접수 후 안내 문자가 오는지, 홈페이지에서 상태 조회가 가능한지까지 확인해 두면 불필요한 재문의가 줄어듭니다.`,
      ],
      documents: [
        `${section}에서는 제출 가능한 자료의 형식을 확인해야 합니다. 영수증, 예약 내역, 본인 확인 자료처럼 필요한 항목이 빠지면 심사가 늦어질 수 있습니다.`,
        documentSecond,
      ],
      caution: [
        `${section}에서 가장 중요한 것은 중복 신청과 허위 자료 제출을 피하는 것입니다. 혜택을 빨리 받으려다 잘못된 자료를 넣으면 지급이 지연되거나 제외될 수 있습니다.`,
        `또한 비공식 링크나 캡처된 안내만 믿고 들어가는 것도 조심해야 합니다. 최종 접수는 반드시 공식 페이지에서 진행하고, 변경 공지가 있는지 마지막에 다시 확인하는 흐름이 안전합니다.`,
      ],
      summary: [
        `${section}만 다시 보면 ${keyword}는 대상 확인, 신청 기간 확인, 공식 홈페이지 접수, 증빙 제출 순서로 정리할 수 있습니다.`,
        `처음에는 복잡해 보여도 필요한 자료를 미리 챙기고 일정만 놓치지 않으면 확인 과정은 크게 어렵지 않습니다. 다만 지역별 세부 기준은 다를 수 있으니 최종 기준은 공식 공고를 우선으로 두는 것이 좋습니다.`,
      ],
    };
    return [
      ...(policyMap[intent] || policyMap.overview),
      naturalSectionExtraParagraphV2({ keyword, section, intent, isPolicy }),
      ...(index < 3 ? [naturalSectionFollowupParagraphV2({ keyword, intent, isPolicy })] : []),
    ];
  }
  const generalMap = {
    overview: [
      `${section}에서는 ${keyword}${objectParticle(keyword)} 처음 접하는 분들이 가장 먼저 확인해야 할 배경을 정리했습니다. 용어만 보면 어렵게 느껴질 수 있지만 핵심은 기준과 순서를 나눠 보는 것입니다.`,
      `${subject} 관련 정보는 한 번에 결론을 내리기보다 필요한 항목을 차례대로 확인할 때 훨씬 이해가 쉽습니다.`,
    ],
    apply: [
      `${section}은 실제로 따라 하는 과정에 가깝습니다. 링크나 메뉴 이름만 보고 넘어가기보다 접속 경로와 화면에서 확인해야 할 항목을 같이 봐야 합니다.`,
      `처음 진행한다면 한 번에 끝내려고 하기보다 필요한 정보가 무엇인지 먼저 체크하고 시작하는 편이 오류를 줄이는 데 도움이 됩니다.`,
    ],
    caution: [
      `${section}에서는 흔히 헷갈리는 부분을 따로 짚어보겠습니다. 비슷한 이름의 페이지나 안내가 있을 때는 주소와 기준일을 반드시 확인해야 합니다.`,
      `또한 캡처 화면만 보고 판단하면 최신 기준을 놓칠 수 있으니, 마지막 단계에서는 공식 안내나 원문 기준을 함께 보는 것이 좋습니다.`,
    ],
    summary: [
      `${section}에서는 앞에서 본 내용을 간단히 다시 묶었습니다. ${keyword}는 핵심 기준, 진행 순서, 주의사항만 분리해도 훨씬 읽기 쉬워집니다.`,
      `필요한 부분만 빠르게 확인하고 싶다면 대상이나 조건을 먼저 보고, 그다음 방법과 주의사항으로 넘어가는 순서를 추천합니다.`,
    ],
  };
  return [
    ...(generalMap[intent] || generalMap.overview),
    naturalSectionExtraParagraphV2({ keyword, section, intent, isPolicy }),
    ...(index < 3 ? [naturalSectionFollowupParagraphV2({ keyword, intent, isPolicy })] : []),
  ];
}

function buildRewriteDraftV2({ keyword, topic, platform, ctaUrl, useNaverQr, useAiImages = true, pattern, customTitle = '', variantIndex = 0 }) {
  const subject = naturalDraftSubject(keyword, topic);
  const title = normalizeTitleValue(customTitle) || naturalDraftTitle(keyword, topic, platform);
  const sectionCount = Math.max(1, (pattern.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount) - 1);
  const sectionTitles = naturalSectionTitles(keyword, topic, sectionCount, variantIndex);
  const isPolicy = naturalPolicyIntent(keyword, topic);
  const publishSpec = buildPublishSpec(platform, pattern.settings || pattern, { hasCtaUrl: Boolean(ctaUrl), useNaverQr });
  const requiredImageCount = plannedArticleImageCount(pattern.settings || pattern, pattern.sectionCount || sectionTitles.length);
  const sectionImageLimit = Math.max(0, requiredImageCount - 1);
  const bodyParts = [title, ''];
  if (useAiImages) {
    bodyParts.push(`[대표이미지 500x500 중앙정렬: ${title}]`, '');
  }
  bodyParts.push(...naturalIntroParagraphsV2({ keyword, topic, subject, isPolicy }), '');
  if (ctaUrl) {
    bodyParts.push(`지금 바로 아래에서 ${keyword} 관련 정보를 확인하세요.`, ctaUrl);
    bodyParts.push(useNaverQr ? `[네이버 QR 삽입: ${ctaUrl}]` : `[링크 삽입: ${ctaUrl}]`, '');
  }
  if (platform === 'blog') {
    bodyParts.push(`[네이버 동영상 업로드 위치: ${keyword} 핵심 요약 15초 영상]`, '');
  }
  sectionTitles.forEach((section, index) => {
    bodyParts.push(`> ${section}`, '');
    if (useAiImages && index < sectionImageLimit) bodyParts.push(`[이미지 ${index + 1} 500x500 중앙정렬: ${section}]`, '');
    bodyParts.push(...naturalSectionParagraphsV2({ keyword, subject, section, index, isPolicy }), '');
  });
  bodyParts.push('> 마무리', '');
  bodyParts.push(
    isPolicy
      ? `${keyword}${koreanParticle(keyword, '은', '는')} 대상 기준과 신청 기간을 함께 봐야 정확하게 판단할 수 있습니다. 특히 공식 홈페이지의 접수 상태와 변경 공지를 마지막에 확인하는 과정이 가장 중요합니다.`
      : `${keyword}${koreanParticle(keyword, '은', '는')} 핵심 기준과 확인 순서를 분리해 읽으면 훨씬 이해하기 쉽습니다. 필요한 부분만 빠르게 보고 싶다면 방법, 주의사항, 최종 정리 순서로 확인해 보시면 됩니다.`,
    isPolicy
      ? `신청 전에 대상 여부를 먼저 확인하고, 접수 후에는 결과 확인이나 환급 절차까지 이어서 챙겨두면 놓치는 부분을 줄일 수 있습니다.`
      : `비슷한 정보가 많을수록 제목이나 첫 문단만 보고 판단하기보다 실제 기준과 확인 경로를 같이 보는 습관이 도움이 됩니다.`
  );

  const range = metricTargetRange(pattern);
  let body = cleanGeneratedArticleBody(bodyParts.join('\n'));
  body = limitImagePlaceholders(body, requiredImageCount);
  body = limitExactKeywordRepetition(body, keyword, range.maxKwCount, topic);
  let metrics = articleMetrics(body, keyword);
  const extraNotes = [
    `${keyword}은 공고명, 기준일, 접수처가 서로 맞는지 함께 보는 것이 좋습니다.`,
    `${keyword} 관련 안내가 여러 곳에 올라와도 최종 기준은 공식 페이지의 최신 공지에 두는 편이 안전합니다.`,
    `${keyword} 진행 전에는 필요한 자료를 미리 챙겨두면 중간에 다시 돌아가는 일을 줄일 수 있습니다.`,
    `특히 접수 화면에서 요구하는 항목이 글마다 다르게 보인다면 최신 공고문 기준으로 다시 정리하는 것이 좋습니다.`,
    `신청 후에는 완료 화면이나 접수 번호를 따로 저장해 두면 결과 조회나 문의가 필요할 때 훨씬 수월합니다.`,
    `마지막으로 일정이 변경될 수 있는 주제는 글을 읽은 날짜와 실제 공고 기준일을 함께 보는 습관이 필요합니다.`,
    `여기에 문의처나 담당 부서가 따로 안내되어 있다면 접수 전 한 번 확인해 두는 것이 좋습니다. 작은 기준 차이도 실제 처리 결과에는 영향을 줄 수 있습니다.`,
  ];
  let noteIndex = 0;
  while ((metrics.charCount < range.minCharCount || metrics.kwCount < range.minKwCount) && noteIndex < extraNotes.length) {
    body = cleanGeneratedArticleBody(`${body}\n\n${extraNotes[noteIndex]}`);
    body = limitImagePlaceholders(body, requiredImageCount);
    body = limitExactKeywordRepetition(body, keyword, range.maxKwCount, topic);
    metrics = articleMetrics(body, keyword);
    noteIndex += 1;
  }
  const images = useAiImages
    ? Array.from({ length: Math.max(0, requiredImageCount) }, (_, index) => {
        const section = index === 0 ? title : sectionTitles[(index - 1) % Math.max(sectionTitles.length, 1)] || title;
        return {
          index,
          role: index === 0 ? 'cover' : 'section',
          label: index === 0 ? '대표 이미지' : `이미지 ${index}`,
          title: section,
          section,
          caption: imageCaptionLabel(keyword, section, index),
          prompt: `${keyword} ${section} 정보형 카드 이미지`,
          url: makeTemplateImage({
            keyword: imageKeywordLabel(keyword, topic, index),
            section,
            subtitle: index === 0 ? '핵심 정보 정리' : '확인 포인트',
            index,
            platform,
          }),
          width: 500,
          height: 500,
        };
      })
    : [];
  return {
    title,
    body,
    plainText: metrics.plainText,
    charCount: metrics.charCount,
    kwCount: metrics.kwCount,
    imageCount: images.length,
    quoteCount: (body.match(/^>\s*/gm) || []).length,
    images,
    publishSpec,
  };
}

function buildOpenAiRewritePrompt({ job, analyses = [], pattern = {}, settings = {}, variantIndex = 0, research = {} }) {
  return buildOpenAiRewritePromptV2({ job, analyses, pattern, settings, variantIndex, research });
  const keyword = job.target_keyword;
  const topic = job.target_topic || keyword;
  const sourceSummaries = analyses.slice(0, 4).map((row, index) => ({
    index: index + 1,
    title: row.title || '',
    mainKeyword: row.corrected_main_keyword || row.main_keyword || row.keyword || '',
    category: row.category_guess || row.category || '',
    charCount: row.char_count || row.charCount || 0,
    kwCount: row.kw_count || row.kwCount || 0,
    imageCount: row.image_count || row.imageCount || 0,
    quoteBlocks: parseJsonArray(row.quote_blocks).slice(0, 8),
    repeatedTerms: parseJsonArray(row.repeated_terms).slice(0, 10),
    textSample: String(row.plain_text || row.source_text_preview || '').slice(0, 1600),
  }));
  const imageCount = pattern.imageCount || settings.imageCount || DEFAULT_REWRITE_SETTINGS.imageCount;
  const sectionCount = pattern.sectionCount || settings.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount;
  const targetCharCount = pattern.targetCharCount || settings.targetCharCount || DEFAULT_REWRITE_SETTINGS.targetCharCount;
  const targetKwCount = pattern.targetKwCount || settings.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount;
  const range = metricTargetRange({ ...settings, targetCharCount, targetKwCount, sectionCount });
  const charBudget = rewriteCharBudgetPlan({ ...settings, targetCharCount, targetKwCount, sectionCount });
  const cta = job.cta_url || '[글별 CTA 링크 입력 필요]';
  const qrInstruction = job.use_naver_qr
    ? '도입 CTA 직후 또는 두 번째 섹션 뒤에 [네이버 QR 삽입: CTA 링크] 표기를 넣어라.'
    : 'CTA 링크는 도입부 직후와 마무리 직전에 자연스럽게 넣어라.';
  return {
    system: [
      '너는 한국어 네이버 블로그/카페 SEO 원고를 쓰는 전문 에디터다.',
      '제공된 원문을 복사하지 말고 주제와 검색 의도만 학습해 완전히 새 구성과 새 문장으로 작성한다.',
      '유사문서 위험을 낮추기 위해 원문 문장, 문단 순서, 소제목 표현을 그대로 쓰지 않는다.',
      '응답은 반드시 JSON object 하나로만 한다. 마크다운 코드블록을 쓰지 않는다.',
    ].join('\n'),
    user: JSON.stringify({
      task: 'NaviWrite article rewrite/generation',
      platform: job.platform || 'blog',
      category: job.category || 'general',
      keyword,
      topic,
      contentSkill: skillPayload,
      webResearch: {
        enabled: Boolean(research.enabled),
        provider: research.provider || 'none',
        queries: research.queries || [],
        autocompleteKeywords: research.autocompleteKeywords || [],
        searchTotals: research.totals || [],
        searchItems: (research.items || []).slice(0, 10),
        factPack: research.factPack || null,
        answerEngineSignals: research.answerEngineSignals || null,
        errors: research.errors || [],
      },
      verifiedArticleFlow: {
        purpose: 'Use factPack first. Search snippets are supporting context only.',
        preferredSections: [
          '대상 및 자격',
          '금액 또는 비용 기준',
          '신청 기간과 일정',
          '신청 방법과 접수 경로',
          '사용처 또는 환급/제한 조건',
          '준비 서류와 주의사항',
          '핵심 요약',
        ],
      },
      customTitle: job.custom_title || '',
      variantIndex,
      target: {
        charCount: targetCharCount,
        charCountUnit: '공백 제외 한국어 글자수',
        charCountMin: range.minCharCount,
        charCountMax: range.maxCharCount,
        sectionCount,
        sectionCharCount: settings.sectionCharCount || DEFAULT_REWRITE_SETTINGS.sectionCharCount,
        keywordRepeatCount: targetKwCount,
        keywordRepeatMin: range.minKwCount,
        keywordRepeatMax: range.maxKwCount,
        imageCount,
        charBudget,
        quoteHeadingPerSection: true,
        imageSize: '500x500 center aligned',
        similarityRisk: 'very_low',
      },
      structureRules: [
        'title은 SEO/AEO/GEO 기준으로 메인키워드와 검색 의도 보조어를 자연스럽게 포함한다.',
        'title은 네이버 검색형 제목으로 쓴다. 조사/연결어(및, 와, 과)는 가능하면 빼고 핵심 키워드를 검색량 높은 순서로 배열한다.',
        'title에는 랜딩페이지식 CTA를 쓰지 않는다. 금지: 홈페이지에서 쉽게 시작하세요, 지금 바로, 클릭하세요, 확인하세요, 알아보세요, 시작하세요, 놓치지 마세요.',
        '정책/여행/신청 글 제목은 명사형으로 쓴다. 예: 완도 반값여행 신청 방법 일정 안내 공식 홈페이지, 메인키워드 대상 기준 신청 기간.',
        '오타를 만들지 않는다. 특히 반값여행을 반갑여행으로 쓰지 않는다.',
        `본문 글자수는 공백 제외 ${range.minCharCount}~${range.maxCharCount}자 범위에 맞춘다. 목표는 ${targetCharCount}자다.`,
        `분량 배분은 도입부 약 ${charBudget.intro.target}자, 각 섹션 약 ${charBudget.sections[0]?.target || settings.sectionCharCount}자, 마무리 약 ${charBudget.conclusion.target}자를 기준으로 한다. 한 섹션만 길게 쓰지 말고 모든 섹션에 분량을 나눠라.`,
        `메인키워드 '${keyword}'는 본문 전체에 ${range.minKwCount}~${range.maxKwCount}회만 자연스럽게 넣는다.`,
        `소제목은 ${sectionCount}개 기준으로 만들고 각 본문 섹션은 약 ${settings.sectionCharCount || DEFAULT_REWRITE_SETTINGS.sectionCharCount}자 분량으로 쓴다.`,
        'body 첫 줄에는 title을 한 번 넣고, 이후 도입부 3문단을 쓴다.',
        `도입 CTA에는 ${cta}를 넣는다.`,
        qrInstruction,
        '네이버 블로그는 각 소제목을 > 인용구 형식으로 표시한다.',
        '각 소제목 뒤에는 이미지 자리 표시자를 [이미지 n 500x500 중앙정렬: 소제목] 형식으로 넣는다.',
        '본문은 검색자가 바로 확인해야 할 기준, 대상, 방법, 주의사항, 요약 순서로 읽히게 한다.',
        '마무리에서는 핵심을 다시 정리하되 과장된 보장 표현은 피한다.',
        `Hard metric gate: final body must be ${range.minCharCount}-${range.maxCharCount} Korean characters without spaces, exact keyword count ${range.minKwCount}-${range.maxKwCount}, image placeholders exactly ${imageCount}, and quote headings about ${sectionCount}. Revise before returning JSON if any metric is outside the range.`,
        'Before returning JSON, mentally audit the body length. If it is short, expand each section with a distinct factual paragraph; do not append generic repeated notes at the end.',
        'Use webResearch.searchItems and autocompleteKeywords as factual reference material. Do not copy titles or snippets; extract only the checking order, current issue terms, and official-confirmation points.',
        'Use webResearch.answerEngineSignals.relatedQuestions and relatedSearchTerms to shape headings and first sentences. Each section should satisfy one likely AI briefing or related-question intent without writing the label "질문".',
        'Use webResearch.factPack first when available: dates go into the period section, amounts into cost/benefit, eligibility into target, apply facts into application path, usage facts into usage/restriction, and cautions into documents or cautions.',
        'For imageCards, include caption: a short Korean caption under 55 characters that contains the main keyword or a natural variant plus the section intent.',
        'Do not write every section with the same generic frame. Each section must contain a different concrete fact type or a different user action.',
        'The phrase "official notice/page must be checked" may appear at most twice. Replace repeated warnings with concrete checking steps.',
        'If the web research has no exact confirmed fact, write a verification-oriented sentence instead of inventing dates, prices, agencies, or URLs.',
        'Prefer structured output. In addition to body, return articleBlocks with intro, sections, and conclusion so the server can rebuild the final Naver editor order.',
        'articleBlocks.sections must contain unique headings and 2-3 natural paragraphs each. Never put image placeholders, SmartEditor placeholder text, or caption placeholder text inside section paragraphs.',
        'Do not put the same sentence frame into multiple sections. If two sections sound similar, rewrite one around a different user action, fact type, or caution.',
        'Visible section headings must not start with numbers and must not repeat the exact main keyword mechanically in every heading.',
        ...skillPayload.promptRules,
      ],
      sourceBenchmarks: sourceSummaries,
      naturalDensityRules: {
        imagePolicy: `Use at most ${imageCount} image placeholders total: 1 cover image plus the first ${Math.max(0, imageCount - 1)} core section images only. Tail sections such as FAQ, tips, summary, and conclusion may have no image.`,
        exactKeywordPolicy: `Do not repeat the exact main keyword '${keyword}' in every paragraph or every section title. Use the exact phrase about ${range.minKwCount}-${range.maxKwCount} times total, then distribute natural variants and related terms.`,
        benchmarkInterpretation: 'Benchmark posts repeat important keywords, but the output must not look mechanically stuffed. Mix headings with action terms such as 대상, 신청 방법, 기간, 홈페이지, 서류, 주의사항, 확인.',
      },
      qualityGate: {
        seo: [
          `Title must combine 2-3 non-overlapping search phrases around '${keyword}', ordered from strongest intent to supporting intent.`,
          `The first 3 paragraphs must contain the main keyword naturally, but the same sentence frame must not repeat.`,
          `Use exact keyword ${range.minKwCount}-${range.maxKwCount} times total; after that use synonyms, topic nouns, and action terms.`,
        ],
        aeo: [
          'Each section should answer one concrete user question first, then explain details.',
          'Include practical answer blocks for target/eligibility, period/date, application path, documents, cautions, and final checklist when relevant.',
          'Avoid vague filler such as "there is a lot of information"; write the answer the reader can act on.',
        ],
        geo: [
          'Do not invent dates, amounts, agencies, or official URLs. If the source is uncertain, phrase it as a confirmation step.',
          'Mention official notice/page verification where facts may change.',
          'Separate confirmed facts, checking order, and user action so generative search can quote concise answers.',
        ],
        hardBans: [
          'No SmartEditor placeholder text: AI 활용 설정, 사진 설명을 입력하세요, 내용을 입력하세요, 출처 입력.',
          'No authoring labels in the visible article: 도입부 첫 문단, 도입부 두 번째 문단, 대답:, 답변:, 요약 답변:, 세부 설명:, 행동 권장:, 마무리 요약:, 체크리스트:.',
          'No empty quote markers and no duplicated heading text.',
          'No numbered section prefixes such as 1., 2., 3. in body paragraphs.',
        ],
      },
      requiredJsonShape: {
        title: 'string',
        body: 'string with title, intro, CTA, quote headings, image placeholders, conclusion',
        sectionTitles: ['string'],
        imageCards: [{ label: '대표 또는 섹션명', title: '이미지 제목', subtitle: '이미지 보조문구', caption: '키워드가 포함된 짧은 사진 설명' }],
      },
    }, null, 2),
  };
}

function buildOpenAiRewritePromptV2({ job, analyses = [], pattern = {}, settings = {}, variantIndex = 0, research = {} }) {
  const keyword = job.target_keyword;
  const topic = job.target_topic || keyword;
  const skill = contentSkillFor(settings.contentSkillKey || settings.content_skill_key || DEFAULT_REWRITE_SETTINGS.contentSkillKey);
  const skillPayload = promptSkillPayload(skill);
  const sectionCount = pattern.sectionCount || settings.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount;
  const imageCount = plannedArticleImageCount({ ...settings, ...pattern }, sectionCount);
  const targetCharCount = pattern.targetCharCount || settings.targetCharCount || DEFAULT_REWRITE_SETTINGS.targetCharCount;
  const targetKwCount = pattern.targetKwCount || settings.targetKwCount || DEFAULT_REWRITE_SETTINGS.targetKwCount;
  const range = metricTargetRange({ ...settings, targetCharCount, targetKwCount, sectionCount });
  const charBudget = rewriteCharBudgetPlan({ ...settings, targetCharCount, targetKwCount, sectionCount });
  const cta = job.cta_url || '';
  const sourceSummaries = analyses.slice(0, 4).map((row, index) => ({
    index: index + 1,
    title: row.title || '',
    mainKeyword: row.corrected_main_keyword || row.main_keyword || row.keyword || '',
    category: row.category_guess || row.category || '',
    charCount: row.char_count || row.charCount || 0,
    kwCount: row.kw_count || row.kwCount || 0,
    imageCount: row.image_count || row.imageCount || 0,
    quoteBlocks: parseJsonArray(row.quote_blocks).slice(0, 8),
    repeatedTerms: parseJsonArray(row.repeated_terms).slice(0, 10),
    textSample: String(row.plain_text || row.source_text_preview || '').slice(0, 1200),
  }));
  return {
    system: [
      '너는 한국어 네이버 블로그/카페용 글을 쓰는 전문 에디터다.',
      '벤치마킹 글의 주제와 검색 의도만 참고하고 문장, 문단 순서, 소제목 표현은 새로 만든다.',
      '글자수나 키워드 반복수를 맞추기 위해 같은 문장이나 같은 의미를 반복하지 않는다.',
      '응답은 반드시 JSON object 하나로만 작성한다.',
    ].join('\n'),
    user: JSON.stringify({
      task: 'NaviWrite publish draft',
      platform: job.platform || 'blog',
      category: job.category || 'general',
      keyword,
      topic,
      contentSkill: skillPayload,
      webResearch: {
        enabled: Boolean(research.enabled),
        provider: research.provider || 'none',
        queries: research.queries || [],
        autocompleteKeywords: research.autocompleteKeywords || [],
        searchTotals: research.totals || [],
        searchItems: (research.items || []).slice(0, 10),
        factPack: research.factPack || null,
        answerEngineSignals: research.answerEngineSignals || null,
        errors: research.errors || [],
      },
      verifiedArticleFlow: {
        purpose: 'Use factPack first. Search snippets are supporting context only.',
        preferredSections: [
          '대상 및 자격',
          '금액 또는 비용 기준',
          '신청 기간과 일정',
          '신청 방법과 접수 경로',
          '사용처 또는 환급/제한 조건',
          '준비 서류와 주의사항',
          '핵심 요약',
        ],
      },
      customTitle: job.custom_title || '',
      variantIndex,
      target: {
        charCount: targetCharCount,
        charCountMin: range.minCharCount,
        charCountMax: range.maxCharCount,
        sectionCount,
        sectionCharCount: settings.sectionCharCount || DEFAULT_REWRITE_SETTINGS.sectionCharCount,
        keywordRepeatCount: targetKwCount,
        keywordRepeatMin: range.minKwCount,
        keywordRepeatMax: range.maxKwCount,
        imageCount,
        charBudget,
      },
      rules: [
        '제목은 메인키워드를 앞쪽에 두고, 검색자가 같이 찾는 보조어 2~3개를 자연스럽게 조합한다.',
        '제목에 "홈페이지에서 쉽게 시작하세요", "클릭하세요", "지금 바로" 같은 과한 CTA 문구를 넣지 않는다.',
        '본문 첫 줄에는 제목을 한 번만 넣는다.',
        '도입부는 3문단으로 작성하고 독자가 왜 이 정보를 확인해야 하는지 자연스럽게 설명한다.',
        '도입부에 "참고 글의 문장을 가져온 것이 아니라", "검색 의도는", "주제 범위는" 같은 제작 설명 문장을 쓰지 않는다.',
        '네이버 블로그는 각 섹션 제목을 반드시 "> 소제목" 형태로 작성한다.',
        '본문 문단 앞에 "1.", "2.", "3." 같은 순번을 붙이지 않는다.',
        '빈 인용구를 만들지 않는다. ">" 뒤에는 반드시 실제 소제목 문장이 있어야 한다.',
        '각 소제목 바로 다음 줄에 "[이미지 n 500x500 중앙정렬: 소제목]" 형식의 이미지 자리 표시자를 넣는다.',
        '대표 이미지는 본문 초반에 "[대표이미지 500x500 중앙정렬: 제목]" 형식으로 넣는다.',
        cta
          ? `도입 CTA 이후 또는 2번째 섹션 뒤에 CTA 링크 "${cta}"를 넣고, QR 사용 시 "[네이버 QR 삽입: ${cta}]"를 함께 넣는다.`
          : 'CTA 링크가 비어 있으면 CTA 자리 표시자나 "[글별 CTA 링크 입력 필요]" 문장을 절대 쓰지 않는다.',
        '각 섹션은 역할이 달라야 한다. 대상/조건, 신청 방법, 일정/기간, 서류/환급, 주의사항, 요약처럼 겹치지 않게 나눈다.',
        '같은 문장, 같은 첫 문장, 같은 결론 문장을 반복하지 않는다.',
        '벤치마킹 글의 문장 12어절 이상을 그대로 가져오지 않는다.',
        '말투는 광고 문구보다 정보형 블로그에 가깝게 쓴다. 너무 딱딱한 공문체나 과한 감탄문은 피한다.',
        `Hard metric gate: final body must be ${range.minCharCount}-${range.maxCharCount} Korean characters without spaces, exact keyword count ${range.minKwCount}-${range.maxKwCount}, image placeholders exactly ${imageCount}, and quote headings about ${sectionCount}. Revise before returning JSON if any metric is outside the range.`,
        `Distribute length by budget: intro about ${charBudget.intro.target} chars, each section about ${charBudget.sections[0]?.target || settings.sectionCharCount} chars, conclusion about ${charBudget.conclusion.target} chars. Do not make one long block while other sections stay thin.`,
        'Before returning JSON, mentally audit the body length. If it is short, expand each section with a distinct factual paragraph; do not append generic repeated notes at the end.',
        'Use webResearch.searchItems and autocompleteKeywords as factual reference material. Do not copy titles or snippets; extract only the checking order, current issue terms, and official-confirmation points.',
        'Use webResearch.answerEngineSignals.relatedQuestions and relatedSearchTerms to shape headings and first sentences. Each section should satisfy one likely AI briefing or related-question intent without writing the label "질문".',
        'Use webResearch.factPack first when available: dates go into the period section, amounts into cost/benefit, eligibility into target, apply facts into application path, usage facts into usage/restriction, and cautions into documents or cautions.',
        'For imageCards, include caption: a short Korean caption under 55 characters that contains the main keyword or a natural variant plus the section intent.',
        'Do not write every section with the same generic frame. Each section must contain a different concrete fact type or a different user action.',
        'The phrase "official notice/page must be checked" may appear at most twice. Replace repeated warnings with concrete checking steps.',
        'If the web research has no exact confirmed fact, write a verification-oriented sentence instead of inventing dates, prices, agencies, or URLs.',
        ...skillPayload.promptRules,
      ],
      sourceBenchmarks: sourceSummaries,
      naturalDensityRules: {
        imagePolicy: `Use at most ${imageCount} image placeholders total: 1 cover image plus the first ${Math.max(0, imageCount - 1)} core section images only. Tail sections such as FAQ, tips, summary, and conclusion may have no image.`,
        exactKeywordPolicy: `Do not repeat the exact main keyword '${keyword}' in every paragraph or every section title. Use the exact phrase about ${range.minKwCount}-${range.maxKwCount} times total, then distribute natural variants and related terms.`,
        benchmarkInterpretation: 'Benchmark posts repeat important keywords, but the output must not look mechanically stuffed. Mix headings with action terms such as 대상, 신청 방법, 기간, 홈페이지, 서류, 주의사항, 확인.',
      },
      qualityGate: {
        seo: [
          `Title must combine 2-3 non-overlapping search phrases around '${keyword}', ordered from strongest intent to supporting intent.`,
          `The first 3 paragraphs must contain the main keyword naturally, but the same sentence frame must not repeat.`,
          `Use exact keyword ${range.minKwCount}-${range.maxKwCount} times total; after that use synonyms, topic nouns, and action terms.`,
        ],
        aeo: [
          'Each section should answer one concrete user question first, then explain details.',
          'Include practical answer blocks for target/eligibility, period/date, application path, documents, cautions, and final checklist when relevant.',
          'Avoid vague filler such as "there is a lot of information"; write the answer the reader can act on.',
        ],
        geo: [
          'Do not invent dates, amounts, agencies, or official URLs. If the source is uncertain, phrase it as a confirmation step.',
          'Mention official notice/page verification where facts may change.',
          'Separate confirmed facts, checking order, and user action so generative search can quote concise answers.',
        ],
        hardBans: [
          'No SmartEditor placeholder text: AI 활용 설정, 사진 설명을 입력하세요, 내용을 입력하세요, 출처 입력.',
          'No authoring labels in the visible article: 도입부 첫 문단, 도입부 두 번째 문단, 대답:, 답변:, 요약 답변:, 세부 설명:, 행동 권장:, 마무리 요약:, 체크리스트:.',
          'No empty quote markers and no duplicated heading text.',
          'No numbered section prefixes such as 1., 2., 3. in body paragraphs.',
          'Do not repeat labels like "요약 답변:" and "세부 설명:" in every section.',
          'Do not add refund, documents, allowance, or application steps that do not match the topic intent.',
          ...skillPayload.forbiddenPatterns,
        ],
      },
      requiredJsonShape: {
        title: 'string',
        body: 'string',
        articleBlocks: {
          intro: ['string paragraph without labels'],
          sections: [{ heading: 'string without number prefix', paragraphs: ['2-3 Korean paragraphs'], caption: 'image caption under 55 chars' }],
          conclusion: ['string paragraph without labels'],
        },
        sectionTitles: ['string'],
        imageCards: [{ label: 'string', title: 'string', subtitle: 'string', caption: 'string under 55 Korean chars' }],
      },
    }, null, 2),
  };
}

async function repairOpenAiRewriteMetrics({ openAi, model, job, title, body, sectionTitles = [], settings = {}, requiredImageCount = 0, targetRange = {}, currentMetrics = {}, research = {}, initialPrompt = '' } = {}) {
  if (!openAi?.apiKey || !body) return null;
  const charBudget = rewriteCharBudgetPlan(settings);
  const promptPayload = {
    task: 'Repair NaviWrite draft metrics without changing the topic',
    title,
    keyword: job.target_keyword,
    topic: job.target_topic || job.target_keyword,
    currentMetrics,
    target: {
      charCountMin: targetRange.minCharCount,
      charCountMax: targetRange.maxCharCount,
      keywordRepeatMin: targetRange.minKwCount,
      keywordRepeatMax: targetRange.maxKwCount,
      imagePlaceholders: requiredImageCount,
      quoteHeadingCount: settings.sectionCount || DEFAULT_REWRITE_SETTINGS.sectionCount,
      charBudget,
    },
    sectionTitles,
    factPack: research.factPack || null,
    currentBody: body.slice(0, 12000),
    repairRules: [
      'Return JSON only: {"title": string, "body": string}.',
      'Keep the same title unless it has obvious grammar errors.',
      'Rewrite the whole body naturally to fit the metric range. Do not append repeated generic paragraphs at the end.',
      'The body first line must be the title, followed by intro, CTA/QR if present, quote headings, image placeholders, section paragraphs, and conclusion.',
      'Keep image placeholders exactly as placeholders, no extra placeholders beyond the requested count.',
      'Use the exact main keyword only within the requested keyword range. Use natural variants after that.',
      'Each section must have a different fact type or user action. Avoid repeating the same warning sentence.',
      'Use factPack facts where available. Do not invent unverified dates, amounts, agencies, official URLs, or eligibility rules.',
      'Do not include labels such as "도입부 첫 문단", "답변:", "요약 답변:", "세부 설명:", "체크리스트:".',
      'Do not number body paragraphs with 1., 2., 3.',
    ],
  };
  const messages = [
    {
      role: 'system',
      content: 'You are a Korean Naver blog editor. Repair a draft so the measured length, keyword count, and image placeholder count fit the target. Return one JSON object only.',
    },
    { role: 'user', content: JSON.stringify(promptPayload, null, 2) },
  ];
  const maxCompletionTokens = clampNumber(Math.ceil((settings.targetCharCount || DEFAULT_REWRITE_SETTINGS.targetCharCount) * 2.1), 3000, 10000);
  const { data, content } = await fetchOpenAiChatJson({
    openAi,
    model,
    messages,
    maxCompletionTokens,
    temperature: 0.5,
    operation: 'OpenAI metric repair',
  });
  const parsed = safeJsonFromModelText(content);
  const repairedTitle = cleanGeneratedTitle(parsed.title || title, {
    keyword: job.target_keyword,
    fallback: title,
  });
  let repairedBody = String(parsed.body || '').trim();
  repairedBody = replaceGeneratedTitleLine(repairedBody, parsed.title || repairedTitle, repairedTitle);
  repairedBody = cleanGeneratedArticleBody(repairedBody);
  repairedBody = limitImagePlaceholders(repairedBody, requiredImageCount);
  repairedBody = limitExactKeywordRepetition(repairedBody, job.target_keyword, targetRange.maxKwCount, job.target_topic);
  const repairedMetrics = articleMetrics(repairedBody, job.target_keyword);
  return {
    title: repairedTitle,
    body: repairedBody,
    metrics: repairedMetrics,
    usage: data.usage || {
      prompt_tokens: estimateTokensFromText(`${messages[0].content}\n${messages[1].content}\n${initialPrompt}`),
      completion_tokens: estimateTokensFromText(content),
    },
  };
}

async function buildOpenAiRewriteDraft({ tenantId, job, analyses, pattern, settings, variantIndex, research = {} }) {
  const openAi = await getOpenAiSettings(tenantId);
  if (!openAi.hasApiKey) {
    throw new Error('OPENAI_API_KEY가 설정되어 있지 않습니다. 운영 설정에서 OpenAI API 키를 저장하거나 Railway 환경변수에 추가해 주세요.');
  }
  let model = normalizeOpenAiModel(settings.openaiModel || openAi.model);
  const prompt = buildOpenAiRewritePromptV2({ job, analyses, pattern, settings, variantIndex, research });
  const maxCompletionTokens = clampNumber(
    Math.ceil((settings.targetCharCount || DEFAULT_REWRITE_SETTINGS.targetCharCount) * 1.8),
    2500,
    9000
  );
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const openAiResult = await fetchOpenAiChatJson({
    openAi,
    model,
    messages,
    maxCompletionTokens,
    temperature: 0.72,
    operation: 'OpenAI rewrite draft',
  });
  const { data, content } = openAiResult;
  model = openAiResult.model || model;
  const parsed = safeJsonFromModelText(content);
  const fallbackTitle = normalizeTitleValue(job.custom_title) || makeRewriteTitle(job.target_keyword, job.target_topic, job.platform, pattern);
  let title = cleanGeneratedTitle(parsed.title || fallbackTitle, {
    keyword: job.target_keyword,
    fallback: fallbackTitle,
  });
  let body = String(parsed.body || '').trim();
  body = replaceGeneratedTitleLine(body, parsed.title || fallbackTitle, title);
  if (job.use_ai_images && !/\[(?:대표\s*이미지|대표이미지)/.test(body)) {
    body = `${title}\n\n[대표이미지 500x500 중앙정렬: ${title}]\n\n${body.replace(new RegExp(`^${escapeRegExp(title)}\\s*`, 'i'), '')}`.trim();
  }
  const sectionTitles = Array.isArray(parsed.sectionTitles) && parsed.sectionTitles.length
    ? parsed.sectionTitles.map((item) => String(item || '').replace(/^>\s*/, '').trim()).filter(Boolean)
    : makeSectionTitles(job.target_keyword, job.target_topic, Math.max(1, (pattern.sectionCount || settings.sectionCount || 7) - 1), variantIndex);
  const requiredImageCount = plannedArticleImageCount(
    { ...settings, ...pattern },
    pattern.sectionCount || settings.sectionCount || sectionTitles.length
  );
  const sectionImageLimit = Math.max(0, requiredImageCount - 1);
  sectionTitles.forEach((section, index) => {
    const markerPattern = new RegExp(`\\[(?:이미지|image|img)\\s*${index + 1}\\b`, 'i');
    if (index < sectionImageLimit && !markerPattern.test(body)) {
      body += `\n\n[이미지 ${index + 1} 500x500 중앙정렬: ${section}]`;
    }
  });
  const parsedBlocks = normalizeGeneratedArticleBlocks(parsed, {
    title,
    keyword: job.target_keyword,
    topic: job.target_topic,
    sectionTitles,
  });
  if (parsedBlocks) {
    body = buildArticleBodyFromBlocks(parsedBlocks, {
      title,
      keyword: job.target_keyword,
      platform: job.platform,
      ctaUrl: job.cta_url,
      useNaverQr: job.use_naver_qr,
      useAiImages: job.use_ai_images,
      requiredImageCount,
      sectionCount: pattern.sectionCount || settings.sectionCount || sectionTitles.length,
    });
  } else {
    body = ensureImageMarkers(body, {
      title,
      sectionTitles,
      requiredImageCount: job.use_ai_images ? requiredImageCount : 0,
    });
  }
  const targetRange = metricTargetRange({
    ...settings,
    targetCharCount: pattern.targetCharCount || settings.targetCharCount,
    targetKwCount: pattern.targetKwCount || settings.targetKwCount,
  });
  body = cleanGeneratedArticleBody(body);
  body = limitImagePlaceholders(body, requiredImageCount);
  body = limitExactKeywordRepetition(body, job.target_keyword, targetRange.maxKwCount, job.target_topic);
  let cleanedMetrics = articleMetrics(body, job.target_keyword);
  let usage = data.usage || {
    prompt_tokens: estimateTokensFromText(`${prompt.system}\n${prompt.user}`),
    completion_tokens: estimateTokensFromText(content),
  };
  let metricRepairCount = 0;
  let metricRepairError = '';
  const currentMetricDistance = metricDistanceToRange(cleanedMetrics, targetRange);
  if (currentMetricDistance > 0) {
    try {
      const repaired = await repairOpenAiRewriteMetrics({
        openAi,
        model,
        job,
        title,
        body,
        sectionTitles,
        settings,
        requiredImageCount,
        targetRange,
        currentMetrics: cleanedMetrics,
        research,
        initialPrompt: `${prompt.system}\n${prompt.user}`,
      });
      if (repaired?.usage) {
        usage = {
          prompt_tokens: (usage.prompt_tokens || 0) + (repaired.usage.prompt_tokens || 0),
          completion_tokens: (usage.completion_tokens || 0) + (repaired.usage.completion_tokens || 0),
          total_tokens: (usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)))
            + (repaired.usage.total_tokens || ((repaired.usage.prompt_tokens || 0) + (repaired.usage.completion_tokens || 0))),
        };
      }
      if (repaired?.body && metricDistanceToRange(repaired.metrics, targetRange) <= currentMetricDistance) {
        title = repaired.title || title;
        body = repaired.body;
        cleanedMetrics = repaired.metrics;
        metricRepairCount = 1;
      }
    } catch (err) {
      metricRepairError = err.message;
    }
  }
  const supplementNotes = [
    `${job.target_keyword}은 공고명과 접수처가 실제로 같은지 먼저 보는 것이 좋습니다.`,
    `${job.target_keyword} 관련 안내가 여러 곳에 올라와도 최종 판단은 공식 페이지의 최신 기준을 우선으로 두는 편이 안전합니다.`,
    `${job.target_keyword} 진행 전에는 필요한 자료와 일정 기준을 미리 적어두면 중간에 놓치는 부분을 줄일 수 있습니다.`,
    `접수 화면에서 요구하는 항목이 글마다 다르게 보이면 최신 공고문 기준으로 다시 확인해야 합니다.`,
    `신청 후에는 완료 화면이나 접수 번호를 따로 저장해 두면 결과 조회나 문의가 필요할 때 더 수월합니다.`,
    `일정이 변경될 수 있는 주제는 글을 읽은 날짜와 실제 공고 기준일을 함께 보는 습관이 필요합니다.`,
    `문의처나 담당 부서가 따로 안내되어 있다면 접수 전 한 번 확인해 두는 것이 좋습니다. 작은 기준 차이도 실제 처리 결과에는 영향을 줄 수 있습니다.`,
  ];
  let metricSupplementCount = 0;
  const allowMetricSupplement = settings.autoMetricSupplement === true;
  while (allowMetricSupplement && cleanedMetrics.charCount < targetRange.minCharCount && metricSupplementCount < Math.min(2, supplementNotes.length)) {
    body = cleanGeneratedArticleBody(`${body}\n\n${supplementNotes[metricSupplementCount]}`);
    body = limitImagePlaceholders(body, requiredImageCount);
    body = limitExactKeywordRepetition(body, job.target_keyword, targetRange.maxKwCount, job.target_topic);
    cleanedMetrics = articleMetrics(body, job.target_keyword);
    metricSupplementCount += 1;
  }
  const localQuality = enforceRewriteQualityLocally({
    title,
    body,
    keyword: job.target_keyword,
    topic: job.target_topic,
    sectionTitles,
    settings: {
      ...settings,
      targetCharCount: pattern.targetCharCount || settings.targetCharCount,
      targetKwCount: pattern.targetKwCount || settings.targetKwCount,
      sectionCount: pattern.sectionCount || settings.sectionCount,
    },
    requiredImageCount: job.use_ai_images ? requiredImageCount : 0,
  });
  body = localQuality.body;
  cleanedMetrics = localQuality.metrics;
  metricSupplementCount += localQuality.addedParagraphCount || 0;
  const enforced = {
    targetRange,
    metricAdjusted: metricSupplementCount > 0 || metricRepairCount > 0,
    metricSupplementCount,
    metricRepairCount,
    metricRepairError,
    localImageMarkerCount: localQuality.imageMarkerCount,
  };
  const plainText = cleanedMetrics.plainText;
  const charCount = cleanedMetrics.charCount;
  const kwCount = cleanedMetrics.kwCount;
  const cards = Array.isArray(parsed.imageCards) ? parsed.imageCards : [];
  const images = job.use_ai_images
      ? Array.from({ length: requiredImageCount }, (_, index) => {
        const card = cards[index] || {};
        const section = index === 0 ? title : sectionTitles[(index - 1) % Math.max(sectionTitles.length, 1)] || title;
        const url = makeTemplateImage({
          keyword: imageKeywordLabel(job.target_keyword, job.target_topic, index),
          section: card.title || card.label || section,
          subtitle: card.subtitle || (index === 0 ? '핵심 요약' : `${index}번째 포인트`),
          index,
          platform: job.platform,
        });
        return {
          index,
          role: index === 0 ? 'cover' : 'section',
          label: index === 0 ? '대표 이미지' : `이미지 ${index}`,
          title: card.title || card.label || section,
          section: card.title || card.label || section,
          caption: card.caption || imageCaptionLabel(job.target_keyword, card.title || card.label || section, index),
          prompt: `${job.target_keyword} ${card.title || card.label || section} 정보형 카드 이미지`,
          url,
          width: 500,
          height: 500,
        };
      })
    : [];
  const costUsd = estimateOpenAiCostUsd({
    model,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  });
  const usageLog = await saveOpenAiUsage({
    tenantId,
    model,
    rewriteJobId: job.id,
    usage,
    costUsd,
    meta: {
      keyword: job.target_keyword,
      platform: job.platform,
      targetCharCount: settings.targetCharCount,
      targetCharMin: enforced.targetRange.minCharCount,
      targetCharMax: enforced.targetRange.maxCharCount,
      actualCharCount: charCount,
      targetKwCount: enforced.targetRange.targetKwCount,
      actualKwCount: kwCount,
      metricAdjusted: enforced.metricAdjusted,
      metricSupplementCount: enforced.metricSupplementCount,
      metricRepairCount: enforced.metricRepairCount,
      metricRepairError: enforced.metricRepairError,
      sourceAnalysisCount: analyses.length,
      researchProvider: research.provider || 'none',
      researchSourceCount: Array.isArray(research.items) ? research.items.length : 0,
      researchAutocompleteCount: Array.isArray(research.autocompleteKeywords) ? research.autocompleteKeywords.length : 0,
    },
  });
  return {
    title,
    body,
    plainText,
    charCount,
    kwCount,
    imageCount: images.length,
    quoteCount: (body.match(/^>\s*/gm) || []).length || sectionTitles.length,
    images,
    publishSpec: buildPublishSpec(job.platform, settings, {
      hasCtaUrl: Boolean(job.cta_url),
      useNaverQr: job.use_naver_qr,
      articleBlocks: parsedBlocks || null,
      qualityGate: enforced,
    }),
    metricEnforced: enforced,
    generatorMode: 'openai',
    openaiModel: model,
    openaiUsage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
      estimatedCostUsd: costUsd,
      estimatedCostKrw: Number(usageLog?.estimated_cost_krw || 0),
      usdKrwRate: Number(usageLog?.usd_krw_rate || 0),
      exchangeRateDate: usageLog?.exchange_rate_date || null,
      exchangeRateSource: usageLog?.exchange_rate_source || null,
    },
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

async function processRewriteJob(jobId, options = {}) {
  const startedAt = Date.now();
  const jobResult = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [jobId]);
  if (jobResult.rows.length === 0) throw new Error('Rewrite job not found');
  const job = jobResult.rows[0];
  const sourceIds = Array.isArray(job.source_analysis_ids) ? job.source_analysis_ids : [];
  const completionCountResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM rewrite_job_events WHERE rewrite_job_id = $1 AND event_type = 'completed'",
    [jobId]
  );
  const variantIndex = Number(completionCountResult.rows[0]?.count || 0) + (options.forceVariant ? 1 : 0);

  await pool.query("UPDATE rewrite_jobs SET status = '패턴 분석중', updated_at = NOW() WHERE id = $1", [jobId]);
  await addRewriteEvent(jobId, 'pattern_started', '선택한 수집글 패턴 분석을 시작했습니다', { sourceIds, variantIndex });

  const analyses = sourceIds.length
    ? (await pool.query('SELECT * FROM source_analyses WHERE id = ANY($1::int[])', [sourceIds])).rows
    : [];
  const settings = parseRewriteSettings(job.settings_json);
  const pattern = buildRewritePattern(analyses, settings);
  const tenantId = options.tenantId || 'owner';
  let research = { enabled: false, provider: 'skipped', items: [], autocompleteKeywords: [], errors: [] };
  try {
    research = await buildRewriteResearchContext({
      keyword: job.target_keyword,
      topic: job.target_topic,
      platform: job.platform,
      settings,
      credentials: options.researchCredentials || null,
    });
    await addRewriteEvent(jobId, 'research_completed', '자료 검색 컨텍스트를 원고 생성에 연결했습니다.', {
      enabled: research.enabled,
      provider: research.provider,
      queries: research.queries,
      searchItemCount: Array.isArray(research.items) ? research.items.length : 0,
      factPackAvailable: Boolean(research.factPack?.available),
      factCount: research.factPack?.factCount || 0,
      factSourceCount: research.factPack?.sourceCount || 0,
      autocompleteCount: Array.isArray(research.autocompleteKeywords) ? research.autocompleteKeywords.length : 0,
      errors: research.errors,
    });
  } catch (err) {
    research = { enabled: true, provider: 'error', items: [], autocompleteKeywords: [], errors: [{ message: err.message }] };
    await addRewriteEvent(jobId, 'research_error', '자료 검색 컨텍스트 연결에 실패해 벤치마킹/키워드 기준으로 생성합니다.', { error: err.message });
  }

  await pool.query(
    "UPDATE rewrite_jobs SET status = '초안 생성중', pattern_json = $2, updated_at = NOW() WHERE id = $1",
    [jobId, JSON.stringify(pattern)]
  );
    await addRewriteEvent(jobId, 'draft_started', '발행 생성 초안을 생성합니다', { pattern });

  const shouldUseOpenAi = (options.generatorMode || settings.generatorMode || DEFAULT_REWRITE_SETTINGS.generatorMode) !== 'server_template';
  let output;
  if (shouldUseOpenAi) {
    await addRewriteEvent(jobId, 'openai_started', 'OpenAI로 유사도 낮은 원고 생성을 시작합니다', {
      model: settings.openaiModel,
      targetCharCount: settings.targetCharCount,
    });
    output = await buildOpenAiRewriteDraft({
      tenantId,
      job,
      analyses,
      pattern,
      settings,
      variantIndex,
      research,
    });
  } else {
    output = buildRewriteDraftV2({
      keyword: job.target_keyword,
      topic: job.target_topic,
      platform: job.platform,
      ctaUrl: job.cta_url,
      useNaverQr: job.use_naver_qr,
      useAiImages: job.use_ai_images,
      pattern,
      customTitle: job.custom_title,
      variantIndex,
    });
    output.generatorMode = 'server_template';
    output.openaiModel = null;
    output.openaiUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  await pool.query("UPDATE rewrite_jobs SET status = '이미지 생성중', updated_at = NOW() WHERE id = $1", [jobId]);
  await addRewriteEvent(jobId, 'images_generated', '템플릿 이미지 세트를 생성했습니다', { count: output.images.length });

  const scores = scoreRewriteOutput(output, pattern);
  const similarityRisk = estimateRewriteSimilarityRisk(output, pattern);
  const targetRange = metricTargetRange(settings);
  const metricFailed = output.charCount < targetRange.minCharCount
    || output.charCount > targetRange.maxCharCount
    || output.kwCount < targetRange.minKwCount
    || output.kwCount > targetRange.maxKwCount
    || output.imageCount !== pattern.imageCount;
  const finalStatus = metricFailed || similarityRisk >= 45 ? '검수 필요' : '글생성 완료';
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
          publish_spec = $16,
          generator_mode = $17,
          openai_model = $18,
          openai_prompt_tokens = $19,
          openai_completion_tokens = $20,
          openai_total_tokens = $21,
          openai_estimated_cost_usd = $22,
          openai_estimated_cost_krw = $23,
          openai_usd_krw_rate = $24,
          openai_exchange_rate_date = $25::date,
          elapsed_ms = $26,
          variant_index = $27,
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
      JSON.stringify(output.images.map((image, index) => (
        typeof image === 'string'
          ? { index, type: 'template-svg', url: image }
          : {
              ...image,
              index: image.index ?? index,
              type: image.type || 'template-svg',
              url: image.url || image.publicUrl || image.public_url || '',
            }
      ))),
      JSON.stringify(output.publishSpec || buildPublishSpec(job.platform, settings)),
      output.generatorMode || 'server_template',
      output.openaiModel || null,
      output.openaiUsage?.promptTokens || 0,
      output.openaiUsage?.completionTokens || 0,
      output.openaiUsage?.totalTokens || 0,
      output.openaiUsage?.estimatedCostUsd || 0,
      output.openaiUsage?.estimatedCostKrw || 0,
      output.openaiUsage?.usdKrwRate || null,
      output.openaiUsage?.exchangeRateDate || null,
      Date.now() - startedAt,
      variantIndex,
    ]
  );

  const elapsedMs = Date.now() - startedAt;
  await addRewriteEvent(jobId, 'completed', '발행 생성 작업이 완료되었습니다', {
    finalStatus,
    scores,
    similarityRisk,
    metricFailed,
    targetRange,
    actualMetrics: {
      charCount: output.charCount,
      kwCount: output.kwCount,
      imageCount: output.imageCount,
      quoteCount: output.quoteCount,
    },
    metricEnforced: output.metricEnforced || null,
    elapsedMs,
    generatorMode: output.generatorMode || 'server_template',
    openai: output.openaiUsage || null,
    variantIndex,
  });
  return attachRewriteMetricSummary({ ...rows[0], generator_mode: output.generatorMode || 'server_template', elapsed_ms: elapsedMs, variant_index: variantIndex });
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

function processRewriteJobsInBackground(jobs, options = {}) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  if (list.length === 0) return;
  const concurrency = clampNumber(parseInt(options.concurrency || '3', 10) || 3, 1, 5);
  setTimeout(async () => {
    await mapLimit(list, concurrency, async (job) => {
      try {
        const processed = await processRewriteJob(job.id, {
          tenantId: options.tenantId,
          researchCredentials: options.researchCredentials,
          generatorMode: options.generatorMode,
        });
        if (processed?.source_kind === 'rss' && processed?.source_item_id) {
          await pool.query(
            `UPDATE rss_source_items
             SET status = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [processed.source_item_id, processed.status === '오류' ? '오류' : '발행 생성 완료']
          );
        }
      } catch (err) {
        await pool.query(
          `UPDATE rewrite_jobs
           SET status = '오류',
               error_message = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [job.id, err.message]
        );
        if (job.source_kind === 'rss' && job.source_item_id) {
          await pool.query(
            `UPDATE rss_source_items
             SET status = '오류',
                 updated_at = NOW()
             WHERE id = $1`,
            [job.source_item_id]
          );
        }
        await addRewriteEvent(job.id, 'error', '발행 생성 백그라운드 처리 중 오류가 발생했습니다', { error: err.message });
      }
    });
  }, 0);
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
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

function normalizeSlotId(value = '') {
  return String(value || `acc_${Date.now()}`).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `acc_${Date.now()}`;
}

function credentialMasterKey() {
  const secret = process.env.CREDENTIAL_MASTER_KEY
    || process.env.NAVIWRITE_CREDENTIAL_KEY
    || process.env.DATABASE_URL
    || (process.env.NODE_ENV === 'production' ? '' : 'naviwrite-dev-credential-key');
  if (!secret) {
    throw new Error('CREDENTIAL_MASTER_KEY 환경변수가 필요합니다.');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptCredentialSecret(secret = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptCredentialSecret(row = {}) {
  if (!row.credential_cipher || !row.credential_iv || !row.credential_tag) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    credentialMasterKey(),
    Buffer.from(row.credential_iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(row.credential_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.credential_cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function publicAccountSlot(row = {}) {
  const channelDiscovery = row.channel_discovery || {};
  const qrDailyLimit = clampNumber(parseInt(row.qr_daily_limit || '10', 10) || 10, 1, 10);
  const qrUsedDate = row.qr_used_date ? String(row.qr_used_date).slice(0, 10) : null;
  const qrToday = kstDateString();
  const qrUsedToday = qrUsedDate === qrToday ? clampNumber(parseInt(row.qr_used_count || '0', 10) || 0, 0, qrDailyLimit) : 0;
  const qrRemainingToday = Math.max(0, qrDailyLimit - qrUsedToday);
  const qrLimitStatus = qrRemainingToday <= 0 ? '한도 소진' : (row.qr_limit_status || '사용가능');
  return {
    id: row.slot_id,
    slotId: row.slot_id,
    tenantId: row.tenant_id,
    platform: row.platform || 'blog',
    label: row.label || row.slot_id,
    usernameHint: row.username || '',
    memo: row.target_url || row.memo || '',
    targetUrl: row.target_url || '',
    loginStatus: row.login_status || '인증 필요',
    credentialMode: row.credential_mode || 'server-aes-256-gcm',
    credentialPolicy: '서버 AES-256 암호화',
    sessionPolicy: '6시간 체크 · 2시간 무활동 재확인',
    hasCredential: Boolean(row.credential_cipher),
    credentialUpdatedAt: row.credential_updated_at || null,
    credentialVerifiedAt: row.credential_verified_at || null,
    channelDiscoveredAt: row.channel_discovered_at || null,
    channelDiscoveryOk: channelDiscovery?.ok ?? null,
    channelDiscovery,
    categories: Array.isArray(channelDiscovery?.categories) ? channelDiscovery.categories : [],
    runnerProfileId: row.slot_id,
    qrDailyLimit,
    qrUsedDate: qrToday,
    qrUsedToday,
    qrRemainingToday,
    qrLimitStatus,
    qrLastShortUrl: row.qr_last_short_url || '',
    qrLastUsedAt: row.qr_last_used_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function consumeQrAccountUsage({ tenantId, slotId, shortUrl = '' }) {
  if (!slotId) return null;
  const today = kstDateString();
  const slot = await loadAccountSlot({ tenantId, slotId });
  if (!slot) return null;
  const limit = clampNumber(parseInt(slot.qr_daily_limit || '10', 10) || 10, 1, 10);
  const storedDate = slot.qr_used_date ? String(slot.qr_used_date).slice(0, 10) : null;
  const currentUsed = storedDate === today ? clampNumber(parseInt(slot.qr_used_count || '0', 10) || 0, 0, limit) : 0;
  if (currentUsed >= limit) {
    const { rows } = await pool.query(
      `UPDATE account_slots
       SET qr_used_date = $3::date,
           qr_used_count = $4,
           qr_limit_status = '한도 소진',
           updated_at = NOW()
       WHERE tenant_id = $1 AND slot_id = $2
       RETURNING *`,
      [tenantId, slotId, today, currentUsed]
    );
    return { ok: false, account: publicAccountSlot(rows[0] || slot), reason: 'QR daily limit reached' };
  }
  const { rows } = await pool.query(
    `UPDATE account_slots
     SET qr_used_date = $3::date,
         qr_used_count = $4,
         qr_limit_status = CASE WHEN $4 >= LEAST(GREATEST(COALESCE(qr_daily_limit, 10), 1), 10) THEN '한도 소진' ELSE '사용가능' END,
         qr_last_short_url = COALESCE($5, qr_last_short_url),
         qr_last_used_at = NOW(),
         updated_at = NOW()
     WHERE tenant_id = $1 AND slot_id = $2
     RETURNING *`,
    [tenantId, slotId, today, currentUsed + 1, shortUrl || null]
  );
  return { ok: true, account: publicAccountSlot(rows[0]), used: currentUsed + 1, limit };
}

async function loadAccountSlot({ tenantId, slotId }) {
  const { rows } = await pool.query(
    `SELECT * FROM account_slots
     WHERE tenant_id = $1 AND slot_id = $2
     LIMIT 1`,
    [tenantId, slotId]
  );
  return rows[0] || null;
}

function normalizePublishMode(value = '') {
  const mode = String(value || '').toLowerCase();
  if (['now', 'immediate', '즉시발행'].includes(mode)) return 'immediate';
  if (['scheduled', '예약발행'].includes(mode)) return 'scheduled';
  return 'draft';
}

function normalizePublishStatus(value = '') {
  const status = String(value || '').trim();
  const allowed = new Set(['초안대기', '자동발행대기', '발행대기', '예약대기', '발행중', '발행완료', 'RSS확인완료', '성과추적중', '오류']);
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

function rssUrlFromCollectedBlog(blog = {}) {
  const blogId = String(blog.blog_id || '').trim();
  if (blogId) return `https://rss.blog.naver.com/${blogId}.xml`;
  const home = String(blog.home_url || '').trim();
  const match = home.match(/blog\.naver\.com\/([^/?#]+)/i);
  return match?.[1] ? `https://rss.blog.naver.com/${match[1]}.xml` : null;
}

async function getAppSetting(key, fallback = {}) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (!rows[0]) return fallback;
  return rows[0].value && typeof rows[0].value === 'object' ? rows[0].value : fallback;
}

async function setAppSetting(key, value = {}) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING *`,
    [key, JSON.stringify(value || {})]
  );
  return rows[0]?.value || value || {};
}

const OPENAI_PRICING_USD_PER_1M = {
  'gpt-4.1-mini': { input: 0.40, output: 1.60, label: 'GPT-4.1 mini' },
  'gpt-4.1': { input: 2.00, output: 8.00, label: 'GPT-4.1' },
  'gpt-5-mini': { input: 0.25, output: 2.00, label: 'GPT-5 mini' },
};

function normalizeOpenAiModel(model = '') {
  const value = String(model || '').trim();
  return value || process.env.OPENAI_WRITER_MODEL || DEFAULT_REWRITE_SETTINGS.openaiModel;
}

function openAiPricingFor(model = '') {
  return OPENAI_PRICING_USD_PER_1M[normalizeOpenAiModel(model)] || OPENAI_PRICING_USD_PER_1M[DEFAULT_REWRITE_SETTINGS.openaiModel];
}

function estimateTokensFromText(text = '') {
  const compact = String(text || '').replace(/\s+/g, '');
  const latin = (compact.match(/[a-zA-Z0-9]/g) || []).length;
  const hangul = compact.length - latin;
  return Math.max(1, Math.ceil(hangul * 0.9 + latin * 0.35));
}

function estimateOpenAiCostUsd({ model, promptTokens = 0, completionTokens = 0 }) {
  const pricing = openAiPricingFor(model);
  return Number((((promptTokens * pricing.input) + (completionTokens * pricing.output)) / 1000000).toFixed(6));
}

function parseUsdKrwRate(value) {
  const numeric = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(numeric) && numeric > 0 ? Number(numeric.toFixed(4)) : 0;
}

function yyyymmdd(dateString = kstDateString()) {
  return String(dateString || '').replace(/-/g, '').slice(0, 8);
}

function addDaysToDateString(dateString, days) {
  const [year, month, day] = String(dateString || kstDateString()).split('-').map(Number);
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

async function cacheUsdKrwRate({ rateDate, sourceDate, rate, source, isFallback = false, meta = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO exchange_rate_daily (
       rate_date, source_date, base_currency, quote_currency, rate_type, rate,
       source, is_fallback, meta, fetched_at
     )
     VALUES ($1::date,$2::date,'USD','KRW','deal_bas_r',$3,$4,$5,$6::jsonb,NOW())
     ON CONFLICT (rate_date, base_currency, quote_currency, rate_type) DO UPDATE SET
       source_date = EXCLUDED.source_date,
       rate = EXCLUDED.rate,
       source = EXCLUDED.source,
       is_fallback = EXCLUDED.is_fallback,
       meta = EXCLUDED.meta,
       fetched_at = NOW()
     RETURNING *`,
    [rateDate, sourceDate, Number(rate), source, Boolean(isFallback), JSON.stringify(meta || {})]
  );
  return rows[0];
}

async function fetchKoreaEximUsdKrwRate(rateDate) {
  const authKey = process.env.KOREA_EXIM_API_KEY || process.env.KOREAEXIM_API_KEY || process.env.EXCHANGE_RATE_API_KEY || '';
  if (!authKey) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const sourceDate = addDaysToDateString(rateDate, -offset);
    const url = `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${encodeURIComponent(authKey)}&searchdate=${yyyymmdd(sourceDate)}&data=AP01`;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      const rows = Array.isArray(data) ? data : [];
      const usd = rows.find((row) => String(row.cur_unit || row.CUR_UNIT || '').toUpperCase().startsWith('USD'));
      const rate = parseUsdKrwRate(usd?.deal_bas_r || usd?.DEAL_BAS_R || usd?.kftc_deal_bas_r || usd?.KFTC_DEAL_BAS_R);
      if (rate) {
        return {
          rateDate,
          sourceDate,
          rate,
          source: 'koreaexim_deal_bas_r',
          isFallback: offset > 0,
          meta: { offsetDays: offset, curUnit: usd.cur_unit || usd.CUR_UNIT || 'USD' },
        };
      }
    } catch (err) {
      if (offset === 7) {
        console.warn('[exchange-rate] Korea Exim fetch failed:', err.message);
      }
    }
  }
  return null;
}

async function fetchNaverUsdKrwRate(rateDate) {
  const today = kstDateString();
  if (String(rateDate || today).slice(0, 10) !== today) return null;
  try {
    const response = await fetch('https://api.stock.naver.com/marketindex/exchange/FX_USDKRW', {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'NaviWrite/1.0 (+https://web-production-184ff.up.railway.app)',
      },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const info = data?.exchangeInfo || {};
    const rate = parseUsdKrwRate(info.closePrice || info.calcPrice);
    if (!rate) return null;
    const tradedAt = String(info.localTradedAt || '');
    return {
      rateDate,
      sourceDate: tradedAt.slice(0, 10) || rateDate,
      rate,
      source: 'naver_hana_deal_bas_r',
      isFallback: false,
      meta: {
        provider: 'Naver Finance',
        bank: info.stockExchangeType?.nameKor || '하나은행',
        localTradedAt: tradedAt,
        degreeCount: info.degreeCount || null,
        marketStatus: info.marketStatus || '',
        priceDataType: info.priceDataType || '',
      },
    };
  } catch (err) {
    console.warn('[exchange-rate] Naver fetch failed:', err.message);
    return null;
  }
}

async function fetchOpenUsdKrwRate(rateDate) {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const rate = parseUsdKrwRate(data?.rates?.KRW);
    if (!rate) return null;
    return {
      rateDate,
      sourceDate: rateDate,
      rate,
      source: 'open_er_api_latest_usd',
      isFallback: true,
      meta: { note: 'Fallback latest market rate, not Korea Exim deal_bas_r' },
    };
  } catch (err) {
    console.warn('[exchange-rate] fallback fetch failed:', err.message);
    return null;
  }
}

async function getUsdKrwRateForDate(rateDate = kstDateString(), { refresh = false } = {}) {
  const date = String(rateDate || kstDateString()).slice(0, 10);
  if (!refresh) {
    const cached = await pool.query(
      `SELECT *
       FROM exchange_rate_daily
       WHERE rate_date = $1::date
         AND base_currency = 'USD'
         AND quote_currency = 'KRW'
         AND rate_type = 'deal_bas_r'
       LIMIT 1`,
      [date]
    );
    if (cached.rows[0]) {
      const cachedSource = String(cached.rows[0].source || '');
      const shouldPreferNaverToday = date === kstDateString() && cachedSource !== 'naver_hana_deal_bas_r';
      if (!shouldPreferNaverToday) return cached.rows[0];
    }
  }
  const fetched = await fetchNaverUsdKrwRate(date) || await fetchKoreaEximUsdKrwRate(date) || await fetchOpenUsdKrwRate(date);
  if (fetched) return cacheUsdKrwRate(fetched);
  const fallbackRate = parseUsdKrwRate(process.env.DEFAULT_USD_KRW_RATE || process.env.USD_KRW_RATE || 1350);
  return cacheUsdKrwRate({
    rateDate: date,
    sourceDate: date,
    rate: fallbackRate,
    source: 'manual_env_fallback',
    isFallback: true,
    meta: { note: 'Set KOREA_EXIM_API_KEY for official 매매기준율' },
  });
}

function estimateRewriteOpenAiUsage({ model, count = 1, targetCharCount = 2200, sourceCount = 0, sectionCount = 7 }) {
  const safeCount = clampNumber(parseInt(count, 10) || 1, 1, 500);
  const safeChars = clampNumber(parseInt(targetCharCount, 10) || DEFAULT_REWRITE_SETTINGS.targetCharCount, 1200, 5000);
  const promptTokensPerJob = 1200 + Math.min(5, Number(sourceCount || 0)) * 650 + Number(sectionCount || 7) * 45;
  const completionTokensPerJob = Math.ceil(safeChars * 1.08) + 500;
  const promptTokens = safeCount * promptTokensPerJob;
  const completionTokens = safeCount * completionTokensPerJob;
  return {
    model: normalizeOpenAiModel(model),
    count: safeCount,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateOpenAiCostUsd({ model, promptTokens, completionTokens }),
  };
}

function openAiSettingKey(tenantId = 'owner') {
  return `openai:${tenantId || 'owner'}`;
}

async function getOpenAiSettings(tenantId = 'owner') {
  const stored = await getAppSetting(openAiSettingKey(tenantId), {});
  const storedModel = stored.model === 'gpt-4.1-mini' ? '' : stored.model;
  const model = normalizeOpenAiModel(storedModel || process.env.OPENAI_WRITER_MODEL || DEFAULT_REWRITE_SETTINGS.openaiModel);
  let siteApiKey = '';
  try {
    siteApiKey = stored.apiKeyCipher ? decryptCredentialSecret({
      credential_cipher: stored.apiKeyCipher,
      credential_iv: stored.apiKeyIv,
      credential_tag: stored.apiKeyTag,
    }) : '';
  } catch {
    siteApiKey = '';
  }
  const envApiKey = process.env.OPENAI_API_KEY || '';
  return {
    model,
    monthlyBudgetUsd: Number(stored.monthlyBudgetUsd ?? stored.monthly_budget_usd ?? process.env.OPENAI_MONTHLY_BUDGET_USD ?? 20) || 20,
    apiKey: siteApiKey || envApiKey,
    keySource: siteApiKey ? 'site_encrypted' : envApiKey ? 'railway_env' : 'missing',
    hasApiKey: Boolean(siteApiKey || envApiKey),
    updatedAt: stored.updatedAt || null,
  };
}

function publicOpenAiSettings(settings = {}) {
  return {
    model: settings.model,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    hasApiKey: settings.hasApiKey,
    keySource: settings.keySource,
    pricing: openAiPricingFor(settings.model),
    pricingSource: 'OpenAI API pricing page, standard text token rates',
  };
}

async function saveOpenAiUsage({ tenantId = 'owner', feature = 'rewrite', operation = 'article_generation', model, rewriteJobId = null, contentJobId = null, usage = {}, costUsd = 0, meta = {} }) {
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens) || 0;
  const exchangeRateDate = kstDateString();
  const exchangeRate = await getUsdKrwRateForDate(exchangeRateDate);
  const usdKrwRate = Number(exchangeRate?.rate || 0);
  const costKrw = Number((Number(costUsd || 0) * usdKrwRate).toFixed(2));
  const { rows } = await pool.query(
    `INSERT INTO openai_usage_logs (
       tenant_id, feature, operation, model, rewrite_job_id, content_job_id,
       prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
       exchange_rate_date, exchange_rate_source_date, usd_krw_rate, estimated_cost_krw, exchange_rate_source,
       request_meta
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14,$15,$16)
     RETURNING *`,
    [
      tenantId,
      feature,
      operation,
      normalizeOpenAiModel(model),
      rewriteJobId,
      contentJobId,
      promptTokens,
      completionTokens,
      totalTokens,
      Number(costUsd || 0),
      exchangeRateDate,
      exchangeRate?.source_date || exchangeRateDate,
      usdKrwRate,
      costKrw,
      exchangeRate?.source || 'manual_env_fallback',
      JSON.stringify({
        ...meta,
        exchangeRate: {
          rateDate: exchangeRateDate,
          sourceDate: exchangeRate?.source_date || exchangeRateDate,
          usdKrwRate,
          source: exchangeRate?.source || 'manual_env_fallback',
          isFallback: Boolean(exchangeRate?.is_fallback),
        },
      }),
    ]
  );
  return rows[0];
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
    content_skill_key: body.content_skill_key || body.contentSkillKey || DEFAULT_REWRITE_SETTINGS.contentSkillKey,
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
    naver_qr_short_url: body.naver_qr_short_url || body.naverQrShortUrl || body.shortUrl || body.short_url || null,
    naver_qr_image_url: body.naver_qr_image_url || body.naverQrImageUrl || null,
    naver_qr_manage_url: body.naver_qr_manage_url || body.naverQrManageUrl || null,
    qr_created_at: normalizeOptionalDate(body.qr_created_at || body.qrCreatedAt),
    qr_account_id: body.qr_account_id || body.qrAccountId || null,
    qr_error_message: body.qr_error_message || body.qrErrorMessage || null,
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
    action_delay_min_seconds: normalizeDelaySeconds(body.action_delay_min_seconds ?? body.actionDelayMinSeconds, 60, 0, 600),
    action_delay_max_seconds: normalizeDelaySeconds(body.action_delay_max_seconds ?? body.actionDelayMaxSeconds, 60, 1, 600),
    between_posts_delay_minutes: normalizeDelaySeconds(body.between_posts_delay_minutes ?? body.betweenPostsDelayMinutes, 120, 1, 1440),
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
    naverQrShortUrl: job.naver_qr_short_url,
    naverQrImageUrl: job.naver_qr_image_url,
    naverQrManageUrl: job.naver_qr_manage_url,
    qrCreatedAt: job.qr_created_at,
    qrAccountId: job.qr_account_id,
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
    const guid = stripHtml(extractXmlTag(block, 'guid')) || link;
    const pubDate = stripHtml(extractXmlTag(block, 'pubDate'));
    const description = stripHtml(extractXmlTag(block, 'description'));
    const date = pubDate ? new Date(pubDate) : null;
    return {
      title,
      link,
      guid,
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
  for (const [arrayIndex, rawImage] of images.entries()) {
    const image = typeof rawImage === 'string' ? { url: rawImage, index: arrayIndex } : (rawImage || {});
    const parsedIndex = Number(image.index ?? image.section_no ?? image.sectionNo ?? arrayIndex);
    const index = Number.isFinite(parsedIndex) ? parsedIndex : arrayIndex;
    const imageUrl = image.url || image.dataUrl || image.data_url || image.publicUrl || image.public_url || '';
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
        String(imageUrl || '').startsWith('data:') ? 'data-url' : 'external-url',
        `generated/${tenantId}/job-${contentJobId}/image-${String(index).padStart(2, '0')}.svg`,
        String(imageUrl || '').startsWith('data:') ? null : imageUrl,
        String(imageUrl || '').startsWith('data:') ? imageUrl : null,
        500,
        500,
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

function buildObsidianMarkdown(job = {}, images = []) {
  const generationModel = job.openai_model || DEFAULT_REWRITE_SETTINGS.openaiModel;
  const skill = contentSkillFor(job.content_skill_key || DEFAULT_REWRITE_SETTINGS.contentSkillKey);
  const frontmatter = [
    '---',
    `tenant: ${job.tenant_id || 'owner'}`,
    `keyword: ${JSON.stringify(job.keyword || '')}`,
    `content_skill: ${skill.key}`,
    `content_skill_name: ${JSON.stringify(skill.name)}`,
    `generation_model: ${generationModel}`,
    'title_rule: "naver_search_compact"',
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
  const learningFields = (skill.writingRules?.obsidianLearningFields || [])
    .map((field) => `- ${field}: `)
    .join('\n');
  return `${frontmatter}# ${job.title || job.keyword}\n\n## 발행 정보\n\n- 계정: ${job.publish_account_label || '-'}\n- 모드: ${job.publish_mode || 'draft'}\n- 상태: ${job.publish_status || '-'}\n- URL: ${job.published_url || '-'}\n\n## 생성 규칙\n\n- 스킬: ${skill.name} (${skill.key})\n- 모델 기준: ${generationModel}\n- 제목 규칙: 메인키워드 전면, 자동완성/연관 키워드 조합, 조사/연결어 최소화, 랜딩 CTA 금지\n- 제목 예시형: 메인키워드 신청 방법 일정 안내 공식 홈페이지\n- 본문 기준: 공백 제외 ${DEFAULT_REWRITE_SETTINGS.targetCharCount}자 전후, 소제목 ${DEFAULT_REWRITE_SETTINGS.sectionCount}개, KW 반복 ${DEFAULT_REWRITE_SETTINGS.targetKwCount}회 기준\n- 이미지 기준: 썸네일 1장과 섹션 이미지, 500x500 중앙 정렬\n\n## 키워드/성과\n\n- 메인 키워드: ${job.keyword || '-'}\n- 글자수: ${job.char_count || 0}\n- KW 반복: ${job.kw_count || 0}\n- 이미지: ${job.image_count || 0}\n- SEO/GEO/AEO: ${Math.round(Number(job.seo_score || 0))}/${Math.round(Number(job.geo_score || 0))}/${Math.round(Number(job.aeo_score || 0))}\n\n## 이미지\n\n${imageList}\n\n## 스킬 피드백\n\n${learningFields || '- 확인된 공식 사실: \\n- 생성 후 사람이 고친 사실: \\n- 다음 생성에서 금지할 문장: '}\n\n## 본문\n\n${job.plain_text || job.body || ''}\n`;
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

function generatedImageDownloadUrl(req, image) {
  const tenantId = encodeURIComponent(tenantIdFromReq(req));
  return `/api/generated-images/${image.id}/file?tenantId=${tenantId}`;
}

function generatedImageClientPayload(req, image, arrayIndex = 0) {
  const persistedSectionNo = Number(image.section_no ?? arrayIndex);
  const sectionNo = persistedSectionNo === 0 && arrayIndex > 0 ? arrayIndex : persistedSectionNo;
  const isCover = arrayIndex === 0 && (image.image_type === 'cover' || sectionNo === 0);
  return {
    ...image,
    index: sectionNo,
    role: isCover ? 'cover' : 'section',
    label: isCover
      ? '대표 이미지'
      : `이미지 ${sectionNo || arrayIndex}`,
    section: image.prompt || '',
    download_url: generatedImageDownloadUrl(req, image),
    downloadUrl: generatedImageDownloadUrl(req, image),
    editor_upload_mode: 'extension_download_blob_then_upload',
    editorUploadMode: 'extension_download_blob_then_upload',
  };
}

async function addJobEvent(jobId, eventType, message, payload = {}) {
  await pool.query(
    `INSERT INTO content_job_events (job_id, event_type, message, payload)
     VALUES ($1, $2, $3, $4)`,
    [jobId, eventType, message, payload]
  );
}

async function resetStalePublishingJobs({ tenantId = null, minutes = null, reason = 'timeout' } = {}) {
  const staleMinutes = normalizeStalePublishMinutes(minutes);
  const message = `${staleMinutes}분 이상 발행중 상태가 유지되어 자동발행 대기로 복구했습니다.`;
  const { rows } = await pool.query(
    `UPDATE content_jobs
     SET publish_status = '자동발행대기',
         scheduled_at = NULL,
         error_message = CASE
           WHEN error_message IS NULL OR error_message = '' THEN $3
           ELSE error_message
         END,
         updated_at = NOW()
     WHERE ($1::text IS NULL OR COALESCE(tenant_id, 'owner') = $1)
       AND publish_status = '발행중'
       AND published_url IS NULL
       AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')
     RETURNING *`,
    [tenantId, staleMinutes, message]
  );
  for (const job of rows) {
    await addJobEvent(job.id, 'publish_auto_requeued', message, { staleMinutes, reason });
  }
  return { count: rows.length, minutes: staleMinutes, jobs: rows };
}

async function buildAutoPublishSlots({ tenantId, count, spacingMinutes = 120 }) {
  const spacingMs = clampNumber(parseInt(spacingMinutes, 10) || 120, 1, 1440) * 60 * 1000;
  const now = new Date();
  const latest = await pool.query(
    `SELECT scheduled_at
     FROM content_jobs
     WHERE COALESCE(tenant_id, 'owner') = $1
       AND publish_mode = 'scheduled'
       AND publish_status IN ('자동발행대기', '발행대기', '예약대기', '발행중')
       AND scheduled_at IS NOT NULL
     ORDER BY scheduled_at DESC
     LIMIT 1`,
    [tenantId]
  );
  const lastScheduledAt = latest.rows[0]?.scheduled_at ? new Date(latest.rows[0].scheduled_at) : null;
  const startAt = lastScheduledAt
    && lastScheduledAt.getTime() > now.getTime()
    && lastScheduledAt.getTime() - now.getTime() <= spacingMs
    ? new Date(lastScheduledAt.getTime() + spacingMs)
    : now;

  return Array.from({ length: count }, (_, index) => new Date(startAt.getTime() + index * spacingMs).toISOString());
}

function normalizeSpacingMinutes(value, fallback, min = 1, max = 1440) {
  return clampNumber(parseInt(value, 10) || fallback, min, max);
}

function normalizeDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function computeRunnerPublishPlan({
  lastPublishedAt = null,
  spacingMinMinutes = 120,
  spacingMaxMinutes = 180,
  now = new Date(),
} = {}) {
  const minMinutes = normalizeSpacingMinutes(spacingMinMinutes, 120, 1, 1440);
  const maxMinutes = Math.max(minMinutes, normalizeSpacingMinutes(spacingMaxMinutes, 180, 1, 1440));
  const lastDate = normalizeDateValue(lastPublishedAt);
  const maxSpacingMs = maxMinutes * 60 * 1000;

  if (!lastDate) {
    return {
      publishMode: 'immediate',
      publishStatus: '발행대기',
      scheduledAt: null,
      reason: '최근 발행 기록 없음',
      spacingMinMinutes: minMinutes,
      spacingMaxMinutes: maxMinutes,
      now: now.toISOString(),
      lastPublishedAt: null,
    };
  }

  const elapsedMs = now.getTime() - lastDate.getTime();
  if (elapsedMs >= maxSpacingMs) {
    return {
      publishMode: 'immediate',
      publishStatus: '발행대기',
      scheduledAt: null,
      reason: `${maxMinutes}분 이상 발행 공백`,
      spacingMinMinutes: minMinutes,
      spacingMaxMinutes: maxMinutes,
      now: now.toISOString(),
      lastPublishedAt: lastDate.toISOString(),
      elapsedMinutes: Math.max(0, Math.floor(elapsedMs / 60000)),
    };
  }

  const candidateAt = new Date(lastDate.getTime() + maxSpacingMs);
  return {
    publishMode: 'scheduled',
    publishStatus: '예약대기',
    scheduledAt: candidateAt.toISOString(),
    reason: `${maxMinutes}분 이내 최근 발행 감지`,
    spacingMinMinutes: minMinutes,
    spacingMaxMinutes: maxMinutes,
    now: now.toISOString(),
    lastPublishedAt: lastDate.toISOString(),
    elapsedMinutes: Math.max(0, Math.floor(elapsedMs / 60000)),
  };
}

async function loadLatestPublishedForRunnerPlan({ tenantId, jobId, publishAccountId, publishAccountLabel, publishAccountPlatform }) {
  const values = [tenantId, jobId];
  const accountConditions = [];
  if (publishAccountId) {
    values.push(publishAccountId);
    accountConditions.push(`publish_account_id = $${values.length}`);
  }
  if (publishAccountLabel) {
    values.push(publishAccountLabel);
    accountConditions.push(`publish_account_label = $${values.length}`);
  }
  if (publishAccountPlatform) {
    values.push(publishAccountPlatform);
    accountConditions.push(`publish_account_platform = $${values.length}`);
  }
  if (accountConditions.length === 0) return null;

  const accountWhere = accountConditions.length ? `AND (${accountConditions.join(' OR ')})` : '';
  const { rows } = await pool.query(
    `SELECT id,
            COALESCE(published_at, scheduled_at) AS published_at,
            published_at AS actual_published_at,
            scheduled_at AS planned_at,
            published_url,
            publish_status,
            publish_account_id,
            publish_account_label,
            publish_account_platform
     FROM content_jobs
     WHERE COALESCE(tenant_id, 'owner') = $1
       AND id <> $2
       AND (
         (published_at IS NOT NULL AND publish_status IN ('발행완료', 'RSS확인완료', '성과추적중'))
         OR (scheduled_at IS NOT NULL AND publish_status IN ('발행중', '발행대기', '예약대기', '자동발행대기'))
       )
       ${accountWhere}
     ORDER BY COALESCE(published_at, scheduled_at) DESC
     LIMIT 1`,
    values
  );
  return rows[0] || null;
}

async function createContentJobFromRewrite({ tenantId, rewriteJob, body = {} }) {
  const input = normalizeJobInput({
    ...body,
    tenantId,
    rewriteJobId: rewriteJob.id,
    keyword: rewriteJob.target_keyword,
    category: rewriteJob.category,
    platform: rewriteJob.platform,
    contentSkillKey: rewriteJob.content_skill_key || parseRewriteSettings(rewriteJob.settings_json).contentSkillKey,
    ctaUrl: rewriteJob.naver_qr_short_url || rewriteJob.cta_url,
    qrTargetUrl: rewriteJob.qr_target_url || rewriteJob.cta_url,
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
    naverQrName: rewriteJob.naver_qr_name,
    naverQrShortUrl: rewriteJob.naver_qr_short_url,
    naverQrImageUrl: rewriteJob.naver_qr_image_url,
    naverQrManageUrl: rewriteJob.naver_qr_manage_url,
    qrCreatedAt: rewriteJob.qr_created_at,
    qrAccountId: rewriteJob.qr_account_id,
    qrErrorMessage: rewriteJob.qr_error_message,
    qrStatus: rewriteJob.qr_status || (rewriteJob.use_naver_qr ? 'QR 생성 필요' : 'QR 미사용'),
    generationStatus: '글생성 완료',
    publishMode: body.publishMode || body.publish_mode || 'scheduled',
    publishStatus: body.publishStatus || body.publish_status || '예약대기',
    rssUrl: body.rssUrl || body.rss_url || null,
    obsidianExportStatus: '관리자전용',
  });
  const qrName = input.naver_qr_name || makeNaverQrName(input.keyword, input.campaign_name || 'rewrite');
  const { rows } = await pool.query(
    `INSERT INTO content_jobs (
       tenant_id, rewrite_job_id, keyword, category, platform, content_skill_key, cta_url, qr_target_url,
       title, body, plain_text, char_count, kw_count, image_count,
       seo_score, geo_score, aeo_score, total_score,
       naver_qr_name, naver_qr_short_url, naver_qr_image_url, naver_qr_manage_url,
       qr_status, qr_created_at, qr_account_id, qr_error_message, generation_status, editor_status,
       publish_mode, scheduled_at, publish_status, publish_account_id,
       publish_account_label, publish_account_platform, action_delay_min_seconds,
       action_delay_max_seconds, between_posts_delay_minutes, rss_url, obsidian_export_status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
     RETURNING *`,
    [
      input.tenant_id, input.rewrite_job_id, input.keyword, input.category, input.platform,
      input.content_skill_key, input.cta_url, input.qr_target_url, input.title, input.body, input.plain_text,
      input.char_count, input.kw_count, input.image_count, input.seo_score, input.geo_score,
      input.aeo_score, input.total_score, qrName, input.naver_qr_short_url, input.naver_qr_image_url,
      input.naver_qr_manage_url, input.qr_status, input.qr_created_at, input.qr_account_id,
      input.qr_error_message, input.generation_status, input.editor_status, input.publish_mode,
      input.scheduled_at, input.publish_status,
      input.publish_account_id, input.publish_account_label, input.publish_account_platform,
      input.action_delay_min_seconds, input.action_delay_max_seconds, input.between_posts_delay_minutes,
      input.rss_url, input.obsidian_export_status,
    ]
  );
  const images = await saveGeneratedImagesForContentJob({ tenantId, contentJobId: rows[0].id, rewriteJob });
    await addJobEvent(rows[0].id, 'publish_queue_created', '발행 생성 작업을 자동발행 대기로 보냈습니다', {
    rewriteJobId: rewriteJob.id,
    imageCount: images.length,
    scheduledAt: input.scheduled_at,
    publishStatus: input.publish_status,
  });
  return { job: rows[0], images };
}

async function ensureContentJobFromRewrite({ tenantId, rewriteJob, body = {} }) {
  const { rows: existing } = await pool.query(
    `SELECT cj.*,
            COUNT(gi.id)::int AS generated_image_count
     FROM content_jobs cj
     LEFT JOIN generated_images gi ON gi.content_job_id = cj.id
     WHERE COALESCE(cj.tenant_id, 'owner') = $1
       AND cj.rewrite_job_id = $2
       AND cj.publish_status NOT IN ('발행완료', 'RSS확인완료', '성과추적중')
     GROUP BY cj.id
     ORDER BY cj.created_at DESC
     LIMIT 1`,
    [tenantId, rewriteJob.id]
  );
  if (existing[0]) {
    const images = await loadGeneratedImages(existing[0].id);
    return { job: existing[0], images, existing: true };
  }
  return createContentJobFromRewrite({
    tenantId,
    rewriteJob,
    body: {
      publishMode: 'draft',
      publishStatus: '초안대기',
      actionDelayMinSeconds: 60,
      actionDelayMaxSeconds: 60,
      betweenPostsDelayMinutes: 120,
      ...body,
    },
  });
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
           main_keyword = COALESCE($3, main_keyword),
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

router.post('/collections/links/:id/recommend-main-keyword', async (req, res) => {
  try {
    const current = await pool.query(
      `SELECT sl.id, sl.url, sl.source_analysis_id,
              sa.plain_text, sa.title, sa.keyword_candidates, sa.main_keyword, sa.keyword,
              sa.category_guess, sa.platform_guess
       FROM source_links sl
       LEFT JOIN source_analyses sa ON sa.id = sl.source_analysis_id
       WHERE sl.id = $1`,
      [req.params.id]
    );
    if (current.rows.length === 0) return res.status(404).json({ error: 'Source link not found' });
    const row = current.rows[0];
    if (!row.source_analysis_id) return res.status(400).json({ error: '수집완료 된 분석만 재분석할 수 있습니다' });

    let analysis = null;
    let fetchStatus = 'saved_only';
    let errorMessage = null;
    try {
      const html = await fetchSourceHtml(row.url);
      const mobileHtml = await fetchNaverMobileHtml(row.url);
      const blogHomeHtml = await fetchNaverBlogHomeHtml(row.url);
      analysis = buildSourceAnalysis({
        sourceUrl: row.url,
        html,
        mobileHtml,
        blogHomeHtml,
        category: row.category_guess,
        platform: row.platform_guess,
        fetchStatus: 'refetched',
      });
      fetchStatus = 'refetched';
    } catch (err) {
      errorMessage = err.message;
    }

    const savedCandidates = parseJsonArray(row.keyword_candidates);
    const candidates = analysis?.keywordCandidates?.length ? analysis.keywordCandidates : savedCandidates;
    const recommendedKeyword = normalizeKeywordValue(
      candidates[0]?.keyword || candidates[0]?.term || row.main_keyword || row.keyword || ''
    );
    if (!recommendedKeyword) return res.status(400).json({ error: '추천할 메인 키워드를 찾지 못했습니다' });

    const plainText = analysis?.plainText || row.plain_text || '';
    const kwCount = countKeywordInText(plainText, recommendedKeyword);
    const { rows } = await pool.query(
      `UPDATE source_analyses
       SET corrected_main_keyword = $2,
           keyword = $2,
           main_keyword = $2,
           kw_count = $3,
           keyword_candidates = COALESCE($4, keyword_candidates),
           fetch_status = COALESCE($5, fetch_status),
           error_message = COALESCE($6, error_message)
       WHERE id = $1
       RETURNING id, main_keyword, corrected_main_keyword, keyword, kw_count, keyword_candidates`,
      [
        row.source_analysis_id,
        recommendedKeyword,
        kwCount,
        candidates.length ? JSON.stringify(candidates) : null,
        fetchStatus,
        errorMessage,
      ]
    );
    res.json({ ok: true, recommendedKeyword, candidates, analysis: rows[0] });
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
    const tenantId = tenantIdFromReq(req);

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
    const dailyPublishByBlog = await pool.query(
      `SELECT COALESCE(NULLIF(publish_account_label, ''), NULLIF(publish_account_id::text, ''), '미지정') AS blog_label,
              COALESCE(publish_account_id::text, '') AS publish_account_id,
              COUNT(*)::int AS published_count
       FROM content_jobs
       WHERE COALESCE(tenant_id, 'owner') = $1
         AND COALESCE(publish_account_platform, platform, 'blog') = 'blog'
         AND publish_status IN ('발행완료', 'RSS확인완료', '성과추적중')
         AND published_at IS NOT NULL
         AND (published_at AT TIME ZONE 'Asia/Seoul')::date = $2::date
       GROUP BY 1, 2
       ORDER BY published_count DESC, blog_label ASC`,
      [tenantId, kstDateString()]
    );
    return res.json({
      platform,
      items: rows,
      history: history.rows,
      perBlogHistory: perBlogHistory.rows,
      dailyPublishByBlog: dailyPublishByBlog.rows,
      stats: {
        total: rows.length,
        realtimeTotalViews: rows.reduce((sum, item) => sum + Number(item.last_total_view_count || item.total_view_count || 0), 0),
        todayCurrentViews: rows.reduce((sum, item) => sum + Number(item.last_today_view_count || item.today_view_count || 0), 0),
        closedDailyViews,
        dailyViews: closedDailyViews,
        todayPublishedPosts: dailyPublishByBlog.rows.reduce((sum, item) => sum + Number(item.published_count || 0), 0),
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

router.post('/keyword-research', async (req, res) => {
  try {
    const result = await researchKeywordsFromText({
      title: req.body?.title || req.body?.topic || req.body?.keyword || '',
      text: req.body?.text || req.body?.sourceText || req.body?.description || '',
      sourceUrl: req.body?.sourceUrl || '',
      platform: normalizePlatform(req.body?.platform || 'blog', req.body?.sourceUrl),
      category: req.body?.category || 'general',
      body: req.body,
      limit: clampNumber(parseInt(req.body?.limit || '12', 10) || 12, 3, 30),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/benchmark-settings', async (req, res) => {
  try {
    const settings = await getAppSetting('benchmark_settings', {
      rssContinuousEnabled: true,
      rssDefaultPeriod: '7d',
    });
    res.json({
      rssContinuousEnabled: settings.rssContinuousEnabled !== false,
      rssDefaultPeriod: settings.rssDefaultPeriod || '7d',
      updatedAt: settings.updatedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/benchmark-settings', async (req, res) => {
  try {
    const current = await getAppSetting('benchmark_settings', {});
    const next = {
      ...current,
      rssContinuousEnabled: req.body?.rssContinuousEnabled ?? req.body?.rss_continuous_enabled ?? current.rssContinuousEnabled ?? true,
      rssDefaultPeriod: req.body?.rssDefaultPeriod || req.body?.rss_default_period || current.rssDefaultPeriod || '7d',
      updatedAt: new Date().toISOString(),
    };
    const saved = await setAppSetting('benchmark_settings', next);
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/account-slots', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const { rows } = await pool.query(
      `SELECT *
       FROM account_slots
       WHERE tenant_id = $1
       ORDER BY created_at ASC, id ASC`,
      [tenantId]
    );
    res.json({ ok: true, accounts: rows.map(publicAccountSlot) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/qr-accounts', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const { rows } = await pool.query(
      `SELECT *
       FROM account_slots
       WHERE tenant_id = $1
         AND platform = 'qr'
       ORDER BY created_at ASC, id ASC`,
      [tenantId]
    );
    const accounts = rows.map(publicAccountSlot);
    res.json({
      ok: true,
      accounts,
      totalDailyLimit: accounts.reduce((sum, account) => sum + (account.qrDailyLimit || 0), 0),
      totalUsedToday: accounts.reduce((sum, account) => sum + (account.qrUsedToday || 0), 0),
      totalRemainingToday: accounts.reduce((sum, account) => sum + (account.qrRemainingToday || 0), 0),
      usageDate: kstDateString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/account-slots', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const body = req.body || {};
    const slotId = normalizeSlotId(body.slotId || body.slot_id || body.id);
    const label = String(body.label || slotId).trim();
    const platform = normalizePlatform(body.platform || 'blog');
    const username = String(body.username || body.usernameHint || body.username_hint || '').trim();
    const targetUrl = String(body.targetUrl || body.target_url || body.memo || '').trim();
    const channelDiscovery = body.channelDiscovery || body.channel_discovery || null;
    const password = String(body.password || '');
    const qrDailyLimit = clampNumber(parseInt(body.qrDailyLimit ?? body.qr_daily_limit ?? body.dailyLimit ?? 10, 10) || 10, 1, 10);
    if (!label) return res.status(400).json({ error: 'label is required' });

    const encrypted = password ? encryptCredentialSecret(password) : null;
    const { rows } = await pool.query(
       `INSERT INTO account_slots (
          tenant_id, slot_id, platform, label, username, target_url, login_status,
          credential_mode, credential_cipher, credential_iv, credential_tag,
          credential_updated_at, memo, channel_discovery, channel_discovered_at,
          qr_daily_limit, qr_limit_status, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,'server-aes-256-gcm',$8,$9,$10,
          CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END,$11,$12::jsonb,
          CASE WHEN $12::jsonb IS NULL THEN NULL ELSE NOW() END,$13,'사용가능',NOW()
        )
       ON CONFLICT (tenant_id, slot_id) DO UPDATE SET
         platform = EXCLUDED.platform,
         label = EXCLUDED.label,
         username = COALESCE(NULLIF(EXCLUDED.username, ''), account_slots.username),
         target_url = COALESCE(NULLIF(EXCLUDED.target_url, ''), account_slots.target_url),
         login_status = EXCLUDED.login_status,
         credential_mode = 'server-aes-256-gcm',
         credential_cipher = COALESCE(EXCLUDED.credential_cipher, account_slots.credential_cipher),
         credential_iv = COALESCE(EXCLUDED.credential_iv, account_slots.credential_iv),
         credential_tag = COALESCE(EXCLUDED.credential_tag, account_slots.credential_tag),
          credential_updated_at = CASE
            WHEN EXCLUDED.credential_cipher IS NULL THEN account_slots.credential_updated_at
            ELSE NOW()
          END,
          channel_discovery = CASE
            WHEN EXCLUDED.channel_discovery IS NULL THEN account_slots.channel_discovery
            ELSE EXCLUDED.channel_discovery
          END,
          channel_discovered_at = CASE
            WHEN EXCLUDED.channel_discovery IS NULL THEN account_slots.channel_discovered_at
            ELSE NOW()
          END,
          memo = COALESCE(NULLIF(EXCLUDED.memo, ''), account_slots.memo),
          qr_daily_limit = COALESCE(EXCLUDED.qr_daily_limit, account_slots.qr_daily_limit, 10),
          updated_at = NOW()
        RETURNING *`,
      [
        tenantId,
        slotId,
        platform,
        label,
        username,
        targetUrl,
        password ? '서버 저장됨 · 인증 필요' : (body.loginStatus || body.login_status || '인증 필요'),
        encrypted?.cipher || null,
        encrypted?.iv || null,
        encrypted?.tag || null,
        targetUrl,
        channelDiscovery ? JSON.stringify(channelDiscovery) : null,
        qrDailyLimit,
      ]
    );
    res.json({ ok: true, account: publicAccountSlot(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/account-slots/:slotId/credential-status', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const slot = await loadAccountSlot({ tenantId, slotId: normalizeSlotId(req.params.slotId) });
    if (!slot) return res.status(404).json({ error: 'account slot not found' });
    res.json({
      ok: true,
      account: publicAccountSlot(slot),
      credential: {
        hasCredential: Boolean(slot.credential_cipher),
        username: slot.username || '',
        mode: slot.credential_mode || 'server-aes-256-gcm',
        updatedAt: slot.credential_updated_at || null,
        verifiedAt: slot.credential_verified_at || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/account-slots/:slotId/credentials/verify', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const slotId = normalizeSlotId(req.params.slotId);
    const slot = await loadAccountSlot({ tenantId, slotId });
    if (!slot) return res.status(404).json({ error: 'account slot not found' });
    if (!slot.credential_cipher) return res.status(404).json({ error: 'credential not found' });
    decryptCredentialSecret(slot);
    const { rows } = await pool.query(
      `UPDATE account_slots
       SET credential_verified_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND slot_id = $2
       RETURNING *`,
      [tenantId, slotId]
    );
    res.json({ ok: true, account: publicAccountSlot(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/account-slots/:slotId/credentials', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const slotId = normalizeSlotId(req.params.slotId);
    const { rows } = await pool.query(
      `UPDATE account_slots
       SET credential_cipher = NULL,
           credential_iv = NULL,
           credential_tag = NULL,
           credential_updated_at = NULL,
           credential_verified_at = NULL,
           login_status = '자격증명 삭제됨',
           updated_at = NOW()
       WHERE tenant_id = $1 AND slot_id = $2
       RETURNING *`,
      [tenantId, slotId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'account slot not found' });
    res.json({ ok: true, account: publicAccountSlot(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/account-slots/:slotId', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const { rowCount } = await pool.query(
      'DELETE FROM account_slots WHERE tenant_id = $1 AND slot_id = $2',
      [tenantId, normalizeSlotId(req.params.slotId)]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rss-sources', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '60', 10), 200);
    const { rows } = await pool.query(
      `SELECT rs.*,
              COUNT(rsi.id)::int AS item_count,
              COUNT(*) FILTER (WHERE rsi.status IN ('감지됨', '키워드 검토'))::int AS review_count
       FROM rss_sources rs
       LEFT JOIN rss_source_items rsi ON rsi.rss_source_id = rs.id
       GROUP BY rs.id
       ORDER BY rs.updated_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rss-sources/import-collected-blogs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit || req.query.limit || '300', 10), 500);
    const category = req.body?.category || req.query.category || null;
    const values = [];
    const where = ["cb.platform = 'blog'", 'cb.blog_id IS NOT NULL'];
    if (category) {
      values.push(category);
      where.push(`cb.category = $${values.length}`);
    }
    values.push(limit);
    const { rows: blogs } = await pool.query(
      `SELECT cb.*
       FROM collected_blogs cb
       WHERE ${where.join(' AND ')}
       ORDER BY cb.updated_at DESC
       LIMIT $${values.length}`,
      values
    );
    const imported = [];
    for (const blog of blogs) {
      const rssUrl = rssUrlFromCollectedBlog(blog);
      if (!rssUrl) continue;
      const label = blog.blog_nickname || blog.blog_title || blog.blog_name || blog.blog_id || rssUrl;
      const { rows } = await pool.query(
        `INSERT INTO rss_sources (label, rss_url, platform, category, collected_blog_id, continuous_monitor, status)
         VALUES ($1,$2,'blog',$3,$4,TRUE,'대기중')
         ON CONFLICT (rss_url) DO UPDATE SET
           label = COALESCE(EXCLUDED.label, rss_sources.label),
           category = EXCLUDED.category,
           collected_blog_id = EXCLUDED.collected_blog_id,
           continuous_monitor = TRUE,
           status = CASE WHEN rss_sources.status = '중지' THEN '대기중' ELSE rss_sources.status END,
           updated_at = NOW()
         RETURNING *`,
        [label, rssUrl, blog.category || 'general', blog.id]
      );
      imported.push(rows[0]);
    }
    res.json({ ok: true, sourceCount: blogs.length, imported: imported.length, sources: imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rss-sources', async (req, res) => {
  try {
    const rssUrl = normalizeRssUrl(req.body?.rssUrl || req.body?.rss_url);
    if (!rssUrl) return res.status(400).json({ error: 'rssUrl is required' });
    const platform = normalizePlatform(req.body?.platform || 'blog', rssUrl);
    const category = req.body?.category || 'general';
    const label = normalizeTitleValue(req.body?.label || req.body?.name || rssUrl);
    const { rows } = await pool.query(
      `INSERT INTO rss_sources (label, rss_url, platform, category, status)
       VALUES ($1,$2,$3,$4,'대기중')
       ON CONFLICT (rss_url) DO UPDATE SET
         label = COALESCE(EXCLUDED.label, rss_sources.label),
         platform = EXCLUDED.platform,
         category = EXCLUDED.category,
         updated_at = NOW()
       RETURNING *`,
      [label, rssUrl, platform, category]
    );
    res.json({ ok: true, source: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/rss-sources/:id', async (req, res) => {
  try {
    const status = req.body?.status || null;
    const continuousMonitor = req.body?.continuousMonitor ?? req.body?.continuous_monitor ?? null;
    const { rows } = await pool.query(
      `UPDATE rss_sources
       SET status = COALESCE($2, status),
           continuous_monitor = COALESCE($3::boolean, continuous_monitor),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, status, continuousMonitor]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'RSS source not found' });
    res.json({ ok: true, source: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function checkRssSourceNow(source, { body = {}, limit = 20 } = {}) {
  try {
    const response = await fetch(source.rss_url, {
      headers: {
        'User-Agent': 'NaviWrite/1.0 RSS monitor',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`RSS fetch failed (${response.status})`);
    const items = parseRssItems(await response.text()).slice(0, clampNumber(parseInt(limit || '20', 10) || 20, 1, 50));
    const saved = [];
    let latestPublishedAt = source.last_item_published_at;

    for (const item of items) {
      if (!item.link) continue;
      const research = await researchKeywordsFromText({
        title: item.title,
        text: item.description,
        sourceUrl: item.link,
        platform: source.platform,
        category: source.category,
        body,
        limit: 10,
      });
      const mainKeyword = research.mainKeyword || '';
      const topCandidate = research.candidates[0] || {};
      const volume = topCandidate.searchVolume ?? null;
      const band = keywordVolumeBand(volume);
      const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;
      if (publishedAt && (!latestPublishedAt || new Date(publishedAt) > new Date(latestPublishedAt))) {
        latestPublishedAt = publishedAt;
      }
      const { rows } = await pool.query(
        `INSERT INTO rss_source_items (
           rss_source_id, guid, title, link, description, published_at,
           platform, category, main_keyword, selected_keyword, keyword_candidates,
           autocomplete_keywords, search_volume, volume_band, status
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'키워드 검토')
         ON CONFLICT (link) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           published_at = EXCLUDED.published_at,
            main_keyword = EXCLUDED.main_keyword,
            selected_keyword = COALESCE(rss_source_items.selected_keyword, EXCLUDED.selected_keyword),
           keyword_candidates = EXCLUDED.keyword_candidates,
           autocomplete_keywords = EXCLUDED.autocomplete_keywords,
           search_volume = EXCLUDED.search_volume,
           volume_band = EXCLUDED.volume_band,
           status = CASE
             WHEN rss_source_items.rewrite_job_id IS NOT NULL THEN rss_source_items.status
             ELSE '키워드 검토'
           END,
           updated_at = NOW()
         RETURNING *`,
        [
          source.id,
          item.guid || item.link,
          item.title,
          item.link,
          item.description,
          publishedAt,
          source.platform,
          source.category,
          mainKeyword,
          mainKeyword,
          JSON.stringify(research.candidates),
          JSON.stringify(research.autocompleteKeywords || []),
          volume,
          band.key,
        ]
      );
      saved.push(rows[0]);
    }

    const updated = await pool.query(
      `UPDATE rss_sources
       SET status = '확인완료',
           last_checked_at = NOW(),
           last_item_published_at = COALESCE($2::timestamptz, last_item_published_at),
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [source.id, latestPublishedAt]
    );

    return { ok: true, source: updated.rows[0], detected: saved.length, items: saved };
  } catch (err) {
    await pool.query(
      `UPDATE rss_sources SET status = '오류', error_message = $2, updated_at = NOW() WHERE id = $1`,
      [source.id, err.message]
    ).catch(() => null);
    throw err;
  }
}

async function checkRssSourceById(sourceId, options = {}) {
  const sourceResult = await pool.query('SELECT * FROM rss_sources WHERE id = $1', [sourceId]);
  if (sourceResult.rows.length === 0) {
    const err = new Error('RSS source not found');
    err.statusCode = 404;
    throw err;
  }
  return checkRssSourceNow(sourceResult.rows[0], options);
}

async function checkDueRssSources({ maxSources = 12, limit = 20 } = {}) {
  const settings = await getAppSetting('benchmark_settings', { rssContinuousEnabled: true });
  if (settings.rssContinuousEnabled === false) return [];
  const intervalMinutes = clampNumber(parseInt(process.env.RSS_CHECK_INTERVAL_MINUTES || '60', 10) || 60, 5, 1440);
  const { rows: sources } = await pool.query(
    `SELECT *
     FROM rss_sources
     WHERE status <> '중지'
       AND COALESCE(continuous_monitor, TRUE) = TRUE
       AND (
         last_checked_at IS NULL
         OR last_checked_at < NOW() - ($1::int * INTERVAL '1 minute')
       )
     ORDER BY last_checked_at ASC NULLS FIRST, updated_at ASC
     LIMIT $2`,
    [intervalMinutes, maxSources]
  );
  const results = [];
  for (const source of sources) {
    try {
      results.push(await checkRssSourceNow(source, { body: {}, limit }));
    } catch (err) {
      results.push({ ok: false, sourceId: source.id, error: err.message });
    }
  }
  return results;
}

router.post('/rss-sources/:id/check', async (req, res) => {
  try {
    const result = await checkRssSourceById(req.params.id, {
      body: req.body || {},
      limit: req.body?.limit || 20,
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/rss-items', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '120', 10), 300);
    const values = [];
    const where = [];
    const dateExpr = 'COALESCE(rsi.published_at, rsi.detected_at)';
    if (req.query.volumeBand) {
      values.push(req.query.volumeBand);
      where.push(`rsi.volume_band = $${values.length}`);
    }
    if (req.query.status) {
      values.push(req.query.status);
      where.push(`rsi.status = $${values.length}`);
    }
    if (req.query.checkedForPublish === 'true' || req.query.checked_for_publish === 'true') {
      where.push('rsi.checked_for_publish = TRUE');
    }
    if (req.query.rssSourceId || req.query.sourceId) {
      const sourceId = parseInt(req.query.rssSourceId || req.query.sourceId, 10);
      if (Number.isFinite(sourceId)) {
        values.push(sourceId);
        where.push(`rsi.rss_source_id = $${values.length}`);
      }
    }
    if (req.query.days) {
      values.push(clampNumber(parseInt(req.query.days, 10) || 7, 1, 365));
      where.push(`${dateExpr} >= NOW() - ($${values.length}::int * INTERVAL '1 day')`);
    }
    if (req.query.dateFrom) {
      values.push(req.query.dateFrom);
      where.push(`${dateExpr} >= $${values.length}::timestamptz`);
    }
    if (req.query.dateTo) {
      values.push(req.query.dateTo);
      where.push(`${dateExpr} < ($${values.length}::date + INTERVAL '1 day')`);
    }
    values.push(limit);
    const { rows } = await pool.query(
      `SELECT rsi.*, rs.label AS rss_label, rs.rss_url, rs.platform AS rss_platform, rs.category AS rss_category,
              cb.blog_name AS source_blog_name, cb.blog_title AS source_blog_title,
              cb.blog_nickname AS source_blog_nickname, cb.blog_id AS source_blog_id
       FROM rss_source_items rsi
       JOIN rss_sources rs ON rs.id = rsi.rss_source_id
       LEFT JOIN collected_blogs cb ON cb.id = rs.collected_blog_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rsi.published_at DESC NULLS LAST, rsi.detected_at DESC
       LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/rss-items/:id', async (req, res) => {
  try {
    const selectedKeyword = normalizeKeywordValue(req.body?.selectedKeyword || req.body?.selected_keyword || '');
    const checkedForPublish = Boolean(req.body?.checkedForPublish ?? req.body?.checked_for_publish);
    const { rows } = await pool.query(
      `UPDATE rss_source_items
       SET selected_keyword = COALESCE(NULLIF($2, ''), selected_keyword),
           checked_for_publish = $3,
           status = CASE WHEN $3 THEN '발행 생성 대기' ELSE status END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, selectedKeyword, checkedForPublish]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'RSS item not found' });
    res.json({ ok: true, item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rss-items/:id/research', async (req, res) => {
  try {
    const itemResult = await pool.query('SELECT * FROM rss_source_items WHERE id = $1', [req.params.id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'RSS item not found' });
    const item = itemResult.rows[0];
    const research = await researchKeywordsFromText({
      title: item.title,
      text: item.description,
      sourceUrl: item.link,
      platform: item.platform,
      category: item.category,
      body: req.body || {},
      limit: 12,
    });
    const topCandidate = research.candidates[0] || {};
    const band = keywordVolumeBand(topCandidate.searchVolume);
    const { rows } = await pool.query(
      `UPDATE rss_source_items
       SET main_keyword = $2,
           selected_keyword = COALESCE(selected_keyword, $2),
           keyword_candidates = $3,
           autocomplete_keywords = $4,
           search_volume = $5,
           volume_band = $6,
           status = '키워드 검토',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        item.id,
        research.mainKeyword,
        JSON.stringify(research.candidates),
        JSON.stringify(research.autocompleteKeywords || []),
        topCandidate.searchVolume ?? null,
        band.key,
      ]
    );
    res.json({ ok: true, item: rows[0], research });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rss-items/to-rewrite-jobs', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const ids = normalizeIdList(req.body?.itemIds || req.body?.rssItemIds);
    if (ids.length === 0) return res.status(400).json({ error: 'itemIds is required' });
    const researchCredentials = naverSearchCredentials(req.body);
    const { rows: items } = await pool.query(
      `SELECT *
       FROM rss_source_items
       WHERE id = ANY($1::int[])
       ORDER BY array_position($1::int[], id)`,
      [ids]
    );
    if (items.length === 0) return res.status(404).json({ error: 'RSS items not found' });

    const settings = parseRewriteSettings(req.body?.rewriteSettings || {});
    const asyncProcess = req.body?.asyncProcess !== false && req.body?.processInline !== true;
    const inserted = [];
    for (const item of items) {
      const keyword = normalizeKeywordValue(item.selected_keyword || item.main_keyword);
      if (!keyword) continue;
      const { rows } = await pool.query(
        `INSERT INTO rewrite_jobs (
          target_keyword, target_topic, platform, category, cta_url,
          use_naver_qr, use_ai_images, source_analysis_ids, settings_json,
          custom_title, status, source_kind, source_item_id, publish_spec
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,'[]',$8,$9,'대기중','rss',$10,$11)
        RETURNING *`,
        [
          keyword,
          `${item.title || ''}\n${item.description || ''}`.trim(),
          normalizePlatform(req.body?.platform || item.platform || 'blog', item.link),
          req.body?.category || item.category || 'general',
          req.body?.ctaUrl || req.body?.cta_url || null,
          Boolean(req.body?.useNaverQr ?? true),
          Boolean(req.body?.useAiImages ?? true),
          JSON.stringify(settings),
          normalizeTitleValue(req.body?.customTitle || ''),
          item.id,
          JSON.stringify(buildPublishSpec(normalizePlatform(req.body?.platform || item.platform || 'blog', item.link), settings)),
        ]
      );
      if (asyncProcess) {
        await pool.query(
          `UPDATE rss_source_items
           SET rewrite_job_id = $2,
               status = '발행 생성 중',
               checked_for_publish = TRUE,
               updated_at = NOW()
           WHERE id = $1`,
          [item.id, rows[0].id]
        );
        inserted.push(rows[0]);
        continue;
      }

      const processed = await processRewriteJob(rows[0].id, { tenantId, researchCredentials });
      await pool.query(
        `UPDATE rss_source_items
         SET rewrite_job_id = $2,
             status = $3,
             checked_for_publish = TRUE,
             updated_at = NOW()
         WHERE id = $1`,
        [item.id, processed.id, processed.status === '오류' ? '오류' : '발행 생성 완료']
      );
      inserted.push(processed);
    }
    if (asyncProcess) {
      processRewriteJobsInBackground(inserted, { tenantId, researchCredentials, concurrency: req.body?.concurrency || 3 });
      return res.json({
        ok: true,
        created: inserted.length,
        queued: inserted.length,
        processed: 0,
        processingMode: 'background',
        jobs: inserted.map(attachRewriteMetricSummary),
      });
    }
    res.json({ ok: true, created: inserted.length, jobs: inserted });
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

router.post('/keyword-recommendations', async (req, res) => {
  try {
    const directKeywordMode = Boolean(req.body?.directKeywordMode || req.body?.direct_keyword_mode || req.body?.mode === 'direct');
    const sourceAnalysisIds = directKeywordMode ? [] : normalizeIdList(req.body?.sourceAnalysisIds);
    const sourceLinkIds = directKeywordMode ? [] : normalizeIdList(req.body?.sourceLinkIds);
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

    const sourceUrl = String(req.body?.sourceUrl || req.body?.source_url || '').trim();
    const sourceText = String(req.body?.sourceText || req.body?.source_text || '').trim();
    const topic = normalizeTitleValue(req.body?.topic || req.body?.targetTopic || '');
    const platform = normalizePlatform(req.body?.platform || analyses[0]?.platform_guess || analyses[0]?.platform || 'blog', sourceUrl);
    const category = req.body?.category || analyses[0]?.category_guess || analyses[0]?.category || 'general';
    const title = normalizeTitleValue(req.body?.title || topic || analyses[0]?.title || '');

    const candidateMap = new Map();
    const addCandidate = (keyword, score = 0, source = '', extra = {}) => {
      const normalized = normalizeKeywordValue(keyword);
      if (!normalized || normalized.replace(/\s/g, '').length < 2) return;
      const key = normalized.replace(/\s/g, '').toLowerCase();
      const current = candidateMap.get(key) || {
        keyword: normalized,
        score: 0,
        count: 0,
        sources: new Set(),
        category,
      };
      current.score += Number(score || 0);
      current.count += Number(extra.count || 0);
      current.searchTotal = extra.searchTotal ?? current.searchTotal;
      current.serpTopTitles = extra.serpTopTitles || current.serpTopTitles || [];
      current.verificationScore = Number(extra.verificationScore || current.verificationScore || 0);
      if (source) current.sources.add(source);
      candidateMap.set(key, current);
    };

    if (directKeywordMode && topic) {
      keywordVariantSeeds(topic).forEach((keyword, index) => {
        addCandidate(keyword, index === 0 ? 96 : 72 - index * 4, index === 0 ? 'direct_seed' : 'direct_variant');
      });
    }

    if (!directKeywordMode) analyses.forEach((row) => {
      addCandidate(row.corrected_main_keyword || row.main_keyword || row.keyword, 22, 'saved_main_keyword', { count: row.kw_count || 0 });
      parseJsonArray(row.keyword_candidates).forEach((item) => {
        addCandidate(item.keyword || item.term, Number(item.score || 0) * 0.45 + 8, 'saved_candidate', { count: item.count || 0 });
      });
    });

    if (sourceUrl) {
      let html = '';
      let mobileHtml = '';
      let blogHomeHtml = '';
      try {
        html = await fetchSourceHtml(sourceUrl);
        mobileHtml = await fetchNaverMobileHtml(sourceUrl);
        blogHomeHtml = await fetchNaverBlogHomeHtml(sourceUrl);
      } catch {
        // Keyword recommendation can still continue with topic/text input.
      }
      if (html || mobileHtml) {
        const analysis = buildSourceAnalysis({
          sourceUrl,
          sourceText: '',
          html: mobileHtml || html,
          mobileHtml,
          blogHomeHtml,
          category,
          platform,
          fetchStatus: 'keyword_recommendation',
          errorMessage: null,
        });
        addCandidate(analysis.mainKeyword, 28, 'url_main_keyword', { count: analysis.kwCount || 0 });
        analysis.keywordCandidates.forEach((item) => {
          addCandidate(item.keyword, Number(item.score || 0) * 0.5 + 10, item.sources?.[0] || 'url_candidate', { count: item.count || 0 });
        });
      }
    }

    const combinedText = [
      topic,
      sourceText,
      analyses.map((row) => `${row.title || ''}\n${row.plain_text || ''}`).join('\n'),
    ].join('\n');
    if (combinedText.trim() || title) {
      inferKeywordCandidates({
        title,
        text: combinedText,
        subheadings: [],
        keywordSignals: [],
      }).forEach((item) => {
        addCandidate(item.keyword, Number(item.score || 0) * 0.55 + 6, 'text_or_topic', { count: item.count || 0 });
      });
    }

    const credentials = naverSearchCredentials(req.body);
    let hasNaverSearch = Boolean(credentials);
    let naverWarning = '';
    if (directKeywordMode && topic && credentials) {
      try {
        const seedSearch = await fetchNaverSearchResults({ query: topic, platform, credentials, display: 10 });
        addCandidate(topic, Math.min(32, Math.log10(Number(seedSearch.total || 0) + 1) * 5), 'naver_search_seed', {
          searchTotal: seedSearch.total,
          serpTopTitles: seedSearch.items.map((item) => item.title).filter(Boolean).slice(0, 5),
        });
        inferKeywordCandidates({
          title: topic,
          text: seedSearch.items.map((item) => `${item.title}\n${item.description}`).join('\n'),
          subheadings: [],
          keywordSignals: [],
        }).forEach((item) => {
          const keyword = normalizeKeywordValue(item.keyword);
          const compactTopic = topic.replace(/\s/g, '').toLowerCase();
          const compactKeyword = keyword.replace(/\s/g, '').toLowerCase();
          const isRelated = compactKeyword.includes(compactTopic.slice(0, Math.min(compactTopic.length, 4)))
            || compactTopic.includes(compactKeyword.slice(0, Math.min(compactKeyword.length, 4)))
            || TITLE_RECOMMENDATION_ACTIONS.some((term) => keyword.includes(term));
          if (isRelated) addCandidate(keyword, Number(item.score || 0) * 0.38 + 10, 'naver_search_related', { count: item.count || 0 });
        });
      } catch (err) {
        hasNaverSearch = false;
        naverWarning = err.message;
      }
    }
    const candidates = [...candidateMap.values()]
      .map((item) => ({
        ...item,
        sources: [...item.sources],
        score: Number(item.score.toFixed(2)),
        wordCount: item.keyword.split(/\s+/).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, clampNumber(parseInt(req.body?.limit || '10', 10) || 10, 3, 20));
    const compoundCompacts = candidates
      .filter((item) => item.wordCount >= 2)
      .map((item) => item.keyword.replace(/\s/g, '').toLowerCase());
    const broadSingleTerms = new Set(['신청', '지원', '대상', '방법', '기준', '결과', '링크', '유형', '후기', '예약', '정리', '확인', '비교', '500만원', '지원금', '테스트', '소상공인']);
    candidates.forEach((candidate) => {
      const compact = candidate.keyword.replace(/\s/g, '').toLowerCase();
      const includedInCompound = candidate.wordCount === 1 && compoundCompacts.some((compound) => compound.includes(compact));
      if (includedInCompound) candidate.score = Number((candidate.score - 70).toFixed(2));
      if (broadSingleTerms.has(candidate.keyword)) candidate.score = Number((candidate.score - 45).toFixed(2));
    });
    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates.slice(0, 8)) {
      if (!credentials || !hasNaverSearch) break;
      try {
        const search = await fetchNaverSearchResults({ query: candidate.keyword, platform, credentials, display: 5 });
        const compact = candidate.keyword.replace(/\s/g, '').toLowerCase();
        const topTitleHits = search.items.filter((item) => stripHtml(item.title || '').replace(/\s/g, '').toLowerCase().includes(compact)).length;
        const rawSearchScore = search.total === null ? 0 : Math.min(24, Math.log10(Number(search.total || 0) + 1) * 4);
        const searchScore = candidate.wordCount <= 1 ? rawSearchScore * 0.25 : rawSearchScore;
        candidate.searchTotal = search.total;
        candidate.serpTopTitles = search.items.map((item) => item.title).filter(Boolean).slice(0, 5);
        candidate.verificationScore = Number((searchScore + topTitleHits * 4).toFixed(2));
        candidate.score = Number((candidate.score + candidate.verificationScore).toFixed(2));
        candidate.sources.push('naver_search_verified');
      } catch (err) {
        hasNaverSearch = false;
        naverWarning = err.message;
      }
    }

    const actionTerms = ['신청', '방법', '대상', '조건', '지급일', '링크', '예약', '결과', '유형'];
    const signalActionCompounds = candidates
      .filter((item) => item.wordCount >= 2 && item.sources.some((sourceName) => /naver|signal/i.test(sourceName)) && actionTerms.some((term) => item.keyword.includes(term)))
      .map((item) => item.keyword.replace(/\s/g, '').toLowerCase());
    candidates.forEach((candidate) => {
      const compact = candidate.keyword.replace(/\s/g, '').toLowerCase();
      const hasAction = actionTerms.some((term) => candidate.keyword.includes(term));
      const fromNaverSignal = candidate.sources.some((sourceName) => /naver_tag|naver_recommendation/i.test(sourceName));
      const shorterThanSignalAction = candidate.wordCount < 3 && signalActionCompounds.some((compound) => compound !== compact && compound.includes(compact));
      if (hasAction && candidate.wordCount >= 2) candidate.score = Number((candidate.score + 18).toFixed(2));
      if (fromNaverSignal) candidate.score = Number((candidate.score + 18).toFixed(2));
      if (shorterThanSignalAction) candidate.score = Number((candidate.score - 34).toFixed(2));
    });

    candidates.sort((a, b) => b.score - a.score || (b.searchTotal || 0) - (a.searchTotal || 0));
    const enriched = await enrichKeywordCandidates(candidates, {
      body: req.body,
      seedQuery: topic || title || candidates[0]?.keyword || '',
      limit: clampNumber(parseInt(req.body?.limit || '10', 10) || 10, 3, 20),
    });
    const rankedCandidates = rankKeywordRecommendations(enriched.candidates, {
      seedQuery: topic || title,
      hasKeywordTool: enriched.hasKeywordTool,
    });

    res.json({
      ok: true,
      topic,
      platform,
      category,
      hasNaverSearch,
      naverWarning,
      hasKeywordTool: enriched.hasKeywordTool,
      keywordToolWarning: enriched.keywordToolWarning,
      autocompleteKeywords: enriched.autocompleteKeywords,
      candidates: rankedCandidates.map((candidate) => ({
        ...candidate,
        suggestedTitles: generateTitleCandidates({
          keyword: candidate.keyword,
          topic,
          platform,
          category,
          analyses,
          keywordSignals: enriched.autocompleteKeywords || [],
        }).slice(0, 3),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/content-skills', async (req, res) => {
  res.json({
    defaultSkillKey: DEFAULT_REWRITE_SETTINGS.contentSkillKey,
    skills: Object.values(CONTENT_SKILLS),
  });
});

router.get('/openai/settings', async (req, res) => {
  try {
    const settings = await getOpenAiSettings(tenantIdFromReq(req));
    res.json({ ok: true, settings: publicOpenAiSettings(settings), models: Object.keys(OPENAI_PRICING_USD_PER_1M) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/openai/settings', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const current = await getAppSetting(openAiSettingKey(tenantId), {});
    const apiKey = String(req.body?.apiKey || req.body?.api_key || '').trim();
    let encrypted = null;
    if (apiKey) encrypted = encryptCredentialSecret(apiKey);
    const value = {
      ...current,
      model: normalizeOpenAiModel(req.body?.model || current.model || DEFAULT_REWRITE_SETTINGS.openaiModel),
      monthlyBudgetUsd: Number(req.body?.monthlyBudgetUsd ?? req.body?.monthly_budget_usd ?? current.monthlyBudgetUsd ?? 20) || 20,
      updatedAt: new Date().toISOString(),
    };
    if (encrypted) {
      value.apiKeyCipher = encrypted.cipher;
      value.apiKeyIv = encrypted.iv;
      value.apiKeyTag = encrypted.tag;
      value.apiKeyUpdatedAt = new Date().toISOString();
    }
    await setAppSetting(openAiSettingKey(tenantId), value);
    const settings = await getOpenAiSettings(tenantId);
    res.json({ ok: true, settings: publicOpenAiSettings(settings) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/openai/estimate', async (req, res) => {
  try {
    const settings = await getOpenAiSettings(tenantIdFromReq(req));
    const usage = estimateRewriteOpenAiUsage({
      model: req.body?.model || settings.model,
      count: req.body?.count || 1,
      targetCharCount: req.body?.targetCharCount || req.body?.target_char_count || DEFAULT_REWRITE_SETTINGS.targetCharCount,
      sourceCount: req.body?.sourceCount || req.body?.source_count || 0,
      sectionCount: req.body?.sectionCount || req.body?.section_count || DEFAULT_REWRITE_SETTINGS.sectionCount,
    });
    const exchangeRate = await getUsdKrwRateForDate(kstDateString());
    const usdKrwRate = Number(exchangeRate?.rate || 0);
    res.json({
      ok: true,
      estimate: {
        ...usage,
        estimatedCostKrw: Number((Number(usage.estimatedCostUsd || 0) * usdKrwRate).toFixed(2)),
        usdKrwRate,
        exchangeRateDate: exchangeRate?.rate_date || kstDateString(),
        exchangeRateSourceDate: exchangeRate?.source_date || exchangeRate?.rate_date || kstDateString(),
        exchangeRateSource: exchangeRate?.source || '',
        exchangeRateIsFallback: Boolean(exchangeRate?.is_fallback),
      },
      pricing: openAiPricingFor(usage.model),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/exchange-rate/usd-krw', async (req, res) => {
  try {
    const rateDate = normalizeOptionalDate(req.query.date)?.slice(0, 10) || kstDateString();
    const exchangeRate = await getUsdKrwRateForDate(rateDate, { refresh: req.query.refresh === '1' || req.query.refresh === 'true' });
    res.json({
      ok: true,
      rateDate: exchangeRate?.rate_date || rateDate,
      sourceDate: exchangeRate?.source_date || rateDate,
      usdKrwRate: Number(exchangeRate?.rate || 0),
      rateType: 'deal_bas_r',
      source: exchangeRate?.source || '',
      isFallback: Boolean(exchangeRate?.is_fallback),
      fetchedAt: exchangeRate?.fetched_at || null,
      note: '네이버 금융 USD/KRW 매매기준율을 우선 사용합니다. 별도 환율 API 키는 필요하지 않습니다.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/openai/usage-summary-v2', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const settings = await getOpenAiSettings(tenantId);
    const exchangeRate = await getUsdKrwRateForDate(kstDateString());
    const usdKrwRate = Number(exchangeRate?.rate || 0);
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date), 0)::float AS today_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::float AS seven_days_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float AS thirty_days_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Seoul') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')), 0)::float AS month_usd,
         COALESCE(SUM(COALESCE(NULLIF(estimated_cost_krw, 0), estimated_cost_usd * $2)) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date), 0)::float AS today_krw,
         COALESCE(SUM(COALESCE(NULLIF(estimated_cost_krw, 0), estimated_cost_usd * $2)) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::float AS seven_days_krw,
         COALESCE(SUM(COALESCE(NULLIF(estimated_cost_krw, 0), estimated_cost_usd * $2)) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float AS thirty_days_krw,
         COALESCE(SUM(COALESCE(NULLIF(estimated_cost_krw, 0), estimated_cost_usd * $2)) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Seoul') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')), 0)::float AS month_krw,
         COALESCE(SUM(prompt_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::int AS thirty_days_prompt_tokens,
         COALESCE(SUM(completion_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::int AS thirty_days_completion_tokens,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS thirty_days_requests
       FROM openai_usage_logs
       WHERE tenant_id = $1`,
      [tenantId, usdKrwRate]
    );
    const daily = await pool.query(
      `SELECT
         to_char((created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS usage_date,
         COALESCE(SUM(estimated_cost_usd), 0)::float AS cost_usd,
         COALESCE(SUM(COALESCE(NULLIF(estimated_cost_krw, 0), estimated_cost_usd * $2)), 0)::float AS cost_krw,
         COUNT(*)::int AS request_count
       FROM openai_usage_logs
       WHERE tenant_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [tenantId, usdKrwRate]
    );
    const usage = rows[0] || {};
    const monthlyBudgetUsd = settings.monthlyBudgetUsd;
    const remainingBudgetUsd = Number((monthlyBudgetUsd - Number(usage.month_usd || 0)).toFixed(6));
    const remainingBudgetKrw = Number((remainingBudgetUsd * usdKrwRate).toFixed(2));
    res.json({
      ok: true,
      summaryVersion: 'krw-nullif-2026-05-06',
      settings: publicOpenAiSettings(settings),
      usage: {
        todayUsd: Number(usage.today_usd || 0),
        sevenDaysUsd: Number(usage.seven_days_usd || 0),
        thirtyDaysUsd: Number(usage.thirty_days_usd || 0),
        monthUsd: Number(usage.month_usd || 0),
        todayKrw: Number(usage.today_krw || 0),
        sevenDaysKrw: Number(usage.seven_days_krw || 0),
        thirtyDaysKrw: Number(usage.thirty_days_krw || 0),
        monthKrw: Number(usage.month_krw || 0),
        remainingBudgetUsd,
        remainingBudgetKrw,
        thirtyDaysPromptTokens: usage.thirty_days_prompt_tokens || 0,
        thirtyDaysCompletionTokens: usage.thirty_days_completion_tokens || 0,
        thirtyDaysRequests: usage.thirty_days_requests || 0,
      },
      exchangeRate: {
        rateDate: exchangeRate?.rate_date || kstDateString(),
        sourceDate: exchangeRate?.source_date || exchangeRate?.rate_date || kstDateString(),
        usdKrwRate,
        rateType: 'deal_bas_r',
        source: exchangeRate?.source || '',
        isFallback: Boolean(exchangeRate?.is_fallback),
      },
      dailyCosts: daily.rows.map((row) => ({
        date: String(row.usage_date).slice(0, 10),
        costUsd: Number(row.cost_usd || 0),
        costKrw: Number(row.cost_krw || 0),
        requestCount: Number(row.request_count || 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/openai/usage-summary', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const settings = await getOpenAiSettings(tenantId);
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date), 0)::float AS today_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::float AS seven_days_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float AS thirty_days_usd,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Seoul') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')), 0)::float AS month_usd,
         COALESCE(SUM(prompt_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::int AS thirty_days_prompt_tokens,
         COALESCE(SUM(completion_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::int AS thirty_days_completion_tokens,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS thirty_days_requests
       FROM openai_usage_logs
       WHERE tenant_id = $1`,
      [tenantId]
    );
    const usage = rows[0] || {};
    const monthlyBudgetUsd = settings.monthlyBudgetUsd;
    const remainingBudgetUsd = Number((monthlyBudgetUsd - Number(usage.month_usd || 0)).toFixed(6));
    res.json({
      ok: true,
      settings: publicOpenAiSettings(settings),
      usage: {
        todayUsd: Number(usage.today_usd || 0),
        sevenDaysUsd: Number(usage.seven_days_usd || 0),
        thirtyDaysUsd: Number(usage.thirty_days_usd || 0),
        monthUsd: Number(usage.month_usd || 0),
        remainingBudgetUsd,
        thirtyDaysPromptTokens: usage.thirty_days_prompt_tokens || 0,
        thirtyDaysCompletionTokens: usage.thirty_days_completion_tokens || 0,
        thirtyDaysRequests: usage.thirty_days_requests || 0,
      },
      note: '남은 금액은 OpenAI 실제 계정 잔액이 아니라 사이트에 설정한 월 예산에서 NaviWrite가 기록한 사용액을 뺀 추정값입니다.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/title-recommendations', async (req, res) => {
  try {
    const directKeywordMode = Boolean(req.body?.directKeywordMode || req.body?.direct_keyword_mode || req.body?.mode === 'direct');
    const sourceAnalysisIds = directKeywordMode ? [] : normalizeIdList(req.body?.sourceAnalysisIds);
    const sourceLinkIds = directKeywordMode ? [] : normalizeIdList(req.body?.sourceLinkIds);
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
    let autocompleteKeywords = [];
    let keywordToolWarning = '';
    let keywordVolumeRows = [];

    if (credentials) {
      try {
        baseSearch = await fetchNaverSearchResults({ query: keyword, platform, credentials, display: 10 });
      } catch (err) {
        hasNaverSearch = false;
        naverWarning = err.message;
      }
    }

    try {
      autocompleteKeywords = await fetchNaverAutocompleteKeywords(keyword);
    } catch {
      autocompleteKeywords = [];
    }

    const keywordToolCredentials = naverKeywordToolCredentials(req.body);
    if (keywordToolCredentials) {
      try {
        const volumeMap = await fetchNaverKeywordVolumes([keyword, ...autocompleteKeywords.slice(0, 12)], keywordToolCredentials);
        keywordVolumeRows = [...volumeMap.values()]
          .filter((row) => row.keyword)
          .sort((a, b) => Number(b.searchVolume || 0) - Number(a.searchVolume || 0))
          .slice(0, 12);
      } catch (err) {
        keywordToolWarning = err.message;
      }
    }

    const baseSerpTitles = baseSearch.items.map((item) => item.title).filter(Boolean);
    const keywordSignals = [
      ...keywordVolumeRows.map((row) => row.keyword),
      ...autocompleteKeywords,
    ];
    const candidates = generateTitleCandidates({ keyword, topic, platform, category, analyses, keywordSignals })
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
        actionTerms: [...new Set([...sourceActionTerms, ...titleRecommendationActions(keywordSignals.join(' '))])],
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
      hasKeywordTool: Boolean(keywordToolCredentials && !keywordToolWarning),
      keywordToolWarning,
      autocompleteKeywords,
      keywordVolumeRows,
      sourceActionTerms,
      serpTopTerms: titleRecommendationActions(baseSerpTitles.join(' ')),
      candidates: scored,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cta-links', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const query = normalizeKeywordValue(req.query.query || req.query.q || '');
    const terms = query
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 8);
    const { rows } = await pool.query(
      `SELECT *
       FROM (
         SELECT 'rewrite' AS source_type,
                id,
                target_keyword AS keyword,
                title,
                platform,
                category,
                cta_url,
                qr_target_url,
                naver_qr_short_url,
                naver_qr_manage_url,
                naver_qr_name,
                qr_account_id,
                updated_at
         FROM rewrite_jobs
         WHERE COALESCE(cta_url, qr_target_url, naver_qr_short_url, '') <> ''
         UNION ALL
         SELECT 'content' AS source_type,
                id,
                keyword,
                title,
                platform,
                category,
                cta_url,
                qr_target_url,
                naver_qr_short_url,
                naver_qr_manage_url,
                naver_qr_name,
                qr_account_id,
                updated_at
         FROM content_jobs
         WHERE tenant_id = $1
           AND COALESCE(cta_url, qr_target_url, naver_qr_short_url, '') <> ''
       ) links
       ORDER BY updated_at DESC
       LIMIT 200`,
      [tenantId]
    );
    const scored = rows
      .map((row) => {
        const haystack = [
          row.keyword,
          row.title,
          row.category,
          row.platform,
          row.cta_url,
          row.qr_target_url,
          row.naver_qr_short_url,
          row.naver_qr_name,
        ].join(' ').toLowerCase();
        const score = terms.length
          ? terms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0)
          : 1;
        return { row, score };
      })
      .filter((item) => item.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score || new Date(b.row.updated_at) - new Date(a.row.updated_at))
      .slice(0, 30)
      .map(({ row, score }) => ({
        id: `${row.source_type}:${row.id}`,
        sourceType: row.source_type,
        sourceId: row.id,
        keyword: row.keyword,
        title: row.title,
        platform: row.platform,
        category: row.category,
        url: row.cta_url || row.qr_target_url || row.naver_qr_short_url,
        ctaUrl: row.cta_url,
        qrTargetUrl: row.qr_target_url,
        shortUrl: row.naver_qr_short_url,
        manageUrl: row.naver_qr_manage_url,
        qrName: row.naver_qr_name,
        qrAccountId: row.qr_account_id,
        updatedAt: row.updated_at,
        score,
      }));
    res.json({ ok: true, query, results: scored });
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
    res.json(rows.map(attachRewriteMetricSummary));
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
    res.json({ ...attachRewriteMetricSummary(job.rows[0]), events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/rewrite-jobs/:id', async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });

    const hasCta = Object.prototype.hasOwnProperty.call(req.body || {}, 'ctaUrl')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'cta_url');
    const hasQrTarget = Object.prototype.hasOwnProperty.call(req.body || {}, 'qrTargetUrl')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'qr_target_url');
    const hasUseNaverQr = Object.prototype.hasOwnProperty.call(req.body || {}, 'useNaverQr')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'use_naver_qr');
    const ctaUrl = hasCta ? (req.body.ctaUrl ?? req.body.cta_url ?? null) : current.rows[0].cta_url;
    const qrTargetUrl = hasQrTarget
      ? (req.body.qrTargetUrl ?? req.body.qr_target_url ?? null)
      : (hasCta ? ctaUrl : current.rows[0].qr_target_url);
    const useNaverQr = hasUseNaverQr
      ? Boolean(req.body.useNaverQr ?? req.body.use_naver_qr)
      : Boolean(current.rows[0].use_naver_qr);
    const qrStatus = useNaverQr
      ? (current.rows[0].naver_qr_short_url ? 'QR 생성 완료' : 'QR 생성 필요')
      : 'QR 미사용';

    const { rows } = await pool.query(
      `UPDATE rewrite_jobs
       SET cta_url = $2,
           qr_target_url = $3,
           use_naver_qr = $4,
           qr_status = $5,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, ctaUrl || null, qrTargetUrl || null, useNaverQr, qrStatus]
    );
    await addRewriteEvent(req.params.id, 'cta_updated', 'CTA link updated', {
      ctaUrl: ctaUrl || null,
      qrTargetUrl: qrTargetUrl || null,
      useNaverQr,
      qrStatus,
    });
    res.json({ ok: true, job: attachRewriteMetricSummary(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const researchCredentials = naverSearchCredentials(req.body);
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
    if (keywords.length === 0) return res.status(400).json({ error: '발행 생성할 키워드를 입력하거나 수집완료 링크를 선택해 주세요' });

    const platform = normalizePlatform(req.body?.platform || 'blog');
    const category = req.body?.category || 'general';
    const targetTopic = req.body?.targetTopic || req.body?.topic || '';
    const ctaUrl = req.body?.ctaUrl || req.body?.cta_url || null;
    const qrTargetUrl = req.body?.qrTargetUrl || req.body?.qr_target_url || ctaUrl;
    const useNaverQr = Boolean(req.body?.useNaverQr || req.body?.use_naver_qr);
    const useAiImages = Boolean(req.body?.useAiImages || req.body?.use_ai_images);
    const rewriteSettings = parseRewriteSettings(req.body?.rewriteSettings || req.body?.settings || {});
    const contentSkillKey = contentSkillFor(rewriteSettings.contentSkillKey).key;
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
          use_naver_qr, use_ai_images, source_analysis_ids, settings_json, content_skill_key,
          custom_title, status, source_kind, publish_spec, qr_target_url, naver_qr_name, qr_status,
          generator_mode, openai_model
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'대기중',$12,$13,$14,$15,$16,$17,$18)
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
          contentSkillKey,
          rewriteSpecs.length === 1 ? customTitle : '',
          sourceRowMode ? 'collected_row' : (resolvedSourceAnalysisIds.length ? 'collected_pattern' : 'direct_keyword'),
          JSON.stringify(buildPublishSpec(spec.platform, rewriteSettings, {
            qrOrLinkRequired: true,
            ctaUrlRequiredPerRow: true,
          })),
          qrTargetUrl,
          makeNaverQrName(spec.keyword, req.body?.campaignName || req.body?.campaign_name || 'rewrite'),
          useNaverQr ? 'QR 생성 필요' : 'QR 미사용',
          rewriteSettings.generatorMode || 'openai',
          rewriteSettings.openaiModel || DEFAULT_REWRITE_SETTINGS.openaiModel,
        ]
      );
      await addRewriteEvent(rows[0].id, 'created', '발행 생성 작업이 등록되었습니다', {
        sourceAnalysisIds: spec.sourceAnalysisIds,
        rewriteSettings,
        sourceRowMode,
      });
      insertedJobs.push(rows[0]);
    }

    const concurrency = clampNumber(parseInt(req.body?.concurrency || '3', 10) || 3, 1, 5);
    const asyncProcess = req.body?.asyncProcess !== false && req.body?.processInline !== true;
    if (asyncProcess) {
      processRewriteJobsInBackground(insertedJobs, { tenantId, researchCredentials, concurrency });
      return res.json({
        ok: true,
        created: insertedJobs.length,
        queued: insertedJobs.length,
        processed: 0,
        contentJobsCreated: 0,
        contentJobs: [],
        concurrency,
        processingMode: 'background',
        jobs: insertedJobs.map(attachRewriteMetricSummary),
      });
    }
    const processed = await mapLimit(insertedJobs, concurrency, async (job) => {
      try {
        return await processRewriteJob(job.id, { tenantId, researchCredentials });
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
        await addRewriteEvent(job.id, 'error', '발행 생성 작업 중 오류가 발생했습니다', { error: err.message });
        return failed.rows[0] || { ...job, status: '오류', error_message: err.message };
      }
    });

    res.json({
      ok: true,
      created: insertedJobs.length,
      processed: processed.length,
      contentJobsCreated: 0,
      contentJobs: [],
      concurrency,
      jobs: processed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs/:id/process', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const job = await processRewriteJob(req.params.id, {
      tenantId,
      forceVariant: Boolean(req.body?.forceVariant || req.body?.force_variant),
      generatorMode: req.body?.generatorMode || req.body?.generator_mode,
    });
    res.json({
      ok: true,
      job,
      contentJob: null,
      contentJobExisting: false,
      generatorMode: job.generator_mode || 'server_template',
      elapsedMs: job.elapsed_ms || null,
      variantIndex: job.variant_index || 0,
      note: job.generator_mode === 'openai' ? 'OpenAI로 원고를 생성했습니다.' : '서버 템플릿 생성기로 원고를 생성했습니다.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs/:id/mark-published', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const rewrite = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (rewrite.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });

    const rewriteJob = rewrite.rows[0];
    const publishedUrl = req.body.publishedUrl || req.body.published_url || null;
    const publishedAt = normalizeOptionalDate(req.body.publishedAt || req.body.published_at) || new Date().toISOString();
    const contentResult = await ensureContentJobFromRewrite({
      tenantId,
      rewriteJob,
      body: {
        publishMode: 'immediate',
        publishStatus: '발행완료',
        publishedUrl,
        publishedAt,
      },
    });
    const { rows: contentRows } = await pool.query(
      `UPDATE content_jobs
       SET published_url = COALESCE($2, published_url),
           published_at = $3,
           publish_status = '발행완료',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [contentResult.job.id, publishedUrl, publishedAt]
    );
    const { rows: rewriteRows } = await pool.query(
      `UPDATE rewrite_jobs
       SET status = '발행 완료',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [rewriteJob.id]
    );
    await addJobEvent(contentResult.job.id, 'published_marked_from_rewrite', '확장프로그램이 발행 생성 작업의 발행 URL/status를 저장했습니다', {
      rewriteJobId: rewriteJob.id,
      publishedUrl,
      publishedAt,
    });
    await addRewriteEvent(rewriteJob.id, 'published_marked', '확장프로그램이 발행 URL을 저장했습니다', {
      publishedUrl,
      publishedAt,
      contentJobId: contentResult.job.id,
    });
    res.json({ ok: true, job: rewriteRows[0], contentJob: contentRows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function saveRewriteQrResult(req, res) {
  try {
    const tenantId = tenantIdFromReq(req);
    const rewrite = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (rewrite.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });

    const current = rewrite.rows[0];
    const shortUrl = req.body.naverQrShortUrl || req.body.naver_qr_short_url || req.body.shortUrl || req.body.short_url || null;
    const manageUrl = req.body.naverQrManageUrl || req.body.naver_qr_manage_url || req.body.manageUrl || req.body.manage_url || null;
    const imageUrl = req.body.naverQrImageUrl || req.body.naver_qr_image_url || req.body.imageUrl || req.body.image_url || null;
    const qrName = req.body.naverQrName || req.body.naver_qr_name || current.naver_qr_name || makeNaverQrName(current.target_keyword, 'rewrite');
    const qrTargetUrl = req.body.qrTargetUrl || req.body.qr_target_url || req.body.targetUrl || req.body.target_url || current.qr_target_url || current.cta_url || null;
    const qrAccountId = req.body.qrAccountId || req.body.qr_account_id || null;
    const qrErrorMessage = req.body.qrErrorMessage || req.body.qr_error_message || req.body.error || null;
    const requestedStatus = req.body.qrStatus || req.body.qr_status;
    const qrStatus = JOB_STATUSES.has(requestedStatus)
      ? requestedStatus
      : shortUrl
        ? 'QR 생성 완료'
        : qrErrorMessage
          ? '오류'
          : 'QR 생성 필요';
    const qrCreatedAt = req.body.qrCreatedAt || req.body.qr_created_at || (shortUrl ? new Date().toISOString() : null);

    const { rows } = await pool.query(
      `UPDATE rewrite_jobs
       SET qr_target_url = COALESCE($2, qr_target_url, cta_url),
           naver_qr_name = COALESCE($3, naver_qr_name),
           naver_qr_short_url = COALESCE($4, naver_qr_short_url),
           naver_qr_manage_url = COALESCE($5, naver_qr_manage_url),
           naver_qr_image_url = COALESCE($6, naver_qr_image_url),
           qr_status = $7,
           qr_created_at = CASE WHEN $4 IS NOT NULL THEN COALESCE($8::timestamptz, NOW()) ELSE qr_created_at END,
           qr_account_id = COALESCE($9, qr_account_id),
           qr_error_message = CASE WHEN $4 IS NOT NULL THEN NULL ELSE COALESCE($10, qr_error_message) END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [current.id, qrTargetUrl, qrName, shortUrl, manageUrl, imageUrl, qrStatus, qrCreatedAt, qrAccountId, qrErrorMessage]
    );

    const updated = rows[0];
    const linkedContentJobs = await pool.query(
      `UPDATE content_jobs
       SET cta_url = COALESCE($2, cta_url),
           qr_target_url = COALESCE($3, qr_target_url),
           naver_qr_name = COALESCE($4, naver_qr_name),
           naver_qr_short_url = COALESCE($2, naver_qr_short_url),
           naver_qr_manage_url = COALESCE($5, naver_qr_manage_url),
           naver_qr_image_url = COALESCE($6, naver_qr_image_url),
           qr_status = $7,
           qr_created_at = CASE WHEN $2 IS NOT NULL THEN COALESCE($8::timestamptz, NOW()) ELSE qr_created_at END,
           qr_account_id = COALESCE($9, qr_account_id),
           qr_error_message = CASE WHEN $2 IS NOT NULL THEN NULL ELSE COALESCE($10, qr_error_message) END,
           updated_at = NOW()
       WHERE rewrite_job_id = $1
       RETURNING id`,
      [current.id, shortUrl, qrTargetUrl, qrName, manageUrl, imageUrl, qrStatus, qrCreatedAt, qrAccountId, qrErrorMessage]
    );

    await addRewriteEvent(current.id, shortUrl ? 'qr_short_url_saved' : 'qr_result_saved', '네이버 QR 단축 URL 정보가 저장되었습니다', {
      shortUrl,
      manageUrl,
      imageUrl,
      qrName,
      qrTargetUrl,
      linkedContentJobIds: linkedContentJobs.rows.map((row) => row.id),
    });

    const shouldConsumeQrUsage = Boolean(shortUrl && qrAccountId && shortUrl !== current.naver_qr_short_url);
    const qrAccountUsage = shouldConsumeQrUsage
      ? await consumeQrAccountUsage({ tenantId, slotId: qrAccountId, shortUrl })
      : null;

    res.json({ ok: true, job: updated, linkedContentJobs: linkedContentJobs.rows, qrAccountUsage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.post('/rewrite-jobs/:id/qr', saveRewriteQrResult);
router.patch('/rewrite-jobs/:id/qr', saveRewriteQrResult);

router.post('/rewrite-jobs/:id/to-content-job', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const rewrite = await pool.query('SELECT * FROM rewrite_jobs WHERE id = $1', [req.params.id]);
    if (rewrite.rows.length === 0) return res.status(404).json({ error: 'Rewrite job not found' });
    const rewriteJob = rewrite.rows[0];
    const autoReady = Boolean(req.body?.autoReady);
    const scheduledAt = autoReady
      ? null
      : req.body?.scheduledAt || req.body?.scheduled_at || (await buildAutoPublishSlots({ tenantId, count: 1, spacingMinutes: req.body?.spacingMinutes || req.body?.betweenPostsDelayMinutes || 120 }))[0];
    const result = await createContentJobFromRewrite({
      tenantId,
      rewriteJob,
      body: {
        ...req.body,
        publishMode: autoReady ? 'draft' : req.body?.publishMode || req.body?.publish_mode || 'scheduled',
        publishStatus: autoReady ? '자동발행대기' : req.body?.publishStatus || req.body?.publish_status || '예약대기',
        scheduledAt,
      },
    });
    res.json({ ok: true, job: result.job, images: result.images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rewrite-jobs/to-content-jobs/bulk', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const body = req.body || {};
    const rewriteJobIds = Array.isArray(body.rewriteJobIds)
      ? body.rewriteJobIds.map((id) => parseInt(id, 10)).filter(Boolean)
      : [];
    if (rewriteJobIds.length === 0) return res.status(400).json({ error: 'rewriteJobIds is required' });

    const spacingMinutes = clampNumber(parseInt(body.spacingMinutes || body.betweenPostsDelayMinutes || 120, 10) || 120, 1, 1440);
    const actionDelayMinutes = clampNumber(parseInt(body.actionDelayMinutes || 1, 10) || 1, 1, 60);
    const publishStatus = body.autoReady ? '자동발행대기' : '예약대기';
    const slots = body.autoReady
      ? Array.from({ length: rewriteJobIds.length }, () => null)
      : await buildAutoPublishSlots({ tenantId, count: rewriteJobIds.length, spacingMinutes });
    const { rows: rewrites } = await pool.query(
      `SELECT *
       FROM rewrite_jobs
       WHERE id = ANY($1::int[])
       ORDER BY array_position($1::int[], id)`,
      [rewriteJobIds]
    );
    if (rewrites.length === 0) return res.status(404).json({ error: 'Rewrite jobs not found' });

    const created = [];
    for (let index = 0; index < rewrites.length; index += 1) {
      const rewriteJob = rewrites[index];
      const result = await createContentJobFromRewrite({
        tenantId,
        rewriteJob,
        body: {
          ...body,
          publishMode: body.autoReady ? 'draft' : 'scheduled',
          publishStatus,
          scheduledAt: slots[index],
          actionDelayMinSeconds: actionDelayMinutes * 60,
          actionDelayMaxSeconds: actionDelayMinutes * 60,
          betweenPostsDelayMinutes: spacingMinutes,
        },
      });
      created.push({ ...result.job, generated_image_count: result.images.length });
    }

    res.json({
      ok: true,
      created: created.length,
      jobs: created,
      spacingMinutes,
      actionDelayMinutes,
      publishStatus,
      firstScheduledAt: created[0]?.scheduled_at || null,
      runnerDecidesSchedule: Boolean(body.autoReady),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Publish Queue (rewrite -> editor -> RSS confirmation -> owner Obsidian export) ---
router.post('/publish-queue/claim-next', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const platform = req.body?.platform || null;
    const publishAccountId = req.body?.publishAccountId || req.body?.publish_account_id || null;
    const publishAccountLabel = req.body?.publishAccountLabel || req.body?.publish_account_label || null;
    const staleReset = await resetStalePublishingJobs({
      tenantId,
      minutes: req.body?.staleMinutes || req.body?.stale_minutes,
      reason: 'claim_next',
    });
    const { rows } = await pool.query(
      `WITH next_job AS (
         SELECT id
         FROM content_jobs
         WHERE COALESCE(tenant_id, 'owner') = $1
           AND publish_status IN ('자동발행대기', '발행대기', '예약대기')
           AND (scheduled_at IS NULL OR scheduled_at <= NOW())
           AND ($2::text IS NULL OR platform = $2 OR publish_account_platform = $2)
         ORDER BY scheduled_at NULLS FIRST, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE content_jobs cj
       SET publish_status = '발행중',
           publish_account_id = COALESCE($3, publish_account_id),
           publish_account_label = COALESCE($4, publish_account_label),
           updated_at = NOW()
       FROM next_job
       WHERE cj.id = next_job.id
       RETURNING cj.*`,
      [tenantId, platform, publishAccountId, publishAccountLabel]
    );
    if (rows.length === 0) return res.json({ ok: true, job: null, staleReset });
    await addJobEvent(rows[0].id, 'publish_claimed', '자동발행 Runner가 작업을 점유했습니다', {
      platform,
      publishAccountId,
      publishAccountLabel,
    });
    res.json({ ok: true, job: rows[0], staleReset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/claim', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const jobId = parseInt(req.params.id, 10);
    const platform = req.body?.platform || null;
    const publishAccountId = req.body?.publishAccountId || req.body?.publish_account_id || null;
    const publishAccountLabel = req.body?.publishAccountLabel || req.body?.publish_account_label || null;
    const ignoreSchedule = req.body?.ignoreSchedule === true || req.body?.ignore_schedule === true;
    await resetStalePublishingJobs({
      tenantId,
      minutes: req.body?.staleMinutes || req.body?.stale_minutes,
      reason: 'claim_selected',
    });
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET publish_status = '발행중',
           publish_account_id = COALESCE($4, publish_account_id),
           publish_account_label = COALESCE($5, publish_account_label),
           updated_at = NOW()
       WHERE id = $1
         AND COALESCE(tenant_id, 'owner') = $2
         AND publish_status IN ('자동발행대기', '발행대기', '예약대기', '초안대기')
         AND ($6::boolean OR scheduled_at IS NULL OR scheduled_at <= NOW())
         AND ($3::text IS NULL OR platform = $3 OR publish_account_platform = $3)
       RETURNING *`,
      [jobId, tenantId, platform, publishAccountId, publishAccountLabel, ignoreSchedule]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: '이미 다른 PC가 점유했거나 지금 발행 가능한 상태가 아닙니다.' });
    }
    await addJobEvent(rows[0].id, 'publish_selected_claimed', '확장프로그램이 선택한 작업을 점유했습니다', {
      platform,
      publishAccountId,
      publishAccountLabel,
    });
    res.json({ ok: true, job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/publish-queue', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    await resetStalePublishingJobs({
      tenantId,
      minutes: req.query?.staleMinutes || req.query?.stale_minutes,
      reason: 'queue_list',
    });
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
           WHEN '자동발행대기' THEN 2
           WHEN '발행대기' THEN 3
           WHEN '예약대기' THEN 4
           WHEN '초안대기' THEN 5
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
    res.json({
      jobId: job.id,
      imageSourceMode: 'server_blob',
      editorUploadMode: 'extension_download_blob_then_upload',
      images: images.map((image, index) => generatedImageClientPayload(req, image, index)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/generated-images/:id/file', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const { rows } = await pool.query(
      `SELECT *
       FROM generated_images
       WHERE id = $1
         AND COALESCE(tenant_id, 'owner') = $2
       LIMIT 1`,
      [req.params.id, tenantId]
    );
    const image = rows[0];
    if (!image) return res.status(404).json({ error: 'Generated image not found' });
    if (image.public_url) return res.redirect(image.public_url);
    if (!image.data_url) return res.status(404).json({ error: 'No downloadable image data' });

    const match = String(image.data_url).match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
    if (!match) return res.status(422).json({ error: 'Unsupported image data format' });
    const mime = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || '';
    const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="naviwrite-image-${image.id}.${mime.includes('svg') ? 'svg' : 'png'}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish-queue/:id/runner-plan', async (req, res) => {
  try {
    const tenantId = tenantIdFromReq(req);
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const publishAccountId = req.body.publishAccountId || req.body.publish_account_id || job.publish_account_id || null;
    const publishAccountLabel = req.body.publishAccountLabel || req.body.publish_account_label || job.publish_account_label || null;
    const publishAccountPlatform = req.body.publishAccountPlatform || req.body.publish_account_platform || job.publish_account_platform || job.platform || null;
    const spacingMinMinutes = normalizeSpacingMinutes(req.body.spacingMinMinutes || req.body.spacing_min_minutes || job.between_posts_delay_minutes || 120, 120, 1, 1440);
    const spacingMaxMinutes = normalizeSpacingMinutes(req.body.spacingMaxMinutes || req.body.spacing_max_minutes || 180, 180, spacingMinMinutes, 1440);
    const requestedLastPublishedAt = normalizeOptionalDate(
      req.body.lastPublishedAt || req.body.last_published_at || req.body.latestPublishedAt || req.body.latest_published_at
    );
    const fallbackLast = requestedLastPublishedAt
      ? null
      : await loadLatestPublishedForRunnerPlan({
        tenantId,
        jobId: job.id,
        publishAccountId,
        publishAccountLabel,
        publishAccountPlatform,
      });
    const lastPublishedAt = requestedLastPublishedAt || fallbackLast?.published_at || null;
    const planNow = new Date();
    const plan = computeRunnerPublishPlan({
      lastPublishedAt,
      spacingMinMinutes,
      spacingMaxMinutes,
      now: planNow,
    });
    const claim = Boolean(req.body.claim);
    const storedScheduledAt = claim && plan.publishMode === 'immediate' ? planNow.toISOString() : plan.scheduledAt;
    const runnerPlan = {
      ...plan,
      source: requestedLastPublishedAt ? 'extension_last_published_at' : fallbackLast ? 'db_latest_published_at' : 'no_history',
      latestPublishedJobId: fallbackLast?.id || null,
      latestPublishedUrl: req.body.lastPublishedUrl || req.body.last_published_url || fallbackLast?.published_url || null,
      storedScheduledAt,
      plannedBy: req.body.runnerName || req.body.runner_name || 'naviwrite-runner',
      plannedAt: new Date().toISOString(),
      claim,
    };
    const publishStatus = claim ? '발행중' : plan.publishStatus;
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET publish_mode = $2,
           scheduled_at = $3,
           publish_status = $4,
           publish_account_id = COALESCE($5, publish_account_id),
           publish_account_label = COALESCE($6, publish_account_label),
           publish_account_platform = COALESCE($7, publish_account_platform),
           between_posts_delay_minutes = $8,
           runner_plan = $9,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        job.id,
        plan.publishMode,
        storedScheduledAt,
        publishStatus,
        publishAccountId,
        publishAccountLabel,
        publishAccountPlatform,
        spacingMinMinutes,
        JSON.stringify(runnerPlan),
      ]
    );
    await addJobEvent(job.id, 'runner_publish_plan', 'Runner가 최근 발행 기준으로 즉시/예약 계획을 저장했습니다', runnerPlan);
    res.json({ ok: true, job: rows[0], plan: runnerPlan });
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

router.post('/publish-queue/:id/requeue', async (req, res) => {
  try {
    const job = await loadTenantContentJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });
    if (['발행완료', 'RSS확인완료', '성과추적중'].includes(job.publish_status) && !req.body?.force) {
      return res.status(400).json({ error: '이미 발행 완료된 작업은 자동발행 대기로 되돌릴 수 없습니다.' });
    }
    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET publish_status = '자동발행대기',
           scheduled_at = NULL,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id]
    );
    await addJobEvent(job.id, 'publish_manual_requeued', '사용자가 작업을 자동발행 대기로 복구했습니다', {
      previousStatus: job.publish_status,
    });
    res.json({ ok: true, job: rows[0] });
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
    const generationStatus = job.title || job.body ? '글생성 완료' : job.generation_status;

    const { rows } = await pool.query(
      `INSERT INTO content_jobs (
        tenant_id, created_by_user_id, rewrite_job_id,
        keyword, category, platform, source_url, cta_url, qr_target_url, tone, campaign_name,
        title, body, plain_text, char_count, kw_count, image_count,
        seo_score, geo_score, aeo_score, total_score,
        naver_qr_name, naver_qr_short_url, naver_qr_image_url, naver_qr_manage_url,
        qr_status, qr_created_at, qr_account_id, qr_error_message,
        generation_status, editor_status, sheet_row_id, sheet_sync_status,
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
        $22,$23,$24,$25,
        $26,$27,$28,$29,
        $30,$31,$32,$33,$34,
        $35,$36,$37,$38,$39,
        $40,$41,$42,$43,
        $44,$45,$46,
        $47,$48,$49,
        $50,$51
       )
       RETURNING *`,
      [
        job.tenant_id, job.created_by_user_id, job.rewrite_job_id,
        job.keyword, job.category, job.platform, job.source_url, job.cta_url, job.qr_target_url,
        job.tone, job.campaign_name, job.title, job.body, job.plain_text,
        job.char_count, job.kw_count, job.image_count,
        job.seo_score, job.geo_score, job.aeo_score, job.total_score,
        qrName, job.naver_qr_short_url, job.naver_qr_image_url, job.naver_qr_manage_url,
        job.qr_status, job.qr_created_at, job.qr_account_id, job.qr_error_message,
        generationStatus, job.editor_status, job.sheet_row_id,
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
      'naver_qr_short_url', 'naver_qr_image_url', 'naver_qr_manage_url',
      'qr_status', 'qr_created_at', 'qr_account_id', 'qr_error_message', 'generation_status',
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
      naver_qr_short_url: ['naver_qr_short_url', 'naverQrShortUrl', 'shortUrl'],
      naver_qr_image_url: ['naver_qr_image_url', 'naverQrImageUrl'],
      naver_qr_manage_url: ['naver_qr_manage_url', 'naverQrManageUrl'],
      qr_status: ['qr_status', 'qrStatus'],
      qr_created_at: ['qr_created_at', 'qrCreatedAt'],
      qr_account_id: ['qr_account_id', 'qrAccountId'],
      qr_error_message: ['qr_error_message', 'qrErrorMessage'],
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

    const { naver_qr_short_url, naver_qr_image_url, naver_qr_manage_url, qr_status, qr_created_at, qr_account_id, qr_error_message } = normalizeJobInput({
      ...req.body,
      qr_status: req.body.qr_status || req.body.qrStatus || (req.body.naverQrShortUrl || req.body.naver_qr_short_url || req.body.shortUrl ? 'QR 생성 완료' : 'QR 생성 필요'),
    });

    const { rows } = await pool.query(
      `UPDATE content_jobs
       SET naver_qr_short_url = COALESCE($2, naver_qr_short_url),
           cta_url = COALESCE($2, cta_url),
           naver_qr_image_url = COALESCE($3, naver_qr_image_url),
           naver_qr_manage_url = COALESCE($4, naver_qr_manage_url),
           qr_status = $5,
           qr_created_at = CASE WHEN $2 IS NOT NULL THEN COALESCE($6::timestamptz, NOW()) ELSE qr_created_at END,
           qr_account_id = COALESCE($7, qr_account_id),
           qr_error_message = CASE WHEN $2 IS NOT NULL THEN NULL ELSE COALESCE($8, qr_error_message) END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [currentJob.id, naver_qr_short_url, naver_qr_image_url, naver_qr_manage_url, qr_status, qr_created_at, qr_account_id, qr_error_message]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Content job not found' });

    if (currentJob.rewrite_job_id) {
      await pool.query(
        `UPDATE rewrite_jobs
         SET naver_qr_short_url = COALESCE($2, naver_qr_short_url),
             naver_qr_image_url = COALESCE($3, naver_qr_image_url),
             naver_qr_manage_url = COALESCE($4, naver_qr_manage_url),
             qr_status = $5,
             qr_created_at = CASE WHEN $2 IS NOT NULL THEN COALESCE($6::timestamptz, NOW()) ELSE qr_created_at END,
             qr_account_id = COALESCE($7, qr_account_id),
             qr_error_message = CASE WHEN $2 IS NOT NULL THEN NULL ELSE COALESCE($8, qr_error_message) END,
             updated_at = NOW()
         WHERE id = $1`,
        [currentJob.rewrite_job_id, naver_qr_short_url, naver_qr_image_url, naver_qr_manage_url, qr_status, qr_created_at, qr_account_id, qr_error_message]
      );
    }

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
let lastRssMonitorAt = 0;

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
    const rssIntervalMs = clampNumber(parseInt(process.env.RSS_CHECK_INTERVAL_MINUTES || '60', 10) || 60, 5, 1440) * 60 * 1000;
    if (Date.now() - lastRssMonitorAt >= rssIntervalMs) {
      lastRssMonitorAt = Date.now();
      try {
        const rssResults = await checkDueRssSources({
          maxSources: clampNumber(parseInt(process.env.RSS_CHECK_MAX_SOURCES || '12', 10) || 12, 1, 100),
          limit: clampNumber(parseInt(process.env.RSS_CHECK_ITEM_LIMIT || '20', 10) || 20, 1, 50),
        });
        if (rssResults.length > 0) {
          const okCount = rssResults.filter((item) => item.ok).length;
          console.log(`[collections] rss monitor: ${okCount}/${rssResults.length}`);
        }
      } catch (err) {
        console.warn('[collections] rss monitor failed:', err.message);
      }
    }
    try {
      const reset = await resetStalePublishingJobs({ tenantId: null, reason: 'scheduler' });
      if (reset.count > 0) console.log(`[publish] stale jobs requeued: ${reset.count}`);
    } catch (err) {
      console.warn('[publish] stale job reset failed:', err.message);
    }
  };

  const interval = setInterval(tick, 60 * 1000);
  interval.unref?.();
  const initial = setTimeout(tick, 15 * 1000);
  initial.unref?.();
}

export default router;
