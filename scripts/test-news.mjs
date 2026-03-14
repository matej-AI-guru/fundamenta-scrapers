/**
 * Test script (pure JS/ESM): diagnose news scraping without writing to DB.
 * Run: node scripts/test-news.mjs
 */
import { readFileSync } from 'fs';
import * as cheerio from 'cheerio';

try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch { /* CI */ }

const RSS_FEEDS = [
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/feed' },
  { source: 'Večernji list',    url: 'https://www.vecernji.hr/feeds/section/biznis' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/vijesti.php' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/analize.php' },
];

// All ZSE tickers + names (hardcoded for local test, no DB needed)
const TEST_STOCKS = [
  { ticker: 'ACI',   name: 'ACI d.d.' },
  { ticker: 'ADPL',  name: 'AD Plastik d.d.' },
  { ticker: 'KOEI',  name: 'Končar - Elektroindustrija d.d.' },
  { ticker: 'PODR',  name: 'Podravka d.d.' },
  { ticker: 'KRAS',  name: 'Kraš d.d.' },
  { ticker: 'ERNT',  name: 'Ericsson Nikola Tesla d.d.' },
  { ticker: 'HT',    name: 'Hrvatski Telekom d.d.' },
  { ticker: 'ZABA',  name: 'Zagrebačka banka d.d.' },
  { ticker: 'INA',   name: 'INA d.d.' },
  { ticker: 'SPAN',  name: 'Span d.d.' },
  { ticker: 'ATGR',  name: 'Atlantic Grupa d.d.' },
  { ticker: 'RIVP',  name: 'Riviera Adria d.d.' },
  { ticker: 'ARNT',  name: 'Arena Hospitality Group d.d.' },
];

const MAX_AGE_DAYS = 90;

function cleanName(name) {
  return name.replace(/\s+(d\.d\.|d\.o\.o\.|j\.d\.d\.|j\.t\.d\.?|d\.d)$/gi, '').trim();
}

function nameKeywords(cleanedName) {
  const name = cleanedName.toLowerCase();
  const keywords = [name];
  const firstPart = name.split(/\s*[-–—]\s*/)[0].trim();
  if (firstPart !== name && firstPart.length >= 3) keywords.push(firstPart);
  return keywords;
}

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractLink($el, $) {
  const linkText = $el.find('link').first().text().trim();
  if (linkText.startsWith('http')) return linkText;
  const linkHref = $el.find('link[href]').first().attr('href') ?? '';
  if (linkHref.startsWith('http')) return linkHref;
  return $el.find('guid').first().text().trim();
}

async function fetchFeed(source, feedUrl, cutoff) {
  try {
    const resp = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.log(`  ✗ [${source}] HTTP ${resp.status}`); return []; }
    const xml = await resp.text();
    const $ = cheerio.load(xml, { xml: true });
    const articles = [];
    $('item').each((_i, el) => {
      const $el = $(el);
      const title = decodeEntities($el.find('title').first().text().trim());
      const url = extractLink($el, $);
      const pubDateStr = $el.find('pubDate').first().text().trim();
      if (!title || !url) return;
      const published = pubDateStr ? new Date(pubDateStr) : new Date();
      if (isNaN(published.getTime()) || published < cutoff) return;
      articles.push({ title, url, source, published_at: published.toISOString() });
    });
    console.log(`  ✓ [${source}] ${articles.length} fresh articles`);
    return articles;
  } catch (e) {
    console.log(`  ✗ [${source}] ERROR: ${e.message}`);
    return [];
  }
}

function matchesCompany(article, ticker, cleanedName) {
  const title = article.title.toLowerCase();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const keyword of nameKeywords(cleanedName)) {
    if (keyword.length >= 5 && title.includes(keyword)) return `substring "${keyword}"`;
    if (new RegExp(`\\b${esc(keyword)}\\b`).test(title)) return `word-boundary "${keyword}"`;
  }
  if (new RegExp(`\\b${esc(ticker.toLowerCase())}\\b`).test(title)) return `ticker "${ticker}"`;
  return null;
}

async function main() {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  console.log('\n══════════════════════════════════════════════');
  console.log('  1. RSS feed dostupnost i članci');
  console.log('══════════════════════════════════════════════');
  const allArticles = [];
  for (const feed of RSS_FEEDS) {
    const articles = await fetchFeed(feed.source, feed.url, cutoff);
    allArticles.push(...articles);
  }
  console.log(`\nUkupno: ${allArticles.length} svježih članaka\n`);

  if (!allArticles.length) {
    console.error('Nema članaka — svi RSS feedovi su nedostupni!');
    process.exit(1);
  }

  // Print all article titles grouped by source
  for (const feed of RSS_FEEDS) {
    const feedArticles = allArticles.filter(a => a.source === feed.source);
    if (feedArticles.length) {
      console.log(`  [${feed.source}] primjeri:`);
      feedArticles.slice(0, 5).forEach(a => console.log(`    "${a.title.slice(0, 85)}"`));
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  2. Matching za test dionice (dry run)');
  console.log('══════════════════════════════════════════════');
  let anyMatch = false;
  for (const stock of TEST_STOCKS) {
    const cleaned = cleanName(stock.name);
    const keywords = nameKeywords(cleaned);
    const matches = allArticles
      .map(a => ({ reason: matchesCompany(a, stock.ticker, cleaned), article: a }))
      .filter(m => m.reason);

    if (matches.length) {
      anyMatch = true;
      console.log(`\n  ✓ ${stock.ticker} (keywords: ${keywords.map(k => `"${k}"`).join(', ')}) — ${matches.length} match(es):`);
      matches.slice(0, 4).forEach(m =>
        console.log(`    [${m.reason}] "${m.article.title.slice(0, 80)}" — ${m.article.source}`)
      );
    } else {
      console.log(`  ✗ ${stock.ticker} (keywords: ${keywords.map(k => `"${k}"`).join(', ')}) — nema podudaranja`);
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log(anyMatch ? '  ✓ Matching radi — spreman za push' : '  ✗ Nema matcheva — provjeri feedove');
  console.log('══════════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
