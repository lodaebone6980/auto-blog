# NaviWrite Local Runner

NaviWrite Local Runner는 사용자 PC에서만 실행되는 보조 서버입니다. Railway 서버와 대시보드는 작업 상태만 저장하고, 네이버/브런치 계정 세션과 필요 시 ID/PW 자격증명은 이 Runner가 로컬에서 관리합니다.

## 실행

```powershell
node server.js
```

또는 Windows에서 `start-runner.cmd`를 더블클릭합니다.

기본 주소:

```text
http://127.0.0.1:39271
```

## 원칙

- 서버 DB와 Google Sheets에는 비밀번호를 저장하지 않습니다.
- 로그인 세션은 계정별 브라우저 프로필 폴더에 저장합니다.
- ID/PW를 저장하는 경우 Windows DPAPI로 암호화해 현재 Windows 사용자 계정 안에만 보관합니다.
- 대시보드는 비밀번호 원문을 볼 수 없고, 저장 여부와 마지막 확인 시각만 확인합니다.
- QR 생성과 발행은 기본적으로 사용자 화면이 열리는 확인형 자동화로 시작합니다.

## 주요 API

```text
GET    /health
GET    /startup-check
GET    /profiles
POST   /profiles
PATCH  /profiles/:id
GET    /profiles/:id/session-status
GET    /profiles/:id/login-plan
POST   /profiles/:id/open-login
POST   /profiles/:id/mark-login-checked
POST   /profiles/:id/activity
GET    /profiles/:id/credential-status
POST   /profiles/:id/credentials
POST   /profiles/:id/credentials/verify
DELETE /profiles/:id/credentials
GET    /vpn/status
POST   /vpn/connect
GET    /publish/queue
POST   /publish/queue
POST   /publish/claim-next
```

## 자동발행 대기와 딜레이

대시보드에서 `자동발행 대기`를 누르면 Runner의 `/publish/queue`에도 작업 묶음이 저장됩니다.

- `actionDelayMinutes`: 발행 동작 사이 대기 시간입니다. 기본 1분입니다.
- `spacingMinutes`: 글과 글 사이 예약 간격입니다. 기본 120분입니다.
- 실제 실행 시 Runner/확장프로그램은 `/publish/claim-next`로 서버 작업을 하나씩 점유하고, 응답의 `delayPlan` 값을 따라 대기합니다.
- 여러 PC에서 동시에 실행해도 서버의 `claim-next`가 한 작업을 한 PC에만 넘기도록 처리합니다.

## 데이터 위치

기본값:

```text
%USERPROFILE%\NaviWriteRunner
```

환경변수로 변경:

```powershell
$env:NAVIWRITE_RUNNER_DATA="D:\NaviWriteRunner"
node server.js
```

포트 변경:

```powershell
$env:NAVIWRITE_RUNNER_PORT="39272"
node server.js
```
