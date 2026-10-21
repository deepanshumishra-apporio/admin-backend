// Reports: a preview of the first rows on screen, and the full set as CSV (audited).
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { all } from '../db.ts';
import { Csv, HttpError, toCsv, type Ctx, type Router } from '../http.ts';
import { snapshot } from '../investors.ts';
import {
  humanise,
  iso,
  isOrder,
  isPlan,
  istDate,
  JourneyStages,
  KycStatuses,
  KycStatusLabels,
  money,
  money0,
  ms,
  paymentGroups,
  PlanKinds,
  StageLabels,
  toPayment,
  unitsOf,
} from '../map.ts';
import { mapLimit, portfolio } from '../upstream.ts';

type Kind = 'text' | 'money' | 'units' | 'count' | 'date' | 'datetime';
type Column = { key: string; label: string; kind: Kind };
type Cell = string | number | null;
type Filters = { from?: string; to?: string; status?: string };

type Report = {
  key: string;
  name: string;
  description: string;
  dateField: string | null;
  statusLabel: string | null;
  statuses: { value: string; label: string }[];
  columns: Column[];
  /** Rows with `_date` (yyyy-mm-dd, IST) and `_status` for filtering. */
  rows: (ctx: Ctx) => Promise<(Record<string, Cell> & { _date?: string | null; _status?: string | null })[]>;
};

const c = (key: string, label: string, kind: Kind = 'text'): Column => ({ key, label, kind });
const day = (value: unknown) => (iso(value) ? istDate(ms(value)) : null);

const OrderStates = ['under_review', 'pending', 'confirmed', 'submitted', 'successful', 'failed', 'cancelled', 'reversed'];
const PlanStates = ['active', 'awaiting_payment', 'review_completed', 'cancelled', 'completed', 'failed'];

const Reports: Report[] = [
  {
    key: 'investors',
    name: 'Investors',
    description: 'Everyone who signed up, where they are in onboarding, and what they have invested.',
    dateField: 'Signed up',
    statusLabel: 'Stage',
    statuses: JourneyStages.map((s) => ({ value: s, label: StageLabels[s] })),
    columns: [
      c('name', 'Name'), c('email', 'Email'), c('phone', 'Mobile'), c('pan', 'PAN (masked)'), c('stage', 'Stage'),
      c('kycStatus', 'KYC'), c('signedUpAt', 'Signed up', 'datetime'), c('onboardedAt', 'Onboarded', 'datetime'),
      c('investedAmount', 'Invested', 'money'), c('currentValue', 'Current value', 'money'), c('activeSips', 'Active SIPs', 'count'),
    ],
    rows: async (ctx) => (await snapshot(ctx)).facts.map((f) => ({
      name: f.up.name, email: f.up.email, phone: f.up.mobile, pan: f.up.pan_masked, stage: StageLabels[f.stage],
      kycStatus: KycStatusLabels[f.kycStatus], signedUpAt: iso(f.up.signed_up_at), onboardedAt: iso(f.up.onboarded_at),
      investedAmount: money0(f.investedAmount), currentValue: money0(f.currentValue), activeSips: f.activeSips,
      _date: day(f.up.signed_up_at), _status: f.stage,
    })),
  },
  {
    key: 'kyc',
    name: 'KYC',
    description: 'KYC status of every investor. Compliant PANs are verified at the KRA during sign-up.',
    dateField: 'Signed up',
    statusLabel: 'KYC status',
    statuses: KycStatuses.map((s) => ({ value: s, label: KycStatusLabels[s] })),
    columns: [c('name', 'Name'), c('pan', 'PAN (masked)'), c('kycStatus', 'KYC'), c('via', 'Completed via'), c('stage', 'Stage'), c('signedUpAt', 'Signed up', 'datetime')],
    rows: async (ctx) => (await snapshot(ctx)).facts.map((f) => ({
      name: f.up.name, pan: f.up.pan_masked, kycStatus: KycStatusLabels[f.kycStatus], via: f.kycCompletedVia === 'KRA' ? 'KRA (already compliant)' : null,
      stage: StageLabels[f.stage], signedUpAt: iso(f.up.signed_up_at), _date: day(f.up.signed_up_at), _status: f.kycStatus,
    })),
  },
  {
    key: 'transactions',
    name: 'Transactions',
    description: 'Every one-time purchase, redemption and switch.',
    dateField: 'Placed',
    statusLabel: 'State',
    statuses: OrderStates.map((s) => ({ value: s, label: humanise(s) })),
    columns: [
      c('ref', 'Reference'), c('investor', 'Investor'), c('pan', 'PAN (masked)'), c('type', 'Type'), c('scheme', 'Scheme'), c('toScheme', 'To scheme'),
      c('amount', 'Amount', 'money'), c('units', 'Units', 'units'), c('nav', 'NAV', 'money'), c('state', 'State'), c('folio', 'Folio'),
      c('placedAt', 'Placed', 'datetime'), c('completedAt', 'Allotted', 'datetime'), c('failure', 'Failure'),
    ],
    rows: async (ctx) => {
      const snap = await snapshot(ctx);
      return snap.orders.filter(isOrder).map((o) => {
        const f = snap.byExtId.get(String(o.user_id));
        return {
          ref: o.ref ?? o.id, investor: f?.up.name ?? null, pan: f?.up.pan_masked ?? null, type: humanise(o.kind), scheme: o.fund?.name ?? o.isin,
          toScheme: o.fund_to?.name ?? null, amount: money(o.amount), units: unitsOf(o.units), nav: o.nav == null ? null : Number(o.nav).toFixed(4),
          state: humanise(o.state), folio: o.folio ?? null, placedAt: iso(o.created_at), completedAt: o.state === 'successful' ? iso(o.succeeded_at) : null,
          failure: o.failure_code ?? null, _date: day(o.created_at), _status: o.state,
        };
      });
    },
  },
  {
    key: 'plans',
    name: 'SIPs, STPs and SWPs',
    description: 'Every systematic plan and where it stands.',
    dateField: 'Registered',
    statusLabel: 'State',
    statuses: PlanStates.map((s) => ({ value: s, label: humanise(s) })),
    columns: [
      c('investor', 'Investor'), c('kind', 'Plan'), c('scheme', 'Scheme'), c('toScheme', 'To scheme'), c('amount', 'Amount', 'money'),
      c('frequency', 'Frequency'), c('day', 'Day', 'count'), c('state', 'State'), c('next', 'Next instalment', 'date'), c('createdAt', 'Registered', 'datetime'),
    ],
    rows: async (ctx) => {
      const snap = await snapshot(ctx);
      return snap.orders.filter(isPlan).map((p) => ({
        investor: snap.byExtId.get(String(p.user_id))?.up.name ?? null, kind: PlanKinds[p.kind as keyof typeof PlanKinds], scheme: p.fund?.name ?? p.isin,
        toScheme: p.fund_to?.name ?? null, amount: money(p.amount), frequency: p.frequency ?? 'monthly', day: p.installment_day ?? null,
        state: humanise(p.state), next: iso(p.next_debit ?? p.next_installment_date), createdAt: iso(p.created_at), _date: day(p.created_at), _status: p.state,
      }));
    },
  },
  {
    key: 'payments',
    name: 'Payments',
    description: 'Checkout payments for one-time purchases. One payment can cover several orders.',
    dateField: 'Started',
    statusLabel: 'Status',
    statuses: ['SUCCESS', 'FAILED', 'PENDING'].map((s) => ({ value: s, label: humanise(s) })),
    columns: [
      c('investor', 'Investor'), c('reference', 'Gateway reference'), c('amount', 'Amount', 'money'), c('status', 'Status'), c('orders', 'Orders', 'count'),
      c('createdAt', 'Started', 'datetime'), c('settledAt', 'Settled', 'datetime'),
    ],
    rows: async (ctx) => {
      const snap = await snapshot(ctx);
      return paymentGroups(snap.orders).map((g) => {
        const p = toPayment(g);
        return {
          investor: snap.byExtId.get(String(g.orders[0]!.user_id))?.up.name ?? null, reference: g.up.reference ?? null, amount: p.amount,
          status: humanise(p.status), orders: g.orders.length, createdAt: p.createdAt, settledAt: p.settledAt, _date: day(p.createdAt),
          _status: p.status === 'SUCCESS' || p.status === 'FAILED' ? p.status : 'PENDING',
        };
      });
    },
  },
  {
    key: 'aum',
    name: 'Assets under management',
    description: 'What each invested investor holds today, valued live from FP. Slower than the other reports.',
    dateField: null,
    statusLabel: null,
    statuses: [],
    columns: [
      c('investor', 'Investor'), c('pan', 'PAN (masked)'), c('scheme', 'Scheme'), c('folio', 'Folio'), c('units', 'Units', 'units'),
      c('nav', 'NAV', 'money'), c('navDate', 'NAV date', 'date'), c('invested', 'Invested', 'money'), c('current', 'Current value', 'money'), c('gain', 'Gain', 'money'),
    ],
    rows: async (ctx) => {
      const snap = await snapshot(ctx);
      const invested = snap.facts.filter((f) => f.invested);
      const ports = await mapLimit(invested, 3, (f) => portfolio(f.up.id, actorOf(ctx)).catch(() => null));
      return invested.flatMap((f, i) => (ports[i]?.holdings ?? []).map((h) => ({
        investor: f.up.name, pan: f.up.pan_masked, scheme: h.fund?.name ?? h.isin, folio: h.folio, units: unitsOf(h.units),
        nav: h.nav == null ? null : Number(h.nav).toFixed(4), navDate: h.nav_date, invested: money(h.invested), current: money(h.current), gain: money(h.gain),
      })));
    },
  },
  {
    key: 'compliance',
    name: 'Compliance alerts',
    description: 'Every alert the checks raised, with what was done about it.',
    dateField: 'First detected',
    statusLabel: 'Status',
    statuses: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'].map((s) => ({ value: s, label: humanise(s) })),
    columns: [
      c('kind', 'Alert'), c('severity', 'Severity'), c('status', 'Status'), c('title', 'Title'), c('investor', 'Investor'),
      c('firstDetectedAt', 'First detected', 'datetime'), c('resolvedAt', 'Closed', 'datetime'), c('resolution', 'Resolution'),
    ],
    rows: async (ctx) => {
      const snap = await snapshot(ctx);
      return (await all<Record<string, string | null>>('SELECT * FROM alerts ORDER BY first_detected_at DESC')).map((a) => ({
        kind: humanise(a['kind']!), severity: humanise(a['severity']!), status: humanise(a['status']!), title: a['title']!,
        investor: a['user_ext_id'] ? snap.byExtId.get(a['user_ext_id'])?.up.name ?? null : null, firstDetectedAt: a['first_detected_at']!,
        resolvedAt: a['resolved_at'] ?? null, resolution: a['resolution'] ?? null, _date: day(a['first_detected_at']), _status: a['status'] ?? null,
      }));
    },
  },
];

const definition = (r: Report) => ({
  key: r.key, name: r.name, description: r.description, dateField: r.dateField, statusLabel: r.statusLabel, statuses: r.statuses, columns: r.columns,
});

function find(key: string): Report {
  const report = Reports.find((r) => r.key === key);
  if (!report) throw HttpError.notFound('That report does not exist.');
  return report;
}

function filtersOf(query: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const name of ['from', 'to'] as const) {
    const value = query.get(name);
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) filters[name] = value;
  }
  const status = query.get('status');
  if (status) filters.status = status;
  return filters;
}

async function rowsFor(ctx: Ctx, report: Report, filters: Filters) {
  const rows = await report.rows(ctx);
  return rows
    .filter((r) => {
      if (report.dateField && filters.from && (!r._date || r._date < filters.from)) return false;
      if (report.dateField && filters.to && (!r._date || r._date > filters.to)) return false;
      if (filters.status && r._status !== filters.status) return false;
      return true;
    })
    .map(({ _date, _status, ...rest }) => rest as Record<string, Cell>);
}

const PreviewLimit = 100;

export function reportRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('reports.read');

  router.get('/reports', full, read, () => Reports.map(definition));

  router.get('/reports/:key', full, read, async (ctx) => {
    const report = find(ctx.params.key!);
    const filters = filtersOf(ctx.query);
    const rows = await rowsFor(ctx, report, filters);
    return {
      report: report.key, name: report.name, columns: report.columns, rows: rows.slice(0, PreviewLimit), total: rows.length,
      limit: PreviewLimit, truncated: rows.length > PreviewLimit, filters, generatedAt: new Date().toISOString(),
    };
  });

  router.get('/reports/:key/export', full, read, async (ctx) => {
    const report = find(ctx.params.key!);
    const filters = filtersOf(ctx.query);
    const rows = await rowsFor(ctx, report, filters);
    await audit(ctx, 'report.exported', report.key, { rows: rows.length, filters });
    return new Csv(`risips-${report.key}-${istDate(Date.now())}.csv`, toCsv(report.columns, rows));
  });
}
