# Decisions, and what I punted

**The webhook is the only way in, and it's the trust boundary.** Verify the
signature over the raw bytes, then check the brand account *separately* — one app
secret signs every surface on an app, so a good signature proves Meta sent
something, not whose account it's about. Idempotency claims the event before the
work, so a crash loses a reply instead of sending two.

**It's allowed to say nothing.** A comment earns exactly one DM, ever, so
spending it on "🔥🔥🔥" is worse than staying quiet. It declines in a millisecond
without calling the model, and writes down why — a message you didn't send leaves
no other trace.

**The store prices everything.** Two bottles at $38 came back as $64.60 on a 15%
sitewide sale, and the agent repeated the store's numbers instead of doing the
arithmetic. It can't quote a total it wasn't handed.

**Shipping is a rule, not a fact.** The store answers at country granularity, so
a model reading "we ship to the US" will tell you it ships to Utah — which it may
not. Wine is regulated state by state, so the prohibited states live in
`config/brand.json` as data.

**The message request is modelled, not observed.** A private reply lands in the
recipient's requests folder, and that much is Instagram's. The pending state is
mine — the API exposes no request status and no accept event. Their reply is the
only real signal, so a reply accepts it.

**Two things follow the brief's example over my instinct.** There's no automation
disclosure, because the brief's opener doesn't carry one — Meta requires it, and
California's bot law requires it when you're incentivising a sale, so production
puts the clause back. And the first name comes from config, because you only get
someone's id once the platform delivers an event about them, which is the thing
that's gated.

## Punted

An age gate, on an alcohol catalog. Moving the shipping rule out of the prompt
and into code. Promoting the price check from eval to runtime. Profile enrichment
succeeding — attempted, and it fails honestly. Attachments, parsed and skipped.
Dashboards, multi-brand, auth.

## The platform limit

Live events and outbound sends need Advanced Access and App Review, which the
brief excludes. Tested, not assumed: a real comment produced zero deliveries,
while Meta's own test deliveries hit the same URL two minutes earlier and
verified fine. So I substituted **the contents of an event and nothing else** —
Meta still signs the POST, and the receiver still checks it.

Nine assumptions turned out to be wrong along the way, and every one would have
shipped. The Meta app secret doesn't sign webhooks — the Instagram one does.
Deliveries carry `changes[]`, not `messaging[]`. Catalog search never returns
empty, so the real failure mode is irrelevance rather than emptiness. None came
from reading the docs — each came from running the thing and being wrong first.
