#!/bin/sh
# 主機 2(測試區 WSL)準備 ItAgentBack 的機密與臨時憑證(INTEGRATION-PLAN M4):本人執行,SQL 密碼以隱藏輸入寫入,不經開發機。
#   在主機 2 的 WSL:sudo sh host2-set-secrets.sh [裝置 FQDN ...]
# 產生(已存在的不覆寫;要重建先刪除該檔):
#   /srv/giganexus/ita-secrets/   ita_db_password、mongo_password、redis_password、mongo_url、redis_url、
#                                 endpoint_server.crt / .key(:51241,臨時根 CA 簽發,SAN DNS:endpoint-server)、
#                                 gw_api_key(Gateway CLI client:create --code endpoint-api;已存在則略過,換發請刪檔再執行)、
#                                 monitor_api_key / agent_monitor_api_key(giga-observe ingest Key:endpoint-api / endpoint-agent)
#   /srv/giganexus/deploy/ita.env  Compose 變數(範本 test.env.example)
#   C:\Users\user\agentpki\<FQDN>\ 每台裝置的 agent.crt / agent.key + ca.crt(臨時 Agent 中繼 CA 簽發,一年;取走後請刪除)
set -eu
D=/srv/giganexus/ita-secrets
PKI=/srv/giganexus/deploy/secrets/pki
GW_ENV_FILE=/srv/giganexus/deploy/test.env
GW_SHARED=/srv/giganexus/shared
OUT=/mnt/c/Users/user/agentpki
mkdir -p "$D"

rnd() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-32; }

# ---------- SQL Server(ita_app)密碼 ----------
if [ ! -f "$D/ita_db_password" ]; then
  stty -echo; printf 'ita_app 密碼(giganexus_It_Agent_test):'; read -r p; stty echo; echo
  [ -n "$p" ] || { echo "密碼空白,中止" >&2; exit 1; }
  printf '%s' "$p" > "$D/ita_db_password"; unset p
fi

# ---------- Mongo / Redis(只在 ItAgentBack 內部網路) ----------
[ -f "$D/mongo_password" ] || rnd > "$D/mongo_password"
[ -f "$D/redis_password" ] || rnd > "$D/redis_password"
printf 'mongodb://ita:%s@ita-mongo:27017/?authSource=admin' "$(cat "$D/mongo_password")" > "$D/mongo_url"
printf 'redis://:%s@ita-redis:6379' "$(cat "$D/redis_password")" > "$D/redis_url"

# ---------- 憑證(openssl 以一次性容器執行) ----------
mkdir -p "$OUT"
docker run --rm -v "$PKI:/ca:ro" -v "$D:/d" -v "$OUT:/o" -e DEVICES="$*" alpine:3.20 sh -c '
set -e; apk add -q openssl; cd /tmp
serial() { echo "0x$(openssl rand -hex 16)"; }
if [ ! -f /d/endpoint_server.crt ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /d/endpoint_server.key -out s.csr \
    -subj "/O=GigaNexus/CN=endpoint-server (test, temporary)" 2>/dev/null
  printf "subjectAltName=DNS:endpoint-server\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:false\n" > s.ext
  openssl x509 -req -in s.csr -CA /ca/ca.crt -CAkey /ca/ca.key -set_serial "$(serial)" -days 825 -sha256 -extfile s.ext -out /d/endpoint_server.crt 2>/dev/null
  echo "已產生 endpoint_server.crt"
fi
for fqdn in $DEVICES; do
  mkdir -p "/o/$fqdn"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "/o/$fqdn/agent.key" -out a.csr \
    -subj "/O=GigaNexus Test/CN=$fqdn" 2>/dev/null
  printf "extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:false\n" > a.ext
  openssl x509 -req -in a.csr -CA /ca/agent-ca.crt -CAkey /ca/agent-ca.key -set_serial "$(serial)" -days 365 -sha256 -extfile a.ext -out "/o/$fqdn/agent.crt" 2>/dev/null
  cp /ca/ca.crt "/o/$fqdn/ca.crt"
  echo "已簽發裝置憑證:$fqdn($(openssl x509 -in "/o/$fqdn/agent.crt" -noout -enddate))"
done
'

# ---------- Gateway API Key(自動註冊 OpenAPI 草稿用;代碼必須等於上游 endpoint-api) ----------
if [ ! -f "$D/gw_api_key" ]; then
  G="$GW_SHARED/giga-api-gateway-bff/deploy"
  TAG="$(cat "$GW_SHARED/gateway-image-tag")"
  (cd "$G" && IMAGE_TAG="$TAG" REGISTRY=10.10.130.123:5050/giganexus/giga-api-gateway-bff \
    docker compose --env-file "$GW_ENV_FILE" -f docker-compose.yml -f docker-compose.test.yml --profile tools run --rm --no-deps -T \
    migrate node dist/bff/src/cli/index.js client:create --code endpoint-api --name "RustIt ItAgentBack" --actor RustIt-M4) > /tmp/ita-key.json
  sed -n 's/^  "key": "\(.*\)",\{0,1\}$/\1/p' /tmp/ita-key.json | tr -d '\n' > "$D/gw_api_key"
  grep -v '"key"' /tmp/ita-key.json; rm -f /tmp/ita-key.json
  [ -s "$D/gw_api_key" ] || { echo "取不到 API Key,請檢查上方輸出" >&2; rm -f "$D/gw_api_key"; exit 1; }
fi

# ---------- giga-observe 監控 Key(ingest;serviceId 即架構圖的服務 id;已存在則略過) ----------
observe_key() { # $1 檔名 $2 serviceId $3 說明
  [ -f "$D/$1" ] && return
  (cd /srv/giganexus/giga-observe && docker compose --env-file deploy/test.env exec -T gno-backend \
    node src/scripts/createApiKey.js --service "$2" --scope ingest --label "$3") > /tmp/ita-obs.txt
  sed -n 's/^  key *: *//p' /tmp/ita-obs.txt | tr -d '\r\n' > "$D/$1"; rm -f /tmp/ita-obs.txt
  [ -s "$D/$1" ] || { echo "取不到 $2 的監控 Key" >&2; rm -f "$D/$1"; exit 1; }
  echo "已建立監控 Key:$2"
}
observe_key monitor_api_key endpoint-api "RustIt ItAgentBack 管理 API"
observe_key agent_monitor_api_key endpoint-agent "RustIt ItAgentBack Agent 通道"

# ---------- Compose 變數 ----------
if [ ! -f /srv/giganexus/deploy/ita.env ]; then
  cat > /srv/giganexus/deploy/ita.env <<'EOF'
GW_ENV=test
GW_BASE_URL=https://giganexus-test.gigasolar.com.tw
GW_NETWORK=giganexus-gw_default
AGENT_TRUSTED_PROXIES=172.19.0.0/16
ITA_DB_HOST=10.10.130.220
ITA_DB_NAME=giganexus_It_Agent_test
ITA_DB_USER=ita_app
ITA_SECRETS_DIR=/srv/giganexus/ita-secrets
EOF
  echo "已建立 /srv/giganexus/deploy/ita.env"
fi

# endpoint-server 以 node(uid 1000)讀取
chown 1000:1000 "$D"/*; chmod 400 "$D"/*
ls -l "$D"
