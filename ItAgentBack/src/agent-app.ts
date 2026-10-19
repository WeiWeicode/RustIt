/**
 * Agent 通道 :51241(endpoint-agent;ENDPOINT-AGENT-GUIDE §5):Gateway :9443(mTLS)把所有路徑轉送到這裡。
 *   - 只認 Nginx 帶來的 x-client-cert-* 標頭,要求 x-client-verify=SUCCESS,以完整 DN 為裝置鍵(§3.3、§5.2);未通過一律 401
 *   - 標頭只採信來自 AGENT_TRUSTED_PROXIES(Nginx)的連線;dev 以 DEV_TRUST_CLIENT_HEADERS 讓本機 Agent 直連
 *   - POST /agent/v1/inventory(資料契約 inventory.schema.json)、WS GET /agent/v1/ws(信封 ws-envelope.schema.json)
 *   - POST /agent/v1/sync(離線補傳比對,sync.schema.json)、POST /agent/v1/events(端點事件,event.schema.json)(PLATFORM-PLAN P2)
 *   - WS command / command_update / command_update_ack / prepare_shutdown(指令通道,P4;邏輯在 CommandDispatcher)
 *   - POST /agent/v1/watchdog/report(Watchdog 上報,watchdog.schema.json,P5-2):同一張裝置憑證,只更新 Watchdog 欄位與寫 Watchdog 事件
 *   - POST /agent/v1/commands/{commandId}/files(指令附檔,logs.collect 日誌 zip,上限 20 MB;command-file.schema.json,P4-2)
 *   - HTTPS 回報同時處理中的請求超過 AGENT_MAX_INFLIGHT 時回 429 ITA_BUSY + Retry-After,在驗證身分前就擋下(A3)
 *   - 與 :51240 是不同的 Fastify 實例,不共用 hook(§5.2);日誌帶 x-request-id、DN、指紋(§5.7)
 *   - 告警評估(P5):每 5 分鐘由這裡的計時器呼叫 AlertService.sweep(與心跳逾時、指令逾期掃描同一處管理)
 *   - 監控(giga-observe 服務 endpoint-agent,與管理 API 分開的 Key):HTTPS 回報逐筆;WebSocket 每條連線關閉時記一筆
 *     (method WS、持續時間、關閉碼、訊息數;非正常關閉為 warn);心跳附上在線連線數。Agent 的 heartbeat 訊息不逐筆記錄(量大)
 */
import { BlockList } from 'node:net';
import type { Readable } from 'node:stream';
import websocket from '@fastify/websocket';
import { errorBody, type DepStatus, type MonitorEnv, type MonitorLog } from '@giganexus/backend-sdk';
import { setupGateway } from '@giganexus/backend-sdk/fastify';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import {
  CONTRACT_IDS,
  compileWsEnvelope,
  contractsDir,
  loadContract,
  type EventsRequest,
  type HelloBody,
  type InventoryRequest,
  type SyncRequest,
  type WatchdogReportRequest,
  type WsEnvelope,
} from './contracts.js';
import { AppError } from './errors.js';
import type { AlertService } from './services/alert-service.js';
import type { CommandDispatcher, CommandUpdateBody } from './services/command-dispatcher.js';
import type { CommandFileService } from './services/command-files.js';
import type { AgentConnection, Ctx, DeviceService } from './services/device-service.js';
import type { DeviceRecord } from './stores/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceRecord | null;
    /** 已計入同時處理數(A3) */
    inflight: boolean;
  }
  interface FastifyContextConfig {
    /** false:不驗證裝置身分(健康檢查) */
    deviceAuth?: boolean;
  }
}

export interface AgentAppOptions {
  config: Pick<Config, 'logLevel' | 'agentTls' | 'trustedProxies'> & Partial<Pick<Config, 'agentMaxInflight' | 'busyRetryAfterSec'>>;
  service: DeviceService;
  contractsDir?: string;
  /** 心跳逾時檢查間隔(毫秒) */
  sweepIntervalMs?: number;
  /** 指令派送器(P4;省略 = 不處理指令訊息) */
  commands?: CommandDispatcher;
  /** 指令逾期掃描間隔(毫秒) */
  commandSweepIntervalMs?: number;
  /** 指令附檔(P4-2;省略 = 不開放上傳) */
  files?: CommandFileService;
  /** 到期附檔清除間隔(毫秒) */
  fileSweepIntervalMs?: number;
  /** 告警評估(P5;省略 = 不評估) */
  alerts?: AlertService;
  /** 告警評估間隔(毫秒) */
  alertSweepIntervalMs?: number;
  /** giga-observe 監控(loadMonitorEnv;省略 = 不監控) */
  monitor?: MonitorEnv;
  /** 監控心跳附帶的相依服務狀態(SQL Server / Mongo / Redis) */
  deps?: () => Promise<DepStatus[]>;
}

const WS_PATH = '/agent/v1/ws';
/** 正常關閉(1000 正常、1001 離開);其餘(含 1006 斷線、4408 心跳逾時、4409 被新連線取代)記 warn */
const NORMAL_CLOSE = new Set([1000, 1001]);

/** WebSocket 連線結束時的監控紀錄(giga-observe API_CONTRACT §2.1;status 101 = 曾成功升級) */
export function wsSessionLog(o: {
  startedAt: number;
  endedAt: number;
  requestId: string;
  deviceId: string;
  computerName: string;
  ip: string | null;
  code: number;
  messages: number;
  online: number;
}): MonitorLog {
  return {
    ts: new Date(o.startedAt).toISOString(),
    level: NORMAL_CLOSE.has(o.code) ? 'info' : 'warn',
    kind: 'http',
    traceId: o.requestId,
    request: { method: 'WS', path: WS_PATH, pathTemplate: WS_PATH, query: null, body: null, bodySize: 0, bodyTruncated: false, headers: {}, ip: o.ip, userId: o.computerName },
    actions: [],
    response: { status: 101, body: null, bodySize: 0, bodyTruncated: false, durationMs: o.endedAt - o.startedAt },
    error: null,
    meta: { deviceId: o.deviceId, closeCode: o.code, messages: o.messages, online: o.online },
  };
}

/** 單則 WebSocket 訊息上限 1 MB(指南 §5.5);HTTPS 回報(含軟體清單)上限 5 MB */
const WS_MAX_PAYLOAD = 1024 * 1024;
const BODY_LIMIT = 5 * 1024 * 1024;
const FP = /^[0-9a-f]{40}$/;

/** AGENT_TRUSTED_PROXIES:IP 或 CIDR;null = 不檢查(只有 dev 旁路) */
export function proxyChecker(list: string[] | null): (addr: string | undefined) => boolean {
  if (!list) return () => true;
  const allow = new BlockList();
  for (const entry of list) {
    const [ip = '', prefix] = entry.split('/');
    const type = ip.includes(':') ? 'ipv6' : 'ipv4';
    if (prefix) allow.addSubnet(ip, Number(prefix), type);
    else allow.addAddress(ip, type);
  }
  return (addr) => {
    if (!addr) return false;
    const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return allow.check(a, a.includes(':') ? 'ipv6' : 'ipv4');
  };
}

export async function buildAgentApp(opts: AgentAppOptions): Promise<FastifyInstance> {
  const { config, service, commands, files } = opts;
  const dir = opts.contractsDir ?? contractsDir();
  const app = Fastify({
    logger: { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    bodyLimit: BODY_LIMIT,
    ...(config.agentTls ? { https: config.agentTls } : {}),
  }) as unknown as FastifyInstance;

  const fromProxy = proxyChecker(config.trustedProxies);
  const validateEnvelope = compileWsEnvelope(dir);
  app.addSchema(loadContract('inventory', dir));
  app.addSchema(loadContract('sync', dir));
  app.addSchema(loadContract('event', dir));
  app.addSchema(loadContract('watchdog', dir));
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  // 監控需在路由之前註冊;本通道不註冊 OpenAPI(Agent 經 :9443 直達,不經 BFF 路由表)
  await app.register(setupGateway, {
    monitor: opts.monitor ?? false,
    register: false,
    version: process.env.npm_package_version,
    userId: (req) => req.device?.computerName ?? null,
    meta: (req) => (req.device ? { deviceId: req.device.deviceId } : undefined),
    monitorOptions: {
      ignorePaths: ['/healthz', WS_PATH],
      deps: async () => [...((await opts.deps?.()) ?? []), { name: `WebSocket 在線 ${service.onlineCount} 條`, ok: true, latencyMs: null }],
    },
  });

  const ctxOf = (req: FastifyRequest): Ctx => ({ log: req.log, requestId: req.id });

  app.decorateRequest('device', null);
  app.decorateRequest('inflight', false);

  // 主機忙碌(A3):HTTPS 回報同時處理數超過上限回 429 + Retry-After,在身分驗證(查 SQL)之前擋下;WebSocket 不計
  const maxInflight = config.agentMaxInflight ?? 32;
  const retryAfter = String(config.busyRetryAfterSec ?? 30);
  let inflight = 0;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || !req.routeOptions.url?.startsWith('/agent/v1/')) return;
    if (inflight >= maxInflight) {
      req.log.warn({ inflight }, '同時處理的回報超過上限,回 429');
      return reply.status(429).header('retry-after', retryAfter).send(errorBody('ITA_BUSY', '主機忙碌,請稍後重試', req.id));
    }
    inflight++;
    req.inflight = true;
  });
  const release = async (req: FastifyRequest) => {
    if (!req.inflight) return;
    req.inflight = false;
    inflight--;
  };
  app.addHook('onResponse', release);
  app.addHook('onRequestAbort', release);

  // 裝置身分 hook(指南 §5.2):WebSocket 升級請求同樣經過,失敗時升級被拒(HTTP 401 / 403)
  app.addHook('onRequest', async (req) => {
    if (!req.routeOptions.url || req.routeOptions.config.deviceAuth === false) return;
    if (!fromProxy(req.socket.remoteAddress)) {
      req.log.warn({ remote: req.socket.remoteAddress }, '來源不是 Gateway(AGENT_TRUSTED_PROXIES),不採信憑證標頭');
      throw new AppError(401, 'DEVICE_UNAUTHORIZED', '缺少有效的裝置憑證');
    }
    const h = (k: string) => String(req.headers[k] ?? '').trim();
    const dn = h('x-client-cert-dn');
    const fp = h('x-client-cert-fp').toLowerCase();
    if (h('x-client-verify') !== 'SUCCESS' || !dn || dn.length > 450 || !FP.test(fp)) throw new AppError(401, 'DEVICE_UNAUTHORIZED', '缺少有效的裝置憑證');
    req.log = req.log.child({ dn, fp });
    req.device = await service.identify(ctxOf(req), dn, fp);
    req.log = req.log.child({ deviceId: req.device.deviceId });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send(errorBody(err.code, err.message, req.id, err.details));
    const e = err as { validation?: { instancePath: string; message?: string }[]; statusCode?: number };
    if (e.validation) {
      req.log.warn({ validation: e.validation.slice(0, 5) }, '回報內容不符合資料契約');
      return reply.status(400).send(
        errorBody(
          'VALIDATION_FAILED',
          '回報內容不符合資料契約',
          req.id,
          e.validation.map((v) => ({ field: v.instancePath.replace(/^\//, '') || '(body)', message: v.message ?? '' })),
        ),
      );
    }
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody('VALIDATION_FAILED', '請求格式錯誤', req.id));
    req.log.error({ err }, '非預期錯誤');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', '系統發生錯誤', req.id));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody('ITA_NOT_FOUND', '找不到此 API', req.id)));

  app.get('/healthz', { config: { deviceAuth: false } }, async () => ({ status: 'ok' }));

  app.post<{ Body: InventoryRequest }>('/agent/v1/inventory', { schema: { body: { $ref: `${CONTRACT_IDS.inventory}#` } } }, async (req) =>
    service.ingestInventory(ctxOf(req), req.device!, req.body),
  );

  app.post<{ Body: SyncRequest }>('/agent/v1/sync', { schema: { body: { $ref: `${CONTRACT_IDS.sync}#` } } }, async (req) =>
    service.sync(ctxOf(req), req.device!, req.body),
  );

  app.post<{ Body: EventsRequest }>('/agent/v1/events', { schema: { body: { $ref: `${CONTRACT_IDS.event}#` } } }, async (req) =>
    service.ingestEvents(ctxOf(req), req.device!, req.body),
  );

  app.post<{ Body: WatchdogReportRequest }>('/agent/v1/watchdog/report', { schema: { body: { $ref: `${CONTRACT_IDS.watchdog}#` } } }, async (req) =>
    service.watchdogReport(ctxOf(req), req.device!, req.body),
  );

  // 指令附檔:本體為 zip 原始位元組,串流交給 CommandFileService(大小與 SHA-256 在寫檔時檢查);只在這個範圍接受 application/zip
  if (files)
    await app.register(async (scope) => {
      scope.addContentTypeParser('application/zip', (_req, payload, done) => done(null, payload));
      scope.post<{ Params: { commandId: string } }>(
        '/agent/v1/commands/:commandId/files',
        { schema: { params: { type: 'object', required: ['commandId'], properties: { commandId: { type: 'string', format: 'uuid' } } } } },
        async (req, reply) => {
          const length = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
          const sha = req.headers['x-file-sha256'];
          const body = req.body as Readable;
          try {
            const r = await files.upload(ctxOf(req), req.device!, req.params.commandId.toLowerCase(), typeof sha === 'string' ? sha : undefined, length, body);
            return reply.status(201).send(r);
          } catch (err) {
            // 提早拒絕(格式、權限、狀態)時丟棄未讀的本體,不寫入任何地方
            body.resume();
            throw err;
          }
        },
      );
    });

  app.get('/agent/v1/ws', { websocket: true }, (socket, req) => {
    const device = req.device!;
    const ctx = ctxOf(req);
    const conn: AgentConnection = {
      // ws 對 CLOSING / CLOSED 的連線 send 不會丟例外:先檢查,讓呼叫端留在 queued
      send: (text) => {
        if (socket.readyState !== socket.OPEN) throw new Error('WebSocket 不是開啟狀態');
        socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.terminate(),
    };
    const send = (type: string, id: string, body: object) => socket.send(JSON.stringify({ v: 1, type, id, body }));
    const startedAt = Date.now();
    let messages = 0;

    const handle = async (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return ctx.log.warn('收到二進位訊息,忽略(只接受 JSON 文字訊息)');
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return ctx.log.warn('WebSocket 訊息不是合法 JSON,忽略');
      }
      if (!validateEnvelope(msg)) return ctx.log.warn({ errors: validateEnvelope.errors?.slice(0, 3) }, 'WebSocket 訊息不符合信封契約,忽略');
      const m: WsEnvelope = msg;
      const log = ctx.log.child({ msgId: m.id, type: m.type });
      const mctx = { log, requestId: ctx.requestId };
      switch (m.type) {
        case 'hello':
          send('hello_ack', m.id, await service.hello(mctx, device, m.body as unknown as HelloBody));
          // 重連補送 queued 指令(指南 §8.4);在 hello_ack 之後(Agent 才知道時鐘偏差)。不等待,避免擋住心跳
          if (commands) void commands.onHello(mctx, device.id);
          return;
        case 'command_update': {
          if (!commands) return send('unsupported', m.id, { type: m.type });
          const ack = await commands.onUpdate(mctx, device.id, m.body as unknown as CommandUpdateBody);
          // SQL 無法寫入時不回 ack,Agent 留在本機稍後重送
          return ack && send('command_update_ack', m.id, ack);
        }
        case 'unsupported':
          // 舊版 Agent 不認得 command:信封 id = command_id
          return commands?.onUnsupported(mctx, device.id, m.id, String(m.body?.type ?? ''));
        case 'heartbeat':
          return send('heartbeat_ack', m.id, await service.heartbeat(mctx, device, m.body ?? {}));
        default:
          // 不認得的類型回 unsupported(指南 §5.6)
          log.info('不支援的訊息類型');
          return send('unsupported', m.id, { type: m.type });
      }
    };

    // 依序處理(連線登記完成後才處理訊息);監聽器必須同步掛上,否則會漏掉最早的訊息
    let chain = service.connected(ctx, device, conn);
    const run = (fn: () => Promise<unknown>) => {
      chain = chain.then(fn).then(
        () => undefined,
        (err: unknown) => ctx.log.error({ err }, 'WebSocket 訊息處理失敗'),
      );
    };
    ctx.log.info('Agent WebSocket 已連線');
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      messages++;
      run(() => handle(data, isBinary));
    });
    socket.on('error', (err: Error) => ctx.log.warn({ err }, 'WebSocket 錯誤'));
    socket.on('close', (code: number) => {
      ctx.log.info({ code }, 'Agent WebSocket 已關閉');
      run(async () => {
        // 先移出連線表再改回 queued:之間建立的指令不會被推送到正在關閉的連線。
        // 被新連線取代的舊連線不處理(新連線的 hello 會改回 queued 並重送)
        const replaced = service.replaced(device.deviceId, conn);
        await service.disconnected(ctx, device, conn);
        if (!replaced) await commands?.onDisconnected(ctx, device.id);
        app.monitor.push(
          wsSessionLog({
            startedAt,
            endedAt: Date.now(),
            requestId: req.id,
            deviceId: device.deviceId,
            computerName: device.computerName,
            // Nginx 帶來的電腦來源 IP(只供監控顯示,不作為身分依據)
            ip: String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || null,
            code,
            messages,
            online: service.onlineCount,
          }),
        );
      });
    });
  });

  // 心跳逾時檢查(半開的 TCP 不會觸發 close,指南 §5.3)
  let timer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  let fileTimer: NodeJS.Timeout | undefined;
  let alertTimer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => void service.sweep({ log: app.log, requestId: 'sweep' }), opts.sweepIntervalMs ?? 10_000);
    timer.unref();
    // 指令逾期 / 逾時掃描,每分鐘(PLATFORM-PLAN §4.4)
    if (commands) {
      commandTimer = setInterval(() => void commands.sweep({ log: app.log, requestId: 'command-sweep' }), opts.commandSweepIntervalMs ?? 60_000);
      commandTimer.unref();
    }
    // 到期附檔清除,每小時(B5)
    if (files) {
      fileTimer = setInterval(() => void files.sweep({ log: app.log, requestId: 'file-sweep' }), opts.fileSweepIntervalMs ?? 3_600_000);
      fileTimer.unref();
    }
    // 告警評估,每 5 分鐘(P5-MONITOR-DESIGN §4)
    const alerts = opts.alerts;
    if (alerts) {
      alertTimer = setInterval(() => void alerts.sweep({ log: app.log, requestId: 'alert-sweep' }), opts.alertSweepIntervalMs ?? 300_000);
      alertTimer.unref();
    }
  });
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(commandTimer);
    clearInterval(fileTimer);
    clearInterval(alertTimer);
    await service.closeAll();
  });
  return app;
}
