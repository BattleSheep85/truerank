/**
 * Category hubs: /best/:categorySlug
 *
 * The dynamic "Best {category}" hubs are retired (refocus 2026-10, spec D4).
 * renderCategoryHub always returns null, so the router answers 404 after the
 * static guide probe. listCategories always returns an empty list, so the
 * sitemap hub list and the browse category strip are empty.
 *
 * The exports stay because routes/pages.js, lib/sitemap.js, and
 * pages/browse.js import them. Removal of those callers is backlog B10.
 */

// A hub with fewer guides than this is thin. lib/sitemap.js still reads it.
export const MIN_HUB_GUIDES = 2;

/**
 * Hubs are retired. Always returns null.
 * @param {string} _category The requested category slug.
 * @param {object} _env Worker env bindings.
 * @returns {Promise<null>}
 */
export async function renderCategoryHub(_category, _env) {
    return null;
}

/**
 * Hubs are retired. Always returns an empty list.
 * @param {object} _env Worker env bindings.
 * @returns {Promise<Array<{ category: string, slug: string, count: number }>>}
 */
export async function listCategories(_env) {
    return [];
}
