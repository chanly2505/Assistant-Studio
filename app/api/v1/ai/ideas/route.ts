import { aiRoute } from '../_factory';
import { generateIdeas } from '@/modules/ai/generate';
import { IdeasRequest } from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// Generation can take a while on the strong model; do not let a platform
// default cut it short.
export const maxDuration = 120;

export const POST = aiRoute({
  slug: 'ideas',
  body: IdeasRequest,
  run: (userId, body, log) => generateIdeas({ userId, log }, body),
});
