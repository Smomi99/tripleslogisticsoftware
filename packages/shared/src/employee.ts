import { z } from 'zod';

import { listQuerySchema } from './api';
import { countrySchema } from './countries';

/**
 * Employee and its two 1:1 extensions (CLAUDE.md §6).
 *   employee         Table_Employee
 *   employee_cv      Table_Employee, 1:1
 *   employee_salary  Table_Employee, 1:1
 *
 * CV and Salary are single-record screens reached from the row, not lists —
 * §8 lists CV and Salary as contextual buttons alongside Edit.
 */

const optionalDate = z
  .string()
  .trim()
  .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'Enter a valid date.')
  .optional();

export const employeeInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the employee name.').max(200, 'Name is too long.'),
  country: countrySchema,
  department: z.string().trim().max(100, 'Department is too long.').optional(),
  designation: z.string().trim().max(100, 'Designation is too long.').optional(),
  joiningDate: optionalDate,
  officeMobile: z.string().trim().max(50, 'Mobile number is too long.').optional(),
  personalEmail: z
    .string()
    .trim()
    .max(255, 'Email is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
    .optional(),
  qualification: z.string().trim().max(2000, 'Qualification is too long.').optional(),
});

export type EmployeeInput = z.input<typeof employeeInputSchema>;

export const EMPLOYEE_SORT_FIELDS = ['code', 'name', 'department'] as const;
export type EmployeeSortField = (typeof EMPLOYEE_SORT_FIELDS)[number];

export const employeeListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(EMPLOYEE_SORT_FIELDS).default('name'),
});

export interface EmployeeDto {
  id: string;
  code: string;
  name: string;
  country: string;
  department: string | null;
  designation: string | null;
  joiningDate: string | null;
  officeMobile: string | null;
  personalEmail: string | null;
  qualification: string | null;
  /** Storage key only (§2). */
  serviceContractFile: string | null;
  serviceContractFileName: string | null;
  isActive: boolean;
  hasCv: boolean;
  hasSalary: boolean;
}

// --------------------------------------------------------------------- CV

export const employeeCvInputSchema = z.object({
  presentAddress: z.string().trim().max(2000, 'Address is too long.').optional(),
  permanentAddress: z.string().trim().max(2000, 'Address is too long.').optional(),
  qualification: z.string().trim().max(2000, 'Qualification is too long.').optional(),
  fatherName: z.string().trim().max(200, 'Name is too long.').optional(),
  motherName: z.string().trim().max(200, 'Name is too long.').optional(),
  siblingName: z.string().trim().max(200, 'Name is too long.').optional(),
  siblingMobile: z.string().trim().max(50, 'Mobile number is too long.').optional(),
  dateOfBirth: optionalDate,
  reference1: z.string().trim().max(2000, 'Reference is too long.').optional(),
  reference2: z.string().trim().max(2000, 'Reference is too long.').optional(),
});

export type EmployeeCvInput = z.input<typeof employeeCvInputSchema>;

export interface EmployeeCvDto extends Omit<EmployeeCvInput, 'dateOfBirth'> {
  dateOfBirth: string | null;
}

// ----------------------------------------------------------------- Salary

/** Money is NUMERIC(18,4) (§4 rule 6), so amounts travel as strings. */
const amountSchema = z
  .string()
  .trim()
  .refine(
    (v) => v === '' || (/^\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) >= 0),
    'Enter an amount with up to 4 decimal places.',
  )
  .optional();

/**
 * gross_salary is deliberately ABSENT from the input.
 *
 * §6 marks it "GENERATED — auto sum, never stored by hand", and it is a
 * Postgres GENERATED ALWAYS column, so the database rejects a direct write. The
 * screen shows the total; it never submits it.
 */
export const employeeSalaryInputSchema = z.object({
  basicSalary: amountSchema,
  homeRent: amountSchema,
  medical: amountSchema,
  mobileBill: amountSchema,
  insurance: amountSchema,
  incentive: amountSchema,
});

export type EmployeeSalaryInput = z.input<typeof employeeSalaryInputSchema>;

export interface EmployeeSalaryDto {
  basicSalary: string;
  homeRent: string;
  medical: string;
  mobileBill: string;
  insurance: string;
  incentive: string;
  /** Computed by Postgres. Read-only everywhere. */
  grossSalary: string;
}

export const SALARY_COMPONENTS = [
  { key: 'basicSalary', label: 'Basic salary' },
  { key: 'homeRent', label: 'Home rent' },
  { key: 'medical', label: 'Medical' },
  { key: 'mobileBill', label: 'Mobile bill' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'incentive', label: 'Incentive' },
] as const;
