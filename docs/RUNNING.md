# Running YouTube Studio Assistant on your Mac

A step-by-step guide for running the app yourself. Every command is run from the project folder:

```bash
cd ~/Desktop/"Studio Asistance"
```

The app has four parts. All four must be running for everything to work:

| Part | What it does | Port | Started with |
|---|---|---|---|
| PostgreSQL | stores users, channels, videos, analytics, AI results | 5433 | `pnpm db:start` |
| Valkey (Redis) | job queue and rate limits | 6379 | `pnpm redis:start` |
| Web app | the website you open in the browser | 3000 | `pnpm dev` |
| Worker | syncs YouTube videos, stats and analytics in the background | — | `pnpm worker:dev` |

---

## 1. Every day: start the app

Use **two terminal windows** (in VS Code: Terminal → New Terminal, then the **+** button for a second one).

**Terminal 1: database, Redis and the web app**

```bash
pnpm db:start && pnpm redis:start && pnpm dev
```

Wait for `✓ Ready`, then open **http://localhost:3000**.

**Terminal 2: the worker**

```bash
pnpm worker:dev
```

You should see `worker ready`. Leave both terminals open while you use the app.

> If `pnpm db:start` or `pnpm redis:start` says it is **already running**, that's fine; nothing
> needs doing.

## 2. Every day: stop the app

1. Press **Ctrl+C** in both terminals. That stops the web app and the worker.
2. Optionally, stop the database and Redis. They use little memory, so leaving them running is fine.

   ```bash
   pnpm db:stop && pnpm redis:stop
   ```

After you restart your Mac, only the database and Redis are gone. Just repeat step 1.

---

## 3. After pulling new code or changing branches

Run these before starting the app:

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
```

- `pnpm install` installs any new packages.
- `pnpm db:generate` refreshes the Prisma database client.
- `pnpm db:migrate` applies new database changes.

If the web app was already running, **restart it** (Ctrl+C, then `pnpm dev`) and restart the
worker too. A running server keeps the old database client and fails with errors like
`Unknown field ...`.

---

## 4. The `.env` file (settings and keys)

All settings live in `.env` in the project folder. **Never commit it or share it.** After changing
it, restart both the web app and the worker, because they only read it when they start.

| Setting | Status on this Mac | Needed for |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL`, `APP_URL` | ✅ set | everything |
| `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` | ✅ set (generated locally) | sign-in, storing YouTube tokens |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✅ set | Google sign-in, connecting a channel |
| `OPENAI_API_KEY` | ❌ not set | the Studio AI tools (ideas, titles, descriptions, scripts, plans) |

### Add the OpenAI key (to turn on the AI tools)

1. Create a key at **https://platform.openai.com/api-keys**. You'll need billing set up on your
   OpenAI account.
2. Open `.env` and add this line, with no quotes or spaces:

   ```
   OPENAI_API_KEY=sk-...
   ```

3. Save with **Cmd+S** and restart `pnpm dev`.

Spending is capped by `AI_DAILY_SPEND_LIMIT_MICROS`, where 1,000,000 = US$1. The default in
`.env.example` is 50,000,000 (US$50 a day). Add a lower value to `.env` if you want a tighter cap,
for example:

```
AI_DAILY_SPEND_LIMIT_MICROS=2000000
```

That sets the cap to US$2 a day.

### Never change these two

Don't change `AUTH_SECRET` or `TOKEN_ENCRYPTION_KEY` once you have data:

- Changing `AUTH_SECRET` signs everyone out.
- Changing `TOKEN_ENCRYPTION_KEY` makes saved YouTube connections unreadable, and every channel
  must then be connected again.

If you ever set up a fresh copy of the project, generate new values for both with this command:

```bash
openssl rand -base64 32
```

---

## 5. Using the app

1. **Sign in:** open http://localhost:3000 and click **Continue with Google**.
   - Choose **cly541913@gmail.com**.
   - If Google shows *"Google hasn't verified this app"*, click **Continue**. This is normal for
     your own app in testing mode.
2. **Connect your channel:** go to **Channels → Connect a YouTube channel** and allow **read-only** YouTube
   and YouTube Analytics access. Signing in alone does not give the app access to your channel.
3. **Wait for the first sync:** the worker (Terminal 2) fetches your videos, then their statistics,
   then analytics. The first sync can take a few minutes for a large channel. After that it
   refreshes automatically every hour.
4. **Analytics:** YouTube publishes analytics with a delay of about 2–3 days. The most recent days
   are marked as provisional, and missing days are shown as missing, never as zero.
5. **Studio (AI):** needs `OPENAI_API_KEY`, as described in section 4. Each user has a monthly
   allowance per tool. Asking the exact same thing again within 24 hours reuses the earlier result
   for free.
6. **Ideas → Projects → Calendar:**
   - **Ideas:** save ideas from Studio, or write your own. Click **Start project** to turn one into
     a project.
   - **Projects:** a board with one column per stage (Idea, Scripting, Filming, Editing, Scheduled,
     Published). Open a project to set its publish date and move it between stages. Every move is
     kept in its history.
   - **Versions:** titles, descriptions and scripts are kept as numbered versions. Add your own,
     or click **Generate with AI** and then **Add to project** on the result. Choose one version
     with **Use this one**, and compare any two with **Compare with selected**.
   - **Calendar:** shows scheduled projects and your own reminders. The first time, click
     **Use … instead** so dates follow your time zone rather than UTC.

### Letting someone else sign in

While the Google app is in **Testing** mode, only listed test users can sign in (up to 100). To add
someone:

1. Open **Google Cloud Console** and select the project **My Project 35411**.
2. Go to **Google Auth Platform → Audience → Test users → + Add users**.
3. Add their Gmail address and click **Save**.

---

## 6. Checking the code (optional)

The database and Redis must be running (`pnpm db:start && pnpm redis:start`).

| Command | What it does |
|---|---|
| `pnpm verify` | typecheck + lint + all tests, the full check |
| `pnpm test` | tests only (they use a separate `_test` database, so your data is safe) |
| `pnpm db:studio` | browse the database in your browser |
| `pnpm build` | production build check |

---

## 7. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `command not found: pnpm` | Node isn't on your PATH in this terminal | Open a new terminal. If it still fails, run `export PATH="$HOME/.local/node/bin:$PATH"` |
| `Port 3000 is in use` | another `pnpm dev` is already running (maybe in another terminal or VS Code window) | Use the one that's running, or stop it with Ctrl+C in its terminal. To find it, run `lsof -i :3000` |
| "Google sign-in isn't configured on this server yet" | Google keys missing from `.env`, or the app wasn't restarted | Check `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, then restart `pnpm dev` |
| Google: `Error 400: redirect_uri_mismatch` | the address in Google Cloud doesn't match exactly | In Google Cloud → Clients → *Studio Assistant local*, the redirect URIs must be exactly `http://localhost:3000/api/auth/callback/google` and `http://localhost:3000/api/youtube/oauth/callback` |
| Google: "Access blocked" / "has not completed the Google verification process" | the account isn't a test user | Add it under **Audience → Test users** (see section 5) |
| "AI features aren't set up on this server yet." | no `OPENAI_API_KEY` | Add it to `.env` (section 4), then restart `pnpm dev` |
| `Unknown field ...` or other Prisma errors | database client is out of date after new code | `pnpm db:generate && pnpm db:migrate`, then restart `pnpm dev` and the worker |
| `Can't reach database server at 127.0.0.1:5433` | database isn't running | `pnpm db:start` |
| `ECONNREFUSED 127.0.0.1:6379` | Redis isn't running | `pnpm redis:start` |
| Videos or stats never appear | worker isn't running | Start `pnpm worker:dev` in a second terminal |
| Page errors mentioning a missing chunk, or a blank page after `pnpm build` | old build files mixed with dev files | Stop `pnpm dev`, run `rm -rf .next`, start `pnpm dev` again |
| Database won't start | a stale lock after a crash | `pnpm db:status` shows what's wrong. The log is in `.pgdata/server.log` |

**Last resort: wipe the local database.** Only do this if the database is broken. It **deletes all
local data**:

```bash
pnpm db:nuke && pnpm db:start && pnpm db:migrate
```

---

## 8. Where things are

- **Settings and keys:** `.env`. **Test settings:** `.env.test`, which uses fake keys and the
  `_test` database.
- **Database files:** `.pgdata/`. **Database log:** `.pgdata/server.log`.
- **Architecture and API limits:** [`docs/architecture/`](architecture/README.md). Start with
  [§12 Constraints & Limitations](architecture/12-constraints-and-limitations.md).
- **Google Cloud project:** *My Project 35411* at https://console.cloud.google.com. The OAuth
  client is *Studio Assistant local*.
