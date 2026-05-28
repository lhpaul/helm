// All queries omit .strict() — Linear may add fields without notice.

export const LIST_TEAM_ISSUES = `
  query ListTeamIssues($teamKey: String!, $after: String) {
    issues(
      filter: { team: { key: { eq: $teamKey } } }
      first: 100
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        state {
          id
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

export const GET_ISSUE_BY_IDENTIFIER = `
  query GetIssueByIdentifier($identifier: String!) {
    issue(id: $identifier) {
      id
      identifier
      title
      description
      url
      state {
        id
        name
        type
      }
      labels {
        nodes {
          id
          name
        }
      }
    }
  }
`;

export const LIST_TEAM_LABELS = `
  query ListTeamLabels($teamKey: String!) {
    issueLabels(filter: { team: { key: { eq: $teamKey } } }, first: 250) {
      nodes {
        id
        name
      }
    }
  }
`;

export const LIST_TEAM_STATES = `
  query ListTeamStates($teamKey: String!) {
    workflowStates(filter: { team: { key: { eq: $teamKey } } }, first: 100) {
      nodes {
        id
        name
        type
      }
    }
  }
`;

export const CREATE_LABEL = `
  mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
    issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
      issueLabel {
        id
        name
      }
      success
    }
  }
`;

export const GET_TEAM_BY_KEY = `
  query GetTeamByKey($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        id
        key
        name
      }
    }
  }
`;

// Adds a single label to an issue. Linear supports issueAddLabel natively.
export const ISSUE_ADD_LABEL = `
  mutation IssueAddLabel($issueId: String!, $labelId: String!) {
    issueAddLabel(id: $issueId, labelId: $labelId) {
      issue {
        id
        identifier
        labels {
          nodes {
            id
            name
          }
        }
      }
      success
    }
  }
`;

// Removes a single label from an issue.
export const ISSUE_REMOVE_LABEL = `
  mutation IssueRemoveLabel($issueId: String!, $labelId: String!) {
    issueRemoveLabel(id: $issueId, labelId: $labelId) {
      issue {
        id
        identifier
        labels {
          nodes {
            id
            name
          }
        }
      }
      success
    }
  }
`;

export const UPDATE_ISSUE_STATE = `
  mutation UpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      issue {
        id
        identifier
        state {
          id
          name
          type
        }
      }
      success
    }
  }
`;

export const CREATE_COMMENT = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      comment {
        id
      }
      success
    }
  }
`;
