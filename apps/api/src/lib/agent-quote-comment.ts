import type { AgentQuoteCommentDto } from '@ff/shared';

import { withTenant } from './tenant-client';

/**
 * The Status thread, rendered for whoever is reading it.
 *
 * Shared by both doors onto the same conversation: the agent reaches it through
 * /agent/quotes/:id/comments, the forwarder through the inquiry screen. One
 * builder, so the two views cannot drift into disagreeing about who said what.
 */

/** What both callers must select on `author`. */
export interface CommentAuthorRow {
  agentId: bigint | null;
  username: string;
  agent: { name: string } | null;
  employee: { name: string } | null;
}

export interface CommentRow {
  id: bigint;
  body: string;
  outcome: string | null;
  createdAt: Date;
  author: CommentAuthorRow;
}

/**
 * Who is reading. It decides one thing only, and that thing matters: whether a
 * forwarder-side message is signed with the name of the person who typed it.
 *
 * An agent never learns which member of staff wrote what. That is the same
 * boundary agent_inquiry_v draws by omitting created_by and updated_by — an
 * outside company deals with the company, not with its org chart. Staff see
 * real names on both sides, because to them this is internal correspondence
 * with a supplier and knowing who promised what is the point.
 */
export type CommentViewer = 'AGENT' | 'STAFF';

export function commentToDto(
  row: CommentRow,
  viewer: CommentViewer,
  forwarderName: string,
): AgentQuoteCommentDto {
  const side = row.author.agentId === null ? 'FORWARDER' : 'AGENT';

  const authorName =
    side === 'AGENT'
      ? // An agent login belongs to the company, not to a person — every one of
        // their contacts shares it — so the company name is the true author.
        (row.author.agent?.name ?? row.author.username)
      : viewer === 'AGENT'
        ? forwarderName
        : (row.author.employee?.name ?? row.author.username);

  return {
    id: row.id.toString(),
    body: row.body,
    outcome: row.outcome,
    authorName,
    authorSide: side,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The `select` both callers pass, so the shapes cannot fall out of step. */
export const COMMENT_SELECT = {
  id: true,
  body: true,
  outcome: true,
  createdAt: true,
  author: {
    select: {
      agentId: true,
      username: true,
      agent: { select: { name: true } },
      employee: { select: { name: true } },
    },
  },
} as const;

/**
 * Author details for a set of comments, read outside the agent's own scope.
 *
 * `user` is one of the tables Phase 3 closed to agents, and rightly so — but
 * that means an agent session joining `author` gets null back, and a thread
 * where nobody is attributed is not a thread. So the join is done with
 * withTenant, exactly as nextCode allocates outside agent scope for its own
 * reason.
 *
 * The server reads more than the agent receives, which is the whole point:
 * commentToDto still renders a staff author as the forwarder's company name.
 * Nothing about the individual crosses the wire.
 */
export async function resolveAuthors(
  tenantId: bigint,
  authorIds: bigint[],
): Promise<Map<string, CommentAuthorRow>> {
  const unique = [...new Set(authorIds.map((id) => id.toString()))].map((id) => BigInt(id));
  if (unique.length === 0) return new Map();

  const rows = await withTenant(tenantId, (db) =>
    db.user.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        agentId: true,
        username: true,
        agent: { select: { name: true } },
        employee: { select: { name: true } },
      },
    }),
  );
  return new Map(rows.map((row) => [row.id.toString(), row]));
}

/** What the agent-side handlers select: no join, because they cannot make one. */
export const COMMENT_SELECT_FLAT = {
  id: true,
  body: true,
  outcome: true,
  createdAt: true,
  authorId: true,
} as const;

export interface FlatCommentRow {
  id: bigint;
  body: string;
  outcome: string | null;
  createdAt: Date;
  authorId: bigint;
}

/** Joins a flat row back to its author before rendering it. */
export function flatCommentToDto(
  row: FlatCommentRow,
  authors: Map<string, CommentAuthorRow>,
  viewer: CommentViewer,
  forwarderName: string,
): AgentQuoteCommentDto {
  const author = authors.get(row.authorId.toString()) ?? {
    // An author whose account has since been removed. The message stays — an
    // append-only record does not lose entries because someone left.
    agentId: null,
    username: 'Someone',
    agent: null,
    employee: null,
  };
  return commentToDto(
    { id: row.id, body: row.body, outcome: row.outcome, createdAt: row.createdAt, author },
    viewer,
    forwarderName,
  );
}
