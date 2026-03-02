/**
 * Automated News Scanner
 *
 * Periodically checks web search for breaking news that might
 * affect open positions and active markets. Updates news-theses.json
 * with new directional signals.
 */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const THESES_PATH = path.join(__dirname, '..', 'data', 'news-theses.json');
const NEWS_CACHE_PATH = path.join(__dirname, '..', 'data', 'news-cache.json');
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Keywords to track across news sources (expandable)
const DEFAULT_WATCHLIST = [
  { category: 'crypto', keywords: ['bitcoin', 'BTC', 'ethereum', 'ETH', 'crypto regulation', 'SEC crypto', 'bitcoin ETF'] },
  { category: 'politics', keywords: ['Trump', 'Biden', 'Congress', 'executive order', 'government shutdown', 'election 2026', 'midterm'] },
  { category: 'geopolitics', keywords: ['Ukraine', 'Russia', 'China Taiwan', 'Iran', 'Israel', 'NATO', 'sanctions'] },
  { category: 'finance', keywords: ['Fed rate', 'interest rate', 'inflation', 'recession', 'stock market crash', 'S&P 500'] },
  { category: 'tech', keywords: ['AI regulation', 'OpenAI', 'Google AI', 'TikTok ban', 'antitrust'] },
  { category: 'sports', keywords: ['NFL', 'NBA', 'Super Bowl', 'March Madness', 'UFC'] },
];

async function loadTheses() {
  try {
    const raw = JSON.parse(await fs.readFile(THESES_PATH, 'utf8'));
    if (Array.isArray(raw)) return { theses: raw, lastUpdated: 0 };
    return raw && raw.theses ? raw : { theses: [], lastUpdated: 0 };
  } catch { return { theses: [], lastUpdated: 0 }; }
}

async function saveTheses(thesesData) {
  const wrapped = Array.isArray(thesesData)
    ? { theses: thesesData, lastUpdated: Date.now() }
    : thesesData;
  await fs.writeFile(THESES_PATH, JSON.stringify(wrapped, null, 2));
}

async function loadNewsCache() {
  try {
    return JSON.parse(await fs.readFile(NEWS_CACHE_PATH, 'utf8'));
  } catch { return { articles: [], lastScan: 0 }; }
}

async function saveNewsCache(data) {
  const trimmed = { ...data, articles: data.articles.slice(-500) };
  await fs.writeFile(NEWS_CACHE_PATH, JSON.stringify(trimmed, null, 2));
}

async function fetchActiveMarketQuestions() {
  try {
    const { data } = await axios.get(`${GAMMA_API}/events`, {
      params: { limit: 50, active: true, closed: false },
      timeout: 10000,
    });
    if (!data) return [];
    return data
      .flatMap(e => (e.markets || []).map(m => ({
        question: m.question || '',
        conditionId: m.conditionId,
        price: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : 0.5),
        volume: parseFloat(m.volume || 0),
        category: (e.category || '').toLowerCase(),
        endDate: m.endDate || e.endDate,
      })))
      .filter(m => m.volume > 10000);
  } catch (err) {
    console.error('[news-scanner] market fetch failed:', err.message);
    return [];
  }
}

/**
 * Use DuckDuckGo Lite HTML API as a free, no-auth news search.
 * Falls back gracefully — the strategy works without live news too.
 */
async function searchNews(query) {
  try {
    const { data } = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q: `${query} news today`, kl: 'us-en' },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
      responseType: 'text',
    });
    // Extract result snippets from HTML
    const snippets = [];
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = snippetRegex.exec(data)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 30) snippets.push(text);
    }
    return snippets.slice(0, 5);
  } catch {
    return [];
  }
}

function deriveSentiment(snippets, keywords) {
  const text = snippets.join(' ').toLowerCase();
  let bullish = 0;
  let bearish = 0;

  const bullishWords = ['surge', 'rally', 'gain', 'jump', 'soar', 'approve', 'pass', 'win', 'agreement', 'peace', 'rise', 'up', 'high', 'record', 'boost', 'green'];
  const bearishWords = ['crash', 'fall', 'drop', 'plunge', 'reject', 'fail', 'lose', 'war', 'conflict', 'down', 'low', 'crisis', 'collapse', 'red', 'decline', 'dump'];

  for (const w of bullishWords) { if (text.includes(w)) bullish++; }
  for (const w of bearishWords) { if (text.includes(w)) bearish++; }

  const total = bullish + bearish;
  if (total === 0) return { sentiment: 'neutral', score: 0 };
  if (bullish > bearish * 1.5) return { sentiment: 'bullish', score: Math.min(bullish / total, 0.9) };
  if (bearish > bullish * 1.5) return { sentiment: 'bearish', score: Math.min(bearish / total, 0.9) };
  return { sentiment: 'mixed', score: 0 };
}

/**
 * Match news sentiment to active markets and generate thesis candidates.
 */
function matchNewsToMarkets(newsResults, markets) {
  const matches = [];

  for (const news of newsResults) {
    if (!news.snippets || news.snippets.length === 0) continue;
    const { sentiment, score } = deriveSentiment(news.snippets, news.keywords);
    if (sentiment === 'neutral' || sentiment === 'mixed') continue;

    const allText = news.snippets.join(' ').toLowerCase();

    for (const market of markets) {
      const question = market.question.toLowerCase();
      const keywordMatch = news.keywords.some(kw => question.includes(kw.toLowerCase()));
      const snippetMatch = news.keywords.some(kw => allText.includes(kw.toLowerCase()));

      if (!keywordMatch && !snippetMatch) continue;

      let bias;
      if (sentiment === 'bullish' && market.price < 0.7) bias = 'BUY_YES';
      else if (sentiment === 'bearish' && market.price > 0.3) bias = 'BUY_NO';
      else continue;

      matches.push({
        marketQuestion: market.question,
        conditionId: market.conditionId,
        currentPrice: market.price,
        category: news.category,
        sentiment,
        sentimentScore: score,
        bias,
        keywords: news.keywords,
        headline: news.snippets[0]?.substring(0, 120),
        source: 'oracle-news-scanner',
      });
    }
  }

  return matches;
}

/**
 * Run a full news scan cycle:
 *  - Fetch active markets
 *  - Search news for each watchlist category
 *  - Match sentiment to markets
 *  - Update theses
 */
async function scan(customWatchlist) {
  const watchlist = customWatchlist || DEFAULT_WATCHLIST;
  const markets = await fetchActiveMarketQuestions();
  const newsResults = [];

  for (const group of watchlist) {
    const query = group.keywords.slice(0, 3).join(' OR ');
    const snippets = await searchNews(query);
    newsResults.push({ category: group.category, keywords: group.keywords, snippets });
    await new Promise(r => setTimeout(r, 1500)); // rate limit
  }

  const matches = matchNewsToMarkets(newsResults, markets);
  const cache = await loadNewsCache();
  cache.articles.push(...newsResults.map(n => ({ ...n, timestamp: Date.now() })));
  cache.lastScan = Date.now();
  await saveNewsCache(cache);

  // Auto-generate theses from strong matches
  if (matches.length > 0) {
    const thesesData = await loadTheses();
    const existingKeywords = new Set(
      thesesData.theses.flatMap(t => t.keywords || []).map(k => k.toLowerCase())
    );

    let added = 0;
    for (const m of matches) {
      if (m.sentimentScore < 0.3) continue;
      const isDuplicate = m.keywords.some(k => existingKeywords.has(k.toLowerCase()));
      if (isDuplicate) continue;

      thesesData.theses.push({
        id: `oracle-${Date.now()}-${added}`,
        keywords: m.keywords.slice(0, 4),
        bias: m.bias,
        confidence: Math.min(0.3 + m.sentimentScore * 0.4, 0.75),
        rationale: `[Auto] ${m.sentiment} sentiment detected: "${m.headline}"`,
        source: 'oracle-news-scanner',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      });
      m.keywords.forEach(k => existingKeywords.add(k.toLowerCase()));
      added++;
    }

    if (added > 0) {
      // Expire old auto-generated theses
      thesesData.theses = thesesData.theses.filter(t => {
        if (t.source !== 'oracle-news-scanner') return true;
        if (t.expiresAt && new Date(t.expiresAt) < new Date()) return false;
        return true;
      });
      thesesData.lastUpdated = Date.now();
      await saveTheses(thesesData);
      console.log(`[oracle/news] Added ${added} new auto-theses from news scan`);
    }
  }

  return { newsResults: newsResults.length, matches: matches.length, markets: markets.length };
}

module.exports = { scan, searchNews, deriveSentiment, DEFAULT_WATCHLIST };
