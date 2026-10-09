// Клиент GitHub REST API для анкеты (D-030). Только fetch, без библиотек.
// Токен уходит исключительно на api.github.com (CSP страницы это закрепляет).
// Все методы бросают GitHubError со статусом — UI переводит его в слова.

export class GitHubError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
  }
}

/** base64 (с переносами, как отдаёт Contents API) → строка UTF-8; работает в браузере и Node. */
export function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

export function createClient({ token, fetchImpl = globalThis.fetch, apiBase = "https://api.github.com" }) {
  async function request(method, path, body) {
    const response = await fetchImpl(apiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = (data && data.message) || `HTTP ${response.status}`;
      throw new GitHubError(response.status, message, `${method} ${path}`);
    }
    return data;
  }

  const repo = (owner, name) => `/repos/${owner}/${name}`;

  /** null вместо исключения на 404 — «нет такого» для формы обычное состояние. */
  async function optional(promise) {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  return {
    request,
    user: () => request("GET", "/user"),
    repository: (owner, name) => optional(request("GET", repo(owner, name))),
    createFork: (owner, name) => request("POST", `${repo(owner, name)}/forks`, {}),
    mergeUpstream: (owner, name, branch) => request("POST", `${repo(owner, name)}/merge-upstream`, { branch }),
    branchHead: async (owner, name, branch) => {
      const data = await optional(request("GET", `${repo(owner, name)}/branches/${encodeURIComponent(branch)}`));
      return data ? { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha } : null;
    },
    /** Файл по пути на ref → { text, sha } или null, если его нет. */
    fileText: async (owner, name, path, ref) => {
      const data = await optional(
        request("GET", `${repo(owner, name)}/contents/${path}?ref=${encodeURIComponent(ref)}`),
      );
      if (!data || data.type !== "file") return null;
      return { text: decodeBase64Utf8(data.content), sha: data.sha };
    },
    /** Все пути дерева (рекурсивно) — чтобы найти content/texts/*.txt. */
    treePaths: async (owner, name, treeSha) => {
      const data = await request("GET", `${repo(owner, name)}/git/trees/${treeSha}?recursive=1`);
      return data.tree.filter((item) => item.type === "blob").map((item) => item.path);
    },
    createBlob: (owner, name, text) =>
      request("POST", `${repo(owner, name)}/git/blobs`, { content: text, encoding: "utf-8" }),
    createTree: (owner, name, baseTree, entries) =>
      request("POST", `${repo(owner, name)}/git/trees`, { base_tree: baseTree, tree: entries }),
    createCommit: (owner, name, message, tree, parents) =>
      request("POST", `${repo(owner, name)}/git/commits`, { message, tree, parents }),
    getRef: (owner, name, branch) => optional(request("GET", `${repo(owner, name)}/git/ref/heads/${branch}`)),
    createRef: (owner, name, branch, sha) =>
      request("POST", `${repo(owner, name)}/git/refs`, { ref: `refs/heads/${branch}`, sha }),
    updateRef: (owner, name, branch, sha, force = true) =>
      request("PATCH", `${repo(owner, name)}/git/refs/heads/${branch}`, { sha, force }),
    deleteRef: (owner, name, branch) => optional(request("DELETE", `${repo(owner, name)}/git/refs/heads/${branch}`)),
    /** base...head: { ahead_by, files: [{filename, status}] } */
    compare: (owner, name, base, head) =>
      request("GET", `${repo(owner, name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
    listBranches: async (owner, name) => {
      const data = await request("GET", `${repo(owner, name)}/branches?per_page=100`);
      return data.map((branch) => branch.name);
    },
    pulls: (owner, name, params) => {
      const query = new URLSearchParams(params).toString();
      return request("GET", `${repo(owner, name)}/pulls?${query}`);
    },
    createPull: (owner, name, body) => request("POST", `${repo(owner, name)}/pulls`, body),
    updatePull: (owner, name, number, body) => request("PATCH", `${repo(owner, name)}/pulls/${number}`, body),
  };
}

/** Понятное объяснение ошибки API для редактора. */
export function explainError(error) {
  if (!(error instanceof GitHubError)) return `Не удалось связаться с GitHub: ${error.message}`;
  switch (error.status) {
    case 401:
      return "GitHub не принял токен. Проверьте, что он скопирован целиком и не истёк.";
    case 403:
      return "GitHub отказал в доступе: у токена не хватает прав (нужен classic-токен с правом repo) или исчерпан лимит запросов — подождите минуту.";
    case 404:
      return "GitHub не нашёл репозиторий. Если это names99-content — проверьте, что приглашение принято и токен видит чужие репозитории (classic, право repo).";
    case 409:
      return "GitHub сообщил о конфликте. Обновите страницу и повторите отправку.";
    case 422:
      return `GitHub отверг запрос: ${error.message}`;
    default:
      return `GitHub ответил ошибкой ${error.status}: ${error.message}`;
  }
}
