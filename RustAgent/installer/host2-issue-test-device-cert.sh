#!/bin/sh
# 測試區臨時裝置憑證(PLATFORM-PLAN P1 收尾:測試 VM;AD CS 自動註冊到位前使用)。
# 以主機 2 的臨時 Agent CA(gen-temp-pki.sh 產生)為一台電腦簽一張用戶端憑證,打包成 PFX(含 Agent CA)。
# 由使用者在主機 2 執行(私鑰與 PFX 密碼不經過 AI):
#   scp RustAgent/installer/host2-issue-test-device-cert.sh host2:
#   ssh -t host2 "wsl -u root -- sh /mnt/c/Users/user/host2-issue-test-device-cert.sh <電腦名稱>"
# 產出:C:\Users\user\agent-certs\<電腦名稱>\<電腦名稱>.pfx 與 pfx-password.txt。
# 匯入 VM 後(Import-PfxCertificate,不加 -Exportable)刪除這個資料夾與 VM 上的 PFX 副本。
set -eu
CN="${1:?用法:host2-issue-test-device-cert.sh <電腦名稱>(與 VM 的 hostname 相同)}"
case "$CN" in *[!A-Za-z0-9.-]*) echo "電腦名稱只能有英數字、點、減號:$CN" >&2; exit 1 ;; esac
PKI="${PKI:-/srv/giganexus/deploy/secrets/pki}"
OUT="${OUT_ROOT:-/mnt/c/Users/user/agent-certs}/$CN"
[ -f "$PKI/agent-ca.key" ] || { echo "找不到 $PKI/agent-ca.key" >&2; exit 1; }
[ -e "$OUT" ] && { echo "$OUT 已存在;要重簽請先刪除" >&2; exit 1; }

umask 077
WORK="$(mktemp -d)"
DONE=
# 中途失敗時連同輸出資料夾一起清掉,可直接重跑
trap 'rm -rf "$WORK"; [ -n "$DONE" ] || rm -rf "$OUT"' EXIT
mkdir -p "$OUT"

openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$WORK/device.key" -out "$WORK/device.csr" \
  -subj "/O=GigaNexus Test/CN=$CN" 2>/dev/null
printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n" > "$WORK/device.ext"
openssl x509 -req -in "$WORK/device.csr" -CA "$PKI/agent-ca.crt" -CAkey "$PKI/agent-ca.key" -CAcreateserial \
  -CAserial "$WORK/agent-ca.srl" -days 365 -sha256 -extfile "$WORK/device.ext" -out "$WORK/device.crt" 2>/dev/null

# 密碼只寫進檔案,不印在畫面;tr 去掉換行,避免 Windows 匯入時密碼不符
openssl rand -hex 16 | tr -dc '0-9a-f' > "$OUT/pfx-password.txt"
# AES-256 / SHA-256 加密的 PFX,Windows 10 1709 起可匯入
openssl pkcs12 -export -inkey "$WORK/device.key" -in "$WORK/device.crt" -certfile "$PKI/agent-ca.crt" \
  -name "GigaNexus Agent ($CN)" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 \
  -passout "file:$OUT/pfx-password.txt" -out "$OUT/$CN.pfx"

openssl x509 -in "$WORK/device.crt" -noout -subject -issuer -enddate
DONE=1
echo "完成:C:\\Users\\user\\agent-certs\\$CN\\($CN.pfx、pfx-password.txt)"
