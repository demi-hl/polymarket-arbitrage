/**
 * Cross-platform market matcher — REALISTIC version.
 * Strict matching to avoid false positives. Only surfaces genuine price discrepancies.
 */

const STOP_WORDS = new Set([
  'will', 'the', 'be', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for',
  'by', 'is', 'it', 'or', 'and', 'this', 'that', 'before', 'after',
  'who', 'what', 'how', 'which', 'than', 'vs', 'more', 'most',
  'win', 'election', 'party', 'year',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function extractProperNouns(text) {
  const words = (text || '').match(/[A-Z][a-z]{2,}/g) || [];
  return new Set(words.map(w => w.toLowerCase()));
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function properNounOverlap(textA, textB) {
  const nounsA = extractProperNouns(textA);
  const nounsB = extractProperNouns(textB);
  if (nounsA.size === 0 || nounsB.size === 0) return 0;
  let overlap = 0;
  for (const n of nounsA) {
    if (nounsB.has(n)) overlap++;
  }
  const smaller = Math.min(nounsA.size, nounsB.size);
  return overlap / smaller;
}

function isLikelyParlay(title) {
  return (title.match(/,/g) || []).length >= 2 || /\byes\b.*\byes\b/i.test(title);
}

function matchMarkets(polyMarkets, externalMarkets, options = {}) {
  const minSimilarity = options.minSimilarity || 0.65;
  const minEdge = options.minEdge || 0.02;
  const baseMaxEdge = options.maxEdge || 0.06;
  const minLiquidity = options.minLiquidity || 10000;
  const matches = [];

  const filtered = externalMarkets.filter(ext => {
    if (isLikelyParlay(ext.title)) return false;
    const tokens = tokenize(ext.title);
    return tokens.length >= 3;
  });

  const externalIndex = new Map();
  for (const ext of filtered) {
    const tokens = tokenize(ext.title);
    for (const token of tokens) {
      if (!externalIndex.has(token)) externalIndex.set(token, []);
      externalIndex.get(token).push(ext);
    }
  }

  for (const poly of polyMarkets) {
    const polyTitle = poly.question || poly.title || '';
    const polyTokens = tokenize(polyTitle);
    if (polyTokens.length < 3) continue;

    const liquidity = poly.liquidity || 0;
    if (liquidity < minLiquidity) continue;

    const candidates = new Map();
    for (const token of polyTokens) {
      const hits = externalIndex.get(token) || [];
      for (const h of hits) {
        candidates.set(h, (candidates.get(h) || 0) + 1);
      }
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const [ext, hitCount] of candidates) {
      if (hitCount < 3) continue;

      const jaccard = jaccardSimilarity(polyTitle, ext.title);
      const nounOverlap = properNounOverlap(polyTitle, ext.title);

      // Require proper nouns to match (people, places, entities)
      if (nounOverlap < 0.7) continue;

      const score = jaccard * 0.5 + nounOverlap * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = ext;
      }
    }

    if (!bestMatch || bestScore < minSimilarity) continue;

    const polyYes = parseFloat(poly.outcomePrices?.[0] ?? poly.yesPrice ?? 0);
    const extYes = bestMatch.yesPrice ?? 0;

    // Reject extreme prices (illiquid/settled)
    if (polyYes <= 0.03 || extYes <= 0.03) continue;
    if (polyYes >= 0.97 || extYes >= 0.97) continue;

    const priceDiff = Math.abs(polyYes - extYes);
    if (priceDiff < minEdge) continue;
    // High-confidence matches (score >= 0.75) allow larger edges up to 25%;
    // lower-confidence matches use the conservative cap to reduce false positives.
    const effectiveMaxEdge = bestScore >= 0.75 ? 0.25 : baseMaxEdge;
    if (priceDiff > effectiveMaxEdge) continue;

    const direction = polyYes < extYes ? 'BUY_YES' : 'BUY_NO';

    matches.push({
      polyMarket: {
        id: poly.id,
        question: poly.question || poly.title,
        slug: poly.slug,
        yesPrice: polyYes,
        noPrice: parseFloat(poly.outcomePrices?.[1] ?? poly.noPrice ?? 0),
        liquidity,
        volume: poly.volume || 0,
        conditionId: poly.conditionId,
        endDate: poly.endDate,
      },
      externalMarket: {
        platform: bestMatch.platform,
        id: bestMatch.id,
        title: bestMatch.title,
        yesPrice: extYes,
        noPrice: bestMatch.noPrice ?? 0,
      },
      matchScore: bestScore,
      priceDiff,
      edgePercent: priceDiff,
      direction,
    });
  }

  matches.sort((a, b) => b.edgePercent - a.edgePercent);
  return matches;
}

module.exports = { matchMarkets, jaccardSimilarity, tokenize };
