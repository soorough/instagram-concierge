# Decisions, and what I punted

**The webhook is the only entrypoint, and it is the trust boundary.** Verify the
signature over raw bytes, then assert the brand account *separately* — one app
secret signs every surface on an app, so a valid signature proves Meta sent
something, not whose account it concerns. Idempotency claims the event before the
work, so a crash loses a reply rather than sending two.

**The agent may stay silent.** A comment grants exactly one DM, permanently, so
spending it on "🔥🔥🔥" is worse than sending nothing. It declines in a
millisecond, without calling the model, and records why.

**The store prices everything.** Two bottles at $38 came back as $64.60 on a 15%
sitewide sale, and the agent repeated the store's figures rather than doing
arithmetic. It may not state a total it wasn't given.

**Shipping is a rule, not a fact.** The store answers at country granularity, so
a model reading "we ship to the US" will say it ships to Utah, which it may not.
Prohibited states live in `config/brand.json`.

**Two places I followed the brief's target feel over my instinct:** no automation
disclosure, since its example carries none — production restores it, and nothing
actually sends; and a configured first name, since an app-scoped id only exists
once the platform delivers an event about that person.

## Punted

An age gate on an alcohol catalog. A price rail to make the prompt's rule
structural. Profile enrichment succeeding — attempted, and it fails honestly.
Attachments, parsed and skipped. Dashboards, multi-brand, auth.

## The platform limit

Live events and outbound sends need Advanced Access and App Review, which the
brief excludes. Tested, not assumed: a real comment from a tester account
produced zero deliveries, while Meta's own test deliveries to the same URL
verified fine. So I substituted **event contents and nothing else** — Meta still
issues and signs the POST, and the receiver verifies it.

Nine assumptions turned out to be wrong along the way, and every one of them
would have shipped. The Meta app secret doesn't sign webhooks — the Instagram one
does. Deliveries carry `changes[]`, not `messaging[]`. The same store hands back
money in two different shapes. A cart-level discount check can't see a line-level
discount. Catalog search never returns empty, so the real failure mode is
irrelevance rather than emptiness. None of those came from reading the docs. Each
one came from running the thing and being wrong first.
