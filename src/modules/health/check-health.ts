import { checkDatabase } from '@/db/prisma';
import { AppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
  };
}

/**
 * Readiness: proves the dependencies actually answer, rather than reporting
 * that the process started. Liveness (`/api/health`) is deliberately separate
 * and does not touch the database — otherwise a slow database causes the
 * orchestrator to kill healthy instances.
 */
export async function checkHealth(): Promise<Result<HealthReport>> {
  const checks: HealthReport['checks'] = { database: { ok: false } };

  try {
    const database = await checkDatabase();
    checks.database = { ok: true, latencyMs: database.latencyMs };
  } catch (cause) {
    checks.database = {
      ok: false,
      // Safe to expose: a fixed string, not the driver's message (which can
      // contain the connection string).
      error: 'unreachable',
    };

    return err(
      new AppError('UPSTREAM_UNAVAILABLE', {
        detail: 'database readiness check failed',
        cause,
        messageKey: 'errors.serviceUnavailable',
      }),
    );
  }

  return ok({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  });
}
