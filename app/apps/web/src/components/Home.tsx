import { Archive, Check, ChevronDown, ChevronRight, ListFilter, CloudDownload, CloudOff, Copy, ExternalLink, FileText, Film, FileVideo, Lock, MessageSquare, Pencil, PenLine, Plus, Replace, RotateCw, Search, Share2, SkipForward, Tag, Trash2, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { editStyles, makesVideos, useAccount, writesScripts } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { shareChip } from "../lib/export-face";
import { hasImportLinks, importPaste } from "../lib/import-input";
import { loadBeta, useBeta } from "../lib/beta";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { doneKey, useDone, type DoneKey } from "../lib/done";
import { loadSeen, markSeen, useSeen } from "../lib/seen";
import { editWork, ideaWork, newOrChanged, scriptWork, type Fresh } from "../lib/seen-status";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { NARRATION, STYLES, type Creator, type ProjectSummary, type Style } from "../lib/types";
import { CardTableRow, IdeaTableRow, ideaStage, NewIdea, NoIdeas, useIdeasHome } from "../ideas/home";
import { makesIdeas } from "../lib/ideas";
import { creeping, elapsed, STEPS, stepOf } from "../writer/import-steps";
import { prefetchScript } from "../writer/opened";
import { CAN, useGrants } from "../writer/can";
import { SHAPES, type Shape, shapeOf } from "../writer/several";
import type { Choice, Decision, Kind } from "../writer/types";
import { useKept } from "../lib/kept";
import { askExportFolder } from "./ExportFolder";
import { ProblemView } from "./ProblemView";
import { explain } from "@edit/types/problems";
import { ChannelAvatar } from "./Channels";
import { ChannelsActions, ChannelsTitle, ChannelsView, useChannelsNav, type ChannelWork } from "./ChannelsHome";
import { AREA, Aside, ChannelField, FIELD, Field, More, NewShell, useChannelNeeded } from "./NewWork";
import { loadChannels, useChannels } from "../lib/channels";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { BY, Category, CATEGORY, CHIP, COLUMNS, contextMenu, CreatorCell, DoneContext, DoneStatus, FreshMark, KindMark, LENGTH, LengthCell, layoutFor, NAME, NoteMark, PILL, ROW, RowButtons, StatusCell, TableShape, Updated, useDoneRow, useNote, withDone } from "./HomeTable";
import { ExportsView, useWatchExports } from "./ExportsView";
import { HomeSidebar, nameOf, OpenSidebar, placeOf, placeOfSection, PLACES, useSidebarOpen, type Place as Spot, type Section, type Where } from "./HomeSidebar";
import { ThumbnailGrid } from "../thumbnails/list";
import { NewThumbnail } from "../thumbnails/new";
import { Loader, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { ChooseRecordings } from "./ChooseRecordings";
import { StatusChips } from "./MemoryChip";
import { UpdateButton } from "./UpdateButton";
import { Button, ConfirmDialog, cx, Modal, ProgressRing, Pulse, spring, Switch } from "./ui";
import { aboutWords, sizeWords } from "./FootageReady";
import { isListed, promoteItem, TestBadge } from "./TestProjects";
import { THIS_MACHINE } from "../lib/platform";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };
/** A YouTube Short's frame: 9:16. */
const SHORTS_FORMAT = { width: 1080, height: 1920, fps: 30 };

/** How long a project someone started stays in their Needs you before it goes to review. */
const NEW_FOR_MS = 3 * 24 * 3600_000;

/** Done shows its most recent this many until asked for all. */
const DONE_SHOWN = 40;

/**
 * One thing on Home: an edit, a subtitled video, a script, a stopped import,
 * an idea or a board card, where it is (its section and stage, "done" when
 * approved), and its row.
 */
interface Item {
  id: string;
  /** Its name in Done (null: it can't be marked done). */
  key: DoneKey | null;
  section: Section;
  stage: string;
  at: number;
  title: string;
  /** Started by the signed-in person (a board card is everyone's). */
  mine: boolean;
  /** Started by the signed-in person in the last three days and not done: first in its Scripts or Edits, under New. */
  fresh?: boolean;
  /** Its kind of video (an idea's workspace), for the filter; none for a board card or a stopped import. */
  kind?: Style | null;
  /** The channel it's for (an edit's), for the filter; none: made without one. */
  channel?: string | null;
  row: () => ReactNode;
}

/**
 * Home (Oct 31 2026, a beta until Nov 3, when it became everyone's: Sphe,
 * "moving forward, we want to use the new home"): a sidebar of ideas, thumbnails,
 * scripts and edits by stage, Exports and Done, and one short list at a time
 * beside it, the study portal's look (the user, Oct 31: "We have ideas,
 * scripts, and edits ... complaints from the teams about having to scroll
 * through a long, tedious" list, "and we also need to be able to have ways to
 * put projects aside"; then, of this design, "i think this is way more
 * organised"). Your own work by default (Mine), the team's a click away
 * (Everyone); a search looks through everything.
 */
export function Home() {
  // What Home showed last, at once; the fresh answers take its place as they come.
  const [projects, setProjects] = useKept<ProjectSummary[] | null>("home.projects", null);
  const account = useAccount((state) => state.account);
  const [cloud, setCloud] = useKept<CloudList | null>("home.cloud", null);
  const [statuses, setStatuses] = useKept<Record<string, ProjectStatus>>("home.statuses", {});
  const [creating, setCreating] = useState(false);
  /** Which New it is: kept while the dialog closes, so it doesn't turn into the other on its way out. */
  const [work, setWork] = useState<"edit" | "script">("edit");
  const startNew = (kind: "edit" | "script") => {
    setWork(kind);
    setCreating(true);
  };
  // Channels are V2's (the beta): Home's Channels, and Add channel over it.
  const v2 = useBeta((beta) => beta.v2);
  useEffect(() => {
    void loadBeta().catch(() => {});
  }, []);
  // Script mode's scripts: one list with the edits (the user, Oct 30: "merge the two applications as much as possible").
  const [scripts, setScripts] = useKept<WriterScriptRow[]>("home.scripts", []);
  // Scripts being written from videos, as Script mode's imports say.
  const [writing, setWriting] = useKept<Writing[]>("home.writing", []);
  useEffect(() => {
    // One ask of each at a time: on a busy Mac an answer can take longer than the 4 s between looks.
    const out = { progress: false, scripts: false };
    const look = () => {
      if (out.progress) return;
      out.progress = true;
      void fetch("/api/writer/progress")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setWriting(Array.isArray(rows) ? (rows as Writing[]) : []), () => {})
        .finally(() => (out.progress = false));
    };
    // Script imports stopped on any Mac (a failed video, a cut connection): open issues, answered here.
    const stopped = () => {
      if (out.scripts) return;
      out.scripts = true;
      void fetch("/api/writer/scripts")
        .then((answer) => (answer.ok ? answer.json() : []))
        // Test scripts aren't listed unless brought forth (TestProjects.tsx).
        .then((rows: unknown) => setLocalScripts(Array.isArray(rows) ? (rows as ScriptIssueRow[]).filter(isListed) : []), () => {})
        .finally(() => (out.scripts = false));
    };
    look();
    stopped();
    const timer = setInterval(() => {
      if (document.hidden) return;
      look();
      stopped();
    }, 4_000);
    return () => clearInterval(timer);
  }, []);
  // Script mode's scripts as this Mac has them: what stopped (any Mac's), and who started each.
  const [localScripts, setLocalScripts] = useKept<ScriptIssueRow[]>("home.localScripts", []);
  // A script import opened over Home (from its row).
  const [watching, setWatching] = useState<string | null>(null);
  const issues = localScripts.filter((row) => (row.status === "needs_choice" || row.status === "error") && !row.dismissedAt);
  const [query, setQuery] = useState("");
  // Ideas (Oct 31): the team's repackaging, a section of Home's for those who work on them.
  const ideasAllowed = makesIdeas(account);
  const [ideasHome, refreshIdeas, ideasError] = useIdeasHome(ideasAllowed);
  const [ideaOpen, setIdeaOpen] = useState(false);
  // The places this person works in, and only those (Sphe, Nov 6: "almost a tunnel vision"): Ideas (and Thumbnails)
  // with the permission, Scripts when they write them, Edits when they make videos (or have edits they may open).
  const makes = makesVideos(account);
  const hasEdits = (projects?.length ?? 0) > 0 || (cloud?.projects?.length ?? 0) > 0;
  const edits = makes || hasEdits || (!ideasAllowed && !writesScripts(account) && scripts.length === 0);
  const places: Spot[] = [...(ideasAllowed ? (["ideas"] as const) : []), ...(writesScripts(account) || scripts.length > 0 ? (["scripts"] as const) : []), ...(edits ? (["edits"] as const) : [])];
  // One place at a time, remembered on this browser; /ideas is Home on its Ideas (the idea page's way back).
  // /thumbnails is Home on its Thumbnails (a thumbnail's way back), as /ideas is on its Ideas.
  const [where, setWhere] = useState<Where>(() => (window.location.pathname === "/ideas" ? "ideas" : window.location.pathname === "/thumbnails" ? "thumbnails" : window.location.pathname === "/channels" ? "channels" : savedWhere()));
  // This computer's exports: the sidebar's card and the Exports view.
  useWatchExports();
  const shownWhere: Where = (placeOf(where).place !== null && !places.includes(placeOf(where).place!)) || (where === "thumbnails" && !ideasAllowed) || (where === "channels" && !v2) ? (places[0] ?? "edits") : where;
  // Each section's New is its own kind (Sphe, Nov 14: no switching between them); elsewhere, an edit for someone who makes them.
  const newWork: "edit" | "script" | null = placeOf(shownWhere).place === "scripts" ? (writesScripts(account) ? "script" : null) : makes ? "edit" : writesScripts(account) ? "script" : null;
  const [thumbOpen, setThumbOpen] = useState(false);
  // Yours, or everyone's (remembered on this browser); nobody signed in has nothing of their own.
  const [mineOnly, setMineOnly] = useState(() => localStorage.getItem(MINE) !== "0");
  const mine = mineOnly && account?.person != null;
  // One kind of video only (Sphe, Nov 2: Mine/Everyone "turned into like a dropdown with filters like category"), remembered on this browser.
  const [kind, setKind] = useState<Style | null>(() => (STYLES.some((one) => one.value === localStorage.getItem(KIND)) ? (localStorage.getItem(KIND) as Style) : null));
  const done = useDone();
  // One channel only (Sphe, Nov 14: the kind filter as a channel filter), remembered on this browser; V2's.
  const channelList = useChannels((state) => state.channels);
  const [channelPick, setChannelPick] = useState<string | null>(() => localStorage.getItem(CHANNEL));
  const channelFilter = v2 && channelList?.some((one) => one.key === channelPick) ? channelPick : null;
  useEffect(() => {
    if (v2) void loadChannels();
  }, [v2]);
  const [allDone, setAllDone] = useState(false);
  // How far back (Sphe, Nov 14: "the default view be this week's content"): this week unless widened, kept while the
  // window is open (sessionStorage), so opening a project and coming back doesn't narrow it again.
  const [period, setPeriod] = useState<Period>(() => PERIODS.find((one) => one.value === sessionStorage.getItem(PERIOD))?.value ?? "week");
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();
  // An approved idea's "Write the script": New project opened with its title and links.
  const [start, setStart] = useState<NewProjectStart | null>(null);
  useEffect(() => {
    const given = sessionStorage.getItem("edit.newProject");
    if (given === null) return;
    sessionStorage.removeItem("edit.newProject");
    try {
      setStart(JSON.parse(given) as NewProjectStart);
      startNew("script");
    } catch {
      // Not ours.
    }
  }, []);

  // Imports, agents, shares and footage coming here are followed every few seconds (many projects at once).
  const busy = Object.values(statuses).some((one) => one.importing !== null || one.working || one.sharing !== null || Boolean(one.footage));
  useEffect(() => {
    if (!busy) return;
    // A poll that fails is noted by api.ts (in the log) and the next one asks again.
    const timer = setInterval(() => void api.projectStatus().then(setStatuses).catch(() => {}), 3_000);
    return () => clearInterval(timer);
  }, [busy]);

  const refresh = () => {
    // The cloud’s list is fetched beside this machine’s, never in its way.
    // Not reached this time: the last list stays (its error says so).
    void cloudApi
      .projects()
      .then(setCloud)
      .catch((error: unknown) => setCloud((last) => (last === null ? null : { ...last, error: (error as Error).message, offline: true })));
    if (writesScripts(useAccount.getState().account)) {
      void api
        .writerScripts()
        .then(({ scripts }) => setScripts(scripts.filter(isListed)))
        // Noted by api.ts; the last list stays until the next refresh.
        .catch(() => {});
    }
    // Feedback waiting, and finished edits not exported as they are now.
    void api
      .projectStatus()
      .then(setStatuses)
      // As above: noted by api.ts, the last statuses stay.
      .catch(() => {});
    // When this person last opened each (New and Changed); none while they can't be read.
    void loadSeen();
    return api
      .projects()
      .then(({ projects }) => setProjects(projects))
      .catch((error) => useEditor.getState().toastError(error, "reach Edit"));
  };

  useEffect(() => {
    // Home hears the server too: a client's review notes Edit had missed are said here as well.
    connectEvents();
    void refresh();
    // Who’s editing what changes while the list is up.
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remote = new Map((cloud?.projects ?? []).map((project) => [project.id, project]));
  const cloudOnly = (cloud?.projects ?? []).filter((project) => !project.local && !projects?.some((local) => local.id === project.id));
  const listedIds = new Set([...(projects ?? []).map((project) => project.id), ...cloudOnly.map((project) => project.id)]);
  // A script's edit: the one made from it here, else (made on another Mac, or from its Doc) the project of the same name.
  const named = new Map([...(projects ?? []).map((project) => [project.name, project.id] as const), ...cloudOnly.map((project) => [project.name, project.id] as const)].map(([name, id]) => [name.trim().toLowerCase(), id]));
  const editOf = (one: WriterScriptRow) => (one.project !== null && listedIds.has(one.project) ? one.project : (named.get(one.title.trim().toLowerCase()) ?? null));
  // Whether a script is a compilation: the cloud's list says, else this Mac's copy.
  const withKind = (one: WriterScriptRow): WriterScriptRow => {
    const here = localScripts.find((local) => local.id === one.id);
    // Its note: this Mac's copy's when it has one (a note just left here), else the list's.
    return { ...one, compilation: one.compilation ?? here?.compilation, runFailed: one.runFailed ?? here?.runFailed ?? null, note: here !== undefined ? here.note : one.note };
  };
  // An import running (or stopped) on this Mac isn't in the cloud's list until
  // it's in: listed from here meanwhile, so it shows in Importing at once (JJ,
  // Nov 2: "It's just confusing when you import and it doesn't get into the
  // importing while it's in progress").
  // Every one of this Mac's not in the cloud's list yet, whatever it's at: one imported and being written (or just
  // written) isn't sent up until it's done, and was listed nowhere for its last two hours (JJ, Nov 16: "I can't seem
  // to find them anywhere").
  const cloudIds = new Set(scripts.map((one) => one.id));
  const pending: WriterScriptRow[] = [
    ...localScripts.filter((one) => !cloudIds.has(one.id)),
    ...writing.filter((one) => !cloudIds.has(one.id) && !localScripts.some((local) => local.id === one.id)).map((one) => ({ id: one.id, title: one.title, createdAt: one.startedAt })),
  ].map((one): WriterScriptRow => ({
    id: one.id,
    title: one.title,
    rev: 0,
    updatedAt: ("updatedAt" in one ? one.updatedAt : undefined) ?? ("createdAt" in one ? one.createdAt : undefined) ?? Date.now(),
    updatedBy: null,
    createdBy: "createdBy" in one ? (one.createdBy ?? null) : null,
    project: null,
    handoff: null,
    clips: "clipCount" in one ? (one.clipCount ?? 0) : 0,
    durationMs: "durationMs" in one ? (one.durationMs ?? 0) : 0,
    // As the cloud's list says it (writer_handoff.ts): written once it has more than its one source clip.
    built: "clipCount" in one && (one.clipCount ?? 0) > 1,
    ...("builtAt" in one && typeof one.builtAt === "number" ? { builtAt: one.builtAt } : {}),
    style: null,
    ...("channel" in one && one.channel ? { channel: one.channel } : {}),
    ...("runFailed" in one && one.runFailed ? { runFailed: one.runFailed } : {}),
    ...("compilation" in one && one.compilation !== undefined ? { compilation: one.compilation } : {}),
    ...("note" in one && one.note ? { note: one.note } : {}),
  }));
  const listedScripts = [...scripts, ...pending];
  const scriptOf = new Map(listedScripts.flatMap((one) => {
    const edit = editOf(one);
    return edit !== null ? [[edit, withKind(one)] as const] : [];
  }));
  const scriptOnly = listedScripts.filter((one) => editOf(one) === null);
  // A script still importing (running, stopped or waiting on a choice) isn't
  // a script yet: it's in Importing, with how far it got (the user, Oct 30:
  // "until the first prompt is kicked off the project isn't a Script project
  // it's still in the importing phase").
  const importingNow = new Map<string, Importing>();
  // One the server follows live is said from that alone: the script's saved progress lags it (5 against 58), and
  // creeping both, each reset the other's creep every render, so the number sat still (JJ, Nov 10).
  const followed = new Set(writing.map((one) => one.id));
  for (const one of localScripts) {
    if (followed.has(one.id)) continue;
    if (one.status === "processing") importingNow.set(one.id, { word: `Importing ${Math.floor(creeping(one.id, one.progress ?? 0))}%`, stopped: false, percent: creeping(one.id, one.progress ?? 0) });
    else if (one.status === "error" || one.status === "needs_choice") importingNow.set(one.id, { word: one.status === "needs_choice" ? "Waiting on a choice" : "Stopped", stopped: true });
    // In, but its first prompt not started yet: still importing until the workflow is under way.
    else if (one.firstBuild) importingNow.set(one.id, { word: "Starting the workflow", stopped: false });
  }
  for (const one of writing) importingNow.set(one.id, { word: `Importing ${Math.floor(creeping(one.id, one.percent))}%`, stopped: false, percent: creeping(one.id, one.percent), step: one.detail || one.stage });

  const all = projects ?? [];
  // Newest change first, local and cloud-only projects and scripts together.
  const projectRows: Listed[] = [
    ...all.filter((project) => !project.subtitles).map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: scriptOf.get(project.id) ?? null })),
    ...cloudOnly.filter((project) => project.summary?.subtitles !== true).map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: scriptOf.get(project.id) ?? null })),
    ...scriptOnly.filter((one) => !issues.some((issue) => issue.id === one.id && !writing.some((going) => going.id === one.id))).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: withKind(one), importing: importingNow.get(one.id), writing: localScripts.some((local) => local.id === one.id && local.building === true), sharing: localScripts.some((local) => local.id === one.id && local.sharing !== undefined), here: localScripts.some((local) => local.id === one.id) })),
  ].sort((a, b) => b.at - a.at);
  const subtitledRows: Listed[] = [
    ...all.filter((project) => project.subtitles).map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: null })),
    ...cloudOnly.filter((project) => project.summary?.subtitles === true).map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: null })),
  ].sort((a, b) => b.at - a.at);
  // A project the signed-in person started in the last three days is first
  // in its list, under New (the user, Oct 30: "it's confusing to add a new
  // project and not have it right in front of you").
  const me = account?.person?.name.trim().toLowerCase() ?? null;
  const meSub = account?.person?.sub ?? "";
  const startedMs = (row: Listed): number => {
    const id = row.local?.id ?? row.cloud?.id ?? null;
    const at = id === null ? NaN : Number(/^p(\d{12,})-/u.exec(id)?.[1] ?? NaN);
    return Number.isFinite(at) ? at : (localScripts.find((one) => one.id === row.script?.id)?.createdAt ?? row.script?.updatedAt ?? 0);
  };
  const starter = (row: Listed) => (row.local !== null ? (remote.get(row.local.id)?.created_by ?? row.local.created_by) : row.cloud !== null ? row.cloud.created_by : row.script.createdBy);
  // Whose it is: the same sign-in, else (older records) the same name.
  const isMe = (by: { sub?: string; name: string } | null | undefined) => by != null && (meSub !== "" && by.sub ? by.sub === meSub : me !== null && by.name.trim().toLowerCase() === me);
  const justStarted = (row: Listed) => isMe(starter(row)) && Date.now() - startedMs(row) < NEW_FOR_MS;
  const fresh = (row: Listed) => justStarted(row) && stageOf(row, row.local === null && row.cloud === null ? undefined : statuses[row.local?.id ?? row.cloud?.id ?? ""]) !== "done";
  const cardProps = (project: ProjectSummary) => ({
    project,
    onChanged: refresh,
    cloudOn: Boolean(cloud?.on),
    status: cloud?.statuses?.[project.id],
    remote: remote.get(project.id),
    state: statuses[project.id],
  });

  // New and Changed (Sphe, Nov 18): from when this person last opened each (lib/seen.ts), none while the marks can't be read.
  const marks = useSeen();
  const freshOf = (key: string, work: Parameters<typeof newOrChanged>[0]): Fresh => newOrChanged(work, marks.seen[key] ?? null, marks.on);

  // Everything Home lists, each where it is.
  const items: Item[] = [];
  for (const row of [...projectRows, ...subtitledRows]) {
    const subtitled = row.local?.subtitles === true || row.cloud?.summary?.subtitles === true;
    const id = row.local?.id ?? row.cloud?.id ?? null;
    if (row.local === null && row.cloud === null) {
      const script = row.script;
      const status = freshOf(`script:${script.id}`, scriptWork({ mine: isMe(script.createdBy), built: script.built, builtAt: script.builtAt, updatedAt: script.updatedAt, busy: row.importing !== undefined || row.writing === true }));
      items.push({
        id: `script-${script.id}`,
        key: doneKey("script", script.id),
        section: "scripts",
        stage: stageOf(row, undefined),
        at: row.at,
        title: script.title,
        mine: isMe(script.createdBy),
        fresh: fresh(row),
        kind: script.style,
        channel: script.channel ?? null,
        row: () => <ScriptTableRow script={script} importing={row.importing} writing={row.writing === true} sharing={row.sharing === true} here={row.here === true} fresh={status} onChanged={refresh} onImport={row.importing ? () => setWatching(script.id) : undefined} />,
      });
      continue;
    }
    const stage = stageOf(row, statuses[id!]);
    // Test projects aren't listed unless brought forth (TestProjects.tsx); this machine's copy says, else the cloud's.
    if (!isListed(row.local ?? row.cloud?.summary)) continue;
    const status = freshOf(`edit:${id!}`, editWork({ id: id!, mine: isMe(starter(row)), modifiedMs: row.local?.modified_ms ?? null, cloud: row.cloud ?? remote.get(id!) ?? null, status: statuses[id!] }));
    items.push({
      id: id!,
      key: doneKey("edit", id!),
      section: "edits",
      stage: stage === "done" ? "done" : subtitled ? "subtitled" : stage === "review" ? "review" : "editing",
      at: row.at,
      title: row.local?.name ?? row.cloud?.name ?? "",
      mine: isMe(starter(row)),
      fresh: fresh(row),
      kind: row.local?.style ?? row.cloud?.summary?.style ?? row.script?.style ?? null,
      channel: row.local?.channel ?? row.cloud?.summary?.channel ?? null,
      row: () => (row.local !== null ? <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} fresh={status} /> : <CloudTableRow project={row.cloud!} script={row.script} fresh={status} onChanged={refresh} />),
    });
  }
  // Script imports that stopped: each waits on someone's answer, under Importing.
  for (const issue of issues.filter((one) => !writing.some((going) => going.id === one.id))) {
    items.push({ id: `issue-${issue.id}`, key: doneKey("script", issue.id), section: "scripts", stage: "importing", at: issue.createdAt ?? 0, title: issue.title, mine: isMe(issue.createdBy), row: () => <ScriptIssue issue={issue} onOpen={setWatching} /> });
  }
  if (ideasAllowed && ideasHome !== null) {
    for (const row of ideasHome.ideas) {
      const status = freshOf(`idea:${row.id}`, ideaWork({ mine: isMe(row.createdBy), run: row.summary.run, repackagedAt: row.summary.repackagedAt, updatedAt: row.updatedAt }));
      items.push({ id: `idea-${row.id}`, key: doneKey("idea", row.id), section: "ideas", stage: ideaStage(row), at: row.updatedAt, title: row.summary.title, mine: isMe(row.createdBy), kind: row.workspace ?? "interrogation", channel: row.summary.channel ?? null, row: () => <IdeaTableRow row={row} fresh={status} /> });
    }
    // A card waiting on changes with no idea yet is the ideas team's, on the board.
    for (const card of ideasHome.changes) {
      items.push({ id: `card-${card.id}`, key: doneKey("card", card.id), section: "ideas", stage: "board", at: Number.MAX_SAFE_INTEGER, title: card.name, mine: true, row: () => <CardTableRow card={card} onOpened={refreshIdeas} /> });
    }
  }

  // Marked done by hand: in Done, wherever it was.
  const markedDone = (item: Item) => item.key !== null && done.entries.has(item.key);
  const isIn = (item: Item, place: Where): boolean => {
    if (markedDone(item)) return place === "done";
    if (place === "done") return item.stage === "done";
    const { place: at, stage } = placeOf(place);
    return at !== null && placeOfSection(item.section) === at && (stage === null ? item.stage !== "done" : item.stage === stage);
  };
  // In the period: changed since its start.
  const since = periodStart(period);
  const recent = (item: Item) => item.at >= since;
  const ofChannel = (item: Item) => channelFilter === null || item.channel === channelFilter;
  const ours = items.filter((item) => (!mine || item.mine) && (kind === null || item.kind === kind) && ofChannel(item) && recent(item));
  const countOf = (place: Where) => ours.filter((item) => isIn(item, place)).length;
  // Channels' In progress: the team's work for a channel that isn't done (whoever's, whenever).
  const channelWork: ChannelWork[] = items.flatMap((item) => {
    if (!item.channel || item.stage === "done" || markedDone(item)) return [];
    const [kind, open] = item.section === "ideas" ? (["idea", () => navigate(`/ideas/${item.id.slice(5)}`)] as const) : item.section === "scripts" ? (["script", () => navigate(`/scripts/${item.id.slice(7)}`)] as const) : (["edit", () => navigate(`/p/${item.id}`)] as const);
    return [{ id: item.id, title: item.title, kind, channel: item.channel, open }];
  });
  // A search looks through everything, everyone's, wherever it is.
  const words = query.trim().toLowerCase();
  const searching = words !== "";
  const newest = (a: Item, b: Item) => b.at - a.at;
  let groups: { key: string; label: string | null; items: Item[] }[];
  if (searching) {
    const found = items.filter((item) => item.title.toLowerCase().includes(words)).sort(newest);
    const placeName = (item: Item) => (item.stage === "done" || markedDone(item) ? "done" : placeOfSection(item.section));
    groups = [...PLACES.map((place) => place.key), "done"].map((key) => ({ key, label: key === "done" ? "Done" : PLACES.find((one) => one.key === key)!.label, items: found.filter((item) => placeName(item) === key) })).filter((group) => group.items.length > 0);
  } else {
    const here = ours.filter((item) => isIn(item, shownWhere));
    const { place, stage } = placeOf(shownWhere);
    if (place !== null && stage === null) {
      // What you just started first, under New (the user, Oct 30: "it's confusing to add a new project and not have it right in front of you"), then by stage.
      const stages = PLACES.find((one) => one.key === place)!.stages;
      const isFresh = (item: Item) => item.fresh === true && item.mine;
      groups = [
        { key: "new", label: "New", items: here.filter(isFresh).sort(newest) },
        ...stages.map((one) => ({ key: one.key, label: one.label, items: here.filter((item) => !isFresh(item) && item.stage === one.key).sort(newest) })),
      ].filter((group) => group.items.length > 0);
    } else if (shownWhere === "done") {
      // The latest done first: marked by hand when it was marked, else when it last changed.
      const doneAt = (item: Item) => (item.key !== null ? (done.entries.get(item.key)?.at ?? item.at) : item.at);
      const sorted = here.sort((a, b) => doneAt(b) - doneAt(a));
      groups = [{ key: "done", label: null, items: allDone ? sorted : sorted.slice(0, DONE_SHOWN) }];
    } else {
      groups = [{ key: shownWhere, label: null, items: here.sort(newest) }];
    }
  }
  const listed = groups.reduce((total, group) => total + group.items.length, 0);
  const total = searching ? listed : countOf(shownWhere);
  const cross = searching || shownWhere === "done";
  const solo = mine && !searching;
  const title = searching ? { parent: null, name: "Search" } : nameOf(shownWhere);
  const inIdeas = !searching && placeOf(shownWhere).place === "ideas";
  const inThumbnails = !searching && shownWhere === "thumbnails";
  const inChannels = !searching && shownWhere === "channels";
  const inExports = !searching && shownWhere === "exports";
  // The open place's stages, steps over its list (empty ones greyed, so the order still reads).
  const shownPlace = searching ? null : placeOf(shownWhere).place;
  const steps = shownPlace === null ? [] : PLACES.find((one) => one.key === shownPlace)!.stages.map((one) => ({ ...one, count: countOf(`${shownPlace}:${one.key}`) }));
  const nothingAtAll = projects !== null && items.length === 0 && !ideasAllowed;
  const loading = projects === null;
  const choose = (place: Where) => {
    localStorage.setItem(VIEW, place);
    setWhere(place);
    setQuery("");
    setAllDone(false);
    if (placeOf(place).place === "ideas") navigate("/ideas", true);
    else if (place === "thumbnails") navigate("/thumbnails", true);
    else if (place === "channels") {
      useChannelsNav.setState({ open: null, dialog: null });
      navigate("/channels", true);
    }
    else if (window.location.pathname === "/ideas" || window.location.pathname === "/thumbnails" || window.location.pathname === "/channels") navigate("/", true);
  };
  const chooseMine = (value: boolean) => {
    localStorage.setItem(MINE, value ? "1" : "0");
    setMineOnly(value);
  };
  const choosePeriod = (value: Period) => {
    sessionStorage.setItem(PERIOD, value);
    setPeriod(value);
  };
  const chooseChannel = (value: string | null) => {
    if (value === null) localStorage.removeItem(CHANNEL);
    else localStorage.setItem(CHANNEL, value);
    setChannelPick(value);
  };
  const chooseKind = (value: Style | null) => {
    if (value === null) localStorage.removeItem(KIND);
    else localStorage.setItem(KIND, value);
    setKind(value);
  };
  // The kinds in the list on screen (in Mine, yours), with how many of each: the filter's menu.
  const kinds = STYLES.map((one) => ({ ...one, count: items.filter((item) => item.kind === one.value && (!mine || item.mine) && ofChannel(item) && recent(item) && isIn(item, shownWhere)).length })).filter((one) => one.count > 0 || one.value === kind);
  // The channels, with how many of each are in the list on screen.
  const channelCounts = v2 ? (channelList ?? []).map((one) => ({ value: one.key, label: one.title, count: items.filter((item) => item.channel === one.key && (!mine || item.mine) && (kind === null || item.kind === kind) && recent(item) && isIn(item, shownWhere)).length })) : [];
  // Nothing in this list: why, and where to look.
  const others = items.filter((item) => !item.mine && (kind === null || item.kind === kind) && recent(item) && isIn(item, shownWhere)).length;
  const otherKinds = kind === null ? 0 : items.filter((item) => item.kind !== kind && (!mine || item.mine) && recent(item) && isIn(item, shownWhere)).length;
  const older = period === "all" ? 0 : items.filter((item) => !recent(item) && (!mine || item.mine) && (kind === null || item.kind === kind) && isIn(item, shownWhere)).length;
  const periodName = PERIODS.find((one) => one.value === period)!.label.toLowerCase();
  const empty = searching
    ? { title: "Nothing matches", text: `Nothing anywhere is called “${query.trim()}”.` }
    : kind !== null && otherKinds > 0
          ? { title: `No ${STYLES.find((one) => one.value === kind)!.label.toLowerCase()} here`, text: `${otherKinds} of other kinds: the filter shows them all again.` }
          : mine && others > 0
          ? { title: "Nothing of yours here", text: `Everyone shows the team’s ${others}.` }
          : older > 0
          ? { title: `Nothing ${periodName}`, text: `${older} from before: the filter goes further back.` }
          : { title: "Nothing here", text: shownWhere === "done" ? "Approved edits and ideas move here by themselves, and anything marked done from its ⋯ menu." : "Nothing is at this stage now." };

  return (
    <DoneContext.Provider value={done}>
      <div className="flex h-full bg-black p-2">
        <HomeSidebar places={places} thumbnails={ideasAllowed} channels={v2} done={countOf("done")} where={searching ? ("" as Where) : shownWhere} onChoose={choose} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
          <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
            {!sidebarOpen && <OpenSidebar onOpen={() => setSidebarOpen(true)} />}
            {inChannels ? (
              <ChannelsTitle />
            ) : (
            <h1 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap">
              {title.parent !== null && (
                <>
                  <span className="font-medium text-muted">{title.parent}</span>
                  <span className="font-normal text-faint">/</span>
                </>
              )}
              <span className="truncate">{title.name}</span>
              {!loading && !inThumbnails && !inExports && <span className="ml-1 text-[13px] font-normal text-faint tabular">{total}</span>}
            </h1>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <StatusChips />
              <UpdateButton />
              {/* One main action a screen, in white (the user, Oct 30). */}
              {inIdeas ? (
                <Button variant="light" onClick={() => setIdeaOpen(true)}>
                  <Plus size={15} strokeWidth={2.2} /> New idea
                </Button>
              ) : inChannels ? (
                <ChannelsActions />
              ) : inExports ? null : inThumbnails ? (
                <Button variant="light" onClick={() => setThumbOpen(true)}>
                  <Plus size={15} strokeWidth={2.2} /> New thumbnail
                </Button>
              ) : newWork !== null ? (
                <Button variant="light" onClick={() => startNew(newWork)}>
                  <Plus size={15} strokeWidth={2.2} /> {newWork === "script" ? "New script" : "New edit"}
                </Button>
              ) : null}
            </div>
          </header>
          <div className={cx("flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-6")}>
            <SetupCard />
            {/* Thumbnails in the panel (Sphe, Nov 2: they "should sort of happen on that right hand side"), not a page of their own. */}
            {inChannels ? (
              <ChannelsView work={channelWork} />
            ) : inExports ? (
              // Opening it clears "Exported" on the rows: their statuses again at once.
              <ExportsView channelOf={(id) => (projects ?? []).find((one) => one.id === id)?.channel ?? remote.get(id)?.summary?.channel ?? null} onViewed={() => void api.projectStatus().then(setStatuses).catch(() => {})} />
            ) : inThumbnails ? (
              <div className="-mx-4 -mt-3">
                <ThumbnailGrid onMake={() => setThumbOpen(true)} />
              </div>
            ) : (
            <>
            <div className="mb-3 flex items-center gap-2">
              {/* Inset in black on the grey panel, as the chat's box is; an edge only in focus. */}
              <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-black px-2.5 text-muted focus-within:border-line-strong">
                <Search size={14} className="shrink-0" />
                <input
                  value={query}
                  placeholder="Search everything by name…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
                />
                {searching && (
                  <button onClick={() => setQuery("")} title="Clear" className="shrink-0 text-faint hover:text-fg">
                    <X size={13} />
                  </button>
                )}
              </label>
              <FilterButton
                who={account?.person != null ? (mineOnly ? "mine" : "everyone") : null}
                kind={kind}
                kinds={kinds}
                period={period}
                onPeriod={choosePeriod}
                channel={channelFilter}
                channels={channelCounts}
                onChannel={chooseChannel}
                disabled={searching}
                onWho={(value) => chooseMine(value === "mine")}
                onKind={chooseKind}
              />
            </div>
            {steps.length > 0 && (
              <StageSteps place={shownPlace!} steps={steps} stage={placeOf(shownWhere).stage} onChoose={choose} />
            )}
            {cloud?.on && cloud.error && (
              <p className="mb-2 px-3 text-[12px] text-warning">
                {cloud.offline ? `Can’t reach the cloud: showing what’s on ${THIS_MACHINE}.` : "The cloud’s list didn’t load."}
              </p>
            )}
            {inIdeas && ideasHome === null && ideasError !== null && <ProblemView error={ideasError} doing="load the ideas" onReload={refreshIdeas} className="mb-2 px-3" />}
            {inIdeas && ideasHome !== null && ideasHome.boardError && <p className="mb-2 px-3 text-[12px] text-warning/80">The board couldn’t be read just now: where cards are may be out of date.</p>}
            {loading || (inIdeas && ideasHome === null && ideasError === null) ? (
              <div className="mt-20 flex justify-center">
                <Loader size={32} />
              </div>
            ) : nothingAtAll ? (
              <FirstEdit cloudOn={Boolean(cloud?.on)} onNew={newWork !== null ? () => startNew(newWork) : null} />
            ) : listed > 0 ? (
              <>
                <HomeList groups={groups} solo={solo} cross={cross} lengthLabel={inIdeas ? "Views" : "Length"} />
                {!searching && shownWhere === "done" && !allDone && total > DONE_SHOWN && (
                  <Button variant="subtle" className="mt-3 self-start" onClick={() => setAllDone(true)}>
                    Show all {total}
                  </Button>
                )}
              </>
            ) : inIdeas && (ideasHome?.ideas.length ?? 0) === 0 && (ideasHome?.changes.length ?? 0) === 0 ? (
              <NoIdeas onNew={() => setIdeaOpen(true)} />
            ) : (
              <div className="mt-16 text-center">
                <div className="text-[14px] font-medium">{empty.title}</div>
                <p className="mt-1.5 text-[13px] text-muted">{empty.text}</p>
              </div>
            )}
            </>
            )}
          </div>
        </main>
      </div>
      <ImportDialog id={watching} writing={writing} issues={issues} onClose={() => setWatching(null)} />
      <NewProject work={work} open={creating} onClose={() => { setCreating(false); setStart(null); }} start={start} />
      {ideasAllowed && <NewThumbnail open={thumbOpen} onClose={() => setThumbOpen(false)} />}
      {ideasAllowed && <NewIdea open={ideaOpen} onClose={() => setIdeaOpen(false)} onMade={refreshIdeas} />}
    </DoneContext.Provider>
  );
}

/**
 * Whose and which kind (Sphe, Nov 2: "probably would help if we turned this
 * into like a dropdown with filters like category"): one button saying what's
 * shown ("Mine", "Everyone · Bodycam"), its menu Mine or Everyone, then every
 * kind there is with how many. A search looks through everything, as before.
 */
function FilterButton({ who, kind, kinds, period, channel, channels, disabled, onWho, onKind, onPeriod, onChannel }: { who: "mine" | "everyone" | null; kind: Style | null; kinds: { value: Style; label: string; count: number }[]; period: Period; channel: string | null; channels: { value: string; label: string; count: number }[]; disabled: boolean; onWho: (value: "mine" | "everyone") => void; onKind: (value: Style | null) => void; onPeriod: (value: Period) => void; onChannel: (value: string | null) => void }) {
  const kindLabel = kinds.find((one) => one.value === kind)?.label ?? STYLES.find((one) => one.value === kind)?.label ?? null;
  const channelLabel = channels.find((one) => one.value === channel)?.label ?? null;
  const label = [who === "mine" ? "Mine" : who === "everyone" ? "Everyone" : null, channelLabel, kindLabel, PERIODS.find((one) => one.value === period)!.label].filter(Boolean).join(" · ");
  const filtered = kind !== null || channel !== null || period !== "week";
  const open = (event: React.MouseEvent<HTMLButtonElement>) =>
    toggleMenu(
      event.currentTarget,
      [
        ...(who !== null
          ? ([
              { label: "Mine", hint: "what you started", checked: who === "mine", onSelect: () => onWho("mine") },
              { label: "Everyone", hint: "the team’s", checked: who === "everyone", onSelect: () => onWho("everyone") },
              { separator: true },
            ] satisfies MenuItem[])
          : []),
        ...PERIODS.map((one): MenuItem => ({ label: one.label, checked: period === one.value, onSelect: () => onPeriod(one.value) })),
        { separator: true },
        // The channels first (V2's), then today's kinds.
        ...(channels.length > 0
          ? ([
              { label: "Every channel", checked: channel === null, onSelect: () => onChannel(null) },
              ...channels.map((one): MenuItem => ({ label: one.label, detail: String(one.count), checked: channel === one.value, onSelect: () => onChannel(one.value) })),
              { separator: true },
            ] satisfies MenuItem[])
          : []),
        { label: "Every kind", checked: kind === null, onSelect: () => onKind(null) },
        ...kinds.map((one): MenuItem => ({ label: one.label, detail: String(one.count), checked: kind === one.value, onSelect: () => onKind(one.value) })),
      ],
      { width: 220 },
    );
  return (
    <button
      type="button"
      onClick={open}
      disabled={disabled}
      title={disabled ? "A search looks through everything" : "Whose, how far back, and which kind"}
      className={cx(
        "flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] bg-black px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        filtered ? "text-fg" : "text-secondary hover:text-fg",
      )}
    >
      <ListFilter size={14} className={filtered ? "text-fg" : "text-muted"} />
      <span className="max-w-[180px] truncate">{label}</span>
      <ChevronDown size={13} className="text-faint" />
    </button>
  );
}

/**
 * A place's stages as steps over its list (prototype C, Nov 2): All, then each
 * stage in order with what's in it; an empty one greyed, not hidden, so the
 * order still reads. The open step again goes back to All.
 */
function StageSteps({ place, steps, stage, onChoose }: { place: Spot; steps: { key: string; label: string; count: number }[]; stage: string | null; onChoose: (where: Where) => void }) {
  const step = (key: string | null, label: string, count: number | null) => {
    const on = stage === key;
    const empty = count === 0 && !on;
    return (
      <button
        key={key ?? "all"}
        disabled={empty}
        onClick={() => onChoose(key === null || on ? place : `${place}:${key}`)}
        className={cx("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors", on ? "bg-active text-fg" : empty ? "text-faint" : "text-muted hover:bg-hover hover:text-fg")}
      >
        {label}
        {count !== null && count > 0 && <span className={cx("tabular", on ? "text-secondary" : "text-faint")}>{count}</span>}
      </button>
    );
  };
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-0.5">
      {step(null, "All", null)}
      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
      {steps.map((one, index) => (
        <Fragment key={one.key}>
          {/* The arrows go first when it's narrow (960 px: Subtitled ran off the panel). */}
          {index > 0 && <ChevronRight size={12} className="shrink-0 text-faint/60 max-[1100px]:hidden" />}
          {step(one.key, one.label, one.count)}
        </Fragment>
      ))}
    </div>
  );
}

/** Which place Home shows (remembered on this browser), from before too ("subtitled" and "ideas" were tabs). */
function savedWhere(): Where {
  const saved = localStorage.getItem(VIEW) ?? "";
  if (saved === "subtitled") return "edits:subtitled";
  // Needs you went on Nov 2 ("let's remove needs you"): Home opens on Edits.
  // Later went on Nov 18: Home opens on Edits from it.
  if (saved === "done" || saved === "exports" || saved === "thumbnails" || saved === "channels") return saved;
  // Videos (Scripts and Edits together) for an evening on Nov 2: its stage says which it was.
  const [first, stage] = saved.split(":") as [string, string | undefined];
  const fromVideos: Spot = stage !== undefined && PLACES.find((one) => one.key === "scripts")!.stages.some((one) => one.key === stage) ? "scripts" : "edits";
  const place: Spot | null = first === "ideas" || first === "scripts" || first === "edits" ? first : first === "videos" ? fromVideos : null;
  if (place === null) return "edits";
  return stage !== undefined && PLACES.find((one) => one.key === place)!.stages.some((one) => one.key === stage) ? `${place}:${stage}` : place;
}

/** An empty Home: the way to the first edit. */
function FirstEdit({ cloudOn, onNew }: { cloudOn: boolean; onNew: (() => void) | null }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mt-[14vh] flex flex-col items-center text-center">
      <Tile size={64} />
      <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em]">{onNew === null ? "Nothing here for your account yet" : "Make your first edit"}</h1>
      <p className="mt-2 max-w-[360px] text-muted">
        {onNew === null
          ? "An admin gives you the work you do at accounts.spheceo.com."
          : cloudOn
          ? "Projects are kept in the team’s cloud, so anyone can pick one up where you left off. Import footage, cut it, and let an agent build the polish."
          : "Projects live on this machine. Import footage, cut it, and let an agent build the polish."}
      </p>
      {onNew !== null && (
        <Button className="mt-6" variant="light" onClick={onNew}>
          <Plus size={15} strokeWidth={2.2} /> New project
        </Button>
      )}
    </motion.div>
  );
}

/**
 * Home's list: the column names, then each group (a stage, or a section in a
 * search) under its name, newest first. What came in since it was last shown
 * slides in, and a renamed row flashes once (state B laid over state A, not
 * the list built again).
 */
function HomeList({ groups, solo, cross, lengthLabel }: { groups: { key: string; label: string | null; items: Item[] }[]; solo: boolean; cross: boolean; lengthLabel: string }) {
  // As wide as the window lets it be: the columns a name can spare go first (Length, then Category).
  const table = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const element = table.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const watch = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  const layout = layoutFor(width, solo);
  // V2's work is a channel's; V1's column is its niche.
  const v2 = useBeta((beta) => beta.v2);
  const seen = useRef<Map<string, string> | null>(null);
  const [lately, setLately] = useState<{ added: Set<string>; renamed: Set<string> }>({ added: new Set(), renamed: new Set() });
  const rows = groups.flatMap((group) => group.items);
  const signature = rows.map((item) => `${item.id}=${item.title}`).join("\n");
  useEffect(() => {
    const now = new Map(rows.map((item) => [item.id, item.title]));
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    const added = new Set([...now.keys()].filter((id) => !before.has(id)));
    const renamed = new Set([...now.entries()].filter(([id, name]) => before.has(id) && before.get(id) !== name).map(([id]) => id));
    if (added.size === 0 && renamed.size === 0) return;
    setLately({ added, renamed });
    const timer = setTimeout(() => setLately({ added: new Set(), renamed: new Set() }), 1800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return (
    <TableShape.Provider value={{ cross }}>
      <div
        ref={table}
        role="table"
        aria-label="Projects"
        data-solo={solo || undefined}
        data-compact={layout.compact || undefined}
        data-slim={layout.slim || undefined}
        data-faces={layout.faces || undefined}
        className="group/table grid gap-x-4"
        style={{ gridTemplateColumns: layout.columns }}
      >
        <div role="row" className={cx(COLUMNS, "px-3 pb-2 text-[12px] font-medium text-muted")}>
          <span role="columnheader">Name</span>
          <span role="columnheader" className="text-right">
            Status
          </span>
          <span role="columnheader" className={CATEGORY}>
            {v2 ? "Channel" : "Niche"}
          </span>
          <span role="columnheader" className={BY}>
            By
          </span>
          <span role="columnheader" className={LENGTH}>
            {lengthLabel}
          </span>
          <span role="columnheader">Updated</span>
        </div>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {group.label !== null && (
              // The kit's section label: sentence case, 13/500, muted.
              <div className="col-span-full flex items-center gap-1.5 border-t border-line px-3 pt-5 pb-2 text-[13px] font-medium text-muted">
                {group.label} <span className="font-normal text-faint tabular">{group.items.length}</span>
              </div>
            )}
            {group.items.map((item) => (
              <div key={item.id} className={cx(COLUMNS, lately.added.has(item.id) && "row-new", lately.renamed.has(item.id) && "row-changed")}>
                {item.row()}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </TableShape.Provider>
  );
}

/** New project opened with a title, its links and a kind (an approved idea's Write the script). */
export type NewProjectStart = { title: string; text: string; style: Style };

/** A row of Home's table: a project on this Mac, one only in the cloud, or a script with no edit yet; `script`: the script it's made from. */
export type Listed =
  | { at: number; local: ProjectSummary; cloud: null; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: CloudProject; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: null; script: WriterScriptRow; importing?: Importing; writing?: boolean; sharing?: boolean; here?: boolean };

/** A script's import while it isn't done: its word for it ("Importing 40%", "Stopped"). */
export type Importing = { word: string; stopped: boolean; percent?: number; step?: string };

/**
 * Where a project is on its way, script to finished video: Home lists them by
 * it (the user, Oct 30: "ready for scripting, these projects are ready for
 * editing, these projects are done editing … a natural progression of our
 * projects here instead of dumping the whole list").
 */
export type Stage = "toscript" | "scripting" | "ready" | "importing" | "editing" | "review" | "done";

export function stageOf(row: Listed, state: ProjectStatus | undefined): Stage {
  if (row.local === null && row.cloud === null) return row.importing ? "importing" : row.script.built ? "ready" : row.writing ? "scripting" : "toscript";
  if (state === undefined) return "editing";
  if (state.importing !== null) return "importing";
  if (state.approved !== null) return "done";
  if (state.feedback > 0 || (state.complete && state.exported)) return "review";
  return "editing";
}

/** Which place Home shows (remembered on this browser). */
export const VIEW = "edit.home.view";
/** The kind of video Home's lists are filtered to (remembered on this browser). */
const KIND = "edit.home.kind";
/** A row's menu with its note's item after Rename (or first, when it has no Rename). */
function withNote(items: MenuItem[], note: MenuItem[]): MenuItem[] {
  const at = items.findIndex((item) => "label" in item && item.label === "Rename");
  return at < 0 ? [...note, ...items] : [...items.slice(0, at + 1), ...note, ...items.slice(at + 1)];
}

/** Mine or Everyone (remembered on this browser). */
const MINE = "edit.home.mine";
/** The channel Home's lists are filtered to (remembered on this browser). */
const CHANNEL = "edit.home.channel";

/** How far back Home's lists look: what changed in the last 7, 30 or 365 days, or everything (`Home`'s period). */
const PERIODS = [
  { value: "week", label: "This week", days: 7 },
  { value: "month", label: "This month", days: 30 },
  { value: "year", label: "This year", days: 365 },
  { value: "all", label: "All time", days: null },
] as const;
type Period = (typeof PERIODS)[number]["value"];
/** The period, while this window is open. */
const PERIOD = "edit.home.period";

/** When `period` starts: anything changed since is in it. */
function periodStart(period: Period): number {
  const days = PERIODS.find((one) => one.value === period)!.days;
  return days === null ? -Infinity : Date.now() - days * 24 * 3600_000;
}

/** What each kind of video makes: the New project pills' tooltips. */
const STYLE_NOTES: Record<Style, string> = {
  bodycam: "16:9 · a narrated bodycam case or compilation, in the house voice",
  interrogation: "16:9 · an interrogation edit, narrated by your recording",
  courtroom: "16:9 · a courtroom edit, narrated by your recording",
  commentary: "16:9 · a narrated video essay with researched B-roll",
  horror: "16:9 · a narrated internet-mystery documentary in an analog horror look",
  shorts: "9:16 · a video’s highlights in 45–60 s, reframed on the subject, our subtitles, music",
};

export interface NoticeProps {
  tone: "warn" | "bad" | "info";
  text: string;
  title: string;
}

/** A small chip on a card saying what’s off: footage missing, footage still in the cloud. */
export function Notice({ tone, text, title }: NoticeProps) {
  const Icon = tone === "info" ? CloudDownload : TriangleAlert;
  return (
    <span
      title={title}
      className={cx(
        CHIP,
        tone === "info" ? "text-fg" : tone === "bad" ? "text-danger" : "text-warning",
      )}
    >
      <Icon size={12} />
      {text}
    </span>
  );
}

/** What a project’s card says about it, and what can be done to it (rename, delete, move to cloud). */
function useProject(project: ProjectSummary, onChanged: () => void, cloudOn: boolean, status?: CloudStatus, remote?: CloudProject, script: string | null = null) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useEditor((state) => state.toast);
  const drive = useDriveLink(project.id, project.drive);
  const inCloud = cloudOn && Boolean(status?.cloud);
  // Footage the timeline plays that’s gone from this Mac (deleted, or on a drive that isn’t plugged in).
  const missing = project.missing ?? 0;
  const used = project.media_used ?? missing;
  const mostlyMissing = missing > 0 && missing * 2 >= used;
  // Cloud footage not on this Mac yet: it comes down when the project opens.
  const fetching = project.remote ?? 0;
  const mostlyRemote = !mostlyMissing && fetching > 0 && fetching * 2 >= used;
  // Someone else’s live lock (this machine’s own isn’t news).
  const editor = remote?.holder && !remote.here ? remote.holder : null;
  // The cloud is only worth a word when something’s off.
  const cloudNews = inCloud && (editor !== null || status?.dirty === true || status?.sync === "offline");

  // Its category (the kind of video its agent edits it as), among the styles this person edits; a Short's format is its own, so it stays one.
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const styles = STYLES.filter((one) => one.value !== "shorts" && (allowed === null || allowed.has(one.value) || one.value === project.style));
  const recategorize = async (style: Style) => {
    if (style === project.style) return;
    try {
      const live = await api.project(project.id);
      await api.saveProject(project.id, live.rev, { ...live.project, style }, clientId);
      markSeen(`edit:${project.id}`);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `change the category of “${project.name}”`);
    }
  };
  const rename = async (name: string) => {
    setRenaming(false);
    if (!name || name === project.name) return;
    try {
      const live = await api.project(project.id);
      await api.saveProject(project.id, live.rev, { ...live.project, name }, clientId);
      // The person's own change from Home: not Changed for them.
      markSeen(`edit:${project.id}`);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, "rename it");
    }
  };
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${project.name}”`);
    }
    onChanged();
  };
  const share = async () => {
    try {
      await askExportFolder();
      await api.shareProject(project.id, null, false, true);
      toast(`Sharing “${project.name}”: exporting it now`, "info");
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `share “${project.name}”`);
    }
  };
  const open = () => {
    if (renaming) return;
    if (project.problem) useEditor.getState().toastError(project.problem, `open “${project.name}”`);
    else navigate(`/p/${project.id}`);
  };
  // Its ⋯ (and right click): Done's is added by the row.
  const items: MenuItem[] = [
    // Made from a script: that script, its other mode.
    ...(script !== null ? [{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script}`) }] : []),
    { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
    // Not for Edit V2: its graphics are code its agent wrote for the new way, which no other kind has.
    ...(project.style !== "shorts" && project.hq !== true && !project.problem && styles.length > 1
      ? [{ label: "Category", icon: <Tag size={14} />, submenu: styles.map((one) => ({ label: one.label, checked: one.value === project.style, onSelect: () => void recategorize(one.value) })) }]
      : []),
    // Shared from here, many projects at once (an export that would wait here goes to the cloud).
    ...(project.problem ? [] : [{ label: "Share for review", icon: <Share2 size={14} />, onSelect: () => void share() }]),
    ...(drive
      ? [
          { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
          { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
        ]
      : []),
    ...promoteItem(project, onChanged),
    { separator: true },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
  ];
  const driveMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!drive) return;
    const box = event.currentTarget.getBoundingClientRect();
    toggleMenu(
      event.currentTarget,
      [
        { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
        { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
      ],
      { width: 180, at: { x: box.left, y: box.bottom + 4 } },
    );
  };
  const nameInput = renaming ? (
    <input
      autoFocus
      defaultValue={project.name}
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => void rename(event.currentTarget.value.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setRenaming(false);
      }}
      className="-mx-1.5 h-7 w-[calc(100%+12px)] rounded-md bg-black/80 px-1.5 font-semibold text-fg outline-none"
    />
  ) : null;
  const dialogs = (
    <>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${project.name}”?`}
        detail={
          inCloud
            ? `It’s deleted from the cloud too, for everyone on the team. A copy is kept in ${THIS_MACHINE}’s Edit data folder; footage files stay where they are.`
            : "The project and its edit are removed (a copy is kept in Edit’s data folder). Your footage files stay where they are."
        }
        confirm={inCloud ? "Delete everywhere" : "Delete project"}
        onConfirm={() => void remove()}
      />
    </>
  );
  // What’s worth a word on the card, as a chip beside "On Drive".
  const notice: NoticeProps | null = project.problem
    ? { tone: "bad", text: "Can’t be opened", title: project.problem }
    : // The cloud refused it: the team can't open or fix it until it's up (Oct 29).
      status?.sync === "error"
      ? { tone: "bad", text: "Not in the cloud", title: `Edit keeps trying to save it to the cloud: ${status.message ?? "it was refused"}` }
      : missing > 0
        ? {
            tone: "warn",
            text: mostlyMissing ? "Footage missing" : `${missing} ${missing === 1 ? "file" : "files"} missing`,
            title: `${missing} of ${used} footage files the edit plays aren’t on ${THIS_MACHINE} (deleted, or on a drive that isn’t plugged in)`,
          }
        : null;
  return { drive, missing, used, mostlyMissing, mostlyRemote, editor, cloudNews, status, notice, open, items, driveMenu, nameInput, dialogs };
}

export interface CardProps {
  project: ProjectSummary;
  onChanged: () => void;
  /** Cloud is on here. */
  cloudOn: boolean;
  /** Its cloud state on this machine (a cloud project). */
  status?: CloudStatus;
  /** It as listed in the cloud. */
  remote?: CloudProject;
  /** Its feedback and export state. */
  state?: ProjectStatus;
}

/** Chips for a project’s review notes waiting and a finished edit not exported as it is now. */
function StateChips({ state, projectId, onChanged, editor = null }: { state?: ProjectStatus; projectId?: string; onChanged?: () => void; editor?: string | null }) {
  const toast = useEditor((store) => store.toast);
  // Someone else has it open: that comes first (it opens read-only).
  if (editor !== null)
    return (
      <span title={`${editor} is editing it now: it opens read-only until they close it.`} className={cx(CHIP, "text-warning")}>
        <Lock size={12} className="shrink-0" />
        <span className="truncate">Being edited</span>
      </span>
    );
  if (state === undefined) return null;
  if (state.archived !== null) {
    const restore = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (projectId === undefined) return;
      void api
        .restoreProject(projectId)
        .then(() => {
          toast("Restoring: its footage is downloading again", "info");
          onChanged?.();
        })
        .catch((error) => useEditor.getState().toastError(error, "restore it"));
    };
    return (
      <span
        title={state.archived.error ?? "Archived on Repack: its footage and exports were freed; the project and its transcripts are kept"}
        className={cx(CHIP, "text-muted")}
      >
        <Archive size={12} />
        {state.archived.restoring ? "Restoring…" : "Archived"}
        {!state.archived.restoring && (
          <button onClick={restore} className="text-info hover:text-info">
            Restore
          </button>
        )}
      </span>
    );
  }
  // One status a row, the one that matters most (the user, Oct 30: a row of chips was "a mess").
  const first = [
    state.importing !== null && (
        <span key="importing"
          title={state.importing.error ?? `Importing: ${state.importing.state}`}
          className={cx(CHIP, "tabular", importStuck(state.importing) ? "text-warning" : "text-info")}
        >
          {importStuck(state.importing) ? <TriangleAlert size={12} className="shrink-0" /> : <Pulse size={12} />}
          <span className="truncate">{importStuck(state.importing) ? "Import stuck" : `Importing ${importShare(state.importing)}`}</span>
        </span>
      ),
    // Its footage still coming down here after the editor was left (Sphe, Nov 18): how far, as the top bar's cloud says it.
    state.footage && (
        <span key="footage" title={footageTitle(state.footage)} className={cx(CHIP, "tabular text-info")}>
          <ProgressRing value={state.footage.bytes_total > 0 ? state.footage.bytes_done / state.footage.bytes_total : 0} size={12} />
          <span className="truncate">Getting footage · {state.footage.files_total - state.footage.files_done} left</span>
        </span>
      ),
    state.working && (
        <span key="working" title="Its agent is working on it" className={cx(CHIP, "text-agent")}>
          <span className="size-1.5 animate-pulse rounded-full bg-agent" />
          Agent working
        </span>
      ),
    state.sharing !== null && (
        <span key="sharing" title={`Sharing: ${state.sharing}`} className={cx(CHIP, "max-w-[220px] text-info")}>
          <Share2 size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{shareChip(state.sharing)}</span>
        </span>
      ),
    // Its export finished here since the Exports view was last opened (Sphe, Nov 18): until it's opened, not the project.
    state.exported_new === true && (
        <span key="exported" title="Exported since you last opened Exports" className={cx(CHIP, "text-success")}>
          <Check size={12} className="shrink-0" />
          Exported
        </span>
      ),
    state.approved !== null && (
        <span key="approved" title={`Version ${state.approved} was approved on its review`} className={cx(CHIP, "text-success")}>
          <Check size={12} />
          Approved v{state.approved}
        </span>
      ),
    state.approved === null && state.feedback > 0 && (
        <span key="notes"
          title={`${state.feedback} open comment${state.feedback === 1 ? "" : "s"} on its review`}
          className={cx(CHIP, "text-info")}
        >
          <MessageSquare size={12} />
          {state.feedback} {state.feedback === 1 ? "comment" : "comments"}
        </span>
      ),
    state.complete && !state.exported && (
        <span key="export" title="The edit is finished, but what it is now hasn’t been exported" className={cx(CHIP, "text-warning")}>
          <FileVideo size={12} />
          Not exported
        </span>
      ),
    // Nothing pressing says nothing (Sphe, Nov 18: status "shows only what needs you"; "In progress" and "No comments" went).
  ].find(Boolean);
  return first || null;
}

/** "6.1 of 9.4 GB · 21 of 32 files here · about 3 min". */
function footageTitle(footage: NonNullable<ProjectStatus["footage"]>): string {
  return [sizeWords(footage.bytes_done, footage.bytes_total), `${footage.files_done} of ${footage.files_total} files here`, aboutWords(footage.left_s)].filter((one) => one !== null).join(" · ");
}

/** An import waiting on the person (a file it couldn't get) or failed. */
export const importStuck = (importing: NonNullable<ProjectStatus["importing"]>) => importing.state === "waiting" || importing.state === "failed";

/** How far an import is: its bytes while it downloads, then the step it's on. */
export function importShare(importing: NonNullable<ProjectStatus["importing"]>) {
  if (importing.state === "downloading") return importing.share !== null ? `${Math.round(importing.share * 100)}%` : `${importing.ready}/${importing.files}`;
  return { transcribing: "· hearing", placing: "· laying out", voicing: "· voicing" }[importing.state] ?? "";
}

/** A script being written from its videos (Script mode's import): what it's on and how far. */
/** `startedAt`: when the import began, as the server says. */
export type Writing = { id: string; title: string; stage: string; percent: number; detail: string; startedAt?: number };

/** When each import and each of its steps was first seen here, by script: kept while Home is open, so reopening its dialog doesn't start the clock again. */
const SEEN = new Map<string, Record<string, number>>();

/** A script import that stopped: what it asks (a decision) or why it failed. */
export type ScriptIssueRow = {
  id: string;
  title: string;
  status: string;
  /** Where it got to: downloading, transcribing, … */
  stage: string;
  /** How far it got (0–100). */
  progress?: number;
  error: string | null;
  createdBy?: Creator;
  decision?: Decision;
  /** Dismissed from "need you" (still stopped). */
  dismissedAt?: number;
  /** Its first prompt still to start. */
  firstBuild?: boolean;
  /** When its first build was saved (Home's New). */
  builtAt?: number;
  /** A test script (TestProjects.tsx): not listed unless `shown`. */
  test?: boolean;
  shown?: boolean;
  /** Written over several videos. */
  compilation?: boolean;
  /** Its last Claude run ended without finishing: when, and what it said. */
  runFailed?: { at: number; error: string } | null;
  /** When it was started. */
  createdAt?: number;
  /** Being shared for review on this Mac (it runs on its own). */
  sharing?: { startedAt: number };
  /** Its script being written (a build running on this Mac). */
  building?: boolean;
  /** Its footage clips (more than one: written), its length, when it last changed and its channel, as this Mac has them. */
  clipCount?: number;
  durationMs?: number;
  updatedAt?: number;
  channel?: string;
  /** Its note, left from Home's ⋯. */
  note?: string;
  /** Stopped on a failure this build meets again however often it's retried (a 413): Retry isn't offered until an update. */
  retryHelps?: false;
};

/** What a stopped import that Retry can't help says instead of offering it. */
export const NEEDS_A_FIX = "Retrying stops here again: this needs a fix in Edit. Once Edit is updated, Retry carries on from what it kept.";

/** Answers a stopped import; it carries on in the background and Home follows it. Whether the server took the answer. */
async function answerIssue(issue: ScriptIssueRow, choice: Choice): Promise<boolean> {
  const writer = await import("../writer/api");
  return writer.resumeImport(issue.id, choice).then(
    () => true,
    (cause) => {
      useEditor.getState().toastError(cause, `carry on “${issue.title}”`);
      return false;
    },
  );
}

/**
 * Whether Retry can help a stopped import: not one this build meets again, nor
 * one that asks a question Retry only asks again (footage with no words heard,
 * which would also be paid for again). A folder an older Edit stopped as over
 * a case's limits is retried whole: a case takes all its footage now.
 */
const retries = (issue: ScriptIssueRow) => issue.retryHelps !== false && issue.decision?.kind !== "no_speech";

/**
 * What can be done about a stopped import, each in a dialog of its own: see
 * the whole error, try again, go on without what failed, give another link
 * for a video, or take it off the list. The user, Oct 30: "if something goes
 * wrong, it's blocked, it's frozen at that state, and then we can come in,
 * fix it, and unblock it"; and the answers in a ⋯ menu, "the exact error ...
 * in a dialog box", Replace a dialog, and Dismiss confirmed.
 */
export function useIssueDialogs(issue: ScriptIssueRow) {
  const [open, setOpen] = useState<"error" | "replace" | "dismiss" | null>(null);
  const [url, setUrl] = useState("");
  const failed = issue.decision?.kind === "failed_recordings" ? issue.decision.failed : [];
  const [which, setWhich] = useState(failed[0]?.id ?? "");
  const close = () => setOpen(null);
  // Why, said plainly (problems.ts): the original words go to the log, never on screen.
  const said = issue.decision?.summary ?? issue.error ?? "It stopped without saying why.";
  const retry = () => {
    close();
    void answerIssue(issue, { kind: "retry" });
  };
  const helps = retries(issue);
  const items: MenuItem[] = [
    { label: "Why it stopped", icon: <TriangleAlert size={14} />, onSelect: () => setOpen("error") },
    ...(helps ? [{ label: "Retry", icon: <RotateCw size={14} />, onSelect: retry }] : []),
    ...(issue.decision?.kind === "failed_recordings" ? [{ label: goOnWithout(issue), icon: <SkipForward size={14} />, onSelect: () => void answerIssue(issue, { kind: "skip_failed" }) }] : []),
    ...(issue.decision?.kind === "no_speech" ? [{ label: NO_TRANSCRIPT, icon: <FileText size={14} />, onSelect: () => void answerIssue(issue, { kind: "no_transcript" }) }] : []),
    { label: "Replace…", icon: <Replace size={14} />, onSelect: () => setOpen("replace") },
    { separator: true },
    { label: "Dismiss…", icon: <X size={14} />, danger: true, onSelect: () => setOpen("dismiss") },
  ];
  const dialogs = (
    <>
      <Modal open={open === "error"} onClose={close} width={520}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Why “{issue.title}” stopped</h2>
          <p className="mt-1 text-[13px] text-muted">Stopped {stageWords(issue.stage)}{issue.progress ? `, ${Math.round(issue.progress)}% in` : ""}. It waits there until it’s answered.</p>
          <ProblemView error={said} doing="finish the import" className="mt-4" />
          {failed.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12px]">
              {failed.map((one) => (
                <li key={one.id} className="flex min-w-0 gap-2">
                  <span className="min-w-0 truncate text-secondary">{one.title}</span>
                  <span className="shrink-0 text-muted">{explain(one.error, "download it").title}</span>
                </li>
              ))}
            </ul>
          )}
          {issue.retryHelps === false && <p className="mt-3 text-[13px] leading-relaxed text-muted">{NEEDS_A_FIX}</p>}
          <div className="mt-[22px] flex items-center justify-end gap-2">
            <div className="flex gap-2">
              <Button variant={helps ? "subtle" : "primary"} onClick={() => setOpen("replace")}>
                Replace…
              </Button>
              {helps && (
                <Button variant="primary" onClick={retry}>
                  Retry
                </Button>
              )}
            </div>
          </div>
        </div>
      </Modal>
      <Modal open={open === "replace"} onClose={close} width={460}>
        <form
          className="p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() === "") return;
            close();
            void answerIssue(issue, { kind: "replace", url: url.trim(), ...(failed.length > 0 ? { id: which } : {}) });
            setUrl("");
          }}
        >
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Replace a video</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Give another link for {failed.length > 0 ? "a video that failed" : "this import’s video"}, such as a Google Drive copy of a YouTube video that won’t download. The import carries on from where it stopped.</p>
          {failed.length > 1 && (
            <select value={which} onChange={(event) => setWhich(event.target.value)} className="mt-4 h-9 w-full rounded-md border border-line bg-black px-2 text-[13px]">
              {failed.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          )}
          <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="A YouTube or Google Drive link" className="mt-4 h-9 w-full rounded-md border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted" />
          <div className="mt-[22px] flex justify-end gap-2">
            <Button type="button" variant="subtle" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={url.trim() === ""}>
              Use this link
            </Button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={open === "dismiss"}
        onClose={close}
        title={`Dismiss “${issue.title}”?`}
        detail="It comes off this list for everyone and stays stopped where it is. Its script keeps what was imported, and Retry there still carries it on."
        confirm="Dismiss"
        onConfirm={() => {
          close();
          void answerIssue(issue, { kind: "dismiss" });
        }}
      />
    </>
  );
  return { items, dialogs, said, retry, showError: () => setOpen("error"), replace: () => setOpen("replace") };
}

/**
 * A stopped import's answers at the foot of its import dialog: the one thing
 * to do (Retry), the other way out (another link, or going on without what
 * failed), nothing more; the error is already in the step above, and Dismiss
 * is on Home's list. The user, Oct 30: "too many options ... minimizing the
 * number of options and the amount of thinking that someone has to do".
 */
function IssueActions({ issue }: { issue: ScriptIssueRow }) {
  const { dialogs, retry, replace } = useIssueDialogs(issue);
  const kind = issue.decision?.kind;
  return (
    <>
      {kind === "failed_recordings" ? (
        <Button onClick={() => void answerIssue(issue, { kind: "skip_failed" })}>{goOnWithout(issue)}</Button>
      ) : (
        <Button variant={retries(issue) || kind === "no_speech" ? undefined : "primary"} onClick={replace}>
          Replace…
        </Button>
      )}
      {/* Footage with no words: opened as it is, its script written without a transcript (as Writer's dialog offered until Nov 15). */}
      {kind === "no_speech" && (
        <Button variant="primary" onClick={() => void answerIssue(issue, { kind: "no_transcript" })}>
          {NO_TRANSCRIPT}
        </Button>
      )}
      {/* A failure this build meets again isn't offered Retry: it would download it all again to stop in the same place (Nov 1, 13 retries of a 413). */}
      {retries(issue) && (
        <Button variant="primary" onClick={retry}>
          Retry
        </Button>
      )}
      {dialogs}
    </>
  );
}

const NO_TRANSCRIPT = "Open without a transcript";
const goOnWithout = (issue: ScriptIssueRow) => (issue.decision?.kind === "failed_recordings" && issue.decision.failed.length === 1 ? "Go on without it" : "Go on without them");

/**
 * A stopped import on Home's "need you" list, in the table's columns below it
 * (the name with who started it at its end, then where it stopped and why),
 * so the avatars line up between the two; the error's first words (the whole
 * of it a click away), and the answers in the ⋯ menu at the far right. Its
 * title opens it over Home.
 */
function ScriptIssue({ issue, onOpen }: { issue: ScriptIssueRow; onOpen: (id: string) => void }) {
  const { items: own, dialogs } = useIssueDialogs(issue);
      <Category text="" />
  const marked = useDoneRow(doneKey("script", issue.id), issue.title);
  const items = withDone(own, marked.items);
  return (
    <div
      role="row"
      onClick={() => onOpen(issue.id)}
      onContextMenu={contextMenu(items, 220)}
      className={cx(COLUMNS, ROW)}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <KindMark kind="script" />
        <TriangleAlert size={14} className="shrink-0 text-warning" />
        <span className={NAME} title={issue.title}>
          {issue.title}
        </span>
      </div>
      <StatusCell>
        {marked.entry ? (
          <DoneStatus entry={marked.entry} />
        ) : (
          // Where it stopped, so it's plain what's being fixed.
          <span title={`Stopped ${stageWords(issue.stage)}: ${explain(issue.decision?.summary ?? issue.error ?? "", "finish the import").title}`} className={cx(CHIP, "text-warning")}>
            <TriangleAlert size={12} className="shrink-0" />
            <span className="truncate">Stopped · {stageName(issue.stage)}</span>
          </span>
        )}
      </StatusCell>
      <CreatorCell by={issue.createdBy} />
      <LengthCell />
      <Updated at={issue.createdAt ?? 0} />
      <RowButtons extra={marked.button} items={items} width={220} />
      {/* Its dialogs open over Home; clicks inside them aren't the row's. */}
      <div className="contents" onClick={(event) => event.stopPropagation()}>
        {dialogs}
      </div>
    </div>
  );
}

/** An import's stage as a chip's word ("Transcribing"). */
export function stageName(stage: string): string {
  const names: Record<string, string> = {
    reading: "Reading",
    downloading: "Downloading",
    joining: "Joining",
    transcribing: "Transcribing",
    processing: "Finishing",
    researching: "Researching",
    speakers: "Naming speakers",
    ready: "After import",
  };
  return names[stage] ?? (stage ? stage[0]!.toUpperCase() + stage.slice(1) : "Stopped");
}

/** An import's stage in words ("while downloading"). */
export function stageWords(stage: string): string {
  const words: Record<string, string> = {
    reading: "while reading the footage",
    downloading: "while downloading",
    joining: "while joining the videos",
    transcribing: "while transcribing",
    processing: "while finishing",
    researching: "while researching",
    speakers: "while naming the speakers",
    ready: "after the import",
  };
  return words[stage] ?? (stage ? `at ${stage}` : "");
}

/**
 * A script's import, open over Home: each step, how far it is, what it's on
 * and for how long (the user, Oct 30: clicking a project still importing
 * "should pop up on the home page and shouldn't redirect you to the script
 * page"). Once it's in, it says so and opens the script.
 */
export function ImportDialog({ id, writing, issues, onClose }: { id: string | null; writing: Writing[]; issues: ScriptIssueRow[]; onClose: () => void }) {
  const live = writing.find((one) => one.id === id) ?? null;
  // Stopped (and not running again): where it got to, why, and what can be done, here on Home.
  const stopped = live === null ? (issues.find((one) => one.id === id) ?? null) : null;
  const last = useRef<Writing | null>(null);
  if (live) last.current = live;
  const shown: Writing | null = live ?? (stopped ? { id: stopped.id, title: stopped.title, stage: stopped.stage, percent: stopped.progress ?? 0, detail: "" } : last.current);
  const [now, setNow] = useState(() => Date.now());
  const step = shown ? stepOf(shown) : "download";
  useEffect(() => {
    last.current = null;
  }, [id]);
  // The import's start as the server gives it, else when this page first saw it; each step's, when this page first saw it.
  const seen = shown ? (SEEN.get(shown.id) ?? {}) : {};
  if (shown) {
    seen.start = shown.startedAt ?? seen.start ?? Date.now();
    seen[step] ??= Date.now();
    SEEN.set(shown.id, seen);
  }
  const began = seen;
  useEffect(() => {
    if (id === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [id]);
  const done = id !== null && live === null && stopped === null && last.current !== null;
  // Why, said plainly (problems.ts): the original words are the log's.
  const problem = stopped ? explain(stopped.decision?.summary ?? stopped.error ?? "", "finish the import") : null;
  const why = problem ? `${problem.title}. ${problem.fix}`.trim() : null;
  const at = done ? STEPS.length : STEPS.findIndex((candidate) => candidate.key === step);
  const percent = done ? 100 : Math.floor(Math.max(0, Math.min(100, live ? creeping(live.id, live.percent, now) : (shown?.percent ?? 0))));
  // A folder an older Edit stopped as over a case's limits: its recordings to choose, all ticked, in place of the steps (nothing has come down yet).
  const tooMuch = stopped?.decision?.kind === "too_much" ? stopped.decision : null;
  return (
    <Modal open={id !== null} onClose={onClose} width={560}>
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="truncate text-[17px] font-semibold tracking-[-0.2px]">{shown?.title || "Importing"}</h2>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted">
            {stopped ? (
              <>
                <StartedBy by={stopped.createdBy} size={20} className="shrink-0" />
                {tooMuch ? "Choose the recordings to bring in." : `Stopped ${stageWords(stopped.stage)}. It waits here until it's answered.`}
              </>
            ) : done ? (
              "The footage is in."
            ) : (
              "Getting the footage ready. It keeps going if you close this."
            )}
          </p>
        </div>
        {tooMuch && stopped ? (
          <ChooseRecordings key={stopped.id} decision={tooMuch} onClose={onClose} onChoose={(ids) => answerIssue(stopped, { kind: "select", ids })} />
        ) : (
          <>
            <div>
              <div className="flex items-baseline gap-3">
                <span className="text-[28px] font-semibold tabular">{percent}%</span>
                <span className="truncate text-[13px] text-muted">{done ? "Ready" : stopped ? "Stopped" : shown?.detail || "Starting…"}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
                <div className={cx("h-full rounded-full transition-[width] duration-500", stopped ? "bg-warning" : "bg-info")} style={{ width: `${percent}%` }} />
              </div>
            </div>
            <ol className="flex flex-col gap-1">
              {STEPS.map((candidate, index) => {
                const state = index < at ? "done" : index === at ? "now" : "later";
                return (
                  <li key={candidate.key} className={cx("flex items-start gap-3 rounded-lg px-3 py-2", state === "now" && "bg-raised")}>
                    <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", state === "done" ? "bg-success" : state === "now" ? (stopped ? "bg-warning" : "animate-pulse bg-info") : "border border-line-strong")} />
                    <div className="min-w-0 flex-1">
                      <div className={cx("text-[13px] font-medium", state === "later" ? "text-muted" : "text-fg")}>{candidate.label}</div>
                      <div className={cx("text-[12px]", state === "now" && stopped ? "whitespace-normal text-warning" : "truncate text-muted")}>{state === "now" && why ? why : state === "now" && shown?.detail ? shown.detail : candidate.hint}</div>
                    </div>
                    <span className="shrink-0 text-[12px] text-faint tabular">{state === "now" && !stopped && began[candidate.key] ? elapsed(now - began[candidate.key]!) : state === "done" ? "Done" : ""}</span>
                  </li>
                );
              })}
            </ol>
            {/* One row: Close, and only what fits where it is (stopped: Replace and Retry; in: Open the script). */}
            <div className="flex items-center gap-2">
              <span className="mr-auto text-[12px] text-faint" title={stopped?.retryHelps === false ? NEEDS_A_FIX : undefined}>
                {began.start && !stopped && !done ? `Running for ${elapsed(now - began.start)}` : stopped?.retryHelps === false ? "Needs a fix in Edit before Retry." : ""}
              </span>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {stopped ? (
                <IssueActions issue={stopped} />
              ) : (
                done &&
          // The person's own change from Home: not Changed for them.
          markSeen(`edit:${project.id}`);
                id !== null && (
                  <Button variant="primary" onClick={() => navigate(`/scripts/${id}`)}>
                    Open the script
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** A project on this Mac: its name, what's worth a word about it, and its ⋯. */
function TableRow({ subtitled, script = null, fresh, ...props }: CardProps & { subtitled: boolean; script?: WriterScriptRow | null; fresh: Fresh }) {
  const { project, onChanged, remote, state } = props;
  const card = useProject(project, onChanged, props.cloudOn, props.status, remote, script?.id ?? null);
  const marked = useDoneRow(doneKey("edit", project.id), project.name);
  const note = useNote(
    project.note,
    project.name,
    project.problem
      ? null
      : async (text) => {
          const live = await api.project(project.id);
          await api.saveProject(project.id, live.rev, { ...live.project, note: text === "" ? undefined : text }, clientId);
          onChanged();
        },
  );
  const items = withDone(withNote(card.items, note.items), marked.items);
  return (
    <>
      <div
        role="row"
        onClick={() => card.open()}
        onContextMenu={contextMenu(items, 190)}
        className={cx(COLUMNS, ROW)}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <KindMark kind={project.subtitles ? "subtitles" : "edit"} />
        <Category style={project.style} compilation={script?.compilation} channel={project.channel} />
          {card.nameInput ?? (
            <span className={NAME} title={project.problem ?? project.name}>
              {project.name}
            </span>
          )}
          {project.dev === true && <TestBadge />}
          {card.nameInput === null && note.mark}
        </div>
        <StatusCell>
          {marked.entry ? (
            <DoneStatus entry={marked.entry} />
          ) : (
            <>
              {/* New or Changed for this person, where its files are when that's news, then its one status: what's wrong with it, else what's going on. */}
              <FreshMark fresh={fresh} />
              <Place sync={card.cloudNews ? card.status : undefined} />
              {card.notice ? <Notice {...card.notice} /> : <StateChips state={state} projectId={project.id} onChanged={onChanged} editor={card.editor} />}
              {card.drive ? (
                <button onClick={card.driveMenu} title={`On Drive: ${card.drive.name}`} className={cx(CHIP, "text-success hover:bg-hover")}>
                  On Drive ↗
                </button>
              ) : (
                subtitled && <span className="shrink-0 text-[12px] text-faint">Not uploaded</span>
              )}
            </>
          )}
        </StatusCell>
        <CreatorCell by={remote?.created_by ?? project.created_by} projectId={project.id} />
        <LengthCell>{project.problem ? "" : shortDuration(project.duration_frames / project.fps)}</LengthCell>
        <Updated at={project.modified_ms} />
        <RowButtons extra={marked.button} items={items} width={190} />
      </div>
      changedHere();
      {card.dialogs}
      {note.dialog}
    </>
  );
}

/** A footage script's kinds as Home's Category names them. */
const KIND_LABEL: Record<Kind, string> = { interrogation: "Interrogation", foia: "Bodycam", courtroom: "Courtroom" };

/** The kind a script's Category stands for (as writer_handoff's styleOf, turned round); a commentary has none. */
const kindOfStyle = (style: Style | null): Kind | null => (style === "bodycam" ? "foia" : style === "interrogation" || style === "courtroom" ? style : null);

/** A script with no edit yet: opening it opens the script; once written, Start the edit makes its video project. */
function ScriptTableRow({ script, importing, writing, sharing, here, fresh, onChanged, onImport }: { script: WriterScriptRow; importing?: Importing; writing: boolean; sharing: boolean; here: boolean; fresh: Fresh; onChanged: () => void; onImport?: () => void }) {
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const failed = script.runFailed ?? null;
  // Its category, changed (JJ, Nov 5: a compilation started as Bodycam was Interrogation): the kinds this person writes, a commentary none.
  const grants = useGrants();
  const current = kindOfStyle(script.style);
  const kinds = script.compilation ? grants.compilationKinds : grants.singleKinds;
          changedHere();
  const recategorize = async (kind: Kind) => {
    if (kind === current) return;
    try {
      const writer = await import("../writer/api");
      await writer.setScriptKind(script.id, kind);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `change the category of “${script.title}”`);
    }
  };
  const categoryItem: MenuItem[] =
    // A channel's script has no category: it's written from what the channel was taught.
    current !== null && kinds.length > 1 && !script.channel
      ? [{ label: "Category", icon: <Tag size={14} />, submenu: kinds.map((kind) => ({ label: KIND_LABEL[kind], checked: kind === current, onSelect: () => void recategorize(kind) })) }]
      : [];
  // Its ⋯ (and right click), as an edit's: open it, and (when this Mac has it) rename or delete it; Done's too.
  const marked = useDoneRow(doneKey("script", script.id), script.title || "Untitled script");
  // The person's own change from Home: not Changed for them.
  const changedHere = () => markSeen(`script:${script.id}`);
  // Its note, left from here when this Mac has the script (even while it imports).
  const note = useNote(
    script.note,
    script.title || "Untitled script",
    here
      ? async (text) => {
          const writer = await import("../writer/api");
          await writer.setScriptNote(script.id, text);
      changedHere();
          onChanged();
        }
      : null,
  );
  const items = withDone(
    [
      { label: "Open script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) },
      ...(failed !== null ? ([{ label: "Run again", icon: <RotateCw size={14} />, onSelect: () => void write() }] satisfies MenuItem[]) : []),
      ...(here
        ? ([
            { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(script.title) },
            ...note.items,
            ...categoryItem,
            { separator: true },
            { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
          ] satisfies MenuItem[])
        : []),
    ],
    marked.items,
  );
  const rename = async () => {
    const title = renaming?.trim() ?? "";
    setRenaming(null);
    if (title === "" || title === script.title) return;
    try {
      const writer = await import("../writer/api");
      await writer.renameScript(script.id, title);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `rename “${script.title}”`);
    }
  };
  const remove = async () => {
    setDeleting(false);
    try {
      const writer = await import("../writer/api");
      await writer.deleteScript(script.id);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${script.title}”`);
    }
  };
  // Ready to script: Claude writes it (as the script page's Build the script does), followed on its page.
  const write = async (event?: React.MouseEvent) => {
    event?.stopPropagation();
    setStarting(true);
    try {
      const writer = await import("../writer/api");
      await writer.startBuild(script.id, "");
      navigate(`/scripts/${script.id}`);
    } catch (error) {
      // A channel taught nothing waits on its page for the person to say what to write (the server's scripting.ts UNTAUGHT).
      if (script.channel && error instanceof Error && error.message.includes("aren't taught yet")) navigate(`/scripts/${script.id}`);
      else useEditor.getState().toastError(error, `write “${script.title}”`);
    } finally {
      setStarting(false);
    }
  };
  const start = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setStarting(true);
    try {
      const { project } = await api.importWriter(script.id);
      onChanged();
      navigate(`/p/${project}`);
    } catch (error) {
      useEditor.getState().toastError(error, `start the edit of “${script.title}”`);
    } finally {
      setStarting(false);
    }
  };
  return (
    <>
    <div
      role="row"
      onMouseEnter={() => !onImport && prefetchScript(script.id)}
      onClick={() => {
        if (onImport) onImport();
        else navigate(`/scripts/${script.id}`);
      }}
      onContextMenu={contextMenu(items, 180)}
      className={cx(COLUMNS, ROW)}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <KindMark kind="script" />
        <span className={NAME} title={script.title}>
          {script.title || "Untitled script"}
        </span>
        {script.test === true && <TestBadge />}
        {note.mark}
      </div>
      <StatusCell>
        {!marked.entry && <FreshMark fresh={fresh} />}
        {marked.entry ? (
          <DoneStatus entry={marked.entry} />
        ) : importing && !importing.stopped && importing.percent !== undefined ? (
          // Importing: how far (the step in its tooltip; its row opens the import).
          <span className={cx(CHIP, "w-32 text-info tabular")} title={importing.step}>
            <span className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-line-strong">
              <span className="block h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(100, importing.percent)))}%` }} />
            </span>
            {Math.floor(Math.max(0, Math.min(100, importing.percent)))}%
          </span>
        ) : importing ? (
          <span className={cx(CHIP, "tabular", importing.stopped ? "text-warning" : "text-info")}>
            {importing.stopped ? <TriangleAlert size={12} className="shrink-0" /> : <Pulse size={12} />}
      <Category style={script.style} compilation={script.compilation} channel={script.channel} />
            <span className="truncate">{importing.word}</span>
          </span>
        ) : writing ? (
          <span className={cx(CHIP, "text-info")}>
            <Pulse size={12} />
            Writing
          </span>
        ) : sharing ? (
          // Shared for review on its own, as an edit's share is (JJ, Nov 1): other scripts can be shared meanwhile.
          <span className={cx(CHIP, "text-info")} title="Its footage is going up to the review link">
            <Pulse size={12} />
            Sharing
          </span>
        ) : failed !== null ? (
          // Its last run failed: said in orange, and a click runs it again (why, plainly, in its tooltip).
          <button disabled={starting} title={`${explain(failed.error, "finish the script").title}. Click to run it again.`} onClick={(event) => void write(event)} className={cx(CHIP, "cursor-pointer text-warning transition-colors hover:bg-hover disabled:opacity-60")}>
            <RotateCw size={12} />
            {starting ? "Starting…" : "Run failed"}
          </button>
        ) : (
          // Its next step: the pill's shape, filled, so it reads as the button it is (the user, Oct 30: "these are ctas").
          <button disabled={starting} onClick={(event) => void (script.built ? start(event) : write(event))} className={cx(PILL, "cursor-pointer border-transparent bg-fg font-semibold text-bg transition-colors hover:bg-white disabled:opacity-60")}>
            {script.built ? <Film size={12} /> : <PenLine size={12} />}
            {starting ? "Starting…" : script.built ? "Start edit" : "Write script"}
          </button>
        )}
      </StatusCell>
      <CreatorCell by={script.createdBy ?? undefined} />
      <LengthCell>{script.durationMs > 0 ? shortDuration(script.durationMs / 1000) : ""}</LengthCell>
      <Updated at={script.updatedAt} title={script.updatedBy ? `by ${script.updatedBy}` : undefined} />
      <RowButtons extra={marked.button} items={items} width={180} />
    </div>
      {note.dialog}
      <Modal open={renaming !== null} onClose={() => setRenaming(null)} width={420}>
        <form
          className="p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Rename script</h2>
          <input autoFocus value={renaming ?? ""} maxLength={180} onChange={(event) => setRenaming(event.target.value)} className="mt-4 h-9 w-full rounded-md border border-line bg-panel px-3 text-[14px] text-fg outline-none focus:border-line-strong" />
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" type="button" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!renaming?.trim() || renaming.trim() === script.title}>
              Rename
            </Button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${script.title}”?`}
        detail="The script, its transcript, preview and narration are deleted, for everyone on the team."
        confirm="Delete"
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudTableRow({ project, script = null, fresh, onChanged }: { project: CloudProject; script?: WriterScriptRow | null; fresh: Fresh; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const summary = project.summary ?? {};
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${project.name}”`);
    }
    onChanged();
  };
  const marked = useDoneRow(doneKey("edit", project.id), project.name);
  const items = withDone(
    [
      ...(script !== null ? ([{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) }] satisfies MenuItem[]) : []),
      { separator: true },
      { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
    ],
    marked.items,
  );
        <Category style={summary.style} compilation={script?.compilation} channel={summary.channel} />
  return (
    <>
      <div
        role="row"
        onClick={() => navigate(`/p/${project.id}`)}
        onContextMenu={contextMenu(items, 180)}
        className={cx(COLUMNS, ROW)}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <KindMark kind={summary.subtitles ? "subtitles" : "edit"} />
          <span className={NAME} title={project.name}>
            {project.name}
          </span>
          {summary.dev === true && <TestBadge />}
          <NoteMark note={summary.note} />
        </div>
        <StatusCell>
          {/* Only what needs you (Sphe, Nov 18): not being here yet isn't news, opening it brings it. */}
          {marked.entry ? (
            <DoneStatus entry={marked.entry} />
          ) : (
            <>
              <FreshMark fresh={fresh} />
              {project.holder && <StateChips editor={project.holder} />}
            </>
          )}
        </StatusCell>
        <CreatorCell by={project.created_by} projectId={project.id} />
        <LengthCell>{seconds !== null ? shortDuration(seconds) : ""}</LengthCell>
        <Updated at={project.updated_ms} title={`by ${project.updated_by}`} />
        <RowButtons extra={marked.button} items={items} width={180} />
      </div>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${project.name}”?`}
        detail={`It’s deleted from the cloud, for everyone on the team. It isn’t on ${THIS_MACHINE}, so no copy is kept here.`}
        confirm="Delete everywhere"
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** A project out of step with the cloud, said in its status: changes not synced yet; nothing when it's in sync (most projects, so no mark). */
export function Place({ sync }: { sync?: CloudStatus }) {
  const trouble = sync?.dirty || sync?.sync === "offline" ? ([CloudOff, "Not synced", `Changes saved on ${THIS_MACHINE} haven’t reached the cloud yet.`] as const) : null;
  if (trouble === null) return null;
  const [Icon, text, title] = trouble;
  return (
    <span title={title} className={cx(CHIP, "text-warning")}>
      <Icon size={12} />
      {text}
    </span>
  );
}

type Preview = Awaited<ReturnType<typeof api.scriptPreview>>;

/** What a paste holds: script Docs, videos, Trello cards. */
const DOC = /docs\.google\.com\/document\//i;
const TRELLO = /trello\.com\/c\//i;
const DRIVE = /drive\.google\.com/i;
const LINK = /https?:\/\/\S+/gi;

/** Script mode's kinds for Edit's styles (bodycam is a FOIA script there); shorts have none, commentary is its own. */
const WRITER_KIND: Partial<Record<Style, "foia" | "interrogation" | "courtroom">> = { bodycam: "foia", interrogation: "interrogation", courtroom: "courtroom" };

/** One source of a script to write, as Script mode checked it: a video or a reused case. */
type Source = { url: string; title: string; durationMs: number | null; reuse: boolean; earlier?: string; problem: string | null; warning?: string | null; again?: boolean };

/**
 * New edit and New script (Nov 14, the one New dialog's frame: NewWork.tsx),
 * each opened from its own section and staying that kind. A script takes the
 * footage (a Trello card opens into its videos, a reused case is ticked when
 * it's recognised), its title from the card or the video. An edit starts from
 * a script written in Edit, searched (Sphe, Nov 14: "we should probably favor
 * picking from in-app scripts"; prod since Nov 4: 26 of the 30 newest edits
 * were), or from a pasted Doc, or blank for the agent's chat. The import runs
 * on Home, then the script or edit workflow starts by itself (the user, Oct 30).
 */
export function NewProject({ work, open, onClose, start = null }: { work: "edit" | "script"; open: boolean; onClose: () => void; start?: NewProjectStart | null }) {
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const grants = useGrants();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("bodycam");
  const [picked, setPicked] = useState(false);
  const v2 = useBeta((beta) => beta.v2);
  const [prompt, setPrompt] = useState("");
  // A channel: with V2 on, every edit and script is made for one, and no niche is picked (Sphe, Nov 16); V1 picks the
  // niche (today's kinds) and never sees channels. Whether it's a compilation: the channel's unless changed here.
  const channels = useChannels((state) => state.channels);
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [compilation, setCompilation] = useState<boolean | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  /** Several videos: one case or a compilation, as the person said (null: not yet). */
  const [shape, setShape] = useState<Shape | null>(null);
  const [reading, setReading] = useState(false);
  /** What each footage line was found to be, while the dialog is open: a line checked once isn't checked again. */
  const checkedLines = useRef(new Map<string, Source[]>());
  /** Reuse ticked or unticked by hand, by link: kept when the list is shown again. */
  const ticked = useRef(new Map<string, boolean>());
  const [preview, setPreview] = useState<{ url: string; result?: Preview; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /**
   * The project already made, whose first message didn't go: trying again
   * sends only that (never a second project), then does what was left
   * (`open` it, or say its import is under way).
   */
  const [made, setMade] = useState<{ project: string; message: string; then: "open" | "importing" } | null>(null);
  const toast = useEditor((state) => state.toast);

  const input = text.trim();
  const links = input.match(LINK) ?? [];
  const writing = work === "script";
  // An edit: from a script written in Edit (searched), or a pasted Doc.
  const [from, setFrom] = useState<"list" | "paste">("list");
  const [scripts, setScripts] = useState<WriterScriptRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [scriptId, setScriptId] = useState<string | null>(null);
  /** The title typed by hand: then it's never filled in from the footage. */
  const typedTitle = useRef(false);
  // With none ready to edit (the team's scripts read, none built), a pasted Doc is the way in.
  const anyScripts = scripts === null || scripts.some((one) => one.built && isListed(one));
  const listed = !writing && from === "list" && anyScripts;
  // Only the kinds this person may write or edit, as the server allows them.
  const writable = (style: Style): boolean => {
    if (style === "commentary") return grants.has(CAN.commentary);
    const kind = WRITER_KIND[style];
    return kind !== undefined && (grants.singleKinds.includes(kind) || grants.compilationKinds.includes(kind));
  };
  const styles = STYLES.filter((option) => (writing ? writable(option.value) : allowed === null || allowed.has(option.value)));
  const kind = styles.some((option) => option.value === style) ? style : (styles[0]?.value ?? "bodycam");
  // Scripts too (Sphe, Nov 14): an edit's, a script's, an idea's and a thumbnail's agent is taught its channel's lane.
  const channel = v2 ? (channels?.find((one) => one.key === channelKey) ?? null) : null;
  const unpicked = useChannelNeeded(channel?.key ?? null);
  // A channel's script is its footage's (its kind from the channel); a commentary is V1's alone (no channel makes them yet).
  const commentary = writing && channel === null && kind === "commentary";

  // A fresh dialog each time.
  useEffect(() => {
    if (!open) return;
    setTitle(start?.title ?? "");
    setText(start?.text ?? "");
    setPrompt("");
    setSources(null);
    setShape(null);
    checkedLines.current.clear();
    ticked.current.clear();
    setPreview(null);
    setError(null);
    setMade(null);
    setPicked(start !== null);
    setChannelKey(null);
    setCompilation(null);
    setFrom("list");
    setQuery("");
    setScriptId(null);
    typedTitle.current = start !== null;
    // A switch made in Settings on this computer is seen as the dialog opens.
    void loadBeta().catch(() => {});
    if (start !== null) setStyle(start.style);
  }, [open]);

  // An edit's scripts: the team's, read as the dialog opens.
  useEffect(() => {
    if (!open || writing) return;
    let alive = true;
    api.writerScripts().then(
      (answer) => alive && setScripts(answer.scripts),
      () => alive && setScripts([]),
    );
    return () => {
      alive = false;
    };
  }, [open, writing]);

  // The channels asked again as the dialog opens (one may have been added elsewhere).
  useEffect(() => {
    if (open && v2) void loadChannels();
  }, [open, v2]);

  // Writing: the paste read into its sources (a Trello card into its videos), each checked, reuses ticked.
  useEffect(() => {
    if (!writing || commentary || links.length === 0) {
      setSources(null);
      return;
    }
    let alive = true;
    setReading(true);
    const timer = setTimeout(async () => {
      try {
        const writer = await import("../writer/api");
        const lines: string[] = [];
        for (const line of input.split(/\n+/).map((one) => one.trim()).filter(Boolean)) {
          if (TRELLO.test(line)) {
            const card = await writer.trelloCard(line.match(LINK)?.[0] ?? line);
            if (alive && !typedTitle.current && card.name) setTitle(card.name);
            lines.push(...card.lines);
          } else lines.push(line);
        }
        // The links at once; what each is (YouTube takes a few seconds a video) as it comes. A line already checked in this
        // dialog keeps its answer, so taking a link out (or adding one) checks only what's new (Nov 8, Marius: "it would be
        // good if it doesn't have to recheck all just because you remove one link").
        const known = checkedLines.current;
        const linked = lines.filter((line) => line.match(LINK) !== null);
        const shown = () =>
          linked
            .flatMap((line) => known.get(line) ?? (line.match(LINK) ?? []).map((url): Source => ({ url, title: "", durationMs: null, reuse: /^REUSE\b/i.test(line), problem: null, again: true })))
            .map((one) => ({ ...one, reuse: ticked.current.get(one.url) ?? one.reuse }));
        if (alive) setSources(shown());
        const fresh = linked.filter((line) => !known.has(line));
        // Four lines asked about at once, each on its own so its answer is its line's.
        let next = 0;
        const lane = async () => {
          for (let at = next++; at < fresh.length && alive; at = next++) {
            const line = fresh[at]!;
            let checked = await writer.checkVideos([line]);
            // A link YouTube didn't answer for (slow, or a sign-in asked) is asked once more before its row says so (Nov 6,
            // Marius: four of six links showed only their URL).
            if (checked.some((one) => one.title === "" && one.problem === null && one.warning !== null && /youtu/.test(one.url))) checked = await writer.checkVideos([line]).catch(() => checked);
            known.set(line, checked.map((one) => ({ url: one.url, title: one.title, durationMs: one.durationMs, reuse: one.reuse, ...(one.earlier ? { earlier: one.earlier } : {}), problem: one.problem, warning: one.warning })));
            if (alive) {
              const now = shown();
              setSources(now);
              // No title given or carded: the first video's own, to change (Sphe, Nov 14: the title comes from what's pasted).
              const first = now.find((one) => !one.reuse && one.title !== "");
              if (first !== undefined) setTitle((was) => (typedTitle.current || was.trim() !== "" ? was : first.title));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, fresh.length) }, lane));
        if (alive) setError(null);
      } catch (cause) {
        if (alive) setError((cause as Error).message);
      } finally {
        if (alive) setReading(false);
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [input, writing, commentary]);

  // Editing: the script's Doc read at once, its title and kind taken when none were given.
  useEffect(() => {
    if (writing || !hasImportLinks(input)) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview({ url: input });
    const timer = setTimeout(() => {
      api
        .scriptPreview(input)
        .then((result) => {
          if (!alive) return;
          setPreview({ url: input, result });
          if (title.trim() === "" && result.title) setTitle(result.title);
        })
        .catch((cause) => alive && setPreview({ url: input, error: (cause as Error).message }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [input, writing]);
  const named = preview?.result?.style;
  useEffect(() => {
    if (named && !picked && (allowed === null || allowed.has(named))) setStyle(named);
  }, [named, picked]);

  const footage = (sources ?? []).filter((one) => !one.reuse);
  const blocked = (sources ?? []).some((one) => one.problem !== null && !one.reuse);
  // Several videos make one case or a compilation (several.ts); one video alone is its case.
  const several = writing && !commentary && sources !== null && sources.length >= 2;
  // A channel's script has no kind, whoever narrates it (the server's formats.ts `taught`); several videos are one case or a compilation as the channel makes them.
  const writerKind = channel !== null ? undefined : WRITER_KIND[kind];
  const videos = shapeOf({
    kind: writerKind,
    reused: (sources ?? []).some((one) => one.reuse),
    title,
    picked: shape,
    may: channel !== null ? { single: grants.singleKinds.length > 0, compilation: grants.compilationKinds.length > 0 } : { single: writerKind !== undefined && grants.singleKinds.includes(writerKind), compilation: writerKind !== undefined && grants.compilationKinds.includes(writerKind) },
    channel,
  });
  const editDoc = !writing && links.some((link) => DOC.test(link));
  // The scripts an edit can start from: built, a person's, of the channel picked (or of none), the words searched.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const choosable = (scripts ?? [])
    .filter((one) => one.built && isListed(one) && (channel === null || !one.channel || one.channel === channel.key))
    .filter((one) => words.every((word) => one.title.toLowerCase().includes(word)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 60);
  const pickedScript = (scripts ?? []).find((one) => one.id === scriptId) ?? null;
  const ready = !unpicked && (listed ? pickedScript !== null : title.trim() !== "" &&
    (writing
      ? commentary
        ? links.length > 0
        : sources !== null && !reading && footage.length > 0 && !blocked
      : input === "" || (preview?.result !== undefined && (editDoc || links.length > 0))));

  /** The project's first message, then what's left: opened, or its import said to be under way. */
  const begin = async (project: string, message: string, then: "open" | "importing") => {
    try {
      await api.firstPrompt(project, message);
    } catch (refused) {
      setMade({ project, message, then });
      throw refused;
    }
    setMade(null);
    onClose();
    if (then === "open") navigate(`/p/${project}`);
    else toast(`“${title.trim()}”: importing its footage, then editing`, "info");
  };

  const create = async () => {
    if (busy || (!ready && made === null)) return;
    setBusy(true);
    setError(null);
    const extra = prompt.trim();
    try {
      if (made !== null) {
        // Made already: only its first message again, never a second project.
        await begin(made.project, made.message, made.then);
        return;
      }
      if (listed && pickedScript !== null) {
        // Already edited: its edit, rather than a second one.
        if (pickedScript.project !== null) {
          onClose();
          navigate(`/p/${pickedScript.project}`);
          return;
        }
        const { project } = await api.importWriter(pickedScript.id, channel !== null ? { channel: channel.key, ...(compilation !== null && compilation !== channel.compilation ? { compilation } : {}) } : {});
        // The edit workflow starts once its footage is in, as a pasted Doc's does.
        await begin(project, `Start the editing workflow.${extra ? `\n\n${extra}` : ""}`, "open");
        return;
      }
      if (writing) {
        const writer = await import("../writer/api");
        // The script workflow starts once the footage is in: the first message is its note.
        const work = commentary
          ? writer.createCommentary(title.trim(), links)
          : footage.length === 1 && footage.length === sources!.length
            ? DRIVE.test(footage[0]!.url)
              ? writer.importDrive(footage[0]!.url, undefined, title.trim(), writerKind, extra, channel?.key)
              : writer.importYoutube(footage[0]!.url, undefined, title.trim(), writerKind, extra, channel?.key)
            : writer.importCompilation(title.trim(), sources!.map((one) => (one.reuse ? ["REUSE", one.url, one.earlier].filter(Boolean).join(" ") : one.url)), videos.shape === "case", writerKind, extra, channel?.key);
        // The server answers once the script exists, or refuses (a bad link, no access, three imports running);
        // the import then runs on Home. It used to answer only when the whole import ended, so this guessed with a
        // 1.5 s timer and a busy Mac's refusal after it was lost (JJ, Nov 1: a compilation started twice, no row and
        // no error). A refusal now stays in this dialog.
        await work;
        onClose();
        toast(`“${title.trim()}”: importing its footage, then writing the script`, "info");
        return;
      }
      // A channel's edit is its channel's kind, which the server checks.
      if (channel === null && input !== "" && allowed !== null && !allowed.has(kind)) throw new Error("Your account can’t make full edits: an admin can give you an Edit style at accounts.spheceo.com.");
      const { project } = await api.createProject({
        name: title.trim(),
        style: kind,
        ...(channel !== null ? { channel: channel.key, ...(compilation !== null && compilation !== channel.compilation ? { compilation } : {}) } : {}),
        ...(kind === "shorts" && channel === null ? SHORTS_FORMAT : FORMAT),
      });
      if (input === "") {
        // A blank project: the first message, if there is one, goes to its agent at once (a V2 edit's footage comes in the chat).
        if (extra !== "") await begin(project.id, extra, "open");
        else {
          onClose();
          navigate(`/p/${project.id}`);
        }
        return;
      }
      try {
        await api.attachScript(project.id, input);
      } catch (refused) {
        // A script refused leaves no empty project behind (each try had made one more).
        await api.deleteProject(project.id).catch(() => undefined);
        throw refused;
      }
      // The edit workflow starts once the import is in, with what was added to it.
      await begin(project.id, `Start the editing workflow.${extra ? `\n\n${extra}` : ""}`, "importing");
    } catch (cause) {
      setError(cause ?? new Error("Can't reach Edit's server"));
    } finally {
      setBusy(false);
    }
  };

  const label = "mb-1.5 block text-[12px] font-medium text-muted";
  // Today's kinds (V1's niche).
  const kindBlock = (labelled: boolean) => (
        <div>
          {labelled && <span className={label}>Kind</span>}
          <div className="flex flex-wrap gap-1.5">
            {styles.map((option) => (
              <button
                type="button"
                key={option.value}
                title={STYLE_NOTES[option.value]}
                onClick={() => {
                  setStyle(option.value);
                  setPicked(true);
                }}
                className={cx(
                  "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors",
                  kind === option.value ? "border-line-strong bg-raised text-fg" : "border-line text-muted hover:text-fg",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
  );

  const pickChannel = (key: string | null) => {
    setChannelKey(key);
    setCompilation(null);
    // A script of another channel is no longer one of the list's.
    const chosenNow = (channels ?? []).find((one) => one.key === key) ?? null;
    if (chosenNow !== null && pickedScript?.channel && pickedScript.channel !== chosenNow.key) setScriptId(null);
  };
  // The script picked: its channel picked with it, when it has one and none is yet.
  const pickScript = (row: WriterScriptRow) => {
    setScriptId(row.id === scriptId ? null : row.id);
    if (row.id !== scriptId && channelKey === null && row.channel && (channels ?? []).some((one) => one.key === row.channel)) setChannelKey(row.channel);
  };
  // Compilation is a channel's edit's, set as the channel has it unless changed here.
  const compiles = !writing && channel !== null;
  const action = busy ? "Starting…" : made !== null ? "Try again" : writing ? "Write the script" : listed ? (pickedScript?.project ? "Open its edit" : "Start the edit") : input === "" ? "Create" : "Start the edit";

  const footageList = writing && !commentary && (reading || sources !== null) && (
    <div className="mt-2 max-h-[220px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
      {reading && (sources === null || sources.length === 0) ? (
        <div className="shimmer px-3 py-2 text-[12px] text-muted">Reading the footage…</div>
      ) : (
        (sources ?? []).map((one, index) => (
          <div key={`${one.url}-${index}`} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg" title={one.url}>
                {one.title || one.url}
              </span>
              {(reading || one.again) && one.title === "" && one.problem === null && <span className="shimmer block text-faint">Checking…</span>}
              {one.problem !== null && <span className="block truncate text-danger">{one.problem}</span>}
              {one.problem === null && !one.again && one.warning && <span className="block truncate text-faint" title={one.warning}>{one.warning}</span>}
            </span>
            {one.durationMs !== null && <span className="shrink-0 text-faint tabular">{shortDuration(one.durationMs / 1000)}</span>}
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted" title="A case the channel already covered: put in as it was, not written again">
              <input
                type="checkbox"
                checked={one.reuse}
                onChange={(event) => {
                  ticked.current.set(one.url, event.target.checked);
                  setSources((all) => (all ?? []).map((other, at) => (at === index ? { ...other, reuse: event.target.checked } : other)));
                }}
              />
              Reuse
            </label>
          </div>
        ))
      )}
    </div>
  );

  const pasteBox = (
    <textarea
      rows={3}
      autoFocus={writing}
      value={text}
      placeholder={
        writing
          ? commentary
            ? "Paste the sources: videos, articles, posts. The first is the brief."
            : "Paste the footage: YouTube or Drive videos, or a Trello card. A case the channel already covered goes in as a reuse."
          : v2
            ? "Paste the script’s Google Doc, or leave this empty to start blank and send the footage in the chat."
            : NARRATION[kind] === "recording"
              ? "Paste the script’s Google Doc, or all its text (copied from the Doc, links and all), and “Voice-over:” with the recording’s Drive link."
              : "Paste the script’s Google Doc, or all its text (copied from the Doc, links and all). A finished video added under it goes in whole, as a reuse."
      }
      onChange={(event) => setText(event.target.value)}
      onPaste={(event) => {
        const plain = event.clipboardData.getData("text/plain");
        const pasted = importPaste(event.clipboardData.getData("text/html"), plain);
        if (pasted === plain) return;
        event.preventDefault();
        const node = event.currentTarget;
        setText(text.slice(0, node.selectionStart) + pasted + text.slice(node.selectionEnd));
      }}
      className={AREA}
    />
  );

  const titleField = (
    <Field label="Title" hint={writing && !typedTitle.current && title !== "" ? "from the footage" : undefined}>
      <input
        autoFocus={!writing}
        value={title}
        onChange={(event) => {
          typedTitle.current = true;
          setTitle(event.target.value);
        }}
        placeholder="What the video is called"
        className={FIELD}
      />
    </Field>
  );

  return (
    <NewShell
      kind={work}
      open={open}
      onClose={onClose}
      onSubmit={() => void create()}
      ready={(ready || made !== null) && !busy}
      busy={busy}
      action={action}
      error={
        <>
          {error !== null && <ProblemView error={error} doing={made !== null ? "start the agent on the new project" : writing ? "start the script" : "make the project"} className="pt-3" />}
          {error === null && blocked && !reading && <p className="pt-3 text-[12px] text-muted">Take out the video that can’t be imported, or tick it as a reuse.</p>}
        </>
      }
      aside={
        writing || scripts === null || !anyScripts ? undefined : listed ? (
          <Aside onClick={() => setFrom("paste")}>Paste a Doc instead</Aside>
        ) : (
          <Aside onClick={() => setFrom("list")}>Pick a script instead</Aside>
        )
      }
    >
      <ChannelField
        kind={work}
        channels={channels ?? []}
        value={channelKey}
        onChange={pickChannel}
        // An edit from a script is the script's kind: today's kinds are a pasted Doc's or a script's to write.
        other={listed ? undefined : kindBlock(false)}
      />

      {listed ? (
        <Field label="Script" hint={channel !== null ? `${channel.title}’s, newest first` : "ready to edit, newest first"}>
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-black px-3 text-muted transition-colors focus-within:border-muted">
            <Search size={13} className="shrink-0" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the scripts" className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint" />
          </label>
          <div className="mt-1.5 max-h-[248px] overflow-y-auto rounded-lg border border-line">
            {scripts === null ? (
              <div className="shimmer px-3 py-2.5 text-[12px] text-muted">Reading the scripts…</div>
            ) : choosable.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">{words.length > 0 ? "No script by that name." : `None of ${channel?.title ?? "the team"}’s scripts are ready to edit yet.`}</div>
            ) : (
              choosable.map((one) => {
                const on = one.id === scriptId;
                const owner = one.channel ? (channels ?? []).find((each) => each.key === one.channel) : undefined;
                return (
                  <button
                    type="button"
                    key={one.id}
                    onClick={() => pickScript(one)}
                    aria-pressed={on}
                    className={cx("flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors last:border-b-0", on ? "bg-active" : "hover:bg-hover")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">{one.title}</span>
                      <span className="block truncate text-[11.5px] text-faint">
                        {[one.style ? (STYLES.find((each) => each.value === one.style)?.label ?? one.style) : null, one.compilation ? "compilation" : null, one.durationMs > 0 ? shortDuration(one.durationMs / 1000) : null, ago(one.updatedAt), one.createdBy?.name?.split(" ")[0] ?? null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {one.project !== null && <span className="shrink-0 rounded-md bg-active px-1.5 py-0.5 text-[11px] text-muted">Has an edit</span>}
                    {owner !== undefined && channel === null && <ChannelAvatar channel={owner} size={18} />}
                    <span className={cx("flex size-4 shrink-0 items-center justify-center rounded-full transition-colors", on ? "bg-fg text-bg" : "text-transparent")}>
                      <Check size={11} strokeWidth={3} />
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Field>
      ) : writing ? (
        <>
          <Field label={commentary ? "Sources" : "Footage"} hint={commentary ? "the first is the brief" : "YouTube, Drive or a Trello card"}>
            {pasteBox}
            {footageList}
            {several && channel === null && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {SHAPES.map(([value, name, makes]) => (
                  <button
                    type="button"
                    key={value}
                    disabled={videos.fixed !== null && videos.shape !== value}
                    title={videos.fixed !== null && videos.shape !== value ? videos.fixed : makes}
                    onClick={() => setShape(value)}
                    className={cx(
                      "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors",
                      videos.shape === value ? "border-fg bg-fg text-bg" : "border-line text-muted hover:text-fg",
                      "disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </Field>
          {titleField}
        </>
      ) : (
        <>
          {titleField}
          <Field label="Script" hint="a Google Doc, or empty to start blank">
            {pasteBox}
            {preview && (
              <div className="mt-1.5 text-[12px] text-muted">
                {preview.error ? (
                  <ProblemView error={preview.error} doing="read the script" className="whitespace-normal" />
                ) : preview.result ? (
                  <>
                    <span className="tabular">
                      {preview.result.title || "Untitled script"} · {preview.result.files} {preview.result.files === 1 ? "source" : "sources"} · {preview.result.narration} cut-ins
                      {preview.result.whole ? "" : ` · ${shortDuration(preview.result.seconds)}`}
                    </span>
                    {preview.result.finished?.map((one) => (
                      <span key={one} className="block truncate text-faint">
                        Reuse, whole: {one}
                      </span>
                    ))}
                    {preview.result.reused?.map((one) => (
                      <span key={one.doc} className="block truncate text-faint">
                        Reuse, as written: {one.title || "a linked script"}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="shimmer">Reading the script…</span>
                )}
              </div>
            )}
          </Field>
        </>
      )}

      <More names={compiles ? "compilation, first message" : "first message"} set={prompt !== "" || compilation !== null}>
        {compiles && channel !== null && (
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-[13px]">Compilation</span>
              <span className="block text-[12px] text-faint">{channel.title} {channel.compilation ? "makes compilations" : "makes one case a video"}; this one can differ</span>
            </span>
            <Switch checked={compilation ?? channel.compilation} onChange={setCompilation} />
          </label>
        )}
        <Field label="First message" hint="optional">
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={writing ? "Added to “Start the script workflow” once the footage is in" : listed || input !== "" ? "Added to “Start the editing workflow” once the footage is in" : "Sent to the agent as the project opens: the footage’s links, and what you want"}
            className={FIELD}
          />
        </Field>
      </More>
    </NewShell>
  );
}
