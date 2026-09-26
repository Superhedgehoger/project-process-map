/**
 * Frozen base-v11 `SqlitePersistence` reader (startup/open/close contract),
 * transcribed from commit 0598ad482c02876de6f4e804033bdba906b9d6c7
 * (`packages/adapters/src/sqlite/persistence.ts`), `currentSchemaVersion = 11`.
 *
 * R2F5 Finding 3: old-reader rejection evidence must execute the ACTUAL
 * frozen base-v11 reader/startup guard — its original open, close and error
 * contracts — not a newly written MAX(version)+throw substitute. This class
 * reproduces the v11-generation reader path verbatim:
 *
 * - Open contract: the same `DatabaseSync` open options (busy timeout
 *   `max(10_000, ...)`), the same PRAGMAs (journal_mode=WAL,
 *   synchronous=FULL, foreign_keys=ON), the same
 *   `assertSupportedSchema()` guard, and the same close-on-failure contract
 *   (on guard failure the handle is closed, `#closed` is set and the original
 *   error rethrows — no partial state survives).
 * - The frozen v11 reader performs NO migration and NO writes: on a v12
 *   database the guard throws `SQLITE_SCHEMA_VERSION_UNSUPPORTED:12` before
 *   any write path is reached, exactly as the v11 binary would have.
 * - `close()` mirrors the v11-generation `close()` (idempotent, marks
 *   closed, closes the handle).
 *
 * Deliberately minimal: only the startup/open/close/error contract needed to
 * prove the original v11 reader path. Domain read/write methods of the v11
 * generation are out of scope for the rejection evidence and are not part of
 * the frozen contract. This module is frozen: future schema changes add a
 * NEW frozen reader module (v12-reader.ts, ...) and do not rewrite this one.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const FROZEN_V11_READER_SCHEMA_VERSION = 11;

export type FrozenV11ReaderOptions = Readonly<{
  path: string;
  busyTimeoutMilliseconds?: number | undefined;
}>;

export class FrozenV11SqlitePersistenceReader {
  readonly #database: DatabaseSync;
  readonly #lockKey: string;
  #closed = false;

  constructor(options: FrozenV11ReaderOptions) {
    if (options.path.trim().length === 0) throw new Error("SQLite path is required");
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.#lockKey = options.path === ":memory:" ? `:memory:${options.path}` : resolve(options.path);
    const busyTimeout = Math.max(10_000, options.busyTimeoutMilliseconds ?? 10_000);
    this.#database = new DatabaseSync(options.path, {
      timeout: busyTimeout,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.#database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    // v11-generation `assertSupportedSchema()` (verbatim guard logic + the
    // fail-closed close contract from the base-commit constructor).
    try {
      this.assertSupportedSchema();
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // handle already closed
      }
      this.#closed = true;
      throw error;
    }
  }

  get pathKey(): string {
    return this.#lockKey;
  }

  private assertSupportedSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      ) STRICT;
    `);
    const row = this.#database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    const version = (row as { version?: number } | undefined)?.version;
    if (typeof version === "number" && version > FROZEN_V11_READER_SCHEMA_VERSION) {
      this.#database.close();
      this.#closed = true;
      throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${version}`);
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }
}
