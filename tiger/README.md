# Tiger Cloud setup

1. Create a Tiger Cloud PostgreSQL service.
2. Apply `tiger/schema.sql` in the Tiger SQL console.
3. Add the connection string to local `.env.local` and Vercel:

```env
TIGER_DATABASE_URL=postgresql://...
# Optional when Tiger requires a non-default SSL setting:
TIGER_DATABASE_SSL=true
```

The application uses Tiger through server-only Vercel Functions:

- `GET/POST /api/leaderboard` — canonical leaderboard
- `POST /api/telemetry` — coaching and match event ingestion

Do not expose `TIGER_DATABASE_URL` with a `VITE_` prefix or call Tiger directly from the browser.
