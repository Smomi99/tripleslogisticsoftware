import type { AgentType } from '@ff/shared';

import type { Prisma } from '../generated/prisma/client';

/**
 * The Agent list's filters as a where clause.
 *
 * One definition, because two screens read it: the list itself, and Email
 * prices, which writes to exactly the agents the list is showing. If the two
 * drifted, the button would mail people the operator never saw.
 */
export interface AgentFilter {
  search?: string | undefined;
  agentType?: AgentType | undefined;
  expertAreaId?: string | undefined;
  isActive?: boolean | undefined;
}

export function agentFilterWhere(query: AgentFilter): Prisma.AgentWhereInput {
  return {
    deletedAt: null,
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.agentType !== undefined ? { agentType: query.agentType } : {}),
    ...(query.expertAreaId !== undefined
      ? { expertAreas: { some: { expertAreaId: BigInt(query.expertAreaId) } } }
      : {}),
    ...(query.search !== undefined
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
            { country: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}
