# -*- coding: utf-8 -*-
"""
Backend Flask — entête SSH-only
- Connexion MySQL exclusivement via le serveur SSH fourni
- AUCUN mode direct/auto, AUCUN db.conf/UNC
- Pool mysql-connector + watchdog du tunnel
- Compat SQLAlchemy minimale (text/engine)
"""

from __future__ import annotations

# -----------------------------------------------------------
# Imports standard
# -----------------------------------------------------------
import os
import sys
import io
import re
import time
import json
import threading
from pathlib import Path
from datetime import datetime as _dt, date, datetime, timedelta
import traceback as _tb
from typing import TYPE_CHECKING, Optional, Any
import secrets


# -----------------------------------------------------------
# TOKEN
# -----------------------------------------------------------

APP_SECRET_TOKEN = secrets.token_hex(32)  # token aléatoire sécurisé (64 caractères hex)
print("[SECURITY] Token généré :", APP_SECRET_TOKEN, flush=True)

# -----------------------------------------------------------
# UTF-8 robuste stdout/stderr
# -----------------------------------------------------------
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# -----------------------------------------------------------
# Logging vers %PROGRAMDATA%\RebutLCF\backend.log
# -----------------------------------------------------------
_LOG_DIR = Path(os.getenv("PROGRAMDATA", "")) / "RebutLCF"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = _LOG_DIR / "backend.log"

def _log(msg: str, exc: Exception | None = None) -> None:
    try:
        with _LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"[{_dt.now():%Y-%m-%d %H:%M:%S}] {msg}\n")
            if exc:
                f.write(_tb.format_exc() + "\n")
    except Exception:
        pass

# -----------------------------------------------------------
# Flask
# -----------------------------------------------------------
from flask import Flask, jsonify, request, g
from flask_cors import CORS
app = Flask(__name__)
CORS(app)

# -----------------------------------------------------------
# Réseau utilitaire
# -----------------------------------------------------------
import socket as _sock

def _check_tcp(host: str, port: int, timeout: float = 2.5) -> bool:
    try:
        with _sock.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False

def _resolve(host: str) -> tuple[bool, str | None]:
    try:
        _sock.gethostbyname(host)
        return True, None
    except Exception as e:
        return False, repr(e)

def _wait_port(host: str, port: int, timeout_s: float = 10.0) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if _check_tcp(host, port, 1.0):
            return True
        time.sleep(0.25)
    return False

# -----------------------------------------------------------
# MySQL + SSH (SSH-ONLY)
# -----------------------------------------------------------
try:
    import mysql.connector
    from mysql.connector import pooling
except Exception as e:  # pragma: no cover
    mysql = None  # type: ignore
    pooling = None  # type: ignore
    _log("MYSQL_IMPORT_FAIL", e)

if TYPE_CHECKING:
    from mysql.connector import pooling as _pooling
    from sshtunnel import SSHTunnelForwarder as _SSHTunnelForwarder
else:
    _pooling = Any            # type: ignore
    _SSHTunnelForwarder = Any # type: ignore

# ---- Paramètres: charge depuis l'environnement (pas de fallback secrets) ----
# ---- Paramètres: 100% depuis l'environnement (aucun fallback secret) ----
SSH_HOST = os.getenv("SSH_HOST", "api-tonnas.synology.me")
SSH_PORT = int(os.getenv("SSH_PORT", "62451"))
SSH_USER = os.getenv("SSH_USER", "nicolas mazurek")
SSH_PASS = os.getenv("SSH_PASS", "LCf_440053_+")
SSH_PKEY = (os.getenv("SSH_PKEY") or "").strip()                      # optionnel
SSH_PKEY_PASSPHRASE = (os.getenv("SSH_PKEY_PASSPHRASE") or "").strip()# optionnel

MYSQL_HOST = os.getenv("MYSQL_HOST", "192.168.1.2")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", "3306"))
MYSQL_DB   = os.getenv("MYSQL_DB",  "DATABASE_LCF")
MYSQL_USER = os.getenv("MYSQL_USER","appuser1")
MYSQL_PWD  = os.getenv("MYSQL_PWD", os.getenv("MYSQL_PASSWORD", "6o@f8!ln507!EnTK"))
# plugin d'auth : ok d'avoir une valeur par défaut non sensible
MYSQL_AUTH_PLUGIN = (os.getenv("MYSQL_AUTH_PLUGIN") or "mysql_native_password").strip()

# Validation stricte (SSH-only)
_missing = [k for k,v in {
    "SSH_HOST":SSH_HOST, "SSH_PORT":SSH_PORT, "SSH_USER":SSH_USER,
    "MYSQL_HOST":MYSQL_HOST, "MYSQL_PORT":MYSQL_PORT, "MYSQL_DB":MYSQL_DB,
    "MYSQL_USER":MYSQL_USER, "MYSQL_PWD":MYSQL_PWD
}.items() if (str(v).strip()=="" or str(v)=="0")]
if _missing:
    raise RuntimeError(f"Variables manquantes: {', '.join(_missing)}")

# sshtunnel import (à la demande)
try:
    from sshtunnel import SSHTunnelForwarder  # type: ignore
except Exception:  # pragma: no cover
    SSHTunnelForwarder = None  # type: ignore

def _require_sshtunnel() -> None:
    global SSHTunnelForwarder
    if SSHTunnelForwarder is None:
        try:
            from sshtunnel import SSHTunnelForwarder as _SSF  # type: ignore
            SSHTunnelForwarder = _SSF
        except Exception as e:
            _log(f"SSHTUNNEL_IMPORT_FAIL: exe={sys.executable} PATH={os.environ.get('PATH','')}")
            raise RuntimeError("sshtunnel manquant — pip install sshtunnel") from e

def _require_mysql() -> None:
    if pooling is None:
        raise RuntimeError("mysql-connector-python manquant — pip install mysql-connector-python")

POOL: 'Optional[_pooling.MySQLConnectionPool]' = None
_tunnel: 'Optional[_SSHTunnelForwarder]' = None
_last_tunnel_err: Optional[str] = None
_tunnel_lock = threading.Lock()
_watchdog_started = False

# Support éventuel de clé privée via paramiko (facultatif)
try:
    import paramiko  # type: ignore
except Exception:
    paramiko = None  # type: ignore

def _load_pkey(path: str, passphrase: str | None):
    if not path or not os.path.exists(path) or paramiko is None:
        return None
    for KeyCls in (paramiko.RSAKey, getattr(paramiko, "Ed25519Key", None), getattr(paramiko, "ECDSAKey", None)):
        if not KeyCls:
            continue
        try:
            return KeyCls.from_private_key_file(path, password=(passphrase or None))
        except Exception:
            continue
    return None

def start_tunnel() -> Optional[_SSHTunnelForwarder]:
    """(Re)démarre le tunnel SSH → MySQL. Mode SSH *uniquement*."""
    global _tunnel, _last_tunnel_err
    _require_sshtunnel()

    with _tunnel_lock:
        if _tunnel and getattr(_tunnel, "is_active", False):
            return _tunnel

        ok_dns, err_dns = _resolve(SSH_HOST)
        if not ok_dns:
            _last_tunnel_err = f"DNS_RESOLVE_FAIL({SSH_HOST}): {err_dns}"
            _log(_last_tunnel_err)
            return None

        # Prépare auth pkey si fournie
        ssh_pkey_obj = _load_pkey(SSH_PKEY, SSH_PKEY_PASSPHRASE) if SSH_PKEY else None
        try:
            t = SSHTunnelForwarder(
                (SSH_HOST, SSH_PORT),
                ssh_username=SSH_USER,
                ssh_password=None if ssh_pkey_obj else (SSH_PASS or None),
                ssh_pkey=SSH_PKEY if ssh_pkey_obj else None,
                remote_bind_address=(MYSQL_HOST, MYSQL_PORT),
                set_keepalive=10.0,
            )
            t.start()
            if not _wait_port("127.0.0.1", t.local_bind_port, 10):
                try:
                    t.stop()
                except Exception:
                    pass
                _last_tunnel_err = "LOCAL_PORT_UNREACHABLE"
                _log(_last_tunnel_err)
                return None

            _tunnel = t
            _last_tunnel_err = None
            _log(f"SSH tunnel OK sur localhost:{t.local_bind_port}")
            return _tunnel

        except Exception as e:
            _last_tunnel_err = repr(e)
            _log("SSH tunnel start failed", e)
            return None

def _set_session_locale(raw_conn) -> None:
    """Impose une locale valide pour les noms de mois/jours (FR par défaut)."""
    cur = raw_conn.cursor()
    try:
        try:
            cur.execute("SET SESSION lc_time_names = 'fr_FR'")
        except Exception:
            try:
                cur.execute("SET SESSION lc_time_names = 'fr_FR.UTF-8'")
            except Exception:
                cur.execute("SET SESSION lc_time_names = 'en_US'")
    finally:
        try:
            cur.close()
        except Exception:
            pass

def _tunnel_watchdog() -> None:
    """Vérifie/relance le tunnel toutes les 15s."""
    global _watchdog_started
    if _watchdog_started:
        return
    _watchdog_started = True

    def _loop():
        while True:
            try:
                if not (_tunnel and getattr(_tunnel, "is_active", False)):
                    start_tunnel()
            except Exception as e:
                _log("watchdog error", e)
            time.sleep(15)

    threading.Thread(target=_loop, daemon=True, name="ssh-watchdog").start()

_tunnel_watchdog()

def _make_pool_ssh() -> _pooling.MySQLConnectionPool:
    _require_mysql()
    t = start_tunnel()
    if not t:
        raise RuntimeError(f"SSH_TUNNEL_DOWN: {_last_tunnel_err}")
    cfg = dict(
        host="127.0.0.1",
        port=t.local_bind_port,
        database=MYSQL_DB,
        user=MYSQL_USER,
        password=MYSQL_PWD,
        autocommit=False,
        connection_timeout=6,
        use_pure=True,
    )
    return pooling.MySQLConnectionPool(
        pool_name="lcf_pool", pool_size=8, pool_reset_session=True, **cfg
    )

def get_pool():
    global POOL
    if POOL is not None:
        try:
            test = POOL.get_connection()
            try:
                test.ping(reconnect=True, attempts=1, delay=0)
                # --- Force lc_time_names with fallback ---
                cur = test.cursor()
                try:
                    try:
                        cur.execute("SET SESSION lc_time_names = 'fr_FR'")
                    except Exception:
                        try:
                            cur.execute("SET SESSION lc_time_names = 'fr_FR.UTF-8'")
                        except Exception:
                            cur.execute("SET SESSION lc_time_names = 'en_US'")
                finally:
                    cur.close()
            finally:
                try: test.close()
                except Exception: pass
            return POOL
        except Exception:
            POOL = None
    POOL = _make_pool_ssh()
    print(f"BACKEND: OUI | MODE=ssh-only | LOCAL=127.0.0.1:{getattr(_tunnel,'local_bind_port',None)}")
    _log("BACKEND READY (ssh-only)")
    return POOL
    
# -----------------------------------------------------------
# Compat curseur/connexion (qmark, text, engine) + Flask g
# -----------------------------------------------------------
class _CompatExecResult:
    def __init__(self, cur):
        self._cur = cur
    def __iter__(self):
        return iter(self._cur.fetchall())
    def fetchall(self):
        return self._cur.fetchall()
    def fetchone(self):
        return self._cur.fetchone()
    @property
    def description(self):
        return self._cur.description
    @property
    def rowcount(self):
        return getattr(self._cur, "rowcount", -1)
    @property
    def lastrowid(self):
        return getattr(self._cur, "lastrowid", None)
    def scalar(self):
        row = self.fetchone()
        return row[0] if row else None
    def mappings(self):
        cols = [d[0] for d in (self._cur.description or [])]
        rows = self.fetchall()
        class _Maps:
            def __init__(self, rows, cols):
                self._rows = [dict(zip(cols, r)) for r in rows]
            def all(self):   return list(self._rows)
            def first(self): return self._rows[0] if self._rows else None
        return _Maps(rows, cols)

class QMarkCursor:
    def __init__(self, cur):
        self._cur = cur
    def execute(self, sql, params=None):
        if isinstance(sql, str):
            q = sql
        else:
            q = str(sql)
        if isinstance(params, dict):
            # :named → %(named)s
            q = re.sub(r":([A-Za-z_]\w*)", r"%(\1)s", q)
        elif params:  # sequence → '?' devient '%s'
            q = q.replace("?", "%s")
        self._cur.execute(q, params)
        return _CompatExecResult(self._cur)
    def executemany(self, sql, seq):
        return self._cur.executemany(sql.replace("?", "%s"), seq)
    def fetchall(self):
        return self._cur.fetchall()
    def fetchone(self):
        return self._cur.fetchone()
    @property
    def description(self):
        return self._cur.description

class ConnWrapper:
    def __init__(self, raw):
        self._raw = raw
    def cursor(self, *a, **kw):
        return QMarkCursor(self._raw.cursor(*a, **kw))
    def commit(self):
        return self._raw.commit()
    def close(self):
        return self._raw.close()

def connect_to_access() -> ConnWrapper:
    if "conn" not in g:
        raw = get_pool().get_connection()
        raw.ping(reconnect=True, attempts=3, delay=1)
        _set_session_locale(raw)  # ✅ impose FR ici aussi
        g.conn = ConnWrapper(raw)
    return g.conn

@app.teardown_appcontext
def _close_conn(_exc):
    conn = getattr(g, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass

# -----------------------------------------------------------
# Endpoints santé (minimaux, SSH-only)
# -----------------------------------------------------------
@app.get("/health")
def health():
    ssh_active = bool(_tunnel and getattr(_tunnel, "is_active", False))
    ssh_lp = getattr(_tunnel, "local_bind_port", None) if ssh_active else None
    ssh_tcp = _check_tcp("127.0.0.1", ssh_lp, 1.0) if ssh_lp else False

    db_ok = False
    try:
        c = connect_to_access()
        cur = c.cursor()
        cur.execute("SELECT 1")
        cur.fetchall()
        db_ok = True
    except Exception as e:
        _log("/health DB check fail", e)

    return jsonify({
        "ok": db_ok,
        "mode": "ssh-only",
        "ssh": {"active": ssh_active, "local_port": ssh_lp, "last_error": _last_tunnel_err, "tcp": ssh_tcp},
        "ts": int(time.time()),
    }), 200

@app.get("/token")
def get_token():
    return jsonify({"token": APP_SECRET_TOKEN}), 200

@app.before_request
def check_auth_token():
    if request.path in ("/health", "/token", "/gdp/maintenance"):
        return  # pas besoin de token pour ces endpoints

    token = request.headers.get("X-App-Token", "")
    if token != APP_SECRET_TOKEN:
        return jsonify({"ok": False, "error": "Invalid or missing token"}), 401

# -----------------------------------------------------------
# Compat SQLAlchemy: text()/engine
# -----------------------------------------------------------
try:
    from sqlalchemy import text as _sa_text  # si dispo
except Exception:
    def _sa_text(q: str) -> str:
        return q

def text(q: str):
    return _sa_text(q)

class _CompatConnCtx:
    def __enter__(self):
        raw = get_pool().get_connection()
        raw.ping(reconnect=True, attempts=2, delay=0)
        _set_session_locale(raw)  # impose FR
        self._raw = raw
        self._cur = raw.cursor()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            # ✅ si aucune exception → COMMIT ; sinon → ROLLBACK
            if exc_type is None:
                try:
                    self._raw.commit()
                except Exception:
                    pass
            else:
                try:
                    self._raw.rollback()
                except Exception:
                    pass
        finally:
            try:
                self._cur.close()
            except Exception:
                pass
            try:
                self._raw.close()
            except Exception:
                pass

    def execute(self, sql, params=None):
        # supporte :named et ? comme avant
        q = sql if isinstance(sql, str) else str(sql)
        if isinstance(params, dict):
            q = re.sub(r":([A-Za-z_]\w*)", r"%(\1)s", q)
        elif params:
            q = q.replace("?", "%s")
        self._cur.execute(q, params)
        return _CompatExecResult(self._cur)

class _CompatEngine:
    def connect(self):
        return _CompatConnCtx()
    def begin(self):
        return _CompatConnCtx()

engine = _CompatEngine()

# Alias pour compat si ancien code référence `tunnel`
tunnel = _tunnel

# -----------------------------------------------------------
# (Tes routes métier peuvent continuer ici…)
# -----------------------------------------------------------

# ===========================================================
# Utilitaires manquants : dates, normalisation & audit distant (SSH)
# ===========================================================
import posixpath
import unicodedata
import base64 as _b64
import sys
print(f"[BOOT] Python exe = {sys.executable}", flush=True)

# Dossier distant d'audit (même serveur SSH)
AUDIT_REMOTE_DIR = os.getenv(
    "AUDIT_REMOTE_DIR",
    "/volume1/Production/DO-0006 LOGS TABLEAU PRODUCTION"
)

def to_ddmmyyyy(value):
    """Retourne une date au format JJ/MM/AAAA.
       Accepte date/datetime ou str 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', etc."""
    if isinstance(value, (date, datetime)):
        return value.strftime("%d/%m/%Y")
    s = (value or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%d/%m/%Y")
        except Exception:
            pass
    return ""

def norm_statut(s: str) -> str:
    s = (s or "").strip()
    try:
        s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    except Exception:
        pass
    return s.upper()

def slugify_filename(name: str, max_len: int = 80) -> str:
    if not name:
        return "INCONNU"
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("._-") or "INCONNU"
    return s[:max_len]

def _open_sftp():
    """Ouvre une session SFTP vers le même hôte SSH (clé privée si fournie)."""
    if paramiko is None:
        raise RuntimeError("paramiko manquant — pip install paramiko")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    pkey = _load_pkey(SSH_PKEY, SSH_PKEY_PASSPHRASE) if SSH_PKEY else None
    client.connect(
        hostname=SSH_HOST,
        port=SSH_PORT,
        username=SSH_USER or None,
        password=None if pkey else (SSH_PASS or None),
        pkey=pkey,
        timeout=10,
        allow_agent=False,
        look_for_keys=False,
    )
    return client, client.open_sftp()

def _sftp_mkdirs(sftp, remote_dir: str) -> None:
    parts = remote_dir.strip("/").split("/")
    cur = "/"
    for p in parts:
        cur = posixpath.join(cur, p)
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)

def _sh_quote(p: str) -> str:
    return "'" + str(p).replace("'", "'\"'\"'") + "'"

def _ssh_exec_append(remote_path: str, payload_utf8: str):
    """Append de texte via SSH (fallback si SFTP indisponible)."""
    if paramiko is None:
        raise RuntimeError("paramiko manquant — pip install paramiko")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    pkey = _load_pkey(SSH_PKEY, SSH_PKEY_PASSPHRASE) if SSH_PKEY else None
    client.connect(
        hostname=SSH_HOST,
        port=SSH_PORT,
        username=SSH_USER or None,
        password=None if pkey else (SSH_PASS or None),
        pkey=pkey,
        timeout=10,
        allow_agent=False,
        look_for_keys=False,
    )
    try:
        dirname = posixpath.dirname(remote_path)
        # mkdir -p
        stdin, stdout, stderr = client.exec_command(f"mkdir -p {_sh_quote(dirname)}")
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError(f"mkdir a échoué: {stderr.read().decode('utf-8','ignore')}")
        # fichier existant ?
        stdin, stdout, stderr = client.exec_command(
            f"if [ -f {_sh_quote(remote_path)} ]; then echo EXISTS; else echo NEW; fi"
        )
        existed = (stdout.read().decode('utf-8','ignore').strip() == "EXISTS")
        # append base64
        b64 = _b64.b64encode(payload_utf8.encode("utf-8")).decode("ascii")
        cmd_append = f"base64 -d >> {_sh_quote(remote_path)} << 'EOF'\n{b64}\nEOF\n"
        stdin, stdout, stderr = client.exec_command(cmd_append)
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError(f"append a échoué: {stderr.read().decode('utf-8','ignore')}")
        return existed
    finally:
        try: client.close()
        except Exception: pass

def write_audit_log_remote(n, nom_client, changes: dict, pc_name: str) -> dict:
    """
    Ecrit un log d'audit *sur le NAS via le même serveur SSH*.
    - 1er essai SFTP; fallback en SSH exec base64 si besoin.
    """
    if not changes:
        msg = "[AUDIT] Aucun changement => pas de log."
        print(msg, flush=True)
        return {"ok": False, "reason": "no_changes", "message": msg}

    ts = datetime.now()
    slug = slugify_filename(nom_client)
    filename = f"{ts:%Y-%m-%d}__{slug}.txt"
    remote_dir = AUDIT_REMOTE_DIR
    remote_path = posixpath.join(remote_dir, filename)
    print(f"[AUDIT] Cible du log: {remote_path}", flush=True)

    lines = []
    for col, (old, new) in changes.items():
        old_s = "" if old is None else str(old)
        new_s = "" if new is None else str(new)
        lines.append(
            f"[{ts.strftime('%Y-%m-%d %H:%M:%S')}] "
            f"PC={pc_name} N={n} NOM_CLIENT={nom_client} | {col}: '{old_s}' -> '{new_s}'"
        )
    payload = "\n".join(lines) + "\n"

    client = None
    sftp = None
    try:
        print(f"[AUDIT] Tentative SFTP vers {SSH_HOST}:{SSH_PORT}…", flush=True)
        client, sftp = _open_sftp()
        _sftp_mkdirs(sftp, remote_dir)
        try:
            sftp.stat(remote_path)
            existed = True
        except IOError:
            existed = False
        with sftp.open(remote_path, "a", -1) as f:
            f.write(payload)
            f.flush()
        print(f"[AUDIT] ✅ SFTP OK → écrit dans {remote_path} ({'existant' if existed else 'nouveau'})", flush=True)
        for L in lines:
            print("   ↳", L, flush=True)
        return {"ok": True, "method": "sftp", "file": remote_path, "existed": existed}
    except Exception as e:
        print("[AUDIT] ⚠️ SFTP indisponible :", repr(e), flush=True)
    finally:
        try:
            if sftp: sftp.close()
        except Exception:
            pass
        try:
            if client: client.close()
        except Exception:
            pass

    try:
        print("[AUDIT] Fallback SSH exec → append base64…", flush=True)
        existed = _ssh_exec_append(remote_path, payload)
        print(f"[AUDIT] ✅ Fallback SSH OK → écrit dans {remote_path} ({'existant' if existed else 'nouveau'})", flush=True)
        for L in lines:
            print("   ↳", L, flush=True)
        return {"ok": True, "method": "ssh", "file": remote_path, "existed": existed}
    except Exception as e2:
        print("[AUDIT] ❌ Fallback SSH KO :", repr(e2), flush=True)
        return {"ok": False, "method": "ssh", "file": remote_path, "error": str(e2)}

def _norm(s: str) -> str:
    s = (s or "").strip()
    try:
        s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    except Exception:
        pass
    return s.lower()

    target = _norm(nom)

    try:
        with engine.begin() as conn:
            # ✅ plus de "nom" (colonne inexistante)
            c1 = conn.execute(text("""
                SELECT COUNT(*) FROM clients
                WHERE LOWER(TRIM(NOM_CLIENT)) = :n
            """), {"n": nom.lower()}).scalar() or 0

            c2 = conn.execute(text("""
                SELECT COUNT(*) FROM tableau_production_2
                WHERE LOWER(TRIM(NOM_CLIENT)) = :n
            """), {"n": nom.lower()}).scalar() or 0

            if c1 == 0:
                rows = conn.execute(text("""
                    SELECT NOM_CLIENT FROM clients
                    WHERE NOM_CLIENT LIKE :like LIMIT 20
                """), {"like": f"%{nom}%"}).fetchall()
                c1 = sum(1 for (x,) in rows if _norm(x) == target)

            if c2 == 0:
                rows = conn.execute(text("""
                    SELECT NOM_CLIENT FROM tableau_production_2
                    WHERE NOM_CLIENT LIKE :like LIMIT 20
                """), {"like": f"%{nom}%"}).fetchall()
                c2 = sum(1 for (x,) in rows if _norm(x) == target)

        return jsonify({
            "ok": True,
            "exists": (c1 + c2) > 0,
            "count": int(c1 + c2),
            "in_clients": int(c1),
            "in_orders": int(c2),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/get-identifiant")
def get_identifiant():
    id_param = (request.args.get("id") or "").strip()
    # Limite de sécurité pour éviter de vider la DB si table très grosse
    try:
        limit = int(request.args.get("limit", "500"))
        limit = max(1, min(limit, 5000))  # borne de 1 à 5000
    except ValueError:
        limit = 500

    try:
        with engine.connect() as conn:
            if id_param:
                rows = conn.execute(text("""
                    SELECT ID, NOM, ROLE, POSTE, SERVICE, MAIL
                    FROM identifiant
                    WHERE ID = :id
                """), {"id": id_param}).mappings().all()
            else:
                rows = conn.execute(text(f"""
                    SELECT ID, NOM, ROLE, POSTE, SERVICE, MAIL
                    FROM identifiant
                    ORDER BY ID
                    LIMIT {limit}
                """)).mappings().all()

        return jsonify({"ok": True, "rows": [dict(r) for r in rows]}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/orders/stats")
def get_orders_stats():
    """
    Statistiques dashboard :
      - commandes_en_cours : STATUT ∈ {EN ATTENTE, EN ATTENTE - PRODUCTION, EN ATTENTE DE PRODUCTION, EN PRODUCTION}
      - commandes_en_stock : STATUT = EN STOCK
      - commandes_livrees  : STATUT ∈ {LIVREE, LIVRÉE, LIVRE}
      - ca_mois            : somme de MONTANT_HT sur le MOIS COURANT, filtrée par DATE_PLANNING
                             (DATE_PLANNING stockée en texte -> STR_TO_DATE selon le format)
    """
    try:
        sql = text("""
            SELECT
              -- Commandes en cours
              SUM(
                CASE
                  WHEN UPPER(TRIM(STATUT)) IN (
                    'EN ATTENTE',
                    'EN ATTENTE - PRODUCTION',
                    'EN ATTENTE DE PRODUCTION',
                    'EN PRODUCTION'
                  )
                  THEN 1 ELSE 0
                END
              ) AS commandes_en_cours,

              -- Commandes en stock
              SUM(
                CASE
                  WHEN UPPER(TRIM(STATUT)) = 'EN STOCK'
                  THEN 1 ELSE 0
                END
              ) AS commandes_en_stock,

              -- Commandes livrées
              SUM(
                CASE
                  WHEN UPPER(TRIM(STATUT)) IN ('LIVREE','LIVRÉE','LIVRE')
                  THEN 1 ELSE 0
                END
              ) AS commandes_livrees,

              -- CA du mois basé sur DATE_PLANNING
              COALESCE(
                SUM(
                  CASE
                    WHEN DATE(
                      CASE
                        WHEN DATE_PLANNING LIKE '__/__ /____' OR DATE_PLANNING LIKE '__/__/____'
                          THEN STR_TO_DATE(DATE_PLANNING, '%d/%m/%Y')
                        WHEN DATE_PLANNING LIKE '__-__-____'
                          THEN STR_TO_DATE(DATE_PLANNING, '%d-%m-%Y')
                        WHEN DATE_PLANNING LIKE '____-__-__'
                          THEN STR_TO_DATE(DATE_PLANNING, '%Y-%m-%d')
                        ELSE NULL
                      END
                    ) BETWEEN DATE_FORMAT(CURDATE(), '%Y-%m-01')
                      AND LAST_DAY(CURDATE())
                    THEN CAST(
                           REPLACE(
                             REPLACE(
                               REPLACE(COALESCE(TRIM(MONTANT_HT), ''), '€', ''),
                             ' ', ''),
                           ',', '.') AS DECIMAL(12,2)
                         )
                    ELSE 0
                  END
                ), 0
              ) AS ca_mois

            FROM tableau_production_2
        """)

        with engine.connect() as conn:
            row = conn.execute(sql).mappings().first()

        stats = dict(row or {})

        # Normaliser les compteurs en int
        for key in ("commandes_en_cours", "commandes_en_stock", "commandes_livrees"):
            try:
                stats[key] = int(stats.get(key, 0) or 0)
            except Exception:
                stats[key] = 0

        # Normaliser ca_mois en float simple
        ca_val = stats.get("ca_mois", 0)
        try:
            stats["ca_mois"] = float(ca_val)
        except Exception:
            try:
                s = str(ca_val).replace("€", "").replace(" ", "").replace(",", ".")
                stats["ca_mois"] = float(s)
            except Exception:
                stats["ca_mois"] = 0.0

        return jsonify({"ok": True, "stats": stats}), 200

    except Exception as e:
        app.logger.exception("Error in get_orders_stats")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/orders/modules-evolution")
def get_orders_modules_evolution():
    """
    Données pour le graphique "Évolution des commandes" :
    - Sur les 6 derniers mois (mois courant inclus)
    - Pour chaque mois : somme du nombre de modules vendus
      (toutes les colonnes dont le nom commence par "MOD").
    """
    try:
        # Expression MySQL pour convertir DATE_PLANNING (texte) en date
        date_expr = "DATE(STR_TO_DATE(REPLACE(TRIM(DATE_PLANNING), '-', '/'), '%d/%m/%Y'))"

        # Somme de toutes les colonnes qui commencent par MODxx...
        modules_expr = " + ".join([
            "COALESCE(NULLIF(MOD10S,''),0)",
            "COALESCE(NULLIF(MOD14S,''),0)",
            "COALESCE(NULLIF(MOD14SDV,''),0)",
            "COALESCE(NULLIF(MOD15S,''),0)",
            "COALESCE(NULLIF(MOD21S,''),0)",
            "COALESCE(NULLIF(MOD21SDV,''),0)",
            "COALESCE(NULLIF(MOD21SPT,''),0)",
            "COALESCE(NULLIF(MOD24S,''),0)",
            "COALESCE(NULLIF(MOD28S,''),0)",
            "COALESCE(NULLIF(MOD10R,''),0)",
            "COALESCE(NULLIF(MOD14R,''),0)",
            "COALESCE(NULLIF(MOD14RDV,''),0)",
            "COALESCE(NULLIF(MOD15R,''),0)",
            "COALESCE(NULLIF(MOD21R,''),0)",
            "COALESCE(NULLIF(MOD21RDV,''),0)",
            "COALESCE(NULLIF(MOD21RPT,''),0)",
            "COALESCE(NULLIF(MOD24R,''),0)",
            "COALESCE(NULLIF(MOD28R,''),0)",
            "COALESCE(NULLIF(MOD21C,''),0)",
            "COALESCE(NULLIF(MOD21CDV,''),0)",
        ])

        sql = text(f"""
            SELECT
              DATE_FORMAT({date_expr}, '%Y-%m') AS ym,
              SUM({modules_expr}) AS modules
            FROM tableau_production_2
            WHERE {date_expr} IS NOT NULL
              AND {date_expr} >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 5 MONTH)
            GROUP BY ym
            ORDER BY ym
        """)

        with engine.connect() as conn:
            rows = conn.execute(sql).mappings().all()

        # Indexe les résultats par clé "YYYY-MM"
        modules_by_ym = {row["ym"]: int(row["modules"] or 0) for row in rows}

        # Construit la liste des 6 derniers mois (du plus ancien au plus récent)
        MONTH_LABELS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin",
                        "Juil", "Août", "Sept", "Oct", "Nov", "Déc"]

        from datetime import date

        today = date.today()
        base = today.replace(day=1)
        months = []
        y, m = base.year, base.month
        for _ in range(6):
            months.append(date(y, m, 1))
            m -= 1
            if m == 0:
                y -= 1
                m = 12
        months.reverse()

        items = []
        for d in months:
            ym = d.strftime("%Y-%m")
            label = MONTH_LABELS[d.month - 1]
            modules = int(modules_by_ym.get(ym, 0))
            items.append({
                "month": ym,      # ex: "2025-03"
                "label": label,   # ex: "Mar"
                "modules": modules,
            })

        return jsonify({"ok": True, "items": items}), 200

    except Exception as e:
        app.logger.exception("Error in get_orders_modules_evolution")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/orders")
def get_orders():
    status     = (request.args.get("status") or "").strip()
    marketing  = (request.args.get("marketing") or "").strip()
    q          = (request.args.get("q") or "").strip()
    n_param    = (request.args.get("n") or "").strip()

    # bornes sûres
    try:
        limit = int(request.args.get("limit", "500"))
        limit = max(1, min(limit, 5000))
    except ValueError:
        limit = 500
    try:
        offset = max(int(request.args.get("offset", "0")), 0)
    except ValueError:
        offset = 0

    try:
        with engine.connect() as conn:
            base_sql = """
                SELECT
                    N,
                    STATUT,
                    N_CLIENT,
                    NOM_CLIENT,
                    NOM_COMMERCIAL,
                    CONTACT_CLIENT,
                    MONTANT_HT,
                    REMARQUES,
                    MARKETING
                FROM tableau_production_2
            """
            where, params = [], {}

            if n_param:
                where.append("N = :n")
                params["n"] = n_param

            # ---- Filtres de statut ----
            s = status.lower()
            if s in {"en_cours", "en cours", "progress"}:
                # mêmes statuts que pour les stats dashboard
                where.append("""
                    UPPER(TRIM(STATUT)) IN (
                        'EN ATTENTE',
                        'EN ATTENTE - PRODUCTION',
                        'EN ATTENTE DE PRODUCTION',
                        'EN PRODUCTION'
                    )
                """)
            elif s in {"stock", "en_stock", "en stock"}:
                where.append("UPPER(TRIM(STATUT)) = 'EN STOCK'")
            elif s in {"livre", "livrée", "livree", "delivered"}:
                where.append("UPPER(TRIM(STATUT)) IN ('LIVREE','LIVRÉE','LIVRE')")
            elif status:
                # fallback: filtre brut si tu passes un statut exact dans l’URL
                where.append("STATUT = :status")
                params["status"] = status


            # ---- Filtre Marketing ----
            if marketing:
                where.append("UPPER(MARKETING) = :marketing")
                params["marketing"] = marketing.strip().upper()  # ex: OUI / NON

            # ---- Recherche simple ----
            if q:
                where.append("(NOM_CLIENT LIKE :q OR N_CLIENT LIKE :q)")
                params["q"] = f"%{q}%"

            sql = text(
                base_sql
                + (" WHERE " + " AND ".join(where) if where else "")
                + " ORDER BY N DESC LIMIT :limit OFFSET :offset"
            )
            params["limit"], params["offset"] = limit, offset

            rows = conn.execute(sql, params).mappings().all()

        return jsonify({"ok": True, "rows": [dict(r) for r in rows]}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

def get_table_columns(table_name):
    with engine.connect() as conn:
        result = conn.execute(text(f"SHOW COLUMNS FROM {table_name}"))
        rows = result.fetchall()
        return [r[0] for r in rows]

TABLE_PRODUCTION_COLUMNS = None
TABLE_PRODUCTION_COLUMNS_TS = 0

def get_table_columns_cached(ttl=300):
    """Cache avec TTL (300s par défaut)."""
    import time
    global TABLE_PRODUCTION_COLUMNS, TABLE_PRODUCTION_COLUMNS_TS
    now = time.time()
    if TABLE_PRODUCTION_COLUMNS is None or (now - TABLE_PRODUCTION_COLUMNS_TS) > ttl:
        TABLE_PRODUCTION_COLUMNS = get_table_columns("tableau_production_2")
        TABLE_PRODUCTION_COLUMNS_TS = now
    return TABLE_PRODUCTION_COLUMNS

# --- GET /orders/<n> pour lire un enregistrement complet ---
@app.get("/orders/<int:n>")
def get_order(n):
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text(f"SELECT * FROM tableau_production_2 WHERE N = :n LIMIT 1"),
                {"n": n},
            ).mappings().first()
        if not row:
            return jsonify({"ok": False, "error": "Commande introuvable"}), 404
        return jsonify({"ok": True, "row": dict(row)}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# --- POST /orders pour créer dynamiquement ---
@app.post("/orders")
def create_order():
    data = request.get_json(silent=True) or {}
    # on ne prend que les colonnes de la table (sauf N qui est auto)
    cols = get_table_columns_cached()
    # Si on détecte des clés inconnues (ex: MOD ajoutés après démarrage), on rafraîchit
    if any(k not in cols for k in data.keys()):
        # force un refresh immédiat
        from time import time
        TABLE_PRODUCTION_COLUMNS_TS = 0  # ou TABLE_PRODUCTION_COLUMNS = None
        cols = get_table_columns_cached()
        
    valid_data = {k: v for k, v in data.items() if k in cols and k != "N"}

    # normalise d’éventuelles dates déjà présentes
    for k in ("DATE_PLANNING", "LIVRAISON_PREVUE", "DATE_LIVRAISON"):
        if k in valid_data and valid_data[k]:
            valid_data[k] = to_ddmmyyyy(valid_data[k])

    # champs obligatoires
    if not valid_data.get("N_CLIENT") or not valid_data.get("NOM_CLIENT"):
        return jsonify({"ok": False, "error": "N_CLIENT et NOM_CLIENT sont requis"}), 400

    # ======= Vérification NOM_CLIENT dans clients + tableau_production_2 =======
    nom_client = (valid_data.get("NOM_CLIENT") or "").strip()
    try:
        def _norm(s: str) -> str:
            s = (s or "").strip()
            try:
                s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
            except Exception:
                pass
            return s.lower()

        target = _norm(nom_client)
        with engine.begin() as conn:
            # (pas de colonne 'nom' dans ta table clients)
            c1 = conn.execute(text("""
                SELECT COUNT(*) FROM clients
                WHERE LOWER(TRIM(NOM_CLIENT)) = :n
            """), {"n": nom_client.lower()}).scalar() or 0

            c2 = conn.execute(text("""
                SELECT COUNT(*) FROM tableau_production_2
                WHERE LOWER(TRIM(NOM_CLIENT)) = :n
            """), {"n": nom_client.lower()}).scalar() or 0

            # Fallback accent-insensible si collation stricte
            if c1 == 0:
                rows = conn.execute(text("""
                    SELECT NOM_CLIENT FROM clients
                    WHERE NOM_CLIENT LIKE :like LIMIT 20
                """), {"like": f"%{nom_client}%"}).fetchall()
                c1 = sum(1 for (x,) in rows if _norm(x) == target)

            if c2 == 0:
                rows = conn.execute(text("""
                    SELECT NOM_CLIENT FROM tableau_production_2
                    WHERE NOM_CLIENT LIKE :like LIMIT 20
                """), {"like": f"%{nom_client}%"}).fetchall()
                c2 = sum(1 for (x,) in rows if _norm(x) == target)

        if (c1 + c2) > 0:
            return jsonify({"ok": False,
                            "error": f"NOM_CLIENT « {nom_client} » existe déjà"}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    # ======= Dates automatiques =======
    today_date = date.today()

    # 1) DATE_PLANNING = aujourd’hui (non modifiable)
    valid_data["DATE_PLANNING"] = to_ddmmyyyy(today_date)

    # 2) Calcul LIVRAISON_PREVUE (10 ou 12 semaines, +3 si dans les 3 premières sem. d'août)
    ral_bdc    = (valid_data.get("RAL_BDC") or "").strip().upper()
    ral_module = (valid_data.get("RAL_MODULE") or "").strip().upper()
    weeks_to_add = 10 if (ral_bdc == "RAL 9003 BLANC" and ral_module == "RAL 9003 BLANC") else 12

    livraison_prevue = today_date + timedelta(weeks=weeks_to_add)
    if livraison_prevue.month == 8 and livraison_prevue.day <= 21:
        livraison_prevue += timedelta(weeks=3)
    valid_data["LIVRAISON_PREVUE"] = to_ddmmyyyy(livraison_prevue)

    # ======= Statut & tampons automatiques =======
    statut_norm = norm_statut(valid_data.get("STATUT"))

    # Si une date de livraison est fournie → forcer LIVREE
    if valid_data.get("DATE_LIVRAISON"):
        valid_data["DATE_LIVRAISON"] = to_ddmmyyyy(valid_data["DATE_LIVRAISON"])
        valid_data["STATUT"] = "LIVREE"
        statut_norm = "LIVREE"

    today_txt = to_ddmmyyyy(date.today())
    if statut_norm == "EN PRODUCTION":
        valid_data["DATE_PRODUCTION"] = today_txt
    elif statut_norm == "EN STOCK":
        valid_data["DATE_STOCK"] = today_txt
    elif statut_norm in ("LIVREE", "LIVRE"):
        valid_data["DATE_LIVRAISON"] = valid_data.get("DATE_LIVRAISON") or today_txt

    # Toujours fournir les 3 colonnes dates à l’INSERT (VARCHAR NOT NULL)
    for col in ("DATE_PRODUCTION", "DATE_STOCK", "DATE_LIVRAISON"):
        if col not in valid_data or valid_data[col] is None:
            valid_data[col] = ""

    # ======= INSERT + mail =======
    try:
        columns = ", ".join(valid_data.keys())
        values  = ", ".join([f":{k}" for k in valid_data.keys()])

        with engine.begin() as conn:
            result = conn.execute(
                text(f"INSERT INTO tableau_production_2 ({columns}) VALUES ({values})"),
                valid_data
            )
            new_id = getattr(result, "lastrowid", None)

        # Envoi d'email (non bloquant) + retour d’info au front
        mail_info = {}
        try:
            mail_info = send_new_order_email(new_id, valid_data) or {}
        except Exception as e:
            print(f"[mail] erreur non bloquante: {e}")

        return jsonify({"ok": True, "N": new_id, "mail": mail_info}), 201

    except Exception as e:
        print("[ERREUR INSERT]", e)
        return jsonify({"ok": False, "error": str(e)}), 500

@app.put("/orders/<int:n>")
def update_order(n):
    data = request.get_json(silent=True) or {}

    cols = get_table_columns_cached()
    # ✅ Si on détecte des clés inconnues → refresh immédiat
    if any(k not in cols for k in data.keys()):
        from time import time
        global TABLE_PRODUCTION_COLUMNS_TS, TABLE_PRODUCTION_COLUMNS
        TABLE_PRODUCTION_COLUMNS_TS = 0
        TABLE_PRODUCTION_COLUMNS = None
        cols = get_table_columns_cached()

    # On garde les valeurs vides ("") : elles servent à effacer
    valid_data = {k: v for k, v in data.items() if k in cols and k != "N"}

    if not valid_data:
        print("[AUDIT] ✖ Aucun champ valide transmis → pas de log", flush=True)
        return jsonify({"ok": False, "error": "Aucune colonne valide transmise"}), 400

    try:
        with engine.begin() as conn:
            # état AVANT sur les colonnes modifiées + NOM_CLIENT (pour le log)
            cols_to_fetch = set(valid_data.keys()) | {"NOM_CLIENT"}
            select_cols = ", ".join(sorted(cols_to_fetch))
            before = conn.execute(
                text(f"SELECT {select_cols} FROM tableau_production_2 WHERE N = :N"),
                {"N": n},
            ).mappings().first()
            if not before:
                print("[AUDIT] ✖ Commande introuvable", flush=True)
                return jsonify({"ok": False, "error": "Commande introuvable"}), 404

            # --- Normalisations & tampons auto lors d'une MAJ ---
            if "DATE_LIVRAISON" in valid_data:
                # si on renseigne une date de livraison -> force statut LIVREE
                dl = to_ddmmyyyy(valid_data["DATE_LIVRAISON"])
                valid_data["DATE_LIVRAISON"] = dl
                if dl:
                    valid_data["STATUT"] = "LIVREE"

            statut_eff = norm_statut(valid_data.get("STATUT") or before.get("STATUT"))
            today = to_ddmmyyyy(date.today())

            if statut_eff == "EN PRODUCTION":
                valid_data["DATE_PRODUCTION"] = today
            elif statut_eff == "EN STOCK":
                valid_data["DATE_STOCK"] = today
            elif statut_eff in ("LIVREE", "LIVRE"):
                # si pas de date fournie, on pose aujourd'hui
                if not valid_data.get("DATE_LIVRAISON"):
                    valid_data["DATE_LIVRAISON"] = today

            # UPDATE
            set_clause = ", ".join([f"{k} = :{k}" for k in valid_data.keys()])
            payload = dict(valid_data)
            payload["N"] = n
            res = conn.execute(
                text(f"UPDATE tableau_production_2 SET {set_clause} WHERE N = :N"),
                payload,
            )
            if res.rowcount == 0:
                # La ligne existe (on a 'before'), mais aucune valeur n’a changé :
                # on considère que c'est un succès idempotent.
                print("[AUDIT] UPDATE : 0 ligne modifiée (valeurs identiques)", flush=True)

        # Diff
        changes: dict[str, tuple[Any, Any]] = {}
        for k, new_val in valid_data.items():
            old_val = before.get(k)
            if (old_val or "") != (new_val or ""):
                changes[k] = (old_val, new_val)

        print(f"[AUDIT] ◀ diff_keys={list(changes.keys())} (len={len(changes)})", flush=True)

        nom_client = valid_data.get("NOM_CLIENT") or before.get("NOM_CLIENT") or ""
        pc_name = (
            request.headers.get("X-Client-PC")
            or request.headers.get("X-Client-Host")
            or request.remote_addr
            or "unknown"
        )

        write_audit_log_remote(n, nom_client, changes, pc_name)

        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/clients")
def get_clients():
    q = (request.args.get("q") or "").strip()

    # bornes sûres
    try:
        limit = int(request.args.get("limit", "500"))
        limit = max(1, min(limit, 5000))
    except ValueError:
        limit = 500
    try:
        offset = max(int(request.args.get("offset", "0")), 0)
    except ValueError:
        offset = 0

    try:
        with engine.connect() as conn:
            base_sql = """
                SELECT
                    NOM_CLIENT,
                    NUMERO_DE_SERIE,
                    VERSION,
                    MDP,
                    TYPE_DE_CONNEXION
                FROM clients
            """
            where = []
            params = {}

            if q:
                where.append("""(
                    NOM_CLIENT LIKE :q
                    OR NUMERO_DE_SERIE LIKE :q
                    OR VERSION LIKE :q
                    OR TYPE_DE_CONNEXION LIKE :q
                    OR MDP LIKE :q
                )""")
                params["q"] = f"%{q}%"

            where_sql = (" WHERE " + " AND ".join(where)) if where else ""
            order_sql = " ORDER BY NOM_CLIENT ASC, NUMERO_DE_SERIE ASC"
            limit_sql = f" LIMIT {limit} OFFSET {offset}"

            rows = conn.execute(text(base_sql + where_sql + order_sql + limit_sql), params).mappings().all()

        return jsonify({"ok": True, "rows": [dict(r) for r in rows]}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/donnees")
def get_donnees():
    """
    /donnees?nom_colonne=MODE_PAIEMENT  ->  {"ok":true, "values":["INGENICO SELF", ...]}
    """
    nom = (request.args.get("nom_colonne") or "").strip()
    if not nom:
        return jsonify({"ok": False, "error": "nom_colonne manquant"}), 400

    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT VALEUR
                FROM donnees
                WHERE NOM_COLONNE = :nom
                  AND COALESCE(VALEUR,'') <> ''
                ORDER BY N
            """), {"nom": nom}).fetchall()

        values = [r[0] for r in rows]
        values = list(dict.fromkeys(values))
        return jsonify({"ok": True, "values": values}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/donnees/all")
def get_donnees_all():
    """
    Retourne toutes les valeurs de la table `donnees`, groupées par NOM_COLONNE.

    Réponse :
    {
      "ok": true,
      "values": {
        "STATUT": ["EN ATTENTE", "EN PRODUCTION", ...],
        "MODE_PAIEMENT": ["INGENICO SELF", "VAD", ...],
        ...
      }
    }
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT NOM_COLONNE, VALEUR
                FROM donnees
                WHERE COALESCE(VALEUR, '') <> ''
                ORDER BY NOM_COLONNE, N
            """)).fetchall()

        data = {}
        for nom, val in rows:
            if not nom:
                continue
            key = str(nom).strip()
            if not key:
                continue
            if key not in data:
                data[key] = []
            if val is not None:
                s = str(val).strip()
                if s:
                    data[key].append(s)

        # dédup
        for k, lst in data.items():
            data[k] = list(dict.fromkeys(lst))

        return jsonify({"ok": True, "values": data}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/donnees/cols")
def get_donnees_cols():
    """
    Retourne la liste des NOM_COLONNE distincts de la table `donnees`.
    Utilisé pour filtrer les champs à hydrater côté front.
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT DISTINCT NOM_COLONNE
                FROM donnees
                WHERE COALESCE(NOM_COLONNE, '') <> ''
                ORDER BY NOM_COLONNE
            """)).fetchall()

        cols = [r[0] for r in rows]
        return jsonify({"ok": True, "cols": cols}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# main.py – helpers
def normalize_amount_to_db(val: object):
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    # retire € + espaces (y compris insécable)
    s = re.sub(r"[ €\u202f]", "", s)
    # virgule = décimale si pas de point ; sinon, virgules = milliers
    if "," in s and "." not in s:
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    m = re.match(r"^-?\d+(?:\.\d{1,2})?$", s) or re.match(r"^-?\d*(?:\.\d{0,2})?", s)
    if not m or not m.group(0):
        return None
    return m.group(0)  # ex: "1234.56"

@app.get("/clients/check")
def check_client_exists():
    """
    Vérifie si un client existe déjà dans la table `clients`.

    Exemple :
        /clients/check?nom=LES%20P%20TITS%20MARAICHERS%20A
        → {"ok": true, "exists": true}
    """
    nom_client = (request.args.get("nom") or "").strip().upper()
    if not nom_client:
        return jsonify({"ok": False, "error": "Nom client manquant"}), 400

    try:
        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT COUNT(*) AS count
                FROM clients
                WHERE UPPER(TRIM(NOM_CLIENT)) = :nom
            """), {"nom": nom_client})
            count = result.scalar() or 0

        return jsonify({"ok": True, "exists": count > 0}), 200

    except Exception as e:
        app.logger.error(f"Erreur /clients/check : {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

import os, time, subprocess
from datetime import date
from urllib.parse import quote
import unicodedata

try:
    import win32com.client as win32
    import pythoncom
except Exception:
    win32 = None
    pythoncom = None

def _get_outlook_app():
    """Essaie d’obtenir l’objet COM Outlook."""
    if not win32:
        return None
    try:
        return win32.gencache.EnsureDispatch("Outlook.Application")
    except Exception:
        try:
            return win32.Dispatch("Outlook.Application")
        except Exception:
            return None

def _ensure_outlook_ready(max_wait=20, poll=1.2):
    """
    Lance Outlook si besoin, attend qu’il soit prêt, puis renvoie l’objet COM.
    Retourne (app, launched) où launched est True si on l’a démarré ici.
    """
    app = _get_outlook_app()
    if app:
        return app, False

    # Démarre Outlook
    try:
        subprocess.Popen(["cmd", "/c", "start", "", "outlook.exe"], shell=True)
        launched = True
    except Exception:
        try:
            os.startfile("outlook")
            launched = True
        except Exception:
            launched = False

    # Attente que COM soit prêt
    start = time.time()
    while time.time() - start < max_wait:
        time.sleep(poll)
        app = _get_outlook_app()
        if app:
            return app, launched

    return None, launched

BASE_SHAREPOINT = "https://lecasierfrancais.sharepoint.com/sites/Production/Documents%20partages/"
def windows_path_to_sharepoint(p: str) -> str:
    if not p:
        return ""
    s = str(p).strip().strip('"').replace("\\", "/")
    lower = s.lower()
    anchor = "/production - documents/"
    pos = lower.find(anchor)
    if pos == -1:
        idx = lower.find("/dossiers clients/")
        if idx == -1:
            return ""
        rest = s[idx + 1 :]
    else:
        rest = s[pos + len(anchor) :]
    encoded = "/".join(quote(part) for part in rest.split("/"))
    return BASE_SHAREPOINT + encoded

def get_commercial_email(nom_commercial: str) -> str:
    """
    Cherche dans `donnees` la ligne où:
      NOM_COLONNE = 'NOM_COMMERCIAL' ET _norm(VALEUR) == _norm(nom_commercial)
    Retourne le MAIL (ou EMAIL si MAIL est NULL).
    """
    target = _norm(nom_commercial)
    if not target:
        return ""

    try:
        with engine.begin() as conn:
            rows = conn.execute(text("""
                SELECT VALEUR,
                       COALESCE(MAIL, EMAIL) AS MAIL
                FROM donnees
                WHERE UPPER(TRIM(NOM_COLONNE)) = 'NOM_COMMERCIAL'
                  AND (MAIL IS NOT NULL OR EMAIL IS NOT NULL)
            """)).fetchall()

        for r in rows:
            # accès robuste tuple/Row
            valeur = r[0] if isinstance(r, (list, tuple)) else (getattr(r, "VALEUR", "") or "")
            mail   = r[1] if isinstance(r, (list, tuple)) else (getattr(r, "MAIL", "")   or "")
            if _norm(valeur) == target and mail:
                return mail.strip()

        # aucun match strict normalisé
        return ""

    except Exception as e:
        print("[get_commercial_email] erreur:", e)
        return ""
    
def send_new_order_email(order_id: int, row: dict):
    """
    Ouvre un brouillon Outlook (Display) avec récap « Nouvelle commande ».
    Adressage :
      - To   : vmazurek@lecasierfrancais.fr
      - CC   : email du NOM_COMMERCIAL (table `donnees`: MAIL/EMAIL)
      - BCC  : liste fixe + (si MARKETING == 'OUI') adresses marketing
    Dé-doublonne proprement et fallback en mailto si COM indisponible.
    """
    info = {
        "attempted": True, "sent": False, "displayed": False, "to": "",
        "reason": "", "launched_outlook": False, "mailto_fallback": False
    }

    try:
        # ===== Adressage selon règles =====
        to_addr = "vmazurek@lecasierfrancais.fr"
        info["to"] = to_addr

        nom_commercial = (row.get("NOM_COMMERCIAL") or "").strip()
        cc_from_donnees = get_commercial_email(nom_commercial)

        bcc_list = [
            "nmazurek@lecasierfrancais.fr",
            "jbdelefolly@lecasierfrancais.fr",
            "conseil@manuel-moutier.com",
            "tderache@lecasierfrancais.fr",
        ]
        if (row.get("MARKETING") or "").strip().upper() == "OUI":
            bcc_list += ["communication@lecasierfrancais.fr", "hpoizot@lecasierfrancais.fr"]

        # dé-doublonnage To/CC/BCC
        def dedup(seq):
            seen, out = set(), []
            for x in [s.strip() for s in (seq or []) if s and s.strip()]:
                k = x.lower()
                if k not in seen:
                    seen.add(k); out.append(x)
            return out

        cc_list  = dedup([cc_from_donnees] if cc_from_donnees else [])
        bcc_list = dedup(bcc_list)
        # retire de BCC tout ce qui est déjà en To/CC
        bcc_list = [x for x in bcc_list if x.lower() not in {to_addr.lower(), *[c.lower() for c in cc_list]}]

        # ===== Contenu du mail =====
        nom_client     = (row.get("NOM_CLIENT") or "").strip()
        nom_comm       = nom_commercial
        date_planning  = row.get("DATE_PLANNING") or date.today()
        try:
            date_planning_txt = date_planning if isinstance(date_planning, str) else to_ddmmyyyy(date_planning)
        except Exception:
            date_planning_txt = str(date_planning)

        plan_src = (row.get("PLAN_INSTALLATION_LIEN") or row.get("PLAN_INSTALLATION") or "").strip()
        plan_url = windows_path_to_sharepoint(plan_src) if (plan_src and "://" not in plan_src) else plan_src

        subject = f"[GDP] Nouvelle commande #{order_id} — {nom_client or 'Client'}"
        plan_row_html = f"""
            <tr><td><strong>Plan :</strong></td>
                <td>{('<a href="'+plan_url+'" target="_blank">'+plan_url+'</a>') if plan_url else '-'}</td></tr>
        """
        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; background-color: #f9f9f9; margin: 0; padding: 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center" style="padding: 30px 0;">
                    <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px;">
                        <tr style="background-color: #29235C;">
                            <td style="padding: 30px; color: white; text-align: center;">
                                <h2 style="margin:0;">Nouvelle commande ajoutée au tableau de production</h2>
                                <div style="opacity:.9;margin-top:6px;">N° {order_id}</div>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 30px; color: #333333;">
                                <p>Bonjour,</p>
                                <p style="margin:0 0 12px;">
                                    Nouvelle commande ajoutée au tableau de production :
                                </p>

                                <p style="margin:16px 0 8px;"><strong>Le document suivant a été généré :</strong></p>
                                <table cellpadding="6" cellspacing="0" style="font-size: 14px;">
                                    <tr><td><strong>Client :</strong></td><td>{nom_client or "-"}</td></tr>
                                    {plan_row_html}
                                    <tr><td><strong>Date planning :</strong></td><td>{date_planning_txt}</td></tr>
                                    <tr><td><strong>Commercial :</strong></td><td>{nom_comm or "-"}</td></tr>
                                </table>

                                {"<p style='margin-top:18px;'><a href='"+plan_url+"' target='_blank' style='display:inline-block;padding:10px 16px;background:#29235C;color:#ffffff;text-decoration:none;border-radius:6px;'>Ouvrir le plan d’installation</a></p>" if plan_url else ""}

                                <p style="margin-top: 30px;">Cordialement,<br><strong>GDP — Le Casier Français</strong></p>
                            </td>
                        </tr>
                    </table>
                </td></tr>
            </table>
        </body>
        </html>
        """

        # ===== COM Outlook prêt ? sinon fallback mailto =====
        if pythoncom:
            try: pythoncom.CoInitialize()
            except Exception: pass

        app_ol, launched = _ensure_outlook_ready(max_wait=25, poll=1.2)
        info["launched_outlook"] = bool(launched)
        if not app_ol:
            info["reason"] = "outlook_unavailable"
            # Fallback mailto avec to/cc/bcc (HTML non supporté)
            from urllib.parse import quote
            q = []
            if cc_list:  q.append("cc="  + quote(";".join(cc_list)))
            if bcc_list: q.append("bcc=" + quote(";".join(bcc_list)))
            q.append("subject=" + quote(subject))
            q.append("body="    + quote("Nouvelle commande ajoutée au tableau de production."))
            url = "mailto:" + to_addr + ("?" + "&".join(q) if q else "")
            try:
                os.startfile(url)
                info["mailto_fallback"] = True
            except Exception as e:
                info["reason"] += f" + mailto_failed: {e}"
            return info

        # ===== Création du brouillon + adressage =====
        mail = None
        for _ in range(8):
            try:
                mail = app_ol.CreateItem(0)
                break
            except Exception:
                time.sleep(1.0)
        if not mail:
            info["reason"] = "createitem_failed"
            return info

        mail.To      = to_addr  # To imposé
        if cc_list:  mail.CC  = ";".join(cc_list)
        if bcc_list: mail.BCC = ";".join(bcc_list)
        mail.Subject = subject
        mail.HTMLBody = html

        try:
            mail.Display()
        except Exception:
            mail.Display(True)

        info["displayed"] = True
        return info

    finally:
        if pythoncom:
            try: pythoncom.CoUninitialize()
            except Exception: pass

@app.get("/gdp/maintenance")
def get_maintenance_status():
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT STATUT FROM GDP WHERE ID = 'GDP_MAINTENANCE' LIMIT 1")
            ).fetchone()

        statut = int(row[0]) if row and row[0] is not None else 0
        return jsonify({"ok": True, "STATUT": statut}), 200

    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "STATUT": 0}), 500

# ========== 4) Lancement ==========
if __name__ == "__main__":
    try:
        app.run(host="127.0.0.1", port=5000, threaded=True, use_reloader=False)
    finally:
        print("[STOP] Fermeture du tunnel SSH…")
        try:
            tunnel.stop()
        except Exception:
            pass
