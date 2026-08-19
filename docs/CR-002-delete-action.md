# CR-002 — A Delete action on master-data screens

**Raised by:** the development team
**Status:** built across every Settings and CRM master screen; **awaiting your
confirmation, and reversible if you would rather not have it**
**Affects:** CLAUDE.md §8 (Screen patterns), §7 (RBAC), §4 rule 3

---

## 1. The problem

§8 fixes the Action column at `Edit` plus an `Active/Inactive` toggle, and §4
rule 3 forbids hard deletes. Both are right for the case they were written for:
a carrier with four hundred BLs against it must never disappear, because last
year's documents still have to render.

But there is a second case the toggle cannot express — **a row that was never
real**. A demonstration workspace today contains:

| Screen | Row |
|---|---|
| Carrier | `helll` |
| Sea-Air Port | `CPR TRACK`, `omi`, and a second `Chittagong` |
| Vessel | `Sadi Mohammad Omi` (a person) |
| Agent | `Nordic Cargo Partners`, entered twice |

Deactivating those does not solve anything. They stay in the Inactive filter
permanently, and the duplicate `Chittagong` still looks like a real choice —
which has already caused one incident: a rate was recorded against one
`Chittagong` and an inquiry against the other, and the screen simply found no
match, with nothing to explain why.

Typing mistakes are not going to stop happening, so the product needs an answer
for them.

## 2. The proposal

Add a **Delete** action to master-data screens only — Settings and CRM.

**It is not a hard delete.** It sets `deleted_at`, exactly as §4 rule 3
requires. Every foreign key survives, every historical record still resolves,
and the row can be restored by a developer if it is ever removed in error.
What changes is only that the row leaves the screens.

**It is refused whenever anything references the row.** This is the substance of
the change, and it is checked by the server, not merely hidden in the browser.
The check reads the database's own catalogue of relationships, so a table added
next year is covered without anyone remembering to update a list.

**A record's own parts do not count as usage.** An agent's expert areas, a
carrier's service ports, a customer's contact people — those belong to the
record and are removed with it. Only use from *outside* blocks: an inquiry that
names the customer, a rate that names the port. Without this distinction the
feature would be useless in practice, because the rows a typo produces are
exactly the ones somebody fills in a contact for before noticing the spelling.

When it is refused, the message says what is in the way:

> Aarhus is used by 1 agent port coverage, 1 carrier port pair, 1 carrier
> service port and 1 inquiry. Deactivate it instead of deleting it.

**It is refused on shared rows.** Ports, currencies and carriers that the system
supplies to every company are not yours to delete; §7A rule 7 already allows you
to deactivate them for your own workspace, and that is unchanged.

**It is a separate permission.** `DELETE` is granted per user and per screen in
the §7 matrix, exactly like Edit. A data-entry operator can be given Edit and
Deactivate without it.

### The rule of thumb for your staff

> **Deactivate** — it was real, and no longer applies.
> **Delete** — it was never real.

## 3. What this does not change

- No hard delete is introduced anywhere. §4 rule 3 stands.
- Transactional records — quotations, bookings, shipments, invoices, inquiries,
  purchase rates — get **no** Delete. Those are business history and are retired
  by their own status (`LOST`, `EXPIRED`, superseded). Only Settings and CRM
  master data is affected.
- Nothing about the Active/Inactive toggle changes. It remains the normal way to
  retire a record, and the confirmation text points staff back to it.

## 4. One consequence worth knowing

A deleted row keeps its business code — `PL-007` stays spent, and no future port
is ever given it. An identifier that has appeared on a printed document must
never come to mean something else.

Its *natural* key is released, though. Delete a port mistyped as `CGPX` and you
can immediately add the correct one as `CGPX`; without this, re-entering the
corrected record would fail against a row nobody can see.

## 5. Status

Built and tested across every Settings and CRM master screen: Sea-Air Port,
Cost Head, Currency, Carrier, Vessel, Vendor, Commodity Category, Customer,
Agent, Employee and User.

- the permission, and the server-side guard on every route
- the reference check, driven from the database catalogue
- own-parts removed with the record; outside use blocks
- refusal on shared rows, and on deleting your own user account
- the row action, the confirmation, and the message when it is refused
- automated tests, including that another workspace's row cannot be reached and
  that the delete really is soft

Against the current demonstration data this makes `helll`, `omi`,
`Sadi Mohammad Omi` and the duplicate agent removable, while `Aarhus`,
`Chittagong` and any customer with an inquiry stay put and say why.

The five shared-lookup screens — Goods Type, Container Type, Rate Tier, Terms
of Shipment, Inquiry Source — are not wired, because every row on them is a
shared row today and Delete would never appear. They follow the same pattern
the moment a workspace adds its own value.

## 6. What we need from you

1. **Do you want Delete at all?** If your preference is that nothing ever
   leaves a list, say so and we will remove it — the mistyped rows then simply
   live in the Inactive filter permanently, and staff need to be told that is
   normal.
2. **Should it cover CRM as well as Settings**, or Settings only? A customer or
   an employee entered twice is the same problem, but the record is more
   sensitive.
3. **Who should hold it?** Our assumption is superadmin only to begin with, with
   the permission available to grant more widely once you have seen it used.
