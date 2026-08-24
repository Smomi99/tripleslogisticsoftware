import type { TenantDb } from './tenant-client';

/**
 * Templates, and filling them in.
 *
 * A template is looked up by key. The workspace's own row wins over the shipped
 * default, so a forwarder can rewrite what goes out to their agents without
 * anyone editing code — and without every new workspace starting from a blank
 * page, which is what a tenant-only table would have meant.
 */

/** `{{ customerName }}` and `{{customerName}}` both work. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface RenderedMail {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
}

export interface TemplateRow {
  key: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
}

/**
 * Substitutes the variables a template names.
 *
 * A placeholder with no value becomes an empty string rather than staying on
 * screen as `{{eta}}`. A customer reading "ETA {{eta}}" learns that we send
 * machine-generated mail badly; a customer reading "ETA" learns nothing, which
 * is the better failure. Missing keys are returned so a caller can log them.
 */
export function fill(
  template: string,
  values: Record<string, string | number | null | undefined>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  return { text, missing: [...new Set(missing)] };
}

export function render(
  row: TemplateRow,
  values: Record<string, string | number | null | undefined>,
): RenderedMail {
  return {
    subject: fill(row.subject, values).text.trim(),
    bodyText: fill(row.bodyText, values).text,
    bodyHtml: row.bodyHtml === null ? null : fill(row.bodyHtml, values).text,
  };
}

/**
 * The template a workspace should use for a key.
 *
 * Takes a tenant-scoped client rather than the raw one, and that is not
 * optional: the application connects as ff_app, which row level security
 * applies to, so a read with no tenant in scope returns nothing at all — not an
 * error, just silence, and every message would quietly fall back to its
 * hardcoded wording. email_template is registered system-capable, so the
 * extension already widens the filter to "this workspace or shared" and there
 * is no OR to write here.
 *
 * Returns null when there is no template at all, which is a deployment fault
 * rather than a user error: the caller falls back to its own wording so a
 * missing row cannot silence a notification somebody is waiting on.
 */
export async function resolveTemplate(db: TenantDb, key: string): Promise<TemplateRow | null> {
  const rows = await db.emailTemplate.findMany({
    where: { key, isActive: true, deletedAt: null },
    select: { key: true, subject: true, bodyText: true, bodyHtml: true, tenantId: true },
  });
  if (rows.length === 0) return null;
  // The workspace's own wording beats the shipped default.
  const chosen = rows.find((r) => r.tenantId !== null) ?? rows[0]!;
  return {
    key: chosen.key,
    subject: chosen.subject,
    bodyText: chosen.bodyText,
    bodyHtml: chosen.bodyHtml,
  };
}
