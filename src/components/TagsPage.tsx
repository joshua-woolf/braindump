import { useState } from "react";
import {
  ArrowRight,
  Combine,
  LoaderCircle,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Suggestion, Tag, Status } from "@/types";

export function TagsPage({
  tags,
  suggestions,
  changed,
  filter,
  status,
}: {
  tags: Tag[];
  suggestions: Suggestion[];
  changed: () => void;
  filter: (tag: string) => void;
  status: Status | null;
}) {
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [merge, setMerge] = useState<{ source: string; target: string } | null>(
    null,
  );
  const reviewing = !!status?.tagReviewPending;
  const lastFailed = status?.jobs.find((j) => j.kind === "tags");
  async function run(path: string, method: string, body: unknown) {
    setBusy(true);
    try {
      await api(path, method, body);
      changed();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Tags</h1>
          <p className="subtle">
            A little structure for everything you’re curious about.
          </p>
        </div>
        <Button
          disabled={busy || reviewing}
          onClick={async () => {
            if (await run("/tags/review", "POST", {}))
              toast.success("Tag review queued");
          }}
        >
          {reviewing ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
          {reviewing ? "Review queued" : "Find similar tags"}
        </Button>
      </div>
      {lastFailed?.error && (
        <p role="alert" className="notice mb-5">
          Tag review: {lastFailed.error}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <section className="panel">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="font-semibold">Your Tags</h2>
            <span className="subtle">{tags.length} total</span>
          </div>
          {tags.length ? (
            <div className="flex flex-wrap gap-3">
              {tags.map((t) => (
                <button
                  key={t.name}
                  onClick={() => filter(t.name)}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm hover:border-primary hover:text-primary"
                >
                  <span>{t.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-14 text-center text-muted-foreground">
              <Tags className="mx-auto mb-4 opacity-40" />
              <p className="text-sm">
                Tags will appear as your links are summarized.
              </p>
            </div>
          )}
        </section>
        <section className="panel">
          <h2 className="mb-2 font-semibold">Suggested Merges</h2>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            Review similar tags before combining them. Future summaries will
            reuse the name you keep.
          </p>
          {suggestions.length ? (
            <div className="space-y-4">
              {suggestions.map((s) => (
                <div className="rounded-lg border p-4" key={s.id}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="tag">{s.source}</span>
                    <ArrowRight size={14} className="text-muted-foreground" />
                    <span className="tag">{s.target}</span>
                  </div>
                  <p className="mb-3 text-sm leading-6 text-muted-foreground">
                    {s.reason}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setMerge(s)}
                    >
                      <Combine />
                      Review merge
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => run(`/suggestions/${s.id}`, "PATCH", {})}
                    >
                      <X />
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg bg-muted/60 p-5 text-sm leading-7 text-muted-foreground">
              {reviewing
                ? "Your local model will look for tags with the same meaning."
                : "No suggestions waiting. Run a review after adding more links."}
            </div>
          )}
          <p className="mt-5 text-xs text-muted-foreground">
            Last completed review:{" "}
            {status?.lastTagReview
              ? new Date(status.lastTagReview).toLocaleString()
              : "not yet"}
          </p>
        </section>
      </div>
      <section className="panel mt-6">
        <h2 className="mb-2 font-semibold">Merge or Rename a Tag</h2>
        <p className="mb-5 text-sm text-muted-foreground">
          Move every link to the name you want to keep. A backup is saved before
          each merge.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="source-tag" className="field-label">
              Tag to Replace
            </label>
            <select
              id="source-tag"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="filter-select h-9"
            >
              <option value="">Choose a tag</option>
              {tags.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
          <ArrowRight className="mb-2 text-muted-foreground" size={18} />
          <div>
            <label htmlFor="target-tag" className="field-label">
              Name to Keep
            </label>
            <Input
              id="target-tag"
              list="existing-tags"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Existing or new tag"
              maxLength={60}
            />
            <datalist id="existing-tags">
              {tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </datalist>
          </div>
          <Button
            variant="outline"
            disabled={
              !source ||
              !target.trim() ||
              source === target.trim().toLowerCase()
            }
            onClick={() =>
              setMerge({ source, target: target.trim().toLowerCase() })
            }
          >
            Review merge
          </Button>
        </div>
      </section>
      <Dialog
        open={!!merge}
        onOpenChange={(v) => {
          if (!v) setMerge(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Merge “{merge?.source}” Into “{merge?.target}”?
            </DialogTitle>
            <DialogDescription>
              This changes all links using “{merge?.source}”, including archived
              links and Trash. Future tags will also use “{merge?.target}”. A
              local backup is saved first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMerge(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (await run("/tags/merge", "POST", merge)) {
                  setMerge(null);
                  setSource("");
                  setTarget("");
                  toast.success("Tags merged");
                }
              }}
            >
              Merge tags
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
