import { useState } from "react";
import { Folder, Pencil, Plus, Trash2, LoaderCircle } from "lucide-react";
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
import type { LinkList } from "@/types";

export function ListsPage({
  lists,
  loaded,
  changed,
  openList,
}: {
  lists: LinkList[];
  loaded: boolean;
  changed: () => void;
  openList: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [action, setAction] = useState<{
    kind: "rename" | "delete";
    list: LinkList;
  } | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setBusy(true);
    setError("");
    try {
      await api("/lists", "POST", { name });
      setName("");
      changed();
      toast.success("List created");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/lists/${action.list.id}`,
        action.kind === "rename" ? "PATCH" : "DELETE",
        action.kind === "rename" ? { name: editName } : {},
      );
      changed();
      toast.success(
        action.kind === "rename"
          ? "List renamed"
          : "List deleted. Your links are still saved.",
      );
      setAction(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Lists</h1>
          <p className="subtle">
            Make space for a project, a topic, or your next rabbit hole.
          </p>
        </div>
      </div>
      <form
        className="mb-6 rounded-xl border bg-card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field-label" htmlFor="new-list-name">
          New List
        </label>
        <div className="flex flex-wrap gap-3">
          <Input
            id="new-list-name"
            className="min-w-0 flex-1 basis-48"
            placeholder="e.g. Weekend reading"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            required
          />
          <Button type="submit" disabled={busy || !name.trim()}>
            <Plus size={16} />
            Create List
          </Button>
        </div>
        {!action && error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </form>
      {!loaded ? (
        <div className="empty-state">
          <LoaderCircle className="animate-spin text-primary" />
          <p>Loading lists…</p>
        </div>
      ) : lists.length ? (
        <div className="space-y-3" aria-label="Saved lists">
          {lists.map((list) => (
            <article
              key={list.id}
              className="flex items-center gap-3 rounded-xl border bg-card p-4 sm:p-5"
            >
              <Folder className="shrink-0 text-primary" size={21} />
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">
                  <button
                    className="max-w-full break-words text-left hover:text-primary"
                    onClick={() => openList(list.id)}
                  >
                    {list.name}
                  </button>
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {list.count} {list.count === 1 ? "link" : "links"} · Includes
                  Archive
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Rename ${list.name}`}
                title="Rename List"
                disabled={busy}
                onClick={() => {
                  setAction({ kind: "rename", list });
                  setEditName(list.name);
                  setError("");
                }}
              >
                <Pencil size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-danger"
                aria-label={`Delete ${list.name}`}
                title="Delete List"
                disabled={busy}
                onClick={() => {
                  setAction({ kind: "delete", list });
                  setError("");
                }}
              >
                <Trash2 size={16} />
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">
            <Folder size={30} />
          </div>
          <h2>A Little Order for Your Ideas.</h2>
          <p>
            Create a list above, then use the folder button on any saved link to
            add it. A link can belong to more than one list.
          </p>
        </div>
      )}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAction(null);
            setError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "rename" ? "Rename List" : "Delete List?"}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "rename"
                ? "Give this collection a new name."
                : `Delete “${action?.list.name}”? Your saved links will remain in your library and in any other lists.`}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            {action?.kind === "rename" && (
              <>
                <label htmlFor="rename-list" className="field-label">
                  List Name
                </label>
                <Input
                  id="rename-list"
                  maxLength={80}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  disabled={busy}
                />
              </>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            )}
            <DialogFooter className="mt-5">
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  setAction(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action?.kind === "delete" ? "destructive" : "default"}
                disabled={
                  busy || (action?.kind === "rename" && !editName.trim())
                }
              >
                {busy && <LoaderCircle className="animate-spin" />}
                {action?.kind === "rename" ? "Save Name" : "Delete List"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
