/**
 * Start one paid research run: insert the permanent research row, then
 * enqueue the job. Shared by POST /api/research and the disagreement
 * re-run (worker/lib/disagreement.js). Callers own every gate (cache,
 * rate limits, spend gate, monthly budget); this module only starts the run.
 */

import { generateId, insertResearch } from './db.js';
import { generateSlug } from './utils.js';

/**
 * @returns {Promise<{ ok: boolean, id: string, slug: string }>}
 *   ok=false means the queue send failed and the row is now 'failed'.
 */
export async function startResearchRun(env, {
    query, canonicalQuery, squashedQuery, clarifications = null, bypassSearchCache = false,
}) {
    // Slug mirrors Exhaustive's shape: slugify(query) + '-' + first 8 chars of the id.
    const id = generateId();
    const slug = generateSlug(query, id);
    await insertResearch(env.DB, { id, slug, query, canonicalQuery, squashedQuery, clarifications });

    // If the queue send throws (transient Queues outage, binding misconfiguration),
    // flip the already-inserted row to failed so it doesn't orphan as 'pending'.
    try {
        await env.RESEARCH_QUEUE.send({
            reportId: id,
            query,
            ...(bypassSearchCache ? { bypassSearchCache: true } : {}),
        });
    } catch (err) {
        console.error(`[research-run] queue send failed for ${id}:`, err instanceof Error ? err.message : String(err));
        try {
            await env.DB.prepare("UPDATE research SET status = 'failed' WHERE id = ?").bind(id).run();
        } catch (markErr) {
            console.error(`[research-run] could not mark ${id} failed:`, markErr instanceof Error ? markErr.message : String(markErr));
        }
        return { ok: false, id, slug };
    }
    return { ok: true, id, slug };
}
