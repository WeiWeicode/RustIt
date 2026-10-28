#!/bin/sh
# 主機 2(測試區 WSL)準備 NAS RustIT\ 唯讀掛載的帳密(P7-4,docs/P7-SOFTWARE-DESIGN.md §4):本人執行,密碼以隱藏輸入寫入,不經開發機、不給 AI。
#   在主機 2 的 WSL:sudo sh host2-set-nas-credentials.sh [--no-mount]
# 做的事(已存在的帳密檔不覆寫;要換帳密先刪除 $CRED 再執行):
#   1. 寫入 /srv/giganexus/nas-secrets/rustit-nas.cred(root 擁有、0400;不放進 ita-secrets,因為該目錄會被 chown 給容器內的 node 使用者)
#   2. 以 CIFS **唯讀**掛載 //10.10.130.31/docker-folder/RustIT 到 /srv/giganexus/nas-rustit(除非 --no-mount),並檢查 test/releases/、test/software/ 存在(B-3:兩區分開,測試區用 RustIT\test\)
#   3. 印出 ita.env 要加的兩行與 /etc/fstab 建議行(不自動改 fstab、不自動改 ita.env)
# NAS 帳號必須是唯讀帳號(IT 可寫、endpoint-server 帳號唯讀,ADR 0002)。Agent 不拿 NAS 帳密、不直接連 NAS。
set -eu
CRED_DIR=/srv/giganexus/nas-secrets
CRED=$CRED_DIR/rustit-nas.cred
NAS_SHARE=//10.10.130.31/docker-folder/RustIT
MNT=/srv/giganexus/nas-rustit

[ "$(id -u)" -eq 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }

umask 077
mkdir -p "$CRED_DIR"
chown root:root "$CRED_DIR"; chmod 700 "$CRED_DIR"

# ---------- 帳密檔(mount.cifs credentials 格式) ----------
if [ ! -f "$CRED" ]; then
  printf 'NAS 唯讀帳號(RustIT\\ 唯讀):'; read -r u
  [ -n "$u" ] || { echo "帳號空白,中止" >&2; exit 1; }
  stty -echo; printf 'NAS 密碼:'; read -r p; stty echo; echo
  [ -n "$p" ] || { echo "密碼空白,中止" >&2; exit 1; }
  # 網域(選填;非網域帳號直接 Enter)
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

# ---------- 唯讀掛載與檢查 ----------
if [ "${1:-}" = "--no-mount" ]; then
  echo "略過掛載(--no-mount)"
else
  command -v mount.cifs >/dev/null 2>&1 || { echo "缺 cifs-utils,請先:apt-get install -y cifs-utils" >&2; exit 1; }
  mkdir -p "$MNT"
  if mountpoint -q "$MNT"; then
    echo "$MNT 已掛載,略過"
  else
    # ro:唯讀;nosuid,nodev,noexec:不允許在掛載點執行;uid/gid 1000 讓容器內 node 可讀;vers=3.0 視 NAS 調整
    mount -t cifs "$NAS_SHARE" "$MNT" -o "credentials=$CRED,ro,nosuid,nodev,noexec,uid=1000,gid=1000,file_mode=0444,dir_mode=0555,vers=3.0" \
      || { echo "掛載失敗:檢查帳密、NAS 共用名稱 $NAS_SHARE、SMB 版本(可改 vers=2.1)" >&2; exit 1; }
    echo "已唯讀掛載 $NAS_SHARE → $MNT"
  fi
  for d in test/releases test/software; do
    if [ -d "$MNT/$d" ]; then echo "找到 $MNT/$d"; else printf '警告:NAS 上沒有 RustIT/%s/,請建立(IT 寫入帳號,RUNBOOK §1.1)後再切換\n' "$d" >&2; fi
  done
  # 確認真的唯讀(寫入應失敗)
  if ( : > "$MNT/.rw-probe" ) 2>/dev/null; then
    rm -f "$MNT/.rw-probe"; echo "警告:掛載可寫入!請改用唯讀帳號" >&2
  else
    echo "確認唯讀:寫入測試被拒"
  fi
fi

cat <<EOF

--- 接下來(由你決定何時切換;切換前 develop 要先合併 P7-4 的 compose 說明) ---
1. /srv/giganexus/deploy/ita.env 加入(把兩個目錄改指向 NAS 掛載):
     ITA_RELEASES_HOST_DIR=$MNT/test/releases
     ITA_SOFTWARE_HOST_DIR=$MNT/test/software
2. 重開機後要自動掛載:/etc/fstab 加(WSL 需 systemd 或在 WSL-GigaNexus 排程啟動後執行 mount -a):
     $NAS_SHARE $MNT cifs credentials=$CRED,ro,nosuid,nodev,noexec,uid=1000,gid=1000,file_mode=0444,dir_mode=0555,vers=3.0,_netdev,nofail 0 0
3. 把現有檔案複製到 NAS 的 RustIT/test/releases、RustIT/test/software(用 IT 寫入帳號)並比對雜湊,
   再重跑 develop 的 deploy-test 重建 endpoint-server;完整步驟見 docs/RUNBOOK.md §1.1
EOF
