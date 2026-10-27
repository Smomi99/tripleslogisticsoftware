# Sales Lead-FOB and Sales Lead follow up

Source: the client's "Triple S Logistics — FOB Sales Lead Form" (image, 2026-10-26), and the
Sales & Marketing menu, which now reads `Sales Lead-FOB` and `Sales Lead follow up`. This answers
CLAUDE.md §3's two lead screens, which had no wireframe until now, and replaces the name-and-notes
skeleton built for MODULE_PURCHASE_SALES §9 Q12.

The purpose, in the client's words: capture export shipment opportunities from Bangladesh
factories, exporters, buying houses and overseas nominated agents before converting them into
freight quotations and confirmed shipments.

---

## 1. The form, as transcribed

`*` = required on the client's form.

**§1 Lead identification** — Lead ID (auto, e.g. `FOB-2026-0001`) · Lead Date \* · Lead Source \* ·
Lead Owner / Salesperson \* · Business Type \* · Lead Priority

**§2 Customer and commercial parties** — "Keep separate master-data links for the exporter,
overseas buyer and nominated agent. They may be three different companies."
Exporter / Factory Name \* · Exporter Contact Person · Mobile / WhatsApp · Exporter Email ·
Factory Location · Overseas Buyer / Importer · Buyer Country · Buying House ·
Overseas Nominated Agent / Forwarder · Agent Country · Agent Contact / Email

**§3 Shipment opportunity details** — Commodity / Product \* · Shipment Mode \* ·
Port of Loading (POL) \* · Port of Discharge (POD) \* · Equipment Type ·
Estimated Volume (Containers) · Expected Shipment Frequency · Expected First Shipment ·
Incumbent Forwarder · Current Shipping Line · Shipment / Business Requirements

**§4 Revenue potential and sales qualification** — "Not every FOB lead is commercially accessible
to TSL. A factory may export 100 containers monthly, but the freight may be controlled entirely by
the overseas buyer's nominated forwarder."
Freight Control · Lead Status · Estimated Freight Revenue / Container (USD) ·
Estimated Net Profit / Container (USD) · Win Probability (%) · Next Follow-up Date ·
**Calculated opportunity value**: Monthly Freight Revenue, Monthly Net Profit ("Estimates assume
the entered container volume is monthly and the profit figure is net profit per container. For
mixed equipment, use separate lane or shipment records.") · Reason for Win / Loss

**§5 Workflow** — 01 Capture Lead · 02 Qualify Lead (freight control, incumbent, volume, first
shipment) · 03 Request Rate (a linked rate request for the pricing team) · 04 Submit Quotation ·
05 Follow Up (calls, emails, target rates, objections, next follow-up) · 06 Convert to Business
(link the lead to the customer, quotation and shipment booking)

**§6 Linked modules recommended** — Lead ownership (salesperson, department, branch, manager) ·
Customer master link · Overseas agent link · Trade lane · Lead activity history (date, contact
method, discussion, outcome, next action) · Rate request · Competitor intelligence (current
forwarder, carrier, estimated market rate and source) · Business forecast (monthly TEUs, revenue,
profit, probability-weighted pipeline) · Document attachment (RFQ, shipment forecast, buyer
nomination, previous quotations) · Approval and audit (owner, changes, status history)

**§7 Lead list** — Lead ID and date · Exporter / factory · Buyer country and nominated agent ·
POL → POD · Commodity and equipment · Estimated monthly TEUs · Freight control · Current
forwarder · Estimated monthly revenue and profit · Lead status and probability · Salesperson and
next follow-up date.
**Management KPIs** — total active leads, qualified leads, monthly TEU pipeline, estimated monthly
gross profit, conversion pending, lead conversion rate, overdue follow-ups, new customers won.

§8 of the image ("Save the sample lead form") describes the mock-up's own button and is not a
requirement.

---

## 2. As built (branch `feature/sales-lead-fob`)

Migration `20261026120000_sales_lead_fob`. Tables affected: `sales_lead` (extended),
`sales_lead_followup` (extended), `sales_lead_document` (new). Permissions are unchanged in key —
`SALES.NEW_SALES_LEAD` is relabelled **Sales Lead-FOB**; `SALES.SALES_LEAD_FOLLOWUP` now has a menu
item of its own.

| Form | Built as |
|---|---|
| §1 Lead ID | `FOB-<year>-0001`, per workspace per year of the lead date, four digits as the form writes it. The six pre-form leads keep their `LED-…` codes. |
| §1 Lead Source | The existing **Inquiry Source** lookup (Setting → Inquiry Source) — same question, already maintained, and an inquiry raised from the lead inherits it. |
| §1 Owner | FK to `employee`; the employee's department is shown beside it (§6 lead ownership). |
| §2 the three parties | Each a typed name plus an optional master link: exporter → `customer`, buyer → `customer`, agent → `agent`. Picking a record fills the name and contact boxes. A prospect needs no customer record; marking the lead **Won** does (DB check + form rule). |
| §3 Commodity | FK to `commodity_item`, as the inquiry uses. |
| §3 Shipment Mode | Sea FCL / Sea LCL / Air, stored as the inquiry's `shipment_type` + `loading_type`. Air runs between airports, sea between seaports. Equipment type is FCL only. |
| §3 Volume | Per month. Containers for FCL; the unit follows the mode for LCL (CBM) and Air (KG), and the per-unit revenue and profit with it. |
| §3 Current Shipping Line | FK to `carrier`. |
| §3 Requirements | The skeleton's `notes` column, renamed — what was typed there was this. |
| §4 money | `NUMERIC(18,4)` with `currency_id` set to USD by the API (§4 rule 6). |
| §4 Calculated value | Volume × revenue, volume × profit, profit × probability (weighted), and TEU = containers × the equipment's TEU factor. Live on the form; computed in NUMERIC on the server. |
| §4 Next Follow-up Date | On the lead. Every follow-up recorded moves it to that follow-up's next date (blank clears it). |
| §4 Reason for Win / Loss | Required when the status is Won or Lost. `closed_at` records when the lead was decided. |
| §5 Status | New · Qualified · Rate requested · Quoted · Follow-up / negotiation · Won · Lost, drawn as a six-step strip on the form and the lead's history page. |
| §5 step 03 | **Raise inquiry** on a lead opens the existing inquiry form pre-filled (customer, lane, mode, commodity, salesperson, first shipment, source). Saving it moves a New or Qualified lead to Rate requested and links the lead's customer if it had none. Quotation and booking follow from the inquiry as before. |
| §5 step 05 / §6 activity | Follow-up adds outcome, next action, target rate (USD) and objections to date, method, contact and discussion. |
| §6 competitor intelligence | Incumbent forwarder, current shipping line, market rate heard and its source. |
| §6 documents | `sales_lead_document`: RFQ, shipment forecast, buyer nomination, previous quotation, other. PDF, Word, JPG or PNG up to 10 MB; removal is a soft delete. |
| §6 approval and audit | The audit triggers record every change to all three tables. |
| §7 list | The register shows all eleven column groups, filters by status (incl. open / closed), salesperson, freight control and follow-up due, and searches Lead ID, exporter, buyer, buying house, agent and incumbent. |
| §7 KPIs | Pipeline figures (active, qualified, TEU, revenue, profit, weighted, conversion pending, overdue) over open leads now; conversion rate and new customers won over leads decided this calendar year in the workspace's zone. Filterable by salesperson. |

**Sales Lead follow up** (menu) is a screen of its own: a **Due** list of open leads by next
follow-up (Overdue · Due today · Next 7 days · No date set, each counted) with the last
conversation on each row and *Record follow-up* in place, and an **Activity log** of every
follow-up across leads. A lead's full history stays on its child screen.

Visibility: every user with the lead VIEW permission sees every lead. The form names an owner but
states no "own leads only" rule, so none was added; the register filters by salesperson instead.
The inquiries listed on a lead's history page follow the inquiry's own rule (own, or VIEW_ALL).

---

## 3. Open questions

The form gives field names but no dropdown values. Those below were chosen as reasonable
defaults; each is one list in `packages/shared/src/sales-lead.ts` plus a Postgres enum, so a
correction is a small migration.

1. **Business Type** — built as *New customer · Existing customer — new lane · Existing customer —
   more volume*. "New customers won" counts Won leads of the first kind. Is this what the client
   means by Business Type?
2. **Freight Control** — *Free hand (exporter decides) · Buyer nominated · Buying house
   nominated · Nominated through our agent · Not confirmed yet*.
3. **Expected Shipment Frequency** — *Weekly · Fortnightly · Monthly · Quarterly · Seasonal ·
   One-off*.
4. **Lead Priority** — *High · Medium · Low*.
5. **Lead Source** reuses Inquiry Source. Should leads have a separate list?
6. **§6 branch and manager** — no branch or reporting-line field exists on `employee`, so lead
   ownership shows salesperson and department only.
7. **Shipment forecasts are often Excel.** Uploads accept PDF, Word, JPG and PNG, the product-wide
   rule (`lib/storage.ts`). Allow `.xlsx` for lead documents?
8. **Mixed equipment** — one lead carries one equipment type, as the form's own note recommends.
   Is a multi-equipment lead needed?
