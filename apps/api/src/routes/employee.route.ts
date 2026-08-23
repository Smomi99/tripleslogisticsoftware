import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type EmployeeCvDto,
  employeeCvInputSchema,
  type EmployeeDto,
  employeeInputSchema,
  employeeListQuerySchema,
  type EmployeeSalaryDto,
  employeeSalaryInputSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * CRM → Employee, with its CV and Salary (CLAUDE.md §6, §8).
 *
 * CV and Salary are 1:1 extensions, not lists — §8 shows them as contextual
 * buttons on the row, and each opens a single record. That makes them the first
 * screens in the product that create-or-update rather than list-and-add.
 */
export const employeeRouter: Router = Router();

employeeRouter.use(authenticate);

const FEATURE = 'CRM.EMPLOYEE';

const SELECT = {
  id: true,
  code: true,
  name: true,
  country: true,
  department: true,
  designation: true,
  joiningDate: true,
  officeMobile: true,
  personalEmail: true,
  qualification: true,
  serviceContractFile: true,
  isActive: true,
  cv: { select: { id: true } },
  salary: { select: { id: true } },
} as const;

type EmployeeRow = {
  id: bigint;
  code: string;
  name: string;
  country: string;
  department: string | null;
  designation: string | null;
  joiningDate: Date | null;
  officeMobile: string | null;
  personalEmail: string | null;
  qualification: string | null;
  serviceContractFile: string | null;
  isActive: boolean;
  cv: { id: bigint } | null;
  salary: { id: bigint } | null;
};

/** joining_date and date_of_birth are DATE columns — no time, no timezone. */
const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

function toDto(row: EmployeeRow): EmployeeDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    country: row.country,
    department: row.department,
    designation: row.designation,
    joiningDate: dateOnly(row.joiningDate),
    officeMobile: row.officeMobile,
    personalEmail: row.personalEmail,
    qualification: row.qualification,
    serviceContractFile: row.serviceContractFile,
    serviceContractFileName:
      row.serviceContractFile === null ? null : displayNameFromKey(row.serviceContractFile),
    isActive: row.isActive,
    hasCv: row.cv !== null,
    hasSalary: row.salary !== null,
  };
}

const optionalDate = (value: string | undefined): Date | null =>
  value === undefined || value === '' ? null : new Date(value);

async function findEmployee(db: TenantDb, id: bigint) {
  const employee = await db.employee.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (employee === null) throw HttpError.notFound('Employee not found.');
  return employee;
}

employeeRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = employeeListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
              { department: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.employee.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.employee.count({ where }),
    ]);
    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<EmployeeDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

employeeRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'employee');
  const row = await withTenant(auth.tenantId, async (db) => {
    const found = await db.employee.findFirst({ where: { id, deletedAt: null }, select: SELECT });
    if (found === null) throw HttpError.notFound('Employee not found.');
    return found;
  });
  const payload: ApiSuccess<EmployeeDto> = { success: true, data: toDto(row) };
  res.json(payload);
});

employeeRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'employee');
  const employee = await withTenant(auth.tenantId, (db) => findEmployee(db, id));
  const payload: ApiSuccess<{ id: string; name: string }> = {
    success: true,
    data: { id: employee.id.toString(), name: employee.name },
  };
  res.json(payload);
});

employeeRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = employeeInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'employee', CODE_PREFIX.employee, auth.tenantId);
      try {
        return await db.employee.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            country: input.country,
            department: input.department || null,
            designation: input.designation || null,
            joiningDate: optionalDate(input.joiningDate),
            officeMobile: input.officeMobile || null,
            personalEmail: input.personalEmail || null,
            qualification: input.qualification || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate an employee code.');
  });

  const payload: ApiSuccess<EmployeeDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

employeeRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'employee');
  const input = employeeInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    await findEmployee(db, id);
    return db.employee.update({
      where: { id },
      data: {
        name: input.name,
        country: input.country,
        department: input.department || null,
        designation: input.designation || null,
        joiningDate: optionalDate(input.joiningDate),
        officeMobile: input.officeMobile || null,
        personalEmail: input.personalEmail || null,
        qualification: input.qualification || null,
        updatedBy: auth.userId,
      },
      select: SELECT,
    });
  });

  const payload: ApiSuccess<EmployeeDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

employeeRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'employee');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.employee.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Employee not found.');
      const updated = await db.employee.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

// ===========================================================================
// Service contract file
// ===========================================================================

employeeRouter.post(
  '/:id/contract',
  requirePermission(`${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'employee');
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const stored = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.employee.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, serviceContractFile: true },
      });
      if (existing === null) throw HttpError.notFound('Employee not found.');

      const saved = await putFile(auth.tenantId, 'employee-contract', file);
      await db.employee.update({
        where: { id },
        data: { serviceContractFile: saved.key, updatedBy: auth.userId },
      });
      if (existing.serviceContractFile !== null) {
        await removeFile(auth.tenantId, existing.serviceContractFile);
      }
      return saved;
    });

    const payload: ApiSuccess<{ key: string; fileName: string }> = {
      success: true,
      data: { key: stored.key, fileName: displayNameFromKey(stored.key) },
    };
    res.status(201).json(payload);
  },
);

employeeRouter.get('/:id/contract', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'employee');

  const key = await withTenant(auth.tenantId, async (db) => {
    const employee = await db.employee.findFirst({
      where: { id, deletedAt: null },
      select: { serviceContractFile: true },
    });
    if (employee === null || employee.serviceContractFile === null) {
      throw HttpError.notFound('No service contract has been uploaded.');
    }
    return employee.serviceContractFile;
  });

  const { stream, sizeBytes } = await openFile(auth.tenantId, key);
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`,
  );
  stream.pipe(res);
});

// ===========================================================================
// CV (1:1)
// ===========================================================================

const CV_SELECT = {
  presentAddress: true,
  permanentAddress: true,
  qualification: true,
  fatherName: true,
  motherName: true,
  siblingName: true,
  siblingMobile: true,
  dateOfBirth: true,
  reference1: true,
  reference2: true,
} as const;

employeeRouter.get('/:id/cv', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const employeeId = parseId(req.params.id, 'employee');

  const cv = await withTenant(auth.tenantId, async (db) => {
    await findEmployee(db, employeeId);
    return db.employeeCv.findFirst({
      where: { employeeId, deletedAt: null },
      select: CV_SELECT,
    });
  });

  // An employee with no CV yet is not an error — the screen opens empty.
  const payload: ApiSuccess<EmployeeCvDto> = {
    success: true,
    data: {
      presentAddress: cv?.presentAddress ?? '',
      permanentAddress: cv?.permanentAddress ?? '',
      qualification: cv?.qualification ?? '',
      fatherName: cv?.fatherName ?? '',
      motherName: cv?.motherName ?? '',
      siblingName: cv?.siblingName ?? '',
      siblingMobile: cv?.siblingMobile ?? '',
      dateOfBirth: dateOnly(cv?.dateOfBirth ?? null),
      reference1: cv?.reference1 ?? '',
      reference2: cv?.reference2 ?? '',
    },
  };
  res.json(payload);
});

/** PUT rather than POST: one CV per employee, created or replaced in place. */
employeeRouter.put('/:id/cv', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const employeeId = parseId(req.params.id, 'employee');
  const input = employeeCvInputSchema.parse(req.body);

  const data = {
    presentAddress: input.presentAddress || null,
    permanentAddress: input.permanentAddress || null,
    qualification: input.qualification || null,
    fatherName: input.fatherName || null,
    motherName: input.motherName || null,
    siblingName: input.siblingName || null,
    siblingMobile: input.siblingMobile || null,
    dateOfBirth: optionalDate(input.dateOfBirth),
    reference1: input.reference1 || null,
    reference2: input.reference2 || null,
  };

  const saved = await withTenant(auth.tenantId, async (db) => {
    await findEmployee(db, employeeId);
    const existing = await db.employeeCv.findFirst({
      where: { employeeId, deletedAt: null },
      select: { id: true },
    });

    if (existing === null) {
      return db.employeeCv.create({
        data: {
          tenantId: auth.tenantId,
          employeeId,
          ...data,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: CV_SELECT,
      });
    }
    return db.employeeCv.update({
      where: { id: existing.id },
      data: { ...data, updatedBy: auth.userId },
      select: CV_SELECT,
    });
  });

  const payload: ApiSuccess<EmployeeCvDto> = {
    success: true,
    data: {
      presentAddress: saved.presentAddress ?? '',
      permanentAddress: saved.permanentAddress ?? '',
      qualification: saved.qualification ?? '',
      fatherName: saved.fatherName ?? '',
      motherName: saved.motherName ?? '',
      siblingName: saved.siblingName ?? '',
      siblingMobile: saved.siblingMobile ?? '',
      dateOfBirth: dateOnly(saved.dateOfBirth),
      reference1: saved.reference1 ?? '',
      reference2: saved.reference2 ?? '',
    },
  };
  res.json(payload);
});

// ===========================================================================
// Salary (1:1)
// ===========================================================================

const SALARY_SELECT = {
  basicSalary: true,
  homeRent: true,
  medical: true,
  mobileBill: true,
  insurance: true,
  incentive: true,
  grossSalary: true,
} as const;

type SalaryRow = {
  basicSalary: Prisma.Decimal;
  homeRent: Prisma.Decimal;
  medical: Prisma.Decimal;
  mobileBill: Prisma.Decimal;
  insurance: Prisma.Decimal;
  incentive: Prisma.Decimal;
  grossSalary: Prisma.Decimal | null;
};

function salaryToDto(row: SalaryRow | null): EmployeeSalaryDto {
  const zero = '0.0000';
  if (row === null) {
    return {
      basicSalary: zero,
      homeRent: zero,
      medical: zero,
      mobileBill: zero,
      insurance: zero,
      incentive: zero,
      grossSalary: zero,
    };
  }
  return {
    basicSalary: row.basicSalary.toFixed(4),
    homeRent: row.homeRent.toFixed(4),
    medical: row.medical.toFixed(4),
    mobileBill: row.mobileBill.toFixed(4),
    insurance: row.insurance.toFixed(4),
    incentive: row.incentive.toFixed(4),
    grossSalary: row.grossSalary?.toFixed(4) ?? zero,
  };
}

const amount = (value: string | undefined): string =>
  value === undefined || value === '' ? '0' : value;

employeeRouter.get('/:id/salary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const employeeId = parseId(req.params.id, 'employee');

  const salary = await withTenant(auth.tenantId, async (db) => {
    await findEmployee(db, employeeId);
    return db.employeeSalary.findFirst({
      where: { employeeId, deletedAt: null },
      select: SALARY_SELECT,
    });
  });

  const payload: ApiSuccess<EmployeeSalaryDto> = { success: true, data: salaryToDto(salary) };
  res.json(payload);
});

/**
 * PUT /:id/salary
 *
 * gross_salary is never written. §6 calls it "GENERATED — auto sum, never
 * stored by hand", and it is a Postgres GENERATED ALWAYS column, so a write
 * would be rejected outright. It is read back after the update instead.
 */
employeeRouter.put('/:id/salary', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const employeeId = parseId(req.params.id, 'employee');
  const input = employeeSalaryInputSchema.parse(req.body);

  const data = {
    basicSalary: amount(input.basicSalary),
    homeRent: amount(input.homeRent),
    medical: amount(input.medical),
    mobileBill: amount(input.mobileBill),
    insurance: amount(input.insurance),
    incentive: amount(input.incentive),
  };

  const saved = await withTenant(auth.tenantId, async (db) => {
    await findEmployee(db, employeeId);
    const existing = await db.employeeSalary.findFirst({
      where: { employeeId, deletedAt: null },
      select: { id: true },
    });

    if (existing === null) {
      return db.employeeSalary.create({
        data: {
          tenantId: auth.tenantId,
          employeeId,
          ...data,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: SALARY_SELECT,
      });
    }
    return db.employeeSalary.update({
      where: { id: existing.id },
      data: { ...data, updatedBy: auth.userId },
      select: SALARY_SELECT,
    });
  });

  const payload: ApiSuccess<EmployeeSalaryDto> = { success: true, data: salaryToDto(saved) };
  res.json(payload);
});

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a employee entered by mistake.
 */
employeeRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'employee');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.employee.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'employee',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Employee not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'employee', id, auth.userId);

    await db.employee.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
