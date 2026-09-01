import { AiAction, Env, Status } from "./types";
import {
  countAccounts,
  getAccountById,
  listAccounts,
  reserveMultiple,
  totalStockValue,
  updateAccountStatus,
} from "./db";

export interface ActionResult {
  summary: string;
  data: unknown;
}

// Tenta achar a conta alvo de um update_status. A Groq pode mandar um
// account_id exato, ou (mais comum) um texto solto tirado do comando do
// usuário. Nunca deixamos a IA decidir sozinha: se não achar exatamente
// uma conta candidata (por id exato ou por game+username únicos), a
// operação é recusada e o usuário precisa ser mais específico.
async function resolveTargetAccountId(env: Env, hint: string): Promise<string | { ambiguous: string[] }> {
  const direct = await getAccountById(env, hint);
  if (direct) return direct.id;

  const candidates = await listAccounts(env, { search: hint }, 10);
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1) return { ambiguous: candidates.map((c) => `${c.id} (${c.game} / ${c.username})`) };

  throw new Error(`Não encontrei nenhuma conta correspondente a "${hint}".`);
}

export async function executeAction(env: Env, action: AiAction): Promise<ActionResult> {
  switch (action.action) {
    case "list_stock": {
      const rows = await listAccounts(env, {
        game: action.game,
        status: action.status,
        maxPrice: action.max_price,
      });
      const safe = rows.map(({ password_enc, ...rest }) => rest);
      return { summary: `${rows.length} conta(s) encontrada(s).`, data: safe };
    }

    case "count_accounts": {
      const total = await countAccounts(env, { game: action.game, status: action.status });
      const label = action.game ? `de ${action.game}` : "no total";
      return { summary: `Você tem ${total} conta(s) ${label}.`, data: { total } };
    }

    case "total_stock_value": {
      const total = await totalStockValue(env, { status: action.status });
      return { summary: `Valor total: R$ ${total.toFixed(2)}.`, data: { total } };
    }

    case "get_random_account": {
      const status: Status = action.status ?? "DISPONIVEL";
      const candidates = await listAccounts(env, { game: action.game, status, maxPrice: action.max_price }, 50);
      if (candidates.length === 0) {
        return { summary: "Nenhuma conta disponível com esses critérios.", data: null };
      }
      // embaralha para não sempre pegar a mesma quando há concorrência
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      const [reservedId] = await reserveMultiple(env, shuffled.map((c) => c.id), 1);
      if (!reservedId) {
        return { summary: "Todas as candidatas foram reservadas por outra requisição. Tente novamente.", data: null };
      }
      const account = await getAccountById(env, reservedId);
      const { password_enc, ...safe } = account!;
      return { summary: `Conta reservada: ${safe.game} (${safe.username}).`, data: safe };
    }

    case "get_multiple_accounts": {
      const status: Status = action.status ?? "DISPONIVEL";
      const quantity = action.quantity ?? 1;
      const candidates = await listAccounts(env, { game: action.game, status, maxPrice: action.max_price }, 100);
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      const reservedIds = await reserveMultiple(env, shuffled.map((c) => c.id), quantity);
      const accounts = await Promise.all(reservedIds.map((id) => getAccountById(env, id)));
      const safe = accounts.filter(Boolean).map((a) => {
        const { password_enc, ...rest } = a!;
        return rest;
      });
      return {
        summary: `${safe.length} de ${quantity} conta(s) reservada(s).`,
        data: safe,
      };
    }

    case "update_status": {
      if (!action.account_id) throw new Error("Comando não especificou qual conta alterar.");
      if (!action.new_status) throw new Error("Comando não especificou o novo status.");

      const resolved = await resolveTargetAccountId(env, action.account_id);
      if (typeof resolved !== "string") {
        return {
          summary: `Encontrei mais de uma conta parecida com "${action.account_id}". Especifique o ID exato: ${resolved.ambiguous.join(", ")}`,
          data: { ambiguous: resolved.ambiguous },
        };
      }

      const updated = await updateAccountStatus(env, resolved, action.new_status, "via comando de IA");
      if (!updated) throw new Error("Conta não encontrada.");
      const { password_enc, ...safe } = updated;
      return { summary: `Conta ${safe.id} marcada como ${safe.status}.`, data: safe };
    }

    default:
      throw new Error("Ação não implementada.");
  }
}
