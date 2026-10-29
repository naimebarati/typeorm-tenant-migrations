import { describe, expect, it } from 'vitest';
import { assessConnectionBudget, connectionsNeeded } from '../../src/postgres/connection-budget.js';

describe('connection budget', () => {
  it('needs 3 connections per tenant in flight plus one', () => {
    expect(connectionsNeeded(1)).toBe(4);
    expect(connectionsNeeded(8)).toBe(25);
  });

  it('is silent when the run fits into the free slots', () => {
    expect(assessConnectionBudget({ max: 100, reserved: 3, used: 10 }, 8)).toBeUndefined();
    expect(assessConnectionBudget({ max: 100, reserved: 3, used: 72 }, 8)).toBeUndefined(); // exactly 25 free
  });

  it('warns, with the numbers and a concurrency that would fit, when it does not', () => {
    const text = assessConnectionBudget({ max: 100, reserved: 3, used: 73 }, 8)!;
    expect(text).toContain('up to 25 connections');
    expect(text).toContain('only 24 are free');
    expect(text).toContain('max_connections 100, 73 in use, 3 reserved');
    expect(text).toContain('about 7 would fit');
  });

  it('never suggests less than 1, and copes with a server that is already full', () => {
    const text = assessConnectionBudget({ max: 100, reserved: 3, used: 99 }, 4)!;
    expect(text).toContain('only 0 are free');
    expect(text).toContain('about 1 would fit');
  });
});
