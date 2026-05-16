export const GET_PROJECT = `
  query GetProject($login: String!, $number: Int!) {
    organization(login: $login) {
      projectV2(number: $number) {
        id
        title
      }
    }
  }
`;

export const GET_PROJECT_FIELDS = `
  query GetProjectFields($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        # GitHub Projects v2 caps at 60 custom fields per project.
        # 100 covers with margin. Re-evaluate if GitHub raises the cap.
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

export const CREATE_SINGLE_SELECT_FIELD = `
  mutation CreateSingleSelectField(
    $projectId: ID!
    $name: String!
    $options: [ProjectV2SingleSelectFieldOptionInput!]!
  ) {
    createProjectV2Field(input: {
      projectId: $projectId
      dataType: SINGLE_SELECT
      name: $name
      singleSelectOptions: $options
    }) {
      projectV2Field {
        __typename
        ... on ProjectV2SingleSelectField {
          id
          name
          options {
            id
            name
          }
        }
      }
    }
  }
`;

export const GET_PROJECT_ITEMS = `
  query GetProjectItems($projectId: ID!, $first: Int!, $after: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            # Same rationale: max 60 custom fields means max 60 field values per item.
            # 100 covers with margin. Re-evaluate if GitHub raises the cap.
            fieldValues(first: 100) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                  name
                  optionId
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                url
                state
              }
            }
          }
        }
      }
    }
  }
`;
