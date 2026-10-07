/**
 * Agent 通道 :51241(endpoint-agent;ENDPOINT-AGENT-GUIDE §5):Gateway :9443(mTLS)把所有路徑轉送到這裡。
 *   - 只認 Nginx 帶來的 x-client-cert-* 標頭,要求 x-client-verify=SUCCESS,以完整 DN 為裝置鍵(§3.3、§5.2);未通過一律 401
 *   - 標頭只採信來自 AGENT_TRUSTED_PROXIES(Nginx)的連線;dev 以 DEV_TRUST_CLIENT_HEADERS 讓本機 Agent 直連
 *   - POST /agent/v1/inventory(資料契約 inventory.schema.json)、WS GET /agent/v1/ws(信封 ws-envelope.schema.json)
 *   - 與 :51240 是不同的 Fastify 實例,不共用 hook(§5.2);日誌帶 x-request-id、DN、指紋(§5.7)
 *   - 監控(giga-observe 服務 endpoint-agent,與管理 API 分開的 Key):HTTPS 回報逐筆;WebSocket 每條連線關閉時記一筆
 *     (method WS、持續時間、關閉碼、訊息數;非正常關閉為 warn);心跳附上在線連線數。Agent 的 heartbeat 訊息不逐筆記錄(量大)
 */
import { BlockList } from 'node:net';
import websocket from '@fastify/websocket';
import { errorBody, type DepStatus, type MonitorEnv, type MonitorLog } from '@giganexus/backend-sdk';
import { setupGateway } from '@giganexus/backend-sdk/fastify';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { CONTRACT_IDS, compileWsEnvelope, contractsDir, loadContract, type HelloBody, type InventoryRequest, type WsEnvelope } from './contracts.js';
import { AppError } from './errors.js';
import type { AgentConnection, Ctx, DeviceService } from './services/device-service.js';
import type { DeviceRecord } from './stores/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceRecord | null;
  }
  interface FastifyContextConfig {
    /** false:不驗證裝置身分(健康檢查) */
    deviceAuth?: boolean;
  }
}

export interface AgentAppOptions {
  config: Pick<Config, 'logLevel' | 'agentTls' | 'trustedProxies'>;
  service: DeviceService;
  contractsDir?: string;
  /** 心跳逾時檢查間隔(毫秒) */
  sweepIntervalMs?: number;
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
  const { config, service } = opts;
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

  app.get('/agent/v1/ws', { websocket: true }, (socket, req) => {
    const device = req.device!;
    const ctx = ctxOf(req);
    const conn: AgentConnection = { close: (code, reason) => socket.close(code, reason), terminate: () => socket.terminate() };
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
          return send('hello_ack', m.id, await service.hello(mctx, device, m.body as unknown as HelloBody));
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
        await service.disconnected(ctx, device, conn);
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
  app.addHook('onReady', async () => {
    timer = setInterval(() => void service.sweep({ log: app.log, requestId: 'sweep' }), opts.sweepIntervalMs ?? 10_000);
    timer.unref();
  });
  app.addHook('preClose', async () => {
    clearInterval(timer);
    service.closeAll();
  });
  return app;
}
