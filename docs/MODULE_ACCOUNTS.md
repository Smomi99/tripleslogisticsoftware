# MODULE SPEC — ACCOUNTS: AWAITING FREIGHT INV · DEBIT INVOICE · CREDIT INVOICE · RECEIVABLE-PAYABLE · THE BOOKS — **v2, transcribed from `Design.xlsx`**

> **v2 (2026-09-27).** The client's second Accounts delivery is §13 and §14: Chart of accounts, the four
> Transaction screens (Journal, Expense, Income, Internal Transfer), Bank and Account Set up, the Credit
> Invoice list, and the Unbilled column on the Receivable-Payable list. Where §14 changes an earlier
> section, that section says so.

> **How to use.** Start a Claude Code session with:
> *"Read CLAUDE.md, then /docs/MODULE_ACCOUNTS.md."*
> `CLAUDE.md` governs stack, tenancy, RBAC, screen patterns and design tokens.
> **Depends on** `MODULE_BOOKING_CARGO.md` (the booking is what gets invoiced),
> `MODULE_INQUIRY_QUOTATION.md` (the quotation is what the invoice is pulled from), `MODULE_CLP.md` +
> `CR-002` §9 (the container cost the carrier block is prefilled from) and the opening balances of
> `20260819180000_vendor_to_crm_and_opening_balances`.
> Every field below comes from a sheet cell. What no sheet answers is in §12 with the default the build
> uses, not silently in the schema.

---

## 0. SOURCE — WHAT ARRIVED

`docs/Design.xlsx`, 2026-09-26, replacing `Design (6).xlsx`. Every earlier sheet is byte-for-byte
unchanged except `Menu`. Eight sheets are new:

| Sheet | Screen | This spec |
|---|---|---|
| `Awaiting Debit Note` | Accounts → **Awaiting Freight Inv**, and the invoice it makes | **built** |
| `Debit note (Other)` | Accounts → **Debit Invoice** (list, `Create New`, `Receive`) | **built** |
| `Receiveable-Payable list` | Accounts → **Receivable-Payable list** (sheet title: `Ledger`) | **built** |
| `Ledger.` | One party's ledger (`Ledger - CMA`) — the list's drill-down | built; became `Credit Invoice` in v2 (§14.2) |
| `Chart of accounts` | Accounts → Chart of accounts | **built in v2** (§14.1) |
| `Journal` | Accounts → Transaction → Journal | **built in v2** (§14.4) |
| `Expense-Vendor`, `Expense-regular` | Accounts → Transaction → Expense | **built in v2** (§14.4–§14.6) |

### 0.1 The Accounts menu, before and after

```
before (Design (6))            after (Design.xlsx, M3–M16)
- Awaiting Freight Inv          - Awaiting Freight Inv
- New Invoice ( Other)          - Debit Invoice
- Amount Receivable             - Credit Invoice
- New Credit Invoice            - Receivable-Payable list
- Amount Payable                -Chat of accounts
- Income statement              - Transaction
- Balance Sheet                       '- Journal  '- Expense  '- Income  '-Internal Transfer
- Cash Flow Statement           - Income statement · - Balance Sheet · - Cash Flow Statement · - TA/DA
- TA/DA
```

`Amount Receivable` and `Amount Payable` became **one** screen. `New Invoice (Other)` became **Debit
Invoice**. §6 carries the permission consequences.

### 0.2 The flow (Menu F22 and the Steps table B33–G50)

`Quotation > Shipment Booking > Shipment Approval > Shipping Order Issue > Cargo Receipt > CLP >
Stuffing > Shipment Advise > EGM > SI Submission > BL Issue > Debit Note`, and the Steps table says
`Debit note/invoice — Outbound Yes, Inbound Yes`: **every booking is invoiced**, inbound included,
even though inbound skips the shipping order, VGM and the BL.

---

## 1. WHERE THIS SITS

```
booking (approved) ──► AWAITING FREIGHT INV ──Make invoice──► DEBIT INVOICE (draft)
                                                                  │  Save & Send
                                                                  ▼
                                              ISSUED ──Receive──► PARTIALLY RECEIVED ──► RECEIVED
                                                │
                    customer receivable ◄───────┤  (the sell side)
       carrier / agent / vendor payables ◄──────┘  (the cost blocks)
                                                         │
                                                         ▼
                                              RECEIVABLE-PAYABLE LIST ──► one party's LEDGER
```

Sheet K17 says it in one line: *"A receivable and Payable ledger will be created."*

---

## 2. WHAT THE SHEETS SAY

Transcribed, not summarised. A quoted cell is the authority.

### 2.1 Awaiting Freight Inv — the list (`Awaiting Debit Note`, row 7)

`Inquiry No · Quotation No · Qutation Date · Booking NO · Customer · Commodity · Shipment Type ·
POL/AOL · POD/AOD · Required Container · Quoted Amount · Status · Action`, with `Search` (N6).

- Sample rows: `Sea · Chittagong · Humburg · 20STD(1) + (40HC(1)`, `Air · Dhaka · London · 200 Kg`.
- L5: *"Quote can see by click on the amount"* — the Quoted Amount opens the quotation.
- Action (N8, O8): `Make invoice` · `Edit`.

### 2.2 The invoice the list makes (`Awaiting Debit Note`, rows 14–64)

Notes, K14–K17, verbatim:

1. *"Pull out full Qutation from quote table . If any charge /qty and othe item need add or remove
   then we can do it."*
2. *"Total buying cost amount need to insert in a field. A file upload of Agent / vendor / carrier
   debite invoice also upload for record."*
3. *"Selection of agent/vendor / carrier must be there."*
4. *"A receivable and Payable ledger will be created."*

**Cost Details** (B19) — three blocks, identical in shape:

| Block | Party picker | Grid (rows 23 / 32 / 40) | Foot |
|---|---|---|---|
| `Buying from Carrier` (B21) | combo box at C21 | `Cost head · Container size · unit · QTY · Buying price · Currency · Total Amount · Conversion Rate · Total Amount (BDT)` | `Total Cost =` · `Invoice no :` · `Upload Invoice` |
| `Buying from Agent` (B30) | combo box at C30 | same | same |
| `Buying from Vendor` (B38) | combo box at C38 | same | same |

`Grand total cost =` (G46).

**Selling Price** (B51) — the same nine columns (the sheet's header reads `Buying price` here too; it
is the selling price, see §3.4) and `+ Add` (K52). Then `Total Sell price =`, `Gross profit = Total
sell price - Grand Total cost`, `GP % =`.

**Email id of Customer** (B61). Buttons (B64–E64): `Drat` · `Save & Send` · `Print` · `Cancel invoice`.

### 2.3 Debit Invoice — the list (`Debit note (Other)`, row 7)

`Inquiry No · Quotation No · Qutation Date · Booking NO · Debit Invoice No · Customer · Shipment Type ·
POL/AOL · POD/AOD · Invoice Amount · Currency · Status · Action`, `Create New` (O5).

- Action (N8–P8): `Receive` · `Edit` · `Cancel`.
- The receive form (rows 15–20): `Inquiry No · Quotation NO · Booking NO · Debit Invoice No ·
  Customer · Invoice Amount · Currency` and **`Payment Date`** (G15).

### 2.4 Receivable-Payable list (`Receiveable-Payable list`, title G3 `Ledger`)

`SL No · Agent / Carrier /Vendor name · Receiveable Amount(USD) · Receiveable Amount(Base Cur) ·
Payable Amount ( USD) · Payable Amount ( Base Cur)`, grouped under `Receiveable Amount Details` (D7)
and `Payable Amount Details` (F7), with `Total =` (C19). Sample names: CMA-CGM, Trust Cargo, Maersk
line, DK Internatinol.

### 2.5 Ledger — the drill-down (`Ledger.`, title G3 `Ledger - CMA`)

`Date · Invoice No · Descrption · Amount ( USD) · Conversion Rate · Amount ( Base cur) · Payment Status
· Action` — sample `2026-09-10 · Inv-CMA-001 · Freight 1x40HC · 2000 · 124 · =F8*E8 (248000) ·
Partial Paid | Full Paid · Make Payment · Edit | Delete`.

`Amount (Base) = Amount × Conversion Rate` is the sheet's own formula (G8), and it is the rule every
money column in this module follows.

---

## 3. DECISIONS

### 3.1 Awaiting Freight Inv is a worklist of bookings, like every other stage list

Approval, Shipping Order, Cargo Receipt, Shipment Advise and BL Draft are all *"the booking list
narrowed to the states where this stage is the next thing that happens"* (`shipment-worklist.route.ts`).
This one is the same, with one difference: membership is decided by **the absence of a live freight
invoice**, not by a shipment status alone, because invoicing does not move the booking (§3.8).

A booking is awaiting its debit note while it is **confirmed** — `APPROVED_FOR_SHIPMENT`, `SO_ISSUED`,
`SO_SKIPPED`, `PART_RECEIVED`, `CARGO_RECEIVED`, `ADVISED`, `BL_DRAFTED`, `BL_ISSUED` or `SHORT_CLOSED`
— and has no `ISSUED` freight invoice. (`BL_ISSUED` arrived with BL Print, MODULE_DOCUMENTATION §13;
it is F22's last step before the Debit Note, so it counts as *ready* with `ADVISED` and `BL_DRAFTED`.) Not yet confirmed (`BOOKING_RECEIVED`, `VESSEL_PROPOSED`), `REJECTED` and
`CANCELLED` bookings never appear. §12 Q1 asks whether the client wants it narrower.

`Status` shows where the invoice stands (`Awaiting invoice` / `Draft`), with the booking's own stage
under it — an accountant deciding what to bill first needs both.

### 3.2 One invoice, two kinds

`kind = FREIGHT` is made from a booking on the awaiting list; **one live freight invoice per booking**
(a partial unique index, like one live advise per booking). `kind = OTHER` is `Create New` — the
old menu's *New Invoice (Other)* — for charges that are not a booking's freight: it names a customer,
and may name a booking for reference, and there can be any number of them.

### 3.3 One currency per invoice, and per supplier block

The client's rule for the quotation (2026-09-11) is *one currency per quotation*, and `Debit note
(Other)` shows `Invoice Amount | Currency` as one pair — so an invoice is in one currency too. Pulling
a quotation therefore pulls its currency. Each cost block is one supplier's invoice, which is in one
currency, so each block has one currency of its own. Changing it on any row of a grid changes the
whole grid, exactly as the quotation grid behaves.

### 3.4 Money: amount, frozen rate, base amount

Every figure is stored the way sheet G8 computes it: **amount × conversion rate = base amount**, where
a rate is "units of the workspace's base currency per 1 unit" (`lib/currency-rate.ts`). The rate is
taken from the workspace's own rate for the invoice date (`resolveRate`), frozen on the document, and
editable while the side it belongs to is editable. `Total Amount (BDT)` on the sheet is this base
amount; the column is headed with the workspace's actual base code.

Totals are stored on the header and recomputed on every save, like the quotation's (§5.3 rule 6).
Gross profit and GP % are **derived** from the stored totals, never stored:
`GP = sell total (base) − Σ cost totals (base)`, `GP % = GP ÷ sell total (base) × 100`.

The selling grid's `Buying price` header (C52 row) is a copy of the cost grid's; the column is the
selling price, and the screen says so.

### 3.5 What the invoice is prefilled with

- **Selling Price** ← the booking's quotation lines, every one, with their cost head, container size,
  unit, quantity and price (note 1). Editable, removable, and `+ Add` for more. A quotation raised
  before the one-currency rule can still mix currencies (`BDT 19,500 + USD 3,200`); that one is
  invoiced in the **base** currency with each charge converted at today's rate, and a note says so.
  Relabelling every line in the first line's currency would bill 19,500 dollars for a taka charge —
  found by running the flow against the demo data.
- **Buying from Carrier** ← the booking's carrier, and — when the booking has been through a
  finalised container load plan — one line per container at the cost CR-002 §9 allocated to this
  booking (`clp_booking.allocated_cost_amount`). That figure exists precisely so Accounts would not
  have to reconstruct it (`lib/clp-cost.ts`).
- **Buying from Agent** ← the agent the quotation was priced from, if it was built from an agent's
  quote, else the inquiry's winning agent. Party only; the lines come from the agent's invoice.
- **Buying from Vendor** ← nothing. Vendors are chosen by hand.
- **Email id of Customer** ← the customer's contacts' email addresses.

Nothing is saved until `Draft` or `Save & Send` — the advise's prefill-then-create shape — so opening
the form and walking away leaves no half-made invoice behind.

### 3.6 Receivable and payable are computed from the documents

> v2: still true. Payments and receipts are now written by vouchers, beside settlement rows that lower
> these same balances (§14.6); an Unbilled column sits between them (§14.7).

`Receivable` for a customer = their issued invoices − what has been received against them, plus the
opening balance from CRM. `Payable` to a carrier, agent or vendor = the cost blocks of issued invoices,
plus the opening balance. Computed on read, not written to a second table: while nothing else posts
to a party (no payment screen yet, §12 Q9), a posting table would be a copy that can only drift from
the documents it copies. When Journal and Expense land, they get a ledger table and these documents
post into it.

Openings come from each party's two CRM columns: what they owe us (`customer_owe`, `vendor_owe`,
`agent_owe`) is receivable, and what we owe them (`we_owe`) is payable. Customer and vendor had one signed
`opening_balance` until §14.14 moved them to the agent's pair. Carriers have no opening balance. Openings
are converted at today's rate, because nothing froze one.

The **USD** columns carry what is denominated in US dollars; the **Base** columns carry everything,
converted. A party billed partly in taka shows the dollar part in USD and the whole in base — the
ledger drill-down shows each document in its own currency, so the two never have to be reconciled in
the reader's head. §12 Q5.

### 3.7 Draft, issue, and what may change afterwards

- `DRAFT` — everything editable.
- `ISSUED` (by `Save & Send`) — the **sell side** (customer, date, currency, rate, selling lines) stays
  editable only until money is received against it; after that, a correction is cancel-and-reissue.
  The **cost side** stays editable for the life of the invoice: a carrier's invoice routinely arrives
  after the customer has been billed, and it changes nothing the customer was sent.
- `CANCELLED` — reason mandatory, read-only, number kept forever. Refused while money received
  against it, or paid against any of its credit invoices, stands. Cancelling the Income or Expense
  voucher that moved it takes it back first (§14.4). Cancelling a freight invoice returns its booking to
  the awaiting list.

Numbered `DN-2026-000001` when first saved, per workspace per year of the invoice date, like every
other document a customer sees; never reused — a cancelled invoice keeps its number (§12 Q2).

### 3.8 Invoicing does not move the booking

After the debit note the shipment still has *On board confirmation*, *Transhipment confirmation*,
*Arrival confirmation*, *IGM update* and *DO issue* ahead of it (Steps table). Invoicing is Accounts
recording money, not the shipment moving, so `shipment_status` is untouched.

### 3.9 Buying costs are privileged

A salesman may need to see whether a customer has paid without seeing what the forwarder paid the
carrier. The cost blocks, cost totals, gross profit and GP % are behind
`ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE` — the same split `PURCHASE.*.VIEW_BUY_PRICE` already makes.
Without it the API leaves them out of every response, ignores them on save, and the screen does not
draw them. The customer's PDF never carries them at all.

---

## 4. SCHEMA

Every table follows CLAUDE.md §4: `tenant_id` first, audit columns, soft delete, composite FKs to
tenant-owned parents, single-column FKs plus `app_assert_parent_tenant` to system-capable ones
(carrier, container size, cost unit, currency), RLS in the single-comparison form, the audit trigger.

```
debit_invoice                                  -- client: Awaiting Debit Note / Debit note (Other)
  code DN-2026-000001, series_year
  kind            ENUM debit_invoice_kind (FREIGHT, OTHER)
  shipment_id     FK shipment NULL             -- required when FREIGHT (CHECK)
  quotation_id    FK quotation NULL            -- the booking's quotation, for the list's columns
  customer_id     FK customer NOT NULL
  invoice_date    DATE
  currency_id     FK currency, currency_code   -- §3.3, snapshot code
  conversion_rate NUMERIC(18,10)               -- §3.4, frozen
  total_amount, total_amount_base, cost_total_base   NUMERIC(18,4), recomputed on save
  recipient_emails TEXT[]                      -- "Email id of Customer"
  status          ENUM debit_invoice_status (DRAFT, ISSUED, CANCELLED)
  issued_at/by, sent_at/by, pdf_file, cancelled_at/by, cancel_reason (CHECK when CANCELLED)
  UNIQUE (tenant_id, code); one live FREIGHT invoice per shipment (partial unique)

debit_invoice_line                             -- Selling Price grid
  debit_invoice_id FK, sort_order, source ENUM invoice_line_source (QUOTATION, LOAD_PLAN, MANUAL)
  cost_head_id FK + cost_head_name, container_size_id FK NULL + name, cost_unit_id FK NULL + unit_name
  quantity NUMERIC(18,3), unit_price NUMERIC(18,4)
  amount   NUMERIC(18,4) GENERATED (quantity * unit_price)

debit_invoice_cost                             -- one "Buying from …" block
  debit_invoice_id FK, sort_order
  party_type ENUM supplier_party_type (CARRIER, AGENT, VENDOR)
  carrier_id | agent_id | vendor_id            -- exactly the one party_type names (CHECK)
  supplier_invoice_no TEXT, supplier_invoice_file (storage key)
  currency_id FK + currency_code, conversion_rate NUMERIC(18,10)
  total_amount, total_amount_base NUMERIC(18,4)

debit_invoice_cost_line                        -- the block's grid
  debit_invoice_cost_id FK, sort_order, source, cost head / size / unit as above,
  quantity, unit_price ("Buying price"), amount GENERATED

debit_invoice_receipt                          -- "Receive"
  debit_invoice_id FK, payment_date DATE,
  amount NUMERIC(18,4) CHECK > 0               -- in the invoice's currency
  amount_base NUMERIC(18,4)                    -- at the invoice's rate (§3.4)
```

---

## 5. RULES

1. `Make invoice` needs a confirmed booking (§3.1) with no live freight invoice; a second one is a 409
   that names the invoice already there.
2. A line needs a cost head; quantity and price are non-negative numbers. `Save & Send` needs at least
   one selling line and at least one address.
3. A cost block needs its party once it has any line, number or file. A block with nothing in it is
   dropped on save.
4. A received amount is positive and no more than what is outstanding. Payment status is derived:
   nothing received → **Unpaid**, some → **Partially received**, all → **Received**.
5. Every write re-reads the document inside the transaction and checks §3.7 there — never trusting the
   status the browser last saw.
6. `Save & Send` renders the PDF, stores it, and attaches it (the advise's pattern). A failure to
   render logs and sends the letter without it rather than failing an issue that has already happened.

---

## 6. PERMISSIONS — registry diff

Existing grants survive: the migration **renames permission keys in place**, the precedent
`20260819180000` set when Vendor moved to CRM.

```diff
 ACTIONS
+  'RECEIVE'                   // recording money in is not editing the invoice
 FEATURES
   ACCOUNTS.AWAITING_FREIGHT_INV   unchanged — VIEW the queue, CREATE = Make invoice
-  ACCOUNTS.NEW_INVOICE_OTHER      'New Invoice (Other)'   MASTER
+  ACCOUNTS.DEBIT_INVOICE          'Debit Invoice'
+                                  [...MASTER, 'SEND', 'EXPORT_PDF', 'CANCEL', 'RECEIVE', 'VIEW_BUY_PRICE']
-  ACCOUNTS.AMOUNT_RECEIVABLE      'Amount Receivable'     MASTER
-  ACCOUNTS.AMOUNT_PAYABLE         'Amount Payable'        MASTER
+  ACCOUNTS.RECEIVABLE_PAYABLE     'Receivable-Payable list'   MASTER
   ACCOUNTS.NEW_CREDIT_INVOICE     label 'Credit Invoice' (key unchanged; screen not built)
```

`AMOUNT_RECEIVABLE` is renamed in place. `AMOUNT_PAYABLE` cannot also be renamed onto the same keys,
so every role and user grant on it is copied onto the matching `RECEIVABLE_PAYABLE` key first, and
only then are its rows removed — nobody who could see payables loses the screen that now shows them.

**Granting it.** `Make invoice` is `AWAITING_FREIGHT_INV.CREATE`; everything after the first save —
opening, editing, sending, printing the invoice — is `DEBIT_INVOICE.*`. An accounts role therefore
holds both features. The seed creates the new keys; no existing role is granted them automatically.

---

## 7. API — `/api/tenant/accounts`

| Method | Route | Permission |
|---|---|---|
| GET | `/awaiting-freight-inv` | `AWAITING_FREIGHT_INV.VIEW` |
| GET | `/shipments/:id/debit-invoice/prefill` | `AWAITING_FREIGHT_INV.CREATE` |
| POST | `/shipments/:id/debit-invoice` | `AWAITING_FREIGHT_INV.CREATE` |
| GET | `/debit-invoices/options` | `AWAITING_FREIGHT_INV.CREATE` **or** `DEBIT_INVOICE.VIEW` |
| GET / POST | `/debit-invoices` | `DEBIT_INVOICE.VIEW` / `.CREATE` (an OTHER invoice) |
| GET / PATCH | `/debit-invoices/:id` | `.VIEW` / `.EDIT` — PATCH refused once money is received (§3.7) |
| PUT | `/debit-invoices/:id/costs` | `.EDIT` + `.VIEW_BUY_PRICE` — the cost side alone, for after a receipt |
| POST | `/debit-invoices/:id/send` | `.SEND` — issues a draft, (re)sends an issued one |
| GET | `/debit-invoices/:id/pdf` | `.EXPORT_PDF` |
| POST | `/debit-invoices/:id/cancel` | `.CANCEL` — reason required |
| ~~POST~~ | ~~`/debit-invoices/:id/receipts`~~ | removed in v2 — `Receive` opens Income (§14.6) |
| POST / GET | `/debit-invoices/:id/costs/:costId/file` | `.EDIT` + `.VIEW_BUY_PRICE` / `.VIEW_BUY_PRICE` |
| GET | `/receivable-payable` | `RECEIVABLE_PAYABLE.VIEW` |
| GET | `/receivable-payable/:partyType/:partyId` | `RECEIVABLE_PAYABLE.VIEW` — the ledger |

---

## 8. SCREENS

| Route | Sheet |
|---|---|
| `/accounts/awaiting-freight-inv` | §2.1 |
| `/accounts/debit-invoice/new?shipment=:id` → `/accounts/debit-invoice/:id` | §2.2, and `Create New` without a booking |
| `/accounts/debit-invoice` | §2.3, with the `Receive` modal |
| `/accounts/receivable-payable` | §2.4 |
| `/accounts/receivable-payable/:partyType/:partyId` | §2.5, read-only |

---

## 9. DOCUMENTS AND EMAIL

- **PDF** `lib/debit-invoice-pdf.ts` on the shared letterhead: the customer, the booking, quotation and
  inquiry references, the lane, the selling lines, the total, the total in words, and — when the invoice
  is not in the base currency — the frozen conversion rate and the base-currency equivalent, because
  that rate is what the receipt will be booked at (§12 Q6). **Never** a cost or a margin. Watermarked
  `DRAFT` until issued.
- **Email** template key `DEBIT_INVOICE_SENT`, with a built-in fallback, PDF attached.

---

## 10. TESTS

1. Tenant isolation for every list and every id (§7A rule 4).
2. The seam: prefill from a real quotation and a real CLP cost allocation, issue, and read the same
   money back from the Receivable-Payable list and the party ledger.
3. The rules of §5 and §3.7: one live freight invoice per booking, the receipt ceiling, cancel refused
   after a receipt, the sell side locked after a receipt while the cost side is not.
4. `VIEW_BUY_PRICE` — without it, no cost figure leaves the API in any response.
5. Permission guards on every route.

---

## 11. BUILD STATUS — 2026-09-26

| Piece | State |
|---|---|
| Schema + migration `20260926100000_accounts_debit_invoice` | **done** — 5 tables, 4 enums, RLS, grants, audit and tenant-guard triggers, the permission renames |
| Awaiting Freight Inv | **done** — queue, stage and mode filters, quoted amount opens the quotation, Make invoice / Edit |
| Debit invoice (Make invoice, Create New) | **done** — prefill (§3.5), three cost blocks with party, invoice no and upload, selling grid, GP and GP %, draft, Save & Send with the PDF attached, Print, Cancel |
| Debit Invoice list | **done** — status and kind filters, Receive (part payments), Edit, Cancel |
| Receivable-Payable list + party ledger | **done** — customers, agents, carriers and vendors, openings included, totals over every page; the ledger is read-only (§12 Q9) |
| Tests | `accounts.test.ts` — 19 cases: the whole loop with exact figures, §3.7's locks, the load-plan prefill, mixed currencies, `VIEW_BUY_PRICE`, guards, two-workspace isolation |

Checked in the browser against the demo workspace: 12 confirmed bookings on the queue, an invoice
made, sent, printed and half received, and the same money read back from the list and the carrier's
ledger.

---

## 12. OPEN QUESTIONS — for the client

Nothing below is guessed at in the schema. Each has a working default so the build is not held up.

| # | Question | Working default |
|---|---|---|
| 1 | **When does a booking start waiting for its debit note?** The chain puts the debit note after the BL, but inbound has no BL and the Steps table invoices both. | Every confirmed booking without an issued freight invoice (§3.1), with its stage shown so the ready ones stand out |
| 2 | **Debit invoice number format.** Only `PL-001` was ever given. | `DN-2026-000001`, per workspace per year, like the quotation and booking |
| 3 | **`Receivable-Payable list` names only agents, carriers and vendors**, but the invoice creates a customer receivable (K17). | Customers are listed too, marked by type, with a type filter |
| 4 | **More than one carrier, agent or vendor on one job?** The sheet draws one block each. | One block each on screen; the table allows more for when it is needed |
| 5 | **The USD and Base columns** for money billed in taka or a third currency. | USD = the dollar-denominated part; Base = everything converted (§3.6) |
| 6 | **Should the customer's PDF show the base-currency equivalent?** The quotation stopped printing a second currency on 2026-09-11. | Yes on the invoice only, because the invoice's rate is the rate the payment is booked at |
| 7 | **A receipt entered in error** — reversal, or delete? Neither is on the sheet. | **Answered by v2:** cancel the Income voucher that banked it (§14.4) |
| 8 | **`Receive` form** shows `Invoice Amount` and `Payment Date` only. Part payments are implied by the Ledger sheet's `Partial Paid`. | An `Amount received` field, defaulting to the outstanding balance |
| 9 | **Paying a supplier.** `Make Payment` on the Ledger sheet and the Expense sheets. | **Answered by v2:** Expense against the credit invoice (§14.6) |

---

## 13. SOURCE, SECOND DELIVERY — `Design.xlsx`, 2026-09-27

The client redrew the rest of the Accounts menu. Diffed sheet by sheet against the copy committed with
§1–§12; every sheet outside Accounts is unchanged except `Menu`.

| Sheet | What changed | Where it is built |
|---|---|---|
| `Menu` | M17–M19 added: `Setting` · `- Bank Set up` · `- Account Set up`. Hyperlinks now point Debit Invoice → `Debit Invoice`, Credit Invoice → `Credit Invoice`, Expense → `Expense-regular`, Income → `Income-Other`, Internal Transfer → `Internal Transfer` | §14.8 |
| `Receiveable-Payable list` | **New column group** `Unbilled Amount` (F7) — `Unbill Amount(USD)` · `Unbill Amount(Base Cur)` — between Receivable and Payable; the title moved to I3 | §14.7 |
| `Debit note (Other)` → `Debit Invoice` | Renamed. The receive form (rows 15–20) is gone; `Receive` (N8) now hyperlinks to the `Income` sheet | §14.6 |
| `Ledger.` → `Credit Invoice` | Renamed and retitled `Credit Invoice`; column C reads `Vendor/Agent/Carrier Inv No`; `Make Payment` (I8) hyperlinks to `Expense-Vendor` | §14.2 |
| `Chart of accounts` | H6 `Asset = Liabbilities - Owner's Equity`; B64–C68 `Expense Ledger - Predefined · Ledger: Cost of Service · Sub Ledger: Sea Freight-FCL` | §14.1 |
| `Journal` | Sample filled in: C10 `Salary for the month of Sep 2026`; rows 20–21 `Bank Minus 500000` (credit) and `Salary( Expense+` 500000 (debit) | §14.4 |
| `Expense-Vendor` | G17 `( minus 100)` beside `Payment from`, G21 `100` on the category row | §14.4, §14.6 |
| `Income` (new) | `Income/Receive`: Date · `Income From : ( Customer)` · `Select Invoice No : ( View invoice )` · Description · `Deposit to` · `Income Category` grid (`Select Income Category` · Amount · add) · Debit Amount · Credit Amount · Difference · Save | §14.4, §14.6 |
| `Income-Other` (new) | Date · Description · `Deposit to : ( bank or cash account` · Income Category grid · Debit / Credit / Difference · Save | §14.4 |
| `Internal Transfer` (new) | Date · `Transfer From : ( All bank account )` · Description · `Transfer To` grid (`Select account` · Amount · add) · Debit / Credit / Difference · Save | §14.4 |
| `bank setup` (new) | Bank Name · Branch · Bank Address · Swift No · Routing number · IBAN No · Save | §14.3 |
| `Account setup` (new) | Account Name · Account Nuber · Select Bank · Select Branch · Bank Address · Swift No · Routing number · IBAN No · Save (sample: Triple S Logistics, 08633033878, Bank Asia Plc, Ring Road, BAHDD9876, 07214563) | §14.3 |
| `Expense-regular` | Unchanged; now the Expense menu item's target | §14.4 |

`Income statement`, `Balance Sheet`, `Cash Flow Statement` and `TA/DA` are still on the menu with no sheet
of their own — see §14.9 Q1.

---

## 14. THE BOOKS — Chart of accounts, Transaction, Bank / Account set up

### 14.0 The one decision everything else follows

**The four Transaction screens are the books; the invoices stay the party ledgers.**

Every sheet the client drew for money moving — `Expense-regular`, `Expense-Vendor`, `Income`,
`Income-Other`, `Internal Transfer`, `Journal` — is a balanced double entry in the workspace base: an
account on one side, categories on the other, and `Debit Amount / Credit Amount / Difference` at the foot.
Each one is saved as a **voucher** (`journal_entry`) with its debit and credit **lines** (`journal_line`).
The chart's balances, and later the statements, are sums of posted voucher lines — nothing else.

Debit and credit invoices do **not** post to the books when they are issued. They remain what §3.6 made
them: the documents the Receivable-Payable list and each party's ledger are computed from. When a voucher
pays or banks against a party, it leaves a **settlement** row beside it (§14.6), and that row lowers the
party's balance.

Why not post invoices on issue (accrual)? Because the sheets were not drawn that way: `Expense-Vendor` asks
for an **Expense Category** against the supplier's invoice, and `Income` for an **Income Category** against
the customer's. Posting the invoice first would count that income or expense twice. §14.9 Q2 puts the
choice to the client; the tables are the same either way, so moving to accrual later means adding postings,
not reshaping anything.

### 14.1 Chart of accounts (sheet `Chart of accounts`)

- **Two levels, as B64–C68 say**: a **Ledger** (`parent_id` NULL) under one of five heads, and **Sub
  Ledgers** under a ledger. A sub ledger shares its ledger's head. The trigger `ledger_account_parent_guard`
  enforces both, so the chart cannot go three deep.
- **Predefined** (B64): every ledger and sub ledger on the sheet is seeded into each workspace **the first
  time anything reads the chart** (`ensureChart`, idempotent, race-safe on `UNIQUE(tenant_id, system_key)`).
  No data migration and no onboarding step, so every workspace, old or new, gets the same chart. A workspace
  owns its copy: it renames and extends it freely. Each predefined row carries a stable `system_key`
  (`ASSET.BANK`, `EXPENSE.COST_OF_SERVICE.SEA_FCL`, …) that the product holds on to instead of the name.
- **Spelling corrected on seeding**: Customs Clearence → Clearance, Gain/Loss on Foreight → Foreign
  Exchange, Computer Hardard → Hardware, Computer- Software → Computer Software, Sales Incetive → Incentive,
  Office Stationary → Stationery, Repair and Manatainence → Maintenance, Telphone → Telephone, Untilities →
  Utilities, Vehical → Vehicle, Un catagories / Uncatagories → Uncategorized, Commision → Commission. "Cash
  short or less" is kept as written, since its meaning is unclear (§14.9 Q7).
- **Not seeded**: the three sample bank sub ledgers (Z11–Z13, "Bank Asia Ltd-878"). They are real accounts,
  made by Account Set up (§14.3).
- `+ ADD new` beside a ledger adds a sub ledger; `++` (C9) adds a ledger. Under **Bank**, `+ ADD new` goes
  to Account Set up instead, so an account's number and branch are never missing.
- **Postable** = a sub ledger, or a ledger with no sub ledgers (Discount, Gain on Foreign Exchange, …).
- **Balance** per account = its posted debits minus credits (asset, expense) or credits minus debits
  (liability, equity, income), in the base. A ledger's balance adds its sub ledgers. The sheet shows no
  balance column; it is derived rather than stored, and without it nobody could see what a bank holds.
- **Retiring**: Active/Inactive only (§4 rule 3). **Bank** and **Cash** cannot be switched off, because every
  voucher screen draws from them. A ledger with active sub ledgers cannot be switched off. A bank account's
  own sub ledger is renamed and switched off from Account Set up, never from the chart.

### 14.2 Credit Invoice (sheet `Credit Invoice`)

The old `Ledger.` drill-down, retitled, for every supplier at once. A **credit invoice** is a cost block
(`debit_invoice_cost`) of an **issued** debit invoice: one carrier's, agent's or vendor's bill for a job.
A draft debit invoice's cost blocks are Unbilled (§14.7), not credit invoices yet.

Columns: `Vendor/Agent/Carrier Inv No` (in the code gutter) · Date · supplier (**added**: the list covers
every supplier, so it must name each) · Description · Amount (the block's currency) · Conversion Rate ·
Amount (Base Cur) · Payment Status (`Unpaid` / `Partially paid` / `Paid`, derived from payments) · Action.

- `Make Payment` → Expense, prefilled against this invoice (§14.6).
- `Edit` → the debit invoice it was recorded on, where the cost side stays editable (§3.7).
- `Delete` → soft-removes the cost block. That is exactly what removing the block on the invoice does, so it
  takes the same grant (`DEBIT_INVOICE.EDIT` + `VIEW_BUY_PRICE`). Refused once anything is paid against it.

Once a credit invoice has a payment, its supplier, currency and rate are frozen, its total cannot fall below
what was paid, and it cannot be removed. Its debit invoice cannot be cancelled while that payment stands
(`MONEY_PAID`).

### 14.3 Bank Set up and Account Set up

- **Bank Set up**: one row per **branch** of a bank (`UNIQUE(tenant, lower(bank_name), lower(branch))`),
  with the sheet's six fields.
- **Account Set up**: Account Name, Account Number, `Select Bank` then `Select Branch`. Bank Address, Swift
  No, Routing number and IBAN No are **shown from the chosen branch**, not typed again (see §14.9 Q4 on
  IBAN).
- An account and its **sub ledger under Asset → Bank** are made in one transaction. The sub ledger is named
  as on the sheet, bank plus last three digits (`Bank Asia Plc-878`), or the full number if that would
  collide. Renaming the bank or changing the number renames it. Switching the account off switches it off.

### 14.4 The four Transaction screens

| Screen | Sheet | Debit | Credit |
|---|---|---|---|
| Expense | `Expense-regular` / `Expense-Vendor` | each **Expense Category** row | **Payment from** (a Bank or Cash sub ledger) |
| Income | `Income-Other` / `Income` | **Deposit to** (Bank or Cash) | each **Income Category** row |
| Internal Transfer | `Internal Transfer` | each **Transfer To** row (Bank or Cash, not the source) | **Transfer From** |
| Journal | `Journal` | the rows as written | the rows as written |

- **Money account** ("Asset like Bank, Cash", F17) = an active sub ledger under the **Bank** or **Cash**
  ledger. The form shows each one's balance. "Transfer From (All bank account)" lists Cash too, because
  depositing cash in the bank is a transfer (§14.9 Q5).
- **Categories** are filtered to the head the sheet names: Expense Category → Expense accounts, Income
  Category → Income accounts. The Journal takes any postable account.
- **Balance**: Expense, Income and Transfer take one **Amount** for the money account and require the rows
  to add up to it. The Journal requires Total Debit = Total Credit. The form keeps Save closed while the
  Difference is not nil, the server refuses it, and a **deferred constraint trigger**
  (`journal_line_balanced`) refuses a posted voucher that does not balance at COMMIT.
- **All in the base currency.** The sheets have no currency field. What crosses currencies is the
  settlement (§14.6).
- **Journal: `Save` and `Save & agreed`.** `Save` keeps a **draft**, which moves no balance and can be edited.
  `Save & agreed` **posts** it. Writing (`CREATE`/`EDIT`) and agreeing (`APPROVE`) are separate grants.
  Expense, Income and Transfer have only `Save`, so they post at once.
- **A posted voucher is never edited.** `Cancel` needs a reason, keeps the number, takes it out of every
  balance, and takes back whatever it settled (§14.6). This answers §12 Q7: a wrong receipt is reversed by
  cancelling its Income voucher.
- **Numbers**, per workspace per kind per year: `JV-2026-000001` (Journal), `PV-` (Expense, payment
  voucher), `RV-` (Income, receipt voucher), `TV-` (Internal Transfer) — §14.9 Q6.
- `Upload file` / `Upload Payment voucher`: one attachment per voucher, stored by key.
- Each screen opens on a **list** of its vouchers (§8), with `+ New` for the sheet's form.

### 14.5 What the Expense and Income forms pre-fill

`Receive` (Debit Invoice list, the invoice, the customer's ledger) opens **Income** against that invoice.
`Make Payment` (Credit Invoice list, the invoice's cost block, the supplier's ledger) opens **Expense**
against that credit invoice. Both pre-fill:

- the party and the invoice, with its outstanding amount;
- the banked amount, at the invoice's own rate — a suggestion; the voucher records the bank's actual figure;
- one category row: **Income on Service** / **Cost of Service** for the booking's service (Sea FCL, Sea
  LCL, Air), when the invoice has a booking. This is a default the operator can change, not a rule
  (§14.9 Q3).

### 14.6 Settlements — what a voucher closes on a party's ledger

| Voucher | Against | Row written | Party balance |
|---|---|---|---|
| Income, **Income From** a customer | an issued **debit invoice** | `debit_invoice_receipt` (+ `journal_entry_id`) | receivable ↓ |
| Expense, **Pay to** a vendor / carrier / agent | a **credit invoice** | `supplier_payment` | payable ↓ |
| either | the party's **CRM opening balance** | `opening_settlement` | that side ↓ |

- `amount` on the settlement is in the **document's currency**: what comes off the invoice. The voucher's
  own figures are in the base: what the bank moved. For a base-currency document the two must be the same
  figure; otherwise their ratio is the rate the bank gave, and the form shows it.
- A settlement never exceeds what is outstanding (`OVER_RECEIVED` / `OVER_PAID`). The one that closes a
  document takes the base still open, so it nets to exactly zero (the §3.4 receipt rule, now also for
  payments).
- Receiving against a debit invoice also needs `ACCOUNTS.DEBIT_INVOICE.RECEIVE` (§6): banking income and
  saying a customer paid are separate grants.
- **The old `Receive` form is retired** (`POST /debit-invoices/:id/receipts` removed). There is now one
  way for a customer to have paid, and it moves the bank balance. Receipts recorded before today keep
  `journal_entry_id` NULL and still count.
- Opening settlements are converted at today's rate, as the opening is (§3.6), so a fully settled opening
  nets to zero. Carriers have no opening, so none is settled.

### 14.7 The Receivable-Payable list's Unbilled column

`Unbilled Amount` (F7) = money on a job whose debit invoice has **not been issued yet**:

- **Customer**: a draft debit invoice's total (its own frozen rate). For a confirmed booking on Awaiting
  Freight Inv with no invoice started, its **quoted amount**, at today's rate.
- **Carrier / agent / vendor**: the cost blocks of a draft debit invoice.

It is shown beside Receivable and Payable, never inside them. "Only open balances" counts it, the `Total =`
row adds it, and each party's ledger shows it in its totals.

### 14.8 Menu

Accounts, in the Menu sheet's order, with the client's nesting drawn as sidebar sub-headings:
Awaiting Freight Inv · Debit Invoice · Credit Invoice · Receivable-Payable list · Chart of accounts ·
**Transaction**: Journal · Expense · Income · Internal Transfer · Income Statement · Balance Sheet · Cash Flow
Statement · TA/DA · **Setting**: Bank Set up · Account Set up.

### 14.9 Schema — `20260927120000_accounts_books`

```
ledger_account       code ACC-001, account_type ENUM(ASSET,LIABILITY,EQUITY,INCOME,EXPENSE),
                     parent_id FK self (composite), name, system_key UNIQUE(tenant, system_key)
                     name unique per head (ledgers) / per ledger (sub ledgers), live rows only
bank                 code BNK-001, bank_name, branch, bank_address, swift_no, routing_no, iban_no
bank_account         code BAC-001, account_name, account_no, bank_id FK, ledger_account_id FK UNIQUE
journal_entry        code JV/PV/RV/TV-yyyy-nnnnnn, series_year, kind, entry_date, description,
                     attachment_file, status ENUM(DRAFT,POSTED,CANCELLED),
                     party_type + customer/agent/carrier/vendor_id (CHECK: exactly the one named),
                     total_amount, posted_at/by, cancelled_at/by, cancel_reason (CHECK when CANCELLED)
journal_line         journal_entry_id, ledger_account_id, debit, credit NUMERIC(18,4)
                     CHECK exactly one side positive; deferred trigger: a POSTED voucher balances
supplier_payment     journal_entry_id, debit_invoice_cost_id, payment_date, amount > 0, amount_base
opening_settlement   journal_entry_id, side ENUM(RECEIVABLE,PAYABLE), party (never CARRIER),
                     settlement_date, currency_id + code, amount > 0
debit_invoice_receipt  + journal_entry_id NULL
```

All seven tables follow §4: `tenant_id` first, composite FKs to tenant-owned parents, the tenant guard on
carrier and currency, RLS in the single-comparison form, `ff_app` without DELETE, and the audit trigger.
No existing column is changed and no row is rewritten.

**After deploy:** `pnpm db:deploy`, then `pnpm db:seed` for the new permission keys, then grant the new
features to the accounts role. The chart seeds itself.

### 14.10 Permissions — registry diff

```diff
 ACCOUNTS.NEW_CREDIT_INVOICE   'Credit Invoice'   VIEW is the list (actions unchanged)
+ACCOUNTS.CHART_OF_ACCOUNTS    'Chart of accounts'  VIEW CREATE EDIT TOGGLE_STATUS
+ACCOUNTS.JOURNAL              'Journal'            VIEW CREATE EDIT APPROVE CANCEL
+ACCOUNTS.EXPENSE              'Expense'            VIEW CREATE CANCEL
+ACCOUNTS.INCOME               'Income'             VIEW CREATE CANCEL
+ACCOUNTS.INTERNAL_TRANSFER    'Internal Transfer'  VIEW CREATE CANCEL
+ACCOUNTS.BANK_SETUP           'Bank Set up'        VIEW CREATE EDIT TOGGLE_STATUS
+ACCOUNTS.ACCOUNT_SETUP        'Account Set up'     VIEW CREATE EDIT TOGGLE_STATUS
```

No `DELETE` anywhere in Accounts (CR-002, enforced by `permissions.test.ts`). The Credit Invoice's `Delete`
rides on `DEBIT_INVOICE.EDIT` + `VIEW_BUY_PRICE` (§14.2). No `EXPORT` is declared: none is built, and an
unusable checkbox in the matrix is worse than an absent one.

### 14.11 API — `/api/tenant/accounts`

| Method | Route | Permission |
|---|---|---|
| GET / POST | `/chart` | `CHART_OF_ACCOUNTS.VIEW` / `.CREATE` |
| PATCH · POST | `/chart/:id` · `/chart/:id/toggle-status` | `.EDIT` · `.TOGGLE_STATUS` |
| GET / POST · PATCH · POST | `/banks` · `/banks/:id` · `/banks/:id/toggle-status` | `BANK_SETUP.*` |
| GET / POST · PATCH · POST | `/bank-accounts` · `/bank-accounts/:id` · `…/toggle-status` | `ACCOUNT_SETUP.*` |
| GET | `/bank-accounts/banks` | `ACCOUNT_SETUP.VIEW` — Select Bank / Branch |
| GET / POST | `/journal`, `/expense`, `/income`, `/internal-transfer` | that screen's `.VIEW` / `.CREATE` |
| GET · POST | `/<screen>/:id` · `/<screen>/:id/cancel` | `.VIEW` · `.CANCEL` |
| POST / GET | `/<screen>/:id/file` | `.CREATE` / `.VIEW` |
| PATCH · POST | `/journal/:id` · `/journal/:id/post` | `JOURNAL.EDIT` (+`APPROVE` to agree) · `JOURNAL.APPROVE` |
| GET | `/vouchers/options` | any of the four `.CREATE`, or `JOURNAL.EDIT` |
| GET | `/vouchers/open-documents`, `/vouchers/document-party` | `EXPENSE.CREATE` or `INCOME.CREATE` |
| GET | `/credit-invoices` | `NEW_CREDIT_INVOICE.VIEW` |
| DELETE | `/credit-invoices/:id` | `DEBIT_INVOICE.EDIT` + `DEBIT_INVOICE.VIEW_BUY_PRICE` |
| ~~POST~~ | ~~`/debit-invoices/:id/receipts`~~ | removed — Income (§14.6) |

### 14.12 Tests

`ledger.test.ts`, 25 cases across two workspaces built from nothing:

- the chart seeded once, extended, protected, and kept two levels deep **in the database**;
- a bank branch and account appearing as a money account;
- each of the four screens with exact balances, including a draft journal that moves nothing until agreed,
  and a clerk who may write it but not agree it;
- a posted voucher that does not balance, refused **in the database**;
- a credit invoice paid in part and then in full, with the over-payment, the delete, the re-price and the
  debit invoice cancel all refused;
- a receipt banked and then cancelled, reopening the invoice;
- an opening balance settled;
- the Unbilled column from a quoted booking and then from its draft;
- a guard on every route, and two-workspace isolation.

`accounts.test.ts` now receives through Income vouchers. `tenant-isolation.test.ts` counts 100 models.

### 14.13 Open questions — for the client

Nothing here is guessed in the schema. Each has the working default the build uses.

| # | Question | Working default |
|---|---|---|
| 1 | **Income Statement, Balance Sheet, Cash Flow Statement, TA/DA** are on the menu with no sheet. H6 on the chart also writes `Asset = Liabilities - Owner's Equity`; the accounting identity is Assets = Liabilities **+** Owner's Equity. | Not built. The books now hold everything they need; they wait on a layout, and the H6 sign needs confirming. |
| 2 | **Should a debit invoice post to the books when it is issued** (accrual: receivable and income on issue, payable and cost of service for its suppliers)? | No. Invoices are the party ledgers, and the vouchers are the books, as the Expense-Vendor and Income sheets draw them (§14.0). |
| 3 | **Which category does money against an invoice belong to?** | Pre-selected from the booking's service (Sea FCL / LCL / Air) under Cost of Service / Income on Service; the operator can change it. |
| 4 | **IBAN is on Bank Set up**, but an IBAN identifies an account, not a branch. | As drawn: kept on the bank row and shown on Account Set up. |
| 5 | **Transfer From "(All bank account)"** — does that exclude Cash? | Cash is included, so depositing cash in the bank is a transfer. |
| 6 | **Voucher numbers.** Only `PL-001` was ever given (CLAUDE.md §11 item 4). | `JV-` / `PV-` / `RV-` / `TV-2026-000001`, per workspace per kind per year. |
| 7 | **"Cash short or less"** (B50) — "Cash short or over"? | Seeded as written. |
| 8 | **Paying a supplier without an invoice** (an advance), or **receiving from an agent** (`agent_owe`) — neither sheet shows it. | Not offered. Pay to and Income From settle an invoice or the CRM opening balance. A Journal can record anything else. |
| 9 | **Bank accounts in a foreign currency** (a USD account). Account Set up has no currency. | Every account is kept in the base. A USD receipt is banked at its base value, and the dollar amount is recorded on the invoice it settles. |

### 14.14 Customer and vendor openings: the agent's two columns (client, 2026-09-27)

**The request.** "On the agent we have We owe (Dr) and Agent owe (Cr) inputs, that's why we get proper
result in the Receivable-Payable list. Add these two fields to the customer and vendor, and remove the
opening balance inputs."

**Why the single figure gave the wrong result.** Customer and vendor held one signed Opening Balance:
positive meant "owed to us", negative "we owe them". A payable typed the natural way, as a positive
number, therefore landed on the **receivable** side. Two columns that each name their side cannot be
entered backwards. They also let a party owe on one account while being owed on another, which one
figure cannot express.

| Party | Before | After (migration `20260927140000_customer_vendor_we_owe_they_owe`) |
|---|---|---|
| Customer | `opening_balance` (signed) | `we_owe` — **We owe (Dr)** · `customer_owe` — **Customer owe (Cr)** |
| Vendor | `opening_balance` (signed) | `we_owe` — **We owe (Dr)** · `vendor_owe` — **Vendor owe (Cr)** |
| Agent | `we_owe` · `agent_owe` | unchanged |

- One currency for both figures (`opening_currency_id`, unchanged). The database refuses a figure without
  one (`*_opening_needs_currency`) and refuses a negative figure (`*_opening_not_negative`).
- **Existing figures moved by the rule they were entered under.** A positive balance became *owe us*,
  a negative one became *we owe*, and a zero became neither. Every balance reads exactly as it did before
  the migration. Where a figure was entered with the wrong sign — a vendor payable typed as a positive
  number — the operator corrects it now, in the field that names the side. Nothing was guessed.
- `opening_balance` is dropped once its figures are copied. No view depended on it.
- Settling an opening (§14.6) is unchanged: Expense pays what *we owe* a vendor, carrier or agent, and
  Income receives what a *customer owes*. A vendor's or agent's *owe us* figure, and what we owe a
  customer, are still recorded by Journal (§14.13 Q8).
