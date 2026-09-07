/**
 * The console's client.
 *
 * This was 532 lines of untyped JavaScript inside index.html, and it is where
 * every recent defect lived — a hardcoded customer id racing its own config, a
 * button re-enabled by the wrong branch, a lock screen that set `hidden`
 * without hiding. None of it was type-checked and none of it was tested, which
 * is a poor place for the most-edited file in the repository to sit.
 *
 * It is TypeScript now, compiled with everything else. No framework and no
 * bundler: `tsc` emits one module the page loads directly.
 */

/** What the console's API returns. Narrow, and only what is actually read. */
type Identity = {
  brandName: string;
  accountHandle: string;
  testerHandle: string;
  testerCustomerId: string;
};

type ThreadSummary = {
  customerId: string;
  username: string | null;
  lastSeenAt: number;
  messages: number;
  /** 'pending' while the Opener sits unaccepted in their message requests. */
  requestState?: 'none' | 'pending' | 'accepted';
};

type ToolCall = { tool: string; ok: boolean; ms: number; args: unknown };

type TurnStats = { modelCalls: number; modelMs: number; toolMs: number; escalated: boolean };

type ThreadMessage = {
  role: 'customer' | 'concierge';
  text: string;
  at: number;
  stats?: TurnStats;
  trace: ToolCall[];
};

type Thread = { customerId: string; username: string | null; messages: ThreadMessage[] };

type Withheld = { commentId: string; reason: string; at: number };

type ActivityRow = { at: number; kind: string; code?: string; detail?: string; text: string };

type Gate = { enabled: boolean; reason: string | null };

type SimulateResult = { ok: boolean; status: number; body: string; eventId: string };

/** One simulated Delivery, as the console asks for it. */
type SimulatePayload = {
  kind: 'message' | 'comment' | 'forged';
  text?: string;
  eventId?: string | null;
  customerId?: string | null;
  username?: string | null;
  ageHours?: number;
};

/**
 * An element the page is known to contain.
 *
 * Throws rather than returning null: every id here is written in index.html a
 * few hundred lines above, so a miss is a typo at author time, not a state the
 * running console should try to survive. Failing loudly beats `undefined`
 * spreading quietly through the DOM calls.
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`console: #${id} is missing from the page`);
  return el as T;
};

/**
 * The shared password, and every request that carries it.
 *
 * `fetch` is wrapped once rather than each call site being edited, so a route
 * added later cannot forget the header. A 401 raises the unlock screen instead
 * of failing silently — the deployed console is behind one password, and the
 * only useful thing to do with a rejection is ask for it again.
 *
 * Kept in localStorage so a reload does not ask twice. It is a shared demo
 * password, not a credential: the gate exists to stop a public URL spending
 * model credits, not to establish who anyone is.
 */
const PASSWORD_KEY = 'concierge.password';
const rawFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const password = localStorage.getItem(PASSWORD_KEY);

  if (password && url.startsWith('/api/')) {
    init = {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'x-console-password': password },
    };
  }

  const response = await rawFetch(input, init);
  if (response.status === 401) showLock('That password was not accepted.');
  return response;
};

function showLock(message?: string): void {
  $('lock').hidden = false;
  $('lock-error').textContent = message ?? '';
  $<HTMLInputElement>('lock-input').focus();
}

/** Probes a gated route; the answer decides whether the console is usable. */
async function unlocked(): Promise<boolean> {
  try {
    const password = localStorage.getItem(PASSWORD_KEY);
    const headers: Record<string, string> = password ? { 'x-console-password': password } : {};
    return (await rawFetch('/api/identity', { headers })).status !== 401;
  } catch {
    return true; // A network failure is not a locked door; let the page say so.
  }
}
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Bare URLs are what the concierge sends, so link them without rewriting the text.
const linkify = (text: string): DocumentFragment => {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(https?:\/\/\S+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a');
      a.href = part; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = part.length > 42 ? part.slice(0, 42) + '…' : part;
      frag.append(a);
    } else if (part) {
      frag.append(document.createTextNode(part));
    }
  }
  return frag;
};

let current: string | null = null;

/**
 * What the model asked for, in full.
 *
 * This was clipped at 38 characters, which cut exactly the part worth reading:
 * a search whose intent is "customer wants something for a steak dinner"
 * rendered as "intent: customer wants something for a s…". The arguments are
 * the evidence that the model chose this call rather than fell into a branch,
 * so they wrap instead.
 */
const argSummary = (args: unknown): string => {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('  ');
};

/**
 * Renders the ledger.
 *
 * Nothing is truncated and nothing is dropped. The previous version clipped
 * each line with an ellipsis and kept only the last fourteen, which quietly
 * threw away the evidence this panel exists to show — the reason a signature
 * was refused, the reason an Opener was withheld. Both are the whole point.
 *
 * `textContent` throughout: these strings are log lines, and one of them is a
 * Customer's own comment.
 */
async function loadActivity(): Promise<void> {
  const rows = (await (await fetch('/api/activity')).json()) as ActivityRow[];
  $('activity-count').textContent = rows.length ? `${rows.length}` : '';

  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-row';
    li.textContent = 'Nothing yet. Every delivery the receiver accepts or refuses lands here.';
    return $('activity').replaceChildren(li);
  }

  $('activity').replaceChildren(...rows.map((r: ActivityRow) => {
    const li = document.createElement('li');
    li.className = r.kind;

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = new Date(r.at).toLocaleTimeString([], { hour12: false });

    const body = document.createElement('span');
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = r.code ?? r.text;
    body.append(code);

    // Only when it says something the code does not already say.
    if (r.detail && r.detail !== r.code) {
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = r.detail;
      body.append(detail);
    }

    li.append(time, body);
    return li;
  }));
}

async function loadThreads(): Promise<void> {
  const threads = (await (await fetch('/api/threads')).json()) as ThreadSummary[];
  const list = $('threads');
  list.replaceChildren();

  for (const t of threads) {
    const b = document.createElement('button');
    b.className = 'thread-link';
    b.type = 'button';
    b.setAttribute('aria-current', String(t.customerId === current));
    const pending = t.requestState === 'pending';
    b.innerHTML = `<b>${t.username ? '@' + t.username : t.customerId}</b>
                   <small>${t.messages} message${t.messages === 1 ? '' : 's'} · ${time(t.lastSeenAt)}</small>`;
    if (pending) {
      // The opener has gone out and is waiting in their requests, unaccepted.
      const tag = document.createElement('small');
      tag.className = 'pending';
      tag.textContent = 'request pending';
      b.append(tag);
    }
    b.onclick = () => openThread(t.customerId);
    list.append(b);
  }

  /**
   * Withheld Openers never became a Conversation, so they appear nowhere else.
   * The reason is the substance of the row — it is the record of a judgement
   * call — so it is written in full rather than summarised.
   */
  const withheld = (await (await fetch('/api/withheld')).json()) as Withheld[];
  $('withheld-group').hidden = withheld.length === 0;
  $('withheld-count').textContent = withheld.length ? `${withheld.length}` : '';
  $('withheld').replaceChildren(...withheld.map((w: Withheld) => {
    const d = document.createElement('div');
    d.className = 'withheld-item';

    const id = document.createElement('b');
    id.textContent = w.commentId;

    const reason = document.createElement('span');
    reason.textContent = w.reason;

    const when = document.createElement('time');
    when.textContent = new Date(w.at).toLocaleTimeString([], { hour12: false });

    d.append(id, reason, when);
    return d;
  }));

  /**
   * Open something, always.
   *
   * The composer sets `current` before firing, so a message sent into an empty
   * console left `current` pointing at a conversation the main pane had never
   * rendered — the thread existed in the rail and the reply was stored, but the
   * screen stayed empty and the send looked like it had failed.
   */
  const first = threads[0];
  if (!first) return;
  if (!current || !threads.some((t: ThreadSummary) => t.customerId === current)) {
    void openThread(first.customerId);
  }
}

/**
 * The pane that actually scrolls.
 *
 * `.log` carries `overflow-y: auto` but never gets a height cap, so it grows to
 * fit its contents and the *document* is what scrolls. Reading scroll state off
 * `.log` therefore always says "no overflow" and every stick-to-bottom check
 * silently passes. Ask which element is really scrolling instead of assuming.
 */
function scroller(): HTMLElement {
  const log = $('log');
  // scrollingElement is null only in a detached document; the body is the fallback.
  return log.scrollHeight > log.clientHeight
    ? log
    : ((document.scrollingElement as HTMLElement | null) ?? document.body);
}

const atBottom = (s: HTMLElement, slack = 140): boolean => s.scrollHeight - s.clientHeight - s.scrollTop < slack;

/** Which thread is on screen, and how much of it, so a re-render can tell new from same. */
let rendered: { customerId: string | null; messages: number } = { customerId: null, messages: -1 };

async function openThread(customerId: string): Promise<void> {
  current = customerId;
  const data = await (await fetch(`/api/threads/${encodeURIComponent(customerId)}`)).json();

  /**
   * Sampled before the DOM is replaced, because replaceChildren resets the
   * measurements this decides on.
   *
   * The poll re-renders every 3s, so scrolling unconditionally would drag the
   * page down while someone is reading back through the history. It follows
   * only when a reply actually arrived and they were already at the bottom —
   * and jumps outright when the thread changed, where there is no position
   * worth keeping.
   */
  const switched = rendered.customerId !== customerId;
  const grew = data.messages.length > rendered.messages;
  const wasAtBottom = atBottom(scroller());

  $('who').textContent = data.username ? '@' + data.username : customerId;
  $('meta').textContent = `${data.messages.length} messages`;

  const log = $('log');
  log.replaceChildren();

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent =
    'These replies were composed and stored but not delivered — Instagram gates outbound sends until the app is in Live mode. Everything to the right is what the concierge actually did to produce them.';
  log.append(note);

  for (const m of data.messages) {
    const turn = document.createElement('div');
    turn.className = `turn from-${m.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.append(linkify(m.text));
    turn.append(bubble);

    const trace = document.createElement('div');
    trace.className = 'trace';
    if (m.role === 'concierge') {
      if (m.trace.length === 0) {
        trace.innerHTML = '<div class="none">answered without a tool</div>';
      } else {
        for (const c of m.trace) {
          const row = document.createElement('div');
          row.innerHTML = `<span class="tool ${c.ok ? '' : 'failed'}">${c.tool}</span>
                           <span class="ms">${c.ms}ms</span>`;
          trace.append(row);

          // The arguments are the evidence that the model chose this, not a branch.
          const args = argSummary(c.args);
          if (args) {
            const a = document.createElement('div');
            a.className = 'args';
            a.textContent = args;
            trace.append(a);
          }
        }
      }
      if (m.stats) {
        const st = document.createElement('div');
        st.className = 'stats' + (m.stats.escalated ? ' escalated' : '');
        st.textContent = m.stats.escalated
          ? `escalated · ${m.stats.modelCalls} model calls`
          : `model ${m.stats.modelMs}ms × ${m.stats.modelCalls} · tools ${m.stats.toolMs}ms`;
        trace.append(st);
      }
    }
    turn.append(trace);
    log.append(turn);
  }

  rendered = { customerId, messages: data.messages.length };

  if (switched || (grew && wasAtBottom)) {
    const s = scroller();
    s.scrollTo({ top: s.scrollHeight, behavior: switched ? 'auto' : 'smooth' });
  }

  loadThreadsHighlight();
}

function loadThreadsHighlight() {
  for (const b of document.querySelectorAll('.thread-link')) {
    const label = b.querySelector('b')?.textContent ?? '';
    b.setAttribute('aria-current', String(label.replace('@', '') === current || label === current));
  }
}

// ── driving the demo ────────────────────────────────────────────────────────
// Every button posts to /api/simulate, which signs the bytes and POSTs them at
// our own webhook. Nothing here reaches inside the system.
/**
 * Who the console speaks as, and who it speaks to.
 *
 * Filled from `/api/identity` at boot rather than hardcoded, because these are
 * three separate identities and the page had been printing the wrong one as its
 * title: the brand is who the Concierge speaks *as*, the account is the inbox it
 * speaks *through*, and the tester is the Customer on the other end.
 *
 * There is deliberately no fallback Customer. A literal here would be a second
 * source of truth for identity, and the first version of this had one: the
 * composer went live with a hardcoded `slittone-1` while the fetch was still in
 * flight, so an early click opened a Conversation under an id the configuration
 * had never heard of. Identity comes from configuration or the console does not
 * send — the same rule the Receiver follows for Customers.
 */
let CUSTOMER: string | null = null;
let HANDLE: string | null = null;
let lastEventId: string | null = null;

const result = (text: string, bad = false): void => {
  const el = $('result');
  el.textContent = text;
  el.className = 'result' + (bad ? ' bad' : '');
};

/**
 * What the composer is allowed to do, and why.
 *
 * `identity` and `simulate` gate sending. `reset` gates clearing separately,
 * because the two are refused for different reasons and one is far worse:
 * simulating against a live dispatcher would put fabricated conversations in
 * front of real people, while clearing would hand back Openers the platform
 * grants exactly once. Clear sits inside `.composer`, so without its own gate a
 * re-enable here would quietly undo that refusal.
 */
const gates = { identity: false, simulate: false, reset: false };

function refreshComposer(reason?: string): void {
  const ready = gates.identity && gates.simulate;
  for (const el of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
    '.composer button, .composer input',
  )) {
    el.disabled = !ready;
  }
  if (ready) {
    $<HTMLButtonElement>('redeliver').disabled = !lastEventId;
    // Never re-enabled by a send finishing; only its own check clears it.
    $<HTMLButtonElement>('clear').disabled = !gates.reset;
  }
  if (!ready && reason) result(reason, true);
}

// Locked until we know who we are.
refreshComposer();


async function fire(payload: SimulatePayload, label: string): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.composer button')) b.disabled = true;
  result(`${label}…`);
  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      result(data.error ?? 'refused', true);
    } else {
      if (payload.kind !== 'forged') lastEventId = data.eventId;
      result(`${data.status} ${data.body}`, data.status !== 200);
    }
  } catch (e) {
    result(String((e as Error).message), true);
  } finally {
    refreshComposer();
    // The reply takes a few seconds; poll a little more eagerly for a moment.
    for (const wait of [1200, 3000, 6000, 9000, 13000]) setTimeout(() => { loadThreads(); loadActivity(); }, wait);
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $<HTMLInputElement>('text').value.trim();
  if (!text) return;
  $<HTMLInputElement>('text').value = '';
  // Set after the send, not before: pointing at a thread that does not exist
  // yet is what made the first message look like it had vanished.
  fire({ kind: 'message', text, customerId: CUSTOMER }, 'sending message').then(() => {
    current = CUSTOMER;
  });
});

$('comment').onclick = () => {
  const text = $<HTMLInputElement>('text').value.trim() || 'obsessed with this red blend 😍 is it good with steak?';
  $<HTMLInputElement>('text').value = '';
  fire({ kind: 'comment', text, customerId: CUSTOMER, username: HANDLE }, 'leaving comment').then(() => {
    current = CUSTOMER;
  });
};

$('noise').onclick = () =>
  fire({ kind: 'comment', text: '🔥🔥🔥', customerId: 'noise-' + Date.now() }, 'leaving comment');

/**
 * The platform's two clocks, made clickable.
 *
 * Both were enforced from the first commit and neither could be shown: every
 * simulated Event was stamped "now", so the reply window was permanently fresh
 * and the comment window permanently open. A rule you cannot trigger is one a
 * walkthrough has to take on faith.
 *
 * Nothing special happens on the server. The Delivery is signed and POSTed like
 * any other; only its timestamp is older. `last_seen_at` is written from that
 * timestamp, and the opener policy reads it, so the ordinary code path reaches
 * its own guard — watch the activity feed turn `blocked`.
 */
$('stale').onclick = () =>
  fire(
    { kind: 'message', text: 'still thinking about that cabernet', customerId: CUSTOMER, ageHours: 25 },
    'sending a 25-hour-old message',
  ).then(() => { current = CUSTOMER; });

// Eight days: past the seven the platform allows, so the Opener is withheld
// and lands in the withheld panel rather than becoming a Conversation.
$('oldcomment').onclick = () =>
  fire(
    {
      kind: 'comment',
      text: 'is this one still in stock?',
      customerId: 'stale-' + Date.now(),
      username: HANDLE,
      ageHours: 8 * 24,
    },
    'leaving an 8-day-old comment',
  );

// Same event id — Meta redelivering. Should be accepted: 0.
$('redeliver').onclick = () =>
  fire({ kind: 'message', text: '(redelivery)', eventId: lastEventId, customerId: CUSTOMER }, 'redelivering');

$('forge').onclick = () => fire({ kind: 'forged' }, 'sending forged signature');

/**
 * Clear everything, so a demo starts from nothing.
 *
 * Not routed through `fire` — that signs a Delivery and POSTs it at the
 * webhook, which is right for anything that should cross the trust boundary and
 * wrong for this. Clearing is a console operation, not an Event.
 *
 * The server refuses it while the dispatcher is live, and says why. The confirm
 * here is only about the scrollback: history is the whole record of what the
 * Concierge did, and there is no undo.
 */
$('clear').onclick = async () => {
  if (!window.confirm('Clear every conversation, turn and opener decision? This cannot be undone.')) return;

  result('clearing…');
  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return result(data.error ?? 'refused', true);

    // Nothing is on screen any more, so drop the selection rather than polling
    // for a thread that no longer exists.
    current = null;
    rendered = { customerId: null, messages: -1 };
    lastEventId = null;
    $<HTMLButtonElement>('redeliver').disabled = true;
    $('who').textContent = 'Pick a conversation';
    $('meta').textContent = '';
    $('log').replaceChildren();
    await Promise.all([loadThreads(), loadActivity()]);
    result('cleared');
  } catch (e) {
    result(String((e as Error).message), true);
  }
};


$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $<HTMLInputElement>('lock-input').value.trim();
  if (!value) return;
  localStorage.setItem(PASSWORD_KEY, value);

  if (await unlocked()) {
    $('lock').hidden = true;
    $<HTMLInputElement>('lock-input').value = '';
    start();
  } else {
    localStorage.removeItem(PASSWORD_KEY);
    $('lock-error').textContent = 'That password was not accepted.';
  }
});

/** Everything that polls or fetches. Held back until the console is unlocked. */
function start(): void {
  loadThreads();
  loadActivity();

  fetch('/api/identity').then((r) => r.json()).then((id) => {
    CUSTOMER = id.testerCustomerId;
    HANDLE = id.testerHandle;
    $('brand').innerHTML = `${id.brandName} <span>· concierge</span>`;
    $('account').textContent = '@' + id.accountHandle;
    $<HTMLInputElement>('text').placeholder = `Message the concierge as @${id.testerHandle}…`;
    gates.identity = true;
    refreshComposer();
  }).catch(() => refreshComposer('could not read /api/identity'));

  fetch('/api/simulate').then((r) => r.json()).then((s) => {
    gates.simulate = s.enabled;
    refreshComposer(s.enabled ? undefined : s.reason);
  }).catch(() => refreshComposer('could not reach /api/simulate'));

  fetch('/api/reset').then((r) => r.json()).then((s) => {
    gates.reset = s.enabled;
    if (!s.enabled) $('clear').title = s.reason;
    refreshComposer();
  }).catch(() => { gates.reset = false; refreshComposer(); });

  // Re-open the current thread each tick so a reply appears without a click.
  setInterval(() => {
    loadThreads();
    loadActivity();
    if (current) openThread(current);
  }, 3000);
}

unlocked().then((ok) => (ok ? start() : showLock()));
