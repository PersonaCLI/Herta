import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 9 as const;

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  lang TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(entity_id, alias)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  url TEXT,
  category TEXT,
  source_hash TEXT NOT NULL,
  source_mtime_ms INTEGER,
  page_subject_entity_id TEXT REFERENCES entities(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  section_path TEXT NOT NULL,
  speaker TEXT,
  speaker_entity_id TEXT REFERENCES entities(id),
  author_entity_id TEXT REFERENCES entities(id),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  is_dialogue INTEGER NOT NULL DEFAULT 0,
  is_herta_voice_evidence INTEGER NOT NULL DEFAULT 0,
  is_canon_fact_candidate INTEGER NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0,
  UNIQUE(document_id, ordinal)
);

-- External-content FTS5: index only, no own copy of text.
-- SqliteKnowledgeStore must keep chunks_fts + chunk_fts_map synchronized
-- with chunks on every insert/update/delete.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title,
  section_path,
  speaker,
  text,
  content='',
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS chunk_fts_map (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  referent_entity_id TEXT NOT NULL REFERENCES entities(id),
  embodiment_entity_id TEXT REFERENCES entities(id),
  speaker_entity_id TEXT REFERENCES entities(id),
  page_subject_entity_id TEXT REFERENCES entities(id),
  confidence REAL NOT NULL,
  method TEXT NOT NULL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entities(id),
  relation TEXT NOT NULL,
  target_entity_id TEXT NOT NULL REFERENCES entities(id),
  evidence_chunk_id TEXT REFERENCES chunks(id),
  confidence REAL NOT NULL,
  method TEXT NOT NULL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  text_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  data_root TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  llm_call_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS llm_annotations (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_json TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_overrides (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  override_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_speaker_entity ON chunks(speaker_entity_id);
CREATE INDEX IF NOT EXISTS idx_chunks_author_entity ON chunks(author_entity_id);
CREATE INDEX IF NOT EXISTS idx_chunks_voice ON chunks(is_herta_voice_evidence, quality_score);
CREATE INDEX IF NOT EXISTS idx_mentions_referent ON entity_mentions(referent_entity_id, confidence);
CREATE INDEX IF NOT EXISTS idx_mentions_surface ON entity_mentions(surface);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_entity_id, relation);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_entity_id, relation);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_annotations_input_hash ON llm_annotations(input_hash);
`;

const DDL_V2 = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  subject_entity_id TEXT NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,
  object_entity_id TEXT REFERENCES entities(id),
  value TEXT,
  qualifiers_json TEXT,
  evidence_chunk_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rationale TEXT,
  created_at TEXT NOT NULL,
  supersedes_claim_id TEXT REFERENCES claims(id)
);

CREATE INDEX IF NOT EXISTS idx_claims_subject_predicate
  ON claims(subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_claims_status_predicate
  ON claims(status, predicate);
CREATE INDEX IF NOT EXISTS idx_claims_supersedes
  ON claims(supersedes_claim_id);
`;

const DDL_V3 = `
CREATE TABLE IF NOT EXISTS wiki_pages (
  entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  content_json TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  source_chunk_ids_json TEXT NOT NULL
);
`;

// NOTE (2026-07-14): the voice-profile GENERATION pipeline (voice-discover /
// voice-validate / voice-eval / voice-snapshot) was retired and its code
// removed. The voice_profile_candidates / voice_profiles / voice_profiles_history /
// voice_eval_runs DDL below stays as-is — migrations are append-only and
// existing DBs keep their rows as historical data. Runtime still reads
// voice_profiles via SqliteKnowledgeStore.getVoiceProfile (self-model CLI).
const DDL_V4 = `
CREATE TABLE IF NOT EXISTS voice_evidence_strata (
  chunk_id            TEXT PRIMARY KEY,
  speaker_entity_id   TEXT NOT NULL,
  addressee_class     TEXT NOT NULL,
  addressee_entity_id TEXT,
  classifier_version  INTEGER NOT NULL,
  classified_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strata_speaker_addressee
  ON voice_evidence_strata (speaker_entity_id, addressee_class);

CREATE TABLE IF NOT EXISTS voice_profile_candidates (
  id                    TEXT PRIMARY KEY,
  entity_id             TEXT NOT NULL,
  register_class        TEXT NOT NULL,
  round                 INTEGER NOT NULL,
  candidate_json        TEXT NOT NULL,
  source_chunk_ids_json TEXT NOT NULL,
  prompt_hash           TEXT NOT NULL,
  generated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_entity_register_round
  ON voice_profile_candidates (entity_id, register_class, round);

CREATE TABLE IF NOT EXISTS voice_profiles (
  entity_id                    TEXT PRIMARY KEY,
  schema_version               INTEGER NOT NULL,
  default_register_json        TEXT NOT NULL,
  relationship_registers_json  TEXT NOT NULL,
  anti_patterns_json           TEXT NOT NULL,
  evidence_chunk_ids_json      TEXT NOT NULL,
  generated_at                 TEXT NOT NULL,
  source_round                 INTEGER NOT NULL
);
`;

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // One writer from the first step to the last (review 2026-11-10, second
  // pass). Each step looks at the schema and then changes it, and the steps
  // ran one statement at a time: two processes opening a database that
  // still needed a step both saw the column missing, and the second to add
  // it failed with "duplicate column name". `BEGIN IMMEDIATE` makes the
  // second wait, and then see what the first did. A step that fails also
  // leaves nothing half-applied.
  db.transaction(() => {
    db.exec(DDL_V1);
    recordVersion(db, 1);

    db.exec(DDL_V2);
    recordVersion(db, 2);

    db.exec(DDL_V3);
    recordVersion(db, 3);

    db.exec(DDL_V4);
    recordVersion(db, 4);

    applyV5(db);
    recordVersion(db, 5);

    applyV6(db);
    recordVersion(db, 6);

    applyV7(db);
    recordVersion(db, 7);

    applyV8(db);
    recordVersion(db, 8);

    applyV9(db);
    recordVersion(db, 9);
  }).immediate();
}

/**
 * v5 — extend `voice_profiles` with `self_narration_json` so that R2 can
 * land validated `self_narration` register entries on the profile row.
 *
 * `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` form, so this guards
 * by inspecting `PRAGMA table_info(voice_profiles)` and skipping the ALTER
 * when the column is already present. Idempotent across re-applies.
 */
function applyV5(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(voice_profiles)").all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === "self_narration_json")) return;
  db.exec(
    "ALTER TABLE voice_profiles ADD COLUMN self_narration_json TEXT NOT NULL DEFAULT '{}'",
  );
}

/**
 * v6 — extend voice stratification + candidates with LLM-pass metadata.
 *
 *   - voice_evidence_strata gets per-pass verdicts, consensus source,
 *     grounded citations, mood / register_mode tags, and a heuristic-vs-LLM
 *     disagreement flag.
 *   - voice_profile_candidates gets pass_run + consensus markers so R2 can
 *     filter to consensus-only candidates.
 *   - voice_profiles gets evidence_strata_version.
 *   - voice_profiles_history is created to archive snapshots of voice_profiles.
 *   - voice_eval_runs is created to track voice profile evaluation runs.
 *
 * All ALTERs are guarded via PRAGMA table_info inspection so re-applying the
 * migration is a no-op. CREATE TABLE IF NOT EXISTS statements are naturally
 * idempotent.
 */
function applyV6(db: Database.Database): void {
  const strataCols = db
    .prepare("PRAGMA table_info(voice_evidence_strata)")
    .all() as Array<{ name: string }>;
  const strataNames = new Set(strataCols.map((c) => c.name));
  const strataAdds: ReadonlyArray<[string, string]> = [
    ["addressee_entity_id_llm", "TEXT"],
    ["mood", "TEXT"],
    ["register_mode", "TEXT"],
    ["grounded_citation", "TEXT"],
    ["confidence", "REAL"],
    ["source", "TEXT NOT NULL DEFAULT 'heuristic'"],
    ["disagreement_with_heuristic", "INTEGER NOT NULL DEFAULT 0"],
    ["pass_a_verdict_json", "TEXT"],
    ["pass_b_verdict_json", "TEXT"],
  ];
  for (const [name, type] of strataAdds) {
    if (!strataNames.has(name)) {
      db.exec(`ALTER TABLE voice_evidence_strata ADD COLUMN ${name} ${type}`);
    }
  }

  const candCols = db
    .prepare("PRAGMA table_info(voice_profile_candidates)")
    .all() as Array<{ name: string }>;
  const candNames = new Set(candCols.map((c) => c.name));
  if (!candNames.has("pass_run")) {
    db.exec(
      "ALTER TABLE voice_profile_candidates ADD COLUMN pass_run INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!candNames.has("consensus")) {
    db.exec(
      "ALTER TABLE voice_profile_candidates ADD COLUMN consensus INTEGER NOT NULL DEFAULT 0",
    );
  }

  const profileCols = db
    .prepare("PRAGMA table_info(voice_profiles)")
    .all() as Array<{ name: string }>;
  const profileNames = new Set(profileCols.map((c) => c.name));
  if (!profileNames.has("evidence_strata_version")) {
    db.exec(
      "ALTER TABLE voice_profiles ADD COLUMN evidence_strata_version INTEGER",
    );
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS voice_profiles_history (
  history_id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id                    TEXT NOT NULL,
  schema_version               INTEGER NOT NULL,
  default_register_json        TEXT NOT NULL,
  relationship_registers_json  TEXT NOT NULL,
  anti_patterns_json           TEXT NOT NULL,
  evidence_chunk_ids_json      TEXT NOT NULL,
  self_narration_json          TEXT NOT NULL DEFAULT '{}',
  generated_at                 TEXT NOT NULL,
  source_round                 INTEGER NOT NULL,
  evidence_strata_version      INTEGER,
  archived_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_profiles_history_entity_archived
  ON voice_profiles_history (entity_id, archived_at DESC);

CREATE TABLE IF NOT EXISTS voice_eval_runs (
  id                                       TEXT PRIMARY KEY,
  eval_set_version                         INTEGER NOT NULL,
  voice_profiles_evidence_strata_version   INTEGER NOT NULL,
  prompt_index                             INTEGER NOT NULL,
  prompt_text                              TEXT NOT NULL,
  assistant_text                           TEXT NOT NULL,
  validated_phrases_present_json           TEXT NOT NULL,
  anti_patterns_present_json               TEXT NOT NULL,
  code_switch_count                        INTEGER NOT NULL,
  ran_at                                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_eval_runs_strata_version
  ON voice_eval_runs (voice_profiles_evidence_strata_version);
`);
}

/**
 * v7 — Phase 6 of the self-model build pipeline. Stores the synthesized
 * `HertaSelfModelV1` payload (Pass 2 output) plus its judge report
 * (Pass 3b) under the same row, keyed by entity_id with shipped_at as
 * the recency index. Multiple ships per entity are kept as history;
 * runtime consumers read the latest row by `MAX(shipped_at)`.
 *
 *   - `payload_json`         — the full HertaSelfModelV1 JSON.
 *   - `judge_report_json`    — Pass 3b output, optional (NULL if shipped
 *                              without a judge run).
 *   - `source_facts_hash`    — sha256 over the Pass 1 facts that fed Pass 2,
 *                              used to skip re-ship when the input is unchanged.
 *   - `shipped_at`           — ISO 8601 timestamp written at ship time.
 *
 * Indexed by (entity_id, shipped_at DESC) so the runtime's "latest by entity"
 * lookup is a single row read.
 */
function applyV7(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS self_models (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id           TEXT NOT NULL REFERENCES entities(id),
  schema_version      INTEGER NOT NULL,
  payload_json        TEXT NOT NULL,
  judge_report_json   TEXT,
  source_facts_hash   TEXT,
  shipped_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_models_entity_shipped
  ON self_models (entity_id, shipped_at DESC);
`);
}

/**
 * v8 — EN interaction language slice 2 (2026-07-14). Official-localization
 * translations of canon chunks, resolved through the aligned TextMaps
 * (CN line → shared hash → EN line; see glossary/textmap-glossary.ts).
 * One row per (chunk, lang); the voice pipeline's EN consumers join this
 * against `voice_evidence_strata`, so the CN addressee/mood analysis
 * carries over to the EN text for free.
 *
 *   - `text`          — the official localized line (never machine-translated).
 *   - `textmap_hash`  — the TextMap key witnessing the alignment.
 *   - `match_kind`    — "exact" (raw string equality with the CN TextMap
 *                       line) or "normalized" (matched after stripping
 *                       whitespace/punctuation/markup variance).
 */
function applyV8(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS chunk_translations (
  chunk_id      TEXT NOT NULL REFERENCES chunks(id),
  lang          TEXT NOT NULL,
  text          TEXT NOT NULL,
  textmap_hash  TEXT NOT NULL,
  match_kind    TEXT NOT NULL,
  aligned_at    TEXT NOT NULL,
  PRIMARY KEY (chunk_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_chunk_translations_lang
  ON chunk_translations (lang);
`);
}

/**
 * v9 — index `entity_mentions(chunk_id)`. SQLite does not auto-index foreign-key
 * columns, so the two ingest claim passes (listChunkSignalsForClaims,
 * listChunkSignalsForLlmClaims) and searchLore's per-hit lookup ran a full
 * `entity_mentions` scan per chunk — O(N_chunks × N_mentions) over the whole
 * corpus, twice per rebuild. This index turns each into a seek. Idempotent.
 */
function applyV9(db: Database.Database): void {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_mentions_chunk ON entity_mentions(chunk_id);",
  );
}

function recordVersion(db: Database.Database, version: number): void {
  const existing = db
    .prepare("SELECT version FROM schema_version WHERE version = ?")
    .get(version) as { version: number } | undefined;
  if (existing === undefined) {
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
    ).run(version, new Date().toISOString());
  }
}
