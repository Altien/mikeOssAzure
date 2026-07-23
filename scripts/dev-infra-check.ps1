param(
  [string]$ComposeFile = "docker-compose.dev.yml"
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$failures = 0

function Pass($message) {
  Write-Host "[ok]   $message" -ForegroundColor Green
}

function Warn($message) {
  Write-Host "[warn] $message" -ForegroundColor Yellow
}

function Fail($message) {
  $script:failures += 1
  Write-Host "[fail] $message" -ForegroundColor Red
}

function Check-Command($name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) {
    Pass "$name is on PATH"
    return $true
  }
  Fail "$name is not on PATH"
  return $false
}

function Check-Container($name) {
  $state = docker inspect -f "{{.State.Status}}" $name 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $state) {
    Fail "$name container is missing"
    return
  }

  $health = docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $name 2>$null
  if ($state -eq "running" -and ($health -eq "healthy" -or $health -eq "none")) {
    Pass "$name is running"
  } elseif ($state -eq "running") {
    Fail "$name is running but health is $health"
  } else {
    Fail "$name state is $state"
  }
}

function Check-Http($url, $name) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      Pass "$name responds with HTTP $($response.StatusCode)"
    } else {
      Fail "$name returned HTTP $($response.StatusCode)"
    }
  } catch {
    Fail "$name request failed: $($_.Exception.Message)"
  }
}

function Check-Port($port, $name) {
  $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  if ($connections) {
    $owners = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    Pass "$name port $port is listening (PID: $($owners -join ', '))"
  } else {
    Warn "$name port $port is not listening"
  }
}

Write-Host "Mike local dev infrastructure check" -ForegroundColor Cyan
Write-Host "Compose file: $ComposeFile"
Write-Host ""

$hasDocker = Check-Command docker
if (-not $hasDocker) {
  exit 1
}

try {
  docker compose version | Out-Null
  Pass "docker compose is available"
} catch {
  Fail "docker compose is not available: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Compose services" -ForegroundColor Cyan
docker compose -f $ComposeFile ps

Write-Host ""
Write-Host "Container checks" -ForegroundColor Cyan
Check-Container "mike-postgres"
Check-Container "mike-postgrest"

$azuriteExists = docker ps -a --format "{{.Names}}" | Where-Object { $_ -eq "mike-azurite" } | Select-Object -First 1
if ($azuriteExists) {
  Check-Container "mike-azurite"
} else {
  Warn "mike-azurite is not running in this compose stack; ok if Azurite is running elsewhere"
}

Write-Host ""
Write-Host "Service probes" -ForegroundColor Cyan
try {
  docker exec mike-postgres pg_isready -U mikeadmin -d mike | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Pass "Postgres accepts connections for mike database"
  } else {
    Fail "Postgres pg_isready failed"
  }
} catch {
  Fail "Postgres pg_isready failed: $($_.Exception.Message)"
}

try {
  $tableCount = docker exec mike-postgres psql -U mikeadmin -d mike -tAc "select count(*) from information_schema.tables where table_schema='public';"
  if ([int]$tableCount -gt 0) {
    Pass "Postgres schema is present ($tableCount public tables)"
  } else {
    Fail "Postgres schema has no public tables; run migrations"
  }
} catch {
  Fail "Postgres schema check failed: $($_.Exception.Message)"
}

Check-Http "http://localhost:4000/" "PostgREST direct"

Write-Host ""
Write-Host "Expected local ports" -ForegroundColor Cyan
Check-Port 5432 "Postgres"
Check-Port 4000 "PostgREST"
Check-Port 10000 "Azurite blob"
Check-Port 3001 "Backend API"
Check-Port 3000 "Frontend"

Write-Host ""
if ($failures -eq 0) {
  Pass "local dev infrastructure looks ready"
  exit 0
}

Fail "$failures infrastructure check(s) failed"
exit 1
