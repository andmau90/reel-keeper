import { ApiHealthResponseSchema } from './index.js';

describe('ApiHealthResponseSchema', () => {
  it('accepts a healthy response and rejects other statuses', () => {
    expect(ApiHealthResponseSchema.parse({ status: 'ok' })).toEqual({
      status: 'ok',
    });
    expect(ApiHealthResponseSchema.safeParse({ status: 'error' }).success).toBe(
      false,
    );
  });
});
