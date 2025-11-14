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
   CONFIGURATION
   ======================= */
const USE_LOCAL_BACKEND = false;   // true = backend Python local ; false = API distante NAS
const REMOTE_BASE = "https://api-tonnas.synology.me:8443";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 5000;
const LOCAL_BASE = `http://${LOCAL_HOST}:${LOCAL_PORT}`;

const HARDCODED_PYTHON = path.join(__dirname, ".venvHouse", "Scripts", "python.exe");

/* =======================
   HELPERS
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
   PYTHON BACKEND LAUNCH
   ======================= */
function pythonCandidates() {
    const envOverride = process.env.BACKEND_PYTHON || "";
    const list = [];

    if (HARDCODED_PYTHON) list.push({ cmd: HARDCODED_PYTHON, args: [] });
    if (envOverride) list.push({ cmd: envOverride, args: [] });

    list.push({ cmd: "py", args: ["-3.12"] });
    list.push({ cmd: "py", args: ["-3.11"] });
    list.push({ cmd: "py", args: ["-3"] });

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

    for (const cand of pythonCandidates()) {
        try {
            log(`[backend] trying: ${cand.cmd} ${cand.args.join(" ")} ${backendPath}`);
            const p = spawn(cand.cmd, [...cand.args, backendPath], {
                cwd,
                env: { ...process.env, PYTHONUTF8: "1" },
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });

            p.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
            p.stderr.on("data", (d) => process.stderr.write(`[backend:err] ${d}`));

            p.on("exit", (code, sig) => {
                log(`[backend] exited code=${code} sig=${sig || ""}`);
            });

            backendProc = p;
            return p;

        } catch {}
    }
    return null;
}

/* =======================
   ELECTRON
   ======================= */
const iconPath = process.platform === "darwin"
    ? path.join(__dirname, "frontend", "assets", "logo.icns")
    : path.join(__dirname, "frontend", "assets", "logo.ico");

function createWindow(baseUrl) {
    process.env.BACKEND_BASE = baseUrl;

    mainWin = new BrowserWindow({
        width: 1920,
        height: 1080,
        autoHideMenuBar: true,
        icon: iconPath,
        title: "GDP",
        webPreferences: {
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    // Bloquer DevTools en remote only
    if (!USE_LOCAL_BACKEND) {
        mainWin.webContents.on("before-input-event", (event, input) => {
            const isDevToolsShortcut =
                ((input.control || input.meta) && input.shift && input.code === "KeyI") ||
                input.key === "F12";
            if (isDevToolsShortcut) event.preventDefault();
        });
        mainWin.webContents.on("devtools-opened", () => mainWin.webContents.closeDevTools());
    }

    // On charge d’abord loading.html, la watcher choisira la bonne page
    mainWin.loadFile(path.join(__dirname, "frontend", "html", "loading.html"));
    mainWin.maximize();
}

/* =======================
   MAINTENANCE WATCHER
   ======================= */
function startMaintenanceWatcher(baseUrl) {
    if (!mainWin) return;

    const maintenanceFile = path.join(__dirname, "frontend", "html", "maintenance.html");
    const normalFile      = path.join(__dirname, "frontend", "html", "index.html");

    let firstCheckDone = false;
    let lastLoaded = null;

    async function checkStatus() {
        if (!mainWin || mainWin.isDestroyed()) return;

        try {
            // Vérifie /health
            const health = await fetch(baseUrl + "/health");
            if (!health.ok) throw new Error("Backend down");

            // Vérifie GDP_MAINTENANCE
            const r = await fetch(baseUrl + "/gdp/maintenance");
            const data = await r.json();
            if (!data.ok) throw new Error("Maintenance query failed");

            const target = data.STATUT === 1 ? maintenanceFile : normalFile;

            // Pas recharger si déjà sur la bonne page
            if (lastLoaded === target) return;

            lastLoaded = target;
            mainWin.loadFile(target);

            firstCheckDone = true;

        } catch (e) {
            if (!mainWin || mainWin.isDestroyed()) return;

            if (lastLoaded !== maintenanceFile) {
                lastLoaded = maintenanceFile;
                mainWin.loadFile(maintenanceFile);
            }

            firstCheckDone = true;
        }
    }

    // Première vérification immédiate
    checkStatus();

    // Vérification toutes les 15 sec
    setInterval(checkStatus, 15000);
}

/* =======================
   MAIN APP START
   ======================= */
app.whenReady().then(async () => {
    const baseUrl = USE_LOCAL_BACKEND ? LOCAL_BASE : REMOTE_BASE;

    if (USE_LOCAL_BACKEND) {
        startLocalBackend();
        try {
            await waitForApi(`${LOCAL_BASE}/health`, 12000);
        } catch {}
    } else {
        try {
            await waitForApi(`${REMOTE_BASE}/health`, 8000);
        } catch {}
    }

    createWindow(baseUrl);
    startMaintenanceWatcher(baseUrl);
});

/* =======================
   CLEAN EXIT
   ======================= */
app.on("before-quit", () => {
    if (backendProc && !backendProc.killed) {
        try { backendProc.kill(); } catch {}
    }
});

ipcMain.handle("open-external", (_evt, url) => shell.openExternal(url));

