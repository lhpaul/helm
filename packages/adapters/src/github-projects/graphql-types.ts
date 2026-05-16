// ── Shared primitives ─────────────────────────────────────────────────────────

export type GitHubFieldOption = {
  id: string;
  name: string;
};

// ── GET_PROJECT ───────────────────────────────────────────────────────────────

export type GetProjectResponse = {
  organization: {
    projectV2: {
      id: string;
      title: string;
    } | null;
  } | null;
};

// ── GET_PROJECT_FIELDS ────────────────────────────────────────────────────────

export type GitHubSingleSelectField = {
  __typename: 'ProjectV2SingleSelectField';
  id: string;
  name: string;
  options: ReadonlyArray<GitHubFieldOption>;
};

export type GitHubOtherField = {
  __typename: string;
};

export type GitHubProjectFieldNode = GitHubSingleSelectField | GitHubOtherField;

export type GetProjectFieldsResponse = {
  node: {
    fields: {
      nodes: ReadonlyArray<GitHubProjectFieldNode>;
    };
  } | null;
};

// ── CREATE_SINGLE_SELECT_FIELD ────────────────────────────────────────────────

export type CreateSingleSelectFieldResponse = {
  createProjectV2Field: {
    projectV2Field: GitHubSingleSelectField | GitHubOtherField;
  };
};

// ── GET_PROJECT_ITEMS ─────────────────────────────────────────────────────────

export type GitHubSingleSelectValue = {
  __typename: 'ProjectV2ItemFieldSingleSelectValue';
  field: { name: string };
  name: string;
  optionId: string;
};

export type GitHubOtherFieldValue = {
  __typename: string;
};

export type GitHubFieldValueNode = GitHubSingleSelectValue | GitHubOtherFieldValue;

export type GitHubIssueContent = {
  __typename: 'Issue';
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
};

export type GitHubOtherContent = {
  __typename: string;
};

export type GitHubItemContent = GitHubIssueContent | GitHubOtherContent | null;

export type GitHubProjectItemNode = {
  id: string;
  fieldValues: {
    nodes: ReadonlyArray<GitHubFieldValueNode>;
  };
  content: GitHubItemContent;
};

export type GetProjectItemsResponse = {
  node: {
    items: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: ReadonlyArray<GitHubProjectItemNode>;
    };
  } | null;
};

// ── Mutation responses ────────────────────────────────────────────────────────

export type UpdateProjectItemFieldResponse = {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
};

export type CloseIssueResponse = {
  closeIssue: { issue: { state: string } };
};

export type ReopenIssueResponse = {
  reopenIssue: { issue: { state: string } };
};

export type AddCommentResponse = {
  addComment: { commentEdge: { node: { id: string } } };
};

// ── projects_v2_item webhook payload ─────────────────────────────────────────

export type ProjectsV2ItemEditedPayload = {
  action: 'edited';
  changes: {
    field_value: {
      field_node_id: string;
      field_type: string;
      to: { id: string; name: string } | null | undefined;
    };
  };
  projects_v2_item: {
    content_node_id: string;
    content_type: string;
  };
};

// ── Type guards ───────────────────────────────────────────────────────────────

export function isSingleSelectField(node: GitHubProjectFieldNode): node is GitHubSingleSelectField {
  return node.__typename === 'ProjectV2SingleSelectField';
}

export function isSingleSelectValue(node: GitHubFieldValueNode): node is GitHubSingleSelectValue {
  return node.__typename === 'ProjectV2ItemFieldSingleSelectValue';
}

export function isIssueContent(content: GitHubItemContent): content is GitHubIssueContent {
  return content !== null && content.__typename === 'Issue';
}
