import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { digestId, hash, RaCoreError, workspaceActions } from './contract.mjs';

const load = createRequire(import.meta.url);
const day = 86_400_000;
const retention = 7 * day;
const admissionAge = 10 * 60_000;
const futureSkew = 60_000;
const operationLimit = 4096;
const activationLimit = 512;
const applicationId = 0x52414331;

const schema = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
  INSERT INTO metadata VALUES ('admission_floor', 0);
  CREATE TABLE activations (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, origin TEXT NOT NULL, node TEXT NOT NULL, workspace TEXT NOT NULL,
    binding_key TEXT NOT NULL, actions TEXT NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100), uses INTEGER NOT NULL CHECK(uses BETWEEN 0 AND max_uses),
    revoked_at INTEGER, UNIQUE(device, origin, node, workspace)
  ) STRICT;
  CREATE TABLE operations (
    device TEXT NOT NULL, origin TEXT NOT NULL, id TEXT NOT NULL, computer TEXT NOT NULL, app TEXT NOT NULL,
    thread TEXT NOT NULL, project TEXT, node TEXT NOT NULL, workspace TEXT NOT NULL, activation TEXT NOT NULL,
    action TEXT NOT NULL, request_hash TEXT NOT NULL, artifact_path TEXT,
    use_number INTEGER NOT NULL, use_limit INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('RESERVED', 'STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
    reserved_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    error_code TEXT, peer_status INTEGER, result TEXT,
    PRIMARY KEY(device, origin, id)
  ) STRICT;
  CREATE INDEX operations_by_origin ON operations(device, origin, reserved_at DESC, id DESC);
`;

const keys = row => [row.device, row.origin, row.id];
const storageError = () => new RaCoreError(503, 'journal_unavailable');

export function activationView(row, now) {
  const actions = JSON.parse(row.actions);
  if (!Array.isArray(actions) || !actions.length || actions.some(action => !workspaceActions.includes(action)) || !digestId(row.binding_key))
    throw storageError();
  const state = row.revoked_at !== null ? 'revoked' : row.expires_at <= now ? 'expired' : row.uses >= row.max_uses ? 'exhausted' : 'active';
  return { id: row.id, originId: row.origin, nodeId: row.node, workspaceId: row.workspace, actions, state,
    grantVerifiedAt: row.verified_at, expiresAt: row.expires_at, maxUses: row.max_uses, uses: row.uses, revokedAt: row.revoked_at };
}

function resultView(json) {
  if (!json) return null;
  const result = JSON.parse(json);
  const summary = {};
  for (const key of ['size', 'entryCount', 'exitCode']) if (Number.isSafeInteger(result[key])) summary[key] = result[key];
  for (const key of ['sent', 'closed', 'exited', 'truncated']) if (typeof result[key] === 'boolean') summary[key] = result[key];
  return summary;
}

export function operationView(row) {
  const origin = { id: row.origin, deviceId: row.device, computerId: row.computer, app: row.app, threadId: row.thread,
    ...(row.project ? { projectId: row.project } : {}) };
  const artifacts = row.artifact_path === null ? [] : [{
    id: hash([...keys(row), row.node, row.workspace]), kind: row.action === 'list-files' ? 'directory' : 'file',
    nodeId: row.node, workspaceId: row.workspace,
  }];
  return { id: row.id, origin, nodeId: row.node, workspaceId: row.workspace, action: row.action, activationId: row.activation,
    state: row.state, reservedAt: row.reserved_at, startedAt: row.started_at, finishedAt: row.finished_at,
    useNumber: row.use_number, useLimit: row.use_limit, artifacts, result: resultView(row.result),
    error: row.error_code, peerStatus: row.peer_status };
}

export class RaCoreJournal {
  #db;
  #usable = true;

  constructor(dataDir, now = Date.now()) {
    const { DatabaseSync } = load('node:sqlite');
    const file = path.join(dataDir, 'ra-core-v1.sqlite');
    fs.mkdirSync(dataDir, { mode: 0o700, recursive: true });
    const old = fs.lstatSync(file, { throwIfNoEntry: false });
    if (old && !old.isFile()) throw storageError();
    if (!old) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    const db = this.#db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
      // Acquire the lifetime lock before initializing or recovering the journal.
      this.#transaction(() => {
        if (!old) db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${schema}`);
        if (db.prepare('PRAGMA application_id').get().application_id !== applicationId
          || db.prepare('PRAGMA user_version').get().user_version !== 1
          || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw storageError();
        this.#prune(now);
        db.prepare(`UPDATE operations SET state = 'UNKNOWN', finished_at = ?, error_code = 'relay_restarted'
          WHERE state IN ('RESERVED', 'STARTED')`).run(now);
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  #statement(sql) {
    if (!this.#usable) throw storageError();
    return this.#db.prepare(sql);
  }

  #transaction(run) {
    if (!this.#usable) throw storageError();
    this.#db.exec('BEGIN EXCLUSIVE');
    try {
      const value = run();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); }
      catch { this.#usable = false; }
      throw error;
    }
  }

  #prune(now) {
    const floor = this.#statement("SELECT value FROM metadata WHERE key = 'admission_floor'").get()?.value;
    if (!Number.isSafeInteger(floor) || floor < 0) throw storageError();
    const cutoff = Math.max(floor, now - retention);
    if (cutoff > floor) {
      // Both the final outcome and the ID's creation time must be outside retention.
      this.#statement("DELETE FROM operations WHERE finished_at < ? AND CAST(substr(id, 1, 13) AS INTEGER) < ?").run(cutoff, cutoff);
      this.#statement('DELETE FROM activations WHERE coalesce(revoked_at, expires_at) < ?').run(cutoff);
      this.#statement("UPDATE metadata SET value = ? WHERE key = 'admission_floor'").run(cutoff);
    }
    return cutoff;
  }

  activations(device, origin) {
    return this.#statement('SELECT * FROM activations WHERE device = ? AND origin = ? ORDER BY verified_at DESC').all(device, origin);
  }

  activation(device, origin, id) {
    return this.#statement('SELECT * FROM activations WHERE device = ? AND origin = ? AND id = ?').get(device, origin, id);
  }

  #scope(device, origin, node, workspace) {
    return this.#statement('SELECT * FROM activations WHERE device = ? AND origin = ? AND node = ? AND workspace = ?').get(device, origin, node, workspace);
  }

  assertCanActivate(device, origin, node, workspace, now) {
    const current = this.#scope(device, origin, node, workspace);
    if (current && activationView(current, now).state === 'active') throw new RaCoreError(409, 'activation_exists');
  }

  activate({ device, origin, node, workspace, bindingKey, actions, verifiedAt, expiresAt, maxUses }, now) {
    return this.#transaction(() => {
      this.#prune(now);
      this.assertCanActivate(device, origin, node, workspace, now);
      this.#statement('DELETE FROM activations WHERE device = ? AND origin = ? AND node = ? AND workspace = ?').run(device, origin, node, workspace);
      if (this.#statement('SELECT count(*) AS count FROM activations').get().count >= activationLimit)
        throw new RaCoreError(409, 'activation_capacity');
      const id = randomUUID();
      this.#statement('INSERT INTO activations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)')
        .run(id, device, origin, node, workspace, bindingKey, JSON.stringify(actions), verifiedAt, expiresAt, maxUses);
      return this.activation(device, origin, id);
    });
  }

  revoke(device, origin, id, now) {
    return this.#transaction(() => {
      const row = this.activation(device, origin, id);
      if (!row) throw new RaCoreError(409, 'activation_missing');
      this.#statement('UPDATE activations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
      const inFlight = this.#statement(`SELECT * FROM operations
        WHERE device = ? AND origin = ? AND activation = ? AND state = 'STARTED'
        ORDER BY started_at DESC, id DESC`).all(device, origin, id);
      return { row: this.activation(device, origin, id), inFlight };
    });
  }

  #operation(device, origin, id) {
    return this.#statement('SELECT * FROM operations WHERE device = ? AND origin = ? AND id = ?').get(device, origin, id);
  }

  work(device, origin, id) {
    if (id) {
      const row = this.#operation(device, origin, id);
      return row ? [row] : [];
    }
    return this.#statement('SELECT * FROM operations WHERE device = ? AND origin = ? ORDER BY reserved_at DESC, id DESC LIMIT 100').all(device, origin);
  }

  requireAction(device, origin, id, node, workspace, action, now) {
    const row = this.activation(device, origin, id);
    if (!row || row.node !== node || row.workspace !== workspace) throw new RaCoreError(403, 'activation_required');
    const view = activationView(row, now);
    if (['revoked', 'expired'].includes(view.state) || !view.actions.includes(action))
      throw new RaCoreError(403, 'action_not_activated');
    return { row, view };
  }

  reserve({ id, origin, activationId, node, workspace, bindingKey, action, args }, clock) {
    return this.#transaction(() => {
      const now = clock();
      const { deviceId: device, id: originId } = origin;
      const { row: activation, view } = this.requireAction(device, originId, activationId, node, workspace, action, now);
      if (bindingKey !== activation.binding_key) throw new RaCoreError(409, 'binding_stale');

      const requestHash = hash([node, workspace, action, args]);
      const known = this.#operation(device, originId, id);
      if (known) {
        if (known.request_hash !== requestHash) throw new RaCoreError(409, 'operation_id_conflict');
        return { row: known, replay: true };
      }
      if (view.state === 'exhausted') throw new RaCoreError(403, 'activation_exhausted');
      const issuedAt = Number(id.slice(0, 13));
      const floor = this.#prune(now);
      if (issuedAt < now - admissionAge || issuedAt > now + futureSkew || issuedAt <= floor)
        throw new RaCoreError(409, 'operation_id_out_of_window');
      if (this.#statement('SELECT count(*) AS count FROM operations').get().count >= operationLimit)
        throw new RaCoreError(409, 'journal_capacity');

      this.#statement('UPDATE activations SET uses = uses + 1 WHERE id = ?').run(activationId);
      this.#statement(`INSERT INTO operations
        (device, origin, id, computer, app, thread, project, node, workspace, activation, action, request_hash, artifact_path,
          use_number, use_limit, state, reserved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?)`)
        .run(device, originId, id, origin.computerId, origin.app, origin.threadId, origin.projectId ?? null, node, workspace,
          activationId, action, requestHash, args.path ?? null, view.uses + 1, view.maxUses, now);
      return { row: this.#operation(device, originId, id), replay: false };
    });
  }

  start(row, clock) {
    return this.#transaction(() => {
      const now = clock();
      const update = this.#statement(`UPDATE operations SET state = 'STARTED', started_at = ?
        WHERE device = ? AND origin = ? AND id = ? AND state = 'RESERVED'
          AND EXISTS (SELECT 1 FROM activations WHERE id = operations.activation AND revoked_at IS NULL AND expires_at > ?)`)
        .run(now, ...keys(row), now);
      if (update.changes === 1) return null;
      const rejected = this.#statement(`UPDATE operations SET state = 'FAILED', finished_at = ?, error_code = 'action_not_activated'
        WHERE device = ? AND origin = ? AND id = ? AND state = 'RESERVED'`).run(now, ...keys(row));
      if (rejected.changes !== 1) throw storageError();
      return this.#operation(...keys(row));
    });
  }

  finish(row, { state, result, error, peerStatus }, now) {
    try {
      const update = this.#statement(`UPDATE operations SET state = ?, finished_at = ?, result = ?, error_code = ?, peer_status = ?
        WHERE device = ? AND origin = ? AND id = ? AND state = 'STARTED'`)
        .run(state, now, result ? JSON.stringify(result) : null, error ?? null, peerStatus ?? null, ...keys(row));
      if (update.changes !== 1) throw storageError();
      return this.#operation(...keys(row));
    } catch {
      // The peer may have acted. Keep this journal closed to further dispatch until recovery.
      this.#usable = false;
      throw storageError();
    }
  }
}
