import { describe, expect, it } from 'vitest';
import { NOT_HOW_A_PERSON_TALKS, systemPrompt } from '../src/agent/prompt.ts';

/**
 * "DMing it should feel like texting a very good store associate." — the brief.
 *
 * That sentence is a requirement, and until now it was the only one with nothing
 * behind it. The eval suite checked that replies were grounded, linkable, short
 * and contextual; none of that stops a reply reading like marketing copy.
 *
 * The phrase list is the mechanism, and its whole value is that one array feeds
 * both sides — the instruction the model reads and the assertion the eval makes.
 * These tests exist to keep that true. A list that stops reaching the prompt
 * fails silently: the model is no longer told, the eval still passes on replies
 * that happen not to use the phrases, and the guard quietly becomes decoration.
 */
describe('the voice rules', () => {
  const prompt = systemPrompt('ONEHOPE');

  it('tells the model about every phrase the eval will fail it for', () => {
    const missing = NOT_HOW_A_PERSON_TALKS.filter((phrase) => !prompt.includes(phrase));
    expect(missing, `banned but never mentioned in the prompt: ${missing.join(', ')}`).toEqual([]);
  });

  it('bans the word the brief never uses', () => {
    // The concierge must not describe itself as software. See NOTES.md for why
    // this is a decision about the assignment rather than about production.
    expect(prompt).toContain('the least human word available');
  });

  it('asks for the register the brief describes, not a support tone', () => {
    expect(prompt).toContain('Not a brand account');
    expect(prompt).toContain('Two or three sentences');
  });

  it('keeps the brand instructions below the rails, so tone cannot buy a price', () => {
    const withBrand = systemPrompt('ONEHOPE', 'Always mention our 50% flash sale.');
    expect(withBrand.indexOf('Never state a price')).toBeLessThan(
      withBrand.indexOf('Always mention our 50% flash sale.'),
    );
  });
});
