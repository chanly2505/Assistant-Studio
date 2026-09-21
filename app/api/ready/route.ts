import { withApi } from '@/lib/api/with-api';
import { checkHealth } from '@/modules/health/check-health';

export const dynamic = 'force-dynamic';

/**
 * Readiness. Proves the dependencies answer, so a deploy is not promoted and
 * traffic is not routed to an instance that cannot serve.
 */
export const GET = withApi({ auth: 'none' }, async () => checkHealth());
