-- Copy Doc upload: two more papers the client asked for on 2026-10-28,
-- after the sheet's nine (docs/DESIGN-UPDATE-2026-10-28.md §3.5). Each is a
-- copy uploaded here: nothing else in the system holds them.
--
-- copy_document's RLS, grants, audit trigger and its one-live-copy-per-kind
-- index cover every kind already, so the enum is all that changes. Nothing in
-- this transaction uses the new values, which Postgres would refuse.
ALTER TYPE "copy_document_kind" ADD VALUE IF NOT EXISTS 'CNF_CERTIFICATE' AFTER 'DELIVERY_ORDER';
ALTER TYPE "copy_document_kind" ADD VALUE IF NOT EXISTS 'ENCASHMENT_CERTIFICATE' AFTER 'CNF_CERTIFICATE';
