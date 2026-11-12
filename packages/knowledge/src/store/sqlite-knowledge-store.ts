import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AddresseeClass,
  CanonChunk,
  CanonClaim,
  CanonDocument,
  CanonEdge,
  CanonEntityId,
  ChunkTranslation,
  EntityMention,
  Mood,
  RegisterMode,
  StratumSource,
  VoiceEvidenceStratum,
  VoiceEvidenceStratumLlm,
  VoiceProfile,
  WikiPage,
} from "../schema.js";
import { SEED_EDGES, SEED_ENTITIES } from "../seed/entities.js";
import { applyMigrations } from "./migrations.js";

export interface OpenStoreOptions {
  dbPath: string;
  readonly?: boolean;
}

/** One referent an ambiguous alias may resolve to (`resolveAmbiguousAlias`). */
export interface EntityCandidate {
  entityId: string;
  canonicalName: string;
  type: string;
}

export interface FtsHit {
  chunkId: string;
  rank: number;
}

export interface LlmAnnotationRecord {
  id: string;
  chunkId: string;
  provider: string;
  model: string;
  task: string;
  inputHash: string;
  outputJson: string;
  confidence?: number;
  createdAt: string;
}

export interface CanonEdgeRow {
  id: string;
  sourceEntityId: string;
  relation: string;
  targetEntityId: string;
  evidenceChunkId?: string;
  confidence: number;
  method: string;
  rationale?: string;
}

export interface ChunkWithDocument {
  chunk: {
    id: string;
    documentId: string;
    ordinal: number;
    sectionPath: string[];
    speaker?: string;
    speakerEntityId?: string;
    authorEntityId?: string;
    text: string;
    isDialogue: boolean;
    isHertaVoiceEvidence: boolean;
    isCanonFactCandidate: boolean;
    qualityScore: number;
  };
  document: {
    id: string;
    title: string;
    path: string;
    url?: string;
    kind: string;
  };
}

interface ClaimRow {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string | null;
  value: string | null;
  qualifiersJson: string | null;
  evidenceChunkIdsJson: string;
  confidence: number;
  method: string;
  status: string;
  rationale: string | null;
  createdAt: string;
  supersedesClaimId: string | null;
}

function claimRowToCanon(row: ClaimRow): CanonClaim {
  return {
    id: row.id,
    subjectEntityId: row.subjectEntityId,
    predicate: row.predicate,
    objectEntityId: row.objectEntityId ?? undefined,
    value: row.value ?? undefined,
    qualifiersJson: row.qualifiersJson ?? undefined,
    evidenceChunkIds: JSON.parse(row.evidenceChunkIdsJson) as string[],
    confidence: row.confidence,
    method: row.method as CanonClaim["method"],
    status: row.status as CanonClaim["status"],
    rationale: row.rationale ?? undefined,
    createdAt: row.createdAt,
    supersedesClaimId: row.supersedesClaimId ?? undefined,
  };
}

/** Render raw text as a safe FTS5 query: each whitespace-separated term
 *  becomes a quoted string (internal `"` doubled per FTS5's escape rule).
 *  Empty input yields "" — the caller returns no hits rather than passing
 *  an invalid empty MATCH. See searchFts (audit 2026-07-10, finding 23). */
function toFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export class SqliteKnowledgeStore {
  private constructor(private readonly db: Database.Database) {}

  static openOrCreate(opts: OpenStoreOptions): SqliteKnowledgeStore {
    if (!opts.readonly) {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    const db = new Database(
      opts.dbPath,
      opts.readonly ? { readonly: true } : {},
    );
    try {
      if (!opts.readonly) {
        applyMigrations(db);
        seedEntities(db);
        seedEdges(db);
      } else {
        db.pragma("foreign_keys = ON");
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new SqliteKnowledgeStore(db);
  }

  close(): void {
    this.db.close();
  }

  // --- entities & aliases ---

  getEntity(
    id: CanonEntityId,
  ): { id: string; type: string; canonicalName: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, type, canonical_name AS canonicalName FROM entities WHERE id = ?",
      )
      .get(id) as
      | { id: string; type: string; canonicalName: string }
      | undefined;
    return row;
  }

  getAliases(
    id: CanonEntityId,
  ): Array<{ alias: string; lang: string | null; priority: number }> {
    return this.db
      .prepare("SELECT alias, lang, priority FROM aliases WHERE entity_id = ?")
      .all(id) as Array<{
      alias: string;
      lang: string | null;
      priority: number;
    }>;
  }

  resolveAmbiguousAlias(alias: string): EntityCandidate[] {
    const direct = this.db
      .prepare(
        `SELECT a.entity_id AS entityId, e.type, e.canonical_name AS canonicalName
         FROM aliases a JOIN entities e ON e.id = a.entity_id
         WHERE a.alias = ?`,
      )
      .get(alias) as
      | { entityId: string; type: string; canonicalName: string }
      | undefined;
    if (direct === undefined) return [];
    if (direct.type !== "ambiguous") {
      return [
        {
          entityId: direct.entityId,
          canonicalName: direct.canonicalName,
          type: direct.type,
        },
      ];
    }
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a2.entity_id AS entityId, e2.type, e2.canonical_name AS canonicalName
         FROM aliases a2 JOIN entities e2 ON e2.id = a2.entity_id
         WHERE a2.alias LIKE ? AND e2.type != 'ambiguous'`,
      )
      .all(`%${alias}%`) as Array<{
      entityId: string;
      type: string;
      canonicalName: string;
    }>;
    return rows.map((r) => ({
      entityId: r.entityId,
      canonicalName: r.canonicalName,
      type: r.type,
    }));
  }

  // --- documents ---

  upsertDocument(doc: CanonDocument): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, kind, title, path, url, category, source_hash, source_mtime_ms, page_subject_entity_id, created_at)
         VALUES (@id, @kind, @title, @path, @url, @category, @sourceHash, @sourceMtimeMs, @pageSubjectEntityId, @createdAt)
         ON CONFLICT(path) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           url = excluded.url,
           category = excluded.category,
           source_hash = excluded.source_hash,
           source_mtime_ms = excluded.source_mtime_ms,
           page_subject_entity_id = excluded.page_subject_entity_id`,
      )
      .run({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        path: doc.path,
        url: doc.url ?? null,
        category: doc.category ?? null,
        sourceHash: doc.sourceHash,
        sourceMtimeMs: doc.sourceMtimeMs ?? null,
        pageSubjectEntityId: doc.pageSubjectEntityId ?? null,
        createdAt: doc.createdAt,
      });
  }

  getDocumentByPath(path: string): CanonDocument | undefined {
    const row = this.db
      .prepare(
        `SELECT id, kind, title, path, url, category, source_hash AS sourceHash,
                source_mtime_ms AS sourceMtimeMs,
                page_subject_entity_id AS pageSubjectEntityId,
                created_at AS createdAt
         FROM documents WHERE path = ?`,
      )
      .get(path) as CanonDocument | undefined;
    return row;
  }

  /** The ids of the chunks a document already has. */
  chunkIdsOfDocument(documentId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT id FROM chunks WHERE document_id = ?")
      .all(documentId) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /** Remove every mention on a document's chunks: an ingest that was cut
   *  after some of them writes them all again. */
  deleteMentionsOfDocument(documentId: string): void {
    this.db
      .prepare(
        `DELETE FROM entity_mentions
         WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)`,
      )
      .run(documentId);
  }

  // --- chunks + FTS ---

  // Note: the FTS row denormalizes documents.title at insert time. If
  // upsertDocument later changes the title for an existing document,
  // its existing FTS rows go stale. Phase 1 ingest is rebuild-only
  // (--force deletes the DB); Phase 2 incremental updates must either
  // refresh FTS rows on title change or stop denormalizing title.
  insertChunk(chunk: CanonChunk): void {
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, document_id, ordinal, section_path, speaker, speaker_entity_id, author_entity_id, text, text_hash, token_estimate, is_dialogue, is_herta_voice_evidence, is_canon_fact_candidate, quality_score)
       VALUES (@id, @documentId, @ordinal, @sectionPath, @speaker, @speakerEntityId, @authorEntityId, @text, @textHash, @tokenEstimate, @isDialogue, @isHertaVoiceEvidence, @isCanonFactCandidate, @qualityScore)`,
    );
    const insertFtsMap = this.db.prepare(
      "INSERT INTO chunk_fts_map (chunk_id) VALUES (?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts (rowid, title, section_path, speaker, text) VALUES (?, ?, ?, ?, ?)",
    );

    const tx = this.db.transaction(() => {
      insertChunk.run({
        id: chunk.id,
        documentId: chunk.documentId,
        ordinal: chunk.ordinal,
        sectionPath: JSON.stringify(chunk.sectionPath),
        speaker: chunk.speaker ?? null,
        speakerEntityId: chunk.speakerEntityId ?? null,
        authorEntityId: chunk.authorEntityId ?? null,
        text: chunk.text,
        textHash: chunk.textHash,
        tokenEstimate: chunk.tokenEstimate,
        isDialogue: chunk.isDialogue ? 1 : 0,
        isHertaVoiceEvidence: chunk.isHertaVoiceEvidence ? 1 : 0,
        isCanonFactCandidate: chunk.isCanonFactCandidate ? 1 : 0,
        qualityScore: chunk.qualityScore,
      });
      const info = insertFtsMap.run(chunk.id);
      const docTitle = this.db
        .prepare("SELECT title FROM documents WHERE id = ?")
        .get(chunk.documentId) as { title: string } | undefined;
      insertFts.run(
        info.lastInsertRowid as number,
        docTitle?.title ?? "",
        chunk.sectionPath.join(" > "),
        chunk.speaker ?? "",
        chunk.text,
      );
    });
    tx();
  }

  getChunk(id: string): CanonChunk | undefined {
    const row = this.db
      .prepare(
        `SELECT id, document_id AS documentId, ordinal, section_path AS sectionPathJson,
                speaker, speaker_entity_id AS speakerEntityId, author_entity_id AS authorEntityId,
                text, text_hash AS textHash, token_estimate AS tokenEstimate,
                is_dialogue AS isDialogue, is_herta_voice_evidence AS isHertaVoiceEvidence,
                is_canon_fact_candidate AS isCanonFactCandidate, quality_score AS qualityScore
         FROM chunks WHERE id = ?`,
      )
      .get(id) as
      | (Omit<
          CanonChunk,
          | "sectionPath"
          | "isDialogue"
          | "isHertaVoiceEvidence"
          | "isCanonFactCandidate"
        > & {
          sectionPathJson: string;
          isDialogue: number;
          isHertaVoiceEvidence: number;
          isCanonFactCandidate: number;
        })
      | undefined;
    if (row === undefined) return undefined;
    return {
      ...row,
      sectionPath: JSON.parse(row.sectionPathJson) as string[],
      isDialogue: row.isDialogue === 1,
      isHertaVoiceEvidence: row.isHertaVoiceEvidence === 1,
      isCanonFactCandidate: row.isCanonFactCandidate === 1,
    };
  }

  searchFts(query: string, limit: number): FtsHit[] {
    // FTS5 MATCH has its own query grammar (audit 2026-07-10, finding 23):
    // a stray `"`, an unbalanced paren, or a `col:` prefix in raw text
    // throws `SqliteError: fts5 syntax error` straight out of every caller —
    // the parameter binding prevents SQL injection but not GRAMMAR
    // injection, a crash-in-waiting for the first consumer that feeds this
    // user text. Quote each whitespace-separated term (doubling internal
    // quotes) so arbitrary text is always a valid query; terms AND together,
    // which is the retrievers' intent — operator syntax was never a
    // supported input.
    const safe = toFtsQuery(query);
    if (safe === "") return [];
    const rows = this.db
      .prepare(
        `SELECT m.chunk_id AS chunkId, bm25(chunks_fts) AS rank
         FROM chunks_fts f
         JOIN chunk_fts_map m ON m.rowid = f.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(safe, limit) as Array<{ chunkId: string; rank: number }>;
    return rows;
  }

  // --- mentions & edges ---

  insertMention(m: EntityMention): void {
    this.db
      .prepare(
        `INSERT INTO entity_mentions (id, chunk_id, surface, start_offset, end_offset, referent_entity_id, embodiment_entity_id, speaker_entity_id, page_subject_entity_id, confidence, method, rationale)
         VALUES (@id, @chunkId, @surface, @startOffset, @endOffset, @referentEntityId, @embodimentEntityId, @speakerEntityId, @pageSubjectEntityId, @confidence, @method, @rationale)`,
      )
      .run({
        id: m.id,
        chunkId: m.chunkId,
        surface: m.surface,
        startOffset: m.startOffset ?? null,
        endOffset: m.endOffset ?? null,
        referentEntityId: m.referentEntityId,
        embodimentEntityId: m.embodimentEntityId ?? null,
        speakerEntityId: m.speakerEntityId ?? null,
        pageSubjectEntityId: m.pageSubjectEntityId ?? null,
        confidence: m.confidence,
        method: m.method,
        rationale: m.rationale ?? null,
      });
  }

  insertEdge(e: CanonEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (id, source_entity_id, relation, target_entity_id, evidence_chunk_id, confidence, method, rationale)
         VALUES (@id, @sourceEntityId, @relation, @targetEntityId, @evidenceChunkId, @confidence, @method, @rationale)`,
      )
      .run({
        id: e.id,
        sourceEntityId: e.sourceEntityId,
        relation: e.relation,
        targetEntityId: e.targetEntityId,
        evidenceChunkId: e.evidenceChunkId ?? null,
        confidence: e.confidence,
        method: e.method,
        rationale: e.rationale ?? null,
      });
  }

  getEdgesForEntity(entityId: string): CanonEdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_entity_id AS sourceEntityId, relation,
                target_entity_id AS targetEntityId,
                evidence_chunk_id AS evidenceChunkId,
                confidence, method, rationale
         FROM edges
         WHERE source_entity_id = ? OR target_entity_id = ?`,
      )
      .all(entityId, entityId) as Array<
      Omit<CanonEdgeRow, "evidenceChunkId" | "rationale"> & {
        evidenceChunkId: string | null;
        rationale: string | null;
      }
    >;
    return rows.map((r) => ({
      id: r.id,
      sourceEntityId: r.sourceEntityId,
      relation: r.relation,
      targetEntityId: r.targetEntityId,
      evidenceChunkId: r.evidenceChunkId ?? undefined,
      confidence: r.confidence,
      method: r.method,
      rationale: r.rationale ?? undefined,
    }));
  }

  getChunkWithDocument(chunkId: string): ChunkWithDocument | undefined {
    const row = this.db
      .prepare(
        `SELECT
            c.id AS cId, c.document_id AS cDocId, c.ordinal AS cOrdinal,
            c.section_path AS cSectionPath, c.speaker AS cSpeaker,
            c.speaker_entity_id AS cSpeakerEntityId,
            c.author_entity_id AS cAuthorEntityId,
            c.text AS cText,
            c.is_dialogue AS cIsDialogue,
            c.is_herta_voice_evidence AS cIsVoice,
            c.is_canon_fact_candidate AS cIsFact,
            c.quality_score AS cQualityScore,
            d.id AS dId, d.title AS dTitle, d.path AS dPath,
            d.url AS dUrl, d.kind AS dKind
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.id = ?`,
      )
      .get(chunkId) as
      | {
          cId: string;
          cDocId: string;
          cOrdinal: number;
          cSectionPath: string;
          cSpeaker: string | null;
          cSpeakerEntityId: string | null;
          cAuthorEntityId: string | null;
          cText: string;
          cIsDialogue: number;
          cIsVoice: number;
          cIsFact: number;
          cQualityScore: number;
          dId: string;
          dTitle: string;
          dPath: string;
          dUrl: string | null;
          dKind: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      chunk: {
        id: row.cId,
        documentId: row.cDocId,
        ordinal: row.cOrdinal,
        sectionPath: JSON.parse(row.cSectionPath) as string[],
        speaker: row.cSpeaker ?? undefined,
        speakerEntityId: row.cSpeakerEntityId ?? undefined,
        authorEntityId: row.cAuthorEntityId ?? undefined,
        text: row.cText,
        isDialogue: row.cIsDialogue === 1,
        isHertaVoiceEvidence: row.cIsVoice === 1,
        isCanonFactCandidate: row.cIsFact === 1,
        qualityScore: row.cQualityScore,
      },
      document: {
        id: row.dId,
        title: row.dTitle,
        path: row.dPath,
        url: row.dUrl ?? undefined,
        kind: row.dKind,
      },
    };
  }

  // --- claims ---

  insertClaim(claim: CanonClaim): void {
    this.db
      .prepare(
        `INSERT INTO claims (
           id, subject_entity_id, predicate, object_entity_id, value,
           qualifiers_json, evidence_chunk_ids_json, confidence, method, status,
           rationale, created_at, supersedes_claim_id
         )
         VALUES (
           @id, @subjectEntityId, @predicate, @objectEntityId, @value,
           @qualifiersJson, @evidenceChunkIdsJson, @confidence, @method, @status,
           @rationale, @createdAt, @supersedesClaimId
         )
         ON CONFLICT(id) DO UPDATE SET
           subject_entity_id = excluded.subject_entity_id,
           predicate = excluded.predicate,
           object_entity_id = excluded.object_entity_id,
           value = excluded.value,
           qualifiers_json = excluded.qualifiers_json,
           evidence_chunk_ids_json = excluded.evidence_chunk_ids_json,
           confidence = excluded.confidence,
           method = excluded.method,
           status = excluded.status,
           rationale = excluded.rationale,
           supersedes_claim_id = excluded.supersedes_claim_id`,
      )
      .run({
        id: claim.id,
        subjectEntityId: claim.subjectEntityId,
        predicate: claim.predicate,
        objectEntityId: claim.objectEntityId ?? null,
        value: claim.value ?? null,
        qualifiersJson: claim.qualifiersJson ?? null,
        evidenceChunkIdsJson: JSON.stringify(claim.evidenceChunkIds),
        confidence: claim.confidence,
        method: claim.method,
        status: claim.status,
        rationale: claim.rationale ?? null,
        createdAt: claim.createdAt,
        supersedesClaimId: claim.supersedesClaimId ?? null,
      });
  }

  getClaimsBySubject(subjectEntityId: string): CanonClaim[] {
    const rows = this.db
      .prepare(
        `SELECT id, subject_entity_id AS subjectEntityId, predicate,
                object_entity_id AS objectEntityId, value,
                qualifiers_json AS qualifiersJson,
                evidence_chunk_ids_json AS evidenceChunkIdsJson,
                confidence, method, status, rationale,
                created_at AS createdAt,
                supersedes_claim_id AS supersedesClaimId
         FROM claims
         WHERE subject_entity_id = ?
         ORDER BY predicate, id`,
      )
      .all(subjectEntityId) as Array<ClaimRow>;
    return rows.map(claimRowToCanon);
  }

  getActiveClaimsForPredicate(predicate: string, limit = 100): CanonClaim[] {
    const rows = this.db
      .prepare(
        `SELECT id, subject_entity_id AS subjectEntityId, predicate,
                object_entity_id AS objectEntityId, value,
                qualifiers_json AS qualifiersJson,
                evidence_chunk_ids_json AS evidenceChunkIdsJson,
                confidence, method, status, rationale,
                created_at AS createdAt,
                supersedes_claim_id AS supersedesClaimId
         FROM claims
         WHERE predicate = ? AND status = 'active'
         ORDER BY confidence DESC, id
         LIMIT ?`,
      )
      .all(predicate, limit) as Array<ClaimRow>;
    return rows.map(claimRowToCanon);
  }

  countClaims(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as {
      n: number;
    };
    return row.n;
  }

  updateClaimEvidence(
    claimId: string,
    evidenceChunkIds: ReadonlyArray<string>,
    confidence: number,
  ): void {
    this.db
      .prepare(
        `UPDATE claims
         SET evidence_chunk_ids_json = ?, confidence = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(evidenceChunkIds), confidence, claimId);
  }

  getActiveClaimsForKey(
    subjectEntityId: string,
    predicate: string,
  ): CanonClaim[] {
    const rows = this.db
      .prepare(
        `SELECT id, subject_entity_id AS subjectEntityId, predicate,
                object_entity_id AS objectEntityId, value,
                qualifiers_json AS qualifiersJson,
                evidence_chunk_ids_json AS evidenceChunkIdsJson,
                confidence, method, status, rationale,
                created_at AS createdAt,
                supersedes_claim_id AS supersedesClaimId
         FROM claims
         WHERE subject_entity_id = ? AND predicate = ? AND status = 'active'
         ORDER BY confidence DESC, id`,
      )
      .all(subjectEntityId, predicate) as Array<ClaimRow>;
    return rows.map(claimRowToCanon);
  }

  listEntityIds(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM entities").all() as Array<{
      id: string;
    }>;
    return new Set(rows.map((r) => r.id));
  }

  listEntities(): Array<{
    id: string;
    type: string;
    canonicalName: string;
    description: string | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, type, canonical_name AS canonicalName, description FROM entities ORDER BY id",
      )
      .all() as Array<{
      id: string;
      type: string;
      canonicalName: string;
      description: string | null;
    }>;
  }

  listChunkSignalsForClaims(): Array<{
    chunkId: string;
    text: string;
    mentions: Array<{
      surface: string;
      referentEntityId: string;
      confidence: number;
      method: "deterministic" | "llm" | "human_review";
    }>;
  }> {
    const chunkRows = this.db
      .prepare("SELECT id, text FROM chunks ORDER BY id")
      .all() as Array<{ id: string; text: string }>;
    const mentionStmt = this.db.prepare(
      `SELECT surface, referent_entity_id AS referentEntityId,
              confidence, method
       FROM entity_mentions
       WHERE chunk_id = ?`,
    );
    return chunkRows.map((row) => ({
      chunkId: row.id,
      text: row.text,
      mentions: mentionStmt.all(row.id) as Array<{
        surface: string;
        referentEntityId: string;
        confidence: number;
        method: "deterministic" | "llm" | "human_review";
      }>,
    }));
  }

  listChunkSignalsForLlmClaims(): Array<{
    chunkId: string;
    documentTitle: string;
    documentKind: string;
    sectionPath: string[];
    speaker?: string;
    text: string;
    isCanonFactCandidate: boolean;
    isHertaVoiceEvidence: boolean;
    mentions: Array<{
      surface: string;
      referentEntityId: string;
      confidence: number;
    }>;
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunkId, d.title AS documentTitle, d.kind AS documentKind,
                c.section_path AS sectionPathJson, c.speaker, c.text,
                c.is_canon_fact_candidate AS isFact,
                c.is_herta_voice_evidence AS isVoice
         FROM chunks c JOIN documents d ON d.id = c.document_id
         ORDER BY c.id`,
      )
      .all() as Array<{
      chunkId: string;
      documentTitle: string;
      documentKind: string;
      sectionPathJson: string;
      speaker: string | null;
      text: string;
      isFact: number;
      isVoice: number;
    }>;
    const mentionStmt = this.db.prepare(
      `SELECT surface, referent_entity_id AS referentEntityId, confidence
       FROM entity_mentions WHERE chunk_id = ?`,
    );
    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentTitle: r.documentTitle,
      documentKind: r.documentKind,
      sectionPath: JSON.parse(r.sectionPathJson) as string[],
      speaker: r.speaker ?? undefined,
      text: r.text,
      isCanonFactCandidate: r.isFact === 1,
      isHertaVoiceEvidence: r.isVoice === 1,
      mentions: mentionStmt.all(r.chunkId) as Array<{
        surface: string;
        referentEntityId: string;
        confidence: number;
      }>,
    }));
  }

  // --- wiki pages ---

  upsertWikiPage(page: WikiPage): void {
    this.db
      .prepare(
        `INSERT INTO wiki_pages (
           entity_id, generated_at, content_json, claim_ids_json, source_chunk_ids_json
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           generated_at = excluded.generated_at,
           content_json = excluded.content_json,
           claim_ids_json = excluded.claim_ids_json,
           source_chunk_ids_json = excluded.source_chunk_ids_json`,
      )
      .run(
        page.entityId,
        page.generatedAt,
        JSON.stringify(page),
        JSON.stringify(page.claimIds),
        JSON.stringify(page.sourceChunkIds),
      );
  }

  getWikiPage(entityId: string): WikiPage | undefined {
    const row = this.db
      .prepare(
        "SELECT content_json AS contentJson FROM wiki_pages WHERE entity_id = ?",
      )
      .get(entityId) as { contentJson: string } | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(row.contentJson) as WikiPage;
  }

  listWikiPageEntityIds(): string[] {
    const rows = this.db
      .prepare(
        "SELECT entity_id AS entityId FROM wiki_pages ORDER BY entity_id",
      )
      .all() as Array<{ entityId: string }>;
    return rows.map((r) => r.entityId);
  }

  countWikiPages(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM wiki_pages")
      .get() as { n: number };
    return row.n;
  }

  getVoiceEvidenceChunksForEntity(
    entityId: string,
    limit: number,
  ): Array<{
    chunkId: string;
    documentTitle: string;
    sectionPath: string[];
    text: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunkId, d.title AS documentTitle,
                c.section_path AS sectionPathJson, c.text
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.is_herta_voice_evidence = 1
           AND c.speaker_entity_id = ?
         ORDER BY c.quality_score DESC, c.id
         LIMIT ?`,
      )
      .all(entityId, limit) as Array<{
      chunkId: string;
      documentTitle: string;
      sectionPathJson: string;
      text: string;
    }>;
    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentTitle: r.documentTitle,
      sectionPath: JSON.parse(r.sectionPathJson) as string[],
      text: r.text,
    }));
  }

  // --- voice evidence strata ---

  upsertVoiceEvidenceStratum(s: VoiceEvidenceStratum): void {
    this.db
      .prepare(
        `INSERT INTO voice_evidence_strata (
           chunk_id, speaker_entity_id, addressee_class, addressee_entity_id,
           classifier_version, classified_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           speaker_entity_id   = excluded.speaker_entity_id,
           addressee_class     = excluded.addressee_class,
           addressee_entity_id = excluded.addressee_entity_id,
           classifier_version  = excluded.classifier_version,
           classified_at       = excluded.classified_at`,
      )
      .run(
        s.chunkId,
        s.speakerEntityId,
        s.addresseeClass,
        s.addresseeEntityId ?? null,
        s.classifierVersion,
        s.classifiedAt,
      );
  }

  // --- chunk translations (schema v8, EN interaction slice 2) ---

  upsertChunkTranslation(t: ChunkTranslation): void {
    this.db
      .prepare(
        `INSERT INTO chunk_translations (
           chunk_id, lang, text, textmap_hash, match_kind, aligned_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, lang) DO UPDATE SET
           text         = excluded.text,
           textmap_hash = excluded.textmap_hash,
           match_kind   = excluded.match_kind,
           aligned_at   = excluded.aligned_at`,
      )
      .run(t.chunkId, t.lang, t.text, t.textmapHash, t.matchKind, t.alignedAt);
  }

  getChunkTranslation(
    chunkId: string,
    lang: string,
  ): ChunkTranslation | undefined {
    const row = this.db
      .prepare(
        `SELECT chunk_id     AS chunkId,
                lang,
                text,
                textmap_hash AS textmapHash,
                match_kind   AS matchKind,
                aligned_at   AS alignedAt
         FROM chunk_translations WHERE chunk_id = ? AND lang = ?`,
      )
      .get(chunkId, lang) as
      | {
          chunkId: string;
          lang: string;
          text: string;
          textmapHash: string;
          matchKind: string;
          alignedAt: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      ...row,
      matchKind: row.matchKind as ChunkTranslation["matchKind"],
    };
  }

  /** All stratified chunks for a speaker with their CN text — the align
   *  pass's input (one query instead of N chunk reads). */
  listStratifiedChunkTexts(
    speakerEntityId: string,
  ): Array<{ chunkId: string; text: string }> {
    return this.db
      .prepare(
        `SELECT c.id AS chunkId, c.text
         FROM voice_evidence_strata s
         JOIN chunks c ON c.id = s.chunk_id
         WHERE s.speaker_entity_id = ?
         ORDER BY c.id`,
      )
      .all(speakerEntityId) as Array<{ chunkId: string; text: string }>;
  }

  getVoiceEvidenceStratum(chunkId: string): VoiceEvidenceStratum | undefined {
    const row = this.db
      .prepare(
        `SELECT chunk_id            AS chunkId,
                speaker_entity_id   AS speakerEntityId,
                addressee_class     AS addresseeClass,
                addressee_entity_id AS addresseeEntityId,
                classifier_version  AS classifierVersion,
                classified_at       AS classifiedAt
         FROM voice_evidence_strata WHERE chunk_id = ?`,
      )
      .get(chunkId) as
      | {
          chunkId: string;
          speakerEntityId: string;
          addresseeClass: string;
          addresseeEntityId: string | null;
          classifierVersion: number;
          classifiedAt: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      chunkId: row.chunkId,
      speakerEntityId: row.speakerEntityId,
      addresseeClass: row.addresseeClass as AddresseeClass,
      addresseeEntityId: row.addresseeEntityId ?? undefined,
      classifierVersion: row.classifierVersion,
      classifiedAt: row.classifiedAt,
    };
  }

  listStrataByClass(
    speakerEntityId: string,
    addresseeClass: AddresseeClass,
  ): VoiceEvidenceStratum[] {
    const rows = this.db
      .prepare(
        `SELECT chunk_id            AS chunkId,
                speaker_entity_id   AS speakerEntityId,
                addressee_class     AS addresseeClass,
                addressee_entity_id AS addresseeEntityId,
                classifier_version  AS classifierVersion,
                classified_at       AS classifiedAt
         FROM voice_evidence_strata
         WHERE speaker_entity_id = ? AND addressee_class = ?
         ORDER BY chunk_id`,
      )
      .all(speakerEntityId, addresseeClass) as Array<{
      chunkId: string;
      speakerEntityId: string;
      addresseeClass: string;
      addresseeEntityId: string | null;
      classifierVersion: number;
      classifiedAt: string;
    }>;
    return rows.map((r) => ({
      chunkId: r.chunkId,
      speakerEntityId: r.speakerEntityId,
      addresseeClass: r.addresseeClass as AddresseeClass,
      addresseeEntityId: r.addresseeEntityId ?? undefined,
      classifierVersion: r.classifierVersion,
      classifiedAt: r.classifiedAt,
    }));
  }

  /**
   * Returns all speaker entity IDs that have at least `minChunks`
   * player-class strata rows, ordered alphabetically. Used by the
   * multi-character contrast fan-out in R1 discover pass (D3).
   */
  listSpeakersWithPlayerChunks(minChunks: number): Array<{
    entityId: string;
    count: number;
  }> {
    return this.db
      .prepare(
        `SELECT speaker_entity_id as entityId, COUNT(*) as count
           FROM voice_evidence_strata
          WHERE addressee_class = 'player'
          GROUP BY speaker_entity_id
         HAVING COUNT(*) >= ?
          ORDER BY entityId ASC`,
      )
      .all(minChunks) as Array<{ entityId: string; count: number }>;
  }

  countStrata(
    speakerEntityId: string,
    addresseeClass?: AddresseeClass,
  ): number {
    if (addresseeClass === undefined) {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM voice_evidence_strata WHERE speaker_entity_id = ?",
        )
        .get(speakerEntityId) as { n: number };
      return row.n;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM voice_evidence_strata
         WHERE speaker_entity_id = ? AND addressee_class = ?`,
      )
      .get(speakerEntityId, addresseeClass) as { n: number };
    return row.n;
  }

  upsertVoiceEvidenceStratumLlm(row: VoiceEvidenceStratumLlm): void {
    this.db
      .prepare(
        `INSERT INTO voice_evidence_strata
           (chunk_id, speaker_entity_id, addressee_class, addressee_entity_id,
            classifier_version, classified_at,
            addressee_entity_id_llm, mood, register_mode, grounded_citation,
            confidence, source, disagreement_with_heuristic,
            pass_a_verdict_json, pass_b_verdict_json)
         VALUES
           (@chunk_id, @speaker_entity_id, @addressee_class, @addressee_entity_id,
            @classifier_version, @classified_at,
            @addressee_entity_id_llm, @mood, @register_mode, @grounded_citation,
            @confidence, @source, @disagreement_with_heuristic,
            @pass_a_verdict_json, @pass_b_verdict_json)
         ON CONFLICT(chunk_id) DO UPDATE SET
           speaker_entity_id   = excluded.speaker_entity_id,
           addressee_class     = excluded.addressee_class,
           addressee_entity_id = excluded.addressee_entity_id,
           classifier_version  = excluded.classifier_version,
           classified_at       = excluded.classified_at,
           addressee_entity_id_llm     = excluded.addressee_entity_id_llm,
           mood                        = excluded.mood,
           register_mode               = excluded.register_mode,
           grounded_citation           = excluded.grounded_citation,
           confidence                  = excluded.confidence,
           source                      = excluded.source,
           disagreement_with_heuristic = excluded.disagreement_with_heuristic,
           pass_a_verdict_json         = excluded.pass_a_verdict_json,
           pass_b_verdict_json         = excluded.pass_b_verdict_json`,
      )
      .run({
        chunk_id: row.chunkId,
        speaker_entity_id: row.speakerEntityId,
        addressee_class: row.addresseeClass,
        addressee_entity_id: row.addresseeEntityId ?? null,
        classifier_version: row.classifierVersion,
        classified_at: row.classifiedAt,
        addressee_entity_id_llm: row.addresseeEntityIdLlm ?? null,
        mood: row.mood ?? null,
        register_mode: row.registerMode ?? null,
        grounded_citation: row.groundedCitation ?? null,
        confidence: row.confidence ?? null,
        source: row.source,
        disagreement_with_heuristic: row.disagreementWithHeuristic ? 1 : 0,
        pass_a_verdict_json: row.passAVerdictJson ?? null,
        pass_b_verdict_json: row.passBVerdictJson ?? null,
      });
  }

  getVoiceEvidenceStratumLlm(
    chunkId: string,
  ): VoiceEvidenceStratumLlm | undefined {
    const row = this.db
      .prepare(
        `SELECT chunk_id, speaker_entity_id, addressee_class, addressee_entity_id,
                classifier_version, classified_at,
                addressee_entity_id_llm, mood, register_mode, grounded_citation,
                confidence, source, disagreement_with_heuristic,
                pass_a_verdict_json, pass_b_verdict_json
         FROM voice_evidence_strata WHERE chunk_id = ?`,
      )
      .get(chunkId) as
      | {
          chunk_id: string;
          speaker_entity_id: string;
          addressee_class: string;
          addressee_entity_id: string | null;
          classifier_version: number;
          classified_at: string;
          addressee_entity_id_llm: string | null;
          mood: string | null;
          register_mode: string | null;
          grounded_citation: string | null;
          confidence: number | null;
          source: string | null;
          disagreement_with_heuristic: number;
          pass_a_verdict_json: string | null;
          pass_b_verdict_json: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      chunkId: row.chunk_id,
      speakerEntityId: row.speaker_entity_id as CanonEntityId,
      addresseeClass: row.addressee_class as AddresseeClass,
      addresseeEntityId:
        (row.addressee_entity_id as CanonEntityId | null) ?? undefined,
      classifierVersion: row.classifier_version,
      classifiedAt: row.classified_at,
      addresseeEntityIdLlm:
        (row.addressee_entity_id_llm as CanonEntityId | null) ?? undefined,
      mood: (row.mood as Mood | null) ?? undefined,
      registerMode: (row.register_mode as RegisterMode | null) ?? undefined,
      groundedCitation: row.grounded_citation ?? undefined,
      confidence: row.confidence ?? undefined,
      // Legacy rows (pre-v6) had no source column → default to "heuristic".
      source: (row.source as StratumSource | null) ?? "heuristic",
      disagreementWithHeuristic: Boolean(row.disagreement_with_heuristic),
      passAVerdictJson: row.pass_a_verdict_json ?? undefined,
      passBVerdictJson: row.pass_b_verdict_json ?? undefined,
    };
  }

  // --- voice profiles ---
  //
  // The voice-profile GENERATION pipeline (discover/validate/eval/snapshot)
  // was retired 2026-07-14; its candidate/history/eval-run accessors were
  // removed with it. `upsertVoiceProfile` / `getVoiceProfile` survive:
  // `cli/self-model-subcommand.ts` still reads the latest voice_profiles row.

  upsertVoiceProfile(p: VoiceProfile): void {
    // selfNarration is optional. Persist as the empty-object sentinel "{}"
    // when absent so the column's NOT NULL constraint is satisfied without
    // ambiguity vs. an actually-present register (which always has the four
    // DefaultRegister sub-fields).
    const selfNarrationJson =
      p.selfNarration !== undefined ? JSON.stringify(p.selfNarration) : "{}";
    this.db
      .prepare(
        `INSERT INTO voice_profiles (
           entity_id, schema_version, default_register_json,
           relationship_registers_json, self_narration_json, anti_patterns_json,
           evidence_chunk_ids_json, generated_at, source_round
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           schema_version              = excluded.schema_version,
           default_register_json       = excluded.default_register_json,
           relationship_registers_json = excluded.relationship_registers_json,
           self_narration_json         = excluded.self_narration_json,
           anti_patterns_json          = excluded.anti_patterns_json,
           evidence_chunk_ids_json     = excluded.evidence_chunk_ids_json,
           generated_at                = excluded.generated_at,
           source_round                = excluded.source_round`,
      )
      .run(
        p.entityId,
        p.schemaVersion,
        JSON.stringify(p.defaultRegister),
        JSON.stringify(p.relationshipRegisters),
        selfNarrationJson,
        JSON.stringify(p.antiPatterns),
        JSON.stringify(p.evidenceChunkIds),
        p.generatedAt,
        p.sourceRound,
      );
  }

  getVoiceProfile(entityId: string): VoiceProfile | undefined {
    const row = this.db
      .prepare(
        `SELECT entity_id                   AS entityId,
                schema_version              AS schemaVersion,
                default_register_json       AS defaultRegisterJson,
                relationship_registers_json AS relationshipRegistersJson,
                self_narration_json         AS selfNarrationJson,
                anti_patterns_json          AS antiPatternsJson,
                evidence_chunk_ids_json     AS evidenceChunkIdsJson,
                generated_at                AS generatedAt,
                source_round                AS sourceRound
         FROM voice_profiles WHERE entity_id = ?`,
      )
      .get(entityId) as
      | {
          entityId: string;
          schemaVersion: number;
          defaultRegisterJson: string;
          relationshipRegistersJson: string;
          selfNarrationJson: string;
          antiPatternsJson: string;
          evidenceChunkIdsJson: string;
          generatedAt: string;
          sourceRound: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    const selfNarrationParsed = JSON.parse(row.selfNarrationJson) as
      | VoiceProfile["defaultRegister"]
      | Record<string, never>;
    // Empty-object sentinel "{}" → field absent. A populated DefaultRegister
    // always carries the four required sub-fields; presence of `formsOfAddress`
    // is sufficient to disambiguate.
    const selfNarration =
      selfNarrationParsed !== null &&
      typeof selfNarrationParsed === "object" &&
      "formsOfAddress" in selfNarrationParsed
        ? (selfNarrationParsed as VoiceProfile["defaultRegister"])
        : undefined;
    return {
      entityId: row.entityId,
      schemaVersion: row.schemaVersion,
      defaultRegister: JSON.parse(
        row.defaultRegisterJson,
      ) as VoiceProfile["defaultRegister"],
      relationshipRegisters: JSON.parse(
        row.relationshipRegistersJson,
      ) as VoiceProfile["relationshipRegisters"],
      ...(selfNarration !== undefined ? { selfNarration } : {}),
      antiPatterns: JSON.parse(
        row.antiPatternsJson,
      ) as VoiceProfile["antiPatterns"],
      evidenceChunkIds: JSON.parse(row.evidenceChunkIdsJson) as string[],
      generatedAt: row.generatedAt,
      sourceRound: row.sourceRound,
    };
  }

  // --- self-models (Phase 6) ---

  /**
   * Insert a synthesized self-model row. Multiple ships per entity are
   * allowed and form a history; runtime consumers read the latest by
   * `MAX(shipped_at)` via {@link getLatestSelfModel}. Returns the new
   * row id.
   *
   * `payloadJson` is the full HertaSelfModelV1 JSON (string-pre-stringified
   * so the store doesn't need to depend on the self-model schema package).
   * `judgeReportJson` is optional — pass `null` to ship without a judge run.
   * `sourceFactsHash` is optional — sha256 over the Pass 1 facts for
   * change-detection.
   */
  insertSelfModel(input: {
    entityId: string;
    schemaVersion: number;
    payloadJson: string;
    judgeReportJson: string | null;
    sourceFactsHash: string | null;
    shippedAt: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO self_models (
           entity_id, schema_version, payload_json,
           judge_report_json, source_facts_hash, shipped_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.entityId,
        input.schemaVersion,
        input.payloadJson,
        input.judgeReportJson,
        input.sourceFactsHash,
        input.shippedAt,
      );
    return Number(result.lastInsertRowid);
  }

  getLatestSelfModel(entityId: string):
    | {
        id: number;
        entityId: string;
        schemaVersion: number;
        payloadJson: string;
        judgeReportJson: string | null;
        sourceFactsHash: string | null;
        shippedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT id,
                entity_id          AS entityId,
                schema_version     AS schemaVersion,
                payload_json       AS payloadJson,
                judge_report_json  AS judgeReportJson,
                source_facts_hash  AS sourceFactsHash,
                shipped_at         AS shippedAt
         FROM self_models
         WHERE entity_id = ?
         ORDER BY shipped_at DESC, id DESC
         LIMIT 1`,
      )
      .get(entityId) as
      | {
          id: number;
          entityId: string;
          schemaVersion: number;
          payloadJson: string;
          judgeReportJson: string | null;
          sourceFactsHash: string | null;
          shippedAt: string;
        }
      | undefined;
    return row;
  }

  listSelfModelHistory(
    entityId: string,
  ): Array<{ id: number; shippedAt: string; sourceFactsHash: string | null }> {
    return this.db
      .prepare(
        `SELECT id,
                shipped_at        AS shippedAt,
                source_facts_hash AS sourceFactsHash
         FROM self_models
         WHERE entity_id = ?
         ORDER BY shipped_at DESC, id DESC`,
      )
      .all(entityId) as Array<{
      id: number;
      shippedAt: string;
      sourceFactsHash: string | null;
    }>;
  }

  // --- LLM annotations cache ---

  upsertLlmAnnotation(rec: LlmAnnotationRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO llm_annotations (id, chunk_id, provider, model, task, input_hash, output_json, confidence, created_at)
         VALUES (@id, @chunkId, @provider, @model, @task, @inputHash, @outputJson, @confidence, @createdAt)`,
      )
      .run({
        id: rec.id,
        chunkId: rec.chunkId,
        provider: rec.provider,
        model: rec.model,
        task: rec.task,
        inputHash: rec.inputHash,
        outputJson: rec.outputJson,
        confidence: rec.confidence ?? null,
        createdAt: rec.createdAt,
      });
  }

  getLlmAnnotation(inputHash: string): LlmAnnotationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, chunk_id AS chunkId, provider, model, task,
                input_hash AS inputHash, output_json AS outputJson,
                confidence, created_at AS createdAt
         FROM llm_annotations WHERE input_hash = ?`,
      )
      .get(inputHash) as LlmAnnotationRecord | undefined;
    return row;
  }

  // --- upsert helpers (idempotent write used by tests and re-ingest) ---

  /** Upsert a chunk. Uses INSERT OR REPLACE so FTS rows are refreshed too. */
  upsertChunk(chunk: CanonChunk): void {
    const upsertChunkStmt = this.db.prepare(
      `INSERT INTO chunks (id, document_id, ordinal, section_path, speaker, speaker_entity_id, author_entity_id, text, text_hash, token_estimate, is_dialogue, is_herta_voice_evidence, is_canon_fact_candidate, quality_score)
       VALUES (@id, @documentId, @ordinal, @sectionPath, @speaker, @speakerEntityId, @authorEntityId, @text, @textHash, @tokenEstimate, @isDialogue, @isHertaVoiceEvidence, @isCanonFactCandidate, @qualityScore)
       ON CONFLICT(id) DO UPDATE SET
         document_id              = excluded.document_id,
         ordinal                  = excluded.ordinal,
         section_path             = excluded.section_path,
         speaker                  = excluded.speaker,
         speaker_entity_id        = excluded.speaker_entity_id,
         author_entity_id         = excluded.author_entity_id,
         text                     = excluded.text,
         text_hash                = excluded.text_hash,
         token_estimate           = excluded.token_estimate,
         is_dialogue              = excluded.is_dialogue,
         is_herta_voice_evidence  = excluded.is_herta_voice_evidence,
         is_canon_fact_candidate  = excluded.is_canon_fact_candidate,
         quality_score            = excluded.quality_score`,
    );
    const insertFtsMap = this.db.prepare(
      "INSERT OR IGNORE INTO chunk_fts_map (chunk_id) VALUES (?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts (rowid, title, section_path, speaker, text) VALUES (?, ?, ?, ?, ?)",
    );

    const tx = this.db.transaction(() => {
      upsertChunkStmt.run({
        id: chunk.id,
        documentId: chunk.documentId,
        ordinal: chunk.ordinal,
        sectionPath: JSON.stringify(chunk.sectionPath),
        speaker: chunk.speaker ?? null,
        speakerEntityId: chunk.speakerEntityId ?? null,
        authorEntityId: chunk.authorEntityId ?? null,
        text: chunk.text,
        textHash: chunk.textHash,
        tokenEstimate: chunk.tokenEstimate,
        isDialogue: chunk.isDialogue ? 1 : 0,
        isHertaVoiceEvidence: chunk.isHertaVoiceEvidence ? 1 : 0,
        isCanonFactCandidate: chunk.isCanonFactCandidate ? 1 : 0,
        qualityScore: chunk.qualityScore,
      });
      const existing = this.db
        .prepare("SELECT rowid FROM chunk_fts_map WHERE chunk_id = ?")
        .get(chunk.id) as { rowid: number } | undefined;
      if (existing === undefined) {
        const info = insertFtsMap.run(chunk.id);
        const docTitle = this.db
          .prepare("SELECT title FROM documents WHERE id = ?")
          .get(chunk.documentId) as { title: string } | undefined;
        insertFts.run(
          info.lastInsertRowid as number,
          docTitle?.title ?? "",
          chunk.sectionPath.join(" > "),
          chunk.speaker ?? "",
          chunk.text,
        );
      }
    });
    tx();
  }

  /**
   * Upsert an entity with a flat aliases array (convenience method for tests
   * and re-ingest). `kind` maps to the `type` column.
   */
  upsertEntity(e: {
    id: string;
    kind: string;
    canonicalName: string;
    aliases?: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, type, canonical_name)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type           = excluded.type,
           canonical_name = excluded.canonical_name`,
      )
      .run(e.id, e.kind, e.canonicalName);
    if (e.aliases !== undefined) {
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO aliases (entity_id, alias, lang, priority) VALUES (?, ?, NULL, 0)",
      );
      for (const alias of e.aliases) {
        stmt.run(e.id, alias);
      }
    }
  }

  // --- voice restratify helpers ---

  listDocsContainingSpeakerChunks(speakerEntityId: string): Array<{
    id: string;
    path: string;
    kind: string;
  }> {
    return this.db
      .prepare(
        `SELECT DISTINCT d.id, d.path, d.kind
           FROM documents d
           JOIN chunks c ON c.document_id = d.id
           WHERE c.speaker_entity_id = ?
           ORDER BY d.id`,
      )
      .all(speakerEntityId) as Array<{
      id: string;
      path: string;
      kind: string;
    }>;
  }

  listSpeakerChunksInDoc(
    speakerEntityId: string,
    docId: string,
  ): Array<{
    id: string;
    ordinal: number;
    text: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, ordinal, text
           FROM chunks
           WHERE speaker_entity_id = ? AND document_id = ?
           ORDER BY ordinal`,
      )
      .all(speakerEntityId, docId) as Array<{
      id: string;
      ordinal: number;
      text: string;
    }>;
  }

  /**
   * All chunks in a single document, in ordinal order, joined with the
   * speaker's canonical name. Used by the scene-extraction pipeline to
   * dump full conversational context for a doc that contains lines by a
   * specific speaker.
   *
   * Returns one row per chunk; `speakerEntityId` and `speakerName` are
   * null when the parser couldn't attribute a speaker (typical for
   * narrator beats / stage directions).
   */
  listAllChunksInDocWithSpeakers(docId: string): Array<{
    chunkId: string;
    ordinal: number;
    text: string;
    speakerEntityId: string | null;
    speakerName: string | null;
    speakerSurface: string | null;
    isDialogue: boolean;
  }> {
    return this.db
      .prepare(
        `SELECT c.id            AS chunkId,
                c.ordinal       AS ordinal,
                c.text          AS text,
                c.speaker_entity_id AS speakerEntityId,
                e.canonical_name AS speakerName,
                c.speaker       AS speakerSurface,
                c.is_dialogue   AS isDialogue
           FROM chunks c
           LEFT JOIN entities e ON e.id = c.speaker_entity_id
           WHERE c.document_id = ?
           ORDER BY c.ordinal`,
      )
      .all(docId) as Array<{
      chunkId: string;
      ordinal: number;
      text: string;
      speakerEntityId: string | null;
      speakerName: string | null;
      speakerSurface: string | null;
      isDialogue: boolean;
    }>;
  }

  /** Fetch a document by id. Returns null if not present. */
  getDocumentMeta(docId: string): {
    id: string;
    title: string;
    path: string;
    kind: string;
  } | null {
    const row = this.db
      .prepare("SELECT id, title, path, kind FROM documents WHERE id = ?")
      .get(docId) as
      | { id: string; title: string; path: string; kind: string }
      | undefined;
    return row ?? null;
  }

  listAllEntityIds(): string[] {
    return (
      this.db.prepare("SELECT id FROM entities ORDER BY id").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  }

  // --- raw escape hatch for tests + ad-hoc queries ---

  rawAll<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Wraps `fn` in a SQLite transaction. If `fn` throws, the transaction is
   * rolled back automatically (better-sqlite3 behaviour).
   */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }
}

function seedEntities(db: Database.Database): void {
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entities (id, type, canonical_name, description) VALUES (?, ?, ?, ?)",
  );
  const insertAlias = db.prepare(
    "INSERT OR IGNORE INTO aliases (entity_id, alias, lang, priority) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const e of SEED_ENTITIES) {
      insertEntity.run(e.id, e.type, e.canonicalName, e.description ?? null);
      for (const a of e.aliases) {
        insertAlias.run(e.id, a.alias, a.lang ?? null, a.priority ?? 0);
      }
    }
  });
  tx();
}

function seedEdges(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO edges (id, source_entity_id, relation, target_entity_id, evidence_chunk_id, confidence, method, rationale)
     VALUES (?, ?, ?, ?, NULL, 1.0, 'deterministic', ?)`,
  );
  const tx = db.transaction(() => {
    for (const edge of SEED_EDGES) {
      const id = `seed:${edge.sourceEntityId}->${edge.relation}->${edge.targetEntityId}`;
      insert.run(
        id,
        edge.sourceEntityId,
        edge.relation,
        edge.targetEntityId,
        edge.rationale ?? null,
      );
    }
  });
  tx();
}
