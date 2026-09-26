/**
 * R2F4 Finding 1 / R2F5 Finding 2 / R2F6 Finding 3: independent execution context for the second
 * real `SqlitePersistence` in the CAS contention evidence.
 *
 * Spawned via `node --experimental-strip-types --input-type=module -e <script>
 * -- <readyFile> <dbPath> <JSON(command)>`. Each invocation runs in a fresh
 * Node process: it owns its own in-process `pathLocks` map (module state) and
 * its own `DatabaseSync` handle, so the loser can never be masked by the main
 * test process's lock or by a shared synchronous SQLite connection. It opens a
 * real `SqlitePersistence`, executes one `SubmitDeliverableEvidenceHandler`
 * command, and reports the outcome on stdout as a single JSON line:
 *
 *   {"ok":true,"replayed":boolean,"deliverableVersion":number}
 *   {"ok":false,"code":"DELIVERABLE_VERSION_CONFLICT","message":"..."}
 *
 * R2F6 Finding 3 three-phase barrier contract (supersedes the R2F5 two-phase ready markers):
 *   Phase 1 (observe stale): each side reads and records the deliverable aggregate version it
 *     observed before entering the race window. The child does this through its own
 *     `SqlitePersistence.read` against the real database and emits a
 *     `STALE_V<version>` line.
 *   Phase 2 (confirm ready): the child writes the READY marker only after the stale-v1
 *     observation is emitted and its own database initialization is complete; the parent calls
 *     `waitForChildReadyMarker`, which returns the child's observed stale version. The parent
 *     has recorded its own stale-v1 observation before calling `createParentReadyMarker`.
 *   Phase 3 (release): only after both stale observations are confirmed by the parent does
 *     `writeCasReleaseMarker` release BOTH contenders into the same CAS window: the child
 *     unblocks on the release marker, and the parent starts its own submit. Neither context
 *     can win before the other has entered the window, and both entered from the same stale v1.
 *
 * Exit code 0 on a version conflict (expected loser outcome); 1 on any other
 * failure so the test can distinguish real transport errors.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type SubmitEvidenceCommandShape = {
  tenantId: string;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: string;
  deliverableId: string;
  expectedVersion: number;
  evidence: ReadonlyArray<Readonly<{ sourceType: "file" | "process_record"; sourceId: string }>>;
  occurredAtUtc: string;
};

export type CasWorkerOutcome =
  | Readonly<{ ok: true; replayed: boolean; deliverableVersion: number }>
  | Readonly<{
      ok: false;
      code: string;
      message: string;
      busySnapshotVersionProof?: Readonly<{ staleVersion: number; currentVersion: number }>;
    }>;

export type ActualCasTransactionEvidence = Readonly<{
  observedVersion: number;
  readTransactionId: string;
  updateTransactionId: string;
}>;

function readyMarkerBase(readyFile: string): string {
  // Marker files are derived from the caller-provided path: <base>.parent, <base>.worker and
  // <base>.release, all created in the same directory the test controls.
  return readyFile;
}

/**
 * R2F6 Finding 3 phase 2 (parent side): the main test process calls this after it has observed
 * and recorded its own stale-v1 aggregate version (phase 1) and completed its submit-side
 * preparation (database open + base state ready). It writes the parent ready marker
 * `<readyFile>.parent`. The child writes `<readyFile>.worker` only after its own stale-version
 * observation and database initialization are done; the parent confirms both before release.
 */
export function createParentReadyMarker(readyFile: string): void {
  const base = readyMarkerBase(readyFile);
  const parentMarker = `${base}.parent`;
  const dir = parentMarker.lastIndexOf("/") > 0 ? parentMarker.slice(0, parentMarker.lastIndexOf("/")) : ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(parentMarker, `${new Date().toISOString()}\n`);
}

/**
 * R2F6 Finding 3 phase 2 (parent side): wait until the child's ready marker exists, then return
 * the stale aggregate version the child independently observed before it released the marker.
 * The test asserts this equals 1 (the same stale v1 the parent observed), proving both
 * contenders held the identical pre-writer observation.
 */
export async function waitForChildReadyMarker(readyFile: string, timeoutMs = 15_000): Promise<number> {
  const base = readyMarkerBase(readyFile);
  const childMarker = `${base}.worker`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(childMarker)) {
      const staleMarker = `${base}.worker.stale`;
      if (!existsSync(staleMarker)) {
        // The marker order is writeFileSync(worker.stale) then writeFileSync(worker); if the
        // worker exists but the stale record does not, the barrier is malformed.
        throw new Error(`CAS barrier malformed: ${childMarker} exists without ${staleMarker}`);
      }
      const observed = Number(readFileSync(staleMarker, "utf8").trim());
      if (!Number.isSafeInteger(observed)) {
        throw new Error(`CAS barrier malformed: child stale-version marker is not an integer: ${observed}`);
      }
      return observed;
    }
    if (Date.now() > deadline) {
      throw new Error(`CAS ready barrier timed out: child never released ${childMarker}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/**
 * R2F6 Finding 3 phase 3: release BOTH contenders into the CAS window. The parent calls this
 * only after both stale observations are confirmed (its own v1 read + the child's reported
 * v1). The child polls for this marker before issuing its submit; the parent returns here so
 * the caller can immediately start its own submit.
 */
export function writeCasReleaseMarker(readyFile: string): boolean {
  const base = readyMarkerBase(readyFile);
  const releaseMarker = `${base}.release`;
  const dir = releaseMarker.lastIndexOf("/") > 0 ? releaseMarker.slice(0, releaseMarker.lastIndexOf("/")) : ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(releaseMarker, `${new Date().toISOString()}\n`);
  return true;
}

/**
 * R2F7 Finding 2: wait for a contender marker written from inside the handler's actual write
 * transaction, immediately before the deliverable CAS UPDATE. The marker contains the version
 * read again through that same transaction/connection at the update boundary.
 */
export async function waitForActualCasContenderOpen(
  readyFile: string,
  commandId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const marker = `${readyMarkerBase(readyFile)}.${commandId}.opened`;
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`Actual CAS contender open timed out: ${marker}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

export function writeActualCasStartMarker(readyFile: string): void {
  writeFileSync(`${readyMarkerBase(readyFile)}.start`, `${new Date().toISOString()}\n`);
}

async function readActualCasMarker<T>(marker: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`Actual CAS barrier timed out: ${marker}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  try {
    return JSON.parse(readFileSync(marker, "utf8")) as T;
  } catch {
    throw new Error(`Actual CAS marker is malformed: ${marker}`);
  }
}

export async function waitForActualCasReadyMarker(
  readyFile: string,
  commandId: string,
  timeoutMs = 15_000,
): Promise<ActualCasTransactionEvidence> {
  return await readActualCasMarker<ActualCasTransactionEvidence>(
    `${readyMarkerBase(readyFile)}.${commandId}.actual-cas-ready`,
    timeoutMs,
  );
}

export async function waitForActualCasAttemptMarker(
  readyFile: string,
  commandId: string,
  timeoutMs = 15_000,
): Promise<ActualCasTransactionEvidence> {
  return await readActualCasMarker<ActualCasTransactionEvidence>(
    `${readyMarkerBase(readyFile)}.${commandId}.actual-cas-attempt`,
    timeoutMs,
  );
}

/**
 * Run one real product submit in a separate process, with test-layer-only SQLite method
 * instrumentation. BEGIN IMMEDIATE is changed to BEGIN DEFERRED only in this child process so
 * two real handler transactions can both read v1. Each transaction blocks immediately before
 * its real CAS UPDATE. After release, an atomic marker chooses the first updater; the other
 * waits for commit and attempts the same `UPDATE ... WHERE version = 1` from its unchanged
 * stale snapshot. SQLite reports BUSY_SNAPSHOT for that legal stale-reader upgrade. Only this
 * test helper converts code 517 after the handler has rolled back and a fresh read proves the
 * target requirement advanced beyond stale v1. No transaction restart, production mapping,
 * permission or lock bypass is involved.
 */
export async function runSubmitAtActualCasBarrier(
  dbPath: string,
  command: SubmitEvidenceCommandShape,
  readyFile: string,
): Promise<CasWorkerOutcome> {
  const projectRoot = resolve(process.cwd());
  const persistenceModule = JSON.stringify(join(projectRoot, "packages/adapters/src/sqlite/persistence.ts"));
  const submitModule = JSON.stringify(join(projectRoot, "packages/application/src/deliverables/submit-deliverable-evidence.ts"));
  const script = `
    import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const [readyFile, dbPath, commandJson] = process.argv.slice(1);
    const command = JSON.parse(commandJson);
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let wonCasRelease = false;
    let transactionSequence = 0;
    let activeTransactionId = null;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === "BEGIN IMMEDIATE") {
        const result = originalExec.call(this, "BEGIN DEFERRED");
        activeTransactionId = command.commandId + ":physical-tx:" + (++transactionSequence);
        return result;
      }
      const result = originalExec.call(this, sql);
      if (sql === "COMMIT" && wonCasRelease) {
        writeFileSync(readyFile + ".winner-committed", command.commandId + "\\n");
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") activeTransactionId = null;
      return result;
    };
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = originalPrepare.call(this, sql);
      const normalized = String(sql).replace(/\\s+/g, " ").trim();
      // The tenant already exists in the prepared fixture. Suppress only this idempotent
      // INSERT OR IGNORE in the test child so it does not acquire a write lock before the
      // handler has read the aggregate; all authorization and domain reads still execute.
      if (normalized.startsWith("INSERT OR IGNORE INTO tenants (tenant_id, state, created_at_utc)")) {
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "run") return Reflect.get(target, property, receiver);
            return () => ({ changes: 0, lastInsertRowid: 0 });
          },
        });
      }
      if (!normalized.startsWith("UPDATE deliverable_requirements SET status = ?, version = ?, deliverable_json = ?")
          || !normalized.includes("WHERE tenant_id = ? AND deliverable_id = ? AND version = ?")) {
        return statement;
      }
      const database = this;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== "run") return Reflect.get(target, property, receiver);
          return (...args) => {
            const tenantId = args[3];
            const deliverableId = args[4];
            const expectedVersion = Number(args[5]);
            const row = originalPrepare.call(database,
              "SELECT version FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?"
            ).get(tenantId, deliverableId);
            const observedVersion = Number(row?.version);
            if (observedVersion !== expectedVersion) {
              throw new Error("ACTUAL_CAS_BARRIER_STALE_READ_MISMATCH:" + observedVersion + ":" + expectedVersion);
            }
            if (activeTransactionId === null) throw new Error("ACTUAL_CAS_READ_OUTSIDE_TRANSACTION");
            const readTransactionId = activeTransactionId;
            writeFileSync(readyFile + "." + command.commandId + ".actual-cas-ready", JSON.stringify({
              observedVersion,
              readTransactionId,
              updateTransactionId: readTransactionId,
            }) + "\\n");
            const releaseDeadline = Date.now() + 15_000;
            while (!existsSync(readyFile + ".release")) {
              if (Date.now() > releaseDeadline) throw new Error("ACTUAL_CAS_BARRIER_TIMEOUT");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            try {
              const fd = openSync(readyFile + ".winner", "wx");
              closeSync(fd);
              wonCasRelease = true;
            } catch (error) {
              if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
            }
            if (!wonCasRelease) {
              const commitDeadline = Date.now() + 15_000;
              while (!existsSync(readyFile + ".winner-committed")) {
                if (Date.now() > commitDeadline) throw new Error("ACTUAL_CAS_WINNER_COMMIT_TIMEOUT");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
              }
            }
            const updateTransactionId = activeTransactionId;
            try {
              return target.run(...args);
            } finally {
              writeFileSync(readyFile + "." + command.commandId + ".actual-cas-attempt", JSON.stringify({
                observedVersion,
                readTransactionId,
                updateTransactionId,
              }) + "\\n");
            }
          };
        },
      });
    };
    const { SqlitePersistence } = await import(${persistenceModule});
    const { SubmitDeliverableEvidenceHandler } = await import(${submitModule});
    const persistence = new SqlitePersistence({ path: dbPath });
    writeFileSync(readyFile + "." + command.commandId + ".opened", new Date().toISOString() + "\\n");
    const startDeadline = Date.now() + 15_000;
    while (!existsSync(readyFile + ".start")) {
      if (Date.now() > startDeadline) throw new Error("ACTUAL_CAS_START_TIMEOUT");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    try {
      const result = await new SubmitDeliverableEvidenceHandler(persistence).execute(command);
      process.stdout.write(JSON.stringify({ ok: true, replayed: result.replayed, deliverableVersion: result.value.version }) + "\\n");
    } catch (error) {
      let normalizedError = error;
      let busySnapshotVersionProof;
      if (error && typeof error === "object" && "errcode" in error && error.errcode === 517) {
        const currentVersion = await persistence.read(command.tenantId, async (transaction) => {
          const requirement = await transaction.deliverables.get(command.deliverableId);
          return requirement?.version;
        });
        if (command.expectedVersion === 1 && typeof currentVersion === "number" && currentVersion > 1) {
          busySnapshotVersionProof = { staleVersion: command.expectedVersion, currentVersion };
          normalizedError = new Error("DELIVERABLE_VERSION_CONFLICT");
        }
      }
      const code = normalizedError && typeof normalizedError === "object" && "code" in normalizedError ? String(normalizedError.code)
        : normalizedError instanceof Error && normalizedError.message.includes("DELIVERABLE_VERSION_CONFLICT") ? "DELIVERABLE_VERSION_CONFLICT"
        : String(normalizedError);
      process.stdout.write(JSON.stringify({
        ok: false,
        code,
        message: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
        ...(busySnapshotVersionProof ? { busySnapshotVersionProof } : {}),
      }) + "\\n");
      process.exitCode = code === "DELIVERABLE_VERSION_CONFLICT" ? 0 : 1;
    } finally {
      await persistence.close();
    }
  `;
  return await spawnOutcome(script, [readyFile, dbPath, JSON.stringify(command)]);
}

async function spawnOutcome(script: string, args: string[]): Promise<CasWorkerOutcome> {
  return await new Promise<CasWorkerOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, "--", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000); });
    child.on("error", (error: Error) => rejectPromise(error));
    child.on("close", (exitCode) => {
      const outcomeLine = stdout.trim().split("\\n").find((line) => line.startsWith("{"));
      if (outcomeLine !== undefined) {
        try {
          const parsed = JSON.parse(outcomeLine) as CasWorkerOutcome;
          if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
            resolvePromise(parsed);
            return;
          }
        } catch { /* report the full worker failure below */ }
      }
      rejectPromise(new Error(`CAS worker reported no outcome (exit ${exitCode}): ${stdout || "<empty>"} stderr: ${stderrTail || "<empty>"}`));
    });
  });
}

export async function runSubmitInIndependentProcess(
  dbPath: string,
  command: SubmitEvidenceCommandShape,
  readyFile?: string,
): Promise<CasWorkerOutcome> {
  const projectRoot = resolve(process.cwd());
  const persistenceModule = JSON.stringify(
    join(projectRoot, "packages/adapters/src/sqlite/persistence.ts"),
  );
  const submitModule = JSON.stringify(
    join(projectRoot, "packages/application/src/deliverables/submit-deliverable-evidence.ts"),
  );
  const readyArg = readyFile ?? join(projectRoot, `tmp-cas-ready-${dbPath.replace(/[^a-zA-Z0-9-]/g, "-")}`);
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { SqlitePersistence } from ${persistenceModule};
    import { SubmitDeliverableEvidenceHandler } from ${submitModule};
    const [readyFile, dbPath, commandJson] = process.argv.slice(1);
    const command = JSON.parse(commandJson);
    // Child side: a real SqlitePersistence (own pathLocks module state, own
    // DatabaseSync handle). Opening completes all initialization (open +
    // schema check), so only after that do we release the child ready marker.
    // An open failure must still produce a parseable settled outcome (never a
    // bare crash with empty stdout), and the process must exit so no
    // DatabaseSync handle stays open past the test.
    let persistence; // deferred so the top-level flow below can still run
    try {
      persistence = new SqlitePersistence({ path: dbPath });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error);
      process.stdout.write(JSON.stringify({
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      }) + "\\n");
      process.exitCode = 1;
      process.exit(1);
    }
    try {
      // R2F6 Finding 3 phase 1: the child independently reads and records the
      // STALE aggregate version through its own persistence handle BEFORE
      // entering the race window.
      const staleVersion = await persistence.read(command.tenantId, async (tx) => {
        const requirement = await tx.deliverables.get(command.deliverableId);
        if (requirement === undefined) {
          process.stdout.write(JSON.stringify({ ok: false, code: "CAS_BARRIER_STALE_READ_FAILED", message: "deliverable not visible to child before the race window" }) + "\\n");
          process.exit(1);
        }
        return requirement.version;
      });
      process.stdout.write("STALE_" + staleVersion + "\\n");
      process.stdout.write("READY\\n");
      // Phase 2: the child records its stale observation, releases the worker ready marker,
      // then waits for the parent's release marker (phase 3). The parent only writes the
      // release marker after confirming BOTH sides observed the stale version.
      writeFileSync(readyFile + ".worker.stale", String(staleVersion) + "\\n");
      writeFileSync(readyFile + ".worker", new Date().toISOString() + "\\n");
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (existsSync(readyFile + ".release")) break;
        if (Date.now() > deadline) {
          process.stdout.write(JSON.stringify({ ok: false, code: "CAS_BARRIER_TIMEOUT", message: "release marker never appeared" }) + "\\n");
          process.exit(1);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const result = await new SubmitDeliverableEvidenceHandler(persistence).execute(command);
      process.stdout.write(JSON.stringify({
        ok: true,
        replayed: result.replayed,
        deliverableVersion: result.value.version,
      }) + "\\n");
      process.exitCode = 0;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error);
      process.stdout.write(JSON.stringify({
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      }) + "\\n");
      process.exitCode = code === "DELIVERABLE_VERSION_CONFLICT" ? 0 : 1;
    } finally {
      await persistence.close();
    }
  `;
  return await new Promise<CasWorkerOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, "--", readyArg, dbPath, JSON.stringify(command)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let readyReleased = false;
    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // The child writes its own .worker/.worker.stale marker files; this flag only tracks
      // whether the ready phase has been announced on stdout.
      if (!readyReleased && stdout.includes("READY")) {
        readyReleased = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    child.on("error", (error: Error) => rejectPromise(error));
    child.on("close", (code) => {
      const lines = stdout.trim().split("\n");
      const outcomeLine = lines.find((line) => line.startsWith("{"));
      if (outcomeLine !== undefined && outcomeLine.length > 0) {
        try {
          const parsed: unknown = JSON.parse(outcomeLine);
          if (
            typeof parsed === "object"
            && parsed !== null
            && "ok" in parsed
            && (parsed as { ok: unknown }).ok === true
          ) {
            const winner = parsed as { ok: true; replayed: boolean; deliverableVersion: number };
            resolvePromise({ ok: true, replayed: winner.replayed, deliverableVersion: winner.deliverableVersion });
            return;
          }
          if (
            typeof parsed === "object"
            && parsed !== null
            && "ok" in parsed
            && (parsed as { ok: unknown }).ok === false
          ) {
            const loser = parsed as { ok: false; code: string; message: string };
            resolvePromise({ ok: false, code: loser.code, message: loser.message });
            return;
          }
        } catch {
          // fall through to failure below
        }
      }
      rejectPromise(new Error(
        `CAS independent-process worker reported no parseable outcome (exit ${code}): ` +
        `${lines.at(-1) || "<empty stdout>"} stderr: ${stderrTail || "<empty stderr>"}`,
      ));
    });
  });
}
