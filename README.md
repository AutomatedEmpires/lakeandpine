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
docker run -d --name lp-postgres --restart unless-stopped \
  -e POSTGRES_PASSWORD=lakeandpine_dev -e POSTGRES_DB=lakeandpine \
  -p 5442:5432 -v lp-pgdata:/var/lib/postgresql/data postgres:17-alpine
npm install
npm --prefix apps/web run quality:verify-migrations
npm --prefix apps/web run dev
```

Copy `.env.example` to `apps/web/.env.local` and use a local/disposable database.
The migration verifier creates its own PostgreSQL 17 database, applies every migration,
and proves the restricted application role cannot bypass RLS.

Useful checks:

```bash
npm --prefix apps/web test
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web audit --omit=dev
```

For a disposable end-to-end write proof, start the app and run:

```bash
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' npm --prefix apps/web run dev
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' \
  RUNTIME_SMOKE_BASE_URL=http://127.0.0.1:3010 npm --prefix apps/web run ops:smoke-runtime
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
- `docs/ops/migration-verification.md`
- `AGENTS.md`

Historical recovered prototype files remain under `prototypes/recovered/` for provenance;
they are not the active product contract.
