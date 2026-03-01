#!/usr/bin/env tsx
/**
 * Trinidad and Tobago Law MCP -- Census Script
 *
 * Scrapes the full law catalog from laws.gov.tt (Digital Legislative Library).
 *
 * Portal structure:
 *   GET /ttdll-web/revision/list?offset=N (paginated by 10)
 *   Each page has <a href="...currentid=NNN#email-content"> links
 *   Each law has revisions with PDF downloads at:
 *     /ttdll-web/revision/download/[revisionId]?type=act
 *
 * We pick the most recent revision for each law (first download link on its detail panel).
 *
 * Source: https://laws.gov.tt
 *
 * Usage:
 *   npx tsx scripts/census.ts
 *   npx tsx scripts/census.ts --limit 100
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
const CENSUS_PATH = path.join(DATA_DIR, 'census.json');

const BASE_URL = 'https://laws.gov.tt';
const LIST_URL = `${BASE_URL}/ttdll-web/revision/list`;

/* ---------- Types ---------- */

interface RawLawEntry {
  title: string;
  chapter: string;
  currentId: string;
  pdfUrl: string;
}

/* ---------- HTML Parsing ---------- */

/**
 * Extract law entries from a listing page HTML.
 *
 * Actual HTML from laws.gov.tt listing:
 *   <li class="list-group-item">
 *     <a href="/ttdll-web/revision/list?offset=0&amp;q=&amp;currentid=490#email-content" class="clear text-ellipsis">
 *       <small class="pull-right"></small>
 *       <strong class="block">Absconding Debtors</strong>
 *       <small>Chapter 8:08</small>
 *     </a>
 *   </li>
 */
function extractLawsFromListing(html: string): { title: string; chapter: string; currentId: string }[] {
  const entries: { title: string; chapter: string; currentId: string }[] = [];

  // Two-pass approach for robustness:
  // 1. Find all currentid values linked with #email-content (listing entries only, not sidebar)
  // 2. For each, extract the <strong> title and <small> chapter that follow

  // Split the HTML into list-group-item blocks from the main listing
  const blocks = html.split('<li class="list-group-item">');

  for (const block of blocks) {
    // Only process blocks that have the #email-content anchor (listing items)
    if (!block.includes('#email-content')) continue;

    // Extract currentid
    const idMatch = block.match(/currentid=(\d+)(?:&amp;|&|#)/);
    if (!idMatch) continue;
    const currentId = idMatch[1];

    // Extract title from <strong> tag
    const titleMatch = block.match(/<strong[^>]*>([^<]+)<\/strong>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();

    // Extract chapter from <small> tag (skip the pull-right one)
    let chapter = '';
    const smallMatches = block.match(/<small>([^<]*)<\/small>/g);
    if (smallMatches) {
      for (const sm of smallMatches) {
        const inner = sm.replace(/<\/?small>/g, '').trim();
        if (inner.length > 0 && inner.toLowerCase().startsWith('chapter')) {
          chapter = inner;
          break;
        }
      }
    }

    if (title.length > 2 && currentId) {
      if (!entries.some(e => e.currentId === currentId)) {
        entries.push({ title, chapter, currentId });
      }
    }
  }

  return entries;
}

/**
 * Extract the most recent PDF download link from a law detail panel.
 * Pattern: /ttdll-web/revision/download/[ID]?type=act
 */
function extractLatestPdfUrl(html: string, currentId: string): string {
  // Look for download links in the section associated with this currentId
  const downloadRe = /\/ttdll-web\/revision\/download\/(\d+)\?type=act/g;
  const match = downloadRe.exec(html);
  if (match) {
    return `${BASE_URL}/ttdll-web/revision/download/${match[1]}?type=act`;
  }
  return '';
}

/**
 * Check if there is a next page link in the pagination HTML.
 */
function getNextOffset(html: string, currentOffset: number): number | null {
  const nextOffset = currentOffset + 10;
  // Check if the next offset link exists in pagination
  if (html.includes(`offset=${nextOffset}`)) {
    return nextOffset;
  }
  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function parseArgs(): { limit: number | null } {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { limit };
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const { limit } = parseArgs();

  console.log('Trinidad and Tobago Law MCP -- Census');
  console.log('======================================\n');
  console.log('  Source: laws.gov.tt (Digital Legislative Library)');
  console.log('  Method: HTML scraping (paginated listing)');
  if (limit) console.log(`  --limit ${limit}`);
  console.log('');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Phase 1: Paginate through all listing pages to collect law entries
  const allEntries: { title: string; chapter: string; currentId: string }[] = [];
  let offset = 0;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const url = `${LIST_URL}?offset=${offset}`;
    process.stdout.write(`  Page ${pageNum} (offset=${offset})...`);

    const result = await fetchWithRateLimit(url);
    if (result.status !== 200) {
      console.log(` HTTP ${result.status} -- stopping pagination`);
      break;
    }

    const entries = extractLawsFromListing(result.body);
    console.log(` ${entries.length} laws`);

    if (entries.length === 0) {
      break;
    }

    allEntries.push(...entries);

    // Check for limit on number of laws
    if (limit && allEntries.length >= limit) {
      break;
    }

    const nextOffset = getNextOffset(result.body, offset);
    if (nextOffset === null) {
      break;
    }
    offset = nextOffset;
  }

  // Deduplicate by currentId
  const seenIds = new Map<string, { title: string; chapter: string; currentId: string }>();
  for (const entry of allEntries) {
    if (!seenIds.has(entry.currentId)) {
      seenIds.set(entry.currentId, entry);
    }
  }
  const unique = Array.from(seenIds.values());
  console.log(`\n  Total unique laws discovered: ${unique.length}`);

  // Build law entries -- PDF URLs are resolved during ingestion (to avoid N+1 fetches)
  // Detail page URL: /ttdll-web/revision/list?offset=0&q=&currentid=NNN
  // (contains download links like /ttdll-web/revision/download/REVISION_ID?type=act)
  const lawsWithPdf: RawLawEntry[] = unique.map(entry => ({
    title: entry.title,
    chapter: entry.chapter,
    currentId: entry.currentId,
    pdfUrl: `${BASE_URL}/ttdll-web/revision/list?offset=0&q=&currentid=${entry.currentId}`,
  }));

  // Build census entries
  const laws = lawsWithPdf.map((entry) => {
    const id = `tt-${slugify(entry.title)}`;

    return {
      id,
      title: entry.title,
      identifier: entry.chapter || entry.title,
      url: entry.pdfUrl,
      status: 'in_force' as const,
      category: 'act' as const,
      classification: 'ingestable' as const,
      ingested: false,
      provision_count: 0,
      ingestion_date: null as string | null,
      issued_date: '',
      source_chapter: entry.chapter,
      portal_id: entry.currentId,
    };
  });

  const census = {
    schema_version: '2.0',
    jurisdiction: 'TT',
    jurisdiction_name: 'Trinidad and Tobago',
    portal: 'laws.gov.tt',
    census_date: new Date().toISOString().split('T')[0],
    agent: 'trinidadian-law-mcp/census.ts',
    summary: {
      total_laws: laws.length,
      ingestable: laws.filter(l => l.classification === 'ingestable').length,
      ocr_needed: 0,
      inaccessible: 0,
      excluded: 0,
    },
    laws,
  };

  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));

  console.log('\n==================================================');
  console.log('CENSUS COMPLETE');
  console.log('==================================================');
  console.log(`  Total laws discovered:  ${laws.length}`);
  console.log(`  Ingestable:             ${census.summary.ingestable}`);
  console.log(`\n  Output: ${CENSUS_PATH}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
