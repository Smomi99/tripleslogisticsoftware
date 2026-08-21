import { z } from 'zod';

import {
  currencyRequiredFor,
  openingCurrencyField,
  signedMoneyField,
} from './opening-balance';

import { listQuerySchema } from './api';
import { countrySchema } from './countries';

/**
 * Customer and its contacts (CLAUDE.md §6).
 *   customer      Table_Customer
 *   customer_pic  Table_Customer_PIC   [child]
 *
 * Ten fields, so §8 puts the form on a full page rather than in a modal.
 */

export const CUSTOMER_TYPES = ['IMPORTER', 'EXPORTER', 'TRADER'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  IMPORTER: 'Importer',
  EXPORTER: 'Exporter',
  TRADER: 'Trader',
};

export const BUSINESS_AREAS = ['INBOUND', 'OUTBOUND', 'BOTH'] as const;
export type BusinessArea = (typeof BUSINESS_AREAS)[number];
export const BUSINESS_AREA_LABEL: Record<BusinessArea, string> = {
  INBOUND: 'Inbound',
  OUTBOUND: 'Outbound',
  BOTH: 'Both',
};

/**
 * Monthly volumes. NUMERIC(18,4) in the database (§4 rule 6), so they travel as
 * strings — a float would quietly lose precision on a TEU or KG figure.
 */
const volumeSchema = z
  .string()
  .trim()
  .refine(
    (v) => v === '' || (/^\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) >= 0),
    'Enter a number with up to 4 decimal places.',
  )
  .optional();

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer name.').max(200, 'Name is too long.'),
  country: countrySchema,
  address: z.string().trim().max(2000, 'Address is too long.').optional(),
  customerType: z.enum(CUSTOMER_TYPES, { message: 'Choose importer, exporter or trader.' }),
  businessArea: z.enum(BUSINESS_AREAS, { message: 'Choose inbound, outbound or both.' }),
  industrySectorId: z.string().regex(/^\d+$/, 'Choose a commodity category.'),
  exSeaVolumeTeuMonth: volumeSchema,
  exAirVolumeKgMonth: volumeSchema,
  imSeaVolumeTeuMonth: volumeSchema,
  imAirVolumeKgMonth: volumeSchema,
  /** Opening figures for the accounts ledger. Positive is owed to us. */
  openingBalance: signedMoneyField('Enter an opening balance, or leave it blank.'),
  openingCurrencyId: openingCurrencyField,
}).refine((v) => currencyRequiredFor([v.openingBalance], v.openingCurrencyId), {
  message: 'Choose the currency the opening balance is in.',
  path: ['openingCurrencyId'],
});

export type CustomerInput = z.input<typeof customerInputSchema>;

export const CUSTOMER_SORT_FIELDS = ['code', 'name', 'country'] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export const customerListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(CUSTOMER_SORT_FIELDS).default('name'),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  businessArea: z.enum(BUSINESS_AREAS).optional(),
});

export interface CustomerDto {
  id: string;
  code: string;
  name: string;
  country: string;
  address: string | null;
  customerType: CustomerType;
  businessArea: BusinessArea;
  industrySectorId: string;
  industrySectorName: string;
  exSeaVolumeTeuMonth: string | null;
  exAirVolumeKgMonth: string | null;
  imSeaVolumeTeuMonth: string | null;
  imAirVolumeKgMonth: string | null;
  openingBalance: string | null;
  openingCurrencyId: string | null;
  openingCurrencyCode: string | null;
  isActive: boolean;
  picCount: number;
}

export const customerPicInputSchema = z.object({
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

export type CustomerPicInput = z.input<typeof customerPicInputSchema>;

export interface CustomerPicDto {
  id: string;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}
