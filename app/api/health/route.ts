import { ok } from '@/domain/errors/result';
import { withApi } from '@/lib/api/with-api';

export const dynamic = 'force-dynamic';

/**
 * Liveness. Answers "is this process running", nothing more.
 *
 * It must not touch the database: if it did, a slow database would make the
 * orchestrator kill otherwise-healthy instances and turn a degradation into an
 * outage. Dependency checks belong on /api/ready.
 */
export const GET = withApi({ auth: 'none' }, async () =>
  ok({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }),
);
