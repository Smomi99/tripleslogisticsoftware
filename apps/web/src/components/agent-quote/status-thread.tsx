'use client';

import { type AgentQuoteCommentDto } from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The Status thread on an agent quotation.
 *
 * "all the comments will appear here … finally when we won or lost then
 * appear." One conversation, two doors: the agent reaches it from their own
 * quote, the forwarder from the inquiry. Both render through this component so
 * neither side can be shown a different history of what was said.
 *
 * The endpoint differs between them, so it is passed in. Everything else —
 * ordering, attribution, how an outcome reads — is decided once, here.
 */
export function StatusThread({
  endpoint,
  canPost,
  emptyHint,
}: {
  /** Base path; the component GETs it and POSTs to it. */
  endpoint: string;
  /** False for a reader who may see the thread but not add to it. */
  canPost: boolean;
  emptyHint: string;
}) {
  const { authorizedList: list, authorizedRequest: request } = useSession();
  const [comments, setComments] = useState<AgentQuoteCommentDto[] | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await list<AgentQuoteCommentDto[]>(endpoint);
      setComments(result.data);
    } catch {
      setComments([]);
      setError('Could not load the messages on this quotation.');
    }
  }, [list, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(async () => {
    const text = body.trim();
    if (text === '') return;
    setPending(true);
    setError(null);
    try {
      const saved = await request<AgentQuoteCommentDto>(endpoint, {
        method: 'POST',
        body: { body: text },
      });
      setComments((current) => [...(current ?? []), saved]);
      setBody('');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not send that message. Try again in a moment.',
      );
    } finally {
      setPending(false);
    }
  }, [body, endpoint, request]);

  return (
    <div className="flex flex-col gap-3">
      {comments === null ? (
        <p className="text-cell text-steel">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-cell text-steel">{emptyHint}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className={
                // An outcome is the end of the conversation, not another
                // remark, so it does not look like one.
                comment.outcome === null
                  ? 'rounded-manifest border border-line bg-surface p-3'
                  : comment.outcome === 'WON'
                    ? 'rounded-manifest border border-verified/40 bg-verified/5 p-3'
                    : 'rounded-manifest border border-alert/40 bg-alert/5 p-3'
              }
            >
              <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-cell font-semibold text-hull">{comment.authorName}</span>
                <span className="label-manifest">
                  {comment.authorSide === 'AGENT' ? 'Agent' : 'Forwarder'}
                </span>
                {comment.outcome !== null && (
                  <span
                    className={
                      comment.outcome === 'WON'
                        ? 'text-cell font-semibold text-verified'
                        : 'text-cell font-semibold text-alert'
                    }
                  >
                    {comment.outcome === 'WON' ? 'Won' : 'Lost'}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] tabular-nums text-steel">
                  {comment.createdAt.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-body text-hull">{comment.body}</p>
            </li>
          ))}
        </ol>
      )}

      {canPost && (
        <div className="flex flex-col gap-2">
          <label htmlFor="comment-body" className="label-manifest">
            Add a message
          </label>
          <textarea
            id="comment-body"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            placeholder="Both sides can see everything written here."
          />
          <div>
            <Button
              type="button"
              size="compact"
              onClick={() => void post()}
              disabled={pending || body.trim() === ''}
            >
              {pending ? 'Sending…' : 'Send message'}
            </Button>
          </div>
        </div>
      )}

      {error !== null && <p className="text-cell text-alert">{error}</p>}
    </div>
  );
}
