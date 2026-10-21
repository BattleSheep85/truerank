// Majority vote over repeated stance replies (CP-789).
import { mergeStanceVotes, STANCE_VOTES_DEFAULT } from '../../worker/engine/stance-votes.js';

export function runStanceVotesTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const row = (url, stance, span = '') => ({ url, stance, span });

  eq('default: three votes', STANCE_VOTES_DEFAULT, 3);
  eq('no votes: no rows', mergeStanceVotes([]), []);
  eq('one vote: its rows as they are', mergeStanceVotes([[row('a', 'support', 's1')]]), [row('a', 'support', 's1')]);

  eq('majority stance wins, with the span of its first vote',
    mergeStanceVotes([
      [row('a', 'neutral')],
      [row('a', 'support', 'span 2')],
      [row('a', 'support', 'span 3')],
    ]),
    [row('a', 'support', 'span 2')]);

  eq('three different stances: neutral, no span',
    mergeStanceVotes([[row('a', 'support', 'x')], [row('a', 'contradict', 'y')], [row('a', 'neutral')]]),
    [row('a', 'neutral')]);

  eq('a tie of two: neutral',
    mergeStanceVotes([[row('a', 'support', 'x')], [row('a', 'contradict', 'y')]]),
    [row('a', 'neutral')]);

  eq('a url only one vote judged keeps that vote',
    mergeStanceVotes([[row('a', 'support', 'x')], [], []]),
    [row('a', 'support', 'x')]);

  eq('urls keep the order they first appear in',
    mergeStanceVotes([[row('b', 'neutral'), row('a', 'neutral')], [row('a', 'neutral'), row('c', 'support', 'z')]]).map((r) => r.url),
    ['b', 'a', 'c']);

  // The merge must not depend on which vote came back first.
  const votes = [
    [row('a', 'support', 's1'), row('b', 'contradict', 'c1')],
    [row('a', 'support', 's2'), row('b', 'neutral')],
    [row('a', 'neutral'), row('b', 'contradict', 'c3')],
  ];
  const stances = (rows) => rows.map((r) => `${r.url}:${r.stance}`).sort();
  const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0]].map((o) => stances(mergeStanceVotes(o.map((i) => votes[i]))));
  eq('the same stances in any vote order', orders.every((s) => JSON.stringify(s) === JSON.stringify(orders[0])), true);
  eq('the stances are the majorities', orders[0], ['a:support', 'b:contradict']);

  const input = [[row('a', 'support', 'x')]];
  const before = JSON.stringify(input);
  mergeStanceVotes(input);
  eq('the input is not changed', JSON.stringify(input), before);
  eq('bad input: no rows', mergeStanceVotes(null), []);
  return report;
}
