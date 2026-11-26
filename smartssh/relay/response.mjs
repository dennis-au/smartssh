const messages = {
  token_invalid: 'A valid relay token is required.',
  not_found: 'Resource not found.',
  bad_request: 'Invalid request.',
  truncation_refused: 'Context text exceeds the byte limit.',
  missing_idempotency_key: 'Idempotency-Key header is required.',
  proposal_dead: 'Proposal is no longer available.',
  proposal_done: 'Proposal has already been dispatched.',
  stale_approval: 'Approval is no longer valid for this dispatch.',
  confirm_mismatch: 'Confirmation code did not match.',
  internal_error: 'The relay could not complete the request.',
}

export const result = (status, body) => ({ status, body })
export const error = (status, code, fields) => result(status, { error: code, message: messages[code], ...fields })
export const badRequest = () => error(400, 'bad_request')
