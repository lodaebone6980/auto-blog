# NaviWrite Runner

로컬 PC에서만 실행되는 보조 서버입니다. 서버 DB에는 계정 비밀번호를 저장하지 않고, Runner가 계정별 브라우저 프로필과 로컬 자격증명을 담당합니다.

## 실행

```powershell
node runner/server.js
```

기본 주소:

```text
http://127.0.0.1:39271
```

## 원칙

- 서버 DB에는 비밀번호를 저장하지 않습니다.
- 로그인 세션은 계정별 브라우저 프로필 폴더에 저장합니다.
- 로컬 자격증명은 Windows DPAPI로 암호화해 사용자 PC에만 저장합니다.
- 로그인, QR 생성, 발행은 기본적으로 화면 표시 방식으로 진행합니다.
- 수집/분석은 이후 headless 모드로 확장할 수 있습니다.

## 주요 API

```text
GET  /health
GET  /profiles
POST /profiles
POST /profiles/:id/open-login
POST /profiles/:id/mark-login-checked
GET  /profiles/:id/session-status
POST /profiles/:id/credentials
GET  /vpn/status
POST /vpn/connect
```

## 데이터 위치

기본값:

```text
%USERPROFILE%\NaviWriteRunner
```

환경변수로 변경:

```powershell
$env:NAVIWRITE_RUNNER_DATA="D:\NaviWriteRunner"
node runner/server.js
```
