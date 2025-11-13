 // Base API robuste (lecture tardive de window.API + fallbacks)
 const API =
   (typeof window !== "undefined" && window.API) ||
   (typeof window !== "undefined" && window.cfg && window.cfg.API_BASE) ||
   "https://api-tonnas.synology.me:8443";
 // expose aussi sur window pour les autres modules
if (typeof window !== "undefined") window.API = API;

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

// Hydrate tous les <select> à partir de /donnees
async function hydrateAllDonneesSelects() {
  // On enchaîne en parallèle pour aller vite
  await Promise.all(IDS_DONNEES.map(id => populateSelectFromDonneesById(id)));

  // Comme EPAPER peut devenir <select>, on réapplique l’UI
  if (typeof applyEpaperUI === "function") applyEpaperUI();
}

// Rendre dispo pour index.js et les appels inline
window.hydrateAllDonneesSelects = hydrateAllDonneesSelects;

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

function newOrder() {
  // 1. Oublier toute commande précédente
  window.currentOrderN = null;

  // 2. Vider tous les champs de la modale
  document
    .querySelectorAll('#orderModal input, #orderModal textarea, #orderModal select')
    .forEach(el => {
      if (el.tagName === 'SELECT') {
        el.selectedIndex = 0;
      } else {
        el.value = '';
      }
    });

  // 3. (Optionnel) remplir DATE_PLANNING automatiquement
  const dp = document.getElementById('DATE_PLANNING');
  if (dp) {
    const today = new Date();
    dp.value = today.toISOString().split('T')[0];
  }

  // 4. Forcer STATUT = EN ATTENTE
  const st = document.getElementById('STATUT');
  if (st) {
    if (st.tagName === 'SELECT') {
      const idx = Array.from(st.options).findIndex(
        opt => opt.textContent.trim().toUpperCase() === 'EN ATTENTE'
      );
      if (idx >= 0) st.selectedIndex = idx;
    } else {
      st.value = 'EN ATTENTE';
    }
  }

  // 5. Ouvrir la modale
  if (typeof openModal === 'function') openModal('orderModal');

  // 6. Mettre à jour les blocs conditionnels
  if (typeof updateConditionalBlocks === 'function') updateConditionalBlocks();
}

// === Fetch côté client ===
async function loadOrders({ status = '', marketing = '', q = '', limit = 500, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (status)    params.set('status', status);
  if (marketing) params.set('marketing', marketing);
  if (q)         params.set('q', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const res  = await fetch(`${API}/orders?` + params.toString(), { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);

  const rows = data.rows || [];
  renderOrders(rows);
  return rows;
}

function setActiveOrdersFilter(filterKey = "") {
  // Retire l'état actif de tous les boutons "Commandes"
  document.querySelectorAll('.nav-item[data-page="orders"]').forEach(b => b.classList.remove('active'));

  // Choisit le bon bouton: '' = Tous, sinon un data-filter
  const selector = filterKey
    ? `.nav-item[data-page="orders"][data-filter="${filterKey}"]`
    : `.nav-item[data-page="orders"]:not([data-filter])`;
  const btn = document.querySelector(selector);
  if (btn) btn.classList.add('active');

  // S'assure que la page "Commandes" est bien affichée
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-orders')?.classList.add('active');

  if (window.lucide) lucide.createIcons();
}

// Filtres de la sidebar (data-filter)
document.querySelectorAll('.nav-item[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    setActiveOrdersFilter(f);                              // met à jour la barre
    if (f === 'orders_progress')  return loadOrders({ status: 'en_cours' });
    if (f === 'orders_stock')     return loadOrders({ status: 'stock' });
    if (f === 'orders_delivered') return loadOrders({ status: 'livree' });
    if (f === 'orders_marketing') return loadOrders({ marketing: 'OUI' });
  });
});


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

  const res = await fetch(`${API}/clients?` + params.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  renderClients(data.rows || []);
}

// Charge au premier accès à l’onglet "Clients"
// --- Déclenchement à chaque clic sur une entrée de la barre latérale
let ordersLoadedOnce = false;
let clientsLoadedOnce = false;

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
      // Dashboard : TOUJOURS rafraîchir (stats + graphique)
      if (page === 'dashboard') {
        if (typeof window.refreshDashboard === 'function') {
          await window.refreshDashboard();     // /orders/stats + /orders/modules-evolution
        } else {
          await loadDashboardStats();          // fallback au minimum
        }
      }

    } catch (e) {
      console.error(e);
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

window.openOrderForEdit = openOrderForEdit;

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
        const res = await fetch(`${API}/orders/modules-evolution`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const items   = data.items || [];
        const labels  = items.map(it => it.label || it.month);
        const values  = items.map(it => Number(it.modules || 0));

        // Si un ancien graphique existe, on le détruit avant d'en recréer un
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

// optionnel, mais propre : on l'expose explicitement
window.loadOrdersEvolutionChart = loadOrdersEvolutionChart;

// Au chargement initial de la page, on dessine une première fois
window.addEventListener('load', () => {
    loadOrdersEvolutionChart();
    // ... le code du pie chart reste comme avant
});

// Initialize Charts
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

console.log('Le Casier Français ERP initialized');