/** 輸出管理 API 的 OpenAPI(不啟動服務、不連資料庫與 Gateway):npm run -s openapi > openapi.json */
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import { buildMgmtApp } from './mgmt-app.js';
import type { CommandDispatcher } from './services/command-dispatcher.js';
import type { CommandFileService } from './services/command-files.js';
import type { DeviceService } from './services/device-service.js';

const gateway = loadGatewayEnv({ SERVICE_CODE: 'endpoint-api', GW_ENV: 'dev', GW_JWKS_URL: 'http://127.0.0.1/.well-known/jwks.json' });
const app = await buildMgmtApp({
  config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: false, scopeAllRoles: [] },
  service: {} as DeviceService,
  // 與 server.ts 相同的路由(含指令與附檔下載),輸出內容才和自動註冊一致
  commands: {} as CommandDispatcher,
  files: {} as CommandFileService,
});
await app.ready();
console.log(JSON.stringify(app.swagger(), null, 2));
await app.close();
