<#
.SYNOPSIS
  建立「測試用」程式碼簽章憑證(P6-UPGRADE-DESIGN §9-1;正式 AD CS 憑證由 IT 簽發後改用正式憑證)。

.DESCRIPTION
  - 在**執行者自己的電腦** CurrentUser\My 建立自簽 CodeSigningCert(RSA 3072、SHA-256、效期 1 年、私鑰不可匯出)。
    私鑰只留在這台電腦,不要複製到其他地方、不要提交進 repo(AGENT.md §8 機密與憑證)。
  - 匯出公鑰 dist\signing\GigaNexus-Test-CodeSigning.cer(只有公鑰,可帶到 VM)。
  - 印出 SHA-1 指紋(小寫):填入 build-agent-msi.ps1 -TrustedSigners 與版本登錄的 signerThumbprints。

  VM(系統管理員 PowerShell)匯入公鑰:
    Import-Certificate -FilePath .\GigaNexus-Test-CodeSigning.cer -CertStoreLocation Cert:\LocalMachine\Root
    Import-Certificate -FilePath .\GigaNexus-Test-CodeSigning.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher

  由使用者執行;AI 不經手私鑰。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\new-test-signing-cert.ps1
#>
param(
    [string]$Subject = 'CN=GigaNexus Test Code Signing (RustIt P6, not for production)'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # RustAgent\
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date) }
if ($existing) {
    Write-Warning "已有同名且未過期的測試簽章憑證,沿用:$($existing[0].Thumbprint)"
    $cert = $existing[0]
} else {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
        -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
        -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
}
$out = Join-Path $root 'dist\signing'
New-Item -ItemType Directory -Force $out | Out-Null
$cer = Join-Path $out 'GigaNexus-Test-CodeSigning.cer'
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
Write-Host "公鑰:$cer"
Write-Host "到期:$($cert.NotAfter)"
Write-Host "SHA-1 指紋(-TrustedSigners / signerThumbprints):$($cert.Thumbprint.ToLower())"
Write-Host ''
Write-Host '本機也要驗證簽章時,把公鑰匯入目前使用者的「受信任的根憑證授權單位」(會跳出確認視窗):'
Write-Host "  Import-Certificate -FilePath `"$cer`" -CertStoreLocation Cert:\CurrentUser\Root"
