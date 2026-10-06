import { customerPriceEmailRecipientQuerySchema } from '@ff/shared';
import type { Router } from 'express';

import { customerFilterWhere } from '../lib/customer-filter';
import { createPriceEmailRouter } from './price-email.route';

/**
 * CRM → Customer → Email prices (2026-09-29).
 *
 * The screen, the rates and the letter are price-email.route's; this says
 * only who the customers are. CRM.CUSTOMER.PRICE_EMAIL on every route.
 */
export const CUSTOMER_PRICE_OFFER = 'CUSTOMER_PRICE_OFFER';

export const customerPriceEmailRouter: Router = createPriceEmailRouter({
  party: 'customer',
  permission: 'CRM.CUSTOMER.PRICE_EMAIL',
  templateKey: CUSTOMER_PRICE_OFFER,
  recipientQuery: customerPriceEmailRecipientQuerySchema,
  findRecipients: (db, query, take) =>
    db.customer.findMany({
      // Active only: a deactivated customer is one we have stopped dealing with.
      where: customerFilterWhere({ ...query, isActive: true }),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
      select: {
        id: true,
        code: true,
        name: true,
        pics: {
          where: { deletedAt: null, isActive: true, email: { not: null } },
          orderBy: { id: 'asc' },
          select: { name: true, email: true },
        },
      },
    }),
  findActive: (db, ids) =>
    db.customer.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      // The outbox fills in a stable order, the one the recipients were listed in.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
});
