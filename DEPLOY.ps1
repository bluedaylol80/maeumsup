# 마음숲 신도 앱 공개 배포 — 본부장 1회 실행용 (분류기가 AI 자동 공개repo 생성을 차단해 사람 실행 경로)
$ErrorActionPreference = "Stop"
$deploy = "C:\Users\blued\AppData\Local\Temp\claude\D--Github\340f946a-d837-49f1-ab5d-6b3f94be254b\scratchpad\maeumsup-deploy"
Set-Location $deploy
# 1) 공개 repo 생성 (이미 있으면 skip)
$exists = (gh repo view bluedaylol80/maeumsup --json name 2>$null)
if (-not $exists) {
  gh repo create bluedaylol80/maeumsup --public --description "마음숲 사찰 일일 의례 신도용 앱"
}
# 2) push
if (-not (Test-Path .git)) {
  git init -q
  git checkout -q -b main
  git add -A
  git commit -q -m "maeumsup v1.0: daily temple ritual app for devotees (말씀·목탁·기도·연등)"
  git remote add origin git@github.com:bluedaylol80/maeumsup.git
}
git push -u origin main
# 3) GitHub Pages 활성화 (main / root)
gh api repos/bluedaylol80/maeumsup/pages -X POST -f "source[branch]=main" -f "source[path]=/" 2>$null
Write-Output "DEPLOY_DONE: https://bluedaylol80.github.io/maeumsup/oosa/today/"
