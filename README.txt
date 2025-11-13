Démarrer

# 1) Aller dans le dossier de l'app
cd /volume1/backend-app/app

# 2) Lancer en arrière-plan + log + PID
nohup /bin/python3 main.py >> ../backend.log 2>&1 & echo $! > ../backend.pid
disown

# 3) Vérifier
ps -fp "$(cat ../backend.pid)"
tail -n 50 ../backend.log

Arrêter

# 1) Si on a un PID file
if [ -f /volume1/backend-app/backend.pid ]; then
  kill "$(cat /volume1/backend-app/backend.pid)" 2>/dev/null || true
  sleep 2
  kill -9 "$(cat /volume1/backend-app/backend.pid)" 2>/dev/null || true
  rm -f /volume1/backend-app/backend.pid
else
  # 2) Sans PID file : on retrouve le process par son nom et on le coupe
  pids=$(pgrep -f "/bin/python3 .*main\.py") || true
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    sleep 2
    kill -9 $pids 2>/dev/null || true
  fi
fi

# 3) Vérifier que c'est bien mort
pgrep -af "/bin/python3 .*main\.py" || echo "OK: plus de main.py actif"

Redémarrer (arrêt + démarrage)
# Stop
if [ -f /volume1/backend-app/backend.pid ]; then
  kill "$(cat /volume1/backend-app/backend.pid)" 2>/dev/null || true
  sleep 2
  kill -9 "$(cat /volume1/backend-app/backend.pid)" 2>/dev/null || true
  rm -f /volume1/backend-app/backend.pid
else
  pids=$(pgrep -f "/bin/python3 .*main\.py") || true
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 2
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
fi

# Start
cd /volume1/backend-app/app
nohup /bin/python3 main.py >> ../backend.log 2>&1 & echo $! > ../backend.pid
disown

# Check
ps -fp "$(cat ../backend.pid)"
tail -n 50 ../backend.log