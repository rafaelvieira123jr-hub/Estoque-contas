import { AccountRow, Env, Status } from "./types";
import { decryptSecret, encryptSecret } from "./crypto";

export function newAccountId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function logHistory(
  env: Env,
  accountId: string,
  action: string,
  previousStatus: string | null,
  newStatus: string | null,
  details?: string
) {
  await env.DB.prepare(
    `INSERT INTO stock_history (account_id, action, previous_status, new_status, details)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(accountId, action, previousStatus, newStatus, details ?? null)
    .run();
}

export interface StockFilters {
  game?: string;
  status?: Status;
  maxPrice?: number;
  search?: string;
}

export function buildFilterClause(f: StockFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (f.game) {
    clauses.push("LOWER(game) = LOWER(?)");
    params.push(f.game);
  }
  if (f.status) {
    clauses.push("status = ?");
    params.push(f.status);
  }
  if (typeof f.maxPrice === "number") {
    clauses.push("price <= ?");
    params.push(f.maxPrice);
  }
  if (f.search) {
    clauses.push("(LOWER(game) LIKE ? OR LOWER(username) LIKE ?)");
    const like = `%${f.search.toLowerCase()}%`;
    params.push(like, like);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export async function listAccounts(env: Env, filters: StockFilters, limit = 200): Promise<AccountRow[]> {
  const { where, params } = buildFilterClause(filters);
  const stmt = env.DB.prepare(
    `SELECT * FROM accounts ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...params, limit);
  const { results } = await stmt.all<AccountRow>();
  return results ?? [];
}

export async function countAccounts(env: Env, filters: StockFilters): Promise<number> {
  const { where, params } = buildFilterClause(filters);
  const stmt = env.DB.prepare(`SELECT COUNT(*) as c FROM accounts ${where}`).bind(...params);
  const row = await stmt.first<{ c: number }>();
  return row?.c ?? 0;
}

export async function totalStockValue(env: Env, filters: StockFilters): Promise<number> {
  const { where, params } = buildFilterClause(filters);
  const stmt = env.DB.prepare(`SELECT COALESCE(SUM(price),0) as total FROM accounts ${where}`).bind(...params);
  const row = await stmt.first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getAccountById(env: Env, id: string): Promise<AccountRow | null> {
  return env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
}

export async function createAccount(
  env: Env,
  data: {
    game: string;
    username: string;
    password: string;
    price: number;
    level?: string;
    contents?: string;
    notes?: string;
    status?: Status;
  }
): Promise<AccountRow> {
  const id = newAccountId();
  const encPassword = await encryptSecret(data.password, env.CRYPTO_KEY);
  const status = data.status ?? "DISPONIVEL";

  await env.DB.prepare(
    `INSERT INTO accounts (id, game, username, password_enc, price, status, level, contents, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, data.game, data.username, encPassword, data.price, status, data.level ?? null, data.contents ?? null, data.notes ?? null)
    .run();

  await logHistory(env, id, "CREATED", null, status);

  const row = await getAccountById(env, id);
  if (!row) throw new Error("Falha ao criar conta");
  return row;
}

// Reserva atômica: só muda o status se ele ainda estiver DISPONIVEL.
// Se `changes` vier 0, outra requisição já pegou essa conta.
export async function tryReserveAccount(env: Env, id: string, newStatus: Status = "RESERVADA"): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE accounts SET status = ?, updated_at = ? WHERE id = ? AND status = 'DISPONIVEL'`
  )
    .bind(newStatus, nowIso(), id)
    .run();
  const changed = (result.meta?.changes ?? 0) > 0;
  if (changed) {
    await logHistory(env, id, newStatus === "RESERVADA" ? "RESERVED" : "UPDATED", "DISPONIVEL", newStatus);
  }
  return changed;
}

// Tenta reservar N contas disponíveis de uma lista candidata, uma a uma,
// parando assim que atinge a quantidade. Cada reserva individual é atômica
// (condicionada a status = DISPONIVEL), então duas requisições concorrentes
// nunca conseguem reservar a mesma conta.
export async function reserveMultiple(env: Env, candidateIds: string[], quantity: number): Promise<string[]> {
  const reserved: string[] = [];
  for (const id of candidateIds) {
    if (reserved.length >= quantity) break;
    const ok = await tryReserveAccount(env, id, "RESERVADA");
    if (ok) reserved.push(id);
  }
  return reserved;
}

export async function updateAccountStatus(
  env: Env,
  id: string,
  newStatus: Status,
  details?: string
): Promise<AccountRow | null> {
  const current = await getAccountById(env, id);
  if (!current) return null;

  const soldAt = newStatus === "VENDIDA" ? nowIso() : current.sold_at;
  await env.DB.prepare(
    `UPDATE accounts SET status = ?, updated_at = ?, sold_at = ? WHERE id = ?`
  )
    .bind(newStatus, nowIso(), soldAt, id)
    .run();

  const actionName =
    newStatus === "VENDIDA" ? "SOLD" : newStatus === "BRINDE" ? "MARKED_GIFT" : "UPDATED";
  await logHistory(env, id, actionName, current.status, newStatus, details);

  return getAccountById(env, id);
}

export async function updateAccountFields(
  env: Env,
  id: string,
  fields: Partial<{
    game: string;
    username: string;
    password: string;
    price: number;
    level: string | null;
    contents: string | null;
    notes: string | null;
    status: Status;
  }>
): Promise<AccountRow | null> {
  const current = await getAccountById(env, id);
  if (!current) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.game !== undefined) { sets.push("game = ?"); params.push(fields.game); }
  if (fields.username !== undefined) { sets.push("username = ?"); params.push(fields.username); }
  if (fields.password !== undefined) {
    sets.push("password_enc = ?");
    params.push(await encryptSecret(fields.password, env.CRYPTO_KEY));
  }
  if (fields.price !== undefined) { sets.push("price = ?"); params.push(fields.price); }
  if (fields.level !== undefined) { sets.push("level = ?"); params.push(fields.level); }
  if (fields.contents !== undefined) { sets.push("contents = ?"); params.push(fields.contents); }
  if (fields.notes !== undefined) { sets.push("notes = ?"); params.push(fields.notes); }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
    if (fields.status === "VENDIDA") { sets.push("sold_at = ?"); params.push(nowIso()); }
  }

  if (sets.length === 0) return current;

  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);

  await env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();

  if (fields.status && fields.status !== current.status) {
    const actionName =
      fields.status === "VENDIDA" ? "SOLD" : fields.status === "BRINDE" ? "MARKED_GIFT" : "UPDATED";
    await logHistory(env, id, actionName, current.status, fields.status, "edição manual");
  } else {
    await logHistory(env, id, "UPDATED", current.status, current.status, "edição manual");
  }

  return getAccountById(env, id);
}

export async function deleteAccount(env: Env, id: string): Promise<boolean> {
  const current = await getAccountById(env, id);
  if (!current) return false;
  await env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();
  await logHistory(env, id, "DELETED", current.status, null);
  return true;
}

export async function revealPassword(env: Env, id: string): Promise<string | null> {
  const account = await getAccountById(env, id);
  if (!account) return null;
  await logHistory(env, id, "PASSWORD_VIEWED", account.status, account.status);
  return decryptSecret(account.password_enc, env.CRYPTO_KEY);
}

export async function getHistory(env: Env, limit = 100) {
  const { results } = await env.DB.prepare(
    `SELECT h.*, a.game, a.username
     FROM stock_history h
     LEFT JOIN accounts a ON a.id = h.account_id
     ORDER BY h.created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return results ?? [];
}

export async function logAiCommand(env: Env, inputText: string, parsedAction: unknown, resultSummary: string, success: boolean) {
  await env.DB.prepare(
    `INSERT INTO ai_commands (input_text, parsed_action, result_summary, success) VALUES (?, ?, ?, ?)`
  )
    .bind(inputText, JSON.stringify(parsedAction ?? null), resultSummary, success ? 1 : 0)
    .run();
}

export async function getAiCommandHistory(env: Env, limit = 30) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ai_commands ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return results ?? [];
}
