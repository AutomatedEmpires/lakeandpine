# Lake & Pine Cleaning Co.

Premium cleaning operations platform for Private Estate Care, Construction Handoff,
Lake & Marine Interior Care, and Select Commercial Care in the Coeur d'Alene–Spokane
corridor.

The Next.js app in `apps/web` includes:

- a premium public market site and property consultation request;
- privacy-controlled analytics and fail-closed public intake;
- customer service support for reschedules, cancellations, complaints, recleans,
  damage, and refund review;
- cleaner recruiting and a private crew workspace;
- a private operations command center for territories, qualification, capacity-aware
  crew suggestions, scheduling, recovery actions, refunds, and notification retries;
- PostgreSQL-enforced RLS, idempotency, lifecycle audit trails, assignment conflicts,
  time off, travel buffers, skill coverage, and qualification gates.

Requests are not instant bookings. Prices are custom proposals, preferred dates remain
preferences until confirmed, and the refund ledger never moves money.

## Run locally

```bash
docker run --rm -d --name lp-postgres \
  -e POSTGRES_PASSWORD=lakeandpine_dev -e POSTGRES_DB=lakeandpine_proof \
  -p 5442:5432 postgres:17-alpine
export MIGRATION_DATABASE_URL=postgresql://postgres:lakeandpine_dev@127.0.0.1:5442/lakeandpine_proof
export DATABASE_URL=$MIGRATION_DATABASE_URL
pnpm install --frozen-lockfile
pnpm quality:verify-migrations
pnpm dev
```

Copy `.env.example` to `apps/web/.env.local` and use a local/disposable database.
The verifier requires the fresh, local database above, applies every migration, and
proves the restricted application role cannot bypass RLS. Stop and recreate the
`--rm` container before rerunning the migration proof.

Useful checks:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --prod
```

For a disposable end-to-end write proof, start the app and run:

```bash
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' pnpm dev
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' \
  RUNTIME_SMOKE_BASE_URL=http://127.0.0.1:3010 pnpm ops:smoke-runtime
```

The smoke test visits the premium public surfaces, creates one synthetic construction
request, proves idempotency/event/checklist/outbox persistence, suppresses email, and
removes its rows in `finally`.

## Safe operating gates

Keep these false until the named dependencies are verified:

```text
REQUEST_INTAKE_ENABLED=false
CLEANER_APPLICATIONS_ENABLED=false
PAYMENTS_ENABLED=false
```

Real request intake additionally requires request/reference secrets, a verified Resend
sender and reply-to inbox, a monitored operations email, and Sentry. Public phone and
email CTAs stay hidden until verified values are supplied. Clerk protects customer,
operator, and crew workspaces when configured.

The production canonical is `https://lakeandpinecleaning.com`; DNS ownership and the
business phone/email are external launch dependencies.

## Architecture references

- `docs/product/premium-market-operating-model.md`
- `docs/product/premium-operations-domain.md`
- `docs/ops/database-migration-verification.md`
- `AGENTS.md`

Historical recovered prototype files remain under `prototypes/recovered/` for provenance;
they are not the active product contract.
