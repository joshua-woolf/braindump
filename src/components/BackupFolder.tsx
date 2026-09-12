import { useEffect, useState } from "react";
import { FolderInput, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { BackupDirectoryResult } from "../../server/schema";

export function BackupFolder({
  busy,
  setBusy,
  onMoved,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMoved: () => void;
}) {
  const [directory, setDirectory] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BackupDirectoryResult | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<{ directory: string }>(
      "/settings/backup-directory",
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setDirectory(value.directory);
        setDraft(value.directory);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  async function save() {
    if (busy || directory === null) return;
    setBusy(true);
    setMoving(true);
    setError("");
    setResult(null);
    try {
      const saved = await api<BackupDirectoryResult>(
        "/settings/backup-directory",
        "PUT",
        { directory: draft },
      );
      setDirectory(saved.directory);
      setDraft(saved.directory);
      setResult(saved);
      onMoved();
    } catch (e) {
      setError(`Couldn’t move backups. ${(e as Error).message}`);
    } finally {
      setMoving(false);
      setBusy(false);
    }
  }
  return (
    <form
      className="mb-6 border-b border-border pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field-label" htmlFor="backup-folder">
        Backup Folder
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          id="backup-folder"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || loading || directory === null}
          required
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="backup-folder-help"
          placeholder={
            loading ? "Loading folder…" : "/absolute/path/to/backups"
          }
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={
            busy ||
            loading ||
            !draft.trim() ||
            directory === null ||
            draft === directory
          }
        >
          {moving ? <LoaderCircle className="animate-spin" /> : <FolderInput />}
          {moving ? "Moving Backups…" : "Save Backup Folder"}
        </Button>
      </div>
      <p
        id="backup-folder-help"
        className="mt-3 text-xs leading-6 text-muted-foreground"
      >
        Enter an absolute path or use ~/. Saving moves existing backups and
        sends all future backups here. This folder choice stays on this
        installation when you restore a library.
      </p>
      {directory && (
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Current folder: {directory}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-danger">
          {error}
        </p>
      )}
      {directory === null && !loading && (
        <Button
          className="mt-3"
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setRevision((value) => value + 1)}
        >
          Retry
        </Button>
      )}
      {result && (
        <output className="mt-3 block text-sm text-success">
          Backup folder saved. {result.moved}{" "}
          {result.moved === 1 ? "backup moved" : "backups moved"}.
        </output>
      )}
      {!!result?.leftBehind.length && (
        <div role="alert" className="mt-3 text-sm text-warning">
          All backups are saved in the new folder, but these originals could not
          be removed. Check them before removing them manually:
          <ul className="mt-2 list-inside list-disc break-all">
            {result.leftBehind.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
