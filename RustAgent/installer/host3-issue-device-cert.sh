#!/bin/sh
# 正式區臨時裝置憑證(IT AD CS 自動註冊到位前使用;AGENT.md §6、Gateway ENDPOINT-AGENT-GUIDE §3)。
# 以主機 3 的正式區臨時 Agent CA(Gateway deploy/host3-prod-temp-pki.sh 產生,與測試區不同)為一台電腦簽一張用戶端憑證,
# 打包成 PFX(含 Agent CA)。測試區用 host2-issue-test-device-cert.sh,兩區的 CA 不可混用。
# 由使用者在主機 3 執行(agent-ca.key 只有 root 可讀;私鑰與 PFX 密碼不經過 AI):
#   scp RustAgent/installer/host3-issue-device-cert.sh host3:
#   ssh -t host3 "wsl -u root -- sh /mnt/c/Users/user/host3-issue-device-cert.sh <電腦名稱>"
# 電腦名稱(CN,E1):網域電腦用 FQDN(例 PC0123.gsmc.com.tw,endpoint-server 依網域尾碼判定所屬公司);
#                   FQDN 的網域須在 ita.env 的 ENDPOINT_COMPANY_DOMAINS 內,否則拒絕;
#                   非網域電腦用 <公司代碼>-<電腦名稱>(不含點,所屬公司需在 /it/ 手動指定)。
# 產出:C:\Users\user\agent-certs\<電腦名稱>\<電腦名稱>.pfx 與 pfx-password.txt;
#       C:\Users\user\agent-certs\ca-prod.crt(正式區根 CA 公開憑證,build-agent-msi.ps1 -Env prod -CaFile 用)。
# 簽發紀錄(電腦名稱、序號、到期日)追加到 pki/issued-devices.log,撤銷時用序號查。
# 匯入電腦後(Import-PfxCertificate -CertStoreLocation Cert:\LocalMachine\My,不加 -Exportable)刪除這個資料夾與電腦上的 PFX 副本。
# 同一台重簽:先刪輸出資料夾,並加 REISSUE=1(舊憑證到期前仍有效,需要時另行撤銷)。
set -eu
CN="${1:?用法:host3-issue-device-cert.sh <電腦名稱>(網域電腦用 FQDN,例 PC0123.gsmc.com.tw)}"
case "$CN" in *[!A-Za-z0-9.-]* | .* | *. | *..*) echo "電腦名稱只能有英數字、點、減號,且不能以點開頭或結尾:$CN" >&2; exit 1 ;; esac
PKI="${PKI:-/srv/giganexus/deploy/secrets/pki}"
OUT_ROOT="${OUT_ROOT:-/mnt/c/Users/user/agent-certs}"
OUT="$OUT_ROOT/$CN"
LOG="$PKI/issued-devices.log"
[ "$(id -u)" = 0 ] || { echo "請用 root 執行(wsl -u root)" >&2; exit 1; }
[ -f "$PKI/agent-ca.key" ] || { echo "找不到 $PKI/agent-ca.key" >&2; exit 1; }
# 防呆:只用正式區的 CA 簽,避免主機 3 的 pki/ 被還原成測試區那套時簽出測試區也信任的憑證
case "$(openssl x509 -in "$PKI/agent-ca.crt" -noout -subject)" in
  *"Agent CA (prod)"*) ;;
  *) echo "$PKI/agent-ca.crt 不是正式區 Agent CA(應為 GigaNexus Temporary Agent CA (prod));先執行 Gateway deploy/host3-prod-temp-pki.sh" >&2; exit 1 ;;
esac
[ -e "$OUT" ] && { echo "$OUT 已存在;要重簽請先刪除" >&2; exit 1; }
if [ -f "$LOG" ] && awk -v cn="$CN" 'tolower($2) == tolower(cn) { f = 1 } END { exit !f }' "$LOG" && [ "${REISSUE:-}" != 1 ]; then
  echo "$CN 已簽發過(見 $LOG);確定重簽請加 REISSUE=1" >&2; exit 1
fi
[ "${REISSUE:-}" = 1 ] && echo "注意:重簽不會撤銷舊憑證(到期前仍可連 :9443);舊序號見 $LOG" >&2
# FQDN 的網域須在 endpoint-server 的公司網域清單內,避免簽出歸到別家公司的憑證(company.ts 依憑證 CN 尾碼判定,E6)
ITA_ENV="${ITA_ENV:-/srv/giganexus/deploy/ita.env}"
case "$CN" in
  *.*)
    DOMAINS="$(grep '^ENDPOINT_COMPANY_DOMAINS=' "$ITA_ENV" 2>/dev/null | cut -d= -f2- | tr ';' '\n' | cut -d= -f2- | tr ',' '\n' | tr -d ' \r')"
    [ -n "$DOMAINS" ] || { echo "$ITA_ENV 沒有 ENDPOINT_COMPANY_DOMAINS,無法確認 $CN 的網域" >&2; exit 1; }
    printf '%s\n' "$DOMAINS" | awk -v cn="$CN" 'BEGIN { cn = tolower(cn) } $0 != "" { d = "." tolower($0); if (substr(cn, length(cn) - length(d) + 1) == d) f = 1 } END { exit !f }' ||
      { echo "$CN 的網域不在 ENDPOINT_COMPANY_DOMAINS($ITA_ENV)內" >&2; exit 1; }
    ;;
  *) echo "注意:$CN 不是 FQDN,endpoint-server 不會依憑證判定所屬公司,需在 /it/ 手動指定" >&2 ;;
esac

umask 077
WORK="$(mktemp -d)"
DONE=
# 中途失敗時連同輸出資料夾一起清掉,可直接重跑
trap 'rm -rf "$WORK"; [ -n "$DONE" ] || rm -rf "$OUT"' EXIT
# dash 被中斷時不一定執行 EXIT trap;改成正常結束,讓上面的清理一定執行(暫存目錄有未加密私鑰)
trap 'exit 130' INT TERM HUP
mkdir -p "$OUT"

openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$WORK/device.key" -out "$WORK/device.csr" \
  -subj "/O=GigaNexus/CN=$CN" 2>/dev/null
printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n" > "$WORK/device.ext"
# 隨機序號(不留 .srl 檔),寫進簽發紀錄供撤銷
openssl x509 -req -in "$WORK/device.csr" -CA "$PKI/agent-ca.crt" -CAkey "$PKI/agent-ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" -days 365 -sha256 -extfile "$WORK/device.ext" -out "$WORK/device.crt" 2>/dev/null
openssl verify -CAfile "$PKI/ca.crt" -untrusted "$PKI/agent-ca.crt" "$WORK/device.crt" >/dev/null

# 密碼只寫進檔案,不印在畫面;tr 去掉換行,避免 Windows 匯入時密碼不符
openssl rand -hex 16 | tr -dc '0-9a-f' > "$OUT/pfx-password.txt"
# AES-256 / SHA-256 加密的 PFX,Windows 10 1709 起可匯入
openssl pkcs12 -export -inkey "$WORK/device.key" -in "$WORK/device.crt" -certfile "$PKI/agent-ca.crt" \
  -name "GigaNexus Agent ($CN)" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 \
  -passout "file:$OUT/pfx-password.txt" -out "$OUT/$CN.pfx"
# 根 CA 只有公開憑證,建 MSI 用;已存在且相同就不動
cmp -s "$PKI/ca.crt" "$OUT_ROOT/ca-prod.crt" 2>/dev/null || cp "$PKI/ca.crt" "$OUT_ROOT/ca-prod.crt"

SERIAL="$(openssl x509 -in "$WORK/device.crt" -noout -serial | cut -d= -f2)"
END="$(openssl x509 -in "$WORK/device.crt" -noout -enddate | cut -d= -f2)"
( umask 077; printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CN" "$SERIAL" "$END" >> "$LOG" )
openssl x509 -in "$WORK/device.crt" -noout -subject -issuer -enddate
echo "serial=$SERIAL"
DONE=1
# printf '%s':dash 的 echo 會把 \a、\c 當跳脫字元
printf '%s\n' "完成:C:\\Users\\user\\agent-certs\\$CN\\($CN.pfx、pfx-password.txt);根 CA:C:\\Users\\user\\agent-certs\\ca-prod.crt"
