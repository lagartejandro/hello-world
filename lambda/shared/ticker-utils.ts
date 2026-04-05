// Words that match the ticker regex but are never stock tickers.
// Sourced from common false-positives on WSB/stocks/investing.
const BLOCKLIST = new Set([
  // Articles, prepositions, conjunctions
  'A', 'AN', 'THE', 'IN', 'ON', 'AT', 'TO', 'OF', 'IS', 'BE', 'AS', 'BY',
  'OR', 'AND', 'BUT', 'FOR', 'NOR', 'YET', 'SO', 'NO', 'UP', 'DO', 'GO',
  // Pronouns
  'I', 'MY', 'ME', 'WE', 'US', 'HE', 'SHE', 'IT', 'HIS', 'HER', 'ITS',
  'OUR', 'YOU', 'YOUR', 'THEY', 'THEM', 'THEIR',
  // Common finance acronyms (not tickers)
  'IPO', 'ETF', 'ETN', 'CEO', 'CFO', 'CTO', 'COO', 'SEC', 'FED', 'NYSE',
  'EPS', 'PE', 'PEG', 'NAV', 'AUM', 'ROE', 'ROI', 'FCF', 'DCF', 'EBITDA',
  'IV', 'OTM', 'ITM', 'ATM', 'DTE', 'PNL',
  // WSB slang
  'DD', 'YOLO', 'FOMO', 'FUD', 'RH', 'WSB', 'ATH', 'ATL', 'BTFD', 'HODL',
  'MEME', 'SHORT', 'LONG', 'BULL', 'BEAR', 'PUTS', 'CALL', 'CALLS',
  // Internet/Reddit slang
  'OP', 'OC', 'IMO', 'IMHO', 'TBH', 'TIL', 'TLDR', 'AMA', 'ELI',
  'LOL', 'WTF', 'OMG', 'SMH', 'NGL', 'EDIT', 'UPDATE',
  // Time/date
  'YTD', 'QOQ', 'YOY', 'EOD', 'EOW', 'EOM', 'EOQ', 'EOY', 'MTD', 'QTD',
  // Currencies/countries
  'USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY',
  'US', 'UK', 'EU', 'CA', 'AU',
  // Business entity suffixes
  'LLC', 'INC', 'LTD', 'CO', 'PLC', 'CORP',
  // Tech/general
  'AI', 'ML', 'DL', 'API', 'SAAS', 'PAAS', 'IAAS', 'B2B', 'B2C',
  // Misc common words
  'ALL', 'NEW', 'BIG', 'BAD', 'GET', 'GOT', 'PUT', 'SET', 'BUY', 'SELL',
  'HIGH', 'LOW', 'NEXT', 'LAST', 'PAST', 'BEST', 'GOOD', 'NICE',
  'YES', 'NOT', 'CAN', 'WILL', 'MAY', 'HAS', 'HAD', 'WAS', 'ARE', 'WERE',
  'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'BEEN', 'WHAT', 'WHEN', 'WHERE',
  'LIKE', 'JUST', 'THAN', 'THEN', 'ALSO', 'ONLY', 'BOTH', 'SAME', 'EACH',
  'MUCH', 'MANY', 'SOME', 'MORE', 'MOST', 'LESS',
  'LOSS', 'GAIN', 'HOLD', 'SOLD', 'BEEN',
]);

// SEC EDGAR response structure
interface SecEdgarResponse {
  fields: string[];
  data: Array<[number, string, string, string]>;
}

// Module-level cache (survives Lambda warm invocations)
let cachedTickers: Set<string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getNyseTickerSet(): Promise<Set<string>> {
  if (cachedTickers && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTickers;
  }

  const resp = await fetch('https://www.sec.gov/files/company_tickers_exchange.json', {
    headers: { 'User-Agent': 'StockMentionsBot contact@lagartejandro.com' },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch SEC ticker list: ${resp.status}`);
  }

  const data = (await resp.json()) as SecEdgarResponse;
  const tickerIdx = data.fields.indexOf('ticker');
  const exchangeIdx = data.fields.indexOf('exchange');

  cachedTickers = new Set(
    data.data
      .filter(row => {
        const exchange = row[exchangeIdx];
        return (
          exchange === 'NYSE' ||
          exchange === 'NYSE MKT' ||
          exchange === 'NYSE Arca' ||
          exchange === 'NYSE American'
        );
      })
      .map(row => String(row[tickerIdx]))
  );

  cacheTimestamp = Date.now();
  console.log(`Loaded ${cachedTickers!.size} NYSE tickers from SEC EDGAR`);
  return cachedTickers!;
}

// Extracts valid NYSE tickers from a block of text.
// Returns each unique ticker found (no duplicates per text block).
export function extractTickers(text: string, validTickers: Set<string>): string[] {
  const matches = text.match(/\b[A-Z]{1,5}\b/g);
  if (!matches) return [];

  const found = new Set<string>();
  for (const token of matches) {
    if (validTickers.has(token) && !BLOCKLIST.has(token)) {
      found.add(token);
    }
  }
  return [...found];
}
