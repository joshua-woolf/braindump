import { z } from "zod";

const storageKey = "braindump.view.v1";
const statusFilter = z.enum(["", "all", "true", "false"]).catch("");
const queueViewSchema = z.object({
  query: z.string().max(200).catch(""),
  page: z.number().int().min(1).max(1_000_000).catch(1),
});
const viewStateSchema = z.object({
  view: z
    .enum([
      "all",
      "unread",
      "liked",
      "attention",
      "archived",
      "deleted",
      "tags",
      "lists",
      "settings",
      "queue",
    ])
    .catch("all"),
  query: z.string().max(8192).catch(""),
  tag: z.string().max(60).catch(""),
  listId: z.union([z.literal(""), z.uuid()]).catch(""),
  read: statusFilter,
  liked: statusFilter,
  archived: statusFilter,
  deleted: statusFilter,
  state: z
    .enum(["", "ready", "queued", "extracting", "summarizing", "error"])
    .catch(""),
  sort: z.enum(["newest", "oldest", "title"]).catch("newest"),
  advanced: z.boolean().catch(false),
  queue: queueViewSchema.catch({ query: "", page: 1 }),
});

export type QueueViewState = z.infer<typeof queueViewSchema>;

export function readViewState(storage?: Pick<Storage, "getItem">) {
  try {
    const saved = (storage ?? window.sessionStorage).getItem(storageKey);
    return viewStateSchema.parse(saved ? JSON.parse(saved) : {});
  } catch {
    // Invalid or unavailable tab storage must never prevent opening the app.
    return viewStateSchema.parse({});
  }
}

export function saveViewState(
  state: unknown,
  storage?: Pick<Storage, "setItem">,
) {
  try {
    (storage ?? window.sessionStorage).setItem(
      storageKey,
      JSON.stringify(viewStateSchema.parse(state)),
    );
  } catch {
    // Navigation still works when tab storage is blocked or full.
  }
}
