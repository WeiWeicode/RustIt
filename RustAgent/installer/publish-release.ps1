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
  2a. 版本號查重(P7 VM 驗收 B-3,需求方 2026-10-27):同一元件同一版本號已登錄過(含已撤回)就停止(換新版本號重建)。
     查不到(連不上、API Key 無效、正式區尚未部署)也停止,除非加 -SkipRegistryCheck(印警告;只在確定該版本沒登錄過時用)。-DryRun 不查。
     - 建議(S1-1,S1-SIGNING-DESIGN §2):-GatewayUrl + -ApiKeyFile,以 X-Api-Key 呼叫 GET /api/endpoint/releases/registry;
       回應的 environment 必須等於 -Environment。API Key 只授 endpoint.release.registry,由 Gateway 負責人建立(限定來源 IP);
       金鑰檔只放金鑰一行,其他使用者(Everyone / Users / Authenticated Users)不可讀,不接受命令列明文。不需要主機帳號。
     - 未給 -ApiKeyFile(舊方式,過渡期保留):經 ssh 到 -HostAlias,在目標區 endpoint-server 容器(-ServerContainer)內以唯讀查詢
       ita.agent_release;簽章人員要有主機 root 權限
  3. 放進版本檔目錄 {元件}/{版本}/{檔名}:先複製到同目錄的暫存檔、重算 SHA-256 比對,再不覆蓋地放置;**絕不覆蓋既有版本檔**
     (已存在且相同 → 略過;內容不同、連結、或放置時被別人搶先 → 中止)。中途中止時已放好的項目不會回滾。
     同一版本號重新建置的檔案內容會不同(例如只改 Agent,CI 又建了一次未改版本的 Watchdog)而被拒絕:只放有新版本號的元件目錄
     - 預設(P7 起):NAS -NasReleasesDir(UNC),由本機以 SMB 直接寫入。同一台 NAS 兩區路徑分開(需求方 2026-10-27,B-3):
       test = \\10.10.130.31\docker-folder\RustIT\test\releases、prod = \\10.10.130.31\docker-folder\RustIT\prod\releases,
       不給時依 -Environment 選;給了但與環境不一致(例如 test 指到 prod\ 或舊的 RustIT\releases)就停止;
       執行的 Windows 帳號要有 NAS RustIT 的寫入權(IT 寫入帳號,先 net use)。主機只唯讀掛載,不能經主機寫入。
       放好後經 ssh 到 -HostAlias,以唯讀掛載(-MountCheckDir)重算 SHA-256,確認 endpoint-server 讀得到(失敗只警告)
     - -HostDir:舊方式(NAS 之前),以 scp 複製到主機的暫存(每次一個 GUID 子目錄,ACL 只有登入帳號 / SYSTEM / Administrators),
       再在 WSL 以 root 放進主機本機目錄 {ReleasesDir}(mv -n)
  4. 印出登錄資料(元件、版本、檔名、預期簽章者指紋)。登錄在 GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」
     (或 POST /api/endpoint/releases);登錄是草稿,先設給 pilot 環驗證,再發佈,才能推到 it / all

  正式區(-Environment prod)必須明確指定 -HostAlias 與 -ServerContainer(或 -HostDir 加 -HostAlias / -HostStage / -ReleasesDir;
  換主機要一起傳 -HostStage:預設是主機 2 `user` 帳號的路徑);主機的 docker 不在 WSL 時加 -DockerCmd docker。-DryRun:只核對與列出會做的事,不連線、不複製。
  請用受保護 tag 或 main 的 checkout 執行本腳本(腳本本身也在信任鏈內)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment test -DryRun
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment test
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][ValidateSet('test', 'prod')][string]$Environment,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')][string]$HostAlias = 'host2',
    # NAS 版本檔目錄(UNC);不給時依環境(test\releases / prod\releases),給了必須與環境一致
    [string]$NasReleasesDir = '',
    # 主機唯讀掛載的同一個目錄(放好後經 ssh 重算雜湊確認);auto = /srv/giganexus/nas-rustit/{環境}/releases,空字串 = 不檢查
    [string]$MountCheckDir = 'auto',
    # 版本號查重:目標區 endpoint-server 容器(test 預設測試區;prod 必填)與主機上執行 docker 的方式
    [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$ServerContainer = '',
    [ValidateSet('wsl -u root -e docker', 'docker')][string]$DockerCmd = 'wsl -u root -e docker',
    # 版本號查重改走 Gateway API(S1-1):Gateway 網址(https://主機,不含路徑)與 API Key 檔;給了 -ApiKeyFile 就不經 ssh 查詢
    [ValidatePattern('^$|^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$')][string]$GatewayUrl = '',
    [string]$ApiKeyFile = '',
    [switch]$SkipRegistryCheck,
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
if ($ApiKeyFile -and -not $GatewayUrl) { throw '-ApiKeyFile 要搭配 -GatewayUrl(https://Gateway 主機)' }
# 每區允許的 Gateway 主機(資安審查 M2 / L1):打錯網址不會把 API Key 送到別台;換主機時改這裡(與 $NasReleaseDirs 相同作法)
$GatewayHosts = @{
    test = @('10.10.130.124')
    prod = @('giganexus.gigasolar.com.tw')
}
if ($GatewayUrl) {
    $gwHost = ([uri]$GatewayUrl).Host
    if ($GatewayHosts[$Environment] -notcontains $gwHost) { throw "-GatewayUrl 的主機 $gwHost 不是 $Environment 區的 Gateway(允許:$($GatewayHosts[$Environment] -join ', '))" }
}
if ($GatewayUrl -and -not $ApiKeyFile) { throw '-GatewayUrl 要搭配 -ApiKeyFile' }
# 同一台 NAS、兩區路徑分開(B-3):目的地必須與環境一致
$NasReleaseDirs = @{
    test = '\\10.10.130.31\docker-folder\RustIT\test\releases'
    prod = '\\10.10.130.31\docker-folder\RustIT\prod\releases'
}
if (-not $HostDir) {
    $expectedNas = $NasReleaseDirs[$Environment]
    if (-not $NasReleasesDir) { $NasReleasesDir = $expectedNas }
    # -ne 不分大小寫(UNC 不分大小寫);去掉結尾的 \ 再比
    $NasReleasesDir = $NasReleasesDir.TrimEnd('\')
    if ($NasReleasesDir -ne $expectedNas) {
        throw "-NasReleasesDir 與 -Environment $Environment 不一致:$NasReleasesDir(${Environment} 區應為 $expectedNas;舊的 RustIT\releases 已停用)"
    }
    if ($MountCheckDir -eq 'auto') { $MountCheckDir = "/srv/giganexus/nas-rustit/$Environment/releases" }
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

# 2a. 版本號查重(B-3):目標區已登錄過同一個版本(含已撤回)就停止;查不到也停止(-SkipRegistryCheck 例外)
if (-not $ServerContainer -and $Environment -eq 'test') { $ServerContainer = 'giganexus-ita-test-endpoint-server-1' }
function Get-RegisteredReleases {
    # 在容器內以應用程式自己的 SQL 帳號唯讀查詢(密碼只在容器內讀取,不經本機);元件與版本已由上面的路徑規則驗過
    $pairs = ($items | ForEach-Object { '["{0}","{1}"]' -f $_.Component, $_.Version }) -join ','
    $js = @"
const fs=require('fs');const sql=require('mssql');const e=process.env;
(async()=>{const pool=await new sql.ConnectionPool({server:e.ITA_DB_HOST,port:Number(e.ITA_DB_PORT||1433),database:e.ITA_DB_NAME,user:e.ITA_DB_USER,
password:e.ITA_DB_PASSWORD_FILE?fs.readFileSync(e.ITA_DB_PASSWORD_FILE,'utf8').trim():e.ITA_DB_PASSWORD,
options:{encrypt:false,trustServerCertificate:true,appName:'publish-release-check'},connectionTimeout:10000,requestTimeout:15000}).connect();
const out=[];for(const [c,v] of [$pairs]){const r=await pool.request().input('c',sql.VarChar(16),c).input('v',sql.VarChar(40),v)
.query('SELECT component, version, status FROM ita.agent_release WHERE component = @c AND version = @v');for(const x of r.recordset)out.push('REGISTERED '+x.component+' '+x.version+' '+x.status);}
await pool.close();console.log('REGISTRY-OK '+e.ITA_DB_NAME);for(const l of out)console.log(l);})().catch((err)=>{console.log('REGISTRY-ERROR '+((err&&(err.code||err.name))||'ERROR'));process.exit(2);});
"@
    # 以 base64 經 ssh / PowerShell / wsl / docker exec 傳遞,避免各層引號規則不同;程式碼只含上面固定的查詢。
    # 注意:$js 只可放已驗證的元件 / 版本(上面的路徑規則),且只能是 ASCII(atob 不是 UTF-8 解碼)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
    $out = @()
    try {
        $out = @(& ssh -o BatchMode=yes $HostAlias "$DockerCmd exec $ServerContainer node -e 'eval(atob(process.argv[1]))' $b64" 2>$null)
    } catch { $out = @() }
    $ok = $out | Where-Object { $_ -match '^REGISTRY-OK ' } | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $ok) {
        $why = ($out | Where-Object { $_ -match '^REGISTRY-ERROR ' } | Select-Object -First 1)
        return [pscustomobject]@{ Ok = $false; Why = $(if ($why) { $why } else { "ssh / docker exec 失敗(結束碼 $LASTEXITCODE)" }); Rows = @() }
    }
    [pscustomobject]@{ Ok = $true; Why = $ok; Rows = @($out | Where-Object { $_ -match '^REGISTERED ' }) }
}
# S1-1:以 API Key 呼叫 Gateway 的版本號查重(唯讀、只回元件 / 版本 / 狀態 / 部署區),不需要主機帳號
function Read-ApiKey {
    if ($ApiKeyFile -match '^\\') { throw '-ApiKeyFile 不可放在網路分享(分享層權限檢查不到);放本機使用者目錄' }
    $f = (Resolve-Path -LiteralPath $ApiKeyFile).Path
    # 白名單(資安審查 M1):只允許本人、SYSTEM、Administrators 有任何 Allow 權限;擁有者須為本人或 Administrators。
    # 以 SID 比對(中文版 Windows 名稱會在地化);Domain Users、其他同仁等任何其他身分有權限就拒絕
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $okSids = @($me, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $f
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $me -and $owner -ne 'S-1-5-32-544') { throw "API Key 檔的擁有者不是本人(SID $owner):$f" }
    $other = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
            $_.AccessControlType -eq 'Allow' -and ($okSids -notcontains $_.IdentityReference.Value)
        })
    if ($other.Count) {
        throw "API Key 檔有其他身分的權限(SID $($other[0].IdentityReference.Value)):$f;執行 icacls `"$f`" /inheritance:r /grant:r `"*${me}:(R)`" 只留本人"
    }
    $k = (Get-Content -LiteralPath $f -Raw -Encoding UTF8).Trim()
    if ($k -notmatch '^[!-~]{16,512}$') { throw "API Key 檔格式不對(只放金鑰一行):$f" }
    $k
}
function Get-RegisteredReleasesApi {
    $key = Read-ApiKey
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $base = $GatewayUrl.TrimEnd('/')
    $rows = @()
    foreach ($it in $items) {
        # 元件 / 版本已由上面的路徑規則驗過(英數與 . -),仍以 EscapeDataString 組查詢字串
        $u = '{0}/api/endpoint/releases/registry?component={1}&version={2}' -f $base, [uri]::EscapeDataString($it.Component), [uri]::EscapeDataString($it.Version)
        # 不跟隨重新導向(資安審查 M2):PowerShell 5.1 會把 X-Api-Key 一併帶到導向的主機;3xx 視為失敗
        try {
            $resp = Invoke-WebRequest -Uri $u -Headers @{ 'X-Api-Key' = $key } -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 0 -ErrorAction Stop
        } catch {
            $code = $null
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            return [pscustomobject]@{ Ok = $false; Why = $(if ($code) { "HTTP $code(401 / 403:API Key 無效、權限不足或來源 IP 不在允許清單;3xx:不跟隨重新導向)" } else { $_.Exception.Message }); Rows = @() }
        }
        if ($resp.StatusCode -ne 200) { return [pscustomobject]@{ Ok = $false; Why = "HTTP $($resp.StatusCode)(不跟隨重新導向)"; Rows = @() } }
        try { $r = $resp.Content | ConvertFrom-Json } catch { $r = $null }
        if (-not $r -or -not $r.environment) { return [pscustomobject]@{ Ok = $false; Why = '回應格式不對(缺 environment)'; Rows = @() } }
        # 每一筆回應都要是目標區(資安審查 L2;避免 -GatewayUrl 指到另一區而照樣通過)
        if ([string]$r.environment -cne $Environment) { return [pscustomobject]@{ Ok = $false; Why = "回應的部署區是 $($r.environment),不是 $Environment"; Rows = @() } }
        foreach ($x in @($r.items)) { if ($x) { $rows += ('REGISTERED {0} {1} {2}' -f $x.component, $x.version, $x.status) } }
    }
    [pscustomobject]@{ Ok = $true; Why = "Gateway $base(environment=$Environment)"; Rows = $rows }
}
if ($DryRun) {
    Write-Host '[DryRun] 未查版本表(上架時會查目標區是否已登錄過同一版本)。'
} elseif ($SkipRegistryCheck) {
    Write-Warning "-SkipRegistryCheck:未查 $Environment 區的版本表;同一版本號已登錄(含已撤回)時,放好的檔案將無法登錄(409 ITA_RELEASE_EXISTS)"
} elseif ($ApiKeyFile) {
    $reg = Get-RegisteredReleasesApi
    if (-not $reg.Ok) { throw "查不到 $Environment 區的版本表($GatewayUrl):$($reg.Why)。確定版本沒登錄過時才加 -SkipRegistryCheck" }
    if ($reg.Rows.Count) {
        $reg.Rows | ForEach-Object { Write-Host $_ }
        throw "$Environment 區已登錄過上面的版本(含已撤回的也不能重用):改用新的版本號重新建置,不上架"
    }
    Write-Host "版本表確認:$($reg.Why) 沒有登錄過這些版本"
} else {
    Write-Warning '版本號查重經 ssh 以 root 進主機(舊方式);建議改用 -GatewayUrl + -ApiKeyFile(S1-SIGNING-DESIGN §2)'
    if (-not $ServerContainer) { throw '正式區要指定 -ServerContainer(endpoint-server 容器名稱)才能查版本表;或確定版本沒登錄過時加 -SkipRegistryCheck' }
    $reg = Get-RegisteredReleases
    if (-not $reg.Ok) { throw "查不到 $Environment 區的版本表(${HostAlias} / $ServerContainer):$($reg.Why)。確定版本沒登錄過時才加 -SkipRegistryCheck" }
    # 查到的資料庫必須屬於目標區(避免 -HostAlias / -ServerContainer 指到另一區而照樣通過;資安稽核 M1)
    $db = ($reg.Why -replace '^REGISTRY-OK\s+', '').Trim()
    $dbOk = if ($Environment -eq 'test') { $db -eq 'giganexus_It_Agent_test' } else { $db -like 'giganexus_It_Agent*' -and $db -notmatch 'test' }
    if (-not $dbOk) { throw "查到的資料庫 $db 不是 $Environment 區的(${HostAlias} / $ServerContainer):檢查 -HostAlias 與 -ServerContainer" }
    if ($reg.Rows.Count) {
        $reg.Rows | ForEach-Object { Write-Host $_ }
        throw "$Environment 區已登錄過上面的版本(含已撤回的也不能重用):改用新的版本號重新建置,不上架"
    }
    Write-Host "版本表確認:$($reg.Why) 沒有登錄過這些版本"
}

if ($DryRun) {
    if ($HostDir) { Write-Host "[DryRun] 會複製到 ${HostAlias}:$ReleasesDir/{元件}/{版本}/{檔名}(不覆蓋既有檔),未連線。" }
    else { Write-Host "[DryRun] 會複製到 $NasReleasesDir\{元件}\{版本}\{檔名}(不覆蓋既有檔),未連線。" }
    return
}

function Write-Registration {
    Write-Host ''
    Write-Host '上架完成。到 GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」,登錄資料:'
    foreach ($it in $items) { Write-Host ("  {0,-8} {1,-14} {2}  預期簽章者 {3}  SHA-256 {4}" -f $it.Component, $it.Version, $it.File, $signer, $it.Sha) }
    Write-Host '登錄後主機算出的 SHA-256 要與上面相同。'
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
        # 不用 New-Item -Path(會把 [ ] 當萬用字元)
        [void][IO.Directory]::CreateDirectory($ddir)
        $tmp = Join-Path $ddir ".$($it.File).tmp.$guid"
        try {
            Copy-Item -LiteralPath $it.Path -Destination $tmp
            $got = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
            if ($got -ne $it.Sha) { throw "MISMATCH $tag(複製後雜湊不符)" }
            # File.Move 在目的地已存在時失敗:放置時被別人搶先也不覆蓋;其他錯誤(網路、權限)照實回報
            try { [IO.File]::Move($tmp, $dest) } catch {
                if (Test-Path -LiteralPath $dest) { throw "REFUSE $tag 放置時別人已經放了同一個版本(不覆蓋)" }
                throw "無法放置 ${tag}:$($_.Exception.Message)"
            }
        } finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        Write-Host "OK     $tag $got"
        $placed += $it
    }
    # 主機唯讀掛載讀到的內容(endpoint-server 讀這裡);檔案已放好,不符時印出登錄資料後以失敗結束,先到主機確認再登錄
    $mountBad = 0
    if ($MountCheckDir) {
        foreach ($it in $placed) {
            $m = "$MountCheckDir/$($it.Component)/$($it.Version)/$($it.File)"
            # $ErrorActionPreference = Stop 時 PowerShell 5.1 會把 ssh 的 stderr 當成錯誤:包起來,結果由下面判斷
            $have = ''
            try {
                $out = & ssh -o BatchMode=yes $HostAlias "wsl -u root -e sha256sum '$m'" 2>$null
                if ($LASTEXITCODE -eq 0 -and "$out" -match '^([0-9a-f]{64})\s') { $have = $Matches[1] }
            } catch { $have = '' }
            if ($have -eq $it.Sha) { Write-Host "掛載確認 $($it.Component)/$($it.Version):$HostAlias 讀到的雜湊相符" }
            else {
                Write-Warning "${HostAlias}:$m 讀不到或雜湊不同(掛載中斷?),到主機確認後再登錄"
                $mountBad++
            }
        }
    }
    Write-Registration
    if ($mountBad) { throw "NAS 已放好,但 $HostAlias 的唯讀掛載有 $mountBad 個檔案讀不到或雜湊不同:確認掛載後再登錄" }
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
