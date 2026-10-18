// stance-votes.js — majority vote over repeated stance replies (CP-789).
//
// The stance judge (mimo-v2.6-flash) thinks before it answers, so even at
// temperature 0 the same claim and the same pages can get a different stance
// from one call to the next (live 2026-10-17: 1 to 2 of 8 claims changed
// verdict across replays of identical evidence). Asking it a few times and
// keeping the majority stance per source makes the verdict repeatable.

// How many times the primary judge answers each claim (ENGINE_CONFIG.stanceVotes).
export const STANCE_VOTES_DEFAULT = 3;

const NEUTRAL = 'neutral';

// The stance with strictly more votes than any other, else null (a tie).
function majorityStance(votes) {
  const counts = new Map();
  for (const v of votes) counts.set(v.stance, (counts.get(v.stance) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  return tied ? null : ranked[0][0];
}

/**
 * Merges the stance rows of several replies into one row per url. Each url
 * takes the majority stance of the replies that judged it; a tie (or three
 * different stances) is neutral with an empty span. The span is the one of
 * the first reply (in the given order) with the majority stance, so the
 * stances never depend on the order, and the span only on the order of the
 * votes. Urls keep the order they first appear in. Does not change its input.
 * @param {Array<Array<{url: string, stance: string, span: string}>>} voteRows
 * @returns {Array<{url: string, stance: string, span: string}>}
 */
export function mergeStanceVotes(voteRows) {
  if (!Array.isArray(voteRows)) return [];
  const byUrl = new Map();
  for (const rows of voteRows) {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!byUrl.has(r.url)) byUrl.set(r.url, []);
      byUrl.get(r.url).push(r);
    }
  }
  return [...byUrl.entries()].map(([url, votes]) => {
    const stance = majorityStance(votes);
    if (stance === null) return { url, stance: NEUTRAL, span: '' };
    return { url, stance, span: votes.find((v) => v.stance === stance).span };
  });
}
