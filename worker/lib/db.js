/**
 * D1 database helpers. All queries use parameterized statements.
 * research/products match schema/003_research_v2.sql. Timestamps on the new
 * tables are unix epoch SECONDS (INTEGER), not TEXT datetimes.
 */

import { nowEpoch, publicResearchFilter } from './utils.js';
import { CLUSTER_WINNER_ORDER } from './listable.js';

/**
 * Generate a short random ID (URL-safe, [a-z0-9]{16}).
 */
export function generateId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

// -- Research (permanent rows, server-rendered at /research/:slug) --

export async function insertResearch(db, { id, slug, query, canonicalQuery, squashedQuery, tier, clarifications }) {
    await db.prepare(
        `INSERT INTO research (id, slug, query, status, tier, canonical_query, squashed_query, clarifications, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).bind(id, slug, query, tier || 'full', canonicalQuery || null, squashedQuery || null, clarifications || null, nowEpoch()).run();
    return id;
}

export async function findResearchByCanonicalQuery(db, canonicalQuery, maxAgeDays = 14, squashedQuery = null) {
    if (!canonicalQuery) return null;
    const cutoff = nowEpoch() - maxAgeDays * 86400;
    // Require at least one product: a 'complete' row with zero products is a
    // degenerate run and must never absorb new queries into its cluster.
    return db.prepare(
        `SELECT * FROM research
         WHERE (canonical_query = ?1 OR (?2 IS NOT NULL AND ?2 != '' AND squashed_query = ?2))
           AND status = 'complete' AND created_at > ?3
           AND retired_at IS NULL
           AND EXISTS (SELECT 1 FROM products p WHERE p.research_id = research.id)
         ORDER BY created_at DESC LIMIT 1`
    ).bind(canonicalQuery, squashedQuery || null, cutoff).first();
}

export async function getResearchBySlug(db, slug) {
    return db.prepare('SELECT * FROM research WHERE slug = ?').bind(slug).first();
}

export async function getResearchById(db, id) {
    return db.prepare('SELECT * FROM research WHERE id = ?').bind(id).first();
}

// The slug of the report that wins this row's canonical-query cluster, per
// the single winner rule in worker/lib/listable.js (CLUSTER_WINNER_ORDER +
// publicResearchFilter). Used by the report page to point a non-winning
// cluster member's canonical link at the winner instead of at itself.
//
// A null canonicalQuery means the row is its own cluster of one (listable.js
// falls back to COALESCE(canonical_query, slug), and slug is unique) — the
// caller can skip the query and treat the row as its own winner.
//
// Cost: a single indexed lookup. idx_research_canonical (canonical_query,
// status, created_at) — schema/003_research_v2.sql — covers the leading
// `canonical_query = ?1` predicate and the `created_at` tiebreak scan; the
// remaining publicResearchFilter checks touch only the handful of rows in
// that one cluster, not the whole table.
export async function getClusterWinnerSlug(db, canonicalQuery) {
    if (!canonicalQuery) return null;
    const row = await db.prepare(
        `SELECT r.slug FROM research r
         WHERE r.canonical_query = ?1
           AND ${publicResearchFilter('r')}
         ORDER BY ${CLUSTER_WINNER_ORDER}
         LIMIT 1`
    ).bind(canonicalQuery).first();
    return row ? row.slug : null;
}

export async function updateResearchStatus(db, id, status) {
    await db.prepare('UPDATE research SET status = ? WHERE id = ?').bind(status, id).run();
}

// -- Products (v2 schema; pros/cons/specs/metadata are pre-serialized JSON text) --

export async function getProductsByResearchId(db, researchId) {
    return db.prepare('SELECT * FROM products WHERE research_id = ? ORDER BY rank ASC')
        .bind(researchId).all();
}

// Normalize a category string for comparison: lowercase, trim, collapse
// internal whitespace. Used both for the exact-match bind and to build the
// LIKE fallback token, so the two comparisons agree on what "the same
// category" means.
function normalizeCategory(category) {
    return String(category ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Find the most recent COMPLETED ranking research row (i.e. NOT a
// verification row — kind IS NULL or != 'verification') whose category best
// matches the given category string, plus its top N products ordered by
// rank. Used by the verification report's "Better alternatives" section to
// surface an existing ranking for the same product category. Returns null
// when no match exists. Both queries are fully parameterized.
export async function findRankingForCategory(db, category, limit = 3) {
    const normalized = normalizeCategory(category);
    if (!normalized) return null;

    // Prefer an exact normalized match against category/topical_category/
    // canonical_query; fall back to a LIKE on the category token so close
    // variants (e.g. "Mechanical Keyboards" vs "mechanical keyboard") still
    // hit. Remote D1 rejects LIKE patterns over 50 bytes, so cap the token.
    const likeToken = normalized.slice(0, 45);

    const research = await db.prepare(
        `SELECT * FROM research
         WHERE status = 'complete'
           AND retired_at IS NULL
           AND (kind IS NULL OR kind != 'verification')
           AND EXISTS (SELECT 1 FROM products p WHERE p.research_id = research.id)
           AND (
             LOWER(TRIM(category)) = ?1
             OR LOWER(TRIM(topical_category)) = ?1
             OR LOWER(TRIM(canonical_query)) = ?1
             OR LOWER(category) LIKE ?2
             OR LOWER(topical_category) LIKE ?2
           )
         ORDER BY
           CASE WHEN LOWER(TRIM(category)) = ?1
                  OR LOWER(TRIM(topical_category)) = ?1
                  OR LOWER(TRIM(canonical_query)) = ?1
                THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT 1`
    ).bind(normalized, `%${likeToken}%`).first();

    if (!research) return null;

    const productRows = await db.prepare(
        'SELECT * FROM products WHERE research_id = ? ORDER BY rank ASC LIMIT ?'
    ).bind(research.id, limit).all();

    return { research, products: productRows.results ?? [] };
}


// -- Affiliate Clicks --

export async function logAffiliateClick(db, { productId, reportId, network, ipHash }) {
    await db.prepare(
        `INSERT INTO affiliate_clicks (product_id, report_id, affiliate_network, ip_hash)
         VALUES (?, ?, ?, ?)`
    ).bind(productId, reportId, network || 'amazon', ipHash || '').run();
}

// -- Guide Clicks (static "best of" pages; no FK to products/reports) --

export async function logGuideClick(db, { guideSlug, productQuery, network, ipHash }) {
    await db.prepare(
        `INSERT INTO guide_clicks (guide_slug, product_query, affiliate_network, ip_hash)
         VALUES (?, ?, ?, ?)`
    ).bind(guideSlug || '', productQuery || '', network || 'amazon', ipHash || '').run();
}

// -- Feedback --

export async function insertFeedback(db, { reportId, rating, comment }) {
    await db.prepare(
        `INSERT INTO feedback (report_id, rating, comment) VALUES (?, ?, ?)`
    ).bind(reportId, rating, comment || '').run();
}
