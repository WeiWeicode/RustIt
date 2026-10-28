#!/bin/sh
# 主機 2(測試區 WSL)讀寫掛載 NAS RustIT\test\incoming\ 與 RustIT\test\sign-queue\(S1-3,docs/S1-SIGNING-DESIGN.md §1):本人執行,
# 密碼以隱藏輸入寫入,不經開發機、不給 AI。
#   在主機 2 的 WSL:sudo sh host2-set-nas-upload.sh [--no-mount]
# 做的事(已存在的帳密檔不覆寫;要換帳密先刪除 $CRED 再執行):
#   1. 寫入 /srv/giganexus/nas-secrets/rustit-nas-upload.cred(root 擁有、0400)
#   2. 以 CIFS **讀寫**分別掛載兩個子目錄到 /srv/giganexus/nas-rustit-rw/test/{incoming,sign-queue}(除非 --no-mount),並確認可寫入
#   3. 以同一帳號試寫 software\、releases\、正式區 RustIT\prod\,任何一個寫得進去就以失敗結束
#   4. 印出 ita.env 要加的四行與 /etc/fstab 建議行(不自動改 fstab、不自動改 ita.env)
# NAS 上傳帳號(S1-5,請 NAS 管理員建立):只能寫 RustIT\test\incoming\ 與 RustIT\test\sign-queue\,**不可寫** software\、releases\,
# 也不可寫正式區 RustIT\prod\。sign-queue\ 只開給這個帳號與簽章工作站帳號,不開給 IT 群組(工作單可被能寫的人偽造,資安審查 M2)。
# 軟體庫與版本檔仍由 host2-set-nas-credentials.sh 的唯讀帳號掛載。
# 掛載點只有 uid 1000(容器內 node 使用者)可讀寫(0700 / 0600);WSL 預設使用者也是 uid 1000,所以 ssh host2 的帳號仍可寫,
# 簽章工作站因此在簽章前一律以 API Key 向主機確認送簽狀態(sign-status),不只看工作單。
set -eu
CRED_DIR=/srv/giganexus/nas-secrets
CRED=$CRED_DIR/rustit-nas-upload.cred
NAS_ROOT=//10.10.130.31/docker-folder/RustIT
NAS_BASE=$NAS_ROOT/test
MNT=/srv/giganexus/nas-rustit-rw/test
# seal:SMB3 加密(NAS 不支援時拿掉,至少確認 NAS 端啟用 SMB 簽章)
OPTS="nosuid,nodev,noexec,uid=1000,gid=1000,file_mode=0600,dir_mode=0700,vers=3.0,seal"

[ "$(id -u)" -eq 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }

umask 077
mkdir -p "$CRED_DIR"
chown root:root "$CRED_DIR"; chmod 700 "$CRED_DIR"

# ---------- 帳密檔(mount.cifs credentials 格式) ----------
if [ -L "$CRED" ]; then echo "$CRED 是符號連結,中止(請先確認並刪除)" >&2; exit 1; fi
if [ ! -e "$CRED" ]; then
  printf '%s' 'NAS 上傳帳號(只能寫 RustIT\test\incoming、sign-queue):'; read -r u
  [ -n "$u" ] || { echo "帳號空白,中止" >&2; exit 1; }
  # 中途按 Ctrl-C 也要恢復回顯
  trap 'stty echo' EXIT INT TERM
  stty -echo; printf 'NAS 密碼:'; read -r p; stty echo; echo
  trap - EXIT INT TERM
  [ -n "$p" ] || { echo "密碼空白,中止" >&2; exit 1; }
  printf 'NAS 網域(沒有請直接 Enter):'; read -r dom
  {
    printf 'username=%s\n' "$u"
    printf 'password=%s\n' "$p"
    [ -z "$dom" ] || printf 'domain=%s\n' "$dom"
  } > "$CRED"
  unset u p dom
  chown root:root "$CRED"; chmod 400 "$CRED"
  echo "已寫入 $CRED(root 唯讀)"
else
  echo "帳密檔已存在,略過:$CRED(要換帳密請先刪除再執行)"
fi

# ---------- 讀寫掛載與檢查 ----------
if [ "${1:-}" = "--no-mount" ]; then
  echo "略過掛載(--no-mount)"
else
  command -v mount.cifs >/dev/null 2>&1 || { echo "缺 cifs-utils,請先:apt-get install -y cifs-utils" >&2; exit 1; }
  for d in incoming sign-queue; do
    mkdir -p "$MNT/$d"
    if mountpoint -q "$MNT/$d"; then
      echo "$MNT/$d 已掛載,略過"
    else
      mount -t cifs "$NAS_BASE/$d" "$MNT/$d" -o "credentials=$CRED,rw,$OPTS" \
        || { echo "掛載失敗:檢查帳密、NAS 目錄 RustIT/test/$d 是否存在、SMB 版本(可改 vers=2.1)、NAS 是否支援 seal" >&2; exit 1; }
      echo "已讀寫掛載 $NAS_BASE/$d → $MNT/$d"
    fi
    if ( : > "$MNT/$d/.rw-probe" ) 2>/dev/null; then rm -f "$MNT/$d/.rw-probe"; echo "確認可寫入:$MNT/$d"
    else echo "$MNT/$d 無法寫入,請確認 NAS 上傳帳號的權限" >&2; exit 1; fi
  done

  # 上傳帳號不可寫軟體庫、版本檔、正式區(S1-5):以同一帳號暫時掛載試寫,應被拒
  bad=0
  for target in "$NAS_BASE/software" "$NAS_BASE/releases" "$NAS_ROOT/prod"; do
    PROBE=$(mktemp -d)
    if mount -t cifs "$target" "$PROBE" -o "credentials=$CRED,rw,$OPTS" 2>/dev/null; then
      if ( : > "$PROBE/.rw-probe" ) 2>/dev/null; then
        rm -f "$PROBE/.rw-probe"
        echo "錯誤:上傳帳號可以寫入 $target,請 NAS 管理員移除該帳號的寫入權" >&2
        bad=1
      else
        echo "確認上傳帳號不能寫 $target"
      fi
      umount "$PROBE" || echo "警告:無法卸載 $PROBE,請手動 umount" >&2
    else
      echo "上傳帳號無法掛載 $target(符合預期;若是路徑錯誤或網路問題請另行確認)"
    fi
    rmdir "$PROBE" 2>/dev/null || true
  done
  [ "$bad" -eq 0 ] || exit 1
fi

cat <<EOT

--- 接下來(由你決定何時啟用;先在 SQL Server 套用 migration 0011) ---
1. /srv/giganexus/deploy/ita.env 加入:
     ITA_INCOMING_HOST_DIR=$MNT/incoming
     ITA_SIGN_QUEUE_HOST_DIR=$MNT/sign-queue
     ITA_INCOMING_DIR=/srv/incoming
     ITA_SIGN_QUEUE_DIR=/srv/sign-queue
2. 重開機後要自動掛載:/etc/fstab 加(WSL 需 systemd 或在 WSL-GigaNexus 排程啟動後執行 mount -a):
     $NAS_BASE/incoming $MNT/incoming cifs credentials=$CRED,rw,$OPTS,_netdev,nofail 0 0
     $NAS_BASE/sign-queue $MNT/sign-queue cifs credentials=$CRED,rw,$OPTS,_netdev,nofail 0 0
3. 重跑 develop 的 deploy-test 重建 endpoint-server;啟動日誌 uploads 為 true 即已啟用
4. Gateway 建立簽章工作站的 API Key(只授 endpoint.software.sign-check,限定簽章人員電腦 IP)
EOT
