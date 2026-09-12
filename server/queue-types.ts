export type JobKind = "process" | "analyze" | "tags";
export type JobStage = "extracting" | "summarizing" | "reviewing-tags";
export type CurrentJob = {
  id: number;
  stage: JobStage;
  model: string | null;
  startedAt: string;
};
export type QueueJob = {
  id: number;
  kind: JobKind;
  linkId: string | null;
  title: string;
  url: string | null;
  state: "queued" | "running";
  linkState: string | null;
  deleted: number;
  attempts: number;
  error: string | null;
  availableAt: number;
  createdAt: string;
  priority: number;
  position: number;
};
export type QueueResult = {
  running: QueueJob[];
  waiting: QueueJob[];
  current: CurrentJob | null;
  model: string;
  total: number;
  waitingTotal: number;
  retrying: number;
  page: number;
  pages: number;
};
