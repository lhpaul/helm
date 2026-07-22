/** Haystack `triage --json` payload (subset used by the adapter). */
export type HaystackTriageFinding = {
  id?: string | number;
  category?: string | null;
  summary?: string;
  detail?: string;
  agentFixPrompt?: string;
  source?: HaystackFindingSource | null;
};

export type HaystackFindingSource = {
  id?: string | number;
  path?: string;
  file?: string;
  filepath?: string;
  filename?: string;
  line?: number;
  startLine?: number;
};

export type HaystackTriageJson = {
  owner?: string;
  repo?: string;
  prNumber?: number;
  rating?: number;
  status?: string;
  message?: string;
  findings?: HaystackTriageFinding[];
};

export type HaystackPrStatusJson = {
  bucket?: string;
  analysisStatus?: string;
  analysisVerdict?: string;
  haystackRating?: number | string;
  hasReviewer?: boolean;
  needsHumanReview?: boolean;
  inputs?: {
    analysisStatus?: string;
    analysisVerdict?: string;
    haystackRating?: number | string;
    hasReviewer?: boolean;
    needsHumanReview?: boolean;
  };
};

export type HaystackReviewConfig = {
  majorIsBlocking: boolean;
  pollIntervalSec: number;
  timeoutSec: number;
  deferWhenPending: boolean;
};

export type RunHaystack = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type SleepFn = (ms: number) => Promise<void>;
