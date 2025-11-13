// main.js
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

let mainWin = null;
let backendProc = null;

/* =======================
   CONFIG "en dur"
   ======================= */
// Choisis ici :
const USE_LOCAL_BACKEND = false;  // true = lance ../backend/main.py ; false = utilise l’API NAS

// URL backend distant (prod)
const REMOTE_BASE = "https://api-tonnas.synology.me:8443";

// Backend local
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 5000;
const LOCAL_BASE = `http://${LOCAL_HOST}:${LOCAL_PORT}`;

// Si tu connais un chemin Python précis, mets-le ici (sinon laisse vide) :
const HARDCODED_PYTHON = "F:\\GDP V3.00\\.venv\\Scripts\\python.exe";


/* =======================
   Helpers
   ======================= */
function waitForApi(url, timeoutMs = 10000) {
  const start = Date.now();
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const client = isHttps ? https : http;

  const options = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    servername: u.hostname,
    timeout: 2500,
  };

  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = client.request(options, (res) => {
        if (res.statusCode === 200) return resolve(true);
        res.resume();
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        setTimeout(ping, 400);
      });
      req.on("timeout", () => { req.destroy(); setTimeout(ping, 400); });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        setTimeout(ping, 400);
      });
      req.end();
    };
    ping();
  });
}

function log(...a) { console.log("[main]", ...a); }

/* =======================
   Spawn backend local (Flask)
   ======================= */
function pythonCandidates() {
  const envOverride = process.env.BACKEND_PYTHON || "";
  const list = [];

  if (HARDCODED_PYTHON) list.push({ cmd: HARDCODED_PYTHON, args: [] });
  if (envOverride) list.push({ cmd: envOverride, args: [] });

  // Windows Python Launcher d’abord (si dispo)
  list.push({ cmd: "py", args: ["-3.12"] });
  list.push({ cmd: "py", args: ["-3.11"] });
  list.push({ cmd: "py", args: ["-3"] });

  // Fallbacks génériques
  list.push({ cmd: "python", args: [] });
  list.push({ cmd: "python3", args: [] });

  return list;
}

function startLocalBackend() {
  const backendPath = path.join(__dirname, "backend", "main.py");
  const cwd = path.dirname(backendPath);

  if (!fs.existsSync(backendPath)) {
    dialog.showErrorBox("Backend introuvable", `Fichier manquant:\n${backendPath}`);
    return null;
  }

  const tried = [];
  for (const cand of pythonCandidates()) {
    try {
      log(`[backend] trying: ${cand.cmd} ${cand.args.join(" ")} ${backendPath}`);
      const p = spawn(cand.cmd, [...cand.args, backendPath], {
        cwd,
        env: { ...process.env, PYTHONUTF8: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let firstLines = "";
      p.stdout.on("data", (d) => {
        const s = d.toString();
        firstLines += s;
        process.stdout.write(`[backend] ${s}`);
      });
      p.stderr.on("data", (d) => {
        const s = d.toString();
        firstLines += s;
        process.stderr.write(`[backend:err] ${s}`);
      });

      p.on("exit", (code, sig) => {
        log(`[backend] exited code=${code} sig=${sig || ""}`);
        if (mainWin && !mainWin.isDestroyed()) {
          try {
            mainWin.webContents.send("backend-exited", { code, sig, firstLines });
          } catch {}
        }
      });

      // S’il démarre, on retourne tout de suite le process
      backendProc = p;
      return p;
    } catch (e) {
      tried.push(`${cand.cmd} ${cand.args.join(" ")}`);
      continue;
    }
  }

  dialog.showErrorBox(
    "Impossible de lancer le backend local",
    [
      "Aucun interpréteur Python valide n’a été trouvé.",
      "",
      "Essais :",
      ...pythonCandidates().map(c => `- ${c.cmd} ${c.args.join(" ")}`),
      "",
      "Solutions :",
      "1) Installe Python 3.12 (recommandé) depuis python.org, coche « Add to PATH ». ",
      "2) Ou installe le « Python Launcher for Windows » et assure-toi que 'py -3.12' fonctionne.",
      "3) Ou définis la variable d’environnement BACKEND_PYTHON avec le chemin de python.exe.",
      "4) Ou mets le chemin dans HARDCODED_PYTHON au début de main.js.",
    ].join("\n")
  );

  return null;
}

/* =======================
   Electron
   ======================= */
function createWindow(baseUrl) {
  process.env.BACKEND_BASE = baseUrl; // lu en preload & renderer

  mainWin = new BrowserWindow({
    width: 1600,
    height: 1000,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "frontend", "assets", "logo.ico"),
    title: "GDP",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWin.loadFile(path.join(__dirname, "frontend", "html", "index.html"));
  mainWin.maximize();
}

ipcMain.handle("open-external", (_evt, url) => shell.openExternal(url));

app.whenReady().then(async () => {
  if (USE_LOCAL_BACKEND) {
    // 1) Démarre Flask local
    const proc = startLocalBackend();
    // 2) Même si le spawn échoue, on tente quand même d’attendre l’API ; sinon on bascule à la fenêtre (le front affichera les erreurs)
    try {
      await waitForApi(`${LOCAL_BASE}/health`, 12000);
      log("Local backend is up.");
    } catch {
      log("Local backend not reachable yet (continuing anyway).");
    }
    createWindow(LOCAL_BASE);
  } else {
    // Distant
    try {
      await waitForApi(`${REMOTE_BASE}/health`, 8000);
    } catch {
      // pas bloquant en prod ; la fenêtre s’ouvrira quand même
    }
    createWindow(REMOTE_BASE);
  }
});

app.on("window-all-closed", () => {
  if (backendProc && !backendProc.killed) {
    try { backendProc.kill(); } catch {}
  }
  app.quit();
});
