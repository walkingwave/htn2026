import { describe, expect, it } from 'vitest';
import { VersusMatch } from './versus.js';

describe('VersusMatch', () => {
  it('starts with a clean host serve', () => {
    const match = new VersusMatch();
    expect(match.snapshot()).toMatchObject({
      scoreHost: 0,
      scoreGuest: 0,
      server: 'host',
      winner: null,
      target: 11,
    });
  });

  it('gives the next serve to the point scorer', () => {
    const match = new VersusMatch();
    expect(match.scorePoint('guest')).toBeNull();
    expect(match.snapshot()).toMatchObject({ scoreGuest: 1, server: 'guest' });
    expect(match.scorePoint('host')).toBeNull();
    expect(match.snapshot()).toMatchObject({ scoreHost: 1, server: 'host' });
  });

  it('requires a two-point lead at the target score', () => {
    const match = new VersusMatch();
    for (let i = 0; i < 10; i += 1) match.scorePoint('host');
    for (let i = 0; i < 10; i += 1) match.scorePoint('guest');
    expect(match.snapshot().winner).toBeNull();
    match.scorePoint('host');
    expect(match.snapshot().winner).toBeNull();
    expect(match.scorePoint('host')).toBe('host');
  });

  it('does not mutate a completed match', () => {
    const match = new VersusMatch();
    for (let i = 0; i < 11; i += 1) match.scorePoint('host');
    const before = match.snapshot();
    expect(match.scorePoint('guest')).toBe('host');
    expect(match.snapshot()).toEqual(before);
  });

  it('applies a remote snapshot without losing the target', () => {
    const match = new VersusMatch({ target: 7 });
    match.apply({ scoreHost: 3, scoreGuest: 2, server: 'guest', winner: null });
    expect(match.snapshot()).toMatchObject({ scoreHost: 3, scoreGuest: 2, server: 'guest', target: 7 });
  });
});
