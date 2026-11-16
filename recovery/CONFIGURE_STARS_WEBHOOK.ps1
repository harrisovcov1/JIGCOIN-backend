# Windows PowerShell 5.1+. Run only after the backend and matching secret are deployed.
# Credentials are entered at hidden prompts; they are not written to a file or printed.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Read-PrivateValue([string]$Prompt) {
  $SecureValue = Read-Host $Prompt -AsSecureString
  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
}
function Invoke-BotMethod([string]$Method, $Payload) {
  try {
    $Result = Invoke-RestMethod -Method Post -Uri ("https://api.telegram.org/bot" + $script:JigToken + "/" + $Method) -ContentType 'application/json' -Body ($Payload | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 15
    if (-not $Result.ok) { throw 'Provider rejected request' }
    return $Result.result
  } catch { throw 'Telegram request failed. Check configuration. Credentials are not shown.' }
}
try {
  $script:JigToken = Read-PrivateValue 'Enter the existing JigCoin BOT_TOKEN (hidden)'
  $JigSecret = Read-PrivateValue 'Enter the SAME TELEGRAM_WEBHOOK_SECRET saved in Render (hidden)'
  if ($JigSecret -cnotmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'Webhook secret must contain 32-256 allowed characters.' }
  $JigUrl = 'https://jigcoin.onrender.com/telegram/stars-webhook'
  $Me = Invoke-BotMethod 'getMe' @{}
  if ($Me.username -ine 'jigcoinofficial') { throw 'This token is for a different bot. No webhook changed.' }
  $Hook = Invoke-BotMethod 'getWebhookInfo' @{}
  if ($Hook.url -and $Hook.url -ne $JigUrl) { throw 'A different webhook already exists. No webhook changed; inspect the existing integration first.' }
  $Updates = @(@($Hook.allowed_updates) + @('message','pre_checkout_query') | Where-Object { $_ } | Select-Object -Unique)
  $Done = Invoke-BotMethod 'setWebhook' @{url=$JigUrl;secret_token=$JigSecret;allowed_updates=$Updates;drop_pending_updates=$false}
  $Check = Invoke-BotMethod 'getWebhookInfo' @{}
  if ($Check.url -ne $JigUrl -or 'pre_checkout_query' -notin $Check.allowed_updates -or 'message' -notin $Check.allowed_updates) { throw 'Webhook readback did not match.' }
  Write-Host 'Webhook registered and read back. Sales have NOT been enabled.'
  Write-Host 'Send /paysupport to @jigcoinofficial and check that the configured support contact is returned.'
} catch { Write-Host ('Stopped: ' + $_.Exception.Message) }
finally { $script:JigToken=$null; $JigSecret=$null }
