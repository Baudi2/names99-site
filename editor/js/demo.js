// Фейковый GitHub для демо-режима (`?demo=1`) и тестов Node: те же
// эндпоинты, что зовёт github.js, поверх памяти. Ровно столько семантики,
// сколько нужно потоку анкеты: fork, merge-upstream, деревья/блобы/коммиты,
// ветки с force-update, compare, pulls. Плюс demo-действие «владелец
// смержил» — чтобы прогнать «после мержа очередь пуста».

const encodeBase64Utf8 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

let counter = 0;
const newSha = (prefix) => `${prefix}${String(++counter).padStart(6, "0")}${"0".repeat(40 - prefix.length - 6)}`;

export function createDemoFetch({ files, login = "demo-editor", upstream = { owner: "Baudi2", name: "names99-content" } }) {
  const blobs = new Map(); // sha → text
  const trees = new Map(); // sha → Map path → blobSha
  const commits = new Map(); // sha → { tree, parents, message }
  const repos = new Map(); // "owner/name" → { refs: Map branch → sha, fork }
  const pulls = [];
  let pullCounter = 0;

  function makeTree(entries) {
    const sha = newSha("t");
    trees.set(sha, new Map(entries));
    return sha;
  }
  function makeCommit(treeSha, parents, message) {
    const sha = newSha("c");
    commits.set(sha, { tree: treeSha, parents, message });
    return sha;
  }
  const initial = new Map();
  for (const [path, text] of files) {
    const sha = newSha("b");
    blobs.set(sha, text);
    initial.set(path, sha);
  }
  const root = makeCommit(makeTree(initial), [], "Bootstrap");
  const key = (owner, name) => `${owner}/${name}`;
  repos.set(key(upstream.owner, upstream.name), { refs: new Map([["main", root]]), fork: false });

  function ancestors(sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      stack.push(...(commits.get(current)?.parents || []));
    }
    return seen;
  }

  const json = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  const notFound = (what) => json(404, { message: `Not Found: ${what}` });

  const demo = async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers?.Authorization || "";
    if (!auth.startsWith("Bearer ")) return json(401, { message: "Bad credentials" });

    if (path === "/user") return json(200, { login });

    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) return notFound(path);
    const [, owner, name, restRaw] = repoMatch;
    const rest = restRaw || "";
    const repoKey = key(owner, name);
    const repo = repos.get(repoKey);

    if (rest === "" && method === "GET") {
      if (!repo) return notFound(repoKey);
      return json(200, {
        full_name: repoKey,
        fork: repo.fork,
        parent: repo.fork ? { full_name: key(upstream.owner, upstream.name) } : undefined,
        owner: { login: owner },
      });
    }
    if (rest === "/forks" && method === "POST") {
      const source = repos.get(key(upstream.owner, upstream.name));
      repos.set(key(login, name), { refs: new Map(source.refs), fork: true });
      return json(202, { full_name: key(login, name) });
    }
    if (!repo) return notFound(repoKey);

    if (rest === "/merge-upstream" && method === "POST") {
      const source = repos.get(key(upstream.owner, upstream.name));
      repo.refs.set(body.branch, source.refs.get(body.branch));
      return json(200, { message: "Successfully fetched and fast-forwarded", merge_type: "fast-forward" });
    }
    let match;
    if ((match = rest.match(/^\/branches\/(.+)$/)) && method === "GET") {
      const sha = repo.refs.get(match[1]);
      if (!sha) return notFound(match[1]);
      return json(200, { name: match[1], commit: { sha, commit: { tree: { sha: commits.get(sha).tree } } } });
    }
    if (rest === "/branches" && method === "GET") {
      return json(200, [...repo.refs.keys()].map((branch) => ({ name: branch })));
    }
    if ((match = rest.match(/^\/git\/trees\/([^?]+)$/)) && method === "GET") {
      const tree = trees.get(match[1]);
      if (!tree) return notFound(match[1]);
      return json(200, { sha: match[1], tree: [...tree.entries()].map(([p, sha]) => ({ path: p, type: "blob", sha })) });
    }
    if ((match = rest.match(/^\/contents\/(.+)$/)) && method === "GET") {
      const ref = parsed.searchParams.get("ref") || "main";
      const commitSha = repo.refs.get(ref) || (commits.has(ref) ? ref : null);
      if (!commitSha) return notFound(ref);
      const tree = trees.get(commits.get(commitSha).tree);
      const blobSha = tree.get(match[1]);
      if (!blobSha) return notFound(match[1]);
      return json(200, { type: "file", sha: blobSha, content: encodeBase64Utf8(blobs.get(blobSha)) });
    }
    if (rest === "/git/blobs" && method === "POST") {
      const sha = newSha("b");
      blobs.set(sha, body.content);
      return json(201, { sha });
    }
    if (rest === "/git/trees" && method === "POST") {
      const base = new Map(trees.get(body.base_tree) || []);
      for (const entry of body.tree) {
        if (entry.sha === null) base.delete(entry.path);
        else base.set(entry.path, entry.sha);
      }
      return json(201, { sha: makeTree(base) });
    }
    if (rest === "/git/commits" && method === "POST") {
      return json(201, { sha: makeCommit(body.tree, body.parents, body.message) });
    }
    if ((match = rest.match(/^\/git\/commits\/(.+)$/)) && method === "GET") {
      const commit = commits.get(match[1]);
      if (!commit) return notFound(match[1]);
      return json(200, { sha: match[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) });
    }
    if ((match = rest.match(/^\/commits\/(.+)$/)) && method === "GET") {
      const commit = commits.get(match[1]);
      if (!commit) return notFound(match[1]);
      return json(200, { sha: match[1], parents: commit.parents.map((sha) => ({ sha })) });
    }
    if ((match = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
      const sha = repo.refs.get(match[1]);
      return sha ? json(200, { ref: `refs/heads/${match[1]}`, object: { sha } }) : notFound(match[1]);
    }
    if (rest === "/git/refs" && method === "POST") {
      const branch = body.ref.replace("refs/heads/", "");
      if (repo.refs.has(branch)) return json(422, { message: "Reference already exists" });
      repo.refs.set(branch, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((match = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
      if (!repo.refs.has(match[1])) return notFound(match[1]);
      const current = repo.refs.get(match[1]);
      if (!body.force && !ancestors(body.sha).has(current)) return json(422, { message: "Update is not a fast forward" });
      repo.refs.set(match[1], body.sha);
      return json(200, { ref: `refs/heads/${match[1]}`, object: { sha: body.sha } });
    }
    if ((match = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "DELETE") {
      repo.refs.delete(match[1]);
      return { ok: true, status: 204, json: async () => null };
    }
    if ((match = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/)) && method === "GET") {
      const baseSha = repo.refs.get(match[1]);
      const headSha = repo.refs.get(match[2]);
      if (!baseSha || !headSha) return notFound(rest);
      const baseAncestors = ancestors(baseSha);
      const ahead = [...ancestors(headSha)].filter((sha) => !baseAncestors.has(sha)).length;
      const baseTree = trees.get(commits.get(baseSha).tree);
      const headTree = trees.get(commits.get(headSha).tree);
      const changed = [...new Set([...baseTree.keys(), ...headTree.keys()])].filter((p) => baseTree.get(p) !== headTree.get(p));
      return json(200, { ahead_by: ahead, files: changed.map((filename) => ({ filename })) });
    }
    if (rest === "/pulls" && method === "GET") {
      const state = parsed.searchParams.get("state") || "open";
      const head = parsed.searchParams.get("head");
      return json(
        200,
        pulls.filter(
          (pr) => (state === "all" || pr.state === state) && (!head || `${pr.head.repo.owner.login}:${pr.head.ref}` === head),
        ),
      );
    }
    if (rest === "/pulls" && method === "POST") {
      const [headOwner, headRef] = body.head.includes(":") ? body.head.split(":") : [owner, body.head];
      const pr = {
        number: ++pullCounter,
        state: "open",
        title: body.title,
        body: body.body,
        html_url: `https://github.com/${repoKey}/pull/${pullCounter}`,
        user: { login },
        head: { ref: headRef, repo: { owner: { login: headOwner } } },
        base: { ref: body.base },
      };
      pulls.push(pr);
      return json(201, pr);
    }
    if ((match = rest.match(/^\/pulls\/(\d+)$/)) && method === "PATCH") {
      const pr = pulls.find((item) => item.number === Number(match[1]));
      if (!pr) return notFound(rest);
      Object.assign(pr, body);
      return json(200, pr);
    }
    return notFound(`${method} ${path}`);
  };

  /**
   * Демо: владелец смержил PR. По умолчанию — squash, как в проекте: main получает
   * НОВЫЙ коммит с деревом ветки, ветка остаётся «впереди» (L1b); fast-forward — опцией.
   */
  demo.mergePull = (number, { squash = true } = {}) => {
    const pr = pulls.find((item) => item.number === number && item.state === "open");
    if (!pr) throw new Error(`no open pull ${number}`);
    const headRepo = repos.get(key(pr.head.repo.owner.login, upstream.name));
    const sha = headRepo.refs.get(pr.head.ref);
    const main = repos.get(key(upstream.owner, upstream.name)).refs;
    main.set("main", squash ? makeCommit(commits.get(sha).tree, [main.get("main")], `Squash ${pr.title}`) : sha);
    pr.state = "closed";
    pr.merged = true;
  };
  /** Демо: владелец закрыл PR без мержа. */
  demo.closePull = (number) => {
    const pr = pulls.find((item) => item.number === number && item.state === "open");
    if (!pr) throw new Error(`no open pull ${number}`);
    pr.state = "closed";
    pr.merged = false;
  };
  /** Демо: владелец сам поправил файл в main (для проверки «правка владельца не попадает в очередь»). */
  demo.ownerEdit = (path, text) => {
    const repo = repos.get(key(upstream.owner, upstream.name));
    const parent = repo.refs.get("main");
    const tree = new Map(trees.get(commits.get(parent).tree));
    const sha = newSha("b");
    blobs.set(sha, text);
    tree.set(path, sha);
    repo.refs.set("main", makeCommit(makeTree(tree), [parent], "Owner edit"));
  };
  demo.state = { repos, pulls, blobs, trees, commits };
  demo.fileAt = (owner, name, branch, path) => {
    const sha = repos.get(key(owner, name))?.refs.get(branch);
    if (!sha) return null;
    const blobSha = trees.get(commits.get(sha).tree).get(path);
    return blobSha ? blobs.get(blobSha) : null;
  };
  return demo;
}
