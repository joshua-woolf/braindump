import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ArrowUpToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ListOrdered,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { QueueViewState } from "@/lib/view-state";
import type { QueueJob, QueueResult, Status } from "@/types";

function jobTitle(job: QueueJob) {
  return job.kind === "tags" ? "Tag Consolidation Review" : job.title;
}

function kindLabel(job: QueueJob) {
  return job.kind === "tags"
    ? "Find similar tags"
    : job.kind === "analyze"
      ? "Summarize & tag saved text"
      : "Fetch page, summarize & tag";
}

export function QueuePage({
  status,
  changed,
  openLink,
  view,
  setView,
}: {
  status: Status | null;
  changed: () => void;
  openLink: (id: string) => void;
  view: QueueViewState;
  setView: Dispatch<SetStateAction<QueueViewState>>;
}) {
  const [data, setData] = useState<QueueResult | null>(null);
  const { query, page } = view;
  const [search, setSearch] = useState(query);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [promoting, setPromoting] = useState<number | null>(null);
  const generation = useRef(0);
  function setQuery(query: string) {
    setView({ query, page: 1 });
  }
  function setPage(page: number) {
    setView((current) => ({ ...current, page }));
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setLoading(true);
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      const requestGeneration = generation.current;
      try {
        const params = new URLSearchParams({ page: String(page), q: search });
        const result = await api<QueueResult>(`/queue?${params}`);
        if (!cancelled && requestGeneration === generation.current) {
          setData(result);
          setError("");
          if (result.page !== page)
            setView((current) => ({ ...current, page: result.page }));
        }
      } catch (e) {
        if (!cancelled && requestGeneration === generation.current)
          setError((e as Error).message);
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [page, search, revision, setView]);

  async function promote(job: QueueJob) {
    if (promoting !== null) return;
    setPromoting(job.id);
    generation.current++;
    try {
      await api(`/queue/${job.id}/promote`, "POST", {});
      setQuery("");
      setSearch("");
      setPage(1);
      toast.success(`“${jobTitle(job)}” moved to the top`, {
        description: "It will run after the current job finishes.",
      });
      changed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPromoting(null);
      setRevision((v) => v + 1);
    }
  }

  function title(job: QueueJob) {
    return job.linkId ? (
      <button
        className="break-words text-left font-medium hover:text-primary"
        onClick={() => openLink(job.linkId!)}
      >
        {jobTitle(job)}
        {job.deleted ? " (in Trash)" : ""}
      </button>
    ) : (
      <span className="font-medium">{jobTitle(job)}</span>
    );
  }

  const running = data?.running || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Queue</h1>
          <p className="subtle">Choose what your local model works on next.</p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-5 rounded-lg bg-danger-soft p-4 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {status && !status.online && (
        <div className="notice mb-5">
          Ollama is offline. Start it to process summaries and tags; the queue
          is saved.
        </div>
      )}
      <div
        className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <span>
          <strong className="font-semibold text-foreground">
            {running.length}
          </strong>{" "}
          running
        </span>
        <span>
          <strong className="font-semibold text-foreground">
            {data?.waitingTotal ?? "—"}
          </strong>{" "}
          waiting
        </span>
        {!!data?.retrying && (
          <span>
            <strong className="font-semibold text-foreground">
              {data.retrying}
            </strong>{" "}
            waiting to retry
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs">
          <Sparkles size={14} />
          {data?.model || status?.model || "Local Ollama"}
        </span>
      </div>
      <section
        className="panel queue-running mb-6"
        aria-labelledby="running-heading"
      >
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-primary">
          {running.length ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : (
            <Check size={16} />
          )}
          <h2 id="running-heading">
            {running.length ? "Running Now" : "No Job Running"}
          </h2>
        </div>
        {running.length ? (
          running.map((job) => {
            const current = data?.current?.id === job.id ? data.current : null;
            const stage =
              current?.stage ||
              (job.kind === "tags"
                ? "reviewing-tags"
                : job.linkState === "extracting"
                  ? "extracting"
                  : "summarizing");
            return (
              <div key={job.id} className="min-w-0">
                <div className="text-lg">{title(job)}</div>
                {job.url && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {job.url}
                  </p>
                )}
                <p className="mt-4 text-sm text-primary">
                  {stage === "extracting"
                    ? "Extracting the page before sending its text to Ollama"
                    : stage === "reviewing-tags"
                      ? "Reviewing tags for possible consolidation"
                      : "Generating a summary and tags"}
                  {current?.model && (
                    <span className="ml-1">· {current.model}</span>
                  )}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Attempt {job.attempts} of 3
                  {current?.startedAt
                    ? ` · Started ${new Date(current.startedAt).toLocaleTimeString()}`
                    : ""}
                </p>
              </div>
            );
          })
        ) : (
          <p className="text-sm text-muted-foreground">
            {loading && !data
              ? "Loading the queue…"
              : data?.waitingTotal
                ? "The next eligible job will start automatically."
                : "Your queue is clear."}
          </p>
        )}
      </section>
      <section className="panel !p-0" aria-labelledby="waiting-heading">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <h2 id="waiting-heading" className="font-semibold">
            Up Next
          </h2>
          <div className="relative w-full sm:w-80">
            <Search
              size={16}
              className="absolute left-3 top-2.5 text-muted-foreground"
            />
            <Input
              aria-label="Search queued jobs"
              placeholder="Find a queued link…"
              className="bg-card pl-9 pr-9"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="absolute right-3 top-2.5 text-muted-foreground"
                aria-label="Clear queue search"
                onClick={() => setQuery("")}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <p className="border-b px-5 py-3 text-xs leading-6 text-muted-foreground sm:px-6">
          Move a waiting item to the top to run it next. The current job keeps
          running. Moving an item that is waiting to retry makes it eligible
          immediately.
        </p>
        {loading && !data ? (
          <div className="flex justify-center p-12">
            <LoaderCircle
              aria-label="Loading queued jobs"
              className="animate-spin text-primary"
            />
          </div>
        ) : data?.waiting.length ? (
          <ol className="divide-y" aria-busy={loading}>
            {data.waiting.map((job) => {
              const delayed = job.availableAt > Date.now();
              return (
                <li
                  key={job.id}
                  className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 px-5 py-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:px-6"
                >
                  <span
                    className="mt-1 w-8 shrink-0 text-right font-mono text-xs text-muted-foreground"
                    aria-label={`Queue position ${job.position}`}
                  >
                    {job.position}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm leading-6">{title(job)}</div>
                    {job.url && (
                      <p
                        className="mt-1 truncate text-xs text-muted-foreground"
                        title={job.url}
                      >
                        {job.url}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{kindLabel(job)}</span>
                      {delayed ? (
                        <span className="flex items-center gap-1 text-warning">
                          <Clock3 size={12} />
                          Retry after{" "}
                          {new Date(job.availableAt).toLocaleTimeString()}
                        </span>
                      ) : job.position === 1 ? (
                        <span className="text-primary">Next to run</span>
                      ) : null}
                      {job.attempts > 0 && (
                        <span>{job.attempts} of 3 attempts used</span>
                      )}
                      {job.priority > 0 && (
                        <span className="text-primary">Prioritized</span>
                      )}
                    </div>
                    {job.error && (
                      <details className="mt-2 text-xs text-danger">
                        <summary className="cursor-pointer">
                          Previous Attempt Failed
                        </summary>
                        <p className="mt-2 break-words leading-6">
                          {job.error}
                        </p>
                      </details>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="col-start-2 justify-self-start bg-card sm:col-start-3"
                    disabled={
                      promoting !== null || (job.position === 1 && !delayed)
                    }
                    onClick={() => promote(job)}
                    aria-label={`Move ${jobTitle(job)} to top of queue`}
                  >
                    {promoting === job.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <ArrowUpToLine />
                    )}
                    Move to top
                  </Button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <ListOrdered size={28} className="mb-3 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              {search
                ? "No queued jobs match your search."
                : "No jobs waiting. New links will appear here."}
            </p>
          </div>
        )}
        {!!data?.pages && (
          <div className="flex flex-col justify-between gap-3 border-t px-5 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:px-6">
            <span>
              {data.total} {search ? "matching" : "waiting"}{" "}
              {data.total === 1 ? "job" : "jobs"} · Updates every 3 seconds
            </span>
            {data.pages > 1 && (
              <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={data.page === 1 || loading}
                  aria-label="Previous queue page"
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span>
                  {data.page} / {data.pages}
                </span>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={data.page >= data.pages || loading}
                  aria-label="Next queue page"
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
