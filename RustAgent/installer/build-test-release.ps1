<#
.SYNOPSIS
  建置並以測試簽章憑證簽章一個 Agent 升級檔(P6-2 測試期,PLATFORM-PLAN §4.9 選項 A;Windows Runner 建好前用)。

.DESCRIPTION
  1. cargo build --release -p rustit-agent(版本以 RUSTIT_BUILD_VERSION 指定,寫入程式與 exe 版本資源;-Features 可建壞版本)
     建置到 target\rel-<版本>\,不覆蓋 MSI 用的 target\release\
  2. Set-AuthenticodeSignature(SHA-256;測試期不加時間戳記)以 CurrentUser\My 的憑證簽章,確認簽章者指紋
  3. 複製到 dist\releases\agent\<版本>\rustit-agent.exe,印出 SHA-256 與大小

  上架(§4、§9-3):複製到主機 2 /srv/giganexus/ita-releases/agent/<版本>/ → 版本登錄 API(Server 自己算雜湊)→ 設 pilot 目標。
  由使用者執行(用到私鑰)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\build-test-release.ps1 -Version 0.7.1 -Thumbprint <指紋>
  powershell -ExecutionPolicy Bypass -File installer\build-test-release.ps1 -Version 0.7.2-broken -Features broken-no-ws -Thumbprint <指紋>
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$Thumbprint,
    [ValidateSet('', 'broken-exit', 'broken-no-ws')][string]$Features = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # RustAgent\
Set-Location $root

$cert = Get-Item "Cert:\CurrentUser\My\$($Thumbprint.ToUpper())" -ErrorAction SilentlyContinue
if (-not $cert) { throw "CurrentUser\My 找不到憑證 $Thumbprint(先執行 installer\new-test-signing-cert.ps1)" }

$targetDir = "target\rel-$Version"
$env:RUSTIT_BUILD_VERSION = $Version
try {
    $cargoArgs = @('build', '--release', '-p', 'rustit-agent', '--target-dir', $targetDir)
    if ($Features) { $cargoArgs += @('--features', $Features) }
    Write-Host "建置 rustit-agent $Version $Features"
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw 'cargo build 失敗' }
} finally {
    Remove-Item Env:\RUSTIT_BUILD_VERSION -ErrorAction SilentlyContinue
}
$exe = Join-Path $root "$targetDir\release\rustit-agent.exe"
$pv = (Get-Item $exe).VersionInfo.ProductVersion
if ($pv -ne $Version) { throw "exe 版本資源 $pv 與 $Version 不符" }

$out = Join-Path $root "dist\releases\agent\$Version"
New-Item -ItemType Directory -Force $out | Out-Null
$signed = Join-Path $out 'rustit-agent.exe'
Copy-Item $exe $signed -Force
$sig = Set-AuthenticodeSignature -FilePath $signed -Certificate $cert -HashAlgorithm SHA256
if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "簽章失敗:$($sig.StatusMessage)" }
# 本機沒有信任測試根憑證時 Status 為 UnknownError(簽章本身已寫入);VM 匯入公鑰後會是 Valid
Write-Host "簽章狀態:$($sig.Status)($($sig.StatusMessage))"

$hash = (Get-FileHash $signed -Algorithm SHA256).Hash.ToLower()
Write-Host "完成:$signed"
Write-Host "版本:$Version  大小:$((Get-Item $signed).Length) bytes"
Write-Host "SHA-256:$hash"
Write-Host "簽章者:$($cert.Thumbprint.ToLower())"
