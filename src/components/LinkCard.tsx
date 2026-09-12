import {
  Archive,
  ArchiveRestore,
  Check,
  Heart,
  RotateCcw,
  Trash2,
  LoaderCircle,
  Circle,
  AlertCircle,
  Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteIcon } from "@/components/SiteIcon";
import type { CardLink, LibraryLayout, Link } from "@/types";

export function LinkCard({
  link,
  layout = "cards",
  showError = false,
  open,
  update,
  filterTag,
  manageLists,
}: {
  link: CardLink;
  layout?: LibraryLayout;
  showError?: boolean;
  open: () => void;
  update: (patch: Partial<Link>) => void;
  filterTag: (tag: string) => void;
  manageLists: () => void;
}) {
  const domain = new URL(link.url).hostname.replace(/^www\./, "");
  const compact = layout === "list";
  const processing =
    !link.deleted &&
    ["queued", "extracting", "summarizing"].includes(link.state);
  const likeButton = (
    <Button
      variant="ghost"
      size="icon"
      className={`${compact ? "size-8" : "absolute right-4 top-5 size-8"} ${link.liked ? "text-danger" : "text-muted-foreground"}`}
      aria-label={link.liked ? "Unlike link" : "Like link"}
      aria-pressed={link.liked}
      title={link.liked ? "Unlike" : "Like"}
      onClick={() => update({ liked: !link.liked })}
    >
      <Heart size={17} fill={link.liked ? "currentColor" : "none"} />
    </Button>
  );
  const tags = link.tags.length > 0 && (
    <div className="tags">
      {link.tags.slice(0, 4).map((tag) => (
        <button key={tag} className="tag" onClick={() => filterTag(tag)}>
          {tag}
        </button>
      ))}
      {link.tags.length > 4 && (
        <span className="tag">+{link.tags.length - 4}</span>
      )}
    </div>
  );
  const progress = processing ? (
    <span className="flex items-center gap-1.5 text-xs text-primary">
      <LoaderCircle size={13} className="shrink-0 animate-spin" />
      {link.state === "queued"
        ? link.error
          ? "Retry scheduled"
          : "In queue"
        : link.state === "extracting"
          ? "Reading page"
          : "Summarizing"}
    </span>
  ) : link.state === "error" ? (
    <button
      onClick={open}
      className="flex items-center gap-1.5 text-xs text-danger"
    >
      <AlertCircle size={13} className="shrink-0" />
      {showError ? "Review & retry" : "Needs attention"}
    </button>
  ) : (
    <span className="text-xs text-muted-foreground">
      {link.method?.endsWith("-metadata")
        ? "Description only"
        : `${Math.max(1, Math.ceil(link.wordCount / 220))} min read`}
    </span>
  );
  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {compact && likeButton}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Manage lists"
        title="Manage Lists"
        onClick={manageLists}
      >
        <Folder size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={`h-7 gap-1.5 px-2 text-xs ${link.read ? "text-success" : "text-muted-foreground"}`}
        aria-label={link.read ? "Mark unread" : "Mark read"}
        title={link.read ? "Mark unread" : "Mark read"}
        onClick={() => update({ read: !link.read })}
      >
        {link.read ? <Check size={13} /> : <Circle size={12} />}
        <span>{link.read ? "Read" : "Unread"}</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label={link.archived ? "Unarchive link" : "Archive link"}
        title={link.archived ? "Unarchive" : "Archive"}
        onClick={() => update({ archived: !link.archived })}
      >
        {link.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-danger"
        aria-label={link.deleted ? "Restore link" : "Move link to trash"}
        title={link.deleted ? "Restore from Trash" : "Move to Trash"}
        onClick={() => update({ deleted: !link.deleted })}
      >
        {link.deleted ? <RotateCcw size={14} /> : <Trash2 size={14} />}
      </Button>
    </div>
  );
  const titleId = `link-title-${link.id}`;
  const title = link.title;
  const errorDetails = showError && link.state === "error" && (
    <p className="link-error">
      {link.error ||
        "Processing could not finish. Open this link to retry or paste article text."}
    </p>
  );
  if (compact)
    return (
      <article className="link-row" aria-labelledby={titleId}>
        <SiteIcon key={link.id} id={link.id} />
        <div className="link-row-content">
          <button
            id={titleId}
            className="link-row-title hover:text-primary"
            onClick={open}
          >
            {title}
          </button>
          <p className="link-row-url" title={link.url}>
            {link.url}
          </p>
          {(link.summary || link.description) && (
            <p className="link-row-summary">
              {link.summary || link.description}
            </p>
          )}
          {errorDetails}
          {tags}
        </div>
        <div className="link-row-footer">
          {progress}
          {actions}
        </div>
      </article>
    );
  return (
    <article className="link-card" aria-labelledby={titleId}>
      <div className="card-source">
        <SiteIcon key={link.id} id={link.id} />
        <span className="truncate">{domain}</span>
      </div>
      {likeButton}
      <button
        id={titleId}
        className="card-title hover:text-primary"
        onClick={open}
      >
        {title}
      </button>
      {(link.summary || link.description || !errorDetails) && (
        <p className="card-summary">
          {link.summary ||
            link.description ||
            (processing
              ? "Your link is saved. A summary and tags are on their way."
              : "Open this link to retry extraction or paste the article text.")}
        </p>
      )}
      {errorDetails}
      {tags || <div className="tags" />}
      <div className="card-footer">
        {progress}
        {actions}
      </div>
    </article>
  );
}
