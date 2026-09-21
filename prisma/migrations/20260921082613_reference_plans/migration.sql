-- Reference data: subscription plans.
--
-- `User.planKey` defaults to 'free' and is a foreign key to "Plan". Auth.js
-- creates users on first sign-in, so the 'free' row must exist in EVERY
-- environment, not only where `pnpm db:seed` happened to run. Without it the
-- first real sign-in fails on a constraint violation.
--
-- ON CONFLICT DO NOTHING: limits may later be tuned in production; re-running
-- this migration must never overwrite them.

INSERT INTO "Plan" ("key", "name", "maxChannels", "monthlyGenerations", "features", "isActive")
VALUES
  ('free',    'Free',    1,  '{"IDEAS":20,"TITLES":20,"DESCRIPTION":10,"SCRIPT":2,"PLAN":2}',               '{"analyticsHistoryDays":90}',                      true),
  ('creator', 'Creator', 3,  '{"IDEAS":300,"TITLES":300,"DESCRIPTION":150,"SCRIPT":30,"PLAN":30}',          '{"analyticsHistoryDays":365}',                     true),
  ('studio',  'Studio',  10, '{"IDEAS":2000,"TITLES":2000,"DESCRIPTION":1000,"SCRIPT":200,"PLAN":200}',     '{"analyticsHistoryDays":365,"prioritySync":true}', true)
ON CONFLICT ("key") DO NOTHING;
