// The admin API the admin-risips dashboard calls: http://HOST:PORT/api/v1/admin/...
import { createServer } from 'node:http';

import { seedRoles } from './auth.ts';
import { config } from './config.ts';
import { closeDb, migrate } from './db.ts';
import { handle, Router } from './http.ts';
import { announcementRoutes } from './routes/announcements.ts';
import { complianceRoutes, startComplianceLoop } from './routes/compliance.ts';
import { investorRoutes } from './routes/investors.ts';
import { meetingRoutes } from './routes/meetings.ts';
import { reportRoutes } from './routes/reports.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { staffRoutes } from './routes/staff.ts';
import { supportRoutes } from './routes/support.ts';
import { transactionRoutes } from './routes/transactions.ts';
import { flushIds } from './security.ts';
import { startValuationLoop } from './valuation.ts';

// Fail fast on missing settings rather than on the first request.
void config.upstreamUrl;
void config.upstreamKey;
await migrate();
await seedRoles();

const router = new Router();
sessionRoutes(router);
staffRoutes(router);
investorRoutes(router);
transactionRoutes(router);
reportRoutes(router);
complianceRoutes(router);
supportRoutes(router);
announcementRoutes(router);
meetingRoutes(router);

const server = createServer((req, res) => void handle(router, '/api/v1/admin', req, res));
server.listen(config.port, config.host, () => {
  console.log(`[admin-api] listening on http://${config.host}:${config.port}/api/v1/admin (Admin API: ${config.upstreamUrl}, schema: ${config.dbSchema})`);
  if (!config.mfaEnabled) console.log('[admin-api] staff MFA is off (STAFF_MFA_ENABLED=false)');
});

startValuationLoop();
startComplianceLoop();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void flushIds().finally(() => closeDb().finally(() => process.exit(0)));
  });
}
