/**
 * X (Twitter) Sentiment Scanner
 *
 * Scrapes public X/Twitter search results to gauge real-time
 * sentiment around specific topics and Polymarket categories.
 * Uses Nitter instances or public search endpoints as a fallback
 * since official X API requires paid access.
 *
 * Signals:
 *   - Trending topic spikes related to active markets
 *   - Sentiment shift (bullish/bearish) on tracked keywords
 *   - High-engagement posts from notable accounts
 */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const SIGNALS_PATH = path.join(__dirname, '..', 'data', 'x-sentiment-signals.json');

// Polymarket-relevant search queries
const SEARCH_QUERIES = [
  { id: 'polymarket', query: 'polymarket', category: 'meta' },
  { id: 'btc-price', query: 'bitcoin price OR BTC price', category: 'crypto' },
  { id: 'eth-price', query: 'ethereum price OR ETH price', category: 'crypto' },
  { id: 'trump-policy', query: 'Trump executive order OR Trump policy', category: 'politics' },
  { id: 'fed-rates', query: 'Federal Reserve rate OR Fed rate decision', category: 'finance' },
  { id: 'ukraine-war', query: 'Ukraine Russia ceasefire OR peace deal', category: 'geopolitics' },
  { id: 'iran-deal', query: 'Iran nuclear OR Iran sanctions', category: 'geopolitics' },
  { id: 'ai-regulation', query: 'AI regulation OR AI executive order', category: 'tech' },
  { id: 'govt-shutdown', query: 'government shutdown OR continuing resolution', category: 'politics' },
  { id: 'prediction-market', query: 'prediction market whale OR prediction market bet', category: 'meta' },
];

const BULLISH_LEXICON = new Set([
  'moon', 'pump', 'bullish', 'buy', 'long', 'rally', 'breakout', 'ath',
  'green', 'surge', 'rocket', 'win', 'pass', 'approved', 'deal', 'peace',
  'agreement', 'soar', 'boom', 'explosion', 'record high', 'massive',
]);

const BEARISH_LEXICON = new Set([
  'dump', 'crash', 'bearish', 'sell', 'short', 'breakdown', 'red',
  'plunge', 'rekt', 'fail', 'reject', 'war', 'conflict', 'crisis',
  'collapse', 'tank', 'flee', 'panic', 'bust', 'scam', 'fraud',
]);

/**
 * Search X via DuckDuckGo (site:x.com) as a free proxy.
 * Not perfect but avoids needing X API keys.
 */
async function searchX(query) {
  try {
    const { data } = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q: `site:x.com ${query}`, kl: 'us-en', df: 'd' },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      responseType: 'text',
    });

    const snippets = [];
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = snippetRegex.exec(data)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 20) snippets.push(text);
    }
    return snippets.slice(0, 8);
  } catch {
    return [];
  }
}

function analyzeSentiment(snippets) {
  const text = snippets.join(' ').toLowerCase();
  const words = text.split(/\s+/);

  let bullish = 0;
  let bearish = 0;
  let total = 0;

  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, '');
    if (BULLISH_LEXICON.has(clean)) { bullish++; total++; }
    if (BEARISH_LEXICON.has(clean)) { bearish++; total++; }
  }

  if (total === 0) return { sentiment: 'neutral', confidence: 0, bullish: 0, bearish: 0, sampleSize: snippets.length };

  const ratio = bullish / (bullish + bearish);
  let sentiment;
  if (ratio > 0.65) sentiment = 'bullish';
  else if (ratio < 0.35) sentiment = 'bearish';
  else sentiment = 'mixed';

  return {
    sentiment,
    confidence: parseFloat(Math.abs(ratio - 0.5).toFixed(2)),
    bullish,
    bearish,
    sampleSize: snippets.length,
  };
}

/**
 * Detect potential volume/engagement spikes by looking at
 * snippet density and keyword repetition.
 */
function detectSpike(snippets) {
  if (snippets.length < 3) return false;

  // Many search results = topic is trending
  const uniquePhrases = new Set(snippets.map(s => s.substring(0, 50)));
  return uniquePhrases.size >= 3;
}

async function loadSignals() {
  try {
    return JSON.parse(await fs.readFile(SIGNALS_PATH, 'utf8'));
  } catch { return []; }
}

async function saveSignals(signals) {
  const trimmed = signals.slice(-300);
  await fs.writeFile(SIGNALS_PATH, JSON.stringify(trimmed, null, 2));
}

/**
 * Run full X sentiment scan.
 * Cycles through search queries, analyzes sentiment, and saves signals.
 */
async function scan(customQueries) {
  const queries = customQueries || SEARCH_QUERIES;
  const signals = await loadSignals();
  const newSignals = [];
  const now = Date.now();

  for (const q of queries) {
    const snippets = await searchX(q.query);
    if (snippets.length === 0) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const analysis = analyzeSentiment(snippets);
    const isTrending = detectSpike(snippets);

    if (analysis.sentiment !== 'neutral' && analysis.confidence > 0.1) {
      newSignals.push({
        type: 'x-sentiment',
        queryId: q.id,
        query: q.query,
        category: q.category,
        sentiment: analysis.sentiment,
        confidence: analysis.confidence,
        bullish: analysis.bullish,
        bearish: analysis.bearish,
        sampleSize: analysis.sampleSize,
        isTrending,
        snippetPreview: snippets[0]?.substring(0, 100),
        timestamp: now,
      });
    }

    await new Promise(r => setTimeout(r, 2000)); // rate limit
  }

  if (newSignals.length > 0) {
    signals.push(...newSignals);
    await saveSignals(signals);
  }

  return newSignals;
}

/**
 * Get sentiment for a specific category.
 */
async function getCategorySentiment(category, maxAge = 3600000) {
  const signals = await loadSignals();
  const cutoff = Date.now() - maxAge;
  const relevant = signals.filter(s => s.category === category && s.timestamp > cutoff);

  if (relevant.length === 0) return { sentiment: 'neutral', confidence: 0 };

  let totalBullish = 0;
  let totalBearish = 0;
  for (const s of relevant) {
    totalBullish += s.bullish;
    totalBearish += s.bearish;
  }

  const total = totalBullish + totalBearish;
  if (total === 0) return { sentiment: 'neutral', confidence: 0 };

  const ratio = totalBullish / total;
  return {
    sentiment: ratio > 0.6 ? 'bullish' : ratio < 0.4 ? 'bearish' : 'mixed',
    confidence: parseFloat(Math.abs(ratio - 0.5).toFixed(2)),
    sampleCount: relevant.length,
  };
}

module.exports = { scan, getCategorySentiment, analyzeSentiment, SEARCH_QUERIES };
