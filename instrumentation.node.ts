/**
 * Node-runtime boot checks. Loaded only from `instrumentation.ts`.
 *
 * On invalid configuration the process EXITS. Next.js otherwise logs "Failed to
 * prepare server" and keeps listening, answering every request with a 500 —
 * a half-alive process that looks deployed. Exiting lets the orchestrator see
 * a failed start and keep the previous release serving.
 */
export async function validateConfiguration(): Promise<void> {
  try {
    const { env } = await import('./src/lib/env');
    const { logger } = await import('./src/lib/logger');

    logger.info(
      { nodeEnv: env.NODE_ENV, aiProvider: env.AI_PROVIDER, logLevel: env.LOG_LEVEL },
      'configuration validated',
    );
  } catch (error) {
    // The logger may be the thing that failed to initialise, so use stderr.
    console.error(
      `\n✗ Refusing to start.\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
