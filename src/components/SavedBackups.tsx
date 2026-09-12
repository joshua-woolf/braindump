import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { MAX_BACKUP_BYTES } from "../../server/schema";
import type { SavedBackup } from "@/types";

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SavedBackups({
  refreshKey,
  busy,
  onRestore,
}: {
  refreshKey: string;
  busy: boolean;
  onRestore: (backup: SavedBackup) => void;
}) {
  const [backups, setBackups] = useState<SavedBackup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(10);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<{ backups: SavedBackup[] }>(
      "/backups",
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setBackups(result.backups);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const timer = setTimeout(() => setRevision((value) => value + 1), 30_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refreshKey, revision]);

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Available Backups</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        Manual, automatic and safety snapshots in your backup folder, newest
        first. Files are checked before restoration.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          Couldn’t load backups. {error}
        </p>
      )}
      {!backups && loading && (
        <output className="mt-4 block text-sm text-muted-foreground">
          Loading backups…
        </output>
      )}
      {backups?.length === 0 && (
        <div className="py-5">
          <h4 className="text-sm font-medium">No Saved Backups Yet</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose Create Backup to save a copy here. Download Backup saves a
            copy to your browser’s download folder.
          </p>
        </div>
      )}
      {!!backups?.length && (
        <ul className="mt-3 divide-y divide-border">
          {backups.slice(0, limit).map((backup) => (
            <li
              key={backup.name}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="break-all text-sm font-medium text-foreground">
                  {backup.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <time dateTime={backup.modifiedAt} title="Last modified">
                    {new Date(backup.modifiedAt).toLocaleString()}
                  </time>
                  {" · "}
                  {fileSize(backup.size)}
                </p>
                {backup.size > MAX_BACKUP_BYTES && (
                  <p className="mt-1 text-xs text-warning">
                    Over the 256 MB limit. Access this file in your backup
                    folder.
                  </p>
                )}
                {backup.size === 0 && (
                  <p className="mt-1 text-xs text-warning">
                    This file is empty.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {backup.size <= MAX_BACKUP_BYTES && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`/api/backups/${encodeURIComponent(backup.name)}`}
                      download={backup.name}
                      aria-label={`Download ${backup.name}`}
                    >
                      <Download />
                      Download
                    </a>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || backup.size === 0 || backup.size > MAX_BACKUP_BYTES
                  }
                  onClick={() => onRestore(backup)}
                  aria-label={`Restore ${backup.name}`}
                >
                  <RotateCcw />
                  Restore
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {backups && backups.length > limit && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setLimit((value) => value + 10)}
        >
          Show more backups ({backups.length - limit} remaining)
        </Button>
      )}
    </div>
  );
}
