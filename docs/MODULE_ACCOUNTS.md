# MODULE SPEC — ACCOUNTS: AWAITING FREIGHT INV · DEBIT INVOICE · RECEIVABLE-PAYABLE — **v1, transcribed from `Design.xlsx`**

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
| `Ledger.` | One party's ledger (`Ledger - CMA`) — the list's drill-down | read-only view built; `Make Payment`, `Edit`, `Delete` are §12 Q9 |
| `Chart of accounts` | Accounts → Chart of accounts | not built — next phase |
| `Journal` | Accounts → Transaction → Journal | not built — next phase |
| `Expense-Vendor`, `Expense-regular` | Accounts → Transaction → Expense | not built — next phase |

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
`SO_SKIPPED`, `PART_RECEIVED`, `CARGO_RECEIVED`, `ADVISED`, `BL_DRAFTED` or `SHORT_CLOSED` — and has no
`ISSUED` freight invoice. Not yet confirmed (`BOOKING_RECEIVED`, `VESSEL_PROPOSED`), `REJECTED` and
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

`Receivable` for a customer = their issued invoices − what has been received against them, plus the
opening balance from CRM. `Payable` to a carrier, agent or vendor = the cost blocks of issued invoices,
plus the opening balance. Computed on read, not written to a second table: while nothing else posts
to a party (no payment screen yet, §12 Q9), a posting table would be a copy that can only drift from
the documents it copies. When Journal and Expense land, they get a ledger table and these documents
post into it.

Openings follow the CRM fields' own signs: customer and vendor `opening_balance` is signed — positive
is owed to us (receivable), negative is owed by us (payable). The agent's `agent_owe` is receivable and
`we_owe` is payable. Carriers have no opening balance. Openings are converted at today's rate, because
nothing froze one.

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
- `CANCELLED` — reason mandatory, read-only, number kept forever. Refused once money has been
  received (there is no receipt reversal yet — §12 Q7). Cancelling a freight invoice returns its
  booking to the awaiting list.

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
| POST | `/debit-invoices/:id/receipts` | `.RECEIVE` |
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
| 7 | **A receipt entered in error** — reversal, or delete? Neither is on the sheet. | Not built; a receipt is final for now |
| 8 | **`Receive` form** shows `Invoice Amount` and `Payment Date` only. Part payments are implied by the Ledger sheet's `Partial Paid`. | An `Amount received` field, defaulting to the outstanding balance |
| 9 | **Paying a supplier.** `Make Payment` on the Ledger sheet and the Expense sheets. | Next phase, with Chart of accounts and Journal — payables accumulate until then |
