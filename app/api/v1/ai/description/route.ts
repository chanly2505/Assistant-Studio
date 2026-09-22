import { aiRoute } from '../_factory';
import { generateDescription } from '@/modules/ai/generate';
import { DescriptionRequest } from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// Generation can take a while on the strong model; do not let a platform
// default cut it short.
export const maxDuration = 120;

export const POST = aiRoute({
  slug: 'description',
  body: DescriptionRequest,
  perMinute: 10,
  run: (userId, body, log) => generateDescription({ userId, log }, body),
});
