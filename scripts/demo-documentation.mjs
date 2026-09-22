/* eslint-disable no-console */

/**
 * Demo data for the Documentation module — docs/MODULE_DOCUMENTATION.md.
 *
 * Drives the running API rather than writing rows, which is the point: an
 * advise's PO grid is pulled from a finalised load plan, its House BL number is
 * allocated by a sequence, and a BL draft copies that number. Inserting those
 * by hand would be a second implementation of all three, free to disagree with
 * the real one — and demo data that disagrees with the product is worse than
 * none, because it teaches people the wrong thing.
 *
 * So this walks the same path an operator does:
 *
 *   finalise a load plan -> make the advise -> send it -> draft the BL
 *   -> approve one, leave one drafting, have the customer submit a third
 *
 * and leaves every screen with a row in every state worth looking at.
 *
 *   pnpm dev                     (in another terminal — this needs the API up)
 *   pnpm demo:docs               seed it
 *
 * Idempotent by skipping: a booking that already carries an advise is left
 * alone, so running it twice does not double anything.
 */

const API = process.env.API_URL ?? 'http://localhost:4000';
const SLUG = process.env.TENANT_SLUG ?? 'demo';
const USER = process.env.DEMO_USER ?? 'superadmin';
const PASS = process.env.DEMO_PASSWORD ?? 'ChangeMe!2026';

/** The customer logins this creates, so the portal can be tried from both sides. */
const PORTAL_PASSWORD = 'PortalTest!2026';

let token = '';

async function call(method, path, body, asToken) {
  const res = await fetch(`${API}/api/tenant${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Slug': SLUG,
      ...(asToken ?? token ? { Authorization: `Bearer ${asToken ?? token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json, data: json?.data };
}

const get = (p, t) => call('GET', p, undefined, t);
const post = (p, b, t) => call('POST', p, b ?? {}, t);

/** ISO 6346 check digit, so the finalise step is given a real box number. */
function containerNo(stem) {
  const values = {};
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => {
    // 11, 12... skipping every multiple of 11, as the standard has it.
    const n = i + 10 + Math.floor((i + 10) / 11) - 1;
    values[c] = n >= 11 ? n + 1 : n;
  });
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = stem[i];
    const v = /[0-9]/.test(ch) ? Number(ch) : values[ch];
    sum += v * 2 ** i;
  }
  return `${stem}${(sum % 11) % 10}`;
}

function say(step, detail) {
  console.log(`  ${step.padEnd(34)} ${detail}`);
}

/** The bookings this script works with, found by their code. */
async function bookingsByCode(codes) {
  const found = new Map();
  for (const view of ['TO_ADVISE', 'ADVISED']) {
    const res = await get(`/documentation/shipment-advise?view=${view}&page=1&limit=100`);
    for (const row of res.data ?? []) {
      if (codes.includes(row.code)) found.set(row.code, row);
    }
  }
  return found;
}

/** Consolidate, load every cargo line, finalise. The plan the advise reads. */
async function finalisePlan(shipmentId, box) {
  const sizes = await get('/setting/container-sizes?page=1&limit=50');
  const size = (sizes.data ?? []).find((s) => s.code === '20STD') ?? (sizes.data ?? [])[0];
  if (size === undefined) throw new Error('no container size to plan against');

  const made = await post('/ops/clps/consolidate', {
    shipmentIds: [String(shipmentId)],
    containerSizeId: String(size.id),
  });
  if (made.status !== 201) return { ok: false, why: JSON.stringify(made.body).slice(0, 160) };
  const clpId = made.data.id;

  /*
   * Load what the booking actually has waiting. `pool` is the cargo drawn from
   * accepted receipts with nothing allocated to it yet — never the booked
   * quantity, which is the distinction MODULE_CLP §2.4 turns on.
   */
  const plan = await get(`/ops/bookings/${shipmentId}/clp`);
  for (const line of plan.data?.pool ?? []) {
    const put = await post(`/ops/clps/${clpId}/lines`, {
      cargoLineId: String(line.cargoLineId),
      ctnQty: line.ctnQty,
    });
    if (put.status !== 201) {
      return { ok: false, why: `loading ${line.poNo}: ${JSON.stringify(put.body).slice(0, 120)}` };
    }
  }

  const done = await post(`/ops/clps/${clpId}/finalise`, {
    containerNo: box,
    sealNo: `SL-DOC-${String(shipmentId).slice(-4)}`,
    loadDatetime: '2026-09-18T09:00:00.000Z',
  });
  return done.status === 200
    ? { ok: true, clpId }
    : { ok: false, why: JSON.stringify(done.body).slice(0, 160) };
}

/** Make the advise from whatever the plan and the receipts hold. */
async function makeAdvise(shipmentId, { send }) {
  const existing = await get(`/documentation/bookings/${shipmentId}/advise`);
  if (existing.data !== null && existing.data !== undefined) {
    return { skipped: true, advise: existing.data };
  }

  const pre = await get(`/documentation/bookings/${shipmentId}/advise/prefill`);
  if (pre.status !== 200) return { failed: JSON.stringify(pre.body).slice(0, 160) };
  const d = pre.data;
  if (d.blockedReason !== null) return { failed: d.blockedReason };

  const made = await post(`/documentation/bookings/${shipmentId}/advise`, {
    carrierId: d.carrierId,
    transitType: d.transitType,
    firstVesselId: d.firstVesselId,
    voyageNo: d.voyageNo,
    firstFlightNo: d.firstFlightNo,
    polId: d.polId,
    podId: d.podId,
    etd: d.etd,
    eta: d.eta,
    stuffingDate: d.stuffingDate,
    mblNo: `MBL-${String(shipmentId).slice(-5)}`,
  });
  if (made.status !== 201) return { failed: JSON.stringify(made.body).slice(0, 160) };

  if (!send) return { advise: made.data };

  const to = (made.data.recipients ?? []).map((r) => ({ email: r.email }));
  const sent = await post(`/documentation/shipment-advise/${made.data.id}/send`, {
    to: to.length > 0 ? to : [{ email: 'operations@demo.local' }],
    note: 'Your cargo is on board. The bill of lading draft follows.',
  });
  return sent.status === 200 ? { advise: sent.data } : { failed: JSON.stringify(sent.body).slice(0, 160) };
}

/** Draft the bill of lading from the advise's number and the plan's containers. */
async function makeBlDraft(shipmentId, { as, approve }) {
  const who = as ?? token;
  const prefixed = as === undefined ? '/documentation' : '/portal';
  const key = as === undefined ? 'bookings' : 'shipments';

  const existing = await get(`${prefixed}/${key}/${shipmentId}/bl-draft`, who);
  if (existing.data !== null && existing.data !== undefined) {
    return { skipped: true, draft: existing.data };
  }

  const pre = await get(`${prefixed}/${key}/${shipmentId}/bl-draft/prefill`, who);
  if (pre.status !== 200) return { failed: JSON.stringify(pre.body).slice(0, 160) };
  const d = pre.data;
  if (d.blockedReason !== null) return { failed: d.blockedReason };

  // A mode is required (B34 is starred on the client's sheet) and the booking
  // may not carry one.
  let modeId = d.preCarriageByModeId;
  if (modeId === '') {
    const modes =
      as === undefined
        ? (await get('/setting/modes?page=1&limit=50')).data
        : (await get('/portal/lookups', who)).data?.modes;
    modeId = String((modes ?? [])[0]?.id ?? '');
  }
  if (modeId === '') return { failed: 'no mode to set as Pre-Carriage By' };

  const body = {
    shipperText: d.shipperText || 'Shipper, as it prints on the bill.',
    consigneeText: d.consigneeText || 'Consignee, as it prints on the bill.',
    notifyText: d.notifyText || d.consigneeText || 'Notify party.',
    preCarriageByModeId: modeId,
    placeOfReceipt: d.placeOfReceipt || 'Dhaka CFS',
    polId: d.polId,
    podId: d.podId,
    oceanVesselVoyage: d.oceanVesselVoyage,
    grossWeightKg: d.grossWeightKg === null ? null : Number(d.grossWeightKg),
    measurementCbm: d.measurementCbm === null ? null : Number(d.measurementCbm),
    freightPayableAt: 'Chattogram',
    originalBlCount: 3,
    packagesDescription: 'SAID TO CONTAIN\nGARMENTS IN CARTONS\nFREIGHT PREPAID',
    ladenOnBoardDate: '2026-09-18',
  };

  const made = await post(`${prefixed}/${key}/${shipmentId}/bl-draft`, body, who);
  if (made.status !== 201) return { failed: JSON.stringify(made.body).slice(0, 160) };

  if (as !== undefined) {
    const sub = await post(`/portal/bl-drafts/${made.data.id}/submit`, {}, who);
    return sub.status === 200 ? { draft: sub.data } : { failed: JSON.stringify(sub.body).slice(0, 160) };
  }
  if (approve === true) {
    const ok = await post(`/documentation/bl-drafts/${made.data.id}/approve`, {});
    return ok.status === 200 ? { draft: ok.data } : { failed: JSON.stringify(ok.body).slice(0, 160) };
  }
  return { draft: made.data };
}

/** A customer login for the portal, reusing the role if it is already there. */
async function customerLogin(customerName, username) {
  const users = await get(`/crm/users?page=1&limit=100&search=${encodeURIComponent(username)}`);
  const existing = (users.data ?? []).find((u) => u.username === username);
  if (existing === undefined) {
    const roles = await get('/admin/roles?page=1&limit=100');
    let role = (roles.data ?? []).find((r) => r.name === 'Customer portal');
    if (role === undefined) {
      const made = await post('/admin/roles', {
        name: 'Customer portal',
        description: 'What a customer login may reach (CUSTOMER module only).',
      });
      role = made.data;
      await call('PUT', `/admin/roles/${role.id}/permissions`, {
        keys: [
          'CUSTOMER.SHIPMENT.VIEW',
          'CUSTOMER.SHIPMENT.EXPORT',
          'CUSTOMER.BL_DRAFT.VIEW',
          'CUSTOMER.BL_DRAFT.CREATE',
          'CUSTOMER.BL_DRAFT.EDIT',
          'CUSTOMER.BL_DRAFT.SUBMIT',
          'CUSTOMER.BL_DRAFT.EXPORT_PDF',
        ],
      });
    }

    const customers = await get('/crm/customers?page=1&limit=100');
    const customer = (customers.data ?? []).find((c) => c.name === customerName);
    if (customer === undefined) return { failed: `no customer called ${customerName}` };

    const made = await post('/crm/users', {
      userType: 'CUSTOMER',
      customerId: String(customer.id),
      username,
      email: `${username}@demo.local`,
      password: PORTAL_PASSWORD,
      roleId: String(role.id),
    });
    if (made.status !== 201) return { failed: JSON.stringify(made.body).slice(0, 160) };
  }

  const login = await post('/auth/login', { username, password: PORTAL_PASSWORD });
  if (login.status !== 200) return { failed: 'could not sign in as the customer' };
  return { token: login.data.accessToken };
}

async function main() {
  console.log('\nDocumentation demo — driving the API at', API, '\n');

  const login = await post('/auth/login', { username: USER, password: PASS });
  if (login.status !== 200) {
    console.error('Could not sign in. Is `pnpm dev` running, and are the credentials right?');
    console.error(JSON.stringify(login.body).slice(0, 200));
    process.exit(1);
  }
  token = login.data.accessToken;

  /*
   * Four bookings, each left in a different place, so every tab of both
   * worklists and every state of the BL draft has something in it.
   */
  const plan = [
    { code: 'DEMO-SHEET-BKG-1', box: 'MSCU1234561', advise: 'send', bl: 'none' },
    { code: 'DEMO-SHEET-BKG-2', box: 'TGHU7654321', advise: 'send', bl: 'draft' },
    { code: 'DEMO-SHEET-BKG-6', box: 'SITU9876543', advise: 'send', bl: 'approve' },
    { code: 'DEMO-SHEET-BKG-7', box: 'CSQU3054383', advise: 'send', bl: 'customer' },
  ];

  const rows = await bookingsByCode(plan.map((p) => p.code));

  console.log('1. Container load plans');
  for (const step of plan) {
    const row = rows.get(step.code);
    if (row === undefined) {
      say(step.code, 'not on the advise worklist — skipped');
      continue;
    }
    if (!row.detail.includes('No finalised load plan')) {
      say(step.code, 'already planned');
      continue;
    }
    const res = await finalisePlan(row.id, containerNo(step.box.slice(0, 10)));
    say(step.code, res.ok ? `finalised in ${step.box}` : `could not plan: ${res.why}`);
  }

  console.log('\n2. Shipment advises');
  const advises = new Map();
  for (const step of plan) {
    const row = rows.get(step.code);
    if (row === undefined) continue;
    const res = await makeAdvise(row.id, { send: step.advise === 'send' });
    if (res.failed !== undefined) {
      say(step.code, `no advise: ${res.failed}`);
      continue;
    }
    advises.set(step.code, res.advise);
    say(
      step.code,
      `${res.advise.code} ${res.advise.status.toLowerCase()} · HBL ${res.advise.houseBlNo}` +
        (res.skipped === true ? ' (already there)' : ''),
    );
  }

  console.log('\n3. BL drafts');
  let abcToken;
  for (const step of plan) {
    const row = rows.get(step.code);
    if (row === undefined || step.bl === 'none') continue;

    if (step.bl === 'customer') {
      if (abcToken === undefined) {
        const who = await customerLogin(row.customerName, 'demo-portal-customer');
        if (who.failed !== undefined) {
          say(step.code, `no customer login: ${who.failed}`);
          continue;
        }
        abcToken = who.token;
      }
      const res = await makeBlDraft(row.id, { as: abcToken });
      say(
        step.code,
        res.failed !== undefined
          ? `no draft: ${res.failed}`
          : `${res.draft.code} submitted by the customer`,
      );
      continue;
    }

    const res = await makeBlDraft(row.id, { approve: step.bl === 'approve' });
    say(
      step.code,
      res.failed !== undefined
        ? `no draft: ${res.failed}`
        : `${res.draft.code} ${res.draft.status.toLowerCase()} · BL ${res.draft.blNo}`,
    );
  }

  console.log('\n4. BL templates');
  const templates = await get('/documentation/bl-templates');
  const have = new Set((templates.data ?? []).map((t) => t.name));
  const wanted = [
    {
      name: 'House standard — freight prepaid',
      customerId: null,
      notifyText: 'SAME AS CONSIGNEE',
      freightPayableAt: 'Chattogram',
      originalBlCount: 3,
    },
    {
      name: 'ABC Apparels — Hamburg lane',
      customerId: null,
      shipperText: 'ABC APPARELS LTD\nPLOT 42, DEPZ, SAVAR, DHAKA, BANGLADESH',
      notifyText: 'SAME AS CONSIGNEE',
      freightPayableAt: 'Hamburg',
      originalBlCount: 3,
    },
  ];
  for (const t of wanted) {
    if (have.has(t.name)) {
      say(t.name, 'already there');
      continue;
    }
    const made = await post('/documentation/bl-templates', t);
    say(t.name, made.status === 201 ? 'created' : JSON.stringify(made.body).slice(0, 120));
  }

  console.log('\nDone. Sign in at http://localhost:3000');
  console.log(`  staff     ${USER} / ${PASS}`);
  console.log(`  customer  demo-portal-customer / ${PORTAL_PASSWORD}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
