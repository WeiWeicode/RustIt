<#
.SYNOPSIS
  建置「未簽章」的發版檔案(P6-4;PLATFORM-PLAN §4.9 選項 C:Windows Runner 建置 + 人工簽章;P6-UPGRADE-DESIGN §6)。CI 與開發機都用這一支。

.DESCRIPTION
  1. cargo build --release --locked -p rustit-agent -p rustit-watchdog(版本取自各 crate 的 Cargo.toml;-AgentVersion / -WatchdogVersion 只給測試覆寫)
  2. 檢查 exe 版本資源(ProductVersion)與預期版本一致
  3. 依「版本檔目錄」的結構輸出到 -OutDir:
        agent\<版本>\rustit-agent.exe
        watchdog\<版本>\rustit-watchdog.exe
        msi\GigaNexusAgent-<版本>-<部署區>.msi        (只有指定 -Env 時;設定在建置時寫入,每個部署區各一個)
  4. 寫 SHA256SUMS.txt(`<雜湊>  <相對路徑>`,UTF-8、LF)與 RELEASE-INFO.txt(commit、版本、建置時間、CI pipeline)

  產出全部**未簽章**:私鑰不放在 Runner(ADR 0003、§4.9 不採選項 B)。下一步由簽章人員執行 sign-release.ps1,再 publish-release.ps1 上架。
  需要:Rust(MSVC);要建 MSI 另需 WiX v5(見 build-agent-msi.ps1)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File RustAgent\installer\build-release.ps1 -OutDir release-out
  powershell -ExecutionPolicy Bypass -File installer\build-release.ps1 -OutDir ..\release-out -Env test -Gateway 10.10.130.124:9443 -StoreIssuer "GigaNexus Temporary Agent CA (test)" -CaFile dist\rustit-agent-test\pki\ca.crt -TrustedSigners <指紋>
#>
param(
    [string]$OutDir = 'release-out',   # 相對路徑 = 相對於呼叫端目前目錄
    [string]$AgentVersion,
    [string]$WatchdogVersion,
    # 以下只在要同時建 MSI 時使用(轉給 build-agent-msi.ps1)
    [ValidateSet('', 'test', 'prod')][string]$Env = '',
    [string]$Gateway,
    [string]$StoreIssuer,
    [string]$CaFile,
    [ValidateCount(0, 8)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string[]]$TrustedSigners = @()
)
$ErrorActionPreference = 'Stop'
# -OutDir 的相對路徑相對於**呼叫端目前目錄**(CI 在專案根目錄執行,`-OutDir release-out` → <專案根>\release-out);要在 Set-Location 之前解析
$out = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path (Get-Location) $OutDir }
$root = Split-Path -Parent $PSScriptRoot   # RustAgent\
Set-Location $root
# 繼承來的 RUSTIT_BUILD_VERSION 會改掉建出來的版本號:一律清掉,只有版本覆寫(測試)時才由腳本自己設定
Remove-Item Env:\RUSTIT_BUILD_VERSION -ErrorAction SilentlyContinue

function Read-CrateVersion([string]$crate) {
    $m = Select-String -Path "crates\$crate\Cargo.toml" -Pattern '^version = "(.+)"' | Select-Object -First 1
    if (-not $m) { throw "讀不到 crates\$crate\Cargo.toml 的版本" }
    $m.Matches[0].Groups[1].Value
}
$verPattern = '^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$'
if (-not $AgentVersion) { $AgentVersion = Read-CrateVersion 'agent' }
if (-not $WatchdogVersion) { $WatchdogVersion = Read-CrateVersion 'watchdog' }
foreach ($v in $AgentVersion, $WatchdogVersion) { if ($v -notmatch $verPattern) { throw "版本格式不合法:$v" } }
if ($Env -and (-not $Gateway -or -not $StoreIssuer -or -not $CaFile)) { throw '建 MSI 需要 -Gateway、-StoreIssuer、-CaFile' }
# MSI 版本跟 Agent(build-agent-msi.ps1 取自 Cargo.toml);版本覆寫是測試用,內容與 MSI 不同,不能一起建(要在 cargo build 之前就擋)
if ($Env -and ($AgentVersion -ne (Read-CrateVersion 'agent') -or $WatchdogVersion -ne (Read-CrateVersion 'watchdog'))) { throw '版本覆寫只供測試,不能同時建 MSI' }
# CI tag 要和 Agent 版本一致(RUNBOOK:tag = rustit-v<Agent 版本>),打錯 tag 就在建置前失敗
if ($env:CI_COMMIT_TAG -and $env:CI_COMMIT_TAG -ne "rustit-v$AgentVersion") { throw "tag $($env:CI_COMMIT_TAG) 與 Agent 版本 $AgentVersion 不一致(應為 rustit-v$AgentVersion)" }

if (Test-Path $out) {
    if (Get-ChildItem $out -Force | Select-Object -First 1) { throw "輸出目錄不是空的:$out(換一個目錄,不覆蓋既有發版檔)" }
}
New-Item -ItemType Directory -Force $out | Out-Null

# 兩個元件各自一個版本號:只有覆寫(測試)時才設 RUSTIT_BUILD_VERSION,並建置到各自的 target 目錄,避免互相覆蓋
function Build-Crate([string]$crate, [string]$short, [string]$version) {
    $override = $version -ne (Read-CrateVersion $short)
    $cargoArgs = @('build', '--release', '--locked', '-p', $crate)
    if ($override) {
        $env:RUSTIT_BUILD_VERSION = $version
        $cargoArgs += @('--target-dir', "target\rel-$crate-$version")
    }
    try {
        Write-Host "建置 $crate $version(release$(if ($override) { ',版本覆寫' }))"
        & cargo @cargoArgs | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "cargo build $crate 失敗" }
    } finally {
        Remove-Item Env:\RUSTIT_BUILD_VERSION -ErrorAction SilentlyContinue
    }
    $dir = if ($override) { "target\rel-$crate-$version\release" } else { 'target\release' }
    $exe = Join-Path $root "$dir\$crate.exe"
    if (-not (Test-Path $exe -PathType Leaf)) { throw "找不到建置產物 $exe(CARGO_TARGET_DIR 或 .cargo\config.toml 改了輸出位置?)" }
    $pv = (Get-Item $exe).VersionInfo.ProductVersion
    if ($pv -ne $version) { throw "$crate.exe 版本資源 $pv 與預期 $version 不符" }
    $exe
}
$agentExe = Build-Crate 'rustit-agent' 'agent' $AgentVersion
$wdExe = Build-Crate 'rustit-watchdog' 'watchdog' $WatchdogVersion

$files = @()
function Put-File([string]$src, [string]$rel) {
    $dest = Join-Path $out $rel
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    Copy-Item $src $dest
    $script:files += $rel
}
Put-File $agentExe "agent\$AgentVersion\rustit-agent.exe"
Put-File $wdExe "watchdog\$WatchdogVersion\rustit-watchdog.exe"

if ($Env) {
    # 呼叫另一支 .ps1 要用 hashtable splatting(陣列只會做位置綁定,`-Env` 會被當成值);子腳本失敗會 throw
    $msiArgs = @{ Env = $Env; Gateway = $Gateway; StoreIssuer = $StoreIssuer; CaFile = $CaFile }
    if ($TrustedSigners.Count -gt 0) { $msiArgs.TrustedSigners = $TrustedSigners }
    & (Join-Path $PSScriptRoot 'build-agent-msi.ps1') @msiArgs
    $msi = Join-Path $root "dist\msi\GigaNexusAgent-$AgentVersion-$Env.msi"
    if (-not (Test-Path $msi)) { throw "找不到 MSI:$msi" }
    Put-File $msi "msi\GigaNexusAgent-$AgentVersion-$Env.msi"
}

# SHA256SUMS.txt:`<雜湊>  <相對路徑>`(正斜線),UTF-8 無 BOM、LF
$utf8 = New-Object Text.UTF8Encoding $false
$lines = foreach ($rel in ($files | Sort-Object)) { '{0}  {1}' -f (Get-FileHash (Join-Path $out $rel) -Algorithm SHA256).Hash.ToLower(), ($rel -replace '\\', '/') }
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), $utf8)

# commit:CI 用 CI_COMMIT_SHA;開發機用 git(Runner 服務帳號常見 dubious ownership,失敗要說清楚而不是在建完之後才死)
$commit = $env:CI_COMMIT_SHA
$dirty = 'unknown'
if (-not $commit) {
    try {
        $commit = (& git rev-parse HEAD 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw $commit }
        $dirty = if ((& git status --porcelain 2>&1 | Out-String).Trim()) { 'true' } else { 'false' }
    } catch {
        throw "RELEASE-INFO 需要 commit,但 git rev-parse 失敗:$($_.Exception.Message)(CI 請確認 CI_COMMIT_SHA;開發機請在 git 工作目錄執行)"
    }
} elseif ($env:CI) { $dirty = 'false' }
$info = @(
    "agent_version=$AgentVersion",
    "watchdog_version=$WatchdogVersion",
    "commit=$commit",
    "dirty=$dirty",
    "built_at=$([DateTime]::UtcNow.ToString('o'))",
    "ci_pipeline=$($env:CI_PIPELINE_ID)",
    "ci_job=$($env:CI_JOB_ID)",
    'signed=false'
)
[IO.File]::WriteAllText((Join-Path $out 'RELEASE-INFO.txt'), (($info -join "`n") + "`n"), $utf8)

Write-Host ''
Write-Host "完成(未簽章):$out"
Get-Content (Join-Path $out 'SHA256SUMS.txt') | ForEach-Object { Write-Host "  $_" }
Write-Host '下一步:簽章人員執行 installer\sign-release.ps1(核對雜湊 → 簽章 → 驗證),再 installer\publish-release.ps1 上架。'
