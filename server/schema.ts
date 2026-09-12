import { z } from "zod";

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export type SavedBackup = { name: string; size: number; modifiedAt: string };

export const tagName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((s) => s.toLowerCase().replace(/\s+/g, " "));
export const emptyTrashSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const linkSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url().max(8192),
  title: z.string().max(1000),
  description: z.string().max(5000),
  content: z.string().max(1_000_000),
  summary: z.string().max(20000),
  highlights: z.array(z.string().max(2000)).max(20),
  tags: z.array(tagName).max(30),
  read: z.boolean(),
  liked: z.boolean(),
  archived: z.boolean(),
  deleted: z.boolean(),
  state: z.enum(["queued", "extracting", "summarizing", "ready", "error"]),
  error: z.string().max(5000).nullable(),
  method: z.string().max(100).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  summarizedAt: z.string().datetime().nullable(),
  model: z.string().max(200).nullable(),
});
export type Link = z.infer<typeof linkSchema>;
export const settingsSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(150)
    .refine(
      (s) => !s.includes("cloud") && !s.includes("://"),
      "Choose a local model",
    ),
  tagReviewHours: z.number().int().min(0).max(720),
  backupHours: z.number().int().min(0).max(720),
});
export type Settings = z.infer<typeof settingsSchema>;
export const suggestionSchema = z.object({
  id: z.string().uuid(),
  source: tagName,
  target: tagName,
  reason: z.string().max(1000),
  status: z.enum(["pending", "accepted", "dismissed"]),
});
export type Suggestion = z.infer<typeof suggestionSchema>;
export const listName = z
  .string()
  .trim()
  .transform((name) => name.normalize("NFC").replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .refine(
        (name) =>
          name
            .split("")
            .every(
              (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
            ),
        "List names cannot contain control characters",
      ),
  );
export const listInputSchema = z.object({ name: listName }).strict();
export const savedListSchema = z.object({
  id: z.string().uuid(),
  name: listName,
  createdAt: z.string().datetime(),
});
export type SavedList = z.infer<typeof savedListSchema>;
export const membershipSchema = z.object({
  listId: z.string().uuid(),
  linkId: z.string().uuid(),
});
export type ListMembership = z.infer<typeof membershipSchema>;
const backupBase = z.object({
  format: z.literal("braindump"),
  exportedAt: z.string().datetime(),
  links: z.array(linkSchema).max(100000),
  settings: settingsSchema,
  aliases: z.array(z.object({ source: tagName, target: tagName })).max(100000),
  suggestions: z.array(suggestionSchema).max(100000),
});
export const backupSchema = z
  .discriminatedUnion("version", [
    backupBase.extend({ version: z.literal(1) }),
    backupBase.extend({
      version: z.literal(2),
      lists: z.array(savedListSchema).max(10000),
      memberships: z.array(membershipSchema).max(1000000),
    }),
  ])
  .superRefine((snapshot, ctx) => {
    if (snapshot.version === 1) return;
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const list of snapshot.lists) {
      const name = list.name.toLowerCase();
      if (ids.has(list.id) || names.has(name))
        ctx.addIssue({
          code: "custom",
          message: "Backup contains duplicate lists.",
        });
      ids.add(list.id);
      names.add(name);
    }
    const links = new Set(snapshot.links.map((link) => link.id));
    const memberships = new Set<string>();
    for (const membership of snapshot.memberships) {
      const key = `${membership.listId}:${membership.linkId}`;
      if (!ids.has(membership.listId) || !links.has(membership.linkId))
        ctx.addIssue({
          code: "custom",
          message: "Backup contains a membership for a missing list or link.",
        });
      if (memberships.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Backup contains duplicate list memberships.",
        });
      memberships.add(key);
    }
  });
export const patchSchema = z
  .object({
    read: z.boolean().optional(),
    liked: z.boolean().optional(),
    archived: z.boolean().optional(),
    deleted: z.boolean().optional(),
    title: z.string().trim().min(1).max(1000).optional(),
    tags: z.array(tagName).max(30).optional(),
  })
  .strict();
export const analysisSchema = z.object({
  summary: z.string().min(20).max(6000),
  highlights: z.array(z.string().min(1).max(1000)).min(1).max(6),
  tags: z.array(tagName).min(1).max(6),
});
