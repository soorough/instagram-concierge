# Decisions, and what I punted

**One entrypoint, and it is the trust boundary.** Verify the signature over raw
bytes, then assert the brand account *separately* — one app secret signs every
surface on an app, so a valid signature proves Meta sent something, not whose
account it concerns. Identity comes from that pipeline and nowhere else.

**Idempotency keys on the event, not the delivery** — one POST can carry several,
and claims are written before the work. A crash loses a reply rather than sending
two. For an opener that is not a preference: a comment grants one DM permanently,
so a duplicate is unrecoverable.

**The agent may stay silent.** Spending that one message on "🔥🔥🔥" is worse than
silence, so it can decline and records why. Decided in a millisecond or two,
because it never calls the model. It is the only real judgement call in the flagship workflow and I wanted it
visible.

**The store prices everything.** The model may not state a total it wasn't given.
Two bottles at $38 came back as $64.60 — a 15% sitewide sale — and the agent
repeated the store's own figures instead of doing arithmetic. Finding it took a
correction: Shopify folds a line discount into the cart subtotal before
reporting, so the cart-level check I shipped first could never fire.

**Tool names are discovered at boot.** The brief names `search_shop_catalog`; no
storefront serves that any more.

**Shipping is a rule, not a fact.** The store answers shipping at *country*
granularity, so a model reading "we ship to the US" will say it ships to Utah —
which it may not. No prompt wording fixes data at the wrong resolution, so the
prohibited states are a list in `config/brand.json`. Still model-enforced rather
than structural: I would rather say that than imply a rail I did not build.

## Punted

Profile enrichment succeeding — the fetch is attempted (the brief's pipeline has
it), but the endpoint is consent-gated and a commenter hasn't consented, so it
fails and the prompt says so. The post *is* readable, so the opener is grounded
in its caption plus their username and verbatim comment.

An age gate, on an alcohol catalog. A deterministic price rail to make the
prompt's rule structural. Attachments, parsed and skipped. Dashboards,
deployment, multi-brand, auth — named as not required.

## The platform limit

Live events and outbound sends need Live mode → Advanced Access → App Review,
excluded by the brief. Tested, not assumed: with both accounts as Instagram
Testers, a real DM produced zero deliveries. So I substituted **event contents and
nothing else** — Meta still issues and signs the POST, and the receiver verifies
it. `fixtures/` holds two real signed deliveries.

Nine assumptions were wrong and each would have shipped — among them: the Meta
app secret does not sign webhooks (the Instagram one does), deliveries carry
`changes[]` not `messaging[]`, the same store returns money in two shapes, a
cart-level discount check cannot see a line-level discount, and catalog search
never returns an empty result. None came from reading — each came from running
the thing. Detail: `docs/platform-findings.md`.
