# CR-003 — Customising a shared master row

**Raised by:** the development team
**Status:** built for Sea-Air Port, Currency and Carrier; **awaiting your
confirmation**
**Affects:** CLAUDE.md §7A rule 7, §8 (Screen patterns)

---

## 1. The problem

Ports, currencies and carriers are the same worldwide, so the system supplies
them to every company on the server. §7A rule 7 says a company may hide one of
these shared rows for itself, but never edit or delete it — which is right, and
must stay right: one company editing a row that another company reads would be
the worst kind of failure in a shared product.

The consequence is that a large part of Settings can only be deactivated:

| Screen | Shared rows | Your own |
|---|---|---|
| Currency | 9 | 0 |
| Sea-Air Port | 14 | 6 |
| Carrier | 10 | 2 |
| Rate Tier, Terms of Shipment, Container Type, Goods Type, Inquiry Source | all | none |

Two things follow, and the second is expensive.

**A currency conversion cannot be set at all.** It is a per-company commercial
figure. The shared row cannot carry yours, and you cannot edit the shared row.

**Correcting a shared row means creating a duplicate.** The only route available
today is to deactivate the shared row and add your own — which is how this
workspace ended up with two ports called Chittagong, a rate booked against one
and an inquiry against the other, and a screen that simply found no match.

## 2. The proposal

A **Customise** action on shared rows.

It takes your own copy of the row, moves your existing records onto the copy,
and hides the shared original from your list. The shared row is not modified in
any way, and no other company is affected — §7A rule 7 is kept, not bent.

Afterwards the row behaves like any record you created: Edit, Deactivate and
Delete all apply.

The step that matters is the middle one. **Your existing records move to the
copy**, so an inquiry raised last month against the shared Chittagong now points
at yours and shows your name for it. Without that, customising would leave the
copy used by nothing and every historical record on the hidden original — which
is the duplicate problem again, wearing a different hat.

The shared row does not linger in your list as an inactive entry. It is
replaced, not deactivated, and the list shows one row where there was one row.

## 3. What this does not change

- The shared row is never edited or deleted. Other companies see it exactly as
  before, and keep pointing at it.
- Nothing happens automatically. A shared row is only ever copied when someone
  chooses to customise it.
- Deactivate still works as it did, for shared rows you simply do not use.
- It is gated by the screen's existing Edit permission — customising is an edit.

## 4. One thing to decide

The copy is given the next business code in **your** sequence. So a customised
currency may come out as `CUR-001` while the shared `CUR-001` is a different
currency, and both can appear in one list.

That is not new — any record you add gets a code from your own sequence — but
customising makes it far more likely to be noticed, because the two rows are
now the *same* currency under two codes at different times.

This is the open question already recorded in CLAUDE.md §11 item 4: the code
format is only specified for ports (`PL-001`). If you would like customised
copies to be visibly distinct — a different prefix, or a suffix — tell us the
format and we will apply it.

## 5. Status

Built and tested on **Sea-Air Port**, **Currency** and **Carrier** — the three
tables §7A rule 7 names.

Automated tests cover the part that would be expensive to get wrong: the shared
row is byte-for-byte unchanged after a customise, another workspace keeps its
own view of it, the references really do move, and customising the same row
twice is refused.

The five shared-lookup screens — Rate Tier, Terms of Shipment, Container Type,
Goods Type, Inquiry Source — are not wired yet. Say the word and they follow the
same pattern.

## 6. What we need from you

1. **Do you want it?** The alternative is the status quo: shared rows stay
   read-only, and correcting one means a deliberate duplicate.
2. **Should customised copies carry a distinct code?** See §4.
3. **Who should hold it?** It currently follows the screen's Edit permission.
   If customising should be narrower than editing, it needs a permission of its
   own.
