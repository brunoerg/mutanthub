/** "#L12" for one line, "#L12-L20" for a block, as on GitHub. */
export function lineHash(start: number, end?: number): string {
  return end && end > start ? `#L${start}-L${end}` : `#L${start}`;
}

/** Reads a line hash ("#L12", "#L12-L20", "#L12-20") back into a range. */
export function parseLineHash(hash: string): { start: number; end: number } | null {
  const match = hash.match(/^#L(\d+)(?:-L?(\d+))?/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { start, end: Math.max(start, end) };
}

/** Central place for building internal URLs so route changes stay in one file. */
export const routes = {
  home: () => "/",
  dashboard: () => "/dashboard",
  projects: () => "/projects",
  project: (owner: string, repo: string) => `/projects/${owner}/${repo}`,
  projectCode: (
    owner: string,
    repo: string,
    path?: string,
    opts?: { ref?: string; line?: number; endLine?: number; pr?: number },
  ) => {
    const base = `/projects/${owner}/${repo}/code${path ? `/${path}` : ""}`;
    const params = new URLSearchParams();
    if (opts?.ref) params.set("ref", opts.ref);
    if (opts?.pr) params.set("pr", String(opts.pr));
    const query = params.toString();
    const hash = opts?.line ? lineHash(opts.line, opts.endLine) : "";
    return `${base}${query ? `?${query}` : ""}${hash}`;
  },
  projectMutants: (owner: string, repo: string) => `/projects/${owner}/${repo}/mutants`,
  projectSettings: (owner: string, repo: string) => `/projects/${owner}/${repo}/settings`,
  projectPulls: (owner: string, repo: string) => `/projects/${owner}/${repo}/pulls`,
  projectImport: (owner: string, repo: string) => `/projects/${owner}/${repo}/import`,
  projectImportApi: (owner: string, repo: string) => `/api/projects/${owner}/${repo}/import`,
  projectPull: (owner: string, repo: string, number: number) =>
    `/projects/${owner}/${repo}/pulls/${number}`,
  projectRunRequests: (owner: string, repo: string, filter?: "closed" | "all") =>
    `/projects/${owner}/${repo}/requests${filter ? `?status=${filter}` : ""}`,
  projectRunRequest: (owner: string, repo: string, id: string) =>
    `/projects/${owner}/${repo}/requests/${id}`,
  mutants: () => "/mutants",
  mutant: (id: number) => `/mutants/${id}`,
  mutantEdit: (id: number) => `/mutants/${id}/edit`,
  review: () => "/review",
  reviewItem: (id: number) => `/review?selected=${id}`,
  user: (username: string) => `/users/${username}`,
  settings: () => "/settings",
  notifications: () => "/notifications",
  datasets: () => "/datasets",
  dataset: (slug: string) => `/datasets/${slug}`,
  exportMutants: (format: "json" | "csv", query = "") =>
    `/api/export/mutants.${format}${query ? `?${query}` : ""}`,
  snapshotDownload: (slug: string, format: "json" | "csv") =>
    `/api/datasets/${slug}/mutants.${format}`,
  mutantPatch: (id: number) => `/api/mutants/${id}/patch`,
  search: (q: string) => `/search?q=${encodeURIComponent(q)}`,
  signIn: (callbackUrl?: string) =>
    `/signin${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`,
  apiDocs: () => "/api/docs",
  github: {
    repo: (owner: string, repo: string) => `https://github.com/${owner}/${repo}`,
    commit: (owner: string, repo: string, sha: string) =>
      `https://github.com/${owner}/${repo}/commit/${sha}`,
    pull: (owner: string, repo: string, number: number) =>
      `https://github.com/${owner}/${repo}/pull/${number}`,
    file: (
      owner: string,
      repo: string,
      sha: string,
      path: string,
      line?: number,
      endLine?: number,
    ) =>
      `https://github.com/${owner}/${repo}/blob/${sha}/${path}${line ? lineHash(line, endLine) : ""}`,
    user: (username: string) => `https://github.com/${username}`,
  },
};
