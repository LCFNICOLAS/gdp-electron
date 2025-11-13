window.API =
  window.API ||
  (window.cfg && window.cfg.API_BASE) ||
  process.env?.BACKEND_BASE ||
  "https://api-tonnas.synology.me:8443";

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

// Fonction COMMUNE appelée à chaque tick (toutes les 10-15 secondes)
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
      // a) Si un formulaire de commande est ouvert
      if (window.currentOrderN) {
        // Si l'utilisateur est en train d'écrire → on ne touche à rien pour ne pas écraser
        if (window.isOrderFormDirty) return;

        // Sinon, on recharge cette commande depuis la BD
        if (typeof window.openOrderForEdit === "function") {
          await window.openOrderForEdit(window.currentOrderN);
        }

      // b) Sinon, on recharge la liste des commandes
      } else if (typeof window.loadOrders === "function") {
        await window.loadOrders();
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

// Démarrage automatique quand l'UI est prête
document.addEventListener("DOMContentLoaded", () => {
  startGlobalAutoRefresh();
});

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

async function saveOrder() {
  // Vérif mini côté front
  const nClient   = document.getElementById("N_CLIENT")?.value?.trim() || "";
  const nomClient = document.getElementById("NOM_CLIENT")?.value?.trim() || "";
  if (!window.currentOrderN && (!nClient || !nomClient)) {
    showNotif("error", "Renseigne N_CLIENT et NOM_CLIENT avant d’enregistrer.");
    return;
  }

  // Collecte de tous les champs de la modale
  const data = {};
  document
    .querySelectorAll('#orderModal input, #orderModal textarea, #orderModal select')
    .forEach(el => {
      if (!el.id) return;
      data[el.id] = (el.value ?? "").toString().trim();
    });

  // Normalisation EPAPER
  const ep = (data.EPAPER || "").toUpperCase();
  data.EPAPER = ep;
  if (ep === "NON") {
    data.QTE_EPAPER = "";
    data.STATUT_EPAPER = "";
  }

  // Format montant -> DB "1234.56"
  if (data.MONTANT_HT !== undefined) {
    const dbVal = amountToDB(data.MONTANT_HT);
    data.MONTANT_HT = dbVal || ""; // vide si invalide
  }

  const method = window.currentOrderN ? "PUT" : "POST";
  const url = window.currentOrderN ? `${API}/orders/${window.currentOrderN}` : `${API}/orders`;

  // Nettoyage champs vides sauf trio EPAPER en PUT
  if (method === "PUT") {
    const keepEmpty = new Set(["EPAPER", "QTE_EPAPER", "STATUT_EPAPER"]);
    Object.keys(data).forEach(k => {
      if (data[k] === "" && !keepEmpty.has(k)) delete data[k];
    });
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
      headers: {
        "Content-Type": "application/json",
        "X-Client-PC": pcName
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
  const ral_bdc    = (document.getElementById("RAL_BDC")?.value || "").trim().toUpperCase();
  const ral_module = (document.getElementById("RAL_MODULE")?.value || "").trim().toUpperCase();
  const livraisonEl = document.getElementById("LIVRAISON_PREVUE");
  if (!livraisonEl) return;

  // En édition (commande existante) : ne rien modifier
  if (window.currentOrderN) return;

  const today = new Date();
  let weeksToAdd = 12;
  if (ral_bdc === "RAL 9003 BLANC" && ral_module === "RAL 9003 BLANC") {
    weeksToAdd = 10;
  }

  let livraison = new Date(today);
  livraison.setDate(today.getDate() + weeksToAdd * 7);

  // Si la date tombe dans les 3 premières semaines d’août → +3 semaines
  if (livraison.getMonth() === 7 && livraison.getDate() <= 21) {
    livraison.setDate(livraison.getDate() + 3 * 7);
  }

  // ✅ on écrit réellement la valeur calculée dans le champ
  livraisonEl.value = dateToDDMMYYYY(livraison);

  // Met à jour la date d'ajout au planning (format FR)
  const dp = document.getElementById("DATE_PLANNING");
  if (dp) dp.value = dateToDDMMYYYY(today);
}


// Déclenche recalcul si RAL change
["RAL_BDC", "RAL_MODULE"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", calculerLivraisonPrevue);
});

// Quand on ouvre une nouvelle commande → initialise les dates
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
  await window.hydrateAllDonneesSelects();
  applyEpaperUI();
  calculerLivraisonPrevue();
  calcQteEpaper();

  // ✅ Forcer STATUT = EN ATTENTE après ouverture
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
  }
  refreshConsultButtons();
  // ✅ Mettre à jour les blocs conditionnels au démarrage
  if (typeof updateConditionalBlocks === "function") updateConditionalBlocks();
}

function updateConditionalBlocks() {
  // === Borne de commande ===
  const borneSelect  = document.getElementById('BORNE_DE_COMMANDE');
  const borneOptions = document.getElementById('borne-options'); // grille RAL/MP/Type co./Code-barres
  const borneCard    = borneSelect?.closest('.card');
  const borneRow     = borneCard?.querySelector('.row-2cols');   // rangée EPAPER + Contrat

  const showBDC = (borneSelect?.value || '').trim().toUpperCase() === 'OUI';

  [borneOptions, borneRow].forEach(block => {
    if (!block) return;
    // compat .visible (script inline) + compat display
    block.classList.toggle('visible', showBDC);
    block.style.display = showBDC ? '' : 'none';
    block.querySelectorAll('input, select, textarea').forEach(el => {
      el.disabled = !showBDC;
      if (!showBDC) el.value = '';
    });
  });

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
}

document.addEventListener('DOMContentLoaded', () => {
  const borneSelect = document.getElementById('BORNE_DE_COMMANDE');
  const batSelect   = document.getElementById('BATIMENT_MODULAIRE');
  const mktSelect   = document.getElementById('MARKETING');

  borneSelect?.addEventListener('change', updateConditionalBlocks);
  batSelect?.addEventListener('change', updateConditionalBlocks);
  mktSelect?.addEventListener('change', updateConditionalBlocks);

  // s’assure que l’état est bon à l’ouverture
  setTimeout(updateConditionalBlocks, 100);
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
  const res = await fetch(`${API}/orders/${n}`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

  // 2) remplit les champs bruts
  const row = data.row || {};
  Object.entries(row).forEach(([key, value]) => {
    const el = document.getElementById(key);
    if (!el) return;

    if (key === "DATE_PLANNING" || key === "LIVRAISON_PREVUE") {
      el.value = normalizeToDDMMYYYY(value);
    } else {
      el.value = value ?? "";
    }
  });

  // 3) ouvre la modale
  if (typeof openModal === "function") openModal("orderModal");
  await new Promise(r => setTimeout(r, 150));

  // 4) coordonnées / carte (si tu as ça chez toi)
  const coordEl = getCoordEl && getCoordEl();
  let coords = coordEl && parseCoords(coordEl.value?.trim());
  if (!coords) {
    coords = { ...DEFAULT_COORDS };
    if (coordEl) coordEl.value = `${coords.lat},${coords.lon}`;
  }
  await afficherCarte(coords.lat, coords.lon);

  // 5) second passage pour formater certains champs (ex: MONTANT_HT en €)
  Object.entries(row).forEach(([key, value]) => {
    const el = document.getElementById(key);
    if (!el) return;

    if (key === "MONTANT_HT") {
      el.value = formatEUR(value);   // "15 230,50 €"
    } else {
      el.value = value ?? "";
    }
  });

  // 6) ré-appliquer l’UI & les selects
  if (typeof hydrateAllDonneesSelects === "function") await hydrateAllDonneesSelects();
  if (typeof applyEpaperUI === "function") applyEpaperUI();
  if (typeof calcQteEpaper === "function") calcQteEpaper();
  if (typeof refreshConsultButtons === "function") refreshConsultButtons();
  if (typeof afterOpenOrderUIFix === "function") afterOpenOrderUIFix();

  // 7) mémorise la commande ouverte + reset du "dirty"
  window.currentOrderN = n;
  window.isOrderFormDirty = false;   // 🔴 IMPORTANT pour l’auto-refresh
}

window.openOrderForEdit = openOrderForEdit;


// Formulaire commande en cours d'édition
window.currentOrderN = window.currentOrderN || null;
window.isOrderFormDirty = window.isOrderFormDirty || false;
window.isOrderFormDirty = false;

// Dès qu'on tape quelque chose dans la modale de commande → dirty = true
document.addEventListener("input", (e) => {
  if (e.target && e.target.closest && e.target.closest("#orderModal")) {
    window.isOrderFormDirty = true;
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
async function fetchDonneesValues(nomColonne) {
  if (DONNEES_CACHE.has(nomColonne)) return DONNEES_CACHE.get(nomColonne);
  try {
    const res = await fetch(`${API}/donnees?nom_colonne=${encodeURIComponent(nomColonne)}`);
    const json = await res.json();
    const values = (json && json.ok && Array.isArray(json.values)) ? json.values : [];
    // dédup + trim
    const cleaned = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
    DONNEES_CACHE.set(nomColonne, cleaned);
    return cleaned;
  } catch (e) {
    console.error("fetchDonneesValues:", nomColonne, e);
    DONNEES_CACHE.set(nomColonne, []);
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


/** Remplit un champ (converti en <select> si besoin) avec donnees.NOM_COLONNE=clé */
async function populateSelectFromDonneesById(id) {
  let el = document.getElementById(id);
  if (!el) return;

  const key = donneesKeyFor(id);
  let values = await fetchDonneesValues(key);

  // ✨ fallback minimal si la table est vide pour certains champs
  if ((!values || !values.length) && id === "EPAPER") values = ["OUI","NON"];

  if (!values.length) return; // rien à hydrater

  el = ensureSelectForId(id);
  if (!el) return;

  const prev = String(el.value || el.dataset._prev || "").trim();
  delete el.dataset._prev;

  el.innerHTML = `<option value="">-- Sélectionner --</option>`;
  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    el.appendChild(opt);
  });

  if (prev) {
    const norm = s => String(s).trim().toUpperCase();
    const match = values.find(v => norm(v) === norm(prev));
    el.value = match ?? (el.appendChild(new Option(prev, prev)), prev);
  }
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

// IDs des champs quantité de modules (comme dans ton HTML)
const MODULE_INPUT_IDS = [
  "10S","14S","14SDV","15S","21S","21SDV","21SPT","24S","28S",
  "10R","14R","14RDV","15R","21R","21RDV","21RPT","24R","28R",
  "21C","21CDV"
];

// Exceptions de taille
const EPAPER_OVERRIDE = { "21SPT": 18, "21RPT": 18 };

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

// Calcule et met à jour #QTE_EPAPER
function calcQteEpaper() {
  let total = 0;
  for (const id of MODULE_INPUT_IDS) {
    total += qtyOf(id) * unitsFor(id);
  }
  const out = document.getElementById("QTE_EPAPER");
  if (out) out.value = String(total);
}

// Branche les écouteurs "input/change" pour recalculer en direct
function setupQteEpaperAuto() {
  for (const id of MODULE_INPUT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input",  calcQteEpaper);
    el.addEventListener("change", calcQteEpaper);
  }
  // calcul initial
  calcQteEpaper();
}

// Au chargement de la page
document.addEventListener("DOMContentLoaded", setupQteEpaperAuto);

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
    const res = await fetch(`${API}/orders/stats`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Erreur stats");

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
    await fetch(`${API}/orders/${n}/status-stamp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        date_livraison: (dateLivEl?.value || "").trim() || null
      })
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
