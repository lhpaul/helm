// ── Shared primitives ──────────────────────────────────────────────────────────

export type LinearLabel = {
  id: string;
  name: string;
};

export type LinearState = {
  id: string;
  name: string;
  /** "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled" */
  type: string;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: LinearState;
  labels: {
    nodes: ReadonlyArray<LinearLabel>;
  };
};

// ── LIST_TEAM_ISSUES ──────────────────────────────────────────────────────────

export type ListTeamIssuesResponse = {
  issues: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: ReadonlyArray<LinearIssue>;
  };
};

// ── GET_ISSUE_BY_IDENTIFIER ───────────────────────────────────────────────────

export type GetIssueByIdentifierResponse = {
  issue: LinearIssue | null;
};

// ── LIST_TEAM_LABELS ──────────────────────────────────────────────────────────

export type ListTeamLabelsResponse = {
  issueLabels: {
    nodes: ReadonlyArray<LinearLabel>;
  };
};

// ── LIST_TEAM_STATES ──────────────────────────────────────────────────────────

export type ListTeamStatesResponse = {
  workflowStates: {
    nodes: ReadonlyArray<LinearState>;
  };
};

// ── GET_TEAM_BY_KEY ───────────────────────────────────────────────────────────

export type LinearTeam = {
  id: string;
  key: string;
  name: string;
};

export type GetTeamByKeyResponse = {
  teams: {
    nodes: ReadonlyArray<LinearTeam>;
  };
};

// ── CREATE_LABEL ──────────────────────────────────────────────────────────────

export type CreateLabelResponse = {
  issueLabelCreate: {
    issueLabel: LinearLabel;
    success: boolean;
  };
};

// ── ISSUE_ADD_LABEL / ISSUE_REMOVE_LABEL ──────────────────────────────────────

export type IssueLabelMutationResponse = {
  success: boolean;
  issue: Pick<LinearIssue, 'id' | 'identifier' | 'labels'>;
};

export type IssueAddLabelResponse = {
  issueAddLabel: IssueLabelMutationResponse;
};

export type IssueRemoveLabelResponse = {
  issueRemoveLabel: IssueLabelMutationResponse;
};

// ── UPDATE_ISSUE_STATE ────────────────────────────────────────────────────────

export type UpdateIssueStateResponse = {
  issueUpdate: {
    issue: Pick<LinearIssue, 'id' | 'identifier' | 'state'>;
    success: boolean;
  };
};

// ── CREATE_COMMENT ────────────────────────────────────────────────────────────

export type CreateCommentResponse = {
  commentCreate: {
    comment: { id: string };
    success: boolean;
  };
};

// ── State type helpers ────────────────────────────────────────────────────────

/** Linear state types that map to Helm "closed" status. */
export const CLOSED_STATE_TYPES = new Set(['completed', 'cancelled']);

/** Returns 'open' or 'closed' from a Linear state type string. */
export function helmStatusFromStateType(stateType: string): 'open' | 'closed' {
  return CLOSED_STATE_TYPES.has(stateType) ? 'closed' : 'open';
}
