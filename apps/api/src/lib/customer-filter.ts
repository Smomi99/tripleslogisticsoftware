import { type BusinessArea, CUSTOMER_TYPE_LABEL, CUSTOMER_TYPES, type CustomerType } from '@ff/shared';

import type { Prisma } from '../generated/prisma/client';

/**
 * The Customer list's filters as a where clause.
 *
 * One definition, because two screens read it: the list itself, and Email
 * prices, which writes to exactly the customers the list is showing. If the
 * two drifted, the button would mail people the operator never saw.
 */
export interface CustomerFilter {
  search?: string | undefined;
  customerType?: CustomerType | undefined;
  businessArea?: BusinessArea | undefined;
  industrySectorId?: string | undefined;
  isActive?: boolean | undefined;
}

/**
 * The customer types a search term names.
 *
 * Type is an enum column, so `contains` cannot reach it — Postgres will not
 * pattern-match an enum, and casting it in a Prisma filter is not expressible.
 * Matching the term against the values here and passing the survivors as an
 * `in` gets the same answer with a plain equality test.
 *
 * Both the stored value and the label are matched: an operator looking for
 * exporters types "export", not "EXPORTER", and would be equally right either
 * way. An empty result means the term names no type, and the caller leaves the
 * clause out rather than passing `in: []`, which would match nothing at all and
 * quietly break the other search terms beside it.
 */
function typesMatching(term: string): CustomerType[] {
  const needle = term.trim().toLowerCase();
  if (needle === '') return [];
  return CUSTOMER_TYPES.filter(
    (type) =>
      type.toLowerCase().includes(needle) ||
      CUSTOMER_TYPE_LABEL[type].toLowerCase().includes(needle),
  );
}

export function customerFilterWhere(query: CustomerFilter): Prisma.CustomerWhereInput {
  const types = query.search === undefined ? [] : typesMatching(query.search);
  return {
    deletedAt: null,
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.customerType !== undefined ? { customerType: query.customerType } : {}),
    // The client calls the commodity category "commodity"; it is the same
    // industry_sector the form already asks for.
    ...(query.industrySectorId !== undefined
      ? { industrySectorId: BigInt(query.industrySectorId) }
      : {}),
    ...(query.businessArea !== undefined ? { businessArea: query.businessArea } : {}),
    /*
     * The search box reaches the type and the commodity as well as the name,
     * because that is what an operator types into it: "garments", or
     * "exporter", expecting the list to narrow. The dropdowns beside it stay
     * — they are for picking one exactly, this is for finding.
     */
    ...(query.search !== undefined
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
            { country: { contains: query.search, mode: 'insensitive' as const } },
            {
              industrySector: {
                name: { contains: query.search, mode: 'insensitive' as const },
              },
            },
            ...(types.length > 0 ? [{ customerType: { in: types } }] : []),
          ],
        }
      : {}),
  };
}
