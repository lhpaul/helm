import type { ExternalReviewContext } from '../types.js';

export type BugbotSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type BugbotReviewConfig = {
  blockingSeverities: BugbotSeverity[];
  deferWhenPending: boolean;
};

export type BugbotCheckRunPayload = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
    annotations?: BugbotAnnotationPayload[];
  } | null;
};

export type BugbotAnnotationPayload = {
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  annotation_level?: string | null;
  title?: string | null;
  message?: string | null;
  raw_details?: string | null;
};

export type BugbotReviewCommentPayload = {
  id?: number | string;
  node_id?: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

export type BugbotReviewThreadPayload = {
  id?: string | number;
  isResolved?: boolean;
  is_resolved?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: BugbotReviewCommentPayload[];
};

export type BugbotReviewPayload = {
  analysisStatus?: string;
  unavailable?: boolean;
  error?: string;
  checkRun?: BugbotCheckRunPayload;
  reviewComments?: BugbotReviewCommentPayload[];
  reviewThreads?: BugbotReviewThreadPayload[];
};

export type LoadBugbotReview = (
  ctx: ExternalReviewContext,
) => Promise<BugbotReviewPayload | null> | BugbotReviewPayload | null;
