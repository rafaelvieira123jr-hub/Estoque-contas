function renderNav(active) {
  const items = [
    { href: "/index.html", key: "dashboard", label: "Painel",
      icon: '<svg viewBox="0 0 24 24"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>' },
    { href: "/estoque.html", key: "estoque", label: "Estoque",
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="1"/><path d="M8 7V5a4 4 0 018 0v2"/></svg>' },
    { href: "/cadastro.html", key: "cadastro", label: "Cadastrar",
      icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>' },
    { href: "/ia.html", key: "ia", label: "IA",
      icon: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/></svg>' },
  ];

  const html = items
    .map(
      (item) => `<a href="${item.href}" class="${item.key === active ? "active" : ""}">${item.icon}<span>${item.label}</span></a>`
    )
    .join("");

  const el = document.getElementById("tabbar");
  if (el) el.innerHTML = html;
}
