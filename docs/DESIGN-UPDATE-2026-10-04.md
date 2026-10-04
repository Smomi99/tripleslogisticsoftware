# DESIGN UPDATE — 2026-10-04: MILESTONES · PRE-ALERT · IGM · DO · TARIFF · LOCAL SALES · NOTIFICATION · PROFITABILITY · INCOME STATEMENT · REPORTS

> **How to use.** This is the transcription of the client's `Design.xlsx` delivery of 2026-10-04,
> mapped onto what the code already holds. Nothing here is built yet. Each section becomes one build
> session, in the order of §1, and starts with:
> *"Read CLAUDE.md, then /docs/DESIGN-UPDATE-2026-10-04.md §N."*
> Every field below comes from a sheet cell. What no sheet answers is in §11 with the default the build
> would use. Nothing in §11 goes into the schema until it is answered or the default is accepted.

---

## 0. SOURCE — WHAT ARRIVED

`docs/Design.xlsx` went from 68 sheets to 83. Apart from `Menu`, every existing sheet is byte-for-byte
unchanged. These 15 sheets are new:

| Sheet | Screen | Menu | Section |
|---|---|---|---|
| `Depart-Arrival Landing page` | Depart-Arrive Confirmation (six tiles) | Customer Service F10 | §2 |
| `Onboard confirmation-Sea`, `Onboard confirmation-Air` | On board confirmation | (landing tile) | §2 |
| `Trasnshipment con-sea`, `Trasnshipment con-air` | Transshipment confirmation | (landing tile) | §2 |
| `Arrival-Sea`, `Arrival-Air` | Arrival confirmation | (landing tile) | §2 |
| `Pre Alert-Sea` | Pre-Alert | Customer Service F11 | §3 |
| `IGM Update` | IGM submission (inbound only) | Operation I7 | §4.1 |
| `DO issue` | DO Issue (inbound only) | Operation I8 | §4.2 |
| `Tarrif` | Tariff | Purchase B13 (under Price List) | §5 |
| `Notification` | Notification | Setting P11 | §7 |
| `Shipment Profitabilit` | Shipment Profitability | Accounts M14 | §8 |
| `Income statement` | Income statement | Accounts M13 | §9 |
| `Report` | Report catalogue + CEO dashboard | Report (column T) | §10 |

**`Local Sales` is not new.** The sheet and its menu entry (Sales & Marketing D9) were in the previous
file unchanged. They were never specified or built, so §6 covers them here.

### 0.1 Menu changes

```
Customer Service, before              Customer Service, after
- On board confirmation               - Depart-Arrive Confirmation   (one landing page, six tiles)
- Transshipment Confirmation          Pre-Alert
- Arrival confirmation

Purchase → Price List: + "- Tarrif"   (B13)
Accounts: + "Shipment Profitability"  (M14, after Income statement)
Setting:  + "Notification"            (P11; a Settings → Notification screen already exists, §7)

Customer portal column (W), before    after
Shipment Booking                      Shipment Booking-Sea · Shipment Booking-Air
Shipment status                       BL Submission-Sea · BL Submission-Air
Financial Statement                   Shipment status · Financial Statement
```

The customer-portal change is outside this document's scope. It is recorded here so it is not lost.

### 0.2 The Steps table (Menu B33–G50) now governs these screens

| Step | Outbound | Inbound | Remark |
|---|---|---|---|
| On board confirmation | Yes | Yes | |
| Transhipment confirmation | Yes | Yes | *"If indirect vessel"* |
| Arrival confirmation | Yes | Yes | |
| IGM update | Skip | Yes | |
| DO issue | Skip | Yes | |

Direction is already known. It is `quotation.movement_type` (`INBOUND` / `OUTBOUND`), and the
shipment reaches it through `shipment.quotation_id`.

---

## 1. BUILD ORDER (recommendation)

| # | Session | Why this position | Blocked by §11? |
|---|---|---|---|
| 1 | **§8 Shipment Profitability** — **built** | Reads only data that exists: debit invoice revenue and cost. Smallest, highest value. | Q20 (status column) and Q27 (export) have defaults in place |
| 2 | **§2 Depart-Arrive Confirmation** — **built** | Core workflow. The BL's laden-on-board date and the arrival notice depend on it. | Q1–Q6 |
| 3 | **§4 IGM Update + DO Issue** — **built** | Inbound tail of the same milestone track; reuses §2's list. | Q10–Q13 |
| 4 | **§7 Notification** (per-team sender) — **built** (new event letters wait on Q17) | §2, §3 and §4 send mail from named team addresses. | Q16–Q17 |
| 5 | **§3 Pre-Alert** — **built** | Needs §7's Sales Team sender and documents that partly do not exist. | Q7–Q9 |
| 6 | **§5 Tariff** — **built** | Master data only until Q14 says what consumes it. | Q14–Q15 |
| 7 | **§6 Local Sales** — **built** | Customer list + activity log. | Q18–Q19 |
| 8 | **§9 Income Statement** | **Blocked** on an accounting decision (Q21) that also decides Balance Sheet and Cash Flow. | Q21–Q25 |
| 9 | **§10 Reports** | A catalogue of ~70 reports with no layouts. The client has to pick a first set. | Q26 |

---

## 2. DEPART-ARRIVE CONFIRMATION (Customer Service) — **built**

### 2.1 Screens

`Depart-Arrival Landing page` E3 *"Departure -Transshipment -Arrival confirmation"*, with six tiles
(B6–N6): **On board confirmation-Sea · On board confirmation-Air · Transshipment Confirmation-Sea ·
Transshipment Confirmation-Air · Arrival-Sea · Arrival-Air**. Each tile opens a list. Each list has
`Search`, an `Action` column with a status selector and `Save`, and `back to landing` / `back to list`.

| Screen | Columns (row 6) | Date column | Status values |
|---|---|---|---|
| On board-Sea | Quotation NO · Booking NO · S/O NO · Customer · Exporter · Shipment Type · POL · POD · Carrier · Container no · Seal · **1st Leg vsl** · **ETD** · Action | ETD | Awaiting · Departed |
| On board-Air | Quotation NO · Booking NO · S/O NO · Customer · Exporter · Shipment Type · AOL · AOD · Airline · **1st Leg Flight No** · **ETD** · Action | ETD | Awaiting · Departed |
| Transshipment-Sea | … · Container no · Seal · **2nd Leg vsl** · **ETD** · Action | ETD | Awaiting · Departed |
| Transshipment-Air | … · Airline · **2nd Leg Flight No** · **ETD** · Action | ETD | Awaiting · Departed |
| Arrival-Sea | … · Container no · Seal · **Last Leg vsl** · **ETA** · Action | ETA | Awaiting · Arrived |
| Arrival-Air | … · Airlines · **Last Leg flight** · **ETA** · Action | ETA | Awaiting · Arrived |

(`Arrival-Sea` H3 reads *"Arrival -Air"*, a copy slip. The columns are sea.)

### 2.2 Rules, from the sheet notes

On board (Sea M15–M20, Air K15–K20):
1. *"This date pull from shipment advise."* The ETD is pre-filled from `shipment_advise.etd`.
2. *"If vsl delay or advance sailed then change the date and select Departed."*
3. *"This date will finally pull to BL as on board date"* (Air: *"to HAWB"*). Confirming Departed
   writes `bl_draft.laden_on_board_date`. That column already exists.
4. *"An email will automatically send to customer email"*, *"sender email from tsl.doc@triplesbd.com"*.
   That is the CS & Doc Team sender (§7).
5. *"A reason of delay / advance sail will write to inform customer."* A reason is required when the
   confirmed date differs from the pulled one, and it goes into the email.

Transshipment (Sea M15): *"There is no transhipment confirmation for direct vsl."* Only bookings whose
advise has `transit_type = INDIRECT` appear. The rest are rules 1, 2, 4 and 5.

Arrival (Sea N19–N21, Air K15):
6. *"This is the final date of arrival which will update at least 3 days before arrival"* (Air: 1 day).
7. *"An email will automatically send to importer email."*
8. *"Container number, Seal, Size and Last leg vessel name will be in the email."*

### 2.3 Where every column already lives

| Column | Source |
|---|---|
| Quotation NO | `shipment.quotation → quotation.code` |
| Booking NO | `shipment.code` |
| S/O NO | `shipping_order.code` (blank on inbound, which skips the S/O) |
| Customer · Exporter | `shipment.customer` · `shipment.exporter_name` |
| Shipment Type · POL/AOL · POD/AOD | `shipment.shipment_type` · `shipment_advise.pol_id` / `pod_id` |
| Carrier / Airline | `shipment_advise.carrier_id` |
| Container no · Seal | `clp.container_no` · `clp.seal_no`. **One row per container**, so a booking that was stuffed into two containers shows twice (Q2) |
| 1st Leg vsl / Flight No | `shipment_advise.first_vessel_id` / `first_flight_no` |
| 2nd / Last Leg vsl / flight, their ETD / ETA | `shipment_schedule_leg` of the advise's schedule, `leg_no` 2 and the highest `leg_no` |
| ETD (1st leg) · ETA | `shipment_advise.etd` · `shipment_advise.eta` |

### 2.4 What is new in the schema (proposal, for review before migration)

One table, rather than three more `shipment_status` values. The milestones run alongside the document
chain rather than after it: Departed has to happen *before* BL Print, because it supplies the BL's
on-board date. A single linear status cannot say "BL drafted **and** departed".

```
shipment_milestone                      (client: Onboard / Transshipment / Arrival confirmation)
  tenant_id, id, shipment_id FK,
  kind ENUM('DEPARTED','TRANSSHIPPED','ARRIVED'),
  leg_no INT                            -- 1 for DEPARTED, 2 for TRANSSHIPPED, last for ARRIVED
  pulled_date timestamptz               -- what the advise / schedule said, frozen at confirmation
  confirmed_date timestamptz            -- what the operator saved
  status ENUM('AWAITING','CONFIRMED')   -- the sheet's Awaiting / Departed / Arrived
  change_reason text                    -- required when confirmed_date ≠ pulled_date (rule 5)
  email_log_id BIGINT                   -- the notice that went, as shipment_advise.email_log_id
  confirmed_by, confirmed_at, + §4 standard columns
  UNIQUE (tenant_id, shipment_id, kind, leg_no)
```

Rows are created on Save, not pre-seeded. "Awaiting" means that no confirmed row exists for that
shipment and kind yet. `shipment.status` is not touched (Q4). Affected existing tables: `bl_draft`,
written (laden-on-board date), not altered.

**Permission:** one feature, `CUSTOMER_SERVICE.DEPART_ARRIVE` (VIEW · EDIT), for the landing page and
all six lists. Three features is the alternative (Q5).

### 2.5 As built (branch `feature/depart-arrive`)

Migration `20261004100000_shipment_milestone`: the table above without `leg_no` (the kind fixes the
leg) and without `status` (a row exists only once confirmed). Dates are `DATE`, read in the
workspace's time zone. Template keys: `SHIPMENT_DEPARTED`, `SHIPMENT_TRANSSHIPPED`,
`SHIPMENT_ARRIVED`, seeded and editable.

- **Who is listed.** Every booking that is not cancelled or rejected and has a live advise or an
  approved schedule. The legs come from the advise's schedule, or from the approved schedule before an
  advise exists, which is how inbound bookings reach these screens. Transshipment lists indirect routes
  with a second leg. Transshipment and Arrival list a booking only once its **departure is
  confirmed**. The API refuses them before that (`DEPARTURE_FIRST`).
- **Each list** has Awaiting (the worklist, soonest first), Confirmed and All views, search
  (booking, quotation, customer, exporter), and sorting by date, booking or customer. The landing tiles
  show the awaiting count.
- **Confirming.** The date opens on the pulled date, and saving creates the row. Saving again
  **corrects** it: the date first pulled stays frozen, and the customer can be told again.
  - Departure and transshipment need a reason when the date differs from the pulled one, and cannot be
    a future date. An arrival is confirmed ahead of time and takes an optional note.
  - The legs stay in order: no arrival before its departure, and no departure moved past a confirmed
    arrival.
- **The notice** goes to the customer's contacts that have an email (Q1, Q3 defaults). An
  "Email the customer" box, ticked by default, lets a correction go without a second letter. The
  arrival notice lists container, size and seal (N21). It is sent from the workspace's sender until §7
  gives the CS & Doc Team its own.
- **BL on-board date.** Departed writes `laden_on_board_date` on every BL draft for the booking that
  is not cancelled and **not issued**. An issued original is never rewritten. A BL draft started after
  departure opens with the date. Air has no HAWB document yet, so it has nothing to write.
- Tests: `milestone.test.ts`, 10 cases, including two-workspace isolation.

---

## 3. PRE-ALERT (Customer Service) — **built**

`Pre Alert-Sea`: the list columns are §2.1's On board-Sea columns, plus **Status** (O7 *"Awiting"*) and
**Action** `Send`. `Send` opens:

- **Select Documents** (C15), checkboxes: Booking confirmation · HBL · MBL · HAWB · MAWB ·
  Manifest-Air · Dbite Note
- **Select Agent** (C25) · **Email ID** (C27) · `Send` (D28)
- I20: *"An email will send from tsl.sales1@triplesbd.com"*. That is the Sales Team sender (§7), whose
  "Applicable for" is *"(1) Pre-Alert"*.

There is only a Sea sheet, but the document list names HAWB, MAWB and Manifest-Air. One screen covers
both modes, and the checklist offers only the documents that fit the mode.

**What each document is in the code today:**

| Document | Exists? |
|---|---|
| HBL / HAWB | Yes, the BL Print PDF (outbound sea). Air has no HAWB print yet. |
| Debit Note | Yes, the debit invoice PDF (`DEBIT_INVOICE_SENT` already attaches it). |
| Booking confirmation | **No.** No document by that name is generated (Q7). |
| MBL · MAWB · Manifest-Air | **No.** They come from the carrier or airline. They would be uploads (Q8). |

There is no link from a shipment to an agent. The agent is picked from CRM → Agent, and Email ID is
pre-filled from that agent's PICs and stays editable. New email template: `PRE_ALERT_SENT`.

### 3.1 As built (branch `feature/pre-alert`)

Migration `20261004160000_pre_alert`. Permission `CUSTOMER_SERVICE.PRE_ALERT`: VIEW, EDIT (upload) and
SEND.

- **List.** OUTBOUND bookings that have a live advise or an approved schedule (Q9 default), with the On
  board columns, a Sea / Air switch, Awaiting / Sent / All views, and the last send with its agent.
- **Documents** (`pre_alert_document`, one live file per booking per kind). Each mode is offered its
  own: sea gets Booking confirmation · HBL · MBL · Debit Note; air gets Booking confirmation · HAWB ·
  MAWB · Manifest-Air · Debit Note. An upload always wins.
  - **HBL:** a non-negotiable copy of the approved bill (BL Print's COPY), drawn at send time.
  - **Debit Note:** the freight invoice's stored PDF, as it was sent to the customer.
  - **Booking confirmation, MBL, HAWB, MAWB and Manifest-Air:** uploads only. **Q7 changed:** read in
    freight terms, "Booking confirmation" is the carrier's booking confirmation, which the system does
    not make, so it is an upload too.
- **Send.** "Select agent" lists the agents covering the booking's POD first. Email ID fills from that
  agent's contacts and stays editable. Ticked documents that are not there refuse the send and name
  themselves.
  - Each send is kept (`pre_alert`), so a resend sits beside the first.
  - The letter (`PRE_ALERT_SENT`, seeded) states the booking, shipper, consignee, vessel or flight,
    ETD/ETA, HBL/MBL and containers, with the documents attached. It goes from the **Sales Team**
    identity (§7).
- Tests: `pre-alert.test.ts`, 7 cases, including two-workspace isolation.

---

## 4. OPERATION — INBOUND ONLY — **built**

Both lists show only bookings whose quotation is `INBOUND`. Their columns are §2.1's Arrival-Sea
columns (Last Leg vsl, ETA).

### 4.1 IGM Update (`IGM Update`)

K3 *"IGM Update ( Inbound shipment only)"*. Action O7: *"/Awaiting/ Updated"* + `Save`.
Detail L14–M16: **HBL NO** · **Upload IGM file** *"(pdf.jpg )"*.

- An inbound booking has no HBL in the system (inbound skips BL Draft & Print, Menu F44). The HBL No is
  typed here (Q10).
- The file goes to storage like every other upload, and only the key is stored.
- The menu calls it *IGM submission*; the sheet and the Steps table call it *IGM update*. The existing
  permission key `OPERATION.IGM_SUBMISSION` stays. The sidebar keeps the menu's name, and the screen
  is titled "IGM Update".

```
igm_update        (client: IGM Update)
  tenant_id, id, code, shipment_id FK UNIQUE per tenant, hbl_no, igm_file (storage key),
  status ENUM('AWAITING','UPDATED'), + §4 standard columns
```

### 4.2 DO Issue (`DO issue`)

K3 *"DO ISSUE ( Inbound shipment only )"*. Action O7 `ISSUE DO` opens a letter:

```
DATE
TO
TERMINAL MANAGER
CHITTAGONG PORT AUTHORITY
CHITTAGONG
SUBJECT :
…
CONTAINER NO
```

The sheet gives the letter's frame and nothing else. The subject, the body, the DO number and whom it
releases the cargo to are all missing, and the addressee is fixed to Chittagong (Q11–Q13). The existing
permission key `OPERATION.DO_ISSUE` stays.

### 4.3 As built (branch `feature/igm-do`)

Migration `20261004120000_igm_update_and_delivery_order`. **Q11 and Q12 were built differently from the
defaults first written**: rather than leave DO Issue unbuilt, the letter's frame is built and the
operator writes the words.

- **Lists.** Both screens list INBOUND bookings that are not cancelled or rejected and have an approved
  schedule or an advise. They have a Sea / Air switch, Awaiting / Updated (or Issued) / All views,
  search, and the Arrival sheet's columns: last leg, ETA, containers and seals. They do not wait for a
  confirmed departure; an inbound departure is the overseas agent's to report.
- **IGM.** `igm_update`: the HBL No and the file's storage key, with no `code` and no status column.
  The booking reads **Updated** once the file is in. Saving the HBL alone keeps it Awaiting. The first
  save needs `CREATE`, changing it needs `EDIT`, and a replaced file is removed from storage after the
  row points at the new one. The file downloads from the list.
- **DO.** `delivery_order`: numbered **DO-2026-000001** per workspace per year. A cancelled order's
  number is never reused (the debit invoice's rule). The fields:
  - **Date** (today by default) and **To**. Sea opens on the sheet's *TERMINAL MANAGER / CHITTAGONG
    PORT AUTHORITY / CHITTAGONG*, which the operator edits for other ports. Air opens blank.
  - **Subject** (required) and **Letter** (optional): the operator's own words.
  - **Container no**, from the finalised load plans.
- **Rules.** Issuing needs the IGM file (`IGM_FIRST`, the Q13 default). Payment is not checked. There
  is one issued order per booking: a wrong one is **cancelled with a reason** (`TOGGLE_STATUS`) and
  issued again.
- **The printed letter** carries the letterhead, DO No, the sheet's DATE / TO / SUBJECT / CONTAINER NO
  layout and a "For <company>" signature line. It is stored when issued, so a reprint is the letter
  that went (`EXPORT`).
- Tests: `inbound.test.ts`, 8 cases, including two-workspace isolation.

---

## 5. TARIFF (Purchase → Price List) — **built**

`Tarrif`, header row 4: **Country · POL · Movement Type · Tarrif Type**. H5 reads
*"Port Tarrif , CFS Charge"*, taken as the two Tariff Type values. Line grid (rows 8 and 12):
**Cost Head · Container Size · Unit · Unit Price · Currency**, `Add`, then `Save`.

```
tariff               (client: Tarrif)
  tenant_id, id, code, country, pol_id FK → port, movement_type (existing enum),
  tariff_type_id FK → tariff_type lookup (seeded: Port Tariff, CFS Charge), + standard columns
tariff_line
  tenant_id, id, tariff_id FK, cost_head_id FK, container_size_id FK (nullable — Q15),
  cost_unit_id FK, unit_price NUMERIC(18,4), currency_id FK, + standard columns
```

`Country` is redundant with the POL's country. It is kept because the sheet lists it, and it is filled
from the port. The sheet does not say what reads a tariff (Q14). Until that is answered, this is a
price book with its own list and form, and nothing else consumes it.

### 5.1 As built (branch `feature/tariff`)

Migration `20261004180000_tariff`. Permission `PURCHASE.TARIFF`: VIEW · CREATE · EDIT · TOGGLE_STATUS.
The sidebar groups the three price lists and Tariff under **Price List**, as Menu B9–B13 does.

- **Tariff type is an enum** (`PORT_TARIFF`, `CFS_CHARGE`), not the lookup proposed above. The sheet
  names exactly two values, and a Setting lookup with shared rows, overrides and its own screen is a
  large build for two. When the client names a third, it becomes a lookup with a one-step data
  migration (Q28).
- **List.** Code (TRF-001) · Country · POL · Movement Type · Tariff Type · Charges · Status. Search
  covers code, port name and code, and country, with Movement, Type and Active filters. The actions are
  Edit and Deactivate/Activate (confirmed).
- **Form** (a page, per §8: a header and a grid is more than eight fields).
  - The header is POL, Movement Type and Tariff Type. Country follows the POL and is stored with it.
  - The grid is Cost Head · Container Size (optional) · Unit · Unit Price · Currency, with add and
    remove.
  - Saving **replaces** the charges: the old lines are retired, not edited, so the audit trail keeps
    them.
  - Every picked row must be one the workspace can use and has not switched off. The API asks again
    on save. Prices are non-negative (CHECK).
- No uniqueness per POL / movement / type, since none was asked for. Nothing reads a tariff yet (Q14).
- Tests: `tariff.test.ts`, 5 cases, including two-workspace isolation.

---

## 6. LOCAL SALES (Sales & Marketing) — **built**

`Local Sales` R7 says *"Table_Customer"*. This is a view over `customer`, not a new party table.

- **List** (row 6): SL NO · Customer Name · Country · Address · Customer Type · Commodity Category ·
  Business Area · Ex-Sea Volume (TEUs)/Month · EX-Air Volume (KG)/Month · IM-Sea Volume (TEUs)/Month ·
  IM-Air Volume (KG)/Month · **Opening Balance** · **Currency** · Action (`Edit | Inactive | Active`,
  `ADD PIC`). All of these exist on `customer`.
- J13: *"Opening Balance and Currency will be use during make the accounts ledger"*. This is already
  built. Since 2026-09-27 the customer's opening is two columns, *We owe (Dr)* and *Customer owe (Cr)*
  (MODULE_ACCOUNTS §14.14), and the list shows both.
- **Activity Log** (C13–H17), the new part. Each row: **Date & time · PIC · Meeting Summary · Next
  Follow up Dt · Competitors Analysis · Business Possibility** and `Record`.

```
customer_activity    (client: Local Sales → Activity Log)
  tenant_id, id, customer_id FK, activity_at timestamptz, customer_pic_id FK,
  meeting_summary text, next_followup_date date, competitor_analysis text,
  business_possibility text (Q19), + standard columns
```

This sits close to Sales Lead Follow-up, whose rows are date, contact mode, person, notes and next
date. It is not the same: a lead is not yet a customer, and this log has competitor and possibility
columns. Q18 asks whether Local Sales lists every customer or a subset.

### 6.1 As built (branch `feature/local-sales`)

Migration `20261004200000_customer_activity`. Permission `SALES.LOCAL_SALES`: VIEW, and CREATE (the
sheet's Record).

- **List**: every customer (Q18 default), with the sheet's columns. Opening Balance shows both of the
  customer's figures, "owes us" and "we owe", in their currency. Activity shows the count, the last
  date and the next follow-up still ahead. Search covers name, code, country and category, with Customer
  Type, Business Area and Active filters.
- **Actions.** *Activity log* opens the log. *Edit* and *PIC* go to CRM → Customer, and appear only to
  users who hold those CRM permissions. The customer is still edited in one place.
- **Activity Log** (`customer_activity`): the fields are Date & time · PIC · Meeting Summary · Next
  Follow up Dt · Competitors Analysis · Business Possibility (free text, Q19), recorded newest first.
  The PIC must be one of *that* customer's contacts; the API checks this, and so does a trigger.
- Tests: `local-sales.test.ts`, 4 cases, including two-workspace isolation.

---

## 7. NOTIFICATION (Setting) — **team identities built; new event letters not built**

### 7.1 What the sheet asks for

Five teams. Each has "Applicable for" events, a **Sender Email ID**, a **Reply to** and an **Email
Signature**:

| Team | Applicable for | Sender = Reply to |
|---|---|---|
| Price Team | (1) Price request email to carrier, Agent, Vendor · (2) Quotation send to Customer | tsl.pricing@ |
| CS & Doc Team | (1) Booking Received · (2) Shipment Approval · (3) Shipping order · (4) Shipment Advice · (5) BL draft | tsl.doc@ |
| Ops Team | (1) Cargo Receipt · (2) Stuffing | tsl.ops@ |
| Accounts Team | (1) Payment Received · (2) Debit Invoice Send · (3) Payment Send | accounts@ |
| Sales Team | (1) Pre-Alert | tsl.sales1@ |

It also has an email draft per event. Only two have body text: *Price request* (*"Dear Sir / Madam — You
are requested to quote your best price for below shipment."*) and *Quotation send* (*"We are pleased to
offer our best price as below :"*). The rest are titles only: Booking Received, Shipment approval,
Shipping order, Shipment Advise, Cargo receipt, Stuffing, Debit Invoice, Payment received, Payment remit,
Pre-Alert.

The §2 sheets add Departed, Transshipped and Arrived notices from tsl.doc@, which puts them on the CS &
Doc Team.

### 7.2 What already exists

- **Settings → Notification** (`notification_setting`, one row per workspace): Price team emails, one
  signature block, BCC addresses, quotation notes.
- **`email_template`** rows the API sends today: `INQUIRY_AGENT_RFQ`, `INQUIRY_CARRIER_RFQ`,
  `INQUIRY_PRICE_TEAM`, `CUSTOMER_PRICE_OFFER`, `QUOTATION_SENT`, `SHIPMENT_SCHEDULE_PROPOSED`,
  `SHIPMENT_APPROVAL_DECIDED`, `SHIPMENT_ADVISE_SENT`, `BL_DRAFT_SENT`, `DEBIT_INVOICE_SENT`,
  `AGENT_QUOTE_SUBMITTED`.
- **`email_log`** already records `reply_to_addresses` per message.
- The **From** address is one per deployment (`MAIL_FROM` env).

### 7.3 Gaps

1. **A sender identity per team**: sender address, reply-to and signature, plus the event → team
   mapping. New table `notification_team` (team ENUM, sender_email, reply_to, signature), and each
   template key maps to a team.
2. **New templates**: Booking Received, Shipping Order, Cargo Receipt, Stuffing, Payment Received,
   Payment Send/Remit, Pre-Alert, and the three §2 notices. Each one is wired to the event that fires
   it.
3. **Sending as five addresses** needs an SMTP account that may send as each of them, which means
   domain authorisation at the client's mail host. On a SaaS this is also per tenant (Q16).
   Working default: send from the platform sender with **the team's address as Reply-To and its name
   as the display name**. Send-as goes on only when a tenant's SMTP allows it.

The sample signatures carry real staff names (Tanjila Sathi, Saifuddin Shamim, Jisan). They are typed
on the screen by the tenant and are never seeded.

### 7.4 As built (branch `feature/notification-teams`)

Migration `20261004140000_notification_teams`.

- **Settings → Notification → Teams.** Five blocks in the sheet's order, each showing what the team
  sends (the sheet's "Applicable for"), with **Sender email**, **Reply to** and **Email signature**.
  Above them is one switch, **"Our mail server may send as these addresses"**, off by default.
  Nothing is seeded; the sheet's sample signatures name real staff.
- **What a letter does with it** (`TEMPLATE_TEAM` in `@ff/shared`; the outbox resolves the team at
  queue time and records the result on `email_log`, like Reply-To and BCC):
  - **Price:** agent/carrier RFQ, quotation, customer price email.
  - **CS & Doc:** schedule for approval, shipment advise, BL draft, departed/transshipped/arrived.
  - **Accounts:** debit invoice.
  - **Sales:** pre-alert.
  - Internal alerts (price-team note, agent quote, approval decision) keep the workspace sender.
- **With the switch off** (Q16 default), the From stays the deployment's account, under the
  workspace's name. Replies go to the team's Reply-to, or to its sender address when that is blank.
  The team signature is added under the letter. The customer price email already signs itself, so it
  gets no second signature, and a Reply-To chosen by the caller wins.
- **With the switch on**, the From becomes the team's sender address.
- A team left blank changes nothing: every letter goes exactly as before.
- **Not built (§7.3 gap 2):** the letters the sheet names that the product does not send yet: booking
  received, shipping order, cargo receipt, stuffing, payment received and payment sent. Each would
  start emailing customers from an existing screen. Only titles were supplied (Q17), so they wait
  for the client's wording and a yes per letter. They join their team in `TEMPLATE_TEAM` when built.
- Tests: 5 cases in `email-queue.test.ts` (signature, reply-to, send-as, a caller's reply-to, a
  self-signed letter, internal alerts, two workspaces) and 3 in `notification-team.route.test.ts`.

---

## 8. SHIPMENT PROFITABILITY (Accounts) — **built**

`Shipment Profitabilit` row 6: **Quotation No · Booking No · BL No · Customer · Mode · Route (POL-POD) ·
Revenue · Cost · GP · GP % · Status**.

The sample rows confirm GP = Revenue − Cost and **GP % = GP ÷ Revenue**:
10200 − 8925 = 1275 → 12.5 %; 5800 − 4100 = 1700 → 29.3 %; 8500 − 7950 = 550 → 6.5 %;
7200 − 7650 = −450 → −6.3 %. A loss row is expected and must render as one (`--alert`).

| Column | Source |
|---|---|
| Revenue | Σ `debit_invoice.total_amount_base` over the booking's **ISSUED** invoices: the freight invoice and any OTHER invoice that names the booking. Drafts and cancelled invoices are excluded |
| Cost | Σ `debit_invoice.cost_total_base` over the same invoices, the figure Debit Invoice already derives its GP from |
| GP · GP % | Derived, never stored (MODULE_ACCOUNTS §3.4). GP % to one decimal place; blank when revenue is 0 |
| BL No | The live advise's `house_bl_no` (HBL/HAWB, via `shipment_advise_booking`, CR-005). Blank until advised |
| Mode | `shipment.loading_type` / `shipment_type`: FCL · LCL · Consol Box · Air |
| Route | POL code – POD code |
| Status | The booking's own status (Q20 default) |

**As built** (branch `feature/shipment-profitability`):

- **No schema change, no migration.** The permission row `ACCOUNTS.SHIPMENT_PROFITABILITY.VIEW` arrives
  with `db:seed`, as every release's do. Amounts are in base currency (BDT).
- **Cost is privileged.** The route requires `ACCOUNTS.SHIPMENT_PROFITABILITY.VIEW` **and**
  `ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE`, the split §3.9 already makes. The sidebar and the page gate ask
  for both as well (`ALSO_REQUIRES` in `nav-config.ts`), so nobody is shown a menu item that opens onto
  a refusal.
- **List behaviour**: search (booking, quotation, customer, BL No), Mode filter, sort on Customer and the
  four figures, pagination, and a totals strip across the whole filtered list. Total GP % is total GP
  over total revenue, not an average of the rows.
- **Date filter** ("Invoiced from / to"): applies to the booking's **first** issued invoice date, which
  is when the job was billed. A booking billed in February with a further invoice in March sits in
  February, with both invoices counted. The sheet draws no filter. Without one, the list is unusable
  after a year.
- A booking with no issued invoice is left out, because it has billed nothing.
- **No export** (Q27). The action is not registered, so no unusable checkbox appears in the matrix.
- Code: `apps/api/src/lib/shipment-profitability.ts` (the SQL), the route at the end of
  `accounts.route.ts`, `apps/web/src/app/(app)/accounts/shipment-profitability/page.tsx`. Tests:
  `shipment-profitability.test.ts` (sheet figures, exclusions, totals, sorting, filters, both grants,
  two-workspace isolation).

---

## 9. INCOME STATEMENT (Accounts) — blocked on a decision

### 9.1 The sheet

Header C6–C9: **Period** `[01-Oct-2026 to 31-Oct-2026]` · **Branch** `[All / Dhaka / Chattogram]` ·
**Currency** `BDT / USD` · **Basis: Accrual**. Columns: **Particulars · Current Month · YTD · Previous
Year YTD**.

| Section | Lines |
|---|---|
| A. Revenue (13) | Ocean Freight – FCL · Ocean Freight – LCL · Air Freight · Customs Clearance · Trucking / Transportation · Warehousing · Documentation / BL Charges · Handling / CFS Charges · Packing / Stuffing · Door-to-Door · Cross-Trade / Third Country · Project Cargo · Other Logistics Service → Gross Revenue, less Discounts / Credit Notes → **Net Revenue** |
| B. Direct cost (14) | Ocean Freight – FCL · Ocean Freight – LCL · Air Freight · Shipping Line / Carrier Charges · Port / Terminal · CFS · Customs / Clearing · Trucking / Transport · Warehouse – Job Related · Loading / Unloading · Documentation / BL · Agent / Overseas Partner · Handling · Other Job-Related → **Total Direct Cost** → **Gross Profit**, GP % |
| C. Operating expenses (20) | Salaries & Wages · Employee Benefits · Office Rent · Utilities · Internet & Telephone · Software / ERP / IT · Marketing & Advertising · Sales Commission · Business Development · Travel & Entertainment · Vehicle / Transportation · Office Supplies & Stationery · Repairs & Maintenance · Insurance · Professional / Consultancy Fees · Legal & Compliance · Bank Charges · Bad Debt / Provision · Depreciation · Other Administrative → **Operating Profit** |
| D. Non-operating income (3) | Interest Income · Foreign Exchange Gain · Other Income |
| E. Non-operating expenses (4) | Interest / Finance Cost · Foreign Exchange Loss · Loss on Asset Disposal · Other Non-Operating |
| | **Profit Before Tax** − Income Tax Expense = **Net Profit After Tax** · Net Profit Margin % |

### 9.2 Why it cannot be built as drawn

1. **"Basis: Accrual" contradicts how the books were built.** MODULE_ACCOUNTS §14.13 Q2 decided that a
   debit invoice does **not** post to the books. Income on Service is credited when money is received
   through an Income voucher, which is cash basis. An accrual statement built from vouchers alone shows
   revenue in the month it was paid, not the month it was earned. Bolting invoice revenue on top would
   count it twice. This decision also decides whether Balance Sheet and Cash Flow can be right, since an
   accrual balance sheet needs receivables in the books (Q21).
2. **The lines are not the chart of accounts.** The chart has 8 Income on Service sub-ledgers and 7
   Cost of Service sub-ledgers. The sheet has 13 revenue lines and 14 direct-cost lines, and they cut
   differently (Trucking, Port/Terminal, Agent cost have no account). Depreciation, Insurance, Bad Debt,
   Income Tax and Loss on Asset Disposal have no account at all. Each ledger account needs a statement
   line (Q22).
3. **Branch** (Dhaka / Chattogram) exists nowhere. No shipment, invoice or voucher carries a branch
   (Q23).
4. **Currency USD.** The books are kept in base only (MODULE_ACCOUNTS §14.13 Q9), so a USD view means
   choosing a conversion rate (Q24).

---

## 10. REPORTS

The `Report` sheet is a catalogue, not wireframes. It lists 8 groups with about 70 reports, a "Daily CEO
Dashboard" KPI list, a sales-report list, and a note on *Quotation → Booking conversion* and *Quoted vs
Actual margin*. No report has columns, filters or a layout. The Menu's Report column still shows only
Lifting Report, Customer wise Shipment and Country wise shipment.

| Group | Reports |
|---|---|
| 01 Operations | Booking Register · Shipment Status · Pending Shipment · Delayed Shipment · ETD/ETA · Container Status · Documentation Pending · Customs Pending · Delivery Pending |
| 02 Profitability | Shipment P&L · Customer · Trade Lane · Carrier · Agent · Salesperson · Service · Monthly Profitability · Loss-Making Jobs · Uncosted / Unbilled Jobs |
| 03 Sales & CRM | Inquiry Register · Quotation Register · Quotation Conversion · Won/Lost Quotes · Customer Revenue · Customer Volume · Salesperson Performance · New Customers · Inactive Customers |
| 04 Accounts Receivable | Customer Outstanding · AR Aging · Overdue Invoice · Credit Limit · Due Today · Due This Week · Customer SOA |
| 05 Accounts Payable | Vendor Outstanding · AP Aging · Carrier Payable · Agent Payable · Due for Payment · Vendor SOA |
| 06 Carrier & Agent | Carrier Performance · Carrier Volume · Carrier Rate Analysis · Agent Performance · Agent Profitability |
| 07 Finance & Accounting | Cash Book · Bank Book · General Ledger · Trial Balance · P&L · Balance Sheet · Cash Flow · Bank Reconciliation |
| 08 Management | CEO Dashboard · Daily / Weekly / Monthly Management Report · Business Performance · Cash Position · Exception Report |

**What the data supports today:**

- **Buildable now:** Booking Register, Inquiry and Quotation Register, Quotation Conversion, Won/Lost,
  Customer Revenue and Volume, New/Inactive Customers, Customer Outstanding, AR Aging, Overdue Invoice,
  Customer SOA, Vendor Outstanding, AP Aging, Carrier and Agent Payable, Cash Book, Bank Book, General
  Ledger, Trial Balance, Shipment P&L (= §8), Customer / Trade Lane / Carrier Profitability, Loss-Making
  Jobs, Unbilled Jobs.
- **Needs §2 first:** Delayed Shipment, ETD/ETA, Carrier Performance (on-time).
- **Needs data that does not exist:** Customs Pending and Delivery Pending (no customs or delivery
  module); Credit Limit (no credit limit on customer); Salesperson anything (no salesperson on quotation
  or booking); Salesperson target vs achievement (no targets); Bank Reconciliation (no statement
  import); Quoted vs Actual margin (needs quotation buy price kept beside invoice cost).
- **Blocked by §9:** P&L, Balance Sheet, Cash Flow.

---

## 10A. DEPLOYING THIS BATCH

Everything built from this document is on branch `feature/design-update-2026-10-04`, one commit per
section, in the order of §1. Before the code serves traffic:

1. `prisma migrate deploy`. Six migrations, all additive, and none alters an existing column's
   meaning:
   - `20261004100000_shipment_milestone`
   - `20261004120000_igm_update_and_delivery_order`
   - `20261004140000_notification_teams`: also adds `email_log.from_address/from_name` and
     `notification_setting.send_as_team`, and recreates `app_claim_email_batch`
   - `20261004160000_pre_alert`
   - `20261004180000_tariff`
   - `20261004200000_customer_activity`
2. `pnpm db:seed`. It adds six permission features (Shipment Profitability, Depart-Arrive, Pre-Alert,
   Tariff, Local Sales; IGM and DO already existed) and four email templates (`SHIPMENT_DEPARTED`,
   `SHIPMENT_TRANSSHIPPED`, `SHIPMENT_ARRIVED`, `PRE_ALERT_SENT`).
3. Grant the new features to the roles that should have them (Admin → Roles). The superadmin sees
   them at once.

**The access token changed** (commit "Access token carries permissions as a bitmap"). The registry
outgrew the old format: a role holding every permission produced a header over 16 KB, and every request
was refused with HTTP 431. Tokens issued before the deploy are still read for their 15 minutes. After
any deploy that adds a permission, each signed-in user's next request silently refreshes once. Nobody
is signed out.

## 11. OPEN QUESTIONS — for the client

Nothing here is guessed in the schema. Each has the working default the build would use.

| # | Question | Working default |
|---|---|---|
| **Depart-Arrive (§2)** | | |
| 1 | **Who receives the Departed / Transshipped notice?** The sheet says "customer email". | The same recipients the Shipment Advise goes to |
| 2 | **Lists are one row per container** (Container no, Seal). Is a booking in two containers confirmed once or per container? | Confirmed once per booking; the containers are listed in one cell |
| 3 | **Arrival:** is "Arrived" saved when the final ETA is confirmed (3 days / 1 day before), or on actual arrival? And for outbound, the "importer email" has no field: the importer is the overseas consignee, stored as name and address only. | Saved once, as the final ETA. Outbound arrival notice goes to the customer's recipients, inbound to the customer (the importer) |
| 4 | **Does a milestone move the shipment status** (e.g. a "Departed" status on the booking list)? | No. Milestones are a parallel track (§2.4); the booking list gains Departed / Arrived columns |
| 5 | One permission for all six screens, or one per milestone? | One: `CUSTOMER_SERVICE.DEPART_ARRIVE` |
| 6 | A three-leg indirect route has two transshipments; the sheet shows "2nd Leg" only. | Leg 2 only, as drawn |
| **Pre-Alert (§3)** | | |
| 7 | **"Booking confirmation"** — which document? Nothing by that name is generated. | The carrier's booking confirmation, uploaded (built that way) |
| 8 | **MBL, MAWB, Manifest-Air** come from the carrier. Upload them on the Pre-Alert screen, or on Copy Doc Upload (unbuilt)? | Uploaded on the Pre-Alert screen, attached and kept |
| 9 | **Inbound pre-alerts** — sent or received? | Outbound only; the inbound side is the agent's pre-alert to us |
| **IGM / DO (§4)** | | |
| 10 | **Inbound HBL No** — typed on IGM Update? | Yes, typed there |
| 11 | **DO letter body** — subject, wording, whom it releases cargo to (consignee / C&F agent), and a DO number format? | Built with the operator writing subject and letter; `DO-YYYY-NNNNNN`. Send a standard wording to pre-fill |
| 12 | **DO addressee** is fixed to Chittagong Port Authority. Air inbound (Dhaka airport), Mongla, Pangaon? | Sea opens on the sheet's Chittagong addressee, editable; air opens blank. A per-port addressee in Settings if wanted |
| 13 | **Preconditions for DO** — must the IGM be Updated? Must the debit invoice be paid? | IGM Updated required; payment not checked (not stated) |
| **Tariff (§5)** | | |
| 14 | **What uses a tariff?** Pre-filling quotation local charges, the debit invoice, or reference only? | Reference only; nothing reads it yet |
| 15 | **LCL / per-CBM lines** have no container size. And validity dates? | Container size optional; no validity dates (none drawn) |
| **Notification (§7)** | | |
| 16 | **Send as five addresses**, or one sender with team Reply-To? | One sender, team name + Reply-To (§7.3) |
| 17 | **Email bodies** for the ten events that have only a title. | A short neutral draft per event, editable in Settings |
| **Local Sales (§6)** | | |
| 18 | **Which customers** does Local Sales show — all, Bangladesh only, or a customer type? | All customers |
| 19 | **Business Possibility** — free text, or a scale (High / Medium / Low)? | Free text |
| **Profitability (§8)** | | |
| 20 | **Status** column (sample "Completed") — which states? | The booking's own status |
| **Income Statement (§9)** | | |
| 21 | **Accrual or cash?** Accrual needs invoices to post to the books (reversing MODULE_ACCOUNTS §14.13 Q2). That is the right foundation for Balance Sheet too, but it changes how Income and Expense vouchers settle invoices. | **Decision needed. Recommend accrual: invoices post on issue, receipts settle the receivable** |
| 22 | **Statement lines vs chart of accounts** — extend the chart to the sheet's lines, or map each account to a line? | Map: each ledger account gets a statement line, seeded for the predefined chart; unmapped accounts fall into "Other …" |
| 23 | **Branch** — a real dimension on bookings, invoices and vouchers? | Not built; no branch filter |
| 24 | **USD view** — convert at which rate (transaction date, period-end)? | BDT only |
| 25 | Depreciation, Insurance, Bad Debt, Income Tax have no ledger accounts. | Added to the predefined chart when Q22 is built |
| **Reports (§10)** | | |
| 26 | **Which reports first?** About 70 are listed without layouts. | Ask for the first 8. Suggested: Booking Register, Quotation Conversion, Customer Outstanding, AR Aging, AP Aging, Shipment P&L, Customer Profitability, Loss-Making Jobs |
| **Raised while building §8** | | |
| 27 | **Export Shipment Profitability to Excel?** The 2026-09-06 decision keeps buy prices out of every downloaded file, and this screen is mostly buy prices. Is a management export of it wanted, and for whom? | No export. The screen is view-only |
| **Raised while building §5** | | |
| 28 | **More tariff types?** The sheet names Port Tariff and CFS Charge; they are an enum. | An enum of the two. A Setting lookup the day a third is named |
