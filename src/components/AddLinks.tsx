import { useEffect, useState } from "react";
import { Plus, Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { LinkList } from "@/types";

export function AddLinks({
  open,
  onOpenChange,
  done,
  lists,
  defaultListId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  done: () => void;
  lists: LinkList[];
  defaultListId: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listId, setListId] = useState(defaultListId);
  useEffect(() => {
    if (open) setListId(defaultListId);
  }, [open, defaultListId]);
  const count = new Set(text.match(/https?:\/\/[^\s<>"']+/gi) || []).size;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const { results } = await api<{
        results: { id: string; duplicate: boolean }[];
      }>("/links", "POST", { text, ...(listId ? { listId } : {}) });
      const added = results.filter((r) => !r.duplicate).length;
      const duplicates = results.length - added;
      toast.success(
        `${added} ${added === 1 ? "link" : "links"} saved${duplicates ? ` · ${duplicates} already in your library (including Trash)` : ""}${listId ? " · Added to list" : ""}`,
      );
      setText("");
      onOpenChange(false);
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v);
          setError("");
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-accent text-primary">
            <Link2 size={21} />
          </div>
          <DialogTitle className="text-xl">
            A Place for Your Next Rabbit Hole.
          </DialogTitle>
          <DialogDescription>
            Paste one or more links. We’ll save the pages, summarize them, and
            find the right tags.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field-label mt-4" htmlFor="link-input">
            Webpage Links
          </label>
          <Textarea
            id="link-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://example.com/something-worth-reading\nhttps://another.site/a-good-idea"
            }
            className="min-h-44 resize-y text-sm leading-7"
          />
          <div className="mt-3 flex justify-between text-xs text-muted-foreground">
            <span>One per line, or paste a list. Up to 100 at once.</span>
            <span>{count} detected</span>
          </div>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <label className="field-label mt-5" htmlFor="add-to-list">
            Add to List
          </label>
          <select
            id="add-to-list"
            className="filter-select w-full"
            value={listId}
            disabled={busy}
            onChange={(e) => setListId(e.target.value)}
          >
            <option value="">No list</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
          {listId && (
            <p className="mt-2 text-xs text-muted-foreground">
              Existing links are added too. Their read, archive, and Trash
              statuses stay as they are.
            </p>
          )}
          <DialogFooter className="mt-7">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!count || busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}Save{" "}
              {count > 1 ? `${count} links` : "link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
