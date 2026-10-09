// Поток анкеты (D-030): подключение, поиск очереди, отправка. Без DOM —
// работает и в браузере, и в Node с фейковым fetch (тесты, демо-режим).
//
// Очередь (AC-6): одна ветка `edit/<login>-<метка>` и один PR; каждая
// отправка пересобирает файлы от свежего main (base + вся очередь), коммит с
// родителем = голова main, ветка переставляется принудительно, version.json
// = версия main + 1. Восстановление очереди (AC-7): разница ветки с её
// родительским коммитом — именно тем main, от которого её собрали, поэтому
// правки владельца в main после отправки в очередь не попадают.
import { createClient } from "./github.js";
import { PATHS, applyOps, buildSubmission, diffContent, mergeOps, parseContent } from "./content.js";
import { formatDateTime, parseQueueBody, queueBody, submissionTitle } from "./summary.js";
import { validateContent } from "./validate.js";

export const UPSTREAM = { owner: "Baudi2", name: "names99-content" };
export const EDITOR_URL = "https://baudi2.github.io/names99-site/editor/";
const FORK_WAIT_TRIES = 20;
const FORK_WAIT_MILLIS = 1500;

export class EditorError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "EditorError";
    this.code = code;
    this.details = details;
  }
}

const defaultSleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

/** Файлы контента на ref → { content, sha, treeSha }. */
export async function loadContent(client, repo, ref) {
  const head = await client.branchHead(repo.owner, repo.name, ref);
  if (!head) throw new EditorError("no-branch", ref);
  return loadContentAt(client, repo, head.sha, head.treeSha);
}

async function loadContentAt(client, repo, sha, treeSha) {
  const paths = await client.treePaths(repo.owner, repo.name, treeSha);
  const wanted = [
    PATHS.names,
    PATHS.chechen,
    PATHS.version,
    ...Object.values(PATHS.collections),
    ...paths.filter((path) => path.startsWith(PATHS.textsDir + "/") && path.endsWith(".txt")),
  ];
  const files = new Map();
  for (const path of wanted) {
    if (!paths.includes(path)) continue;
    const file = await client.fileText(repo.owner, repo.name, path, sha);
    if (file) files.set(path, file.text);
  }
  return { content: parseContent(files), sha, treeSha };
}

async function ensureFork(client, login, upstream, sleep) {
  const fork = { owner: login, name: upstream.name };
  let repo = await client.repository(fork.owner, fork.name);
  if (!repo) {
    await client.createFork(upstream.owner, upstream.name);
    for (let attempt = 0; attempt < FORK_WAIT_TRIES; attempt++) {
      await sleep(FORK_WAIT_MILLIS);
      repo = await client.repository(fork.owner, fork.name);
      if (repo && (await client.branchHead(fork.owner, fork.name, "main"))) break;
      repo = null;
    }
    if (!repo) throw new EditorError("fork-pending");
  }
  if (repo.fork === false && repo.parent === undefined && login !== upstream.owner) {
    // Одноимённый репозиторий, но не копия нашего — не трогаем.
    throw new EditorError("fork-foreign");
  }
  return fork;
}

async function syncFork(client, work) {
  try {
    await client.mergeUpstream(work.owner, work.name, "main");
  } catch (error) {
    if (error.status === 409) throw new EditorError("fork-conflict");
    throw error;
  }
}

/** Подключение: логин, доступ, fork, свежий main, очередь. */
export async function connect({ token, fetchImpl, upstream = UPSTREAM, sleep = defaultSleep }) {
  const client = createClient({ token, fetchImpl });
  const user = await client.user();
  const login = user.login;
  if (!(await client.repository(upstream.owner, upstream.name))) throw new EditorError("no-access");
  const isOwner = login === upstream.owner;
  const work = isOwner ? upstream : await ensureFork(client, login, upstream, sleep);
  if (!isOwner) await syncFork(client, work);
  const base = await loadContent(client, work, "main");
  const session = {
    client,
    login,
    upstream,
    work,
    isOwner,
    base: base.content,
    baseSha: base.sha,
    baseTreeSha: base.treeSha,
    queue: null,
  };
  session.queue = await detectQueue(session);
  return session;
}

/** Открытый PR редактора (или ветка edit/* впереди main) → очередь с операциями. */
export async function detectQueue(session) {
  const { client, login, upstream, work } = session;
  const open = await client.pulls(upstream.owner, upstream.name, { state: "open", per_page: 100 });
  const mine = open.filter(
    (pr) => pr.user?.login === login && pr.head?.ref?.startsWith("edit/") && pr.head?.repo?.owner?.login === work.owner,
  );
  let found = null;
  if (mine.length) {
    const pr = mine[0];
    found = { branch: pr.head.ref, prNumber: pr.number, prUrl: pr.html_url, submissions: parseQueueBody(pr.body) };
  } else {
    const branches = (await client.listBranches(work.owner, work.name))
      .filter((name) => name.startsWith(`edit/${login}-`))
      .sort()
      .reverse();
    for (const branch of branches) {
      const compared = await client.compare(work.owner, work.name, "main", branch);
      if (compared.ahead_by === 0) continue;
      // Ветка впереди main и без открытого PR: после squash-мержа или закрытия
      // без мержа она остаётся «впереди» — это не очередь, а хвост (L1b).
      const closed = await client.pulls(upstream.owner, upstream.name, {
        state: "closed",
        head: `${work.owner}:${branch}`,
        per_page: 1,
      });
      if (closed.length) {
        await client.deleteRef(work.owner, work.name, branch);
        continue;
      }
      found = { branch, prNumber: null, prUrl: null, submissions: [] };
      break;
    }
  }
  if (!found) return null;
  const head = await loadContent(client, work, found.branch);
  const commit = await client.request("GET", `/repos/${work.owner}/${work.name}/commits/${head.sha}`);
  const parentSha = commit.parents?.[0]?.sha;
  let parentContent = session.base;
  if (parentSha && parentSha !== session.baseSha) {
    const parent = await client.request("GET", `/repos/${work.owner}/${work.name}/git/commits/${parentSha}`);
    parentContent = (await loadContentAt(client, work, parentSha, parent.tree.sha)).content;
  }
  // Правки, которые уже ничего не меняют относительно свежего main, выпадают.
  const ops = diffContent(parentContent, head.content).filter((op) => diffContent(session.base, applyOps(session.base, [op])).length > 0);
  return { ...found, headSha: head.sha, ops };
}

/** Проверка будущего состояния: { errors, warnings } от base + очередь + черновик. */
export function check(session, draftOps) {
  const ops = mergeOps([...(session.queue?.ops || []), ...draftOps]);
  return validateContent(applyOps(session.base, ops));
}

/**
 * Отправка черновика: пересинхронизировать main, пересобрать файлы от него,
 * коммит, ветка, PR. Возвращает обновлённую очередь; черновик очищает вызывающий.
 */
export async function submit(session, draftOps, { now = () => new Date(), editorUrl = EDITOR_URL } = {}) {
  const { client, login, upstream, work, isOwner } = session;
  if (!draftOps.length) throw new EditorError("nothing");
  if (!isOwner) await syncFork(client, work);
  // Другая вкладка или устройство могли отправить раньше: голова ветки
  // очереди сдвинулась → перечитать очередь, иначе чужая отправка затрётся (L1b).
  if (!session.queue) {
    session.queue = await detectQueue(session);
  } else {
    const ref = await client.getRef(work.owner, work.name, session.queue.branch);
    if (!ref || ref.object.sha !== session.queue.headSha) session.queue = await detectQueue(session);
  }
  const fresh = await loadContent(client, work, "main");
  session.base = fresh.content;
  session.baseSha = fresh.sha;
  session.baseTreeSha = fresh.treeSha;

  const allOps = mergeOps([...(session.queue?.ops || []), ...draftOps]);
  const verdict = validateContent(applyOps(session.base, allOps));
  if (verdict.errors.length) throw new EditorError("invalid", verdict.errors);

  const submission = buildSubmission(session.base, allOps);
  const entries = [];
  for (const [path, text] of submission.files) {
    if (text === null) entries.push({ path, mode: "100644", type: "blob", sha: null });
    else {
      const blob = await client.createBlob(work.owner, work.name, text);
      entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
  }
  const title = submissionTitle(draftOps, session.base);
  const tree = await client.createTree(work.owner, work.name, session.baseTreeSha, entries);
  const message = `${title}\n\nОчередь правок от ${login} через анкету; версия ${submission.version}.`;
  const commit = await client.createCommit(work.owner, work.name, message, tree.sha, [session.baseSha]);

  const stamp = formatDateTime(now()).replace(/[- :]/g, "").slice(0, 12);
  const branch = session.queue?.branch || `edit/${login}-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
  if (await client.getRef(work.owner, work.name, branch)) {
    await client.updateRef(work.owner, work.name, branch, commit.sha, true);
  } else {
    await client.createRef(work.owner, work.name, branch, commit.sha);
  }

  const submissions = [...(session.queue?.submissions || []), { at: formatDateTime(now()), title }];
  const body = queueBody({ login, submissions, ops: submission.ops, base: session.base, editorUrl });
  let prNumber = session.queue?.prNumber ?? null;
  let prUrl = session.queue?.prUrl ?? null;
  if (prNumber) {
    await client.updatePull(upstream.owner, upstream.name, prNumber, { body });
  } else {
    const pr = await client.createPull(upstream.owner, upstream.name, {
      title: `Правки от ${login} (анкета, очередь)`,
      head: isOwner ? branch : `${login}:${branch}`,
      base: "main",
      body,
    });
    prNumber = pr.number;
    prUrl = pr.html_url;
  }
  session.queue = { branch, prNumber, prUrl, submissions, ops: submission.ops, headSha: commit.sha };
  return { queue: session.queue, title, version: submission.version, warnings: verdict.warnings };
}

/** Открытые очереди всех редакторов — для режима владельца. */
export async function listQueues(session) {
  const open = await session.client.pulls(session.upstream.owner, session.upstream.name, { state: "open", per_page: 100 });
  return open
    .filter((pr) => pr.head?.ref?.startsWith("edit/"))
    .map((pr) => ({ login: pr.user?.login, number: pr.number, url: pr.html_url, submissions: parseQueueBody(pr.body) }));
}
