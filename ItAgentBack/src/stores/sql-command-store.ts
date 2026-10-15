/**
 * 指令儲存(SQL Server 2012,migration 0003;PLATFORM-PLAN P4、ENDPOINT-AGENT-GUIDE §8.4–§8.5):ita.command、ita.command_batch、
 * ita.command_file(指令附檔索引,P4-2;檔案本身在 COMMAND_FILES_DIR)。
 * 與 SqlDeviceStore 共用連線池。狀態轉換一律條件更新(WHERE state IN …):多個來源同時更新時只有一個成功,狀態只能往前。
 */
import sql from 'mssql';
import type {
  BatchRecord,
  CommandFileRecord,
  CommandFileStore,
  CommandFilter,
  CommandPatch,
  CommandRecord,
  CommandState,
  CommandStore,
  NewBatch,
  NewCommand,
  NewCommandFile,
} from './types.js';

type Row = Record<string, unknown>;

const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);

const COLS = `c.id, c.command_id, c.batch_ref, b.batch_id, b.max_concurrent, c.device_ref, d.device_id, d.computer_name, c.cert_dn, c.kind, c.level, c.params,
  c.state, c.progress, c.result_summary, c.error_code, c.error_message, c.expires_at, c.timeout_at, c.send_count, c.created_by_emp, c.created_by_name,
  c.request_id, c.created_at, c.sent_at, c.acked_at, c.started_at, c.finished_at`;
const FROM = `ita.command c JOIN ita.device d ON d.id = c.device_ref LEFT JOIN ita.command_batch b ON b.id = c.batch_ref`;

const dateOrNull = (v: unknown) => (v as Date | null) ?? null;
const strOrNull = (v: unknown) => (v == null ? null : String(v));

function toCommand(r: Row): CommandRecord {
  return {
    // BIGINT 由 tedious 以字串傳回
    id: Number(r.id),
    commandId: String(r.command_id).toLowerCase(),
    batchRef: r.batch_ref == null ? null : Number(r.batch_ref),
    batchId: r.batch_id == null ? null : String(r.batch_id).toLowerCase(),
    batchMaxConcurrent: r.max_concurrent == null ? null : Number(r.max_concurrent),
    deviceRef: Number(r.device_ref),
    deviceId: String(r.device_id).toLowerCase(),
    computerName: String(r.computer_name),
    certDn: String(r.cert_dn),
    kind: String(r.kind),
    level: r.level === 'admin' ? 'admin' : 'basic',
    params: String(r.params),
    state: r.state as CommandState,
    progress: r.progress == null ? null : Number(r.progress),
    resultSummary: strOrNull(r.result_summary),
    errorCode: strOrNull(r.error_code),
    errorMessage: strOrNull(r.error_message),
    expiresAt: r.expires_at as Date,
    timeoutAt: dateOrNull(r.timeout_at),
    sendCount: Number(r.send_count),
    createdByEmp: String(r.created_by_emp),
    createdByName: strOrNull(r.created_by_name),
    requestId: strOrNull(r.request_id),
    createdAt: r.created_at as Date,
    sentAt: dateOrNull(r.sent_at),
    ackedAt: dateOrNull(r.acked_at),
    startedAt: dateOrNull(r.started_at),
    finishedAt: dateOrNull(r.finished_at),
  };
}

const FILE_COLS = `f.id, f.file_id, f.command_ref, c.command_id, f.file_name, f.size_bytes, f.sha256, f.storage_path, f.created_at, f.expires_at`;
const FILE_FROM = `ita.command_file f JOIN ita.command c ON c.id = f.command_ref`;

function toFile(r: Row): CommandFileRecord {
  return {
    id: Number(r.id),
    fileId: String(r.file_id).toLowerCase(),
    commandRef: Number(r.command_ref),
    commandId: String(r.command_id).toLowerCase(),
    fileName: String(r.file_name),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    storagePath: String(r.storage_path),
    createdAt: r.created_at as Date,
    expiresAt: r.expires_at as Date,
  };
}

export class SqlCommandStore implements CommandStore, CommandFileStore {
  constructor(private readonly pool: () => Promise<sql.ConnectionPool>) {}

  private async request(): Promise<sql.Request> {
    return (await this.pool()).request();
  }

  async createCommands(batch: NewBatch | null, commands: NewCommand[]): Promise<void> {
    const tx = new sql.Transaction(await this.pool());
    await tx.begin();
    try {
      let batchRef: number | null = null;
      if (batch) {
        const r = await new sql.Request(tx)
          .input('bid', sql.UniqueIdentifier, batch.batchId)
          .input('kind', sql.VarChar(64), batch.kind)
          .input('level', sql.VarChar(8), batch.level)
          .input('params', sql.NVarChar(4000), batch.params)
          .input('n', sql.Int, commands.length)
          .input('max', sql.Int, batch.maxConcurrent)
          .input('idem', sql.VarChar(128), batch.idempotencyKey)
          .input('emp', sql.NVarChar(64), batch.createdByEmp)
          .input('name', sql.NVarChar(100), cut(batch.createdByName, 100))
          .input('rid', sql.VarChar(64), cut(batch.requestId, 64))
          .input('at', sql.DateTime2(3), batch.createdAt).query(`
            INSERT INTO ita.command_batch (batch_id, kind, level, params, target_count, max_concurrent, idempotency_key, created_by_emp, created_by_name, request_id, created_at)
            OUTPUT INSERTED.id
            VALUES (@bid, @kind, @level, @params, @n, @max, @idem, @emp, @name, @rid, @at)`);
        batchRef = Number((r.recordset[0] as Row).id);
      }
      // 每列 12 個參數,每批 100 列(參數上限 2100)
      for (let i = 0; i < commands.length; i += 100) {
        const req = new sql.Request(tx).input('batch', sql.BigInt, batchRef);
        const values = commands.slice(i, i + 100).map((c, k) => {
          req
            .input(`c${k}`, sql.UniqueIdentifier, c.commandId)
            .input(`d${k}`, sql.Int, c.deviceRef)
            .input(`n${k}`, sql.NVarChar(450), c.certDn)
            .input(`k${k}`, sql.VarChar(64), c.kind)
            .input(`l${k}`, sql.VarChar(8), c.level)
            .input(`p${k}`, sql.NVarChar(4000), c.params)
            .input(`x${k}`, sql.DateTime2(3), c.expiresAt)
            .input(`i${k}`, sql.VarChar(128), c.idempotencyKey)
            .input(`e${k}`, sql.NVarChar(64), c.createdByEmp)
            .input(`m${k}`, sql.NVarChar(100), cut(c.createdByName, 100))
            .input(`r${k}`, sql.VarChar(64), cut(c.requestId, 64))
            .input(`a${k}`, sql.DateTime2(3), c.createdAt);
          return `(@c${k}, @batch, @d${k}, @n${k}, @k${k}, @l${k}, @p${k}, @x${k}, @i${k}, @e${k}, @m${k}, @r${k}, @a${k}, @a${k})`;
        });
        await req.query(`INSERT INTO ita.command (command_id, batch_ref, device_ref, cert_dn, kind, level, params, expires_at, idempotency_key,
          created_by_emp, created_by_name, request_id, created_at, updated_at) VALUES ${values.join(', ')}`);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  private async one(where: string, bind: (r: sql.Request) => sql.Request): Promise<CommandRecord | null> {
    const r = await bind(await this.request()).query(`SELECT ${COLS} FROM ${FROM} WHERE ${where}`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toCommand(row) : null;
  }

  getCommand(commandId: string): Promise<CommandRecord | null> {
    return this.one('c.command_id = @cid', (r) => r.input('cid', sql.UniqueIdentifier, commandId));
  }

  findByIdempotency(emp: string, key: string): Promise<CommandRecord | null> {
    return this.one('c.created_by_emp = @emp AND c.idempotency_key = @idem AND c.batch_ref IS NULL', (r) =>
      r.input('emp', sql.NVarChar(64), emp).input('idem', sql.VarChar(128), key),
    );
  }

  private async batchWhere(where: string, bind: (r: sql.Request) => sql.Request): Promise<BatchRecord | null> {
    const r = await bind(await this.request()).query(`
      SELECT b.id, b.batch_id, b.kind, b.level, b.params, b.target_count, b.max_concurrent, b.created_by_emp, b.created_by_name, b.created_at
      FROM ita.command_batch b WHERE ${where};
      SELECT c.state, COUNT(*) AS n FROM ita.command c JOIN ita.command_batch b ON b.id = c.batch_ref WHERE ${where} GROUP BY c.state;`);
    const sets = r.recordsets as unknown as Row[][];
    const row = sets[0]?.[0];
    if (!row) return null;
    const counts: BatchRecord['counts'] = {};
    for (const s of sets[1] ?? []) counts[s.state as CommandState] = Number(s.n);
    return {
      id: Number(row.id),
      batchId: String(row.batch_id).toLowerCase(),
      kind: String(row.kind),
      level: row.level === 'admin' ? 'admin' : 'basic',
      params: String(row.params),
      targetCount: Number(row.target_count),
      maxConcurrent: Number(row.max_concurrent),
      createdByEmp: String(row.created_by_emp),
      createdByName: strOrNull(row.created_by_name),
      createdAt: row.created_at as Date,
      counts,
    };
  }

  findBatchByIdempotency(emp: string, key: string): Promise<BatchRecord | null> {
    return this.batchWhere('b.created_by_emp = @emp AND b.idempotency_key = @idem', (r) =>
      r.input('emp', sql.NVarChar(64), emp).input('idem', sql.VarChar(128), key),
    );
  }

  getBatch(batchId: string): Promise<BatchRecord | null> {
    return this.batchWhere('b.batch_id = @bid', (r) => r.input('bid', sql.UniqueIdentifier, batchId));
  }

  async listCommands(f: CommandFilter): Promise<CommandRecord[]> {
    const req = (await this.request()).input('limit', sql.Int, f.limit);
    const where: string[] = [];
    if (f.deviceRef !== undefined) {
      where.push('c.device_ref = @dev');
      req.input('dev', sql.Int, f.deviceRef);
    }
    if (f.batchRef !== undefined) {
      where.push('c.batch_ref = @batch');
      req.input('batch', sql.BigInt, f.batchRef);
    }
    if (f.state) {
      where.push('c.state = @state');
      req.input('state', sql.VarChar(16), f.state);
    }
    if (f.kind) {
      where.push('c.kind = @kind');
      req.input('kind', sql.VarChar(64), f.kind);
    }
    if (f.beforeId !== undefined) {
      where.push('c.id < @before');
      req.input('before', sql.BigInt, f.beforeId);
    }
    const r = await req.query(`SELECT TOP (@limit) ${COLS} FROM ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC`);
    return (r.recordset as Row[]).map(toCommand);
  }

  async transition(id: number, from: CommandState[], p: CommandPatch): Promise<boolean> {
    const req = (await this.request())
      .input('id', sql.BigInt, id)
      .input('state', sql.VarChar(16), p.state)
      .input('at', sql.DateTime2(3), p.at)
      .input('setProgress', sql.Bit, p.progress !== undefined)
      .input('progress', sql.TinyInt, p.progress ?? null)
      .input('setResult', sql.Bit, p.resultSummary !== undefined)
      .input('result', sql.NVarChar(4000), p.resultSummary ?? null)
      .input('code', sql.VarChar(64), cut(p.errorCode, 64))
      .input('msg', sql.NVarChar(1000), cut(p.errorMessage, 1000))
      .input('timeout', sql.DateTime2(3), p.timeoutAt ?? null)
      .input('markStarted', sql.Bit, p.markStarted === true);
    const states = from.map((s, k) => {
      req.input(`f${k}`, sql.VarChar(16), s);
      return `@f${k}`;
    });
    // 各階段時間:sent 每次送出更新;acked / started 只記第一次(Agent 直接回終態時補 acked);終態記 finished_at
    const r = await req.query(`
      UPDATE ita.command SET
        state = @state,
        progress = CASE WHEN @setProgress = 1 THEN @progress ELSE progress END,
        result_summary = CASE WHEN @setResult = 1 THEN @result ELSE result_summary END,
        error_code = COALESCE(@code, error_code),
        error_message = COALESCE(@msg, error_message),
        timeout_at = COALESCE(timeout_at, @timeout),
        send_count = CASE WHEN @state = 'sent' THEN send_count + 1 ELSE send_count END,
        sent_at = CASE WHEN @state = 'sent' THEN @at ELSE sent_at END,
        acked_at = CASE WHEN @state IN ('acked', 'running', 'succeeded', 'failed') AND acked_at IS NULL AND sent_at IS NOT NULL THEN @at ELSE acked_at END,
        started_at = CASE WHEN started_at IS NOT NULL THEN started_at WHEN @state = 'running' THEN @at
          WHEN @markStarted = 1 THEN COALESCE(acked_at, @at) ELSE started_at END,
        finished_at = CASE WHEN @state IN ('succeeded', 'failed', 'canceled', 'expired') THEN @at ELSE finished_at END,
        updated_at = SYSUTCDATETIME()
      WHERE id = @id AND state IN (${states.join(', ')})`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async requeueSent(deviceRef: number): Promise<number> {
    const r = await (await this.request())
      .input('dev', sql.Int, deviceRef)
      .query(`UPDATE ita.command SET state = 'queued', updated_at = SYSUTCDATETIME() WHERE device_ref = @dev AND state = 'sent'`);
    return r.rowsAffected[0] ?? 0;
  }

  async queuedForDevice(deviceRef: number, now: Date): Promise<CommandRecord[]> {
    const r = await (await this.request())
      .input('dev', sql.Int, deviceRef)
      .input('now', sql.DateTime2(3), now)
      .query(`SELECT TOP (200) ${COLS} FROM ${FROM} WHERE c.device_ref = @dev AND c.state = 'queued' AND c.expires_at > @now ORDER BY c.created_at, c.id`);
    return (r.recordset as Row[]).map(toCommand);
  }

  async queuedForBatch(batchRef: number, now: Date, limit: number): Promise<CommandRecord[]> {
    const r = await (await this.request())
      .input('batch', sql.BigInt, batchRef)
      .input('now', sql.DateTime2(3), now)
      .input('limit', sql.Int, limit)
      .query(`SELECT TOP (@limit) ${COLS} FROM ${FROM} WHERE c.batch_ref = @batch AND c.state = 'queued' AND c.expires_at > @now ORDER BY c.created_at, c.id`);
    return (r.recordset as Row[]).map(toCommand);
  }

  async activeInBatch(batchRef: number): Promise<number> {
    const r = await (await this.request())
      .input('batch', sql.BigInt, batchRef)
      .query(`SELECT COUNT(*) AS n FROM ita.command WHERE batch_ref = @batch AND state IN ('sent', 'acked', 'running')`);
    return Number((r.recordset[0] as Row).n);
  }

  async pendingCount(deviceRef: number, kind: string): Promise<number> {
    const r = await (await this.request())
      .input('dev', sql.Int, deviceRef)
      .input('kind', sql.VarChar(64), kind)
      .query(`SELECT COUNT(*) AS n FROM ita.command WHERE device_ref = @dev AND kind = @kind AND state IN ('queued', 'sent', 'acked', 'running')`);
    return Number((r.recordset[0] as Row).n);
  }

  async dueForSweep(now: Date, limit: number): Promise<CommandRecord[]> {
    const r = await (await this.request()).input('now', sql.DateTime2(3), now).input('limit', sql.Int, limit).query(`
      SELECT TOP (@limit) ${COLS} FROM ${FROM}
      WHERE (c.state IN ('queued', 'sent') AND c.expires_at <= @now) OR (c.state IN ('acked', 'running') AND c.timeout_at <= @now)
      ORDER BY c.id`);
    return (r.recordset as Row[]).map(toCommand);
  }

  // ---------- 指令附檔 ----------

  async addFile(f: NewCommandFile): Promise<void> {
    await (await this.request())
      .input('fid', sql.UniqueIdentifier, f.fileId)
      .input('cmd', sql.BigInt, f.commandRef)
      .input('name', sql.NVarChar(255), f.fileName)
      .input('size', sql.BigInt, f.sizeBytes)
      .input('sha', sql.Char(64), f.sha256)
      .input('path', sql.NVarChar(400), f.storagePath)
      .input('at', sql.DateTime2(3), f.createdAt)
      .input('exp', sql.DateTime2(3), f.expiresAt)
      .query(`INSERT INTO ita.command_file (file_id, command_ref, file_name, size_bytes, sha256, storage_path, created_at, expires_at)
        VALUES (@fid, @cmd, @name, @size, @sha, @path, @at, @exp)`);
  }

  async listFiles(commandRef: number): Promise<CommandFileRecord[]> {
    const r = await (await this.request())
      .input('cmd', sql.BigInt, commandRef)
      .query(`SELECT ${FILE_COLS} FROM ${FILE_FROM} WHERE f.command_ref = @cmd ORDER BY f.id`);
    return (r.recordset as Row[]).map(toFile);
  }

  async getFile(fileId: string): Promise<CommandFileRecord | null> {
    const r = await (await this.request()).input('fid', sql.UniqueIdentifier, fileId).query(`SELECT ${FILE_COLS} FROM ${FILE_FROM} WHERE f.file_id = @fid`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toFile(row) : null;
  }

  async expiredFiles(now: Date, limit: number): Promise<CommandFileRecord[]> {
    const r = await (await this.request())
      .input('now', sql.DateTime2(3), now)
      .input('limit', sql.Int, limit)
      .query(`SELECT TOP (@limit) ${FILE_COLS} FROM ${FILE_FROM} WHERE f.expires_at <= @now ORDER BY f.expires_at`);
    return (r.recordset as Row[]).map(toFile);
  }

  async deleteFile(id: number): Promise<void> {
    await (await this.request()).input('id', sql.BigInt, id).query(`DELETE FROM ita.command_file WHERE id = @id`);
  }
}
