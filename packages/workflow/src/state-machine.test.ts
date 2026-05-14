import { describe, expect, it } from 'vitest';
import {
  INITIAL_STAGE,
  canTransition,
  getValidNextStages,
  isWorkflowStage,
  validateTransition,
} from './state-machine.js';
import { WorkflowTransitionError } from './types.js';

describe('canTransition', () => {
  describe('valid transitions', () => {
    it('allows the primary forward path: discovery → spec-draft', () => {
      expect(canTransition('discovery', 'spec-draft')).toBe(true);
    });

    it('allows code-review → remediation (CRITICAL/HIGH issues path)', () => {
      expect(canTransition('code-review', 'remediation')).toBe(true);
    });

    it('allows code-review → in-development (reviewer requests changes)', () => {
      expect(canTransition('code-review', 'in-development')).toBe(true);
    });

    it('allows remediation → code-review (after fix, back to review)', () => {
      expect(canTransition('remediation', 'code-review')).toBe(true);
    });

    it('allows spec-draft → discovery (backward — story needs rediscovery)', () => {
      expect(canTransition('spec-draft', 'discovery')).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('blocks discovery → released (illegal stage skip)', () => {
      expect(canTransition('discovery', 'released')).toBe(false);
    });

    it('blocks released → discovery (released is terminal)', () => {
      expect(canTransition('released', 'discovery')).toBe(false);
    });

    it('blocks in-development → remediation (must go through code-review first)', () => {
      expect(canTransition('in-development', 'remediation')).toBe(false);
    });
  });
});

describe('validateTransition', () => {
  it('does not throw for a valid transition', () => {
    expect(() => validateTransition('plan-ready', 'in-development')).not.toThrow();
  });

  it('throws WorkflowTransitionError for an invalid transition', () => {
    expect(() => validateTransition('discovery', 'released')).toThrow(WorkflowTransitionError);
  });

  it('error carries typed from and to properties', () => {
    let caught: unknown;
    try {
      validateTransition('discovery', 'released');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowTransitionError);
    const err = caught as WorkflowTransitionError;
    expect(err.from).toBe('discovery');
    expect(err.to).toBe('released');
  });

  it('error message includes the valid next stages', () => {
    expect(() => validateTransition('discovery', 'released')).toThrow("'spec-draft'");
  });

  it("error message says 'none' when the from stage is terminal", () => {
    expect(() => validateTransition('released', 'discovery')).toThrow('none');
  });
});

describe('getValidNextStages', () => {
  it('returns both branches from code-review', () => {
    expect(getValidNextStages('code-review')).toEqual(['in-development', 'remediation']);
  });

  it('returns empty array for the terminal released stage', () => {
    expect(getValidNextStages('released')).toEqual([]);
  });
});

describe('constants and type guard', () => {
  it('INITIAL_STAGE is discovery', () => {
    expect(INITIAL_STAGE).toBe('discovery');
  });

  it('isWorkflowStage correctly identifies valid and invalid stages', () => {
    expect(isWorkflowStage('in-development')).toBe(true);
    expect(isWorkflowStage('released')).toBe(true);
    expect(isWorkflowStage('bogus-stage')).toBe(false);
    expect(isWorkflowStage('')).toBe(false);
  });
});
