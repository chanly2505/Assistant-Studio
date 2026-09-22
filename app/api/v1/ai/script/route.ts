import { aiRoute } from '../_factory';
import { generateScript } from '@/modules/ai/generate';
import { ScriptRequest } from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// Generation can take a while on the strong model; do not let a platform
// default cut it short.
export const maxDuration = 120;

export const POST = aiRoute({
  slug: 'script',
  body: ScriptRequest,
  perMinute: 3,
  run: (userId, body, log) => generateScript({ userId, log }, body),
});
