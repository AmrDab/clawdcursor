/**
 * Unit tests for the new observability primitives.
 *
 * Correlation ids: the per-request context that tags every log line.
 */

import { describe, it, expect } from 'vitest';
import {
  newCorrelationId,
  runWithCorrelation,
  getCorrelationId,
  getContext,
} from '../core/observability/correlation';

describe('correlation', () => {
  it('generates stable-format UUIDs', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns different IDs on each call', () => {
    expect(newCorrelationId()).not.toEqual(newCorrelationId());
  });

  it('exposes the correlation ID within runWithCorrelation', async () => {
    const id = newCorrelationId();
    const observed = await runWithCorrelation({ correlationId: id, taskText: 'test' }, () => {
      return getCorrelationId();
    });
    expect(observed).toBe(id);
  });

  it('exposes full context within runWithCorrelation', async () => {
    const id = newCorrelationId();
    const ctx = await runWithCorrelation({ correlationId: id, taskText: 'hello' }, () => {
      return getContext();
    });
    expect(ctx?.correlationId).toBe(id);
    expect(ctx?.taskText).toBe('hello');
    expect(typeof ctx?.startedAt).toBe('number');
  });

  it('isolates context across concurrent tasks', async () => {
    const ids = [newCorrelationId(), newCorrelationId(), newCorrelationId()];
    const results = await Promise.all(
      ids.map(id =>
        runWithCorrelation({ correlationId: id, taskText: id }, async () => {
          // Tiny async hop to force scheduler interleaving.
          await new Promise(r => setTimeout(r, 0));
          return getCorrelationId();
        }),
      ),
    );
    expect(results).toEqual(ids);
  });
});
