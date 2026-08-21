import { z } from 'zod';

import {
  currencyRequiredFor,
  openingCurrencyField,
  signedMoneyField,
} from './opening-balance';

import { listQuerySchema } from './api';
import { countrySchema } from './countries';

/**
 * Vendor and its contact people (CLAUDE.md §5).
 *   vendor      Table_Vendor
 *   vendor_pic  Table_Vendor_Contact_Person   [child]
 *
 * §5 labels the child (Table_Vendor), identical to its parent — read as a
 * transcription slip, since §8 names the screen Vendor_Contact_Person.
 *
 * Both are tenant-owned: a forwarder's suppliers are its own.
 */

export const vendorInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the vendor name.').max(200, 'Name is too long.'),
  country: countrySchema,
  address: z.string().trim().max(2000, 'Address is too long.').optional(),
  serviceDescription: z.string().trim().max(2000, 'Description is too long.').optional(),
  vendorTypeId: z.string().regex(/^\d+$/, 'Choose a vendor type.'),
  bankDetails: z.string().trim().max(2000, 'Bank details are too long.').optional(),
  tinNo: z.string().trim().max(50, 'TIN is too long.').optional(),
  /** The client writes vat_no (BIN) — Bangladesh Business Identification Number. */
  vatNo: z.string().trim().max(50, 'VAT/BIN is too long.').optional(),
  /** Opening figures for the accounts ledger. Positive is owed to us. */
  openingBalance: signedMoneyField('Enter an opening balance, or leave it blank.'),
  openingCurrencyId: openingCurrencyField,
}).refine((v) => currencyRequiredFor([v.openingBalance], v.openingCurrencyId), {
  message: 'Choose the currency the opening balance is in.',
  path: ['openingCurrencyId'],
});

export type VendorInput = z.input<typeof vendorInputSchema>;

export const VENDOR_SORT_FIELDS = ['code', 'name', 'country'] as const;
export type VendorSortField = (typeof VENDOR_SORT_FIELDS)[number];

export const vendorListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(VENDOR_SORT_FIELDS).default('name'),
  vendorTypeId: z.string().regex(/^\d+$/).optional(),
});

export interface VendorDto {
  id: string;
  code: string;
  name: string;
  country: string;
  address: string | null;
  serviceDescription: string | null;
  vendorTypeId: string;
  vendorTypeName: string;
  bankDetails: string | null;
  tinNo: string | null;
  vatNo: string | null;
  openingBalance: string | null;
  openingCurrencyId: string | null;
  openingCurrencyCode: string | null;
  isActive: boolean;
  picCount: number;
}

export const vendorPicInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the contact name.').max(200, 'Name is too long.'),
  department: z.string().trim().max(100, 'Department is too long.').optional(),
  designation: z.string().trim().max(100, 'Designation is too long.').optional(),
  mobile: z.string().trim().max(50, 'Mobile number is too long.').optional(),
  email: z
    .string()
    .trim()
    .max(255, 'Email is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
    .optional(),
});

export type VendorPicInput = z.input<typeof vendorPicInputSchema>;

export interface VendorPicDto {
  id: string;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}
