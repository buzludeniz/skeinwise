// The agents' requests that wait for the person's yes (src/mcp/requests.ts). An agent may ask to leave a thread out or
// to undo one of its own runs, but nothing changes until the person confirms it here or with `skeinwise mcp confirm`.
// Both read the same list, so a request answered on one side is gone from the other.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, X } from 'lucide-preact';
import { loadRecord, message, toast } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate } from '../format.ts';
import type { AgentRequest } from '../types.ts';
import { Button } from './common.tsx';

/** The waiting requests, oldest first, each with Confirm and Refuse. Nothing shows while none waits. */
export function AgentRequests() {
  const [requests, setRequests] = useState<AgentRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Once one is answered, the card stays with a line that nothing else waits, so focus has somewhere to go.
  const [answered, setAnswered] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusRow = useRef<number | null>(null);

  const load = () =>
    api.get<AgentRequest[]>('requests').then(
      (r) => {
        setRequests(r);
        setError(null);
      },
      (e) => setError(message(e)),
    );
  useEffect(() => {
    void load();
  }, []);

  // An answered request leaves the list, and its buttons with it: focus goes to the row that took its place, or to the
  // heading when none is left.
  useEffect(() => {
    const at = focusRow.current;
    if (at === null || !requests) return;
    focusRow.current = null;
    const row = requests.length ? list.current?.children[Math.min(at, requests.length - 1)] : null;
    (row?.querySelector<HTMLElement>('button') ?? heading.current)?.focus();
  }, [requests]);

  const answer = async (r: AgentRequest, yes: boolean, at: number) => {
    setBusy(true);
    try {
      if (yes) {
        await api.post(`requests/${r.id}/confirm`);
        await loadRecord();
        toast(`Done: ${r.what}.`, { tone: 'ok' });
      } else {
        await api.post(`requests/${r.id}/refuse`);
        toast(`Refused: ${r.what}. Nothing changed.`);
      }
    } catch (e) {
      // A 409 says why the change can no longer be made, and the request is dropped either way; a 404 means it was
      // answered elsewhere or ran out. The list is read again below, so it shows what still waits.
      toast(message(e), { tone: 'error' });
    }
    setBusy(false);
    setAnswered(true);
    focusRow.current = at;
    await load();
  };

  if (error) return <p class="set-note" role="alert">Couldn’t read the agents’ requests: {error}</p>;
  if (!requests || (!requests.length && !answered)) return null;
  return (
    <section class="card agent-requests" aria-labelledby="agent-requests-h">
      <h4 id="agent-requests-h" tabIndex={-1} ref={heading}>
        Waiting for your yes
      </h4>
      {requests.length ? (
        <>
          <p class="soft small">An agent asked for these changes. Nothing changes until you confirm one.</p>
          <ul ref={list}>
            {requests.map((r, i) => (
              <li key={r.id}>
                {/* `what` carries a thread title from the record: it is shown as text, never as markup. */}
                <p class="request-what" id={`agent-request-${r.id}`}>
                  {r.what}
                </p>
                <p class="soft small">
                  {r.agent} asked on {fmtDate(r.at)} · request #{r.id}
                </p>
                <div class="request-actions">
                  <Button icon={Check} kind="primary" small disabled={busy} aria-describedby={`agent-request-${r.id}`} onClick={() => answer(r, true, i)}>
                    Confirm
                  </Button>
                  <Button icon={X} small disabled={busy} aria-describedby={`agent-request-${r.id}`} onClick={() => answer(r, false, i)}>
                    Refuse
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p class="soft small">Nothing else waits for your yes.</p>
      )}
    </section>
  );
}
