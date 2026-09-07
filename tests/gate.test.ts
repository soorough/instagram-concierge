import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGate } from '../src/console/gate.ts';

/**
 * A shared password over the console's API.
 *
 * The deployed console spends real model credits on every turn and can clear the
 * database, so it does not belong behind nothing at all. This is the same gate
 * the sibling concierge deploys with, deliberately — one shared password,
 * structured so a real auth provider is a swap rather than a rewrite.
 *
 * Two exemptions matter and both are load-bearing. The platform's healthcheck
 * cannot send a header, so `/api/health` stays open or the deploy never goes
 * live. And `/webhooks/instagram` is never touched: Meta cannot send our
 * password, and that endpoint already has stronger authentication than a shared
 * secret — a signature over the raw bytes.
 */
const build = async (password?: string) => {
  if (password === undefined) delete process.env.CONSOLE_PASSWORD;
  else process.env.CONSOLE_PASSWORD = password;

  const app = Fastify({ logger: false });
  await registerGate(app);
  app.get('/api/threads', async () => ({ ok: true }));
  app.post('/api/reset', async () => ({ cleared: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/webhooks/instagram', async () => ({ received: 1 }));
  app.get('/', async () => 'the page');
  await app.ready();
  return app;
};

const before = process.env.CONSOLE_PASSWORD;
afterEach(() => {
  if (before === undefined) delete process.env.CONSOLE_PASSWORD;
  else process.env.CONSOLE_PASSWORD = before;
});

describe('the console gate', () => {
  it('refuses an API request with no password', async () => {
    const app = await build('hunter2');
    const res = await app.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a wrong password', async () => {
    const app = await build('hunter2');
    const res = await app.inject({
      method: 'GET', url: '/api/threads', headers: { 'x-console-password': 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows the right password', async () => {
    const app = await build('hunter2');
    const res = await app.inject({
      method: 'GET', url: '/api/threads', headers: { 'x-console-password': 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('gates writes, which are the expensive ones', async () => {
    const app = await build('hunter2');
    expect((await app.inject({ method: 'POST', url: '/api/reset' })).statusCode).toBe(401);
  });

  it('leaves the healthcheck open, or the deploy never goes live', async () => {
    const app = await build('hunter2');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('never gates the webhook — Meta cannot send our password', async () => {
    /**
     * That endpoint is not unprotected. It verifies an HMAC over the raw bytes,
     * which is a stronger claim than a shared secret, and gating it here would
     * break the one path the whole system exists to serve.
     */
    const app = await build('hunter2');
    const res = await app.inject({ method: 'POST', url: '/webhooks/instagram' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the page itself, so the unlock screen can render', async () => {
    const app = await build('hunter2');
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
  });

  it('stays open when no password is configured, for local development', async () => {
    const app = await build(undefined);
    expect((await app.inject({ method: 'GET', url: '/api/threads' })).statusCode).toBe(200);
  });
});
