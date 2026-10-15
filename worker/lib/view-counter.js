/**
 * View counting that does not scale writes linearly with traffic.
 *
 * Every report page view used to issue its own `UPDATE research SET
 * view_count = view_count + 1`, on BOTH the KV cache-hit path
 * (worker/routes/pages.js) and the render path (worker/pages/research-page.js).
 * One D1 write per view is fine at a few hundred views a day and becomes the
 * dominant write load as traffic grows, on a surface that is otherwise served
 * entirely from the KV page cache.
 *
 * Fix: sampled counting above a threshold. Below COUNT_EXACTLY_BELOW every
 * view writes, so new and low-traffic pages keep exact counts and the ordering
 * that ranking depends on stays stable where the numbers are small. At or
 * above the threshold, a view writes with probability 1/SAMPLE_RATE and adds
 * SAMPLE_RATE when it does. The expected value is unchanged (each view still
 * contributes exactly 1 on average), so `ORDER BY view_count` keeps ranking the
 * same pages in the same order, while the write rate on the hottest pages
 * drops by SAMPLE_RATE.
 *
 * view_count is a popularity signal used for ranking and reporting, never for
 * billing or quota, so trading exactness for a bounded write rate is the right
 * trade at this surface.
 */

// Below this many recorded views, count every single view. Covers new pages,
// long-tail pages, and anything where sampling noise would be visible.
export const COUNT_EXACTLY_BELOW = 100;

// Above the threshold, write on 1 view in SAMPLE_RATE and add SAMPLE_RATE.
export const SAMPLE_RATE = 10;

/**
 * Decide whether this view writes, and by how much.
 *
 * Pure, so the policy is unit-testable without D1 or a random source.
 *
 * @param {number|null|undefined} currentCount view_count already recorded.
 * @param {number} roll A value in [0, 1). Inject Math.random() at the call site.
 * @returns {number} How much to add. 0 means skip the write entirely.
 */
export function viewIncrement(currentCount, roll) {
    const count = Number.isFinite(currentCount) ? currentCount : 0;
    if (count < COUNT_EXACTLY_BELOW) return 1;
    return roll < 1 / SAMPLE_RATE ? SAMPLE_RATE : 0;
}

/**
 * Parse the KV page-cache meta value.
 *
 * The value used to be a bare Unix-seconds integer. It is now JSON carrying
 * both the last-modified stamp and the view count the sampling policy needs.
 * Old bare-integer values still parse, and report an unknown count, which
 * makes the caller count exactly. That is the safe direction, and it
 * self-heals within one cache TTL.
 *
 * @param {string|null|undefined} raw
 * @returns {{lastModified: number|undefined, viewCount: number}}
 */
export function parsePageMeta(raw) {
    if (!raw) return { lastModified: undefined, viewCount: 0 };
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const lm = Number(parsed.lm);
            const vc = Number(parsed.vc);
            return {
                lastModified: Number.isFinite(lm) ? lm : undefined,
                viewCount: Number.isFinite(vc) ? vc : 0,
            };
        }
    } catch {
        // Legacy bare integer, handled below.
    }
    const legacy = parseInt(raw, 10);
    return { lastModified: Number.isFinite(legacy) ? legacy : undefined, viewCount: 0 };
}

/**
 * Build the KV page-cache meta value.
 *
 * @param {number} lastModified Unix seconds.
 * @param {number} viewCount view_count at render time.
 * @returns {string}
 */
export function buildPageMeta(lastModified, viewCount) {
    return JSON.stringify({ lm: lastModified, vc: Number.isFinite(viewCount) ? viewCount : 0 });
}

/**
 * Record one view of a completed report, sampled.
 *
 * Never throws and never blocks the response: callers pass the returned
 * promise to ctx.waitUntil, or ignore it.
 *
 * @param {{ prepare: Function }} db D1 binding.
 * @param {{ id?: string, slug?: string, view_count?: number }} entry
 *   The research row. `id` is preferred; `slug` is used when only the cached
 *   page key is known.
 * @returns {Promise<void>}
 */
export async function recordView(db, entry) {
    if (!db || !entry) return;
    const delta = viewIncrement(entry.view_count, Math.random());
    if (delta === 0) return;

    try {
        if (entry.id) {
            await db.prepare('UPDATE research SET view_count = view_count + ?1 WHERE id = ?2')
                .bind(delta, entry.id).run();
        } else if (entry.slug) {
            await db.prepare("UPDATE research SET view_count = view_count + ?1 WHERE slug = ?2 AND status = 'complete'")
                .bind(delta, entry.slug).run();
        }
    } catch (err) {
        console.error('[view-counter] update failed:', err instanceof Error ? err.message : String(err));
    }
}
