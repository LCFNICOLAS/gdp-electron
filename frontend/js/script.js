 // Base API robuste (lecture tardive de window.API + fallbacks)
 const API =
   (typeof window !== "undefined" && window.API) ||
   (typeof window !== "undefined" && window.cfg && window.cfg.API_BASE) ||
   "https://api-tonnas.synology.me:8443";
 // expose aussi sur window pour les autres modules
if (typeof window !== "undefined") window.API = API;

// 🔐 TOKEN SÉCURITÉ
let APP_TOKEN = "";
window.APP_TOKEN = APP_TOKEN;  // rendu global

async function loadAppToken() {
    try {
        const res = await fetch("http://127.0.0.1:5000/token");
        const data = await res.json();
        APP_TOKEN = data.token;
        window.APP_TOKEN = APP_TOKEN;
        console.log("TOKEN FRONT =", APP_TOKEN);
    } catch (err) {
        console.error("Erreur récupération token :", err);
    }
}

// 🔁 on lance le chargement du token sans `await`
loadAppToken();

// optionnel : exposer la fonction si tu veux la rappeler ailleurs
if (typeof window !== "undefined") {
  window.loadAppToken = loadAppToken;
}

// 🔐 GET sécurisé
async function apiGet(url) {
  const res = await fetch(API + url, {
    method: "GET",
    headers: {
      "X-App-Token": window.APP_TOKEN || "",
      "Accept": "application/json"
    },
    cache: "no-store"
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

async function apiPost(url, body) {
    return fetch(API + url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-App-Token": window.APP_TOKEN
        },
        body: JSON.stringify(body)
    });
}

window.apiGet = apiGet;
window.apiPost = apiPost;

// === Helpers ===

const IDS_DONNEES = [
  // Dictionnaires “généraux”
  "STATUT", "STATUT_EPAPER", "EPAPER",
  "BORNE_DE_COMMANDE", "BATIMENT_MODULAIRE", "MARKETING",

  // RAL (utilisent la clé NOM_COLONNE="RAL")
  "RAL_BDC", "RAL_MODULE",

  // Ajoute ici les autres champs à options (exemples) :
  "TYPE_CONTRAT", "TYPE_CONNEXION", "MODE_PAIEMENT"
];

function formatEUR(val) {
  if (val === null || val === undefined) return "";
  let s = String(val).trim();
  if (!s) return "";

  // enlever espaces (y compris espace insécable), symbole €, etc.
  s = s.replace(/[\s\u202f€]/g, "");

  // si on n’a pas de point mais une virgule -> virgule = séparateur décimal
  if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  } else {
    // sinon, on considère les virgules comme séparateurs de milliers
    s = s.replace(/,/g, "");
  }

  const num = Number(s);
  if (!isFinite(num)) return "";

  return num.toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function badgeForStatus(s) {
  const v = String(s || '').toUpperCase().trim();
  let cls = 'badge-gray';

  if (v === 'EN ATTENTE' || v === 'EN ATTENTE - PRODUCTION') {
    cls = 'badge-yellow';
  } else if (v === 'EN PRODUCTION') {
    cls = 'badge-blue';
  } else if (v.includes('LIVR') || v === 'EN STOCK' || v.includes('TERMIN')) {
    // couvre LIVRE/LIVRÉ, EN STOCK, TERMINE/TERMINÉ
    cls = 'badge-green';
  } else if (v.includes('ANNUL') || v.includes('BLOC') || v.includes('KO')) {
    cls = 'badge-red';
  }

  return `<span class="badge ${cls}">${s ?? ''}</span>`;
}

// === Rendu du tableau ===
function renderOrders(rows) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Aucune commande trouvée.</td></tr>`;
    return;
  }

    // Rendu des lignes (ajoute data-n au bouton)
    tbody.innerHTML = rows.map(r => `
    <tr>
        <td>${badgeForStatus(r.STATUT)}</td>
        <td><span class="text-primary">${r.N_CLIENT ?? ''}</span></td>
        <td class="font-medium">${r.NOM_CLIENT ?? ''}</td>
        <td>${r.CONTACT_CLIENT ?? ''}</td>
        <td class="font-medium">${formatEUR(r.MONTANT_HT)}</td>
        <td>
        <button class="icon-button" data-n="${r.N}">
            <i data-lucide="more-horizontal"></i>
        </button>
        </td>
    </tr>
    `).join('');

    // Ouvrir le formulaire prérempli quand on clique "…"
const ordersTbody = document.getElementById('ordersTableBody');
if (ordersTbody && !ordersTbody.dataset.bound) {
  ordersTbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-n]');
    if (!btn) return;
    const n = btn.getAttribute('data-n');
    await openOrderForEdit(n);
  });
  ordersTbody.dataset.bound = '1'; // ✅ on ne le fera qu'une fois
}

  // réinitialise les icônes si besoin
  if (window.lucide) lucide.createIcons();
}

window.currentOrderN = null;
window.currentOrdersFilter = window.currentOrdersFilter || "";

async function loadOrders({ status = '', marketing = '', q = '', limit = 500, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (status)    params.set('status', status);
    if (marketing) params.set('marketing', marketing);
    if (q)         params.set('q', q);
    params.set('limit',  String(limit));
    params.set('offset', String(offset));

    const data = await apiGet(`/orders?` + params.toString());   // ← JSON DIRECT

    if (!data || !data.ok) {
        throw new Error(data?.error || "Erreur API /orders");
    }

    const rows = data.rows || [];
    renderOrders(rows);
    return rows;
}

function ensureSelect(id) {
    const old = document.getElementById(id);
    if (!old) {
        console.warn("Champ introuvable :", id);
        return null;
    }

    // Si c’est déjà un select → tout va bien
    if (old.tagName === "SELECT") return old;

    // Sinon on convertit l’input → select
    const sel = document.createElement("select");

    // Copie des attributs
    sel.id = old.id;
    sel.name = old.name || old.id;
    sel.className = old.className;
    sel.required = old.required;

    // Style inline conservé si besoin
    if (old.style.cssText) {
        sel.style.cssText = old.style.cssText;
    }

    // On remplace proprement l'ancien input
    old.replaceWith(sel);

    console.log(`Champ ${id} converti automatiquement en <select>`);

    return sel;
}

async function populateSelectFromDonneesById(id) {
  const sel = ensureSelect(id);  // convertit input -> select
  if (!sel) return;

  // attend le token
  while (!window.APP_TOKEN) {
    await new Promise(res => setTimeout(res, 30));
  }

  const data = await apiGet(`/donnees?nom_colonne=${encodeURIComponent(id)}`);

  if (!data || !data.ok) {
    console.warn("Erreur API pour", id, data);
    return;
  }

  const oldValue = sel.value;        // 1. sauvegarder d'abord
  sel.innerHTML = "";                // 2. vider
  sel.insertAdjacentHTML("beforeend", `<option value=""></option>`);

  data.values.forEach(v => {
    sel.insertAdjacentHTML(
      "beforeend",
      `<option value="${v}">${v}</option>`
    );
  });

  if (oldValue && Array.from(sel.options).some(o => o.value == oldValue)) {
    sel.value = oldValue;
  }

  console.log("Hydratation OK pour", id, data.values.length, "valeurs");
}

function setActiveOrdersFilter(filterKey = "") {
  // mémorise le filtre courant ('' = toutes)
  window.currentOrdersFilter = filterKey || "";

  // Retire l'état actif de tous les boutons "Commandes"
  document.querySelectorAll('.nav-item[data-page="orders"]').forEach(b => b.classList.remove('active'));

  // Choisit le bon bouton: '' = Tous, sinon un data-filter
  const selector = filterKey
    ? `.nav-item[data-page="orders"][data-filter="${filterKey}"]`
    : `.nav-item[data-page="orders"]:not([data-filter])`;
  const btn = document.querySelector(selector);
  if (btn) btn.classList.add('active');

  // Affiche la page Commandes
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-orders')?.classList.add('active');

  if (window.lucide) lucide.createIcons();
}

async function refreshOrdersList() {
  const f = window.currentOrdersFilter || "";

  if (f === 'orders_progress')  return loadOrders({ status: 'en_cours' });
  if (f === 'orders_stock')     return loadOrders({ status: 'stock' });
  if (f === 'orders_delivered') return loadOrders({ status: 'livree' });
  if (f === 'orders_marketing') return loadOrders({ marketing: 'OUI' });

  // par défaut: toutes les commandes
  return loadOrders();
}

// on expose au cas où
window.refreshOrdersList = refreshOrdersList;

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', async function () {
    const page = this.getAttribute('data-page');
    try {
      // Commandes : 1er chargement seulement (évite refresh lourd)
      if (page === 'orders' && !ordersLoadedOnce) {
        await loadOrders();
        ordersLoadedOnce = true;
      }

      // Dashboard : TOUJOURS rafraîchir (tu viens de modifier des données)
      if (page === 'dashboard') {
        await loadDashboardStats();
      }
    } catch (e) {
      console.error(e);
    }
  });
});

document.querySelectorAll('.nav-item[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    setActiveOrdersFilter(f);
    if (f === 'orders_progress')  return loadOrders({ status: 'en_cours' });
    if (f === 'orders_stock')     return loadOrders({ status: 'stock' });
    if (f === 'orders_delivered') return loadOrders({ status: 'livree' });
    if (f === 'orders_marketing') return loadOrders({ marketing: 'OUI' });
  });
});

// === Recherche locale + (option) déclenchement serveur ===
const ordersSearch = document.getElementById('orders-search');
if (ordersSearch) {
  ordersSearch.addEventListener('input', async function () {
    const term = this.value.trim();
    // Filtre DOM immédiat (déjà présent plus bas), et si tu préfères côté serveur :
    // await loadOrders({ q: term });
  });
}

// ===== Helpers Clients =====
function maskPwd(s) {
  const v = String(s ?? '');
  // Affiche **** si vide -> "", sinon masque tout en gardant longueur max 12
  return v ? '•'.repeat(Math.min(v.length, 12)) : '';
}

function renderClients(rows) {
  const tbody = document.getElementById('clientsTableBody');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Aucun client trouvé.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="font-medium">${r.NOM_CLIENT ?? ''}</td>
      <td><span class="text-primary">${r.NUMERO_DE_SERIE ?? ''}</span></td>
      <td>${r.VERSION ?? ''}</td>
      <td>${r.MDP ?? ''}</td>
      <td>${r.TYPE_DE_CONNEXION ?? ''}</td>
      <td><button class="icon-button"><i data-lucide="more-horizontal"></i></button></td>
    </tr>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

async function loadClients({ q = '', limit = 500, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

const data = await apiGet(`/clients?` + params.toString());
if (!data || !data.ok) {
    throw new Error(data?.error || "Erreur API /clients");
}
renderClients(data.rows || []);
}

// Charge au premier accès à l’onglet "Clients"
// --- Déclenchement à chaque clic sur une entrée de la barre latérale
let ordersLoadedOnce = false;
let clientsLoadedOnce = false;

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', async function () {
    const page = this.getAttribute('data-page');
    const isFilter = this.hasAttribute('data-filter');
    if (page === 'orders' && !isFilter) {
      try {
        setActiveOrdersFilter("");     // filtre = toutes
        await refreshOrdersList();     // recharge selon ce filtre
      } catch (e) {
        console.error(e);
      }
    }
  });
});

// Recherche côté serveur (optionnel) ou filtrage DOM (déjà présent)
const clientsSearch = document.getElementById('clients-search');
if (clientsSearch) {
  clientsSearch.addEventListener('input', async function () {
    const term = this.value.trim();
    // Option 1 (serveur) :
    await loadClients({ q: term });
    // Option 2 (client) : laisser la logique générique existante filtrer le DOM
  });
}

// Initialize Lucide icons
lucide.createIcons();

// Navigation
document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', function() {
        const page = this.getAttribute('data-page');
        
        // Update active nav item
        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
        this.classList.add('active');
        
        // Show corresponding page
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-' + page).classList.add('active');
        
        // Re-initialize icons for new content
        lucide.createIcons();
    });
});

// Modal functions
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        lucide.createIcons();
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
    }

    // 🔵 Si on ferme le formulaire de commande, on “oublie” la commande en cours
    if (modalId === 'orderModal') {
        window.currentOrderN = null;
        window.isOrderFormDirty = false;
    }
}

// Close modal on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
    }
});

async function loadOrdersEvolutionChart() {
    const ordersCtx = document.getElementById('ordersChart');
    if (!ordersCtx) return;

    try {
        // 📌 apiGet retourne DIRECTEMENT un objet JSON
        const data = await apiGet(`/orders/modules-evolution`);

        if (!data || !data.ok) {
            throw new Error(data?.error || "Erreur API /orders/modules-evolution");
        }

        const items  = data.items || [];
        const labels = items.map(it => it.label || it.month);
        const values = items.map(it => Number(it.modules || 0));

        // 📌 Reset graphique si déjà affiché
        if (window.ordersChartInstance) {
            window.ordersChartInstance.destroy();
        }

        window.ordersChartInstance = new Chart(ordersCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Modules vendus',
                    data: values,
                    borderWidth: 3,
                    tension: 0.4,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true },
                    x: {}
                }
            }
        });

    } catch (e) {
        console.error('loadOrdersEvolutionChart failed:', e);
    }
}

window.loadOrdersEvolutionChart = loadOrdersEvolutionChart;

window.addEventListener('load', () => {
    loadOrdersEvolutionChart();
});

window.addEventListener('load', function() {
    // Orders Line Chart (modules vendus sur 6 derniers mois)
    loadOrdersEvolutionChart();

    // Pie Chart
    const pieCtx = document.getElementById('pieChart');
    if (pieCtx) {
        new Chart(pieCtx, {
            type: 'doughnut',
            data: {
                labels: ['Luxe 6 bouteilles', 'Premium 12 bouteilles', 'Standard 24 bouteilles'],
                datasets: [{
                    data: [35, 45, 20],
                    backgroundColor: ['#0066cc', '#10b981', '#f59e0b'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                cutout: '60%'
            }
        });
    }
});


// Table search functionality (example for orders)
document.querySelectorAll('.search-bar input').forEach(input => {
    input.addEventListener('input', function() {
        const searchTerm = this.value.toLowerCase();
        const table = this.closest('.page').querySelector('.data-table tbody');
        
        if (table) {
            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(searchTerm)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        }
    });
});

window.addEventListener("load", () => {
    if (typeof openOrderForEdit === "function") {
        window.openOrderForEdit = openOrderForEdit;
    }
});

