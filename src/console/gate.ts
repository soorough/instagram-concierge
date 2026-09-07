import type { FastifyInstance } from 'fastify';

/**
 * A shared password over the console's API.
 *
 * Honest for a demo that is going to be shared as a link: every turn spends real
 * model credits, `/api/simulate` drives the agent loop, and `/api/reset` clears
 * the database — none of which belong behind nothing at all on a public URL.
 * One shared password, structured so a real auth provider is a swap rather than
 * a rewrite. The sibling concierge deploys with the same gate.
 *
 * Two exemptions, both load-bearing.
 *
 * `/api/health` stays open because the platform's healthcheck cannot send a
 * header. Gating it means the deploy is marked unhealthy and never goes live.
 *
 * `/webhooks/instagram` is never touched, because Meta cannot send our password
 * and does not need to: that endpoint verifies an HMAC over the raw bytes, which
 * is a stronger claim than a shared secret. Gating the one path the system
 * exists to serve, in order to protect it, would be its own kind of failure.
 *
 * The page itself is served ungated so the unlock screen can render. There is
 * nothing behind it until the password is right.
 */
export async function registerGate(app: FastifyInstance): Promise<void> {
  const password = process.env.CONSOLE_PASSWORD;

  if (!password) {
    /**
     * Unset means open, which is what local development wants — and is the
     * wrong default in exactly one place, so it says so rather than failing
     * quietly. Refusing to boot without it would make a fresh clone hostile.
     */
    console.log('[console] CONSOLE_PASSWORD unset — the API is open. Set it before deploying.');
    return;
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/health') return;

    if (request.headers['x-console-password'] !== password) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
  });
}
