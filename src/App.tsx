import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  ArrowDownWideNarrow,
  BookOpen,
  Bookmark,
  Heart,
  Folder,
  Layers2,
  LayoutGrid,
  Library,
  List,
  ListOrdered,
  LoaderCircle,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AddLinks } from "@/components/AddLinks";
import { LinkCard } from "@/components/LinkCard";
import { Reader } from "@/components/Reader";
import { TagsPage } from "@/components/TagsPage";
import { ListsPage } from "@/components/ListsPage";
import { EmptyTrash } from "@/components/EmptyTrash";
import { ListMembershipEditor } from "@/components/ListMembershipEditor";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SettingsPage } from "@/components/SettingsPage";
import { QueuePage } from "@/components/QueuePage";
import { ThemeToggle } from "@/components/Appearance";
import { api } from "@/lib/api";
import { useLibraryFeed } from "@/lib/use-library-feed";
import { readViewState, saveViewState } from "@/lib/view-state";
import type {
  CardLink,
  LibraryLayout,
  Link,
  LinkList,
  Status,
  Suggestion,
  Tag,
} from "@/types";

const layoutKey = "braindump.libraryLayout";

const navigation = [
  {
    id: "all",
    name: "All Links",
    icon: Library,
    description: "Good reads. New ideas. All in one place.",
  },
  {
    id: "unread",
    name: "To Read",
    icon: BookOpen,
    description: "Your next good read is waiting here.",
  },
  {
    id: "liked",
    name: "Liked",
    icon: Heart,
    description: "The links you’ve given a little extra love.",
  },
  {
    id: "attention",
    name: "Needs Attention",
    icon: AlertCircle,
    description:
      "Processing stopped for these links. Review the error, retry, or paste article text. Includes archived links.",
  },
  {
    id: "archived",
    name: "Archive",
    icon: Archive,
    description: "Everything you’ve put away for another day.",
  },
  {
    id: "deleted",
    name: "Trash",
    icon: Trash2,
    description:
      "Restore deleted links or empty Trash to remove them permanently.",
  },
];
export default function App() {
  const [initialView] = useState(readViewState);
  const [view, setView] = useState<string>(initialView.view);
  const [layout, setLayout] = useState<LibraryLayout>(() => {
    try {
      return localStorage.getItem(layoutKey) === "list" ? "list" : "cards";
    } catch {
      return "cards";
    }
  });
  const [query, setQuery] = useState(initialView.query);
  const [search, setSearch] = useState(initialView.query);
  const [tag, setTag] = useState(initialView.tag);
  const [listId, setListId] = useState(initialView.listId);
  const [lists, setLists] = useState<LinkList[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [editingLists, setEditingLists] = useState<CardLink | null>(null);
  const [read, setRead] = useState<string>(initialView.read);
  const [liked, setLiked] = useState<string>(initialView.liked);
  const [archived, setArchived] = useState<string>(initialView.archived);
  const [deleted, setDeleted] = useState<string>(initialView.deleted);
  const [state, setState] = useState<string>(initialView.state);
  const [sort, setSort] = useState<string>(initialView.sort);
  const [status, setStatus] = useState<Status | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [statusError, setStatusError] = useState("");
  const [add, setAdd] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(initialView.advanced);
  const [queueView, setQueueView] = useState(initialView.queue);
  const [revision, setRevision] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const changed = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    saveViewState({
      view,
      query,
      tag,
      listId,
      read,
      liked,
      archived,
      deleted,
      state,
      sort,
      advanced,
      queue: queueView,
    });
  }, [
    view,
    query,
    tag,
    listId,
    read,
    liked,
    archived,
    deleted,
    state,
    sort,
    advanced,
    queueView,
  ]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [s, t, l] = await Promise.all([
          api<Status>("/status"),
          api<{ tags: Tag[]; suggestions: Suggestion[] }>("/tags"),
          api<{ lists: LinkList[] }>("/lists"),
        ]);
        if (!cancelled) {
          setStatus(s);
          setStatusError("");
          setTags(t.tags);
          setSuggestions(t.suggestions);
          setLists(l.lists);
          setListsLoaded(true);
          setListId((current) =>
            l.lists.some((list) => list.id === current) ? current : "",
          );
        }
      } catch (e) {
        if (!cancelled) setStatusError((e as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(refresh, 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [revision]);
  const inLibrary = !["tags", "lists", "settings", "queue"].includes(view);
  const params = new URLSearchParams({ view, sort });
  params.set(
    "archived",
    archived ||
      (view === "archived"
        ? "true"
        : ["deleted", "attention"].includes(view)
          ? "all"
          : "false"),
  );
  params.set("deleted", deleted || (view === "deleted" ? "true" : "false"));
  if (view === "unread" || read) params.set("read", read || "false");
  if (view === "liked" || liked) params.set("liked", liked || "true");
  if (search) params.set("q", search);
  if (tag) params.set("tag", tag);
  if (listId) params.set("list", listId);
  if (view === "attention") params.set("state", "error");
  else if (state) params.set("state", state);
  const libraryQuery = inLibrary ? params.toString() : null;
  const library = useLibraryFeed(libraryQuery, revision);
  const { loadMore } = library;
  const loading = library.loading;
  const error = statusError || library.error;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [focusAfterLoad, setFocusAfterLoad] = useState<{
    query: string | null;
    ids: Set<string>;
  } | null>(null);
  useEffect(() => {
    if (!focusAfterLoad || library.loadingMore) return;
    if (
      focusAfterLoad.query === libraryQuery &&
      (document.activeElement === document.body ||
        loadMoreRef.current?.contains(document.activeElement))
    ) {
      const next = library.links.find(
        (link) => !focusAfterLoad.ids.has(link.id),
      );
      if (next) document.getElementById(`link-title-${next.id}`)?.focus();
      else loadMoreRef.current?.querySelector("button")?.focus();
    }
    setFocusAfterLoad(null);
  }, [focusAfterLoad, library.loadingMore, library.links, libraryQuery]);
  useEffect(() => {
    if (inLibrary) window.scrollTo({ top: 0, behavior: "instant" });
  }, [libraryQuery, inLibrary]);
  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !inLibrary ||
      !target ||
      !library.hasMore ||
      loading ||
      library.loadingMore ||
      library.refreshing ||
      library.moreError ||
      library.error ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    inLibrary,
    library.hasMore,
    loading,
    library.loadingMore,
    library.refreshing,
    library.moreError,
    library.error,
    loadMore,
    library.links.length,
    layout,
  ]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target instanceof HTMLElement &&
          (e.target.closest('input,textarea,select,[role="dialog"]') ||
            e.target.isContentEditable))
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key.toLowerCase() === "n" && !selected) setAdd(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);
  function navigate(next: string) {
    window.scrollTo({ top: 0, behavior: "instant" });
    setView(next);
    setTag("");
    setListId("");
    setRead("");
    setLiked("");
    setArchived("");
    setDeleted("");
    setState("");
  }
  function changeLayout(next: LibraryLayout) {
    setLayout(next);
    try {
      localStorage.setItem(layoutKey, next);
    } catch {
      // Switching views still works when browser storage is unavailable.
    }
  }
  function filterTag(value: string) {
    navigate(view === "attention" ? "attention" : "all");
    setTag(value);
  }
  function openList(id: string) {
    navigate("all");
    setListId(id);
    setArchived("all");
    setQuery("");
    setSearch("");
  }
  async function update(id: string, patch: Partial<Link>) {
    try {
      await api(`/links/${id}`, "PATCH", patch);
      changed();
      if (patch.deleted !== undefined)
        toast.success(patch.deleted ? "Moved to Trash" : "Link restored", {
          action: {
            label: "Undo",
            onClick: () => {
              void api(`/links/${id}`, "PATCH", { deleted: !patch.deleted })
                .then(changed)
                .catch((e) => toast.error(e.message));
            },
          },
        });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const current = navigation.find((n) => n.id === view) || navigation[0];
  const activeJobs = status?.activeJobs || 0;
  const currentList = lists.find((list) => list.id === listId);
  const filterCount = [
    tag,
    listId,
    read,
    liked,
    archived,
    deleted,
    state,
  ].filter(Boolean).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button onClick={() => navigate("all")} className="brand">
          <span className="brand-icon">
            <Layers2 size={21} />
          </span>
          braindump<span className="text-[#8e8bef]">.</span>
        </button>
        <p className="nav-label">Your Library</p>
        <nav aria-label="Library views">
          {navigation.map((n) => (
            <button
              className={`nav-item ${view === n.id ? "active" : ""}`}
              aria-current={view === n.id ? "page" : undefined}
              key={n.id}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={18} strokeWidth={1.7} />
              {n.name}
              <span className="nav-count">{status?.counts[n.id] || 0}</span>
            </button>
          ))}
          <button
            className={`nav-item ${view === "queue" ? "active" : ""}`}
            aria-current={view === "queue" ? "page" : undefined}
            onClick={() => navigate("queue")}
          >
            <ListOrdered size={18} strokeWidth={1.7} />
            Queue<span className="nav-count">{status?.activeJobs || 0}</span>
          </button>
        </nav>
        <div className="organize-nav">
          <p className="nav-label">Organize</p>
          <button
            className={`nav-item ${view === "lists" ? "active" : ""}`}
            aria-current={view === "lists" ? "page" : undefined}
            onClick={() => navigate("lists")}
          >
            <Folder size={18} strokeWidth={1.7} />
            Lists<span className="nav-count">{lists.length}</span>
          </button>
          <button
            className={`nav-item ${view === "tags" ? "active" : ""}`}
            onClick={() => navigate("tags")}
          >
            <Tags size={18} strokeWidth={1.7} />
            Tags<span className="nav-count">{tags.length}</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} strokeWidth={1.7} />
            Settings & Backups
          </button>
          <div className="mx-3 mb-1 mt-6">
            <p className="subtle flex items-center gap-2 !text-xs !text-[#808ba8]">
              <span
                className={`size-1.5 rounded-full ${status?.online ? "bg-[#80b4a4]" : "bg-amber-400"}`}
              />
              {status?.online ? "Ollama connected" : "Ollama offline"}
            </p>
            <p className="subtle mt-2 !text-xs !text-[#626e8d]">
              A little space for your mind.
            </p>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="search-box">
            <Search size={19} />
            <input
              ref={searchRef}
              aria-label="Search saved links"
              placeholder="Search your links, ideas, anything…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!inLibrary) navigate("all");
              }}
            />
            {query ? (
              <button
                className="absolute right-3 top-3.5 text-muted-foreground"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X size={16} />
              </button>
            ) : (
              <kbd className="absolute right-3 top-3 hidden rounded border px-1.5 text-xs leading-5 text-muted-foreground sm:block">
                /
              </kbd>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <Button
              className="h-10 rounded-lg px-4 shadow-sm"
              onClick={() => setAdd(true)}
            >
              <Plus size={17} />
              <span>Add Links</span>
            </Button>
          </div>
        </header>
        <div className="workspace">
          {error && (
            <div
              role="alert"
              className="mb-5 flex items-center justify-between rounded-lg bg-danger-soft p-4 text-sm text-danger"
            >
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={changed}>
                Retry
              </Button>
            </div>
          )}
          {view === "lists" ? (
            <ListsPage
              lists={lists}
              loaded={listsLoaded}
              changed={changed}
              openList={openList}
            />
          ) : view === "tags" ? (
            <TagsPage
              tags={tags}
              suggestions={suggestions}
              changed={changed}
              filter={filterTag}
              status={status}
            />
          ) : view === "settings" ? (
            <SettingsPage
              status={status}
              changed={changed}
              openQueue={() => navigate("queue")}
            />
          ) : view === "queue" ? (
            <QueuePage
              status={status}
              changed={changed}
              openLink={setSelected}
              view={queueView}
              setView={setQueueView}
            />
          ) : (
            <>
              <div
                className={`page-heading${view === "deleted" ? " trash-heading" : ""}`}
              >
                <div className="min-w-0">
                  <h1 className="break-words">{current.name}</h1>
                  <p className="subtle">
                    {search
                      ? `Results for “${search}”${view === "attention" ? " in links needing attention" : ""}`
                      : current.description}
                    {currentList && (
                      <span className="block break-words">
                        List: {currentList.name}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="hidden rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground sm:block">
                    {library.total} {library.total === 1 ? "link" : "links"}
                  </div>
                  {view === "deleted" && (
                    <EmptyTrash
                      count={status?.counts.deleted}
                      changed={() => {
                        setSelected(null);
                        setEditingLists(null);
                        changed();
                      }}
                    />
                  )}
                </div>
              </div>
              {!status?.online && status && (
                <div className="notice mb-5">
                  Your links are safe. Start Ollama to generate summaries and
                  tags.{" "}
                  <button
                    className="ml-1 underline underline-offset-2"
                    onClick={() => navigate("settings")}
                  >
                    View setup
                  </button>
                </div>
              )}
              <div className="filters">
                <Button
                  variant="outline"
                  className="h-9 bg-card text-content"
                  onClick={() => setAdvanced(!advanced)}
                  aria-expanded={advanced}
                >
                  <SlidersHorizontal size={14} />
                  Filters
                  {filterCount > 0 && (
                    <span className="rounded bg-accent px-1.5 text-xs text-primary">
                      {filterCount}
                    </span>
                  )}
                </Button>
                <select
                  className="filter-select"
                  aria-label="Filter by tag"
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value);
                  }}
                >
                  <option value="">All tags</option>
                  {tags.map((t) => (
                    <option key={t.name}>{t.name}</option>
                  ))}
                </select>
                {tag && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTag("")}
                    aria-label="Clear tag filter"
                  >
                    <X size={14} />
                  </Button>
                )}
                <select
                  className="filter-select max-w-full sm:max-w-48"
                  aria-label="Filter by list"
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                >
                  <option value="">All lists</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
                <div className="ml-auto flex items-center gap-2">
                  <ArrowDownWideNarrow
                    size={15}
                    className="hidden text-muted-foreground sm:block"
                  />
                  <select
                    className="filter-select !border-0 !bg-transparent !pr-4"
                    aria-label="Sort links"
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                    }}
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="title">Title A–Z</option>
                  </select>
                </div>
                <fieldset
                  aria-label="Link display"
                  className="flex shrink-0 gap-1 rounded-lg border bg-card p-1"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className={
                      layout === "cards"
                        ? "h-7 bg-accent text-primary"
                        : "h-7 text-muted-foreground"
                    }
                    aria-label="Card view"
                    aria-pressed={layout === "cards"}
                    onClick={() => changeLayout("cards")}
                  >
                    <LayoutGrid /> Cards
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={
                      layout === "list"
                        ? "h-7 bg-accent text-primary"
                        : "h-7 text-muted-foreground"
                    }
                    aria-label="List view"
                    aria-pressed={layout === "list"}
                    onClick={() => changeLayout("list")}
                  >
                    <List /> List
                  </Button>
                </fieldset>
              </div>
              {advanced && (
                <div className="mb-6 flex flex-wrap gap-3 rounded-xl border bg-card p-4">
                  {[
                    {
                      label: "Read Status",
                      value: read,
                      setter: setRead,
                      options: [
                        ["", "View default"],
                        ["all", "Read & unread"],
                        ["false", "Unread"],
                        ["true", "Read"],
                      ],
                    },
                    {
                      label: "Like Status",
                      value: liked,
                      setter: setLiked,
                      options: [
                        ["", "View default"],
                        ["all", "Liked & unliked"],
                        ["true", "Liked"],
                        ["false", "Not liked"],
                      ],
                    },
                    {
                      label: "Archive Status",
                      value: archived,
                      setter: setArchived,
                      options: [
                        ["", "View default"],
                        ["all", "Include archived"],
                        ["false", "Not archived"],
                        ["true", "Archived"],
                      ],
                    },
                    {
                      label: "Delete Status",
                      value: deleted,
                      setter: setDeleted,
                      options: [
                        ["", "View default"],
                        ["all", "Include Trash"],
                        ["false", "Not deleted"],
                        ["true", "In Trash"],
                      ],
                    },
                    {
                      label: "Processing",
                      value: state,
                      setter: setState,
                      options: [
                        ["", "Any state"],
                        ["ready", "Ready"],
                        ["queued", "Queued"],
                        ["extracting", "Extracting"],
                        ["summarizing", "Summarizing"],
                        ["error", "Failed"],
                      ],
                    },
                  ]
                    .filter(
                      (f) => view !== "attention" || f.label !== "Processing",
                    )
                    .map((f) => (
                      <label
                        key={f.label}
                        className="text-xs text-muted-foreground"
                      >
                        {f.label}
                        <select
                          className="filter-select mt-2 block"
                          value={f.value}
                          onChange={(e) => {
                            f.setter(e.target.value);
                          }}
                        >
                          {f.options.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-end"
                    onClick={() => {
                      setRead("");
                      setLiked("");
                      setArchived("");
                      setDeleted("");
                      setState("");
                      setTag("");
                      setListId("");
                    }}
                  >
                    Reset
                  </Button>
                </div>
              )}
              {loading && !library.links.length ? (
                <div className="empty-state">
                  <LoaderCircle className="animate-spin text-primary" />
                  <p className="mt-5">Opening your library…</p>
                </div>
              ) : library.links.length ? (
                <div
                  className={
                    layout === "list" ? "library-list" : "library-grid"
                  }
                  aria-label="Saved links"
                  aria-busy={loading || library.loadingMore}
                >
                  {library.links.map((link) => (
                    <LinkCard
                      key={link.id}
                      link={link}
                      layout={layout}
                      showError={view === "attention"}
                      open={() => setSelected(link.id)}
                      update={(p) => void update(link.id, p)}
                      filterTag={filterTag}
                      manageLists={() => setEditingLists(link)}
                    />
                  ))}
                </div>
              ) : library.error ? (
                <div className="empty-state">
                  <AlertCircle className="text-danger" />
                  <h2>Couldn’t Load Your Links.</h2>
                  <p>Use Retry above to reconnect to your library.</p>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    {search || filterCount ? (
                      <Search size={30} strokeWidth={1.5} />
                    ) : view === "all" ? (
                      <Bookmark size={30} strokeWidth={1.5} />
                    ) : (
                      <current.icon size={30} strokeWidth={1.5} />
                    )}
                  </div>
                  <h2>
                    {search || filterCount
                      ? "Nothing Here Just Yet."
                      : view === "all"
                        ? "Save Something That Sparks a Thought."
                        : view === "attention"
                          ? "No Links Need Attention."
                          : view === "deleted"
                            ? "Trash Is Empty."
                            : `No ${view === "unread" ? "Unread" : view === "liked" ? "Liked" : "Archived"} Links.`}
                  </h2>
                  <p>
                    {search || filterCount
                      ? "Try another search, or loosen your filters to find what you’re looking for."
                      : view === "all"
                        ? "An article, a useful guide, an idea for later. Drop in a link and make a little room in your browser."
                        : view === "attention"
                          ? "No links have stopped with an error. You can follow pending work in Queue."
                          : view === "deleted"
                            ? "Links you move to Trash will appear here."
                            : "Keep collecting. This part of your library will fill itself along the way."}
                  </p>
                  {search || filterCount ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        navigate(
                          ["attention", "deleted"].includes(view)
                            ? view
                            : "all",
                        );
                        setQuery("");
                      }}
                    >
                      Clear search & filters
                    </Button>
                  ) : view === "attention" ? (
                    <Button variant="outline" onClick={() => navigate("queue")}>
                      <ListOrdered />
                      View queue
                    </Button>
                  ) : view === "deleted" ? (
                    <Button variant="outline" onClick={() => navigate("all")}>
                      Browse your links
                    </Button>
                  ) : (
                    <Button onClick={() => setAdd(true)}>
                      <Plus />
                      Save your {view === "all" ? "first" : "next"} link
                    </Button>
                  )}
                </div>
              )}
              <div ref={loadMoreRef} className="library-load-more">
                <output
                  aria-live="polite"
                  className="text-xs text-muted-foreground"
                >
                  {library.loadingMore
                    ? "Loading more links…"
                    : library.links.length
                      ? `${library.links.length} of ${library.total} links${library.hasMore ? "" : " · All links loaded."}`
                      : ""}
                </output>
                {library.moreError && (
                  <p role="alert" className="text-sm text-danger">
                    Couldn’t load more links. {library.moreError}
                  </p>
                )}
                {(library.hasMore || library.moreError) && (
                  <Button
                    variant="outline"
                    disabled={
                      loading || library.loadingMore || library.refreshing
                    }
                    onClick={() => {
                      setFocusAfterLoad({
                        query: libraryQuery,
                        ids: new Set(library.links.map((link) => link.id)),
                      });
                      void loadMore();
                    }}
                  >
                    {library.loadingMore && (
                      <LoaderCircle className="animate-spin" />
                    )}
                    {library.moreError
                      ? "Retry loading more"
                      : "Load more links"}
                  </Button>
                )}
              </div>
              <div className="mt-7 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Sparkles size={13} />
                {activeJobs
                  ? `${activeJobs} background ${activeJobs === 1 ? "job" : "jobs"} in progress`
                  : "Collected by you. Organized on your Mac."}
              </div>
            </>
          )}
        </div>
      </main>
      <AddLinks
        open={add}
        onOpenChange={setAdd}
        done={changed}
        lists={lists}
        defaultListId={listId}
      />
      <Reader id={selected} close={() => setSelected(null)} changed={changed} />
      <Dialog
        open={!!editingLists}
        onOpenChange={(open) => {
          if (!open) setEditingLists(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage Lists</DialogTitle>
            <DialogDescription className="break-words">
              {editingLists?.title}
            </DialogDescription>
          </DialogHeader>
          {editingLists && (
            <ListMembershipEditor
              key={editingLists.id}
              linkId={editingLists.id}
              changed={changed}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
