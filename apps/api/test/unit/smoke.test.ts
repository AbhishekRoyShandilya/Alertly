import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE } from '@alertly/shared';
import { SERVICE_NAME } from '../../src/index';

describe('toolchain smoke test', () => {
  it('runs TypeScript tests', () => {
    expect(SERVICE_NAME).toBe('alertly-api');
  });

  it('resolves the shared workspace package', () => {
    expect(SHARED_PACKAGE).toBe('@alertly/shared');
  });
});
