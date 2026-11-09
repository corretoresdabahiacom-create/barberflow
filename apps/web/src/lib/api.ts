import { getFirebaseAuth } from "./firebase";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface Opts { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> }

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth) {
    const user = getFirebaseAuth()?.currentUser;
    if (!user) throw new ApiError(401, "unauthenticated", "Faça login para continuar");
    headers.Authorization = `Bearer ${await user.getIdToken()}`;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw new ApiError(0, "network", "Sem conexão com o servidor. Verifique sua internet.");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Algo deu errado. Tente novamente.");
  return data as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : "Algo deu errado.");

export function newIdemKey(): string {
  return crypto.randomUUID();
}
