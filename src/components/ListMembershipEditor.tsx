import { useEffect, useId, useState } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { SavedList } from "@/types";

export function ListMembershipEditor({
  linkId,
  changed,
}: {
  linkId: string;
  changed: () => void;
}) {
  const fieldId = useId();
  const [lists, setLists] = useState<SavedList[]>([]);
  const [memberships, setMemberships] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError("");
    void Promise.all([
      api<{ lists: SavedList[] }>(
        "/lists",
        "GET",
        undefined,
        controller.signal,
      ),
      api<{ listIds: string[] }>(
        `/links/${linkId}/lists`,
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([all, current]) => {
        if (controller.signal.aborted) return;
        setLists(all.lists);
        setMemberships(current.listIds);
        setLoaded(true);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [linkId, revision]);
  async function toggle(listId: string, included: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/lists/${listId}/links/${linkId}`,
        included ? "PUT" : "DELETE",
        {},
      );
      setMemberships((ids) =>
        included ? [...ids, listId] : ids.filter((id) => id !== listId),
      );
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const list = await api<SavedList>("/lists", "POST", { name, linkId });
      setLists((all) =>
        [...all, list].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setMemberships((ids) => [...ids, list.id]);
      setName("");
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose any number of lists. Changes save immediately and stay when the
        link is reanalyzed.
      </p>
      {!loaded && !error && (
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="animate-spin" size={16} />
          Loading lists…
        </output>
      )}
      {loaded && (
        <fieldset
          disabled={busy}
          className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2"
        >
          <legend className="sr-only">Lists for This Link</legend>
          {lists.length ? (
            lists.map((list) => (
              <label
                key={list.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-3 hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={memberships.includes(list.id)}
                  onChange={(e) => void toggle(list.id, e.target.checked)}
                />
                <span className="min-w-0 break-words text-sm">{list.name}</span>
              </label>
            ))
          ) : (
            <p className="p-2 text-sm text-muted-foreground">
              No lists yet. Create your first one below.
            </p>
          )}
        </fieldset>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-danger"
        >
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setRevision((v) => v + 1)}
          >
            Refresh Lists
          </Button>
        </div>
      )}
      {loaded && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field-label" htmlFor={fieldId}>
            New List
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={fieldId}
              className="min-w-0 flex-1 basis-40"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Name a new list"
              required
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              <Plus size={16} />
              Create & Add
            </Button>
          </div>
        </form>
      )}
      <output className="block text-xs text-muted-foreground">
        {busy ? "Saving…" : loaded && !error ? "All changes saved." : ""}
      </output>
    </div>
  );
}
