import type { ExternalReviewContext } from '../types.js';

export type CodeRabbitSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type CodeRabbitReviewConfig = {
  blockingSeverities: CodeRabbitSeverity[];
  deferWhenPending: boolean;
};

export type CodeRabbitStatusPayload = {
  context?: string;
  state?: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type CodeRabbitReviewCommentPayload = {
  id?: number | string;
  node_id?: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

export type CodeRabbitReviewThreadPayload = {
  id?: string | number;
  isResolved?: boolean;
  is_resolved?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: CodeRabbitReviewCommentPayload[];
};

export type CodeRabbitReviewPayload = {
  unavailable?: boolean;
  error?: string;
  status?: CodeRabbitStatusPayload;
  reviewComments?: CodeRabbitReviewCommentPayload[];
  reviewThreads?: CodeRabbitReviewThreadPayload[];
};

export type LoadCodeRabbitReview = (
  ctx: ExternalReviewContext,
) => Promise<CodeRabbitReviewPayload | null> | CodeRabbitReviewPayload | null;
