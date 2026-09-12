import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  HardDrive,
  LoaderCircle,
  Upload,
  Cpu,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppearanceSettings } from "@/components/Appearance";
import { SavedBackups } from "@/components/SavedBackups";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { backupSchema, MAX_BACKUP_BYTES } from "../../server/schema";
import type { Settings, Status } from "@/types";

export function SettingsPage({
  status,
  changed,
  openQueue,
}: {
  status: Status | null;
  changed: () => void;
  openQueue: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<ReturnType<
    typeof backupSchema.parse
  > | null>(null);
  const [backupName, setBackupName] = useState("");
  const backupListCount = backup?.version === 2 ? backup.lists.length : 0;
  const [openingBackup, setOpeningBackup] = useState<string | null>(null);
  const [backupRevision, setBackupRevision] = useState(0);
  const preparation = useRef<AbortController | null>(null);
  const cancelRestore = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<Settings>("/settings")
      .then(setSettings)
      .catch((e) => setError(e.message));
    return () => preparation.current?.abort();
  }, []);
  async function prepareBackup(
    name: string,
    load: (signal: AbortSignal) => Promise<unknown>,
  ) {
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    setBusy(true);
    setOpeningBackup(name);
    try {
      const parsed = backupSchema.safeParse(await load(controller.signal));
      if (!parsed.success)
        throw new Error(
          "This is not a valid Braindump v1 or v2 backup. Your library was not changed.",
        );
      if (!controller.signal.aborted) {
        setBackup(parsed.data);
        setBackupName(name);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        toast.error(`Couldn’t open backup. ${(e as Error).message}`);
    } finally {
      if (!controller.signal.aborted) {
        setOpeningBackup(null);
        setBusy(false);
      }
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api("/settings", "PUT", settings);
      toast.success("Settings saved");
      changed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!backup || busy) return;
    setBusy(true);
    try {
      const result = await api<{ restored: number }>(
        "/restore",
        "POST",
        backup,
      );
      toast.success(`Restored ${result.restored} links`);
      setSettings(backup.settings);
      setBackup(null);
      setBackupRevision((value) => value + 1);
      changed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Settings &amp; Backups</h1>
          <p className="subtle">Your models, your library, your machine.</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="notice mb-5">
          {error}
        </p>
      )}
      <div className="max-w-4xl space-y-6">
        <AppearanceSettings />
        <section className="panel">
          <div className="mb-5 flex items-center gap-3">
            <Cpu className="text-primary" size={21} />
            <h2 className="font-semibold">Local Intelligence</h2>
          </div>
          <div
            className={`mb-6 flex items-center gap-2 rounded-lg p-3 text-sm ${status?.online ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
          >
            <CheckCircle2 size={16} />
            {status?.online
              ? "Connected to Ollama on this Mac"
              : "Ollama is offline. Start it with ollama serve."}
          </div>
          {settings && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="field-label" htmlFor="model">
                Summary & Tagging Model
              </label>
              <select
                id="model"
                value={settings.model}
                className="filter-select w-full max-w-none"
                onChange={(e) =>
                  setSettings({ ...settings, model: e.target.value })
                }
              >
                {[
                  ...new Set([
                    settings.model,
                    ...(status?.models.map((m) => m.name) || []),
                  ]),
                ].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <p className="mb-6 mt-3 text-sm leading-6 text-muted-foreground">
                Gemma 4 12B MLX is the default for this 24 GB Apple Silicon Mac.
                One model job runs at a time. Summaries and tags stay on your
                machine.
              </p>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="tag-frequency">
                    Tag Review Interval (Hours)
                  </label>
                  <Input
                    id="tag-frequency"
                    type="number"
                    min={0}
                    max={720}
                    required
                    value={settings.tagReviewHours}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        tagReviewHours: Number(e.target.value),
                      })
                    }
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    0 disables scheduled reviews.
                  </p>
                </div>
                <div>
                  <label className="field-label" htmlFor="backup-frequency">
                    Backup Interval (Hours)
                  </label>
                  <Input
                    id="backup-frequency"
                    type="number"
                    min={0}
                    max={720}
                    required
                    value={settings.backupHours}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        backupHours: Number(e.target.value),
                      })
                    }
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    0 disables automatic backups.
                  </p>
                </div>
              </div>
              <p className="my-5 text-sm text-muted-foreground">
                Scheduled jobs run while Braindump is open. Overdue jobs run on
                the next start.
              </p>
              <Button type="submit" disabled={busy}>
                Save settings
              </Button>
            </form>
          )}
        </section>
        <section className="panel">
          <div className="mb-4 flex items-center gap-3">
            <HardDrive className="text-primary" size={21} />
            <h2 className="font-semibold">Backup & Restore</h2>
          </div>
          <p className="mb-5 text-sm leading-7 text-muted-foreground">
            Download your complete library: links, saved article text,
            summaries, tags, read states, likes, archives, Trash, and settings.
            Keep a copy on another drive for safekeeping.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <a href="/api/backup" download>
                <Download />
                Download backup
              </a>
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              <Upload />
              Restore backup
            </Button>
            <input
              ref={file}
              className="hidden"
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const selected = e.target.files?.[0];
                e.target.value = "";
                if (!selected) return;
                if (selected.size > MAX_BACKUP_BYTES) {
                  toast.error("Backup exceeds the 256 MB restore limit.");
                  return;
                }
                void prepareBackup(selected.name, async () =>
                  JSON.parse(await selected.text()),
                );
              }}
            />
          </div>
          {openingBackup && (
            <output className="mt-3 block break-all text-sm text-muted-foreground">
              Opening {openingBackup}…
            </output>
          )}
          <p className="mt-5 text-xs leading-6 text-muted-foreground">
            Automatic backups: data/backups/ · The latest 14 automatic copies
            are kept.
            <br />
            Last automatic backup:{" "}
            {status?.lastBackup
              ? new Date(status.lastBackup).toLocaleString()
              : "not yet"}
            <br />
            Backups contain full article text and are unencrypted.
          </p>
          <SavedBackups
            refreshKey={`${status?.lastBackup ?? 0}-${backupRevision}`}
            busy={busy}
            onRestore={(saved) => {
              void prepareBackup(saved.name, (signal) =>
                api(
                  `/backups/${encodeURIComponent(saved.name)}`,
                  "GET",
                  undefined,
                  signal,
                ),
              );
            }}
          />
        </section>
        <section className="panel">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold">Recent Activity</h2>
            <Button variant="outline" size="sm" onClick={openQueue}>
              View queue
            </Button>
          </div>
          {status?.jobs.length ? (
            <div className="divide-y">
              {status.jobs.slice(0, 8).map((j) => (
                <div
                  key={j.id}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm">
                      {j.kind === "tags"
                        ? "Tag Consolidation Review"
                        : j.kind === "analyze"
                          ? "Summary & Tagging"
                          : "Page Extraction & Summary"}
                    </p>
                    {j.error && (
                      <p className="mt-1 break-words text-xs text-destructive">
                        {j.error}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {j.state === "running" ? (
                      <span className="flex gap-2">
                        <LoaderCircle size={14} className="animate-spin" />
                        Running
                      </span>
                    ) : j.state === "done" ? (
                      "Complete"
                    ) : j.state === "failed" ? (
                      "Failed"
                    ) : (
                      "Queued"
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing running. Add a link to get started.
            </p>
          )}
        </section>
      </div>
      <Dialog
        open={!!backup}
        onOpenChange={(v) => {
          if (!busy && !v) setBackup(null);
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRestore.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Replace Your Library with This Backup?</DialogTitle>
            <DialogDescription>
              This backup contains {backup?.links.length}{" "}
              {backup?.links.length === 1 ? "link" : "links"} and{" "}
              {backupListCount} {backupListCount === 1 ? "list" : "lists"},
              exported{" "}
              {backup ? new Date(backup.exportedAt).toLocaleString() : ""}. It
              replaces your current links, lists and settings.{" "}
              {backup?.version === 1
                ? "Older backups have no lists; your current lists will be removed. "
                : ""}
              A safety copy of the current library is saved in data/backups/
              before restoration.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all text-xs text-muted-foreground">
            {backupName}
          </p>
          {status?.busy && (
            <p className="text-sm text-muted-foreground">
              Wait for the current background job to finish before restoring.
            </p>
          )}
          <DialogFooter>
            <Button
              ref={cancelRestore}
              variant="outline"
              disabled={busy}
              onClick={() => setBackup(null)}
            >
              Cancel
            </Button>
            <Button disabled={busy || status?.busy} onClick={restore}>
              {busy && <LoaderCircle className="animate-spin" />}Restore library
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
