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

Since app commit 7d1dace (on `prod`, 2026-11-04) it also sends: `consent` on orders and plans (2FA `{ at, via }`), `mandate` and
`kyc` (fresh KYC) on `/investors/:id`, and `freshness` on `/summary`. The record shows them (mandates, a SIP's mandate,
AutoPay readiness, KYC forms, 2FA on an order or plan) and compliance raises CONSENT_MISSING, MANDATE_*, KYC_FAILED and
MONITORING_STALE from them. Every field is optional: an app backend without them shows what it did before.

| Dashboard feature | What's missing |
|---|---|
| Nudge / remind investor | a write path to notify investors in the app. Answers `501 NOT_AVAILABLE` |
| Risip Bot chats; tickets investors raise in the app | the conversations live in the app backend. The chat queue is empty; staff-logged phone/email tickets work |
| Announcements reaching the app (banner, notification, seen/tap counts) | the app backend must read them from here. Writing and approving works; delivery counts stay 0 |
| Last login / gateway on records | not in the Admin API; shown as empty |
| Redemption payout, KRA re-checks, PEP | FP gives no payout date or UTR; the app checks the KRA only at onboarding and never asks about PEP |
| Sign-ups over time, AUM total | computed by paging every investor; fine now, slow at thousands. A `/summary` field would help |
| HUFs (see below) | no account type, HUF or NSE fields yet. Until they arrive every investor shows as an individual |

### HUFs: the fields this server reads

A HUF is its own investor: the karta adds it from their login, and it is registered on NSE Invest under the HUF PAN
(tax status `03`, client codes `RSPH…`; see the NSE repo's `sip-flow/HUF-FLOW.md`). Every field is optional, so an
Admin API without them still works. Types: `UpInvestor`, `UpHuf`, `UpNse` in [src/upstream.ts](src/upstream.ts).

| Where | Field | Used for |
|---|---|---|
| `GET /investors` and `/investors/:id` | `account_type`: `individual` \| `huf` | HUF badge, list filter (`accountType=HUF`), funnel split, exports |
| same | `karta_id` | Link from the HUF to the karta's record |
| same | `stage` values `huf-pan`, `huf-details`, `huf-bank`, `huf-nse`, `huf-authorise` | Journey stages: KYC, Profile, then Account setup |
| `GET /investors/:id` | `huf`: `formed_on`, `nature_of_business`, `karta { id, name, pan_masked }`, `coparceners [{ name, relationship, dob }]` | The record's "HUF & NSE" tab |
| same | `nse`: `client_code`, `registered_at`, `bank_status`, `bank_remark`, `authorised` | NSE registration on the record; `bank_status` other than `PENDING`/`ACTIVE` raises `PAYOUT_BANK_UNVERIFIED` (high) |
| same | `nse.fatca`: `{ cams, kfin }`, each `{ status: NOT_SENT \| PENDING \| ACCEPTED \| REJECTED, remark }`, from NSE's `FATCA_REPORT` | `FATCA_REJECTED` alert (e.g. KFin's "MISSING/INVALID UBO_EXCH" for a HUF sent without the karta as UBO) |

HUFs are never flagged `NOMINEE_MISSING` (a HUF can't nominate), and every HUF is read by the 6-hourly deep check
because its NSE registration can fail before onboarding finishes. Send `authorised: null` when NSE's
`CLIENT_AUTHORIZATION` report is empty: it is empty for HUFs even once they are active.

## Onboarding HUFs on NSE (the one thing this server writes outside itself)

Staff onboard a Hindu Undivided Family on NSE Invest from **Onboarding → HUFs** in the dashboard. It is the only place
this server writes to another system, so it is fenced: UAT by default, the live account only with `NSE_ALLOW_PROD=true`,
a second person approves, and the karta consents on their own device first.

```
Draft ─▶ consent link ─▶ karta agrees ─▶ colleague approves ─▶ duplicate check ─▶ UCC ─▶ FATCA ─▶ waiting on karta ─▶ active
 (staff)   (staff sends it)   (public page,      (not the preparer)     (client_master    (CLIENT   (FATCA_COMMON,  (NSE bank check,
                              their IP + time)                           by PAN)          COMMON)   karta as UBO)   CL_ACT link + OTP)
```

- **Code**: [src/routes/hufs.ts](src/routes/hufs.ts) (the steps and states), [src/nse/huf.ts](src/nse/huf.ts) (rules and
  request bodies), [src/nse/client.ts](src/nse/client.ts) (NSE's authentication: TLS 1.3, browser-like headers, never
  through `HTTPS_PROXY`). Ported from the NSE `sip-flow` project, whose `HUF-FLOW.md` explains every value.
- **Data**: table `hufs`. The full details (PANs, bank account, dates of birth, address) are sealed with AES-256-GCM
  under `ADMIN_DATA_KEY`; only the HUF name, karta name, client code and a masked PAN are in the clear.
- **Consent**: `POST /hufs/:id/consent-link` returns a one-time token (only its hash is kept, valid 7 days). The
  karta opens `/huf-consent/<token>` on the dashboard, sees the details masked, and agrees. Their IP and time are
  recorded and sent to NSE in FATCA's `log_name`. Editing the HUF afterwards clears the consent. In production a
  loopback or private IP is refused, so a missing `TRUST_PROXY` can never put our own address on record.
- **Retries**: approving again after a failure re-runs only the NSE steps that did not finish; the UCC is never
  re-sent. Once the UCC is in, the details are locked (a change would need a UCC modification, not built yet).
- **Documents**: once registered, staff upload the karta's signed AOF (`fileupload/AOFIMG`, needed before a non-demat
  order: a HUF can't have an eLog), the signed FATCA form (`FATCAIMG`) and, if the bank check fails, a cancelled
  cheque (`CANCELCHEQUE`). PDF/JPG/PNG/TIFF up to 3 MB, checked by file signature, sent straight to NSE; only the
  name, size and SHA-256 are kept. CAMS/KFin's AOF verdict comes from `AOF_IMAGE_UPLOAD_REPORT`.
- **Status job**: every 30 min (`HUF_STATUS_INTERVAL_MS`) HUFs still waiting on NSE are re-read; none waiting, no calls.
- **Sync from NSE**: HUFs registered on NSE directly (RSPH000001/2 were made on NSE's portal) are found in
  `client_master_report` (7-day windows, from `HUF_SYNC_FROM`, default 2026-10-01; tax status HUF) and added with
  `source = 'NSE'`, details from the client master and FATCA_REPORT. Once a day (last 14 days), and on "Sync from NSE".
- **Active**: NSE's authorisation report is empty for HUFs, so staff mark a HUF active once an order is accepted.
- **Investments** ([src/nse/invest.ts](src/nse/invest.ts), [src/routes/huf-invest.ts](src/routes/huf-invest.ts)): orders
  (`ORDER_STATUS`, 7-day windows), allotments and redemptions (30-day windows), SIPs (`XSIP_REG_REPORT`) and mandates
  (`MANDATE_STATUS`) are read from NSE and kept in `hufs.investments`, again once a day on their own. NSE has no holdings
  API: holdings are allotted units less redeemed ones, valued at the latest NAV. The scheme, NAV and SIP masters
  (`MASTER_DOWNLOAD`, a few MB each) are loaded once a day.
- **Fund catalogue and charts** ([src/amfi.ts](src/amfi.ts)): `GET /hufs/funds` lists every scheme open for purchase
  on NSE with its SEBI category and fund house from AMFI's daily `NAVAll.txt` (matched by ISIN, loaded once a day).
  `GET /hufs/schemes/:code/history` gives the NAV history for the fund's chart and its returns, from mfapi.in (a free
  mirror of AMFI's NAVs; AMFI has no history API), cached six hours. Only public fund codes are sent to either.
- **Investing from the admin**: a lumpsum purchase (`transaction/NORMAL`, physical, then the `PUR` payment link), an
  eNACH mandate on the HUF's account (`registration/product/MANDATE`, `MANDATE_AUTH` link) and a monthly SIP on an
  approved mandate (`registration/product/XSIP`, `XSIP_REG` link). Checked first against the scheme and SIP masters,
  and refused until NSE's bank check has passed and the AOF is on NSE. NSE asks the karta to confirm every one, so
  staff can start but never complete an investment. Orders carry `NSE_EUIN` (`NSE_SUB_BROKER_ARN` if set).
- **No eLog**: NSE's ELOG API is for individuals only.
- **Compliance**: every scan also checks the HUFs here (`hufDetections` in [src/routes/compliance.ts](src/routes/compliance.ts)) from what NSE last reported: FATCA or the AOF rejected by a registrar, no AOF sent, the bank check failed, and eNACH mandates rejected or unapproved for 3 days. Kinds no check can raise yet (`NotChecked`) are listed on the Compliance page with the app data each needs.
- **Tested**: `test/hufs.test.ts` against a fake NSE; and end to end on NSE UAT on 2 Nov 2026 through the dashboard
  (UCC and FATCA with the karta as UBO accepted, client `HUFT582104`). Not yet proven: KFin accepting that FATCA
  (UAT never forwards it), and the `ubo_code` (`NSE_HUF_UBO_CODE`, default `C01`).

To switch it on for a server: set `ADMIN_DATA_KEY` and the `NSE_*` values (see `.env.example`), ask NSE to whitelist
the server's IP for UAT, and give **HUF onboarding on NSE** to the roles that need it (Operations has it by default on
a new database; on an existing one add it in Staff → Roles). For the consent page, set the same random value as
`DASHBOARD_PROXY_KEY` here and `ADMIN_API_PROXY_KEY` on the dashboard (Vercel): Caddy replaces `X-Forwarded-For` with
the dashboard server's address, so the dashboard also sends the visitor's IP in `X-RiSips-Client-IP` with that key.
Without it, a production consent is refused rather than recorded with the wrong IP.

## Fund returns by AMC (a report)

[src/fund-returns.ts](src/fund-returns.ts), [src/routes/fund-returns-report.ts](src/routes/fund-returns-report.ts). Every mutual fund's
1M, 3M, 6M, 1Y, 3Y, 5Y and 10Y return, from AMFI: the current NAVs (`NAVAll.txt`) and, for each period, one week of
every fund's NAVs ending on its anniversary (`DownloadNAVHistoryReport_Po.aspx`, a few MB each). Worked out about 20 s
after start and once a day after that; yesterday's figures are served while today's are made. Up to a year the change
in NAV, beyond that compounded a year; an AMC's figure is the simple average of its funds' returns. `GET
/reports/fund-returns` (multi-select filters as `fundHouse=A|B`, `group=amc|fund`, `sort`, `dir`) and
`/reports/fund-returns/export?format=xlsx|pdf`, both `reports.read`; downloads are audited. The Excel and PDF files are
written by [src/export-files.ts](src/export-files.ts) (no libraries).

## Notifications (the bell and the Inbox)

[src/notifications.ts](src/notifications.ts). Each notification has a key naming its event, so a re-scan or a re-read of
NSE never sends it twice. It goes to everyone holding its permission, or to one person; reads are per person.

| Notification | Raised by | Who sees it |
|---|---|---|
| NSE refused a HUF's registration, order, SIP or mandate; the karta gave consent; a HUF active or synced from NSE | HUF events | `hufs.manage` |
| CAMS or KFin rejected a HUF's FATCA | the HUF status job, when it changes | `hufs.manage` |
| Units allotted, a SIP live, a mandate approved or rejected | the daily investments read, compared with the last one | `hufs.manage` |
| A HUF waiting on the karta for 3+ days | every 10 min | `hufs.manage` |
| A new high or medium compliance alert (low ones stay in Compliance) | the compliance scan | `compliance.manage` |
| A ticket assigned to you; yours due within 2 h | ticket changes; every 10 min | that person |
| Yesterday's sign-ups; investors ready for a week with no order | once a day after 9 AM IST | `investors.read` |

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
