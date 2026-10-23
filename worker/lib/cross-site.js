/**
 * Cross-site guard for POST endpoints that start paid work (CP-894).
 *
 * A no-cors fetch with a text/plain body is a "simple" request: the browser
 * sends it with no preflight, so CORS alone does not stop another site from
 * starting a run through its visitors' browsers. A browser always sends
 * Origin on a cross-origin POST, and modern engines also send Sec-Fetch-Site.
 * A server caller sends neither, so it passes.
 */

import { isWorkerAuthed } from './worker-auth.js';

export const CROSS_SITE_ERROR = 'Cross-site requests are not accepted';

export function isCrossSiteBrowser(request) {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return true;
    const origin = request.headers.get('Origin');
    return Boolean(origin) && origin !== new URL(request.url).origin;
}

/** True when a cross-site browser request lacks the X-Worker-Secret. */
export async function refuseCrossSite(request, env) {
    if (!isCrossSiteBrowser(request)) return false;
    return !(await isWorkerAuthed(request, env));
}
