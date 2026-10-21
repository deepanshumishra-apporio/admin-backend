# admin-risips-api

The backend for the RiSips admin dashboard ([`admin-risips`](https://github.com/deepanshumishra-apporio/admin-risips)).
It serves exactly the `/api/v1/admin/...` contract the dashboard calls (`admin-risips/src/types/admin-api.types.ts`),
so the dashboard runs unchanged: point its `ADMIN_API_URL` here.

- **Investor data comes only from the app backend's read-only Admin API** (`ADMIN_API_BASE_URL`): investors, orders,
  SIPs/STPs/SWPs and holdings. Nothing about investors is stored here except their id. This server never calls FP.
- **Admin-only data lives in PostgreSQL** (`DATABASE_URL`, Neon), in its own schema (`DB_SCHEMA`, default `admin`): staff,
  roles, sessions, login history, the audit log, support tickets, compliance alerts, announcements and review meetings.
  Tables are created on start-up. Queries name the schema themselves, so Neon's pooled endpoint works.
- Every Admin API call carries the signed-in staff member's email as `x-admin-actor`, so the app backend's audit log
  shows who looked at what. Background jobs use `system:valuation` and `system:compliance-scan`.

Node 24.5+ runs the TypeScript directly: no build step. The only runtime dependency is `pg`.

## Running it

```bash
cp .env.example .env          # fill in ADMIN_API_KEY and DATABASE_URL
npm ci
npm start                     # http://127.0.0.1:3005/api/v1/admin
STAFF_EMAIL=you@example.com STAFF_NAME="Your Name" npm run staff:create   # prints a one-time password
npm test                      # uses DATABASE_URL in a throwaway schema, dropped afterwards
npm run typecheck
```

Then in `admin-risips`: `ADMIN_API_URL=http://127.0.0.1:3005` in `.env.local`, `bun run dev`, open http://localhost:3100.

The Admin API only answers the AWS admin server (3.110.2.48) and the Azure VM (74.225.175.227). On a laptop, tunnel
through the VM's proxy and set `HTTPS_PROXY=http://127.0.0.1:18888` (see `.env.example`).

## How the dashboard maps onto the Admin API

| Dashboard | Source |
|---|---|
| Sign-in, MFA, password, staff, roles | Admin database |
| Dashboard, investor list and overview | `GET /investors` + `GET /orders`, all pages, cached 30 s per staff member |
| Investor record | `GET /investors/:id` + `GET /investors/:id/portfolio` |
| Holding / order / plan / payment side panel | the same two calls |
| Transactions, transaction summary | `GET /orders` |
| "Refresh" on a transaction | `GET /orders/:id` (the app backend re-reads FP, not us) |
| Reports + CSV | built from the lists; AUM values each invested investor live |
| Current value on the dashboard and list | a job values every invested investor every 15 min (`system:valuation`) |
| Compliance alerts | a scan every 30 min over the lists; per-investor checks (PAN failed, nominee, bank, overdue tickets) every 6 h or on "Run checks now". A scan that finds nothing new skips the database |
| Tickets, announcements, review meetings | Admin database |

IDs: the dashboard only accepts UUIDs, while the Admin API uses numbers (investors) and FP ids (orders). Each object gets
a UUID derived from its kind and id (`uuidFor`), remembered in `id_map` so it can be mapped back.

## What the Admin API can't do yet (agree the fields with Akash)

| Dashboard feature | What's missing |
|---|---|
| Mandates (investor record, dashboard, `MANDATE_*` alerts) | no mandate data in the Admin API |
| Nudge / remind investor | a write path to notify investors in the app. Answers `501 NOT_AVAILABLE` |
| Risip Bot chats; tickets investors raise in the app | the conversations live in the app backend. The chat queue is empty; staff-logged phone/email tickets work |
| Announcements reaching the app (banner, notification, seen/tap counts) | the app backend must read them from here. Writing and approving works; delivery counts stay 0 |
| Last login / KYC forms / consent / gateway on records | not in the Admin API; shown as empty |
| Sign-ups over time, AUM total | computed by paging every investor; fine now, slow at thousands. A `/summary` field would help |

## Deploying on the AWS admin server

The server's `deploy.sh` builds and runs the dashboard only. Until there is shell access, Akash applies these once:

1. Code at `/opt/admin/api` (this repo), owned by `admin`, then `npm ci --omit=dev`.
2. `/etc/admin/admin-api.env` from `.env.example`, with `DATABASE_URL` and the key from Parameter Store
   `/risips/admin/admin-api-key`. No `HTTPS_PROXY` on the server.
3. `deploy/admin-api.service` → `/etc/systemd/system/`, then `systemctl enable --now admin-api`.
4. In `/etc/admin/admin-web.env`: `ADMIN_API_URL=http://127.0.0.1:3005`, then redeploy/restart `admin-web`.
   Staff logins then never leave the machine unencrypted: browser → Caddy (HTTPS) → dashboard → this API on loopback.
5. The first super admin (Akash), who then creates everyone else from the Staff screen:
   ```bash
   sudo -u admin sh -c 'set -a; . /etc/admin/admin-api.env; cd /opt/admin/api;
     STAFF_EMAIL=akash@... STAFF_NAME="Akash Saxena" node --disable-warning=ExperimentalWarning scripts/create-staff.ts'
   ```
   It prints a one-time password; the first sign-in asks for a new one.

## Keeping Neon's free tier alive

Neon bills compute while anything queries the database, and the compute only sleeps after ~5 idle minutes. A job that
queries every few minutes keeps it awake around the clock, which uses up the free tier's monthly compute hours. So the
background jobs here stay off the database: valuations live in memory, each investor id is saved once, and a compliance
scan that finds what the last one found writes nothing. The database wakes for staff using the dashboard, a scan with
new findings, and the 6-hourly deep scan.

## Running on the Azure VM (74.225.175.227)

Deployed 2026-10-21 as the Docker container `admin-backend` (the VM's own Node is 22; the image has Node 24). It listens
on `127.0.0.1:3005` only, uses host networking, and restarts on its own. Secrets are in `~/admin-backend/.env` (mode 600).

```bash
# update to the latest main
ssh -i ~/.ssh/vps_key azureuser@74.225.175.227
cd ~/admin-backend && git pull && sudo docker build -t admin-backend . \
  && sudo docker rm -f admin-backend && sudo docker run -d --name admin-backend --restart unless-stopped \
     --network host --env-file .env --log-opt max-size=10m --log-opt max-file=3 admin-backend
sudo docker logs -f admin-backend                       # logs
sudo docker exec -e STAFF_EMAIL=... -e STAFF_NAME="..." admin-backend node scripts/create-staff.ts   # a staff login
```

From a laptop: `ssh -i ~/.ssh/vps_key -f -N -L 13005:127.0.0.1:3005 azureuser@74.225.175.227`, then the dashboard's
`ADMIN_API_URL=http://127.0.0.1:13005`.
