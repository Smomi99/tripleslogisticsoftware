# DESIGN UPDATE — 2026-10-28: BUSINESS MATRIX · UPLOAD VGM & EGM · COPY DOC UPLOAD

> **How to use.** This is the transcription of the client's `Design.xlsx` delivery of 2026-10-28,
> mapped onto what the code already holds. Every field below comes from a sheet cell. What no sheet
> answers is in §6 with the default the build uses. A default is a working answer for the client to
> confirm, not a decision they made.

---

## 0. SOURCE — WHAT ARRIVED

`docs/Design.xlsx` went from 83 sheets to 88. Apart from `Menu` and `Report`, every existing sheet is
unchanged. These five sheets are new:

| Sheet | Screen | Menu | Section |
|---|---|---|---|
| `Business Matrix` | Business Matrix | Sales & Marketing D10 | §1 |
| `VGM` (titled *"VGM & EGM"*) | Upload VGM & EGM | Operation I7 | §2 |
| `EGM)` (titled *"VGM"*) | An earlier VGM-only draft of the same screen | none | §2.1 |
| `Copy doc upload` (titled *"Shipping Documens upload"*) | Copy Doc upload | Documentation K8 | §3 |
| `Inquiry reportmen` | Inquiry Register report | Report → 03. Sales & CRM (linked from L8) | §4, not built |

### 0.1 Menu changes

```
Sales & Marketing:  + "- Business Matrix"          (D10, after Local Sales)
Operation, before            Operation, after
- CLP List                   - CLP List
- IGM submission             - Upload VGM & EGM     (I7, new)
- DO Issue                   - IGM submission
                             - DO Issue
Documentation:      "- Copy Doc upload" (K8) was already on the menu. It now has a sheet.
```

### 0.2 Report sheet changes

```
03. Sales & CRM, before      after
├── Customer Revenue          ├── Trade lane wise inquiry
                              └── Customer wise trade lane   (L17, new)
Inquiry Register (L8) now links to the `Inquiry reportmen` sheet (M8).
```

Both new report names lean on §1's trade lanes, which is a reason to build §1 first.

---

## 1. BUSINESS MATRIX (Sales & Marketing) — **built**

### 1.1 What the sheet shows

Two sections, **OUTBOUND SHIPMENT** (E4) and **INBOUND SHIPMENT** (E25).

**Defining a lane.** Outbound row 5–6: **POL** *"Single POL"* · **POD** *"Muliple POD"* ·
**Trade lane name** · `add`. Inbound row 26–27 reads *POL "MULTIPLE POD"* · *POD "SINGLE POL"*. The
cell labels are swapped, but the meaning is the mirror image: **many POLs, one POD**. Every sample row
under it (C30–C34) has a different POL and the one POD, Chittagong.

**The matrix, one table per lane.** C8 *"Trade Lane Name : EU Base port"*, then row 9:

| POL | POD | Inquiry Received | No of Quotation | Shipment Volume ( TEUs) | Total Revenue |
|---|---|---|---|---|---|
| Chittagong | Antrwap | 5 | 2 | 2 | 4000 |
| | Rotterdam | 3 | 1 | 0 | 0 |
| | Le Harve · Southampton · Felixtowe | | | | |

A second outbound lane, *"USE W/C"*, has Chittagong to Los Angeles and Savannah. The inbound table
(row 29) has the same columns, with one row per POL.

### 1.2 What it is built on

| Column | Source | Counted by |
|---|---|---|
| Inquiry Received | `inquiry` with the lane's direction and that POL → POD | `inquiry_date` |
| No of Quotation | `quotation` with the same, **not DRAFT**, one per quotation number however many revisions | `quotation_date` |
| Shipment Volume (TEUs) | **FINAL** load plans (`clp`) holding cargo of a booking on that POL → POD, at the container size's `teu_factor`. A container counts once. | the load date, else the date it was finalised |
| Total Revenue | **ISSUED** debit invoices of bookings on that POL → POD, `total_amount_base` (the workspace's base currency) | `invoice_date` |

Every record is matched on **its own** POL, POD and movement type: an inquiry by the inquiry's ports,
a booking by the booking's. Direction comes from `movement_type`. A booking reads it from its quotation.

### 1.3 Schema

```
trade_lane              (client: Business Matrix → Trade lane name)
  tenant_id, id, code (TLN-001), name,
  movement_type         OUTBOUND | INBOUND (CHECK; Cross Border is not on the sheet)
  port_id FK → port     the single side: the POL of an outbound lane, the POD of an inbound one
  + §4 standard columns

trade_lane_port         (client: "Muliple POD" / "MULTIPLE POD")
  tenant_id, id, trade_lane_id FK, port_id FK → port   the many side
  + §4 standard columns; saving retires and rewrites the rows, as tariff_line does
```

**Permission:** `SALES.BUSINESS_MATRIX`, with VIEW · CREATE · EDIT · TOGGLE_STATUS.

### 1.4 As built

Migration `20261028100000_trade_lane`. Route `/sales/business-matrix`.

- **The page** has the sheet's two sections as an Outbound / Inbound switch. Each lane is its own table,
  headed *Trade lane: name*, with the single port written once on the first row, as C10 and D30 do.
  The filters are search (lane name, code or port), From / To (§6 Q1), Active / Inactive and sort.
  The actions are Edit and Deactivate / Activate (confirmed).
- **Add trade lane** is a modal with Section, Trade lane name, the single port and a searchable
  multi-select for the many side. The matrix lists the ports in the order they were chosen. Once the
  single port is picked, the many side offers only ports of the same kind.
- **Rules** (API, and the database where it can hold them):
  - A lane is OUTBOUND or INBOUND (CHECK).
  - A name is unique per direction, whatever its case (partial unique index).
  - A port is on a lane once, and never on both sides.
  - A lane is all seaports or all airports (§6 Q3).
  - A port pair sits on one live, active lane per direction (§6 Q2). An inactive lane frees its pairs,
    and switching it back on is refused if one has been taken since.
- **Saving** retires the lane's ports and writes them again, as tariff_line does.
- An air lane shows **—** under TEUs.
- Tests: `business-matrix.test.ts`, 11 cases, including two-workspace isolation.

---

## 2. UPLOAD VGM & EGM (Operation) — **built**

### 2.1 What the sheet shows

`VGM`, J3 *"VGM & EGM"*. `Search` (O5). The list, row 6:

**Booking NO · S/O NO · Customer · Exporter · Commodity · Shipment Type · POL/AOL · POD/AOD ·
Container no · Carrier · CLP NO · VGM Status · EGM Status · Action** (`VGM` · `EGM`)

Rows 7–9 are one booking, BOO-01, three times, once per container (cont-1, cont-2, Cont-3). Status
*"Pending"* (M7, N7).

**VGM** panel (B12–F24): **Carrier Booking No** · **Container no** · **VGM** · **Gross Weight** ·
**Name** · **Upload VGM file**.

**EGM** panel (H12–M24): **BL Number** · **MBL Number** · **carrier** · **Upload EGM copy**, with
J17 *"Multiple file can be uploaded"*.

The `EGM)` sheet is the same list without CLP NO, titled *"VGM"*, with the VGM panel only and the
action *"Upload VGM"*. It reads as the draft that `VGM` replaced. It is not built separately.

The Steps table (Menu B43) already says: **VGM update — Outbound Yes, Inbound skip** — *"for
outbound - Arrnage to upload a file"*. The chain (F22) puts **EGM** after Shipment Advise.

### 2.2 Reading

- **VGM is one per container.** It is the SOLAS verified gross mass of a packed container, and the
  sheet lists the booking once per container with the container on the form. It hangs off the load
  plan (`clp`): one live VGM per finalised CLP. A container shared by several bookings (CR-002) has one
  VGM, shown under each of them.
- **EGM is one per bill.** The form names the BL, the MBL and the carrier, so it hangs off the
  shipment advise, which carries the House BL No, the MBL No and the carrier. Bookings that share one
  advise under CR-005 share its EGM. Several files per advise.
- **Gross Weight** opens on the CLP's total gross weight. **VGM** is typed. The VGM is the packed
  container's weight, cargo included, so it cannot be less than the cargo's gross weight.
- **Name** is the person who signs the declaration (SOLAS asks for one). Stored as `signatory_name`.
- **Carrier Booking No** does not exist anywhere in the system. It is typed here, per container, and
  opens on the number already given for the booking's other containers.
- **Status** follows IGM Update's rule: *Uploaded* once the file is in, *Pending* until then.

### 2.3 Schema

```
vgm                     (client: VGM & EGM → VGM)
  tenant_id, id, clp_id FK → clp,
  carrier_booking_no, vgm_kg NUMERIC(18,3), gross_weight_kg NUMERIC(18,3),
  signatory_name, vgm_file (storage key), + §4 standard columns
  one live row per clp

egm_document            (client: VGM & EGM → EGM, "Multiple file can be uploaded")
  tenant_id, id, advise_id FK → shipment_advise, file_key, + §4 standard columns
```

**Permission:** `OPERATION.VGM_EGM`, with VIEW · CREATE · EDIT. CREATE records a first VGM and adds an
EGM file. EDIT changes a VGM and removes an EGM file.

### 2.4 As built

Migration `20261028120000_vgm_egm`. Route `/operation/vgm-egm`.

- **List.** OUTBOUND bookings that are not cancelled or rejected and have an approved schedule or an
  advise (Pre-Alert's candidates). There is a Sea / Air switch (§6 Q7), Pending / Uploaded / All views
  and search. A sea booking shows each finalised container on its own line, with its Container no, CLP
  No and VGM status side by side, as the milestone screens stack containers. That keeps one row per
  booking, so the page count stays true. A booking with no finalised CLP reads *No finalised CLP yet*.
  - **Pending** means the VGM of any container, or the EGM, is still missing. Air only waits on the EGM.
  - Containers come from `clp_booking`, so a consolidated box shows under each of its bookings and
    carries one VGM.
  - **Shared is said out loud** (2026-10-28, after the DEMO-EFR bookings read Uploaded together). A
    container or bill with more than one booking reads *Shared with …* on its line. The VGM and EGM
    dialogs open with *One container, one VGM* or *One bill, one EGM*, naming the other bookings. The
    save toast says where else the VGM shows.
- **VGM** (per container): *Record VGM* opens Carrier Booking No, VGM (kg), Gross Weight (kg), Name and
  the file.
  - Carrier Booking No opens on the one already given for the booking's other containers. Gross Weight
    opens on the CLP's total.
  - The API refuses a draft plan (`CLP_NOT_FINAL`), an inbound container (`NOT_OUTBOUND`), a blank
    name, and a VGM below the gross weight. The last is a CHECK too.
  - The first save needs CREATE, a change needs EDIT. A replaced file is removed from storage after
    the row points at the new one, as on IGM Update.
- **EGM** (per advise): the dialog shows BL Number, MBL Number and carrier from the advise (HAWB, MAWB
  and Airline on air). Several files can be chosen at once and go up one by one, with progress. A copy
  is removed with a confirmation (EDIT). The removal is soft, and the file stays.
- Tests: `vgm-egm.test.ts`, 10 cases, including two-workspace isolation.

---

## 3. COPY DOC UPLOAD (Documentation) — **built**

### 3.1 What the sheet shows

`Copy doc upload`, G3 *"Shipping Documens upload"*. The list, row 6:

**Booking NO · S/O NO · Customer · Exporter · Importer · Commodity · Shipment Type · POL · POD ·
Carrier · House BL No · MBL No · Action** (`Upload Doc`)

Row 7 is a sea export (Chittagong → Hamburg, SITC). Row 8 is an **air import** (DXB → DAC, G9, importer
*JF trader*). So the screen covers both modes and both directions.

An arrow runs from `Upload Doc` (N7) to the form (C16–E24): nine rows, each *"browse and upload"*:

**House bill of lading · Master Bill of lading · CO · Commercal Invoice · Packing list · GSP · EXP ·
IGM · Delivery Order**

The Steps table (Menu B44) says BL Draft & Print is skipped for inbound, *"For inbound Arrnage to upload
a file"*. This is where that file goes.

### 3.2 Reading

- One live file per booking per document. Uploading again replaces it. Unlike EGM, the sheet does not
  say several are allowed.
- On air, the first two read **House air waybill (HAWB)** and **Master air waybill (MAWB)**.
- Some of these papers are already in the system. An upload here always wins. Otherwise the screen
  shows what the system holds, so nothing is uploaded twice:

| Document | Already held as |
|---|---|
| House bill of lading | Pre-Alert's HBL / HAWB upload, else the approved bill (BL Print's non-negotiable COPY) |
| Master bill of lading | Pre-Alert's MBL / MAWB upload |
| IGM | IGM Update's file |
| Delivery Order | the issued DO letter |
| CO · Commercial Invoice · Packing list · GSP · EXP | nothing; uploads only |

  In the other direction, Pre-Alert now offers a house or master bill uploaded here when it has none of
  its own.
- **House BL No** is the advise's, or on an inbound booking without one, IGM Update's HBL No.

### 3.3 Schema

```
copy_document           (client: Copy doc upload)
  tenant_id, id, shipment_id FK → shipment,
  kind ENUM(HOUSE_BL, MASTER_BL, CO, COMMERCIAL_INVOICE, PACKING_LIST, GSP, EXP, IGM, DELIVERY_ORDER),
  file_key, + §4 standard columns
  one live row per booking per kind
```

**Permission:** `DOCUMENTATION.COPY_DOC_UPLOAD` already exists. VIEW lists and downloads, CREATE
uploads into an empty slot, EDIT replaces or removes.

### 3.4 As built

Migration `20261028140000_copy_document`. Route `/documentation/copy-doc-upload`.

- **List.** Every booking that is not cancelled or rejected and has an approved schedule or an advise,
  in both directions and modes. Mode and Direction filters narrow it, and search covers booking,
  quotation, customer and exporter. The Action cell reads *Upload Doc · n of 9*: how many papers are
  on file, counting what the system holds.
- **The form** lists the nine papers in the sheet's order. Each reads *Uploaded*, *On file* (with
  where from) or *Not on file*. The actions are Browse and upload, Upload a copy, Replace, or Remove
  (confirmed, soft).
  - A first copy needs CREATE. Replacing or removing needs EDIT.
  - Removing a copy brings back what the system holds.
- **Sources** are read by one loader and decided by one resolver, so the list's count and the form
  cannot disagree. The House BL from BL Print is drawn when it is downloaded, as on Pre-Alert.
- **Pre-Alert** now offers Copy Doc's house or master bill, by mode, when it has no upload of its own.
  It reads as held elsewhere, with the note *Uploaded on Copy Doc upload*. `contentTypeOf` moved from
  `pre-alert.route.ts` to `lib/storage.ts` for the new download routes.
- Tests: `copy-doc.test.ts`, 9 cases, including both directions of the Pre-Alert link and two-workspace
  isolation.

---

## 4. INQUIRY REGISTER (Report) — not built

`Inquiry reportmen`: **From Date · To date** with *"This month /Last month / three Month/ This year /
Last year"*. Tiles: **Total Inquiry · Quotation Conversion · Potential Revenue · Potential Gross Profit
· No of Won · No of Lost**. The list (row 13): **Inquiry no · Date · Customer · POL · POD · Shipment Type
· Type of movement · TOS · Mode · Loading type · Status**.

Not requested in this round. *Potential Revenue* and *Potential Gross Profit* have no stated formula
(Q12).

---

## 5. BUILD ORDER

Sales → Operation → Documentation, the order of CLAUDE.md §3:

1. §1 Business Matrix
2. §2 Upload VGM & EGM
3. §3 Copy Doc Upload

---

## 6. OPEN QUESTIONS — with the default the build uses

| # | Question | Default built |
|---|---|---|
| Q1 | Business Matrix has no period. Lifetime totals, or a date range? | An optional From / To. Empty means all time. Each figure is counted by its own date (§1.2). |
| Q2 | May one POL → POD pair sit in two live lanes of the same direction? | **No.** It would count twice in any cross-lane total, and *Customer wise trade lane* needs one lane per pair. |
| Q3 | Can a lane mix a seaport and an airport? | **No.** A lane is all seaports or all airports. An air lane shows no TEUs. |
| Q4 | Cross Border inquiries have a movement type the sheet has no section for. | Not on the matrix. |
| Q5 | Does *No of Quotation* count drafts? Revisions? | Sent and later only. A quotation with three revisions is one. |
| Q6 | *Shipment Volume (TEUs)*: what was shipped, or what was booked? | Shipped: finalised load plans, a container counted once. |
| Q7 | Upload VGM & EGM: air too? The headers say POL/AOL, but VGM, CLP NO and Container no are sea. | **Both**, with the Sea / Air switch the other lists have. VGM is sea only (answered 2026-09-03). Air lists bookings for the EGM alone. |
| Q8 | Is EGM per BL or per booking? | Per BL (the shipment advise), so bookings sharing one BL under CR-005 share the EGM. |
| Q9 | Which VGM fields are required? | Carrier Booking No, VGM and Name. Gross Weight opens on the CLP's. The file makes it *Uploaded*. |
| Q10 | *"Pending"* is the only status the sheet shows. | Pending → Uploaded, the way IGM Update reads Awaiting → Updated. |
| Q11 | Copy Doc Upload: one file per document, or several (a booking with three POs has three invoices)? | One per document, replaced on upload. Several is a small change if wanted. |
| Q12 | Inquiry Register: how are *Potential Revenue* and *Potential Gross Profit* worked out? | Not built (§4). |
