<#
  簽章與上架腳本共用:以 API Key 呼叫 Gateway 的系統對系統路由(S1-1 版本號查重、S1-3 送簽狀態確認)。以 dot-source 載入:
    . (Join-Path $PSScriptRoot 'gateway-api.ps1')
  - Assert-GatewayHost:Gateway 主機必須在該區的允許清單(打錯網址不會把 API Key 送到別台;換主機時改 $GatewayHosts)
  - Read-GatewayApiKey:金鑰檔只允許本人 / SYSTEM / Administrators 有權限、擁有者須為本人、不可放網路分享;只放金鑰一行
  - Invoke-GatewayGet:不跟隨重新導向(PowerShell 5.1 會把 X-Api-Key 一併帶到導向的主機;3xx 視為失敗),回應的 environment 必須等於指定的區
  資安審查:S1-1 M1 / M2 / L1 / L2。
#>

$GatewayHosts = @{
    test = @('10.10.130.124')
    prod = @('giganexus.gigasolar.com.tw')
}

function Assert-GatewayHost([string]$GatewayUrl, [string]$Environment) {
    if ($GatewayUrl -notmatch '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$') { throw "-GatewayUrl 要是 https://主機(不含路徑):$GatewayUrl" }
    $gwHost = ([uri]$GatewayUrl).Host
    if ($GatewayHosts[$Environment] -notcontains $gwHost) { throw "-GatewayUrl 的主機 $gwHost 不是 $Environment 區的 Gateway(允許:$($GatewayHosts[$Environment] -join ', '))" }
}

function Read-GatewayApiKey([string]$ApiKeyFile) {
    if ($ApiKeyFile -match '^\\') { throw '-ApiKeyFile 不可放在網路分享(分享層權限檢查不到);放本機使用者目錄' }
    $f = (Resolve-Path -LiteralPath $ApiKeyFile).Path
    # 白名單:只允許本人、SYSTEM、Administrators 有任何 Allow 權限;擁有者須為本人或 Administrators。
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

# 回傳 @{ Ok; Why; Body };PathAndQuery 由呼叫端組好(參數先 EscapeDataString)
function Invoke-GatewayGet([string]$GatewayUrl, [string]$ApiKey, [string]$PathAndQuery, [string]$Environment) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $u = $GatewayUrl.TrimEnd('/') + $PathAndQuery
    try {
        $resp = Invoke-WebRequest -Uri $u -Headers @{ 'X-Api-Key' = $ApiKey } -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 0 -ErrorAction Stop
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Ok = $false; Why = $(if ($code) { "HTTP $code(401 / 403:API Key 無效、權限不足或來源 IP 不在允許清單;3xx:不跟隨重新導向)" } else { $_.Exception.Message }); Body = $null }
    }
    if ($resp.StatusCode -ne 200) { return [pscustomobject]@{ Ok = $false; Why = "HTTP $($resp.StatusCode)(不跟隨重新導向)"; Body = $null } }
    try { $r = $resp.Content | ConvertFrom-Json } catch { $r = $null }
    if (-not $r -or -not $r.environment) { return [pscustomobject]@{ Ok = $false; Why = '回應格式不對(缺 environment)'; Body = $null } }
    if ([string]$r.environment -cne $Environment) { return [pscustomobject]@{ Ok = $false; Why = "回應的部署區是 $($r.environment),不是 $Environment"; Body = $null } }
    [pscustomobject]@{ Ok = $true; Why = 'OK'; Body = $r }
}
