# Platform findings

Established by direct experiment against a live Meta app on 2026-09-06, not from
documentation. Each claim below names the evidence that produced it.

## Setup that exists

Identifiers below are redacted — this repository is public and the app is real.
The *shape* is preserved because two of these findings are about shape: an
account has two different ids depending on which surface you ask, and both
appear in the wild.

| Thing | Value |
|---|---|
| Meta app | `daakhiya concierge`, App ID `<meta app id>` |
| Instagram app | `daakhiya concierge-IG`, App ID `<instagram app id>` |
| Brand account | `@daakiyah`, professional (BUSINESS) |
| Instagram account ID | `17841400000000000` (shown in dashboard) |
| App-scoped user ID | `38097900000000000` (returned by `GET /me`) |
| Token permissions | basic, manage_messages, manage_comments, content_publish, manage_insights |
| Token lifetime | ~60 days (`expires_in` 5,183,917s) |
| Webhook fields | `messages`, `comments` — both subscribed |
| App state | **Unpublished** |

## 1. An unpublished app receives no webhook deliveries

Two explanations were possible: publish state, or Meta's rule that a development
app only sees events involving people who hold a role on it. Both were tested.

**Round 1** — brand account `@daakiyah` held the Instagram Tester role; the sender
`@slittone` held none. DM sent. No delivery.

**Round 2** — `@slittone` added as an Instagram Tester and the invite accepted, so
both parties held roles. Subscription re-verified as `["messages","comments"]`.
DM sent. **Still no delivery.**

Across both rounds the tunnel saw exactly three requests, all of them ours or
Meta's one-time verification:

    GET  /webhooks/instagram?hub.mode=subscribe...  -> 200  UA=facebookplatform/1.0
    GET  ... (local test)                           -> 403  UA=curl   (wrong token)
    GET  ... (local test)                           -> 200  UA=curl

Zero POSTs, ever. The role hypothesis is eliminated; publish state is the binding
constraint, exactly as the dashboard states.

## 2. Inbound message data is withheld too, not just pushes

Polling was the obvious fallback. It does not work either. Checked with the
message request accepted, and again after both accounts held tester roles:

    GET /me/conversations                    -> {"data":[]}
    GET /me/conversations?platform=instagram -> {"data":[]}
    GET /{ig-account-id}/conversations       -> {"data":[]}
    GET /me/media                            -> {"data":[]}

No errors — token and endpoints work, and `me/media` is genuinely empty because
the account has no posts. So the empty conversation list is real: inbound message
data is withheld while unpublished, closing the polling workaround.

## 3. What Live Mode would actually cost

Live Mode is the gate on everything in §1, §2 and §7. It was chased to its real
blocker rather than assumed.

**Not the privacy policy.** One was written, served over the tunnel at `/privacy`,
and saved in App Settings. `Publish` stayed disabled.

**Not App Review in general either.** App Review governs permissions for users
who do *not* hold a role on the app.[^release]

**The actual blocker:** the `instagram_business_*` permissions hold status
**"Ready for testing"** — Standard Access. `Publish` unlocks only at Advanced
Access, and that requires App Review.[^appreview] Its prerequisites:

| Requirement | Note |
|---|---|
| App icon 1024×1024, category, business email, privacy policy URL | privacy policy done; category still empty |
| ≥1 successful API call per requested permission, within 30 days | circular here — the gated calls are the ones that fail |
| **Business Verification** | required for *all* Advanced Access requests; needs a legal entity plus documents[^techprov] |
| Written usage description per permission | three needed |
| Screencast per permission, English UI | three needed |

Review turnaround is cited at roughly 24 hours, but Business Verification is a
separate process measured in days.

**Decision.** Not pursued. The assignment states app review is not expected, and
Business Verification alone would exceed the whole time budget. See
the README's "Honest limits".

## 4. Two identifiers for one account

`GET /me` returns `38097900000000000`; the dashboard shows `17841400000000000`.
The receiver asserts `entry[].id` matches the brand account, so which one Meta
puts in the payload matters. Unresolved — no real payload has been seen. Both are
stored in `.env`; the assertion should accept either until a real payload settles it.

## 5. Traps that cost time, worth keeping in the README

- **The brief's Shopify tool name is stale.** `search_shop_catalog` does not exist.
  A live `tools/list` returns `search_catalog`, `get_cart`, `update_cart`,
  `search_shop_policies_and_faqs`, `get_product_details`. Discover tools at boot
  rather than hardcoding names.
- **Two app secrets.** The Meta app secret and the Instagram app secret are
  different values. Instagram-Login webhooks are signed with the Instagram one.
- **The toggle under-subscribes.** Turning on "Webhook Subscription" in the
  dashboard subscribed `messages` only. `comments` — the field the flagship
  workflow needs — had to be added via
  `POST /me/subscribed_apps` with `subscribed_fields=messages,comments`.
- **OAuth fails silently on the wrong account.** The token generator forces a
  fresh login and autocompletes the username. Logging in as a personal account
  redirects to `/accounts/convert_to_professional_account/` and drops the OAuth
  with no error — it just lands you on a profile page.
- **Developer registration loops** when the email is already confirmed on the
  Facebook account. `/account/step/` returns HTTP 200 with
  `{"success":false,"error":"registration step is no longer current",
  "nextStep":"email_verification"}`. Registering with a never-before-seen address
  is the fix.

## 6. Shopify: ONEHOPE's live endpoint, verified end to end

No dev store. `onehopewine.com/api/mcp` is public, unauthenticated, and was
exercised in full on 2026-09-06:

    tools/list              -> search_catalog, get_cart, update_cart,
                               search_shop_policies_and_faqs, get_product_details
    search_catalog          -> real products; the free-text `context.intent`
                               field is honoured
    get_product_details     -> variants arrive under `selectedOrFirstAvailableVariant`,
                               NOT a `variants` array (a naive read finds nothing)
    update_cart (qty 2)     -> subtotal $58.00, total $49.30 — the store applied an
                               $8.70 discount server-side — plus a real checkout URL
    search_shop_policies    -> "shipping" and "refund policy" return content;
                               "returns" and "wine club" return []

The empty-policy case is kept deliberately as the graceful-degradation fixture:
a real query against a real store that legitimately finds nothing.

### The `instructions` field is untrusted input

`update_cart` returns three top-level keys: `instructions`, `cart`, `errors`.
`instructions` is natural-language directives addressed to the agent ("Ask if the
customer has found everything they need... prompt them to select a shipping
option..."). It is third-party text arriving inside a tool result.

Tool output is data, not instructions. The MCP client reads `cart` and `errors`
and drops `instructions` on the floor. Piping it into the model's context would
let an external server steer the agent — the same class of boundary the webhook
signature check exists to protect.

## 7. Outbound is gated too — four independent tests

A post was published on `@daakiyah` and commented on from `@slittone`, then every
route to the data was tried.

| Route | Result |
|---|---|
| Webhook push (`messages`, `comments` subscribed, both accounts testers) | zero POSTs ever |
| `GET /me/conversations` | `{"data":[]}` |
| `GET /{media-id}/comments` | `{"data":[]}` — while `comments_count` reads **1** |
| `POST /me/messages` private reply | permission/validity error, subcode 2534066 |

`comments_count: 1` alongside an empty `comments` edge is the clearest single
signal: the platform confirms the comment exists and declines to return it.
Metadata about our own account is visible; anything belonging to another user
is not.

The outbound probe is worth reading carefully. A fabricated recipient returns
subcode **2534014** ("user not found"). A plausible id returns subcode **2534066**
— "check whether the access token has sufficient granular scope of IG permission
for private reply, or verify whether the comment ID is valid". Meta's own wording
conflates two causes, so this does not *prove* scope is the blocker. But the send
endpoint accepts the token and the request shape, failing only at recipient
resolution, which is consistent with everything else here.

**Conclusion.** Inbound and outbound both require a published app. Publishing
requires App Review, which the assignment excludes. The receiver is therefore
built exactly as production demands — raw-body HMAC, account assertion,
idempotency — and driven by replayed payloads signed with the real app secret.
The substitution is at the transport, and nowhere else.

## 8. Correction: real Meta-signed deliveries ARE obtainable

An earlier draft of this document concluded that inbound was entirely
unavailable. That was wrong, and the mistake was not reading the docs before
inferring from error codes.

The docs are explicit: *"Apps must be set to Live in the App Dashboard to receive
webhook notifications."*[^webhooks] The Live path was then chased properly:

- Live mode does **not** require App Review in general — App Review governs
  permissions for users **without** a role on the app.
- A privacy policy URL is required. One was written, served over the tunnel at
  `/privacy`, and saved. Publish stayed disabled.
- The real blocker: the `instagram_business_*` permissions show status
  **"Ready for testing"** (Standard Access). Publish unlocks only when they are
  approved, which is App Review — excluded by the assignment.

**But the App Dashboard's webhook Test facility delivers genuinely signed POSTs
to the configured callback URL, in Development mode.** Both were captured:

    messages   255 bytes   signature verified
    comments   308 bytes   signature verified

Saved to `fixtures/meta-messages.json` and `fixtures/meta-comments.json`, each
with Meta's own `X-Hub-Signature-256`.

### Three facts this settled that inference had wrong

1. **`IG_APP_SECRET` is the signing key.** HMAC-SHA256 over the raw body with the
   Instagram app secret reproduces Meta's signature exactly. The Meta app secret
   was never needed and is not stored.

2. **The payload uses `changes[]`.** Real shape:

       {"object":"instagram","entry":[{"id":"0","time":...,
         "changes":[{"field":"messages","value":{
           "sender":{"id":...},"recipient":{"id":...},
           "timestamp":"...","message":{"mid":...,"text":...}}}]}]}

   Not the `messaging[]` array assumed for Instagram-Login. Coding to the
   assumption would have failed on the first real event.

3. **`entry[].id` is `"0"`** in test payloads, so which account identifier appears
   there in live traffic remains unresolved. The receiver accepts either stored id
   and logs what it saw.

### What is real, and what is not

| Layer | Real? |
|---|---|
| Meta → our endpoint transport | yes — Meta issues the POST |
| `X-Hub-Signature-256` verification | yes — verified against Meta's bytes |
| Payload structure | yes — Meta's own samples |
| Event contents | no — placeholder ids and text |
| Live user DMs and comments | no — requires Live mode |
| Outbound sends | no — same gate |

The substitution is the *content* of events, not the transport, the signature, or
the shape. Replay reuses these captured payloads with fields swapped for the real
post and comment observed on `@daakiyah`.

---

## Sources

Every claim above traces to one of these, or to a command whose output is quoted
inline.

[^webhooks]: [Instagram Platform — Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks) — "Apps must be set to Live in the App Dashboard to receive webhook notifications."
[^appreview]: [Instagram Platform — App Review](https://developers.facebook.com/docs/instagram-platform/app-review) — Advanced Access prerequisites, per-permission screencast, prior successful API call.
[^release]: [Meta — App Development Release / Live Mode](https://developers.facebook.com/docs/development/release) — App Review governs users without a role on the app.
[^techprov]: [Meta — Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/) — Business Verification required for all Advanced Access requests.
[^perms]: [Meta — Permissions Reference](https://developers.facebook.com/docs/permissions/) — Standard vs Advanced Access.
[^storefront]: [Shopify — Storefront MCP server](https://shopify.dev/docs/api/storefront-mcp) — tool set and argument shapes.
[^cartmcp]: [Shopify — Cart MCP](https://shopify.dev/docs/api/cart-mcp) — protocol errors vs business outcomes in `messages[]`.
[^deprecation]: [Shopify changelog — cart tool deprecation](https://shopify.dev/changelog) — `get_cart`/`update_cart` on `/api/mcp` deprecated in favour of UCP tools.

Claims established by experiment rather than documentation are marked in place
with the command and its output: the tunnel request log (§1), the empty
conversation and comment edges (§2, §7), the error subcodes 2534014 and 2534066
(§7), the HMAC match against Meta's own signature (§8), and the ONEHOPE cart
totals (§6).

## 9. Two defects found by running it, not by reading

Both shipped into a working build and were exposed by the first live replies.

### The same store sends money in two shapes

    search_catalog       "price_range": { "min": { "amount": 2900, ... } }   number, minor units
    get_product_details  "price": "29.0"                                      string, major units

Same store, same currency, same session. The parser handled strings only, so
every search result rendered as "price on request" while reporting success — a
catalog of real wines with no prices, and no error anywhere. Caught because a
live reply said it out loud.

The value's *type* is the only discriminator the payload carries. Both shapes are
now pinned by tests in `tests/money.test.ts`.

### `search_catalog` does return a `variants` array

An earlier note here claimed variants never arrive in a `variants` array. That
overgeneralised from `get_product_details`, which narrows to
`selectedOrFirstAvailableVariant`. `search_catalog` returns a full `variants`
array. Both are true; the correction matters because the wrong key finds nothing
while still reporting success.

### Instagram renders no markdown

The model emitted `**bold**`, which arrives in a DM as literal asterisks. Not a
platform limit so much as a platform fact worth stating in the prompt, alongside
the instruction to write URLs bare rather than as `[text](url)`.

## 10. Profile is gated; the post is not

The flagship pipeline's `fetch profile` step is attempted rather than skipped, and
the two halves behave differently.

    GET /{ig-user-id}?fields=name,username,follower_count,is_user_follow_business
      → error code 100, subcode 33 — "does not exist, cannot be loaded due to
        missing permissions, or does not support this operation"

    GET /{media-id}?fields=caption,permalink,media_product_type
      → { "caption": "Field to Table Red Blend 2021\n2021, Central Coast",
          "permalink": "https://www.instagram.com/p/Dc7rAB8lKe7/",
          "media_product_type": "FEED" }

The profile endpoint is consent-gated: consent is set when a person messages the
account, taps an icebreaker, or taps a persistent menu. A commenter has done none
of those. The media endpoint has no such gate — it is the Brand Account's own
content.

So the personalisation surface at opener time is: username and verbatim comment
from the Delivery, plus the post's caption from the API. Follow status and
follower count are not available, and the prompt states that explicitly rather
than leaving the model to assume.
