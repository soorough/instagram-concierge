import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests that verify against real Meta Deliveries need IG_APP_SECRET. It lives in
// .env, which is gitignored, so those tests skip for anyone without it rather
// than failing — and the secret never enters the repository.
config({ quiet: true });

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
