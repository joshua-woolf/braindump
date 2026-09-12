import { useEffect, useState } from "react";
import {
  Archive,
  Check,
  ExternalLink,
  Heart,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { ListMembershipEditor } from "@/components/ListMembershipEditor";
import type { Link } from "@/types";

type ReaderProps = {
  id: string | null;
  close: () => void;
  changed: () => void;
};

// Each selection owns its state. Late mutations and polls for a closed reader
// cannot populate another link's reader or change its action targets.
export function Reader(props: ReaderProps) {
  return <SelectedReader key={props.id} {...props} />;
}

function SelectedReader({ id, close, changed }: ReaderProps) {
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [tags, setTags] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLink(null);
    setPaste("");
    setError("");
    let first = true;
    async function load() {
      try {
        const l = await api<Link>(`/links/${id}`);
        if (!cancelled) {
          setLink(l);
          if (first) {
            setTags(l.tags.join(", "));
            setPageUrl(l.url);
            first = false;
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);
  async function patch(p: Partial<Link>) {
    setBusy(true);
    try {
      setLink(await api<Link>(`/links/${id}`, "PATCH", p));
      changed();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function run(action: string, body: unknown = {}) {
    setBusy(true);
    try {
      await api(`/links/${id}/${action}`, "POST", body);
      const updated = await api<Link>(`/links/${id}`);
      setLink(updated);
      if (action === "repair-url") setPageUrl(updated.url);
      changed();
      toast.success(
        action === "refetch" || action === "repair-url"
          ? "Page re-fetch queued"
          : "Summary and tags queued",
      );
      setPaste("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const currentTags = link?.tags.join(", ") || "";
  useEffect(() => {
    setTags(currentTags);
  }, [currentTags, id]);
  const processing =
    link && ["queued", "extracting", "summarizing"].includes(link.state);
  return (
    <Dialog
      open={!!id}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto p-7 sm:max-w-3xl sm:p-10">
        <DialogHeader>
          <DialogTitle className="pr-6 text-2xl leading-snug tracking-tight">
            {link?.title || "Opening Link…"}
          </DialogTitle>
          <DialogDescription className="break-all">
            {link ? new URL(link.url).hostname : "Loading saved content"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!link && !error && (
          <LoaderCircle className="my-12 animate-spin justify-self-center text-primary" />
        )}
        {link && (
          <>
            <div className="flex flex-wrap gap-2 border-b pb-5">
              <Button asChild size="sm">
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  Open original
                  <ExternalLink size={14} />
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => patch({ read: !link.read })}
              >
                <Check />
                {link.read ? "Mark unread" : "Mark read"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={link.liked ? "text-danger" : ""}
                disabled={busy}
                onClick={() => patch({ liked: !link.liked })}
              >
                <Heart fill={link.liked ? "currentColor" : "none"} />
                {link.liked ? "Liked" : "Like"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => patch({ archived: !link.archived })}
              >
                <Archive />
                {link.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => patch({ deleted: !link.deleted })}
              >
                {link.deleted ? <RotateCcw /> : <Trash2 />}
                {link.deleted ? "Restore" : "Trash"}
              </Button>
            </div>
            {processing && (
              <div className="notice flex items-center gap-2">
                <LoaderCircle size={16} className="animate-spin" />
                {link.state === "queued"
                  ? "Waiting for a background worker."
                  : link.state === "extracting"
                    ? "Extracting the page content…"
                    : "Your local model is reading this page…"}
              </div>
            )}
            {link.error && (
              <div
                role="alert"
                className="rounded-lg bg-danger-soft p-4 text-sm leading-relaxed text-danger"
              >
                {link.error}
              </div>
            )}
            {link.method?.endsWith("-metadata") && (
              <div className="notice text-sm leading-6">
                Only the page’s public description was available. This summary
                does not cover the full page or video.
              </div>
            )}
            <Tabs defaultValue={link.state === "error" ? "manage" : "summary"}>
              <TabsList className="mb-5">
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="article">Saved Article</TabsTrigger>
                <TabsTrigger value="manage">Manage</TabsTrigger>
              </TabsList>
              <TabsContent value="summary">
                <p className="whitespace-pre-wrap text-base leading-8 text-content">
                  {link.summary ||
                    "Your summary will appear here once processing is complete."}
                </p>
                {link.highlights.length > 0 && (
                  <>
                    <h3 className="mb-4 mt-7 text-sm font-semibold">
                      Key Takeaways
                    </h3>
                    <ul className="space-y-4">
                      {link.highlights.map((point, i) => (
                        <li
                          key={i}
                          className="flex gap-3 text-sm leading-7 text-content"
                        >
                          <span className="mt-0.5 text-primary">—</span>
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="tags mt-7">
                  {link.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
                {link.summarizedAt && (
                  <p className="mt-7 text-xs leading-6 text-muted-foreground">
                    Summarized with {link.model} ·{" "}
                    {new Date(link.summarizedAt).toLocaleString()}
                    <br />
                    AI summaries can miss details. Check the original for
                    important claims.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="article">
                <div className="reader-text">
                  {link.content ||
                    "No article text saved yet. Re-fetch the page, or paste the text in Manage."}
                </div>
              </TabsContent>
              <TabsContent value="manage" className="space-y-7">
                <section>
                  <label className="field-label" htmlFor="page-url">
                    Page URL
                  </label>
                  <p className="mb-3 text-sm leading-6 text-muted-foreground">
                    Correct a broken or moved address. This saves a safety
                    backup, replaces the old text, summary and tags, and
                    processes the new page. Your read status, likes and lists
                    are kept.
                  </p>
                  <Input
                    id="page-url"
                    type="url"
                    value={pageUrl}
                    onChange={(e) => setPageUrl(e.target.value)}
                    disabled={busy || !!processing || link.deleted}
                  />
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      !!processing ||
                      link.deleted ||
                      !pageUrl.trim() ||
                      pageUrl.trim() === link.url
                    }
                    onClick={() => run("repair-url", { url: pageUrl })}
                  >
                    Update URL & re-fetch
                  </Button>
                </section>
                <section>
                  <h3 className="field-label">Lists</h3>
                  <ListMembershipEditor
                    key={link.id}
                    linkId={link.id}
                    changed={changed}
                  />
                </section>
                <section>
                  <h3 className="field-label">Summary & Tags</h3>
                  <p className="mb-3 text-sm leading-6 text-muted-foreground">
                    Analyze the saved text again, or fetch the latest version of
                    the webpage first.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || !!processing || link.deleted || !link.content
                      }
                      onClick={() => run("analyze")}
                    >
                      <Sparkles />
                      Reanalyze saved text
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !!processing || link.deleted}
                      onClick={() => run("refetch")}
                    >
                      <RefreshCw />
                      Re-fetch page
                    </Button>
                  </div>
                </section>
                <section>
                  <label className="field-label" htmlFor="edit-tags">
                    Tags
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="edit-tags"
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder="design, technology, reading"
                    />
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void patch({
                          tags: [
                            ...new Set(
                              tags
                                .split(",")
                                .map((t) => t.trim().toLowerCase())
                                .filter(Boolean),
                            ),
                          ],
                        }).then((ok) => {
                          if (ok) toast.success("Tags saved");
                        })
                      }
                    >
                      Save tags
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Separate tags with commas. Analysis replaces these tags.
                  </p>
                </section>
                <section>
                  <label className="field-label" htmlFor="paste-content">
                    Paste Article Text
                  </label>
                  <p className="mb-3 text-sm leading-6 text-muted-foreground">
                    For pages that need a login or a manual challenge, copy text
                    you can access in your browser. This replaces the saved
                    article and queues a new summary.
                  </p>
                  <Textarea
                    id="paste-content"
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    className="min-h-40"
                    placeholder="Paste the full article here…"
                  />
                  <Button
                    className="mt-3"
                    size="sm"
                    disabled={
                      busy ||
                      !!processing ||
                      link.deleted ||
                      paste.trim().length < 180
                    }
                    onClick={() => run("content", { content: paste })}
                  >
                    Save text & summarize
                  </Button>
                </section>
                <p className="break-all text-xs leading-6 text-muted-foreground">
                  Saved {new Date(link.createdAt).toLocaleString()}
                  <br />
                  Extraction: {link.method || "pending"}
                  <br />
                  {link.url}
                </p>
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
