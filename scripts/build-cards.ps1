# Builds cards.json from cards.txt using Scryfall's /cards/collection API.
#
# cards.txt: one card per line. Blank lines and lines starting with # are ignored.
# Accepted forms:
#   Sheoldred, the Apocalypse
#   1 Sheoldred, the Apocalypse          (leading count is ignored)
#   Sheoldred, the Apocalypse (DMU)      (pin a set)
#   Sheoldred, the Apocalypse (DMU) 107  (pin an exact printing)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-cards.ps1

param(
  [string]$In  = (Join-Path $PSScriptRoot '..\cards.txt'),
  [string]$Out = (Join-Path $PSScriptRoot '..\cards.json')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$lineRe = '^(?:\d+x?\s+)?(?<name>.+?)(?:\s+\((?<set>[A-Za-z0-9]{2,6})\)(?:\s+(?<num>\S+))?)?\s*$'

$identifiers = @()
foreach ($raw in Get-Content -LiteralPath $In -Encoding UTF8) {
  $line = $raw.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { continue }
  if ($line -notmatch $lineRe) { Write-Warning "Could not parse: $line"; continue }
  if ($Matches.set -and $Matches.num) {
    $identifiers += @{ set = $Matches.set.ToLower(); collector_number = $Matches.num }
  } elseif ($Matches.set) {
    $identifiers += @{ name = $Matches.name; set = $Matches.set.ToLower() }
  } else {
    $identifiers += @{ name = $Matches.name }
  }
}
Write-Host "Read $($identifiers.Count) entries from $In"

$headers = @{ 'User-Agent' = 'RareDraftPicks/1.0'; 'Accept' = 'application/json' }
$cards = New-Object System.Collections.ArrayList
$seen = @{}
$notFound = @()

for ($i = 0; $i -lt $identifiers.Count; $i += 75) {
  $batch = $identifiers[$i..([Math]::Min($i + 74, $identifiers.Count - 1))]
  $body = ConvertTo-Json -InputObject @{ identifiers = @($batch) } -Depth 5 -Compress
  $res = Invoke-RestMethod -Uri 'https://api.scryfall.com/cards/collection' -Method Post `
    -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body))

  foreach ($nf in $res.not_found) { $notFound += (($nf.PSObject.Properties | ForEach-Object { $_.Value }) -join ' ') }

  foreach ($c in $res.data) {
    if ($seen.ContainsKey($c.name)) { Write-Warning "Duplicate card skipped: $($c.name)"; continue }
    $seen[$c.name] = $true

    $faces = @($c.card_faces | Where-Object { $_ })
    $img  = if ($c.image_uris) { $c.image_uris } elseif ($faces.Count) { $faces[0].image_uris } else { $null }
    $back = if (-not $c.image_uris -and $faces.Count -gt 1 -and $faces[1].image_uris) { $faces[1].image_uris.normal } else { $null }
    $colors = @($c.colors)
    if (-not $c.PSObject.Properties['colors'] -and $faces.Count) {
      $colors = @($faces | ForEach-Object { $_.colors } | Where-Object { $_ } | Select-Object -Unique)
    }

    [void]$cards.Add([ordered]@{
      name   = $c.name
      set    = $c.set.ToUpper()
      rarity = $c.rarity
      type   = $c.type_line
      cmc    = $c.cmc
      colors = @($colors | Where-Object { $_ })
      img    = if ($img) { $img.normal } else { $null }
      small  = if ($img) { $img.small }  else { $null }
      back   = $back
    })
  }
  Start-Sleep -Milliseconds 120   # Scryfall asks for <= 10 requests/sec
}

$json = ConvertTo-Json -InputObject @($cards) -Depth 5
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $json, (New-Object Text.UTF8Encoding($false)))

Write-Host "Wrote $($cards.Count) cards to $Out"
if ($notFound.Count) {
  Write-Warning "$($notFound.Count) not found on Scryfall (fix spelling in cards.txt and re-run):"
  $notFound | ForEach-Object { Write-Host "  - $_" }
}
