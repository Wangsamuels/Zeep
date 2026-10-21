// API errors map 1:1 to the status codes in the architecture doc.
export class ZeepError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const errors = {
  bad: (msg: string, extra = {}) => new ZeepError(400, 'bad_request', msg, extra),
  unauthorized: (msg = 'unauthorized') => new ZeepError(401, 'unauthorized', msg),
  payment: (cost: number, got: number) =>
    new ZeepError(402, 'proofs_required', `route costs ${cost} credits, ${got} valid proofs attached`, { cost }),
  forbidden: (msg = 'forbidden') => new ZeepError(403, 'forbidden', msg),
  notFound: (msg = 'not found') => new ZeepError(404, 'not_found', msg),
  tagUsed: () => new ZeepError(409, 'tag_used', 'a credit slot in this request was already used'),
  revoked: () => new ZeepError(410, 'revoked', 'this pass was revoked for reusing a credit slot'),
  staleRoot: () => new ZeepError(422, 'stale_root', 'unknown or expired Merkle root; rebuild your path and retry'),
  invalid: (msg: string) => new ZeepError(422, 'invalid', msg),
  dailyLimit: () => new ZeepError(429, 'daily_limit', 'daily plan limit reached for today'),
  busy: (msg = 'upstream busy') => new ZeepError(503, 'unavailable', msg),
  budget: () => new ZeepError(503, 'mpp_budget', 'daily paid-upstream budget is spent; try again tomorrow'),
};
