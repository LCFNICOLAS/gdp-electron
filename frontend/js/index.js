// ===============================
// app.merged.js (index.js + script.js) — v2
// ===============================
// Base URL du backend (inchangée)
window.API =
  window.API ||
  (window.cfg && window.cfg.API_BASE) ||
  process.env?.BACKEND_BASE ||
  "https://api-tonnas.synology.me:8443";

// Token partagé
window.APP_TOKEN = window.APP_TOKEN || "";

// Charge (ou recharge) le token depuis le backend
async function loadAppToken() {
  const res = await fetch(API + "/token", { cache: "no-store" });
  const data = await res.json();
  if (!data || !data.token) {
    throw new Error("Impossible de récupérer le token");
  }
  window.APP_TOKEN = data.token;
  console.log("TOKEN FRONT =", window.APP_TOKEN);
}

// GET générique avec gestion du token + retry si 401
async function apiGet(url, opts = {}) {
  // s’il n’y a pas de token, on le charge d’abord
  if (!window.APP_TOKEN) {
    await loadAppToken();
  }

  const doFetch = async () => {
    const res = await fetch(API + url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "X-App-Token": window.APP_TOKEN || ""
      }
    });

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    // si le backend renvoie explicitement ok:false -> erreur aussi
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  };

  try {
    return await doFetch();
  } catch (e) {
    // Token invalide / backend relancé → on recharge UNE fois et on retente
    if (e.status === 401 && !opts._retried) {
      console.warn("Token invalide, rechargement…");
      await loadAppToken();
      return apiGet(url, { _retried: true });
    }
    throw e;
  }
}

// POST générique avec la même logique
async function apiPost(url, body, opts = {}) {
  if (!window.APP_TOKEN) {
    await loadAppToken();
  }

  const doFetch = async () => {
    const res = await fetch(API + url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-App-Token": window.APP_TOKEN || ""
      },
      body: JSON.stringify(body || {})
    });

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  };

  try {
    return await doFetch();
  } catch (e) {
    if (e.status === 401 && !opts._retried) {
      console.warn("Token invalide (POST), rechargement…");
      await loadAppToken();
      return apiPost(url, body, { _retried: true });
    }
    throw e;
  }
}

  // =======================
// Auto-refresh global
// =======================

const AUTO_REFRESH_MS = 5000;   // 15000 ms = 15 secondes
let autoRefreshTimer = null;

// Détermine quelle page est active (#page-dashboard, #page-orders, #page-clients, etc.)
function getActivePageKey() {
  const active = document.querySelector(".page.active");
  if (!active) return null;
  if (active.id === "page-dashboard") return "dashboard";
  if (active.id === "page-orders")    return "orders";
  if (active.id === "page-clients")   return "clients";
  return null;
}

async function autoRefreshTick() {
  const page = getActivePageKey();

  try {
    // 1) Tableau de bord → stats + graphique
    if (page === "dashboard") {
      if (typeof window.refreshDashboard === "function") {
        await window.refreshDashboard();          // /orders/stats + /orders/modules-evolution
      } else if (typeof window.loadDashboardStats === "function") {
        await window.loadDashboardStats();        // fallback
      }

    // 2) Page commandes
    } else if (page === "orders") {

      // a) Si un formulaire de commande est ouvert → NE PAS rafraîchir
      // (sinon cela détruit les listes déroulantes, les selects, les valeurs, etc.)
      if (window.currentOrderN) {
        return;   // ⬅️ Empêche le refresh complet du formulaire
      }

      // b) Sinon, on recharge simplement la liste des commandes
      if (typeof window.refreshOrdersList === "function") {
        await window.refreshOrdersList();   // garde le filtre actuel
      } else if (typeof window.loadOrders === "function") {
        await window.loadOrders();          // fallback
      }

    // 3) Page clients → recharge la liste clients
    } else if (page === "clients") {
      if (typeof window.loadClients === "function") {
        await window.loadClients();
      }
    }

  } catch (e) {
    console.warn("autoRefreshTick failed:", e);
  }
}

// Lance / relance le timer global
function startGlobalAutoRefresh(intervalMs = AUTO_REFRESH_MS) {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(autoRefreshTick, intervalMs);
}

// Exposé au cas où tu veuilles changer l’intervalle plus tard
window.startGlobalAutoRefresh = startGlobalAutoRefresh;

// Shim de sécurité: si showNotif n'est pas encore injecté, on a un fallback
window.showNotif = window.showNotif || function(typeOrMsg, title = "") {
  const msg = (title ? `${typeOrMsg}: ${title}` : `${typeOrMsg}`);
  try { console.warn("[notif]", msg); } catch {}
  if (typeof alert === "function") alert(msg);
};

if (typeof window.hydrateAllDonneesSelects !== "function") {
  // si script.js ne l'a pas encore définie, on met un no-op pour éviter l'erreur,
  // et on réessaye après le DOMContentLoaded
  window.hydrateAllDonneesSelects = async function(){};
  document.addEventListener("DOMContentLoaded", () => {
    if (typeof hydrateAllDonneesSelects === "function") {
      window.hydrateAllDonneesSelects = hydrateAllDonneesSelects;
    }
  });
}

function dateToDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// → "31/10/2025" depuis une chaîne "YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", etc.
function normalizeToDDMMYYYY(s) {
  const str = String(s || "").trim();
  if (!str) return "";
  // ISO → DD/MM/YYYY
  const iso = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // DD-MM-YYYY → DD/MM/YYYY
  const frDash = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (frDash) return `${frDash[1]}/${frDash[2]}/${frDash[3]}`;
  // déjà au bon format
  const frSlash = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (frSlash) return str;
  return "";
}

// === FILTRES DE STATUT POUR LA PAGE COMMANDES ===
const ORDER_STATUS_FILTERS = {
    "orders_all": null,
    "orders_progress": ["EN PRODUCTION", "EN ATTENTE - PRODUCTION"],
    "orders_stock": ["EN STOCK"],
    "orders_delivered": ["LIVRÉ", "LIVREE"],
    "orders_marketing": null
};

document.querySelectorAll(".sidebar-nav .nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
        const page = btn.dataset.page;
        const chosenFilter = btn.dataset.filter ?? "orders_all";

        // Changer le titre H1 en fonction du bouton cliqué
        updateOrdersPageHeader(chosenFilter);

        // Appliquer le filtre si on est sur la page commandes
        if (page === "orders") {
            currentOrderFilter = chosenFilter;
            applyOrdersFilter();
        }

        showPage(page);
    });
});

function updateOrdersPageHeader(filterKey) {
    const h1 = document.querySelector("#page-orders h1");
    const p = document.querySelector("#page-orders .subtitle");

    const titles = {
        "orders_all": ["Commandes", "Gérez vos commandes clients"],
        "orders_progress": ["Commandes en cours", "Commandes en production ou en attente"],
        "orders_stock": ["Commandes en stock", "Commandes actuellement en entrepôt"],
        "orders_delivered": ["Commandes livrées", "Historique des commandes livrées"],
        "orders_marketing": ["Marketing", "Commandes nécessitant un suivi marketing"]
    };

    const t = titles[filterKey] ?? titles["orders_all"];

    h1.textContent = t[0];
    p.textContent = t[1];
}

async function saveOrder() {
  // Vérif mini côté front
  const nClient   = document.getElementById("N_CLIENT")?.value?.trim() || "";
  const nomClient = document.getElementById("NOM_CLIENT")?.value?.trim() || "";
  if (!window.currentOrderN && (!nClient || !nomClient)) {
    showNotif("error", "Renseigne N_CLIENT et NOM_CLIENT avant d’enregistrer.");
    return;
  }

  // Collecte de tous les champs de la modale
  let data = {};
  document.querySelectorAll('#orderModal input, #orderModal textarea, #orderModal select')
    .forEach(el => {
      if (!el.id) return;
      data[el.id] = (el.value ?? "").toString().trim();
    });

  // --- Filtrage : ne garder que les champs qui changent ---
  // (et conserver les "" si on efface une ancienne valeur)
  if (window.currentOrder) {
    for (const k of Object.keys(data)) {
      const v = data[k];
      const before = (window.currentOrder[k] ?? "").toString().trim();

      // EPAPER & co : on laisse la logique EPAPER décider plus bas,
      // mais on enlève les champs strictement identiques
      if (["EPAPER", "QTE_EPAPER", "STATUT_EPAPER"].includes(k)) {
        if (v === before) {
          delete data[k];
        }
        continue;
      }

      if (v === "") {
        // si c’était déjà vide, aucun changement → on supprime
        if (before === "") {
          delete data[k];
        }
        // sinon on garde "" pour effacer en base
      } else {
        // valeur non vide identique à avant → pas la peine d’envoyer
        if (v === before) {
          delete data[k];
        }
      }
    }
  }

  // Normalisation EPAPER (uniquement si le champ est présent dans data)
  if (Object.prototype.hasOwnProperty.call(data, "EPAPER")) {
    const ep = (data.EPAPER || "").toUpperCase();
    data.EPAPER = ep;
    if (ep === "NON") {
      // Si EPAPER = NON, on force la suppression des infos associées
      data.QTE_EPAPER = "";
      data.STATUT_EPAPER = "";
    }
  }

  // Format montant -> DB "1234.56" uniquement si le champ est dans data
  if (Object.prototype.hasOwnProperty.call(data, "MONTANT_HT")) {
    const dbVal = amountToDB(data.MONTANT_HT);
    data.MONTANT_HT = dbVal || ""; // vide si invalide
  }

  const method = window.currentOrderN ? "PUT" : "POST";
  const url = window.currentOrderN ? `${API}/orders/${window.currentOrderN}` : `${API}/orders`;

  // Si on est en édition et qu'au final il n'y a rien à changer → on sort proprement
  if (method === "PUT" && Object.keys(data).length === 0) {
    showNotif("info", "Aucun changement à enregistrer.");
    closeModal("orderModal");
    window.isOrderFormDirty = false;
    window.currentOrderN = null;
    return;
  }

  // Nom du PC pour le log distant
  const pcName = localStorage.getItem('PC_NAME') || 'Inconnu';

  // --- Vérification NOM_CLIENT existant (création uniquement) ---
  const nomClientToCheck = (data.NOM_CLIENT || "").trim();
  if (!window.currentOrderN && nomClientToCheck) {
    try {
      const resCheck = await fetch(`${API}/clients/check?nom=${encodeURIComponent(nomClientToCheck)}`);
      let check;
      try { check = await resCheck.json(); } catch { check = {}; }
      const exists =
        (typeof check === "boolean" && check) ||
        check?.exists === true ||
        check?.found === true ||
        (Array.isArray(check) && check.length > 0) ||
        (check?.ok === true && (check.count > 0 || check.exists === true));

      if (exists) {
        showNotif("error", `Le client « ${nomClientToCheck} » existe déjà. Choisis un autre nom.`);
        return;
      }
    } catch (err) {
      console.error("Erreur vérification client :", err);
      showNotif("error", "Impossible de vérifier le nom du client.");
      return;
    }
  }

  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Client-PC": pcName,
        "X-App-Token": window.APP_TOKEN || ""   // ← token obligatoire
      },
      body: JSON.stringify(data)
    });

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status} ${text}`);

    // --- Notifs de mail selon le backend ---
    if (json.mail && typeof json.mail === "object") {
      const m = json.mail;
      if (m.sent) {
        showNotif("success", `Mail de notification envoyé à ${m.to || "…"} .`);
      } else if (m.attempted) {
        showNotif("warning", `Mail non envoyé (${m.reason || "raison inconnue"}).`);
      } else {
        showNotif("info", "Aucun email n’a été envoyé (pas de destinataire).");
      }
    }

    showNotif("success", "Commande enregistrée avec succès !");
    closeModal("orderModal");

    window.currentOrderN = null;
    window.isOrderFormDirty = false;

    // ============================
    // ROUTAGE AUTOMATIQUE APRÈS MAJ
    // ============================
    const newStatus = (data.STATUT || "").trim().toUpperCase();
    let statusParam = "", filterKey = "";

    if (["EN ATTENTE","EN ATTENTE DE PRODUCTION","EN ATTENTE - PRODUCTION","EN PRODUCTION"].includes(newStatus)) {
      statusParam = "en_cours";
      filterKey = "orders_progress";
    } else if (["EN STOCK","TERMINE","TERMINÉ"].includes(newStatus)) {
      statusParam = "stock";
      filterKey = "orders_stock";
    } else if (["LIVREE","LIVRÉE","LIVRE"].includes(newStatus)) {
      statusParam = "livre";
      filterKey = "orders_delivered";
    }

    if (statusParam) {
      await loadOrders({ status: statusParam });
      setActiveOrdersFilter(filterKey);
    } else {
      await loadOrders();
      setActiveOrdersFilter("");
    }

  } catch (e) {
    console.error("saveOrder failed:", e);
    showNotif("error", "Erreur lors de l’enregistrement : " + e.message);
  }
}
window.saveOrder = saveOrder;

// --- Calcule et RENSEIGNE la date de livraison prévue + met à jour DATE_PLANNING
function calculerLivraisonPrevue() {
  const borneVal = (document.getElementById("BORNE_DE_COMMANDE")?.value || "")
                    .trim().toUpperCase();

  // Toujours lire RAL module (lui reste visible)
  const ral_module = (document.getElementById("RAL_MODULE")?.value || "")
                      .trim().toUpperCase();

  // RAL_BDC uniquement si ce n'est pas COMPACT
  let ral_bdc = "";
  if (borneVal !== "COMPACT") {
    ral_bdc = (document.getElementById("RAL_BDC")?.value || "")
              .trim().toUpperCase();
  }

  const livraisonEl = document.getElementById("LIVRAISON_PREVUE");
  if (!livraisonEl) return;

  const today = new Date();
  let weeksToAdd = 12;

  // Condition 10 semaines :
  // - Si borne = COMPACT → on ne regarde QUE RAL_MODULE
  // - Sinon → RAL_BDC ET RAL_MODULE doivent être RAL 9003 BLANC
  const isWhite = v => v === "RAL 9003 BLANC";

  if (isWhite(ral_module) && (borneVal === "COMPACT" ? true : isWhite(ral_bdc))) {
    weeksToAdd = 10;
  }

  // Calcul
  let livraison = new Date(today);
  livraison.setDate(today.getDate() + weeksToAdd * 7);

  // Août : +3 semaines si la date tombe du 1er au 21
  if (livraison.getMonth() === 7 && livraison.getDate() <= 21) {
    livraison.setDate(livraison.getDate() + 3 * 7);
  }

  livraisonEl.value = dateToDDMMYYYY(livraison);

  const dp = document.getElementById("DATE_PLANNING");
  if (dp) dp.value = dateToDDMMYYYY(today);
}


// Déclenche le recalcul même si RAL_BDC / RAL_MODULE ont été recréés (input -> select)
document.addEventListener("change", (e) => {
  const id = e.target && e.target.id;
  if (id === "RAL_BDC" || id === "RAL_MODULE") {
    calculerLivraisonPrevue();
  }
});

// =====================================================
// MODULE EPAPER (déclaration AVANT toute utilisation)
// =====================================================
const MODULE_INPUT_IDS = [
  "MOD10S","MOD14S","MOD14SDV","MOD15S","MOD21S","MOD21SDV","MOD21SPT","MOD24S","MOD28S",
  "MOD10R","MOD14R","MOD14RDV","MOD15R","MOD21R","MOD21RDV","MOD21RPT","MOD24R","MOD28R",
  "MOD21C","MOD21CDV"
];

const EPAPER_OVERRIDE = { "MOD21SPT": 18, "MOD21RPT": 18 };
// =====================================================

function calcQteEpaper() {
  let total = 0;

  for (const id of MODULE_INPUT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;

    const qty = parseInt(el.value, 10) || 0;
    if (qty === 0) continue;

    // Exceptions (MOD21SPT, MOD21RPT)
    if (EPAPER_OVERRIDE[id]) {
      total += qty * EPAPER_OVERRIDE[id];
      continue;
    }

    // Extraire la taille (ex: "MOD21R" -> 21)
    // On enlève "MOD", on prend les chiffres au début
    const raw = id.replace(/^MOD/, "");
    const match = raw.match(/^(\d+)/);

    if (match) {
      const size = parseInt(match[1], 10); // ex: "21"
      total += qty * size;
    }
  }

  const out = document.getElementById("QTE_EPAPER");
  if (out) out.value = total;
}

function setupQteEpaperAuto() {
  for (const id of MODULE_INPUT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;

    // éviter les doubles listeners
    if (el.dataset.boundQteEpaper === "1") continue;

    el.addEventListener("input", calcQteEpaper);
    el.addEventListener("change", calcQteEpaper);

    el.dataset.boundQteEpaper = "1";
  }

  // Premier calcul
  calcQteEpaper();
}

document.addEventListener("DOMContentLoaded", setupQteEpaperAuto);

async function newOrder() {
  window.currentOrderN = null;

  document
    .querySelectorAll("#orderModal input, #orderModal textarea, #orderModal select")
    .forEach(el => {
      if (el.tagName === "SELECT") el.selectedIndex = 0;
      else el.value = "";
    });

  const dp = document.getElementById("DATE_PLANNING");
  if (dp) {
    const today = new Date();
    dp.value = today.toISOString().split("T")[0];
  }

  if (typeof openModal === "function") openModal("orderModal");

  // 🔹 maintenant ça marche vraiment
  if (typeof window.hydrateAllDonneesSelects === "function") {
    await window.hydrateAllDonneesSelects();
  }

  applyEpaperUI();
  calculerLivraisonPrevue();
  if (typeof setupQteEpaperAuto === "function") setupQteEpaperAuto();

  const st = document.getElementById("STATUT");
  if (st) {
    if (st.tagName === "SELECT") {
      const idx = Array.from(st.options).findIndex(
        opt => opt.textContent.trim().toUpperCase() === "EN ATTENTE"
      );
      if (idx >= 0) st.selectedIndex = idx;
    } else {
      st.value = "EN ATTENTE";
    }

makeComboBox("RAL_BDC");
makeComboBox("RAL_MODULE");

  }

  // Valeurs par défaut
  const defaults = {
    BORNE_DE_COMMANDE: "NON",
    MARKETING: "NON",
    BATIMENT_MODULAIRE: "NON",
    PAYS: "FRANCE",
    RAL_MODULE: "RAL 9003 BLANC"
  };

  for (const [id, val] of Object.entries(defaults)) {
    const el = document.getElementById(id);
    if (!el) continue;

    if (el.tagName === "SELECT") {
      // sélectionne l’option qui correspond
      const idx = Array.from(el.options).findIndex(
        o => o.textContent.trim().toUpperCase() === val.toUpperCase()
      );
      if (idx >= 0) el.selectedIndex = idx;
    } else {
      el.value = val;
    }
  }

  refreshConsultButtons();
  if (typeof updateConditionalBlocks === "function") updateConditionalBlocks();
}

// ✅ si tu veux être 100% safe :
window.newOrder = newOrder;

function updateConditionalBlocks() {
  // === Borne de commande ===
  const borneSelect  = document.getElementById('BORNE_DE_COMMANDE');
  const borneValue   = (borneSelect?.value || '').trim().toUpperCase();
  const borneOptions = document.getElementById('borne-options');
  const showBDC = (borneValue === 'OUI');
  if (borneOptions) {
    borneOptions.classList.toggle('visible', showBDC);
    borneOptions.style.display = showBDC ? '' : 'none';
    borneOptions.querySelectorAll('input, select, textarea').forEach(el => {
      el.disabled = !showBDC;
      if (!showBDC) el.value = '';
    });
  }

  // Champs liés à BDC à forcer (adapter l’ID de "Kit Epaper" si besoin)
  const bdcRelated = [
    "EPAPER", "QTE_EPAPER", "STATUT_EPAPER",
    "KIT_EPAPER",            // ← si ton select s’appelle autrement, remplace l’ID
    "CONTRAT_COMMERCANT"
  ];

  bdcRelated.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const group = el.closest(".form-group") || el.closest(".col") || el.closest(".row");
    if (group) group.style.display = showBDC ? "" : "none";
    el.disabled = !showBDC;
    if (!showBDC) el.value = "";  // on nettoie si caché
  });

  // Quand BDC = OUI → valeurs automatiques
  if (borneValue === "OUI") {
    const forcedValues = {
      KIT_CODE_BARRES: "NON",
      RAL_BDC: "RAL 9003 BLANC",
      EPAPER: "NON"
    };

    for (const [id, val] of Object.entries(forcedValues)) {
      const el = document.getElementById(id);
      if (!el) continue;

      if (el.tagName === "SELECT") {
        const idx = Array.from(el.options).findIndex(
          o => o.textContent.trim().toUpperCase() === val.toUpperCase()
        );
        if (idx >= 0) el.selectedIndex = idx;
      } else {
        el.value = val;
      }
    }

    // EPAPER UI doit se replier automatiquement
    if (typeof applyEpaperUI === "function") applyEpaperUI();
  }

  // Boutons du contrat (Ajouter / Consulter)
  ["btn-contrat-ajouter","btn-contrat-consulter"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = showBDC ? "inline-block" : "none";
  });

  // Lorsque BDC = NON, s’assurer que l’UI EPAPER se replie
  if (!showBDC && typeof applyEpaperUI === "function") applyEpaperUI();

  // Cas spécial COMPACT -> masque RAL_BDC
  const ralBdcGroup = document.getElementById('RAL_BDC')?.closest('.form-group');
  if (ralBdcGroup) {
    ralBdcGroup.style.display = (showBDC && ['BANQUE – COMPACT','COMPACT'].includes(
      (document.getElementById('MODE_PAIEMENT')?.value || '').trim().toUpperCase()
    )) ? 'none' : '';
  }

  // (réapplique les dépendances éventuelles)
  try { calcQteEpaper?.(); } catch {}
  try { calculerLivraisonPrevue?.(); } catch {}
  try { setupQteEpaperAuto?.(); } catch {}

  // === Bâtiment modulaire ===
  const batSelect  = document.getElementById('BATIMENT_MODULAIRE');
  const batOptions = document.getElementById('batiment-options');
  const showBAT = (batSelect?.value || '').trim().toUpperCase() === 'OUI';
  if (batOptions) {
    batOptions.classList.toggle('visible', showBAT);
    batOptions.style.display = showBAT ? '' : 'none';
    batOptions.querySelectorAll('input, select, textarea').forEach(el => {
      el.disabled = !showBAT;
      if (!showBAT) el.value = '';
    });
  }

  // === Marketing ===
  const marketingInput = document.getElementById('MARKETING');
  const marketingBlock = document.getElementById('marketing-block');
  if (marketingInput && marketingBlock) {
    const showMKT = (marketingInput.value || '').trim().toUpperCase() === 'OUI';
    marketingBlock.classList.toggle('visible', showMKT);
    marketingBlock.style.display = showMKT ? '' : 'none'; // laisse le CSS gérer le layout
    marketingBlock.querySelectorAll('input, select, textarea')
      .forEach(el => { el.disabled = !showMKT; if (!showMKT) el.value = ''; });
  }
}
// <-- ferme la fonction ici, avant le DOMContentLoaded

  // on vient peut-être de vider des quantités → on recalcule la QTE_EPAPER
  if (typeof setupQteEpaperAuto === "function") setupQteEpaperAuto();

  // === Bâtiment modulaire ===
  const batSelect  = document.getElementById('BATIMENT_MODULAIRE');
  const batOptions = document.getElementById('batiment-options');
  const showBAT = (batSelect?.value || '').trim().toUpperCase() === 'OUI';

  if (batOptions) {
    batOptions.classList.toggle('visible', showBAT); // compat inline
    batOptions.style.display = showBAT ? '' : 'none';
    batOptions.querySelectorAll('input, select, textarea').forEach(el => {
      el.disabled = !showBAT;
      if (!showBAT) el.value = '';
    });
  }

// --- dans updateConditionalBlocks() ---
const marketingInput = document.getElementById("MARKETING");
const marketingBlock = document.getElementById("marketing-block");
if (marketingInput && marketingBlock) {
  const val = (marketingInput.value || "").trim().toUpperCase();
  // avant: marketingBlock.style.display = (val === "OUI") ? "" : "none";
  marketingBlock.style.display = (val === "OUI") ? "block" : "none";
  // (optionnel) désactiver les champs quand caché
  marketingBlock.querySelectorAll('input, select, textarea')
    .forEach(el => el.disabled = (val !== "OUI"));
}

document.addEventListener('DOMContentLoaded', () => {
  // 🔹 DÉLÉGATION D'ÉVÉNEMENT :
  // on écoute tous les "change" et on regarde si la cible est un des 3 champs
  document.addEventListener('change', (e) => {
    const id = e.target && e.target.id;
    if (!id) return;

    const up = id.toUpperCase();
    if (up === 'BORNE_DE_COMMANDE' || up === 'BATIMENT_MODULAIRE' || up === 'MARKETING') {
      updateConditionalBlocks();
    }
  });

  // État cohérent après hydratation des listes
  setTimeout(updateConditionalBlocks, 150);
});

// ===============================
// Carte Leaflet : COORDONNEES d'abord, sinon défaut
// ===============================

const DEFAULT_COORDS = { lat: 50.573367, lon: 3.0655621 };

// ---- charge Leaflet une seule fois
async function ensureLeafletLoaded() {
  if (window.L) return true;
  await new Promise((resolve) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet/dist/leaflet.css";
    document.head.appendChild(css);

    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet/dist/leaflet.js";
    js.onload = resolve;
    document.head.appendChild(js);
  });
  return true;
}

// index.js – à la suite du bloc DOMContentLoaded qui branche #btn-geocode
document.addEventListener("DOMContentLoaded", () => {
  const debounce = (fn, d = 600) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); };
  };
  const tip = debounce(updateCoordonneesFromAdresse, 600);
  ["VOIE_INSTALLATION","CP_INSTALLATION","VILLE_INSTALLATION","PAYS"]
    .forEach(id => document.getElementById(id)?.addEventListener("input", tip));
});

// Géo → met à jour #COORDONNEES à partir des champs adresse et rafraîchit la carte
// --- Géocodage auto adresse → GEOGRAPHIE (lat,lon) -------------------------
async function updateCoordonneesFromAdresse() {
  const voie  = (document.getElementById("VOIE_INSTALLATION")?.value || "").trim();
  const cp    = (document.getElementById("CP_INSTALLATION")?.value || "").trim();
  const ville = (document.getElementById("VILLE_INSTALLATION")?.value || "").trim();
  const pays  = (document.getElementById("PAYS")?.value || "France").trim();

  const out = document.getElementById("GEOGRAPHIE") || document.getElementById("COORDONNEES");
  if (!out) return;

  // Besoin d'un minimum d'info pour éviter les faux positifs
  if (!voie || (!cp && !ville)) return;

  const q = [voie, [cp, ville].filter(Boolean).join(" "), pays].filter(Boolean).join(", ");
  try {
    out.value = "Recherche…";
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=0`,
      { headers: { "Accept-Language": "fr" } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      const lat = Number(data[0].lat), lon = Number(data[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        out.value = `${lat},${lon}`;
        // recentrer la carte si présente (facultatif)
        if (window.L && window.map) {
          if (window.marker) window.marker.setLatLng([lat, lon]);
          window.map.setView([lat, lon], 14);
        }
        return;
      }
    }
    out.value = ""; // pas trouvé
  } catch (e) {
    console.error("Géocodage OSM échoué :", e);
    out.value = "";
  }
}

// Debounce utilitaire pour ne pas spammer l’API
function debounce(fn, d = 600) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); };
}

// Branchements automatiques (input + change) sur les 3 champs adresse
function bindAutoGeocode() {
  const h = debounce(updateCoordonneesFromAdresse, 700);
  ["VOIE_INSTALLATION", "CP_INSTALLATION", "VILLE_INSTALLATION", "PAYS"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input",  h);
    el.addEventListener("change", h);
  });

  // Bouton "Générer" garde le même comportement
  document.getElementById("btn-geocode")?.addEventListener("click", (e) => {
    e.preventDefault();
    updateCoordonneesFromAdresse();
  });

  // Premier calcul si les champs sont déjà renseignés (édition/import)
  setTimeout(updateCoordonneesFromAdresse, 300);
}

document.addEventListener("DOMContentLoaded", bindAutoGeocode);


// ---- récupère l'input coordonné (COORDONNEES ou GEOGRAPHIE)
function getCoordEl() {
  return document.getElementById("COORDONNEES") || document.getElementById("GEOGRAPHIE");
}

// ---- parse "lat,lon" (ou "lat lon" / "lat;lon", décimales . ou ,)
function parseCoords(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(-?\d+(?:[.,]\d+)?)[^\d-]+(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(",", "."));
  const lon = parseFloat(m[2].replace(",", "."));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// ---- affiche/rafraîchit la carte
async function afficherCarte(lat, lon) {
  await ensureLeafletLoaded();
  const mapContainer = document.getElementById("map-container");
  if (!mapContainer) return;

  mapContainer.style.display = "block";

  if (window.map) {
    window.map.remove();
    window.map = null;
  }

  setTimeout(() => {
    window.map = L.map("map-container").setView([lat, lon], 14);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(window.map);

    window.marker = L.marker([lat, lon]).addTo(window.map);

    setTimeout(() => {
      if (window.map && window.map.invalidateSize) window.map.invalidateSize();
    }, 50);
  }, 100);
}

// ---- Ouvre une commande et applique la règle : COORDONNEES sinon défaut
async function openOrderForEdit(n) {
  // 1) charge la commande
  const data = await apiGet(`/orders/${n}`);
  if (!data || !data.ok) {
      throw new Error(data?.error || "Erreur chargement commande");
  }

  const row = data.row || {};
  window.currentOrder = { ...row };

  // 2) ouvre la modale tout de suite
  if (typeof openModal === "function") openModal("orderModal");
  await new Promise(r => setTimeout(r, 150));

  // 3) hydrate d'abord → convertit input → select AVANT de remplir les valeurs
  if (typeof hydrateAllDonneesSelects === "function") {
      await hydrateAllDonneesSelects();
  }

  // 4) remplit ensuite les champs avec les valeurs BD
  Object.entries(row).forEach(([key, value]) => {
    const el = document.getElementById(key);
    if (!el) return;

    if (key === "DATE_PLANNING" || key === "LIVRAISON_PREVUE") {
      el.value = normalizeToDDMMYYYY(value);
    } else if (key === "MONTANT_HT") {
      el.value = formatEUR(value);   // "15 230,50 €"
    } else {
      el.value = value ?? "";
    }
  });

  if (typeof updateConditionalBlocks === "function") {
      updateConditionalBlocks();
  }

  // 5) coordonnées / carte
  const coordEl = getCoordEl && getCoordEl();
  let coords = coordEl && parseCoords(coordEl.value?.trim());
  if (!coords) {
    coords = { ...DEFAULT_COORDS };
    if (coordEl) coordEl.value = `${coords.lat},${coords.lon}`;
  }
  await afficherCarte(coords.lat, coords.lon);

  // 6) ré-appliquer l’UI (une fois que les valeurs sont en place)
  if (typeof applyEpaperUI === "function") applyEpaperUI();
  if (typeof calcQteEpaper === "function") calcQteEpaper();
  if (typeof refreshConsultButtons === "function") refreshConsultButtons();
  if (typeof updateConditionalBlocks === "function") updateConditionalBlocks();
  if (typeof afterOpenOrderUIFix === "function") afterOpenOrderUIFix();

  makeStyledComboBox("RAL_BDC");
  makeStyledComboBox("RAL_MODULE"); 

  // 7) mémorise la commande ouverte + reset du "dirty"
  window.currentOrderN = n;
  window.isOrderFormDirty = false;
}


window.openOrderForEdit = openOrderForEdit;
window.currentOrderN = window.currentOrderN || null;
window.isOrderFormDirty = window.isOrderFormDirty || false;
window.isOrderFormDirty = false;

// Dès qu'on tape quelque chose dans la modale de commande → dirty = true
document.addEventListener("input", (e) => {
  if (e.target && e.target.closest && e.target.closest("#orderModal")) {
    window.isOrderFormDirty = true;
  }
});

document.addEventListener("DOMContentLoaded", async () => {
    if (window.loadAppToken) {
        await window.loadAppToken(); // si tu l’exposes sur window
    }
    startGlobalAutoRefresh();
    if (typeof window.refreshDashboard === "function") {
        await window.refreshDashboard();
    }
});

// (facultatif) init au chargement
document.addEventListener("DOMContentLoaded", async () => {
  const coordEl = getCoordEl();
  if (!coordEl) return;
  const coords = parseCoords(coordEl.value?.trim()) || { ...DEFAULT_COORDS };
  await afficherCarte(coords.lat, coords.lon);
});

// Au chargement, branche le bouton Générer sur updateCoordonneesFromAdresse()
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-geocode")
        || Array.from(document.querySelectorAll("button"))
              .find(b => /g(é|e)n(é|e)rer/i.test(b.textContent || ""));
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      updateCoordonneesFromAdresse();
    });
  }
});

// ===== Hydratation générique des listes depuis /donnees =====
// Cas spécial : RAL_BDC et RAL_MODULE utilisent les valeurs de NOM_COLONNE="RAL"

const DONNEES_CACHE = new Map();

let DONNEES_ALL = null;        // { NOM_COLONNE: [valeurs...] }
let DONNEES_ALL_PROMISE = null;

// Charge toutes les listes /donnees/all une seule fois
async function ensureAllDonneesLoaded(force = false) {
  if (force) {
    DONNEES_ALL = null;
    DONNEES_ALL_PROMISE = null;
  }

  if (DONNEES_ALL) return DONNEES_ALL;

  if (!DONNEES_ALL_PROMISE) {
    DONNEES_ALL_PROMISE = (async () => {
      try {
        const json = await apiGet("/donnees/all");
        const raw = (json && json.ok && json.values && typeof json.values === "object")
          ? json.values
          : {};

        const cleanedAll = {};
        for (const nom of Object.keys(raw)) {
          const arr = Array.isArray(raw[nom]) ? raw[nom] : [];
          const cleaned = [...new Set(arr.map(v => String(v).trim()).filter(Boolean))];
          cleanedAll[nom] = cleaned;
          if (cleaned.length > 0) {
            DONNEES_CACHE.set(nom, cleaned);
          }
        }

        DONNEES_ALL = cleanedAll;
        return DONNEES_ALL;
      } catch (e) {
        console.warn("ensureAllDonneesLoaded /donnees/all failed", e);
        DONNEES_ALL = {};
        return DONNEES_ALL;
      } finally {
        // on garde DONNEES_ALL, on libère juste la promesse
        DONNEES_ALL_PROMISE = null;
      }
    })();
  }

  return DONNEES_ALL_PROMISE;
}

// Mapping ID -> NOM_COLONNE (spécifiques)
const DONNEES_ID_MAP = {
  RAL_BDC: "RAL",
  RAL_MODULE: "RAL",
};

// Retourne la clé à interroger dans /donnees pour un id donné
function donneesKeyFor(id) {
  return DONNEES_ID_MAP[id] || id;
}

/** Appelle l'API pour un nom_colonne et met en cache. Retourne [] si rien. */
async function fetchDonneesValues(nomColonne, force = false) {
  // 1) cache simple par colonne
  if (!force && DONNEES_CACHE.has(nomColonne)) {
    const cached = DONNEES_CACHE.get(nomColonne);
    if (Array.isArray(cached) && cached.length > 0) return cached;
  }

  // 2) on s'assure que /donnees/all est chargé
  await ensureAllDonneesLoaded(force);

  if (DONNEES_ALL && DONNEES_ALL[nomColonne]) {
    return DONNEES_ALL[nomColonne];
  }

  // 3) dernier recours: comportement historique /donnees?nom_colonne=...
  try {
    const json = await apiGet(`/donnees?nom_colonne=${encodeURIComponent(nomColonne)}`);
    const values = (json && json.ok && Array.isArray(json.values)) ? json.values : [];
    const cleaned = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];

    if (cleaned.length > 0) {
      DONNEES_CACHE.set(nomColonne, cleaned);
      if (DONNEES_ALL) {
        DONNEES_ALL[nomColonne] = cleaned;
      }
    }

    return cleaned;
  } catch (e) {
    console.error("fetchDonneesValues:", nomColonne, e);
    return [];
  }
}

/** Convertit un input#id en select#id (en conservant classes, required, etc.). */
function ensureSelectForId(id) {
  const el = document.getElementById(id);
  if (!el) return null;

  // Déjà un <select> : purger l'état collant et renvoyer tel quel
  if (el.tagName === "SELECT") {
    if (el.dataset) delete el.dataset._prev; // 🧹 évite la valeur fantôme entre ouvertures
    return el;
  }

  // Conversion <input> -> <select>
  const prevValue = el.value;

  const sel = document.createElement("select");
  sel.id = id;
  sel.name = el.name || id;
  sel.className = el.className || "form-input";
  sel.required = !!el.required;
  sel.disabled = !!el.disabled;

  // Quelques attributs utiles à conserver
  if (el.getAttribute("placeholder")) {
    sel.setAttribute("placeholder", el.getAttribute("placeholder"));
  }
  if (el.tabIndex) sel.tabIndex = el.tabIndex;
  if (el.title) sel.title = el.title;

  // Copier les data-* existants (hors _prev)
  if (el.dataset) {
    for (const [k, v] of Object.entries(el.dataset)) {
      if (k === "_prev") continue;
      sel.dataset[k] = v;
    }
  }

  // Option placeholder par défaut
  sel.innerHTML = `<option value="">-- Sélectionner --</option>`;

  // Remplacer dans le DOM et mémoriser l'ancienne valeur pour l'hydratation
  el.parentNode.replaceChild(sel, el);
  sel.dataset._prev = prevValue != null ? String(prevValue).trim() : "";

  return sel;
}

let donneesLoaded = false;
async function ensureDonneesLoaded() {
  if (donneesLoaded) return;
  donneesLoaded = true;
  await hydrateAllDonneesSelects();
}

async function initDashboard() {
  await loadDashboardStats();
  // ne charge les listes que quand on ouvre/affiche les filtres
  const btn = document.getElementById("filters-toggle");
  if (btn) btn.addEventListener("click", ensureDonneesLoaded, { once: true });
  // ou: onfocus du champ de recherche
  const search = document.getElementById("global-search");
  if (search) search.addEventListener("focus", ensureDonneesLoaded, { once: true });
}


// ===== QTE_EPAPER : somme(qté × taille) avec exceptions 21SPT/21RPT = 18 =====

// Taille (en unités EPAPER) pour un ID de module
function unitsFor(id) {
  if (id in EPAPER_OVERRIDE) return EPAPER_OVERRIDE[id];
  const n = parseInt(id, 10);   // ex: "14SDV" → 14 ; "21C" → 21
  return Number.isFinite(n) ? n : 0;
}

// Parse quantité (entier >= 0)
function qtyOf(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const q = parseInt((el.value || "").toString().trim(), 10);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

// EPAPER: si valeur === "NON" -> cacher QTE_EPAPER & STATUT_EPAPER et agrandir EPAPER
// --- EPAPER: afficher/masquer QTE_EPAPER & STATUT_EPAPER selon OUI/NON ---
function applyEpaperUI() {
  const ep = document.getElementById("EPAPER");
  if (!ep) return;

  const epGroup     = ep.closest(".form-group");
  const qte         = document.getElementById("QTE_EPAPER");
  const qteGroup    = qte ? qte.closest(".form-group") : null;
  const statut      = document.getElementById("STATUT_EPAPER");
  const statutGroup = statut ? statut.closest(".form-group") : null;

  const val = (ep.value || "").trim().toUpperCase();
  const show = (val === "OUI"); // OUI => on affiche ; NON => on cache

  if (qteGroup)    qteGroup.classList.toggle("hidden", !show);
  if (statutGroup) statutGroup.classList.toggle("hidden", !show);
  if (epGroup)     epGroup.classList.toggle("epaper-full", !show);
}

// branché une fois, marche même si EPAPER est recréé par l’hydratation
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "EPAPER") applyEpaperUI();
});
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "EPAPER") applyEpaperUI();
});

// première application au chargement
document.addEventListener("DOMContentLoaded", () => applyEpaperUI());


// si EPAPER est remplacé (input -> select) par l’hydratation, on relance le setup
document.addEventListener("DOMContentLoaded", () => {
  applyEpaperUI();

  if (typeof refreshDashboard === "function") {
    refreshDashboard();          // stats + graphique si dispo
  } else {
    loadDashboardStats();        // fallback au cas où
  }

  setTimeout(refreshConsultButtons, 150);
});

// ============ Wiring "Enregistrer" ============
// Fonctionne même si le bouton est de type submit ou si un <form> entoure la modale
document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#orderModal form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();           // bloque la soumission HTML
      saveOrder();                  // lance le fetch
    });
  }

  // essaie de trouver un bouton d’enregistrement courant
  const saveBtn =
    document.querySelector('#orderModal [data-save], #orderModal .btn-save, #btn-save-order');
  if (saveBtn) {
    saveBtn.type = "button";        // évite la soumission native
    saveBtn.addEventListener("click", () => saveOrder());
  }
});

async function loadDashboardStats() {
  try {
    // Pas de cache → on tape vraiment le backend à chaque fois
    const data = await apiGet(`/orders/stats`);
    if (!data || !data.ok) throw new Error(data?.error || "Erreur stats");

    const s = data.stats || {};
    const $ = (id) => document.getElementById(id);

    // Compteurs
    if ($("stat-en-cours")) $("stat-en-cours").textContent  = s.commandes_en_cours ?? 0;
    if ($("stat-stock"))    $("stat-stock").textContent     = s.commandes_en_stock ?? 0;
    if ($("stat-livre"))    $("stat-livre").textContent     = s.commandes_livrees ?? 0;

    // CA du mois – accepte number, string, etc.
    let caRaw = s.ca_mois ?? 0;
    let caNum = 0;

    if (typeof caRaw === "number") {
      caNum = caRaw;
    } else {
      const caDb = amountToDB(caRaw);   // "152320.00" ou ""
      caNum = caDb ? Number(caDb) : 0;
    }
    if (!Number.isFinite(caNum)) caNum = 0;

    if ($("stat-ca-mois")) $("stat-ca-mois").textContent = formatEUR(caNum);
  } catch (e) {
    console.error("loadDashboardStats failed:", e);
  }
}

async function refreshDashboard() {
  try {
    // Stats (compteurs + CA)
    await loadDashboardStats();

    // Graphique d’évolution, si défini côté script.js
    if (typeof window.loadOrdersEvolutionChart === "function") {
      await window.loadOrdersEvolutionChart();
    }
  } catch (e) {
    console.error("refreshDashboard failed:", e);
  }
}

// exposer pour que script.js puisse l'utiliser
window.refreshDashboard = refreshDashboard;

function amountToDB(val) {
  if (val == null) return "";
  let s = String(val).trim();
  if (!s) return "";
  // retire espaces (y compris NBSP) et symbole €
  s = s.replace(/[\s\u202f€]/g, "");
  // virgule comme décimale → point ; sinon, virgules = séparateurs de milliers
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  // s'il reste des points de milliers, on ne garde que le dernier comme décimale
  const parts = s.split(".");
  if (parts.length > 2) s = parts.slice(0, -1).join("") + "." + parts.at(-1);
  const num = Number(s);
  if (!isFinite(num)) return "";
  return num.toFixed(2);                 // → "15230.50"
}

window.amountToDB = amountToDB;

document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("MONTANT_HT");
  if (!el) return;

  // Si on arrive en édition avec une valeur DB → affiche "€"
  if (el.value) el.value = formatEUR(el.value);

  // Au focus : faciliter la saisie → "15230,50" (sans € ni espaces)
  el.addEventListener("focus", () => {
    const db = amountToDB(el.value);
    el.value = db ? db.replace(".", ",") : "";
  });

  // En quittant le champ : joli format "15 230,50 €"
  el.addEventListener("blur", () => {
    el.value = el.value ? formatEUR(el.value) : "";
  });
});

// === Assistant de création de commande ===
function openOrderWizard() {
  const w = document.getElementById("orderWizard");
  if (!w) { newOrder(); return; }
  w.classList.add("active");
  w.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
  const wc = document.getElementById("wizardContinue");
  if (wc) wc.style.display = "none";
  window._wizardChoice = null; // réinitialise le choix
}

// Fermeture
const wizardClose = document.getElementById("wizardClose");
if (wizardClose) {
  wizardClose.onclick = () => {
    document.getElementById("orderWizard")?.classList.remove("active");
  };
} else {
  console.warn("[wizard] #wizardClose introuvable");
}

// Sélection des options
const optWeb  = document.getElementById("optWeb");
const optJson = document.getElementById("optJson");
const contDiv = document.getElementById("wizardContinue");
const fileInp = document.getElementById("wizardFile");
const btnCont = document.getElementById("btnContinue");

function selectOption(el, choice) {
  document.querySelectorAll("#orderWizard .option").forEach(o => o.classList.remove("selected"));
  el.classList.add("selected");
  window._wizardChoice = choice;
  if (contDiv) contDiv.style.display = "block";
}

if (optWeb)  optWeb.onclick  = () => selectOption(optWeb, "web");     // évite le crash (L785) :contentReference[oaicite:5]{index=5}
if (optJson) optJson.onclick = () => selectOption(optJson, "json");

// ...
if (btnCont) {
  btnCont.onclick = () => {
    const choice = window._wizardChoice;
    if (!choice) return;
    if (choice === "web") {
      document.getElementById("orderWizard")?.classList.remove("active");
      newOrder();
    }
    if (choice === "json") {
      if (fileInp) fileInp.value = "";   // ✅ reset pour autoriser le même fichier
      fileInp?.click();
    }
  };
}


window.openOrderWizard = openOrderWizard;

// Autoriser à réimporter le même fichier
fileInp?.addEventListener("click", () => { fileInp.value = ""; });

fileInp?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!/\.json$/i.test(f.name)) {
    showNotif("error", "Merci de sélectionner un fichier JSON (.json)");
    e.target.value = "";
    return;
  }

  try {
    const text = await f.text();
    const jsonData = JSON.parse(text);

    // Ferme l’assistant puis OUVRE le formulaire et ATTENDS l’hydratation
    document.getElementById("orderWizard")?.classList.remove("active");
    await newOrder();                              // ✅ on attend l’ouverture + hydrateAllDonneesSelects()
    await new Promise(r => setTimeout(r, 50));     // petite marge UI

    // Remplissage robuste
    for (const [key, value] of Object.entries(jsonData)) {
      const el = document.getElementById(key);
      if (!el) continue;

      if (el.tagName === "SELECT") {
        const target = String(value ?? "").trim().toUpperCase();
        let matched = false;
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          const txt = (opt.textContent || "").trim().toUpperCase();
          const val = (opt.value || "").trim().toUpperCase();
          if (txt === target || val === target) { el.selectedIndex = i; matched = true; break; }
        }
        if (!matched && target) {
          // au cas où la valeur n’est pas dans la liste
          el.appendChild(new Option(String(value), String(value)));
          el.value = String(value);
        }
      } else if (el.type === "checkbox") {
        el.checked = value === true || String(value).toUpperCase() === "OUI";
      } else if (key === "MONTANT_HT") {
        el.value = formatEUR(value);
      } else {
        el.value = value ?? "";
      }
    }

    // Réapplique tout ce qui dépend des champs
    if (typeof updateConditionalBlocks === "function") updateConditionalBlocks();
    applyEpaperUI?.();
    calcQteEpaper?.();
    calculerLivraisonPrevue?.();
    refreshConsultButtons?.();
    afterOpenOrderUIFix?.();   // (si présent : re-synchronise STATUT/LIVRAISON)

  } catch (err) {
    console.error("Erreur import JSON:", err);
    showNotif("error", "Erreur lors de la lecture du fichier JSON.");
  } finally {
    e.target.value = "";  // ✅ permet de réimporter le même fichier ensuite
  }
});



// --- Toast WAGO : API compatible showNotif(type, title, linkText?, linkHref?, options?) ---
// Usages compatibles :
//   showNotif("success","Commande enregistrée !")
//   showNotif("error","Erreur pendant la recherche")
//   showNotif("message sans type") // traité comme "error" par défaut
//   showNotif("success","Ajouté au panier","Voir le panier","/panier",{duration:5000})
(function () {
  const COLORS = {
    success: "#16a34a", // vert
    error:   "#dc2626", // rouge
    warning: "#f59e0b", // ambre
    info:    "#0ea5e9"  // bleu
  };
  let seq = 0;

  function ensureStack() {
    let el = document.getElementById("notifContainer");
    if (el && !el.classList.contains("toast-stack")) {
      el.className = (el.className ? el.className + " " : "") + "toast-stack";
      el.setAttribute("aria-live","polite");
      el.setAttribute("aria-atomic","true");
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "notifContainer";
      el.className = "toast-stack";
      el.setAttribute("aria-live","polite");
      el.setAttribute("aria-atomic","true");
      document.body.appendChild(el);
    }
    return el;
    console.log("[toast] ensureStack ok, el:", el, "class:", el.className);
  }

  function makeCheckIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 24 24");
    svg.setAttribute("fill","none");
    const path = document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M20 6L9 17l-5-5");
    path.setAttribute("stroke","var(--accent)");
    path.setAttribute("stroke-width","2.5");
    path.setAttribute("stroke-linecap","round");
    path.setAttribute("stroke-linejoin","round");
    svg.appendChild(path);
    return svg;
  }

  window.showNotif = function (type, title, linkText = "", linkHref = "", options = {}) {
    // Compat: showNotif("message") → type=error, title=message
    console.log("[toast] showNotif called", { type, title, linkText, linkHref, options });
    const KNOWN = ["success","error","warning","info"];
    if (!KNOWN.includes(type)) { linkHref = linkText; linkText = ""; title = type; type = "error"; }

    const duration = Number.isFinite(options.duration) ? options.duration : 5000;
    const stack = ensureStack();
    const id = `toast-${++seq}`;

    // Structure
    const toast = document.createElement("div");
    toast.className = "toast";

    const chk = document.createElement("input");
    chk.type = "checkbox"; chk.id = id;

    const content = document.createElement("div");
    content.className = "toast-content";
    // Couleur d'accent selon le type (possibilité d’override via options.accent)
    const accent = options.accent || COLORS[type] || getComputedStyle(document.documentElement).getPropertyValue("--accent");
    content.style.setProperty("--accent", accent);

    const close = document.createElement("label");
    close.className = "toast-close"; close.setAttribute("for", id); close.setAttribute("aria-label","Fermer");

    const icon = document.createElement("div");
    icon.className = "toast-icon"; icon.setAttribute("aria-hidden","true");
    icon.appendChild(makeCheckIcon());

    const body = document.createElement("div");
    body.className = "toast-body";
    const h = document.createElement("div");
    h.className = "toast-title"; h.textContent = String(title || "");
    body.appendChild(h);

    if (linkText && linkHref) {
      const a = document.createElement("a");
      a.className = "toast-link"; a.href = linkHref; a.draggable = false;
      a.innerHTML = `<span>${linkText}</span><span class="chev" aria-hidden="true"></span>`;
      body.appendChild(a);
    }

    content.appendChild(close);
    content.appendChild(icon);
    content.appendChild(body);
    toast.appendChild(chk);
    toast.appendChild(content);
    stack.appendChild(toast);

    // Auto-fermeture
    const closeAndRemove = () => {
      chk.checked = true;
      setTimeout(() => toast.remove(), 220);
    };
    if (duration > 0) setTimeout(closeAndRemove, duration);
    chk.addEventListener("change", () => closeAndRemove());
  };
})();

// === PLAN_INSTALLATION_LIEN ===
// Boutons "Ajouter / Consulter" + conversion Chemin Windows -> URL SharePoint
const BASE_SHAREPOINT =
  "https://lecasierfrancais.sharepoint.com/sites/Production/Documents%20partages/";

// Convertit "C:\...\Production - Documents\DOSSIERS CLIENTS\...\Fichier.pdf"
// en "https://.../Documents%20partages/DOSSIERS%20CLIENTS/.../Fichier.pdf"
function windowsPathToSharepoint(p) {
  if (!p) return "";
  let s = String(p).trim().replace(/^"+|"+$/g, "");   // enlève les guillemets
  s = s.replace(/\\/g, "/");                          // \ -> /
  const lower = s.toLowerCase();

  // ancre "production - documents" (peu importe avant, OneDrive, etc.)
  const anchor = "/production - documents/";
  let pos = lower.indexOf(anchor);

  let rest = "";
  if (pos !== -1) {
    rest = s.substring(pos + anchor.length);
  } else {
    // fallback: à partir de "dossiers clients"
    const idx = lower.indexOf("/dossiers clients/");
    if (idx === -1) return "";
    rest = s.substring(idx + 1);
  }

  const encoded = rest.split("/").map(encodeURIComponent).join("/");
  return BASE_SHAREPOINT + encoded;
}

function openInExternalBrowser(url) {
  if (!url) return;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // 1) si un bridge preload existe
  if (window.electron?.openExternal) {
    try { window.electron.openExternal(url); return; } catch {}
  }
  // 2) si nodeIntegration est actif
  try {
    const { shell } = require("electron");
    shell.openExternal(url);
    return;
  } catch {}

  // 3) fallback web
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
  document.body.appendChild(a); a.click(); a.remove();
}

function initFileLinkField({ inputId, addBtnId, seeBtnId, pickerId, accept }) {
  const inp    = document.getElementById(inputId);
  const btnAdd = document.getElementById(addBtnId);
  const btnSee = document.getElementById(seeBtnId);
  if (!inp || !btnAdd || !btnSee) return;

  // picker dédié (un par champ, pour éviter tout mélange)
  let picker = document.getElementById(pickerId);
  if (!picker) {
    picker = document.createElement("input");
    picker.type = "file";
    picker.id = pickerId;
    picker.accept = accept;
    picker.style.display = "none";
    document.body.appendChild(picker);
  }

  const refreshSee = () => {
    btnSee.style.display = (inp.value && inp.value.trim()) ? "inline-block" : "none";
  };

  // "Ajouter" → ouvre LE picker de CE champ
  if (!btnAdd.dataset.bound) {
    btnAdd.addEventListener("click", () => picker.click());
    btnAdd.dataset.bound = "1";
  }

  // Sélection fichier → convertit CHEMIN Windows → URL SharePoint → remplit CE champ
  if (!picker.dataset.bound) {
    picker.addEventListener("change", () => {
      const f = picker.files && picker.files[0];
      if (!f) return;

      const rawPath = f.path || ""; // Electron expose path ; navigateur: vide
      const web = windowsPathToSharepoint(rawPath);
      if (!web) {
        (typeof showNotif === "function")
          ? showNotif("error", "Chemin non reconnu. Il doit contenir 'Production - Documents'.")
          : alert("Chemin non reconnu. Il doit contenir 'Production - Documents'.");
        return;
      }
      inp.value = web;
      inp.dispatchEvent(new Event("input"));
      refreshSee();
    });
    picker.dataset.bound = "1";
  }

  // Si l’utilisateur colle un chemin Windows → conversion auto sur CE champ
  if (!inp.dataset.boundChange) {
    inp.addEventListener("change", (e) => {
      const v = String(e.target.value || "").trim();
      if (/^[A-Za-z]:\\/.test(v) || v.includes("\\")) {
        const web = windowsPathToSharepoint(v);
        if (web) e.target.value = web;
      }
      refreshSee();
    });
    inp.dataset.boundChange = "1";
  }

  // "Consulter" → ouvre CE champ dans le navigateur par défaut
  if (!btnSee.dataset.bound) {
    btnSee.addEventListener("click", () => openInExternalBrowser(inp.value));
    btnSee.dataset.bound = "1";
  }

  inp.addEventListener("input", refreshSee);
  refreshSee();
}

// ===== Branchements (à faire une seule fois) =====
document.addEventListener("DOMContentLoaded", () => {
  // PLAN_INSTALLATION_LIEN
  initFileLinkField({
    inputId:  "PLAN_INSTALLATION_LIEN",
    addBtnId: "btn-plan-lien-ajouter",
    seeBtnId: "btn-plan-lien-consulter",
    pickerId: "plan-file-picker",
    accept:   ".pdf,application/pdf"
  });

  // CONTRAT_COMMERCANT
  initFileLinkField({
    inputId:  "CONTRAT_COMMERCANT",
    addBtnId: "btn-contrat-ajouter",
    seeBtnId: "btn-contrat-consulter",
    pickerId: "contrat-file-picker",
    accept:   ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
});
function refreshConsultButtons() {
  [
    ["PLAN_INSTALLATION_LIEN", "btn-plan-lien-consulter"],
    ["CONTRAT_COMMERCANT",     "btn-contrat-consulter"],
  ].forEach(([inputId, btnId]) => {
    const inp = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!inp || !btn) return;
    btn.style.display = (inp.value && inp.value.trim()) ? "inline-block" : "none";
  });
}

// --- helpers dynamiques ---
function setStatutValue(targetLabelUpper) {
  const statutEl = document.getElementById("STATUT");
  if (!statutEl) return;
  const T = targetLabelUpper;
  if (statutEl.tagName === "SELECT") {
    const i = Array.from(statutEl.options).findIndex(
      o => ((o.value || o.textContent).trim().toUpperCase() === T)
    );
    if (i >= 0) statutEl.selectedIndex = i; else statutEl.value = T;
  } else {
    statutEl.value = T;
  }
}

function forceLivreeIfDateFilled() {
  const dateLivEl = document.getElementById("DATE_LIVRAISON");
  if (!dateLivEl) return;
  if ((dateLivEl.value || "").trim()) setStatutValue("LIVREE");
}

async function stampForCurrentStatus() {
  // tamponne la date côté DB uniquement en édition
  const n = window.currentOrderN;
  if (!n) return;

  const statutEl = document.getElementById("STATUT");
  if (!statutEl) return;
  const label = (statutEl.tagName === "SELECT")
    ? (statutEl.selectedOptions[0]?.textContent || statutEl.value || "")
    : (statutEl.value || "");
  const s = label.trim().toUpperCase();

  let action = null;
  if (s === "EN PRODUCTION") action = "production";
  else if (s === "EN STOCK") action = "stock";
  else if (s === "LIVREE" || s === "LIVRÉE" || s === "LIVRE") action = "livraison";
  if (!action) return;

  const dateLivEl = document.getElementById("DATE_LIVRAISON");
  try {
    await apiPost(`/orders/${n}/status-stamp`, {
      action,
      date_livraison
    });
  } catch (e) {
    console.warn("status-stamp failed:", e);
  }
}

// --- délégation d'événements robuste ---
document.addEventListener("change", (e) => {
  const id = e.target?.id || "";
  if (id === "DATE_LIVRAISON") forceLivreeIfDateFilled();
  if (id === "STATUT") stampForCurrentStatus();
});
document.addEventListener("input", (e) => {
  if (e.target?.id === "DATE_LIVRAISON") forceLivreeIfDateFilled();
});

// Quand on ouvre une commande en édition, on s’assure que les boutons/états sont OK
function afterOpenOrderUIFix() {
  forceLivreeIfDateFilled(); // si une date est déjà là -> forcer LIVREE dans l’UI
}
window.afterOpenOrderUIFix = afterOpenOrderUIFix;



// === Helpers ===

const IDS_DONNEES = [
  // Dictionnaires “généraux”
  "STATUT", "STATUT_EPAPER", "EPAPER",
  "BORNE_DE_COMMANDE", "BATIMENT_MODULAIRE", "MARKETING",

  // RAL (utilisent la clé NOM_COLONNE="RAL")
  "RAL_BDC", "RAL_MODULE",

  // Ajoute ici les autres champs à options (exemples) :
  "TYPE_CONTRAT", "TYPE_DE_CONNEXION", "MODE_PAIEMENT"
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
  if (!tbody) {
    console.warn('[orders] tbody #ordersTableBody introuvable');
    return;
  }

  if (!rows || rows.length === 0) {
    console.log('[orders] renderOrders appelé avec 0 ligne');
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Aucune commande trouvée.</td></tr>`;
    return;
  }

  console.log('[orders] renderOrders appelé avec', rows.length, 'lignes');

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

  // gestion du bouton "..."
  const ordersTbody = document.getElementById('ordersTableBody');
  if (ordersTbody && !ordersTbody.dataset.bound) {
    ordersTbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-n]');
      if (!btn) return;
      const n = btn.getAttribute('data-n');
      console.log('[orders] clic sur bouton "..." N =', n);
      await openOrderForEdit(n);
    });
    ordersTbody.dataset.bound = '1';
  }

  if (window.lucide) lucide.createIcons();

  console.log('[filters] appel setupColumnFilterTriggers depuis renderOrders');
  setupColumnFilterTriggers();

  console.log('[filters] appel applyColumnFilters depuis renderOrders');
  applyColumnFilters();
}


window.currentOrderN = null;
window.currentOrderFilter = window.currentOrderFilter || "";

// --- Filtres de colonnes façon Excel ---------

// --- Filtres de colonnes façon Excel ---------

const columnActiveFilters = {}; // { colIndex: Set(valeurs autorisées) | null }

function setupColumnFilterTriggers() {
  console.log('[filters] setupColumnFilterTriggers() appelé');

  const buttons = document.querySelectorAll(
    '#page-orders table.data-table th .filter-trigger'
  );
  console.log('[filters] nb de flèches trouvées =', buttons.length);

  buttons.forEach((btn, idx) => {
    const colIdx = btn.dataset.colIndex;
    if (btn.dataset.cfBound === '1') {
      console.log('[filters] flèche', idx, '(col', colIdx, ') déjà bindée');
      return;
    }
    btn.dataset.cfBound = '1';
    console.log('[filters] binding flèche', idx, 'pour colIndex =', colIdx);

    btn.addEventListener('click', (e) => {
      console.log('[filters] CLIC sur flèche colIndex =', colIdx);
      e.stopPropagation();
      const colIndex = Number(colIdx);
      const headerText = btn.parentElement.textContent.trim();
      openColumnFilterPopup(colIndex, headerText, btn);
    });
  });

  // on ne pose le listener global "click outside" qu'une seule fois
  if (!setupColumnFilterTriggers._clickOutsideBound) {
    document.addEventListener('click', (evt) => {
      const popup = document.getElementById('columnFilterPopup');
      if (!popup || popup.classList.contains('hidden')) return;
      if (!popup.contains(evt.target)) {
        console.log('[filters] clic en dehors du popup -> fermeture');
        popup.classList.add('hidden');
      }
    });
    setupColumnFilterTriggers._clickOutsideBound = true;
    console.log('[filters] listener global click-outside installé');
  }
}

function openColumnFilterPopup(colIndex, headerLabel, anchorBtn) {
  console.log('[filters] openColumnFilterPopup() colIndex =', colIndex);

  const popup = document.getElementById("columnFilterPopup");
  if (!popup) {
    console.warn("[filters] #columnFilterPopup manquant");
    return;
  }

  // === 1) Récupérer les valeurs ===
  const bodyRows = Array.from(document.querySelectorAll("#ordersTableBody tr"));
  const valuesSet = new Set();

  bodyRows.forEach(tr => {
    const cell = tr.cells[colIndex];
    if (cell) {
      const txt = cell.textContent.trim();
      if (txt !== "") valuesSet.add(txt);
    }
  });

  const values = Array.from(valuesSet).sort((a, b) =>
    a.localeCompare(b, "fr", { sensitivity: "base" })
  );

  const currentFilter = columnActiveFilters[colIndex] || null;

  // === 2) Construction HTML ===
  popup.innerHTML = `
    <div class="cf-header">${headerLabel}</div>

    <div class="cf-search">
      <input type="text" placeholder="Rechercher">
    </div>

    <div class="cf-list">
      <label>
        <input type="checkbox" data-value="__ALL__"> (Tout sélectionner)
      </label>
      ${values
        .map(v => {
          const checked = !currentFilter || currentFilter.has(v) ? "checked" : "";
          return `
          <label data-search-text="${v.toLowerCase()}">
            <input type="checkbox" data-value="${v.replace(/"/g, "&quot;")}" ${checked}>
            ${v}
          </label>`;
        })
        .join("")}
    </div>

    <div class="cf-footer">
      <button class="btn btn-outline btn-sm" data-action="clear">Effacer</button>
      <button class="btn btn-primary btn-sm" data-action="ok">OK</button>
    </div>
  `;

  // === 3) Forcer affichage temporaire pour mesurer correctement ===
  popup.style.visibility = "hidden";
  popup.classList.remove("hidden");
  popup.style.display = "block";

  // largeur réelle du popup
  const popupWidth = popup.offsetWidth;
  console.log("Popup width =", popupWidth);

  popup.style.visibility = "visible"; // ré-afficher normalement

  // === 4) Position ADAPTATIVE droite/gauche ===
  const rect = anchorBtn.getBoundingClientRect();
  const margin = 10;

  let left = rect.left + window.scrollX - 20;   // position normale à droite
  let top = rect.bottom + window.scrollY + 8;

  const screenWidth = window.innerWidth;

  // Si dépasse à droite → passer à gauche
  if (left + popupWidth + margin > screenWidth) {
    left = rect.right + window.scrollX - popupWidth + 20;
  }

  // Si dépasse à gauche → marge minimale
  if (left < margin) left = margin;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  console.log("Popup → left:", left, "top:", top);

  // === 5) Gestion des cases ===
  const listDiv = popup.querySelector(".cf-list");
  const allBox = listDiv.querySelector('input[data-value="__ALL__"]');

  const getItemCheckboxes = () =>
    listDiv.querySelectorAll('input[type="checkbox"]:not([data-value="__ALL__"])');

  function syncAllCheckbox() {
    const items = Array.from(getItemCheckboxes());
    allBox.checked = items.every(cb => cb.checked);
  }

  listDiv.addEventListener("change", e => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement)) return;

    if (cb.dataset.value === "__ALL__") {
      const checked = cb.checked;
      getItemCheckboxes().forEach(item => (item.checked = checked));
    } else {
      syncAllCheckbox();
    }
  });

  syncAllCheckbox();

  // === 6) Recherche ===
  const searchInput = popup.querySelector(".cf-search input");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    listDiv.querySelectorAll("label[data-search-text]").forEach(lbl => {
      lbl.style.display = lbl.dataset.searchText.includes(q) ? "" : "none";
    });
  });

  // === 7) Boutons OK / Effacer ===
  popup.querySelector('[data-action="ok"]').onclick = () => {
    const selected = new Set();
    getItemCheckboxes().forEach(cb => {
      if (cb.checked) selected.add(cb.dataset.value);
    });

    if (selected.size === values.length || selected.size === 0) {
      columnActiveFilters[colIndex] = null;
    } else {
      columnActiveFilters[colIndex] = selected;
    }

    popup.classList.add("hidden");
    applyColumnFilters();
  };

  popup.querySelector('[data-action="clear"]').onclick = () => {
    columnActiveFilters[colIndex] = null;
    popup.classList.add("hidden");
    applyColumnFilters();
  };
}


function applyColumnFilters() {
  const rows = Array.from(document.querySelectorAll('#ordersTableBody tr'));

  rows.forEach(tr => {
    let visible = true;

    Object.entries(columnActiveFilters).forEach(([idxStr, set]) => {
      if (!visible) return;
      if (!set || set.size === 0) return;

      const idx = Number(idxStr);
      const cell = tr.cells[idx];
      if (!cell) return;

      const txt = cell.textContent.trim();
      if (!set.has(txt)) visible = false;
    });

    tr.style.display = visible ? '' : 'none';
  });

  // mettre à jour l'état visuel des flèches
  document
    .querySelectorAll('#page-orders table.data-table th .filter-trigger')
    .forEach(btn => {
      const idx = Number(btn.dataset.colIndex);
      const hasFilter = !!(columnActiveFilters[idx] && columnActiveFilters[idx].size);
      btn.classList.toggle('is-filtered', hasFilter);
    });
}

// Filtres persistants
let currentStatusFilter    = '';
let currentMarketingFilter = '';
let currentSearchQuery     = '';
let allOrders = [];

async function loadOrders({ status, marketing, q, limit = 500, offset = 0 } = {}) {

    if (status    !== undefined) currentStatusFilter    = status;
    if (marketing !== undefined) currentMarketingFilter = marketing;
    if (q         !== undefined) currentSearchQuery     = q;

    const params = new URLSearchParams();

    // Statut (API)
    if (Array.isArray(currentStatusFilter) && currentStatusFilter.length > 0) {
        params.set("status", currentStatusFilter.join(","));
    } else if (typeof currentStatusFilter === "string" && currentStatusFilter.trim() !== "") {
        params.set("status", currentStatusFilter.trim());
    }

    // Marketing (API)
    if (currentMarketingFilter) {
        params.set("marketing", currentMarketingFilter);
    }

    params.set("limit",  String(limit));
    params.set("offset", String(offset));

    const data = await apiGet(`/orders?` + params.toString());
    if (!data || !data.ok) throw new Error(data?.error || "Erreur API /orders");

    allOrders = data.rows || [];

    applyOrdersFilter();
}

function applySearchFilter() {
    let rows = allOrders;

    if (currentSearchQuery) {
        const q = currentSearchQuery.toLowerCase();

        rows = rows.filter(row =>
            (row.STATUT       && row.STATUT.toLowerCase().includes(q)) ||
            (row.N_CLIENT     && row.N_CLIENT.toString().includes(q)) ||
            (row.NOM_CLIENT   && row.NOM_CLIENT.toLowerCase().includes(q)) ||
            (row.CONTACT      && row.CONTACT.toLowerCase().includes(q))
        );
    }

    renderOrders(rows);
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
  window.currentOrderFilter = filterKey || "";

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
    await loadOrders();       // recharge les données brutes
    applyOrdersFilter();      // applique filtre (statut + marketing + recherche)
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
    currentOrderFilter = f;

    // API ne filtre PAS par statut
    loadOrders().then(() => {
        applyOrdersFilter(); // ← filtre local correct !
    });
  });
});


// === Recherche locale + (option) déclenchement serveur ===
const ordersSearch = document.getElementById('orders-search');
if (ordersSearch) {
    ordersSearch.addEventListener('input', function () {
        currentSearchQuery = this.value.trim().toLowerCase();
        applySearchFilter();   // ← OBLIGATOIRE
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

window.addEventListener("load", () => {
    if (typeof openOrderForEdit === "function") {
        window.openOrderForEdit = openOrderForEdit;
    }
});

console.log('Le Casier Français ERP initialized');


// === ROBUSTE: /donnees -> selects ==============================
async function populateSelectFromDonneesById(id, force = false) {
  try {
    // attendre le token si nécessaire
    const waitToken = async () => {
      let tries = 0;
      while (!window.APP_TOKEN && tries < 50) { await new Promise(r => setTimeout(r, 30)); tries++; }
    };
    await waitToken();

    const sel = (typeof ensureSelectForId === "function") ? ensureSelectForId(id) : (typeof ensureSelect === "function" ? ensureSelect(id) : null);
    if (!sel) { console.warn("[donnees] Champ introuvable :", id); return; }

    const key = (typeof donneesKeyFor === "function") ? donneesKeyFor(id) : id;

    let values = (typeof fetchDonneesValues === "function")
      ? await fetchDonneesValues(key, force)
      : [];

    // Fallbacks booléens si backend vide
    const BOOLISH = new Set(["EPAPER","BORNE_DE_COMMANDE","BATIMENT_MODULAIRE","MARKETING"]);
    if ((!values || values.length === 0) && BOOLISH.has(id)) {
      values = ["OUI","NON"];
    }

    const prev = (sel.dataset && sel.dataset._prev) ? sel.dataset._prev : (sel.value || "");
    sel.innerHTML = `<option value="">-- Sélectionner --</option>`;
    for (const v of (values || [])) {
      const s = String(v);
      sel.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
    }

    if (prev && Array.from(sel.options).some(o => (o.value || o.textContent) == prev)) {
      sel.value = prev;
    } else if (prev) {
      sel.insertAdjacentHTML("beforeend", `<option value="${prev}">${prev}</option>`);
      sel.value = prev;
    }
    if (sel.dataset) delete sel.dataset._prev;

    console.log(`[donnees] ${id} ← ${key}: ${values?.length || 0} valeurs`);

    if ((!values || values.length === 0) && !force) {
      setTimeout(() => populateSelectFromDonneesById(id, true), 120);
    }
  } catch (e) {
    console.warn("populateSelectFromDonneesById failed for", id, e);
  }
}

async function hydrateAllDonneesSelects(force = false) {
  try {
    const ids = (typeof IDS_DONNEES !== "undefined" && Array.isArray(IDS_DONNEES)) ? IDS_DONNEES.slice() : [];
    if (!ids.length) { console.warn("[donnees] IDS_DONNEES vide"); return; }

    // faire en série pour éviter les rafales
    for (const id of ids) {
      await populateSelectFromDonneesById(id, force);
    }

    // re-synchroniser l'UI
    try { if (typeof applyEpaperUI === "function") applyEpaperUI(); } catch {}
    try { if (typeof updateConditionalBlocks === "function") updateConditionalBlocks(); } catch {}
  } catch (e) {
    console.warn("hydrateAllDonneesSelects failed:", e);
  }
}
window.hydrateAllDonneesSelects = hydrateAllDonneesSelects;
// ===============================================================



// === Fixed version of stampForCurrentStatus (replaces earlier one) ===
async function stampForCurrentStatus() {
  const n = window.currentOrderN;
  if (!n) return;

  const statutEl = document.getElementById("STATUT");
  if (!statutEl) return;
  const label = (statutEl.tagName === "SELECT")
    ? (statutEl.selectedOptions[0]?.textContent || statutEl.value || "")
    : (statutEl.value || "");
  const s = label.trim().toUpperCase();

  let action = null;
  if (s === "EN PRODUCTION") action = "production";
  else if (s === "EN STOCK") action = "stock";
  else if (s === "LIVREE" || s === "LIVRÉE" || s === "LIVRE") action = "livraison";
  if (!action) return;

  const dateLivEl = document.getElementById("DATE_LIVRAISON");
  try {
    await apiPost(`/orders/${n}/status-stamp`, {
      action,
      date_livraison: (dateLivEl?.value || "").trim()
    });
  } catch (e) {
    console.warn("status-stamp failed:", e);
  }
}



try { if (!window.apiGet && typeof apiGet === "function") window.apiGet = apiGet; } catch {}
try { if (!window.apiPost && typeof apiPost === "function") window.apiPost = apiPost; } catch {}
try { if (!window.loadAppToken && typeof loadAppToken === "function") window.loadAppToken = loadAppToken; } catch {}
try { if (!window.refreshOrdersList && typeof refreshOrdersList === "function") window.refreshOrdersList = refreshOrdersList; } catch {}



// === AUTO-HYDRATATION PAR CORRESPONDANCE NOM_COLONNE <-> ID ===================

// Normalise un identifiant pour correspondre au NOM_COLONNE (MAJUSCULE, _)
function normalizeColName(str) {
  if (!str) return "";
  const s = String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // supprime accents
    .replace(/[\s\-\/]+/g, "_") // espaces, tirets -> _
    .replace(/[^\w]/g, "") // enlève autres signes
    .toUpperCase();
  return s;
}

// Déduit la clé /donnees à partir de l'ID champ
function guessDonneesKeyForId(id) {
  const n = normalizeColName(id);
  if (/^RAL_/.test(n)) return "RAL";
  // Variantes fréquentes
  if (n === "TYPE_DE_CONNEXION") return "TYPE_DE_CONNEXION";
  return n;
}

// Évalue la liste des IDs candidats dans le DOM
function collectCandidateIds() {
  const els = Array.from(document.querySelectorAll('input[id], select[id], textarea[id]'));
  const ids = new Set();
  for (const el of els) {
    const id = el.id;
    if (!id) continue;
    // on ignore les champs sans intérêt (techniques)
    if (/^(SEARCH|TOKEN|CSRF|SUBMIT)$/i.test(id)) continue;
    ids.add(id);
  }
  return Array.from(ids);
}

// Hydrate automatiquement tous les selects dont l'ID correspond à un NOM_COLONNE disponible
async function hydrateAllDonneesSelects(force = false) {
  try {
    // 0) Assure le token
    if (typeof loadAppToken === "function") { try { await loadAppToken(true); } catch {} }

    const ids = collectCandidateIds();
    if (!ids.length) { console.warn("[donnees:auto] Aucun champ trouvé"); return; }

    // 1) Traite en série pour ne pas surcharger le backend
    for (const id of ids) {
      const key = (typeof donneesKeyFor === "function") ? donneesKeyFor(id) : guessDonneesKeyForId(id);

      let values = [];
      try {
        values = (typeof fetchDonneesValues === "function") ? await fetchDonneesValues(key, force) : [];
      } catch (e) {
        // passe
      }

      // si aucune valeur -> on essaie fallback booléen
      const BOOLISH = new Set(["EPAPER","BORNE_DE_COMMANDE","BATIMENT_MODULAIRE","MARKETING","STOCKAGE_CLIENT","CARTE_SIM","KIT_CODE_BARRES","BANDEAU_SOUFFLANT"]);
      if ((!values || values.length === 0) && BOOLISH.has(normalizeColName(id))) {
        values = ["OUI","NON"];
      }

      if (values && values.length) {
        await populateSelectFromDonneesById(id, force);
      }
    }

    // synchronize UI dépendante
    try { if (typeof applyEpaperUI === "function") applyEpaperUI(); } catch {}
    try { if (typeof updateConditionalBlocks === "function") updateConditionalBlocks(); } catch {}

    console.log("[donnees:auto] hydratation terminée.");
  } catch (e) {
    console.warn("hydrateAllDonneesSelects(auto) failed:", e);
  }
}
// === AUTO-HYDRATATION PAR CORRESPONDANCE NOM_COLONNE <-> ID ===================

// Normalise un identifiant pour correspondre au NOM_COLONNE (MAJUSCULE, _)
function normalizeColName(str) {
  if (!str) return "";
  const s = String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // supprime accents
    .replace(/[\s\-\/]+/g, "_")                       // espaces, tirets -> _
    .replace(/[^\w]/g, "")                            // enlève autres signes
    .toUpperCase();
  return s;
}

// Déduit la clé /donnees à partir de l'ID champ
function guessDonneesKeyForId(id) {
  const n = normalizeColName(id);
  if (/^RAL_/.test(n)) return "RAL";
  if (n === "TYPE_DE_CONNEXION") return "TYPE_DE_CONNEXION";
  return n;
}

// Évalue la liste des IDs candidats dans le DOM
function collectCandidateIds() {
  const els = Array.from(document.querySelectorAll("input[id], select[id], textarea[id]"));
  const ids = new Set();
  for (const el of els) {
    const id = el.id;
    if (!id) continue;
    // on ignore les champs techniques
    if (/^(SEARCH|TOKEN|CSRF|SUBMIT)$/i.test(id)) continue;
    ids.add(id);
  }
  return Array.from(ids);
}

// 🔹 cache des colonnes disponibles dans la table `donnees`
let DONNEES_COLS_SET = null;
async function loadDonneesColumns() {
  if (DONNEES_COLS_SET) return DONNEES_COLS_SET;
  try {
    const json = await apiGet("/donnees/cols");
    const cols = Array.isArray(json.cols) ? json.cols : [];
    DONNEES_COLS_SET = new Set(cols.map(c => normalizeColName(c)));
  } catch (e) {
    console.warn("[donnees:auto] Impossible de récupérer /donnees/cols :", e);
    DONNEES_COLS_SET = new Set();
  }
  return DONNEES_COLS_SET;
}

// Hydrate automatiquement tous les selects dont l'ID correspond à un NOM_COLONNE
async function hydrateAllDonneesSelects(force = false) {
  try {
    // 0) Assure le token
    if (typeof loadAppToken === "function") {
      try { await loadAppToken(true); } catch {}
    }

    const ids = collectCandidateIds();
    if (!ids.length) {
      console.warn("[donnees:auto] Aucun champ trouvé");
      return;
    }

    // 1) Récupère la liste des NOM_COLONNE existants une seule fois
    const colsSet = await loadDonneesColumns();

    // Champs booléens qui doivent toujours avoir OUI/NON
    const BOOLISH_IDS = new Set([
      "EPAPER",
      "BORNE_DE_COMMANDE",
      "BATIMENT_MODULAIRE",
      "MARKETING",
      "STOCKAGE_CLIENT",
      "CARTE_SIM",
      "KIT_CODE_BARRES",
      "BANDEAU_SOUFFLANT",
    ]);

    // 2) Ne garder que les IDs qui ont une vraie colonne dans `donnees`
    const todo = [];
    for (const id of ids) {
      const key = (typeof donneesKeyFor === "function") ? donneesKeyFor(id) : guessDonneesKeyForId(id);
      const normKey = normalizeColName(key);
      const normId  = normalizeColName(id);

      if (colsSet.has(normKey) || BOOLISH_IDS.has(normId)) {
        todo.push(id);
      }
    }

    if (!todo.length) {
      console.warn("[donnees:auto] Aucune correspondance ID <-> NOM_COLONNE trouvée");
      return;
    }

    // 3) Hydrate en petites rafales pour être rapide sans exploser le backend
    const CONCURRENCY = 6;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const slice = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(id => populateSelectFromDonneesById(id, force).catch(e => {
          console.warn("[donnees:auto] échec sur", id, e);
        }))
      );
    }

    // 4) synchroniser l’UI dépendante
    try { if (typeof applyEpaperUI === "function") applyEpaperUI(); } catch {}
    try { if (typeof updateConditionalBlocks === "function") updateConditionalBlocks(); } catch {}

    console.log("[donnees:auto] hydratation terminée pour", todo.length, "champs.");
  } catch (e) {
    console.warn("hydrateAllDonneesSelects(auto) failed:", e);
  }
}
window.hydrateAllDonneesSelects = hydrateAllDonneesSelects;
// =============================================================================

let currentOrderFilter = "orders_all";

function applyOrdersFilter() {
    let rows = allOrders;

    // ======================
    // NORMALISATION STATUT
    // ======================
    function normalize(str) {
        return (str || "")
            .toString()
            .toUpperCase()
            .normalize("NFD")                 // supprime accents
            .replace(/[\u0300-\u036f]/g, ""); // ex : "LIVRÉE" → "LIVREE"
    }

    // ======================
    // 1) FILTRE STATUT
    // ======================
    const filterList = ORDER_STATUS_FILTERS[currentOrderFilter];

    if (filterList) {
        rows = rows.filter(r => {
            const status = normalize(r.STATUT);
            return filterList.includes(status);
        });
    }

    // ======================
    // 2) FILTRE MARKETING = OUI
    // ======================
    if (currentOrderFilter === "orders_marketing") {
        rows = rows.filter(r =>
            normalize(r.MARKETING) === "OUI"
        );
    }

    // ======================
    // 3) FILTRE RECHERCHE
    // ======================
    if (currentSearchQuery) {
        const q = currentSearchQuery.toLowerCase();

        rows = rows.filter(row =>
            (row.STATUT      && row.STATUT.toLowerCase().includes(q)) ||
            (row.N_CLIENT    && row.N_CLIENT.toString().includes(q)) ||
            (row.NOM_CLIENT  && row.NOM_CLIENT.toLowerCase().includes(q)) ||
            (row.CONTACT     && row.CONTACT.toLowerCase().includes(q)) ||
            (row.REF_BDC     && row.REF_BDC.toLowerCase().includes(q)) ||
            (row.REF_MODULE  && row.REF_MODULE.toLowerCase().includes(q))
        );
    }

    // ======================
    // 4) AFFICHAGE FINAL
    // ======================
    renderOrders(rows);
}

function makeComboBox(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // Cache le select
  select.style.display = "none";

  // Crée l'input
  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-control";
  input.placeholder = "Tapez ou sélectionnez...";
  input.autocomplete = "off";

  // Insère l’input avant le select
  select.parentNode.insertBefore(input, select);

  // Crée la liste filtrée
  const list = document.createElement("div");
  list.className = "combo-list";
  list.style.position = "absolute";
  list.style.zIndex = "9999";
  list.style.border = "1px solid #ccc";
  list.style.background = "white";
  list.style.display = "none";
  list.style.maxHeight = "180px";
  list.style.overflowY = "auto";
  list.style.width = "100%";

  select.parentNode.appendChild(list);

  // Récupère la liste des options du select
  const options = Array.from(select.options).map(o => o.textContent.trim());

  function filterList() {
    const val = input.value.toUpperCase();
    list.innerHTML = "";

    const filtered = options.filter(opt =>
      opt.toUpperCase().includes(val)
    );

    filtered.forEach(opt => {
      const item = document.createElement("div");
      item.textContent = opt;
      item.className = "combo-item";
      item.style.padding = "6px";
      item.style.cursor = "pointer";
      item.onmouseover = () => item.style.background = "#eee";
      item.onmouseout  = () => item.style.background = "white";

      item.onclick = () => {
        input.value = opt;
        select.value = opt;
        list.style.display = "none";
        input.dispatchEvent(new Event("change"));
      };
      list.appendChild(item);
    });

    list.style.display = filtered.length ? "block" : "none";
  }

  input.addEventListener("input", filterList);
  input.addEventListener("focus", filterList);

  // Permet de taper n’importe quelle valeur
  input.addEventListener("blur", () => {
    select.value = input.value;
    setTimeout(() => list.style.display = "none", 200);
  });

  // SI une valeur existe déjà au chargement ⇒ l’afficher
  if (select.value) input.value = select.value;
}

function makeStyledComboBox(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // Ne pas appliquer deux fois
  if (select.dataset.combobox === "1") return;
  select.dataset.combobox = "1";

  // Conteneur (obligatoire pour bien positionner la liste)
  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";
  wrapper.style.width = "100%";

  // Placer le wrapper devant le select
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  // Cache le select
  select.style.display = "none";

  // Input stylé
  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-input";  // ⭐ ton style
  input.autocomplete = "off";
  input.placeholder = "Tapez ou sélectionnez…";

  wrapper.appendChild(input);

  // Liste dropdown
  const list = document.createElement("div");
  list.className = "combo-list";
  list.style.position = "absolute";
  list.style.left = "0";
  list.style.right = "0";
  list.style.top = "100%";
  list.style.background = "#fff";
  list.style.border = "1px solid #e7e9ee";
  list.style.borderRadius = "10px";
  list.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
  list.style.maxHeight = "240px";
  list.style.overflowY = "auto";
  list.style.display = "none";
  list.style.zIndex = "999";

  wrapper.appendChild(list);

  // Options du select
  const options = Array.from(select.options).map(o => o.textContent.trim());

  function filterList() {
    const val = input.value.toUpperCase();
    list.innerHTML = "";

    const filtered = options.filter(opt =>
      opt.toUpperCase().includes(val)
    );

    filtered.forEach(opt => {
      const div = document.createElement("div");
      div.textContent = opt;
      div.style.padding = "10px 12px";
      div.style.cursor = "pointer";
      div.style.fontSize = "14px";
      div.style.borderBottom = "1px solid #f0f0f0";

      div.onmouseover = () => div.style.background = "#f7f8fa";
      div.onmouseout = () => div.style.background = "#fff";

      div.onclick = () => {
        input.value = opt;
        select.value = opt;
        list.style.display = "none";
        input.dispatchEvent(new Event("change"));
      };

      list.appendChild(div);
    });

    list.style.display = filtered.length ? "block" : "none";
  }

  input.addEventListener("input", filterList);
  input.addEventListener("focus", filterList);

  input.addEventListener("blur", () => {
    select.value = input.value;
    setTimeout(() => (list.style.display = "none"), 200);
  });

  // Valeur initiale
  if (select.value) input.value = select.value;
}

// ===============================
// Filtre "NOM CLIENT" façon Excel
// ===============================

function setupColumnFilterTriggers() {
  const buttons = document.querySelectorAll('#page-orders table.data-table thead .filter-trigger');
  buttons.forEach(btn => {
    if (btn.dataset.cfBound === '1') return;
    btn.dataset.cfBound = '1';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const colIndex = Number(btn.dataset.colIndex);
      const headerText = (btn.parentElement.childNodes[0]?.textContent || '').trim();
      openColumnFilterPopup(colIndex, headerText, btn);
    });
  });

  if (!setupColumnFilterTriggers._outsideBound) {
    document.addEventListener('click', (evt) => {
      const popup = document.getElementById('columnFilterPopup');
      if (popup && !popup.classList.contains('hidden') && !popup.contains(evt.target)) {
        popup.classList.add('hidden');
      }
    });
    setupColumnFilterTriggers._outsideBound = true;
  }
}

function openColumnFilterPopup(colIndex, headerLabel, anchorBtn) {
    const popup = document.getElementById("columnFilterPopup");
    if (!popup) return;

    // === (A) Sécurité : le popup doit ABSOLUMENT être dans <body> ===
    if (popup.parentElement !== document.body) {
        document.body.appendChild(popup);
    }

    // === 1) Récupération des valeurs distinctes de la colonne ===
    const valuesSet = new Set();
    document.querySelectorAll("#ordersTableBody tr").forEach(tr => {
        const cell = tr.cells[colIndex];
        if (cell) {
            const txt = cell.textContent.trim();
            if (txt !== "") valuesSet.add(txt);
        }
    });

    const values = Array.from(valuesSet).sort((a, b) =>
        a.localeCompare(b, "fr", { sensitivity: "base" })
    );

    const currentFilter = columnActiveFilters[colIndex] || null;

    // === 2) Construction du popup ===
    popup.innerHTML = `
        <div class="cf-header">${headerLabel}</div>

        <div class="cf-search">
            <input type="text" placeholder="Rechercher">
        </div>

        <div class="cf-list">
            <label><input type="checkbox" data-value="__ALL__"> (Tout sélectionner)</label>
            ${values
                .map(v => `
                    <label data-search-text="${v.toLowerCase()}">
                        <input type="checkbox"
                               data-value="${v.replace(/"/g, "&quot;")}"
                               ${!currentFilter || currentFilter.has(v) ? "checked" : ""}>
                        ${v}
                    </label>
                `)
                .join("")}
        </div>

        <div class="cf-footer">
            <button type="button" class="btn btn-outline btn-sm" data-action="clear">Effacer</button>
            <button type="button" class="btn btn-primary btn-sm" data-action="ok">OK</button>
        </div>
    `;

    // === 3) Gestion recherche ===
    const searchInput = popup.querySelector(".cf-search input");
    const labels = popup.querySelectorAll(".cf-list label[data-search-text]");

    searchInput.oninput = () => {
        const q = searchInput.value.toLowerCase();
        labels.forEach(lbl => {
            lbl.style.display = lbl.dataset.searchText.includes(q) ? "" : "none";
        });
    };

    // === 4) Tout sélectionner ===
    const allBox = popup.querySelector('input[data-value="__ALL__"]');

    allBox.onchange = () => {
        const checked = allBox.checked;
        popup
            .querySelectorAll('.cf-list input[type="checkbox"]:not([data-value="__ALL__"])')
            .forEach(cb => (cb.checked = checked));
    };

    // === 5) Bouton OK ===
    popup.querySelector('[data-action="ok"]').onclick = () => {
        const selected = new Set(
            [...popup.querySelectorAll('.cf-list input[type="checkbox"]:not([data-value="__ALL__"])')]
                .filter(cb => cb.checked)
                .map(cb => cb.getAttribute("data-value"))
        );

        if (selected.size === values.length || selected.size === 0) {
            columnActiveFilters[colIndex] = null;
        } else {
            columnActiveFilters[colIndex] = selected;
        }

        popup.classList.add("hidden");
        applyColumnFilters();
    };

    // === 6) Bouton Effacer ===
    popup.querySelector('[data-action="clear"]').onclick = () => {
        columnActiveFilters[colIndex] = null;
        popup.classList.add("hidden");
        applyColumnFilters();
    };

    // === 7) Position du popup - affichage temporaire pour mesurer ===
    popup.classList.remove("hidden");
    popup.style.visibility = "hidden";
    popup.style.display = "block";

    const popupWidth = popup.offsetWidth;
    const popupHeight = popup.offsetHeight;

    popup.style.visibility = "visible";

    const rect = anchorBtn.getBoundingClientRect();
    const margin = 10;

    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 4;

    // === ADAPTATION horizontale ===
    const screenWidth = window.innerWidth;

    // S'il dépasse à droite → on le met à gauche
    if (left + popupWidth + margin > screenWidth) {
        left = rect.right + window.scrollX - popupWidth;
    }

    // Anti-dépassement gauche
    if (left < margin) left = margin;

    // === ADAPTATION verticale si nécessaire ===
    const screenHeight = window.innerHeight;
    if (top + popupHeight > screenHeight - margin) {
        top = rect.top + window.scrollY - popupHeight - 4; // afficher au-dessus
    }

    // === Appliquer la position ===
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    popup.style.display = "block";
}


function applyColumnFilters() {
  document.querySelectorAll('#ordersTableBody tr').forEach(tr => {
    let visible = true;
    for (const [idxStr, set] of Object.entries(columnActiveFilters)) {
      if (!set || set.size === 0) continue;
      const idx = Number(idxStr);
      const txt = tr.cells[idx]?.textContent.trim() || '';
      if (!set.has(txt)) { visible = false; break; }
    }
    tr.style.display = visible ? '' : 'none';
  });

  // état visuel des flèches
  document.querySelectorAll('#page-orders table.data-table thead .filter-trigger').forEach(btn => {
    const idx = Number(btn.dataset.colIndex);
    const active = !!(columnActiveFilters[idx] && columnActiveFilters[idx].size);
    btn.classList.toggle('is-filtered', active);
  });
}


console.log('[init] index.js chargé');

document.addEventListener('DOMContentLoaded', () => {
  console.log('[init] DOMContentLoaded déclenché');
});

// Lancement à la fin du chargement de la page
document.addEventListener("DOMContentLoaded", initClientNameFilter);
