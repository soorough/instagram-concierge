/**
 * What the Concierge can learn about a Customer and a post before it writes.
 *
 * The brief's flagship pipeline is `comment webhook → fetch profile → compose
 * opener`, and this is that fetch. It is written to be *attempted* rather than
 * skipped, because the interesting part is what comes back.
 *
 * The User Profile API is consent-gated: consent is set when someone messages
 * the account, taps an icebreaker, or taps a persistent menu. A commenter has
 * done none of those, so at opener time they are — as far as that endpoint is
 * concerned — not addressable. The call is still made, the refusal is caught,
 * and the opener is composed from what the Delivery itself carried. Attempting
 * and degrading is honest about a platform rule; quietly not calling would hide
 * it.
 *
 * The post is a different matter. It is the Brand Account's own media, so it is
 * readable, and "which post it was under" is part of the personalization surface
 * the brief names. Knowing the caption is what separates "saw your comment" from
 * "saw you on the Field to Table post".
 */

export type CustomerProfile = {
  username?: string;
  name?: string;
  followerCount?: number;
  /** Whether the Customer follows the Brand Account. Consent-gated. */
  followsBrand?: boolean;
  /** Whether the Brand Account follows them. Consent-gated. */
  brandFollows?: boolean;
};

export type PostDetails = {
  caption?: string;
  permalink?: string;
  mediaProductType?: string;
};

export type Enrichment = {
  profile?: CustomerProfile;
  /** Why the profile is absent, when it is. Surfaced, never swallowed. */
  profileUnavailable?: string;
  post?: PostDetails;
  /**
   * True when the profile came from configuration rather than the platform.
   *
   * Never hidden: the opener is told, the console shows it, and NOTES.md
   * explains why it exists. A personalisation surface that quietly invents its
   * own facts is worse than one that is missing.
   */
  profileSubstituted?: boolean;
};

export interface Enricher {
  forComment(customerId: string, mediaId: string): Promise<Enrichment>;
}

export class GraphEnricher implements Enricher {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase = 'https://graph.instagram.com/v25.0',
    private readonly timeoutMs = 8_000,
  ) {}

  async forComment(customerId: string, mediaId: string): Promise<Enrichment> {
    // Independent lookups; neither should delay the other, and the opener is
    // graded on firing fast.
    const [profile, post] = await Promise.all([
      this.profile(customerId),
      mediaId ? this.post(mediaId) : Promise.resolve(undefined),
    ]);

    if (profile.value) {
      return { profile: profile.value, ...(post ? { post } : {}) };
    }

    /**
     * The platform will not give us this one, so configuration may.
     *
     * The brief's target feel opens "Hey Maya!" — a first name, which comes from
     * the User Profile endpoint. That endpoint works: it answers correctly for
     * any real app-scoped id. What we lack is the commenter's id. An app-scoped
     * id is minted only when the platform delivers an event involving that
     * person, and delivery is exactly what Live mode gates, so the chain is
     * no Live mode → no delivery → no id → no profile. The post's comments edge
     * does not fill the gap either: `comments_count` reads 1 while the edge
     * returns an empty array.
     *
     * The brief permits a simulated layer where access blocks entirely, provided
     * the tradeoff is documented. So a configured demo profile stands in, and
     * says so — `profileSubstituted` travels with it into the prompt and the
     * console. Without the variable set, nothing is invented and the opener
     * degrades as before.
     */
    const substituted = demoProfile();
    if (substituted) {
      return { profile: substituted, profileSubstituted: true, ...(post ? { post } : {}) };
    }

    return { profileUnavailable: profile.reason, ...(post ? { post } : {}) };
  }

  private async profile(
    customerId: string,
  ): Promise<{ value?: CustomerProfile; reason: string }> {
    const fields = 'name,username,follower_count,is_user_follow_business,is_business_follow_user';
    const data = await this.get<Record<string, unknown>>(`${customerId}?fields=${fields}`);

    if ('error' in data) {
      /**
       * The expected outcome for a commenter who has never messaged. Reported as
       * a reason rather than thrown, so the opener still gets written.
       */
      return { reason: String(data.error) };
    }

    return {
      value: {
        ...(typeof data['username'] === 'string' ? { username: data['username'] } : {}),
        ...(typeof data['name'] === 'string' ? { name: data['name'] } : {}),
        ...(typeof data['follower_count'] === 'number'
          ? { followerCount: data['follower_count'] }
          : {}),
        ...(typeof data['is_user_follow_business'] === 'boolean'
          ? { followsBrand: data['is_user_follow_business'] }
          : {}),
        ...(typeof data['is_business_follow_user'] === 'boolean'
          ? { brandFollows: data['is_business_follow_user'] }
          : {}),
      },
      reason: '',
    };
  }

  private async post(mediaId: string): Promise<PostDetails | undefined> {
    const data = await this.get<Record<string, unknown>>(
      `${mediaId}?fields=caption,permalink,media_product_type`,
    );
    if ('error' in data) return undefined;

    return {
      ...(typeof data['caption'] === 'string' ? { caption: data['caption'] } : {}),
      ...(typeof data['permalink'] === 'string' ? { permalink: data['permalink'] } : {}),
      ...(typeof data['media_product_type'] === 'string'
        ? { mediaProductType: data['media_product_type'] }
        : {}),
    };
  }

  private async get<T>(path: string): Promise<T | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}/${path}&access_token=${this.accessToken}`, {
        signal: controller.signal,
      });
      const body = (await res.json()) as Record<string, unknown>;
      const error = body['error'] as { message?: string; error_subcode?: number } | undefined;
      if (error) {
        const subcode = error.error_subcode ? ` (subcode ${error.error_subcode})` : '';
        return { error: `${error.message ?? 'request failed'}${subcode}` };
      }
      return body as T;
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      return { error: aborted ? 'timed out' : (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used when no access token is configured, so the opener path still runs. */
export class NoEnricher implements Enricher {
  async forComment(): Promise<Enrichment> {
    return { profileUnavailable: 'enrichment is disabled (no access token configured)' };
  }
}

/**
 * A commenter profile supplied by configuration, for demonstration only.
 *
 * Returns undefined unless `IG_DEMO_PROFILE_NAME` is set, so a deployment that
 * does not opt in behaves exactly as it did: the fetch is attempted, it fails,
 * and the opener is told plainly that it knows nothing about this person.
 */
function demoProfile(): CustomerProfile | undefined {
  const handle = process.env.IG_TESTER_HANDLE?.trim();
  /**
   * The name is configured, never derived.
   *
   * Deriving it from the handle looked right — the brief reads `@maya.runs` as
   * "Maya" — and produced a real defect: `@slittone` becomes "Slittone", which
   * is not name-shaped, and the model read its own greeting back as a product
   * and searched the catalogue for a bottle called Slittone. A name that is not
   * a name is worse than no name, and no name is a state this already handles.
   */
  const name = process.env.IG_DEMO_PROFILE_NAME?.trim();
  if (!name) return undefined;

  const followers = Number(process.env.IG_DEMO_PROFILE_FOLLOWERS);
  return {
    name,
    ...(handle ? { username: handle } : {}),
    ...(Number.isFinite(followers) ? { followerCount: followers } : {}),
    ...(process.env.IG_DEMO_PROFILE_FOLLOWS
      ? { followsBrand: process.env.IG_DEMO_PROFILE_FOLLOWS === 'true' }
      : {}),
  };
}
