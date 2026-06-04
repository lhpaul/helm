import { describe, expect, it } from 'vitest';
import { WORKFLOW_STAGES, WorkflowTransitionError } from '@helm/workflow';
import {
  ItemAlreadyExistsError,
  ItemNotFoundError,
  StageMismatchError,
} from '../services/errors.js';
import { mapErrorToResponse, validateExternalId, validateJobId } from './http-errors.js';

// A canonical UUID v4 that matches JOB_ID_REGEX.
const VALID_JOB_ID = '11111111-2222-4333-8444-555555555555';

describe('validateExternalId', () => {
  it.each(['MOM-142', 'HLM-7', 'issue_3', 'feature.v2', 'a'])(
    'accepts valid externalId %j',
    (value) => {
      const result = validateExternalId(value);
      expect(result).toEqual({ ok: true, value });
    },
  );

  it.each(['.', '..'])('rejects the dot-traversal value %j', (value) => {
    const result = validateExternalId(value);
    expect(result).toEqual({
      ok: false,
      response: { body: { error: `Invalid externalId: "${value}"` }, status: 400 },
    });
  });

  it.each(['.hidden', 'has/slash', 'has space', 'has\\backslash', ''])(
    'rejects regex failure %j with the routes 400 body',
    (value) => {
      const result = validateExternalId(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response).toEqual({
          body: { error: `Invalid externalId: "${value}"` },
          status: 400,
        });
      }
    },
  );
});

describe('validateJobId', () => {
  it('accepts a valid UUID v4 job id', () => {
    expect(validateJobId(VALID_JOB_ID)).toEqual({ ok: true, value: VALID_JOB_ID });
  });

  it.each(['not-a-uuid', '', '11111111-2222-3333-4444-555555555555', '../etc/passwd'])(
    'rejects invalid job id %j with the routes 400 body',
    (value) => {
      const result = validateJobId(value);
      expect(result).toEqual({
        ok: false,
        response: { body: { error: `Invalid jobId: "${value}"` }, status: 400 },
      });
    },
  );
});

describe('mapErrorToResponse', () => {
  it('maps ItemNotFoundError → 404 with the error message', () => {
    const err = new ItemNotFoundError('MOM-1');
    expect(mapErrorToResponse(err)).toEqual({
      body: { error: 'Item not found: MOM-1' },
      status: 404,
    });
  });

  it('maps ItemAlreadyExistsError → 409 with the error message', () => {
    const err = new ItemAlreadyExistsError('MOM-1');
    expect(mapErrorToResponse(err)).toEqual({
      body: { error: 'Item already exists: MOM-1' },
      status: 409,
    });
  });

  it('maps StageMismatchError → 400 with the error message', () => {
    const err = new StageMismatchError('MOM-1', 'in-development', 'code-review');
    expect(mapErrorToResponse(err)).toEqual({ body: { error: err.message }, status: 400 });
  });

  it('maps WorkflowTransitionError → 422 with the error message', () => {
    const err = new WorkflowTransitionError(
      'transition not allowed',
      WORKFLOW_STAGES[0],
      WORKFLOW_STAGES[1],
    );
    expect(mapErrorToResponse(err)).toEqual({
      body: { error: 'transition not allowed' },
      status: 422,
    });
  });

  it('maps an unknown error → 500 with a generic message (no message leak)', () => {
    const err = new Error('internal secret path /etc/helm/config');
    expect(mapErrorToResponse(err)).toEqual({
      body: { error: 'Internal server error' },
      status: 500,
    });
  });

  it('maps a non-Error throwable → 500 generic', () => {
    expect(mapErrorToResponse('boom')).toEqual({
      body: { error: 'Internal server error' },
      status: 500,
    });
  });

  it('merges extras into the body after the error field', () => {
    const err = new ItemNotFoundError('MOM-1');
    expect(mapErrorToResponse(err, { details: [{ path: 'x' }], runningJobId: 'job-1' })).toEqual({
      body: { error: 'Item not found: MOM-1', details: [{ path: 'x' }], runningJobId: 'job-1' },
      status: 404,
    });
  });

  it('merges extras into the unknown → 500 body as well', () => {
    expect(mapErrorToResponse(new Error('x'), { missing_context: ['readme'] })).toEqual({
      body: { error: 'Internal server error', missing_context: ['readme'] },
      status: 500,
    });
  });
});
