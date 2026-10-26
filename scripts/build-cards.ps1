# Builds cards.json from cards.txt using Scryfall's /cards/collection API.
#
# cards.txt: one card per line. Blank lines and lines starting with # are ignored.
# Accepted forms:
#   Sheoldred, the Apocalypse
#   3 Sheoldred, the Apocalypse          (3 copies; "3x" also works)
#   Sheoldred, the Apocalypse (DMU)      (pin a set)
#   Sheoldred, the Apocalypse (DMU) 107  (pin an exact printing)
# Repeating a line adds another copy. Copies from all lines for the same card are summed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-cards.ps1

param(
  [string]$In  = (Join-Path $PSScriptRoot '..\cards.txt'),
  [string]$Out = (Join-Path $PSScriptRoot '..\cards.json')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$lineRe = '^(?:(?<copies>\d+)x?\s+)?(?<name>.+?)(?:\s+\((?<set>[A-Za-z0-9]{2,6})\)(?:\s+(?<num>\S+))?)?\s*$'

# One entry per distinct line (name/set/number), with copies summed.
$entries = [ordered]@{}
foreach ($raw in Get-Content -LiteralPath $In -Encoding UTF8) {
  $line = $raw.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { continue }
  if ($line -notmatch $lineRe) { Write-Warning "Could not parse: $line"; continue }

  $count = if ($Matches.copies) { [int]$Matches.copies } else { 1 }
  $set = if ($Matches.set) { $Matches.set.ToLower() } else { $null }
  $num = $Matches.num
  $name = $Matches.name
  $key = "$name|$set|$num".ToLower()

  if ($entries.Contains($key)) { $entries[$key].qty += $count; continue }

  $id = if ($set -and $num) { @{ set = $set; collector_number = $num } }
        elseif ($set)       { @{ name = $name; set = $set } }
        else                { @{ name = $name } }
  $entries[$key] = @{ id = $id; name = $name; set = $set; num = $num; qty = $count; matched = $false }
}
$entryList = @($entries.Values)
Write-Host "Read $($entryList.Count) distinct entries from $In"

# Which cards.txt entry does this Scryfall card belong to? Name lines may name only the
# front face ("Delver of Secrets" -> "Delver of Secrets // Insectile Aberration").
function Find-Entry($card, $batch) {
  foreach ($e in $batch) {
    if ($e.matched) { continue }
    if ($e.num) {
      if ($card.set -eq $e.set -and $card.collector_number -eq $e.num) { return $e }
      continue
    }
    if ($e.set -and $card.set -ne $e.set) { continue }
    if ($card.name -eq $e.name -or
        $card.name.StartsWith("$($e.name) // ", [StringComparison]::OrdinalIgnoreCase)) { return $e }
  }
  return $null
}

$headers = @{ 'User-Agent' = 'RareDraftPicks/1.0'; 'Accept' = 'application/json' }
$cards = [ordered]@{}   # card name -> card object
$notFound = @()

for ($i = 0; $i -lt $entryList.Count; $i += 75) {
  $batch = @($entryList[$i..([Math]::Min($i + 74, $entryList.Count - 1))])
  $body = ConvertTo-Json -InputObject @{ identifiers = @($batch | ForEach-Object { $_.id }) } -Depth 5 -Compress
  $res = Invoke-RestMethod -Uri 'https://api.scryfall.com/cards/collection' -Method Post `
    -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body))

  foreach ($nf in $res.not_found) { $notFound += (($nf.PSObject.Properties | ForEach-Object { $_.Value }) -join ' ') }

  foreach ($c in $res.data) {
    $entry = Find-Entry $c $batch
    $qty = 1
    if ($entry) { $entry.matched = $true; $qty = $entry.qty }
    else { Write-Warning "Could not match $($c.name) to a line in cards.txt; assuming 1 copy" }

    if ($cards.Contains($c.name)) { $cards[$c.name].qty += $qty; continue }

    $faces = @($c.card_faces | Where-Object { $_ })
    $img  = if ($c.image_uris) { $c.image_uris } elseif ($faces.Count) { $faces[0].image_uris } else { $null }
    $back = if (-not $c.image_uris -and $faces.Count -gt 1 -and $faces[1].image_uris) { $faces[1].image_uris.normal } else { $null }
    $colors = @($c.colors)
    if (-not $c.PSObject.Properties['colors'] -and $faces.Count) {
      $colors = @($faces | ForEach-Object { $_.colors } | Where-Object { $_ } | Select-Object -Unique)
    }

    $cards[$c.name] = [ordered]@{
      name   = $c.name
      qty    = $qty
      set    = $c.set.ToUpper()
      rarity = $c.rarity
      type   = $c.type_line
      cmc    = $c.cmc
      colors = @($colors | Where-Object { $_ })
      img    = if ($img) { $img.normal } else { $null }
      small  = if ($img) { $img.small }  else { $null }
      back   = $back
    }
  }
  Start-Sleep -Milliseconds 120   # Scryfall asks for <= 10 requests/sec
}

$json = ConvertTo-Json -InputObject @($cards.Values) -Depth 5
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $json, (New-Object Text.UTF8Encoding($false)))

$copies = 0
foreach ($v in $cards.Values) { $copies += $v.qty }
Write-Host "Wrote $($cards.Count) cards ($copies copies total) to $Out"
$multi = @($cards.Values | Where-Object { $_.qty -gt 1 })
foreach ($m in $multi) { Write-Host "  $($m.qty)x $($m.name)" }
if ($notFound.Count) {
  Write-Warning "$($notFound.Count) not found on Scryfall (fix spelling in cards.txt and re-run):"
  $notFound | ForEach-Object { Write-Host "  - $_" }
}

# On GitHub Actions, show the result on the run's summary page.
if ($env:GITHUB_STEP_SUMMARY) {
  $summary = @("Wrote $($cards.Count) cards ($copies copies total).")
  if ($notFound.Count) {
    $summary += '', "**$($notFound.Count) not found on Scryfall** (fix spelling in cards.txt):"
    $summary += $notFound | ForEach-Object { "- $_" }
  }
  Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary -Encoding UTF8
}
