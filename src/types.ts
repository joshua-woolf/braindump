export type { Link, Settings, Suggestion, SavedBackup } from "../server/schema";
import type { SavedList } from "../server/schema";
export type { SavedList } from "../server/schema";
export type LinkList = SavedList & { count: number };
export type { QueueJob, QueueResult } from "../server/queue-types";
import type { Link } from "../server/schema";
export type LibraryLayout = "cards" | "list";
export type CardLink = Omit<Link, "content"> & { wordCount: number };
export type LibraryResult = {
  links: CardLink[];
  total: number;
  page: number;
  pages: number;
};
export type Tag = { name: string; count: number };
export type Status = {
  online: boolean;
  error: string | null;
  model: string;
  models: { name: string; size: number }[];
  busy: boolean;
  activeJobs: number;
  tagReviewPending: number;
  counts: Record<string, number>;
  lastTagReview: number | null;
  lastBackup: number | null;
  jobs: {
    id: number;
    kind: string;
    link_id: string | null;
    state: string;
    error: string | null;
    attempts: number;
  }[];
};
