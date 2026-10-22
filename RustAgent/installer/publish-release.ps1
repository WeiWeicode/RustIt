<#
.SYNOPSIS
  把已簽章的發版檔案上架到版本檔目錄(P6-4;P6-UPGRADE-DESIGN §6、§9-3)。簽章人員在簽章後執行。

.DESCRIPTION
  輸入:sign-release.ps1 處理過的目錄(含 SHA256SUMS.signed.txt、SIGNED-INFO.txt)。
  1. 重新核對(不信任 SIGNED-INFO.txt 的自報欄位):路徑必須是 agent\<版本>\rustit-agent.exe 或 watchdog\<版本>\rustit-watchdog.exe(小寫精確比對),
     雜湊 = SHA256SUMS.signed.txt、ProductVersion = 路徑的版本、簽章者 = SIGNED-INFO 的指紋;MSI 不經升級通道,略過
  2. -Environment 必填:
       test:測試區主機(預設 host2);測試憑證與正式憑證都可
       prod:**拒絕**測試 / 自簽憑證(憑證本身判定)、要求簽章狀態 Valid 且有時間戳記;不可指向 host2(測試區主機)
     -Environment test 不可指向 host3(正式區主機)
  3. 放進版本檔目錄 {元件}/{版本}/{檔名}:先複製到同目錄的暫存檔、重算 SHA-256 比對,再不覆蓋地放置;**絕不覆蓋既有版本檔**
     (已存在且相同 → 略過;內容不同、連結、或放置時被別人搶先 → 中止)。中途中止時已放好的項目不會回滾。
     同一版本號重新建置的檔案內容會不同(例如只改 Agent,CI 又建了一次未改版本的 Watchdog)而被拒絕:只放有新版本號的元件目錄
     - 預設(P7 起):NAS -NasReleasesDir(UNC;test 不給時用測試區 NAS 的 RustIT\releases),由本機以 SMB 直接寫入;
       執行的 Windows 帳號要有 NAS RustIT 的寫入權(IT 寫入帳號,先 net use)。主機只唯讀掛載,不能經主機寫入。
       放好後經 ssh 到 -HostAlias,以唯讀掛載(-MountCheckDir)重算 SHA-256,確認 endpoint-server 讀得到(失敗只警告)
     - -HostDir:舊方式(NAS 之前),以 scp 複製到主機的暫存(每次一個 GUID 子目錄,ACL 只有登入帳號 / SYSTEM / Administrators),
       再在 WSL 以 root 放進主機本機目錄 {ReleasesDir}(mv -n)
  4. 印出登錄資料(元件、版本、檔名、預期簽章者指紋)。登錄在 GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」
     (或 POST /api/endpoint/releases);登錄是草稿,先設給 pilot 環驗證,再發佈,才能推到 it / all

  正式區(-Environment prod)必須明確指定 -NasReleasesDir 與 -HostAlias(或 -HostDir 加 -HostAlias / -HostStage / -ReleasesDir;
  換主機要一起傳 -HostStage:預設是主機 2 `user` 帳號的路徑)。-DryRun:只核對與列出會做的事,不連線、不複製。
  請用受保護 tag 或 main 的 checkout 執行本腳本(腳本本身也在信任鏈內)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment test -DryRun
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment test
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Environment,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')][string]$HostAlias = 'host2',
    # NAS 版本檔目錄(UNC);test 不給時用測試區 NAS
    [string]$NasReleasesDir = '',
    # 主機唯讀掛載的同一個目錄(放好後經 ssh 重算雜湊確認;空字串 = 不檢查)
    [string]$MountCheckDir = '/srv/giganexus/nas-rustit/releases',
    # 舊方式:放進主機本機目錄 -ReleasesDir
    [switch]$HostDir,
    [string]$ReleasesDir = '/srv/giganexus/ita-releases',
    # 主機 2 是 Windows(SSH 預設 PowerShell,Docker / 版本檔目錄在 WSL):先複製到這個 Windows 暫存目錄底下的 GUID 子目錄
    [string]$HostStage = 'C:/Users/user/ita-publish',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$signedSums = Join-Path $Dir 'SHA256SUMS.signed.txt'
$infoFile = Join-Path $Dir 'SIGNED-INFO.txt'
if (-not (Test-Path -LiteralPath $signedSums) -or -not (Test-Path -LiteralPath $infoFile)) { throw '目錄還沒簽章(缺 SHA256SUMS.signed.txt / SIGNED-INFO.txt):先執行 sign-release.ps1' }
if ($ReleasesDir -notmatch '^/[A-Za-z0-9/_.-]+$' -or $ReleasesDir -match '\.\.') { throw "ReleasesDir 不合法:$ReleasesDir" }
if ($HostStage -notmatch '^[A-Za-z]:/[A-Za-z0-9/_.-]+$' -or $HostStage -match '\.\.') { throw "HostStage 要是 Windows 路徑(正斜線):$HostStage" }
if ($Environment -eq 'prod' -and $HostAlias -eq 'host2') { throw 'host2 是測試區主機:正式區請指定正式區主機(-HostAlias / -HostStage / -ReleasesDir)' }
if ($Environment -eq 'test' -and $HostAlias -eq 'host3') { throw 'host3 是正式區主機:-Environment test 不可指向它' }
if (-not $HostDir) {
    if (-not $NasReleasesDir) {
        if ($Environment -eq 'prod') { throw '正式區要明確指定 -NasReleasesDir(或 -HostDir)' }
        $NasReleasesDir = '\\10.10.130.31\docker-folder\RustIT\releases'
    }
    if ($NasReleasesDir -notmatch '^\\\\[A-Za-z0-9._-]+(\\[^\\/:*?"<>|]+)+$' -or $NasReleasesDir -match '\.\.') { throw "NasReleasesDir 要是 UNC 路徑(\\主機\共用\...):$NasReleasesDir" }
    if ($MountCheckDir -and ($MountCheckDir -notmatch '^/[A-Za-z0-9/_.-]+$' -or $MountCheckDir -match '\.\.')) { throw "MountCheckDir 不合法:$MountCheckDir" }
}

$info = @{}
foreach ($l in (Get-Content -LiteralPath $infoFile -Encoding UTF8)) { if ($l -match '^([a-z_]+)=(.*)$') { $info[$Matches[1]] = $Matches[2] } }
$signer = $info['signer_thumbprint']
if ($signer -cnotmatch '^[0-9a-f]{40}$') { throw 'SIGNED-INFO.txt 沒有簽章者指紋' }

# 1. 重新核對
$semver = '[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,20})?'
$pathRe = "^(agent|watchdog)/($semver)/(rustit-(?:agent|watchdog)\.exe)$"
$items = @()
$testCert = $false
foreach ($line in (Get-Content -LiteralPath $signedSums -Encoding UTF8)) {
    if (-not $line.Trim()) { continue }
    if ($line -cnotmatch '^([0-9a-f]{64})  (.+)$') { throw "SHA256SUMS.signed.txt 格式錯誤:$line" }
    $sha = $Matches[1]; $rel = $Matches[2]
    if ($rel -cmatch '^msi/') { Write-Host "略過(不經升級通道):$rel"; continue }
    if ($rel -cnotmatch $pathRe) { throw "不接受的路徑:$rel" }
    $comp = $Matches[1]; $ver = $Matches[2]; $file = $Matches[3]
    if ($file -cne "rustit-$comp.exe") { throw "元件與檔名不搭:$rel" }
    $p = [IO.Path]::GetFullPath((Join-Path $Dir ($rel -replace '/', '\')))
    if (-not $p.StartsWith($Dir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "路徑跑出目錄:$rel" }
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "缺檔:$rel" }
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne $sha) { throw "雜湊與 SHA256SUMS.signed.txt 不符:$rel(簽章後檔案被改過?)" }
    if ((Get-Item -LiteralPath $p).VersionInfo.ProductVersion -ne $ver) { throw "ProductVersion 與路徑的版本不符:$rel" }
    $sig = Get-AuthenticodeSignature -LiteralPath $p
    if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint.ToLower() -ne $signer) { throw "簽章者與 SIGNED-INFO.txt 不符:$rel" }
    $isTest = ($sig.SignerCertificate.Subject -match 'not for production') -or ($sig.SignerCertificate.Subject -eq $sig.SignerCertificate.Issuer)
    if ($isTest) { $testCert = $true }
    if ($Environment -eq 'prod') {
        if ($isTest) { throw "測試 / 自簽憑證簽的檔案不能上正式區:$rel" }
        if ($sig.Status -ne 'Valid') { throw "簽章狀態不是 Valid:$rel($($sig.Status))" }
        if (-not $sig.TimeStamperCertificate) { throw "簽章沒有時間戳記:$rel" }
    }
    $items += [pscustomobject]@{ Component = $comp; Version = $ver; File = $file; Rel = $rel; Path = $p; Sha = $sha; Size = (Get-Item -LiteralPath $p).Length }
}
if ($items.Count -eq 0) { throw '沒有可上架的 agent / watchdog 檔案' }
if ($testCert) { Write-Warning '這批檔案是測試憑證簽的:只能放測試區' }
Write-Host "核對通過;環境 $Environment,預期簽章者 $signer"
$items | Format-Table Component, Version, File, Size, @{ n = 'SHA-256(前 16 碼)'; e = { $_.Sha.Substring(0, 16) } } -AutoSize | Out-String | Write-Host

if ($DryRun) {
    if ($HostDir) { Write-Host "[DryRun] 會複製到 ${HostAlias}:$ReleasesDir/{元件}/{版本}/{檔名}(不覆蓋既有檔),未連線。" }
    else { Write-Host "[DryRun] 會複製到 $NasReleasesDir\{元件}\{版本}\{檔名}(不覆蓋既有檔),未連線。" }
    return
}

function Write-Registration {
    Write-Host ''
    Write-Host '上架完成。到 GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」,登錄資料:'
    foreach ($it in $items) { Write-Host ("  {0,-8} {1,-14} {2}  預期簽章者 {3}" -f $it.Component, $it.Version, $it.File, $signer) }
    Write-Host '登錄後是草稿:先設給 pilot 環,驗證後再發佈,才能推到 it / all 環(P6-UPGRADE-DESIGN §1)。'
}

# 2a. NAS(預設):本機以 SMB 寫入,暫存檔 → 重算雜湊 → 不覆蓋地放置
if (-not $HostDir) {
    if (-not (Test-Path -LiteralPath $NasReleasesDir -PathType Container)) { throw "連不到 $NasReleasesDir(先以有 RustIT 寫入權的帳號 net use)" }
    $guid = [guid]::NewGuid().ToString('N')
    $placed = @()
    foreach ($it in $items) {
        $tag = "$($it.Component)/$($it.Version)"
        $ddir = Join-Path $NasReleasesDir "$($it.Component)\$($it.Version)"
        $dest = Join-Path $ddir $it.File
        if (Test-Path -LiteralPath $dest) {
            $existing = Get-Item -LiteralPath $dest -Force
            if (-not $existing.LinkType -and -not $existing.PSIsContainer -and (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -eq $it.Sha) {
                Write-Host "SKIP   $tag 已存在且相同"
                $placed += $it
                continue
            }
            throw "REFUSE $tag 已存在但內容不同、或是連結 / 目錄(不覆蓋);中止前已放好的項目不會回滾"
        }
        New-Item -ItemType Directory -Force -Path $ddir | Out-Null
        $tmp = Join-Path $ddir ".$($it.File).tmp.$guid"
        try {
            Copy-Item -LiteralPath $it.Path -Destination $tmp
            $got = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
            if ($got -ne $it.Sha) { throw "MISMATCH $tag(複製後雜湊不符)" }
            # File.Move 在目的地已存在時失敗:放置時被別人搶先也不覆蓋
            try { [IO.File]::Move($tmp, $dest) } catch { throw "REFUSE $tag 放置時別人已經放了同一個版本(不覆蓋)" }
        } finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        Write-Host "OK     $tag $got"
        $placed += $it
    }
    # 主機唯讀掛載讀到的內容(endpoint-server 讀這裡);只警告,不影響上架結果
    if ($MountCheckDir) {
        foreach ($it in $placed) {
            $m = "$MountCheckDir/$($it.Component)/$($it.Version)/$($it.File)"
            $out = & ssh -o BatchMode=yes $HostAlias "wsl -u root -e sha256sum '$m'" 2>$null
            $have = if ($LASTEXITCODE -eq 0 -and "$out" -match '^([0-9a-f]{64})\s') { $Matches[1] } else { '' }
            if ($have -eq $it.Sha) { Write-Host "掛載確認 $($it.Component)/$($it.Version):$HostAlias 讀到的雜湊相符" }
            else { Write-Warning "${HostAlias}:$m 讀不到或雜湊不同(掛載中斷?),到主機確認後再登錄" }
        }
    }
    Write-Registration
    return
}

# 2b. -HostDir:暫存(GUID 子目錄 + 限制 ACL)+ 放進主機本機目錄
$guid = [guid]::NewGuid().ToString('N')
$stage = "$HostStage/$guid"
$stageWin = $stage -replace '/', '\'
$stageWsl = '/mnt/' + $stage.Substring(0, 1).ToLower() + $stage.Substring(2)
$sshOpt = @('-o', 'BatchMode=yes')
$mk = "New-Item -ItemType Directory -Force -Path '$stageWin' | Out-Null; icacls '$stageWin' --% /inheritance:r /grant:r %USERNAME%:(OI)(CI)F SYSTEM:(OI)(CI)F Administrators:(OI)(CI)F"
$rc = 1
try {
    & ssh @sshOpt $HostAlias $mk | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法在 $HostAlias 建立暫存目錄(ssh / icacls)" }
    $sh = New-Object Text.StringBuilder
    [void]$sh.Append(@"
set -e
R='$ReleasesDir'
S='$stageWsl'
put() {
  comp="`$1"; ver="`$2"; src="`$3"; file="`$4"; sha="`$5"
  ddir="`$R/`$comp/`$ver"; dest="`$ddir/`$file"
  if [ -e "`$dest" ] || [ -L "`$dest" ]; then
    have=`$(sha256sum "`$dest" 2>/dev/null | cut -d' ' -f1 || true)
    if [ "`$have" = "`$sha" ]; then echo "SKIP   `$comp/`$ver 已存在且相同"; return; fi
    echo "REFUSE `$comp/`$ver 已存在但內容不同、或是符號連結(不覆蓋)"; exit 3
  fi
  mkdir -p "`$ddir"
  tmp="`$ddir/.`$file.tmp.`$`$"
  cp "`$S/`$src" "`$tmp"
  got=`$(sha256sum "`$tmp" | cut -d' ' -f1)
  if [ "`$got" != "`$sha" ]; then rm -f "`$tmp"; echo "MISMATCH `$comp/`$ver"; exit 4; fi
  chmod 644 "`$tmp"
  mv -n "`$tmp" "`$dest"
  if [ -e "`$tmp" ]; then rm -f "`$tmp"; echo "REFUSE `$comp/`$ver 放置時別人已經放了同一個版本(不覆蓋)"; exit 3; fi
  echo "OK     `$comp/`$ver `$got"
}

"@)
    $i = 0
    foreach ($it in $items) {
        $i++
        $stageName = "$i-$($it.Component)-$($it.Version)-$($it.File)"
        & scp -q @sshOpt $it.Path "${HostAlias}:$stage/$stageName"
        if ($LASTEXITCODE -ne 0) { throw "scp 失敗:$($it.Rel)" }
        [void]$sh.AppendLine("put '$($it.Component)' '$($it.Version)' '$stageName' '$($it.File)' '$($it.Sha)'")
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "publish-release-$guid.sh"
    [IO.File]::WriteAllText($tmp, $sh.ToString().Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
    try {
        & scp -q @sshOpt $tmp "${HostAlias}:$stage/publish-release.sh"
        if ($LASTEXITCODE -ne 0) { throw 'scp 失敗:publish-release.sh' }
    } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    & ssh @sshOpt $HostAlias "wsl -u root -e bash $stageWsl/publish-release.sh"
    $rc = $LASTEXITCODE
} finally {
    # 只清這次的 GUID 子目錄(不影響別人同時在上架)
    & ssh @sshOpt $HostAlias "Remove-Item -LiteralPath '$stageWin' -Recurse -Force -ErrorAction SilentlyContinue" 2>$null | Out-Null
}
if ($rc -ne 0) { throw "上架失敗(結束碼 $rc);上面的 REFUSE / MISMATCH 說明原因。版本檔目錄沒有被覆蓋,但中止前已放好的項目不會回滾" }

# 3. 登錄資料
Write-Registration
