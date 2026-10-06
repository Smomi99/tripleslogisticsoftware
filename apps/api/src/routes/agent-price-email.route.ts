import { agentPriceEmailRecipientQuerySchema } from '@ff/shared';
import type { Router } from 'express';

import { agentFilterWhere } from '../lib/agent-filter';
import { createPriceEmailRouter } from './price-email.route';

/**
 * CRM → Agent → Email prices (2026-10-06): the customer's Email prices, for
 * the agents on the Agent list — the same in every respect, selling prices
 * only included.
 *
 * The screen, the rates and the letter are price-email.route's; this says
 * only who the agents are. CRM.AGENT.PRICE_EMAIL on every route.
 */
export const AGENT_PRICE_OFFER = 'AGENT_PRICE_OFFER';

export const agentPriceEmailRouter: Router = createPriceEmailRouter({
  party: 'agent',
  permission: 'CRM.AGENT.PRICE_EMAIL',
  templateKey: AGENT_PRICE_OFFER,
  recipientQuery: agentPriceEmailRecipientQuerySchema,
  findRecipients: (db, query, take) =>
    db.agent.findMany({
      // Active only: a deactivated agent is one we have stopped working with.
      where: agentFilterWhere({ ...query, isActive: true }),
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
    db.agent.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      // The outbox fills in a stable order, the one the recipients were listed in.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
});
