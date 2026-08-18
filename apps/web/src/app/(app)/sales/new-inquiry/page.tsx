import { redirect } from 'next/navigation';

/**
 * The capture form now opens as a modal from the Inquiry List, so this route
 * has nothing of its own to render.
 *
 * Kept as a redirect rather than deleted: §3 names "New Inquiry" as a screen
 * and anyone who bookmarked it should land on the list rather than a 404. The
 * form itself lives in components/sales/inquiry-form.tsx, used by both the
 * raise and edit paths — the duplicate that used to live here is why Edit
 * silently created a second inquiry.
 */
export default function NewInquiryRedirect(): never {
  redirect('/sales/inquiry');
}
