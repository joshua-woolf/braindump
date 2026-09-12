import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

type Preview = { count: number; running: number; token: string };

export function EmptyTrash({
  count,
  changed,
}: {
  count?: number;
  changed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPreview(null);
    setError("");
    void api<Preview>("/trash", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, revision]);

  async function empty() {
    if (!preview || busy || !preview.count || preview.running) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ deleted: number; backup: string | null }>(
        "/trash/empty",
        "POST",
        { token: preview.token },
      );
      setOpen(false);
      changed();
      toast.success(
        `Permanently deleted ${result.deleted} ${result.deleted === 1 ? "link" : "links"}`,
        { description: "Safety backup saved in data/backups." },
      );
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="text-danger"
          disabled={count === 0}
        >
          <Trash2 />
          Empty Trash
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Empty Trash?</DialogTitle>
          <DialogDescription>
            Permanently remove every link in Trash, including links hidden by
            search or filters. Your other saved links and lists stay intact.
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="space-y-3 text-sm">
            <p className="font-medium text-foreground" aria-live="polite">
              {preview.count
                ? `${preview.count} ${preview.count === 1 ? "link will" : "links will"} be permanently deleted.`
                : "Trash is already empty."}
            </p>
            {preview.running > 0 && (
              <output className="block text-warning">
                A link in Trash is still processing. Wait for it to finish, then
                review Trash again.
              </output>
            )}
            <p className="text-muted-foreground">
              A safety backup is saved in data/backups before deletion. There is
              no Undo; recovery restores the entire library from that backup in
              Settings &amp; Backups.
            </p>
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking Trash…
          </output>
        )}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          {error || (preview && preview.running > 0) ? (
            <Button
              variant="outline"
              onClick={() => setRevision((value) => value + 1)}
            >
              Review Trash
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={busy || !preview?.count}
              onClick={() => void empty()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {busy ? "Emptying Trash…" : "Delete Permanently"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
