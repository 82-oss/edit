// Edit V2's niches on Home: a new one made from New project (a teacher's), and
// a niche's page, what its agent knows and where each piece comes from, which
// a teacher changes there (Sphe, Nov 13: "make it easy for us to create a new
// niche without… code").

import { Archive, Copy, Ellipsis } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { useEditor } from "../lib/store";
import { STYLES, type Style } from "../lib/types";
import {
  archivable,
  copyable,
  GLOBAL_LESSON,
  groupKnowledge,
  likeOptions,
  loadNiches,
  nicheApi,
  useNiches,
  type Knowledge,
  type Niche,
  type NichePage,
} from "../lib/niches";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { ProblemView } from "./ProblemView";
import { Button, ConfirmDialog, cx, DialogActions, DialogTitle, IconButton, Modal, Select, spring } from "./ui";

const FIELD = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
const LABEL = "mb-1.5 block text-[12px] font-medium text-muted";
const PICKER = "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-black px-3 text-[13px] hover:border-line-strong";

const styleLabel = (kind: Style) => STYLES.find((one) => one.value === kind)?.label ?? kind;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A new niche: its name, a line on what it is, the niche it's like (its teaching comes through) and, like none, its kind. */
export function NewNiche({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (niche: Niche) => void }) {
  const niches = useNiches((state) => state.niches) ?? [];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [like, setLike] = useState("");
  const [kind, setKind] = useState<Style>("bodycam");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setLike("");
    setKind("bodycam");
    setError(null);
  }, [open]);

  const liked = niches.find((one) => one.key === like);
  const make = async () => {
    if (name.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { niche } = await nicheApi.save({ name: name.trim(), description: description.trim(), like, kind: liked?.kind ?? kind });
      await loadNiches();
      onMade(niche);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <DialogTitle title="New niche" />
        <label>
          <span className={LABEL}>Name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Interrogation HQ" className={FIELD} />
        </label>
        <label>
          <span className={LABEL}>What it is</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What kind of videos it makes, in a line" className={FIELD} />
        </label>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <span className={LABEL} title="Its agent knows what that niche's knows, and learns its own on top">
              Like
            </span>
            <Select value={like} onChange={setLike} className={PICKER} menuWidth={200} options={[{ value: "", label: "Nothing" }, ...niches.map((one) => ({ value: one.key, label: one.name }))]} />
          </div>
          <AnimatePresence initial={false}>
            {liked === undefined && (
              <motion.div className="min-w-0 flex-1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring}>
                <span className={LABEL}>Kind</span>
                <Select value={kind} onChange={setKind} className={PICKER} menuWidth={200} options={STYLES.map((one) => ({ value: one.value, label: one.label }))} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <DialogActions className="mt-1">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={name.trim() === ""}>
            Make it
          </Button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** Text a teacher changes where it stands (a niche's name, its line): saved on Enter or leaving it, put back on Escape. */
function InPlace({ value, onSave, editable, placeholder, className }: { value: string; onSave: (text: string) => void; editable: boolean; placeholder: string; className: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const shape = "-mx-1.5 block w-[calc(100%+12px)] rounded-md border border-transparent px-1.5";
  if (!editable) return <div className={cx(className, shape)}>{value || <span className="text-faint">{placeholder}</span>}</div>;
  const done = () => {
    const given = text.trim();
    if (given === value.trim()) return;
    onSave(given);
  };
  return (
    // A line that wraps to show all of itself; Enter ends it.
    <textarea
      rows={1}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value.replace(/\n/g, " "))}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
      className={cx(className, shape, "resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-faint hover:border-line focus:border-line-strong")}
    />
  );
}

/**
 * A niche's page: its name and line, the niche it's like, then what its agent
 * knows (lessons, effects, sounds, fonts), each with where it comes from. A
 * teacher renames it, changes what it's like or cuts it loose, reads and
 * changes a lesson, copies a piece to another niche or puts it away; anyone
 * else reads it.
 */
export function NichePageDialog({ open, nicheKey, onClose }: { open: boolean; nicheKey: string; onClose: () => void }) {
  const [page, setPage] = useState<NichePage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cutting, setCutting] = useState<"ask" | "busy" | null>(null);
  /** The lesson open under its row. */
  const [reading, setReading] = useState<string | null>(null);
  const toast = useEditor((state) => state.toast);

  const reload = async () => {
    try {
      const fresh = await nicheApi.page(nicheKey);
      setPage(fresh);
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  };
  useEffect(() => {
    if (!open) return;
    setPage(null);
    setError(null);
    setReading(null);
    setCutting(null);
    void reload();
  }, [open, nicheKey]);

  const failed = (cause: unknown, doing: string) => useEditor.getState().toastError(cause, doing);

  /** The niche changed: its name, line or what it's like (the rest sent as it is, so nothing else moves). */
  const change = async (to: Partial<Pick<Niche, "name" | "description" | "like">>) => {
    if (!page) return;
    const niche = { ...page.niche, ...to };
    if (niche.name.trim() === "") return;
    setPage({ ...page, niche });
    try {
      await nicheApi.save({ key: niche.key, name: niche.name, description: niche.description, like: niche.like ?? "", kind: niche.kind });
      void loadNiches();
      if ("like" in to) await reload();
    } catch (cause) {
      failed(cause, "change the niche");
      await reload();
    }
  };

  const cutLoose = async () => {
    setCutting("busy");
    try {
      await nicheApi.cutLoose(nicheKey);
      setCutting(null);
      void loadNiches();
      await reload();
    } catch (cause) {
      setCutting(null);
      failed(cause, "cut it loose");
    }
  };

  const putAway = async (item: Knowledge) => {
    try {
      await nicheApi.archive(item.key, true);
      setPage((now) => (now ? { ...now, items: now.items.filter((one) => one.key !== item.key) } : now));
      if (reading === item.key) setReading(null);
      toast(`“${item.name}” put away`, "info", {
        label: "Undo",
        run: () =>
          void nicheApi
            .archive(item.key, false)
            .then(reload)
            .catch((cause) => failed(cause, `put “${item.name}” back`)),
      });
    } catch (cause) {
      failed(cause, `put “${item.name}” away`);
    }
  };

  const copyTo = async (item: Knowledge, to: Niche) => {
    try {
      await nicheApi.copy(item.key, to.key);
      toast(`“${item.name}” copied to ${to.name}`, "info");
    } catch (cause) {
      failed(cause, `copy “${item.name}” to ${to.name}`);
    }
  };

  const teacher = page?.teacher === true;
  const niche = page?.niche;
  const liked = niche?.like ? page?.niches.find((one) => one.key === niche.like) : undefined;
  const others = page && niche ? page.niches.filter((one) => one.key !== niche.key) : [];

  const menu = (item: Knowledge): MenuItem[] => [
    ...(copyable(item) && others.length > 0
      ? [{ label: "Copy to", icon: <Copy size={14} />, submenu: others.map((one) => ({ label: one.name, onSelect: () => void copyTo(item, one) })) }]
      : []),
    ...(archivable(item) ? [{ label: "Put away", icon: <Archive size={14} />, ...(item.own ? {} : { hint: "everywhere" }), onSelect: () => void putAway(item) }] : []),
  ];

  return (
    <>
      <Modal open={open} onClose={onClose} width={640}>
        <div className="flex max-h-[min(760px,86vh)] flex-col">
          <div className="px-6 pt-6 pb-4">
            {niche ? (
              <>
                <InPlace value={niche.name} editable={teacher} placeholder="Name" onSave={(name) => name !== "" && void change({ name })} className="text-[18px] leading-8 font-semibold tracking-[-0.3px]" />
                <InPlace
                  value={niche.description}
                  editable={teacher}
                  placeholder="What kind of videos it makes, in a line"
                  onSave={(description) => void change({ description })}
                  className="mt-0.5 py-0.5 text-[13px] leading-relaxed text-muted"
                />
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-faint">
                  <span>{styleLabel(niche.kind)}</span>
                  {(teacher || liked) && <span aria-hidden>·</span>}
                  {teacher ? (
                    <>
                      <span>Like</span>
                      <Select
                        value={niche.like ?? ""}
                        onChange={(like) => void change({ like: like === "" ? null : like })}
                        className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-secondary hover:bg-hover hover:text-fg"
                        menuWidth={200}
                        options={[...(niche.like === null ? [{ value: "", label: "Nothing" }] : []), ...likeOptions(niche.key, page.niches).map((one) => ({ value: one.key, label: one.name }))]}
                      />
                      {liked && (
                        <button type="button" onClick={() => setCutting("ask")} className="rounded-md px-1.5 py-0.5 text-faint transition-colors hover:bg-hover hover:text-fg">
                          Cut loose
                        </button>
                      )}
                    </>
                  ) : (
                    liked && <span>Like {liked.name}</span>
                  )}
                </div>
              </>
            ) : error ? (
              <ProblemView error={error} doing="open the niche" onRetry={() => void reload()} />
            ) : (
              <div className="h-[86px]">
                <div className="shimmer h-8 w-48 rounded-md bg-raised" />
              </div>
            )}
          </div>

          {page && (
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-6 pt-2 pb-6">
              {groupKnowledge(page.items).map((section) => (
                <section key={section.kind} className="mt-4">
                  <h3 className="mb-1 flex items-baseline gap-2 text-[13px] font-semibold text-fg">
                    {section.title}
                    <span className="text-[12px] font-normal text-faint tabular">{section.count}</span>
                  </h3>
                  {section.groups.map((group) => (
                    <div key={group.origin} className="mt-2">
                      <div className="mb-0.5 text-[11px] text-faint">{sentence(group.origin)}</div>
                      {group.items.map((item) => (
                        <Row
                          key={item.key}
                          item={item}
                          open={reading === item.key}
                          onToggle={item.kind === "skill" ? () => setReading(reading === item.key ? null : item.key) : undefined}
                          menu={teacher ? menu(item) : []}
                        >
                          {reading === item.key && <Lesson item={item} editable={teacher && item.key !== GLOBAL_LESSON} onDone={() => setReading(null)} />}
                        </Row>
                      ))}
                    </div>
                  ))}
                </section>
              ))}
              {page.items.length === 0 && <p className="mt-4 text-[13px] text-muted">Its agent hasn’t been taught anything yet.</p>}
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={cutting !== null}
        onClose={() => setCutting(null)}
        onConfirm={() => void cutLoose()}
        busy={cutting === "busy"}
        tone="primary"
        title={`Cut ${niche?.name ?? "it"} loose?`}
        detail={`What comes through from ${liked?.name ?? "the niche it’s like"} is kept as its own, and changes there stop reaching it.`}
        confirm="Cut loose"
      />
    </>
  );
}

/** One thing its agent knows: its name and note; a lesson opens under it. */
function Row({ item, open, onToggle, menu, children }: { item: Knowledge; open: boolean; onToggle?: () => void; menu: MenuItem[]; children?: ReactNode }) {
  const detail = item.note ?? item.category;
  return (
    <div className={cx("-mx-2 rounded-lg transition-colors", open ? "bg-raised" : "hover:bg-hover")}>
      <div className="group flex min-h-9 items-center gap-2 px-2">
        <button type="button" disabled={!onToggle} onClick={onToggle} className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-left disabled:cursor-default">
          <span className="shrink-0 text-[13px] text-fg">{item.name}</span>
          {detail && <span className="truncate text-[12px] text-faint">{detail}</span>}
        </button>
        {menu.length > 0 && (
          <IconButton label="More" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={(event) => toggleMenu(event.currentTarget, menu, { width: 200 })}>
            <Ellipsis size={15} />
          </IconButton>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A lesson's text as its agents read it; a teacher changes it and saves its next version. */
function Lesson({ item, editable, onDone }: { item: Knowledge; editable: boolean; onDone: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const toast = useEditor((state) => state.toast);

  useEffect(() => {
    let alive = true;
    nicheApi
      .lesson(item.key)
      .then((found) => {
        if (!alive) return;
        setText(found.text ?? "");
        setDraft(found.text ?? "");
      })
      .catch((cause) => alive && setError(cause));
    return () => {
      alive = false;
    };
  }, [item.key]);

  const save = async () => {
    if (draft.trim() === "" || busy) return;
    setBusy(true);
    try {
      await nicheApi.saveLesson(item.key, draft);
      setText(draft.trim());
      toast(`“${item.name}” saved`, "info");
      onDone();
    } catch (cause) {
      useEditor.getState().toastError(cause, `save “${item.name}”`);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ProblemView error={error} doing="read the lesson" className="px-2 pb-3" />;
  if (text === null) return <div className="shimmer mx-2 mb-3 h-24 rounded-md bg-active" />;
  const changed = draft.trim() !== text.trim();
  return (
    <div className="px-2 pb-3">
      <textarea
        value={draft}
        readOnly={!editable}
        onChange={(event) => setDraft(event.target.value)}
        className="max-h-[52vh] min-h-32 w-full resize-none [field-sizing:content] rounded-md border border-line bg-black px-3 py-2 font-mono text-[12px] leading-relaxed text-secondary outline-none focus:border-line-strong read-only:focus:border-line"
      />
      {editable && changed && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {!item.own && <span className="mr-auto text-[11px] text-faint">Changes it for every niche that has it</span>}
          <Button size="sm" variant="ghost" onClick={() => setDraft(text)}>
            Undo changes
          </Button>
          <Button size="sm" variant="light" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
