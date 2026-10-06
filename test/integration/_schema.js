// Shared helper: apply the real D1 schema (migrations 001→002→003) to the
// in-memory test database. Each integration spec runs in its own isolated worker,
// so each applies the schema in a beforeAll.
import init from '../../schema/001_initial.sql?raw';
import guides from '../../schema/002_guide_clicks.sql?raw';
import v2 from '../../schema/003_research_v2.sql?raw';
import subscribers from '../../schema/005_subscribers.sql?raw';
import subscribersConsent from '../../schema/009_subscribers_consent.sql?raw';
import subscribersConfirm from '../../schema/013_subscribers_confirm.sql?raw';
import keywords from '../../schema/006_keyword_queue.sql?raw';
import users from '../../schema/007_users.sql?raw';
import claims from '../../schema/010_claims.sql?raw';
import productsNoFk from '../../schema/012_products_nofk.sql?raw';
import verification from '../../schema/011_verification.sql?raw';
import squashedQuery from '../../schema/014_squashed_query.sql?raw';
import processingStarted from '../../schema/015_processing_started.sql?raw';
import consentEvidence from '../../schema/016_subscribers_consent_evidence.sql?raw';
import retireSeoRows from '../../schema/017_retire_seo_rows.sql?raw';

export async function applySchema(db) {
  // 012 must precede 011: it drops the products->research FK so 011 can
  // rebuild `research` (mirrors the required prod ordering).
  for (const sql of [init, guides, v2, subscribers, subscribersConsent, subscribersConfirm, keywords, users, claims, productsNoFk, verification, squashedQuery, processingStarted, consentEvidence, retireSeoRows]) {
    const stmts = sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const s of stmts) await db.prepare(s).run();
  }
}
