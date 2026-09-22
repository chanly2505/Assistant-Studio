import { aiRoute } from '../_factory';
import { generatePlan } from '@/modules/ai/generate';
import { PlanRequest } from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// Generation can take a while on the strong model; do not let a platform
// default cut it short.
export const maxDuration = 120;

export const POST = aiRoute({
  slug: 'plan',
  body: PlanRequest,
  run: (userId, body, log) => generatePlan({ userId, log }, body),
});
