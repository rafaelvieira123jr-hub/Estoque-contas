async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include",
  });

  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Sessão expirada.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erro desconhecido.");
  return data;
}

function money(v) {
  return `R$ ${Number(v || 0).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) +
    " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// Confere sessão em toda página protegida; redireciona pro login se falhar.
async function requireSession() {
  try {
    await api("/api/me");
  } catch {
    window.location.href = "/login.html";
  }
}
