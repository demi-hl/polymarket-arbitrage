/**
 * Sector classification for Polymarket markets.
 * Used to filter scan/watch to politics, sports, crypto, or all.
 */

const SECTOR_KEYWORDS = {
  politics: [
    'trump', 'biden', 'election', 'president', 'congress', 'senate', 'house', 'governor',
    'primary', 'nominee', 'democrat', 'republican', 'vote', 'ballot', 'cabinet', 'vp ',
    'debate', 'poll', 'approval', 'impeach', 'supreme court', 'senator', 'representative',
    'white house', 'electoral', 'inauguration', 'nomination', 'convention', 'midterm',
    'governor', 'mayor', 'political', 'policy', 'legislation', 'bill', 'veto'
  ],
  sports: [
    'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'super bowl', 'world series', 'finals', 'playoffs',
    'lakers', 'celtics', 'warriors', 'bucks', 'knicks', 'heat', 'nuggets', '76ers', 'sixers',
    'cavaliers', 'cavs', 'thunder', 'rockets', 'grizzlies', 'timberwolves', 'mavericks',
    'clippers', 'suns', 'hawks', 'nets', 'bulls', 'pistons', 'pacers', 'magic', 'pelicans',
    'kings', 'spurs', 'hornets', 'wizards', 'raptors', 'blazers', 'jazz', 'o/u', 'over/under',
    'spread:', 'moneyline', 'mvp', 'championship', 'stanley cup', 'world cup', 'olympics',
    'vs.', ' vs ', 'rebounds', 'points', 'touchdown', 'goal', 'quarter', 'half', '1h ', '1st half'
  ],
  crypto: [
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'sol ', 'price of ethereum',
    'price of bitcoin', 'price of ', 'usdc', 'usdt', 'defi', 'token', 'blockchain',
    'sec ', 'sec approval', 'etf', 'halving', 'ath', 'market cap', 'bnb', 'xrp',
    'cardano', 'ada', 'doge', 'dogecoin', 'shib', 'avax', 'polygon', 'matic',
    'will the price', 'price be between', 'above $', 'below $', 'reach $'
  ]
};

/**
 * Classify a market into one sector (first match wins).
 * @param {object} market - { question, category, eventTitle, slug }
 * @returns {'politics'|'sports'|'crypto'|'other'}
 */
function classifySector(market) {
  const text = [
    market.question,
    market.eventTitle,
    market.category,
    market.slug
  ].filter(Boolean).join(' ').toLowerCase();

  if (!text) return 'other';

  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return sector;
  }

  return 'other';
}

/**
 * Check if a market belongs to any of the given sectors.
 * @param {object} market
 * @param {string[]} sectors - e.g. ['politics', 'sports', 'crypto']
 * @returns {boolean}
 */
function marketInSectors(market, sectors) {
  if (!sectors || sectors.length === 0) return true;
  const sector = classifySector(market);
  return sectors.includes(sector);
}

const SECTORS = ['politics', 'sports', 'crypto'];

module.exports = { classifySector, marketInSectors, SECTOR_KEYWORDS, SECTORS };
