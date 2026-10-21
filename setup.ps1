# 가치관 소개팅 AI 매칭 설치 스크립트 (setup.bat 이 실행함)
Set-Location $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Write-Host ""
Write-Host " === 가치관 소개팅 AI 매칭 설치 ===" -ForegroundColor Cyan
Write-Host ""

# 설치 직후엔 PATH가 갱신 안 됐을 수 있어서 기본 설치 위치도 확인
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama -and (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")) {
  $ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
}
if (-not $ollama) {
  Write-Host " [!] Ollama가 설치되어 있지 않아요." -ForegroundColor Yellow
  Write-Host "     https://ollama.com 에서 설치한 뒤 다시 실행해 주세요."
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host " [!] Node.js가 설치되어 있지 않아요." -ForegroundColor Yellow
  Write-Host "     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  exit 1
}

# 자기소개 로컬 LLM과 같은 모델 (한국어 특화, 약 1.6GB). 이미 있으면 바로 끝남
$model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "exaone3.5:2.4b" }
Write-Host " AI 모델($model) 다운로드 중... 처음 한 번만, 시간이 걸려요"
& $ollama pull $model
if ($LASTEXITCODE -ne 0) {
  Write-Host " [!] 다운로드에 실패했어요. 인터넷 연결과 Ollama 앱이 켜져 있는지 확인해 주세요." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host " 설치 완료! 이제 start.bat 을 더블클릭하면 앱이 열려요." -ForegroundColor Green
