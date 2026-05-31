# Kibo

> A minimal, privacy-hardened web browser built on Electron.

Kibo는 Chromium 기반의 미니멀 웹 브라우저입니다. Electron 위에 직접 만든 UI/탭 관리와
보안 하드닝을 얹었고, **Zen 스타일 자동 숨김 UI**와
**사이트별 비밀번호 저장/자동입력**을 핵심 기능으로 합니다.

## 실행

```bash
npm install
npm start          # esbuild로 프리로드를 빌드(dist/)한 뒤 electron 실행
```

`npm start`는 실행 전에 `npm run build`를 자동으로 돌립니다. 콘텐츠 프리로드
(`tabPreload.js`)는 샌드박스 때문에 런타임에 로컬 파일을 `require`할 수 없어,
공유 모듈(`ui/scrollbarCore.js`)을 빌드 시점에 esbuild가 번들로 끼워넣어
`dist/tabPreload.js`를 만듭니다. 개발 중 프리로드를 자주 고친다면:

```bash
npm run build      # 프리로드 한 번 번들
npm run watch      # 변경 시 자동 재빌드
```

> **Linux 샌드박스 안내:** `The SUID sandbox helper binary ... mode 4755` 오류가 나면
> Chromium 샌드박스 바이너리에 권한을 한 번 부여하세요:
> ```bash
> sudo chown root:root node_modules/electron/dist/chrome-sandbox
> sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
> ```
> (임시로는 `npm start -- --no-sandbox` 로도 실행되지만 보안상 권장하지 않습니다.)

## 구조

| 파일 | 역할 |
|------|------|
| `main.js` | 메인 프로세스. 창/프로필/세션, 탭(=`WebContentsView`) 관리, 단축키, IPC |
| `preload.js` | 크롬 UI↔메인 보안 브리지 (`window.api`만 노출) |
| `tabPreload.js` | 웹 페이지 콘텐츠 스크립트 — 자동 숨김 트리거 + 비밀번호 캡처/자동입력 |
| `store.js` | 프로필별 영구 저장소 (설정·북마크·기록·다운로드, JSON) |
| `passwords.js` | 사이트별 비밀번호 금고 (`safeStorage` OS 암호화) |
| `blocker.js` | `session.webRequest` 기반 광고/트래커 차단 |
| `ui/index.html` | 브라우저 크롬 UI |
| `ui/chrome.js` | 크롬 UI 로직 (탭·패널·설정·찾기·경고) |
| `ui/style.css` | 스타일 |

## 핵심 기능

### 1. 주소창 자동 숨김 (Zen 모드) ★
- 평소엔 도구 모음/북마크 바/탭 스트립이 모두 사라지고 **콘텐츠만** 보입니다. F11 불필요.
- 마우스를 화면 **맨 위 가장자리**로 올리면 도구 모음이 스르륵 나타나고, 내리면 다시 숨겨집니다.
- 자동입력 제안·찾기 바가 뜰 때도 자동으로 도구 모음이 나타납니다.
- 설정 또는 `Ctrl+Shift+H` 로 켜고 끌 수 있습니다.
- 구현: 콘텐츠 뷰는 창 전체를 차지하고, 크롬 UI는 **최상단에 떠 있는 별도 `WebContentsView`** 로
  필요할 때만 표시됩니다. 가장자리 감지는 콘텐츠 프리로드(`tabPreload.js`)가 담당합니다.

### 2. 사이트별 아이디·비밀번호 저장 / 자동입력 ★
- 로그인 폼 제출(또는 로그인 버튼 클릭)을 감지해 **저장할지 묻는 배너**를 띄웁니다.
- 다음 방문 시 같은 출처(origin)의 아이디·비밀번호를 **자동으로 채웁니다**.
- 비밀번호는 OS 키링(`safeStorage`, Linux는 libsecret)으로 **암호화되어 디스크에 저장**됩니다.
  키링을 못 쓰는 환경이면 평문 대신 난독화로 저장하고 경고를 표시합니다.
- 메뉴 → **비밀번호 관리**에서 목록 확인·표시(👁)·삭제(🗑) 가능. 목록은 기본적으로 마스킹됩니다.

### 3. 광고/트래커 차단
- `session.webRequest.onBeforeRequest` 로 알려진 광고·분석 도메인 요청을 차단(서브도메인 포함).
- 주소창 옆 🛡 배지에 차단 수가 표시되고, 클릭으로 즉시 켜고 끌 수 있습니다.

### 4. 키보드 단축키
| 단축키 | 동작 | 단축키 | 동작 |
|--------|------|--------|------|
| `Ctrl+T` | 새 탭 | `Ctrl+W` | 탭 닫기 |
| `Ctrl+L` | 주소창 포커스 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 다음/이전 탭 |
| `Ctrl+1~8` / `Ctrl+9` | n번째 / 마지막 탭 | `Ctrl+R` / `F5` | 새로고침 |
| `Alt+←` / `Alt+→` | 뒤로 / 앞으로 | `Ctrl+F` | 페이지에서 찾기 |
| `Ctrl+D` | 북마크 토글 | `Ctrl+H` / `Ctrl+J` | 방문 기록 / 다운로드 |
| `Ctrl+Shift+H` | 자동 숨김 토글 | `Ctrl+Shift+N` | 새 시크릿 창 |
| `Esc` | 패널/찾기/메뉴 닫기 | | |

### 5. 북마크 · 방문 기록 · 다운로드
- 북마크: 주소창 ★ 버튼/`Ctrl+D`, 북마크 바에 표시·삭제.
- 방문 기록: 메뉴 또는 `Ctrl+H`, 항목 열기·개별/전체 삭제 (시크릿 모드는 기록 안 함).
- 다운로드: 진행률·취소·완료 후 열기/폴더에서 보기.

### 6. HTTPS 강제 / 안전하지 않은 사이트 경고
- 최상위 탐색의 `http://` 주소를 자동으로 `https://` 로 업그레이드.
- 업그레이드 실패 또는 인증서 오류 시 **전체 화면 경고**를 띄워 사용자가 직접 “계속” 여부를 선택.
- 탭과 주소창에 🔒(보안) / ⚠(비보안) 표시.

### 7. 시크릿 모드 / 다중 프로필
- 프로필마다 **격리된 세션·기록·북마크·비밀번호 금고**를 사용 (`persist:profile-<name>`).
- 시크릿 창은 메모리 전용 세션 — 기록·비밀번호를 **저장하지 않습니다**.

## 보안 설계

- 웹 페이지는 각각 **격리된 `WebContentsView`** 에서 렌더링 (사이트별 프로세스 격리)
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`
- 웹 페이지에 Node.js 노출 없음 — 콘텐츠 프리로드는 `ipcRenderer`로만 통신하고 페이지에는 아무것도 노출하지 않음
- 모든 권한 요청(카메라/마이크/위치 등) 기본 거부 (전체화면·복사만 허용)
- 크롬 UI에는 엄격한 CSP 적용, 비밀번호는 OS 키링으로 암호화 저장

## 다음 단계 아이디어

- 차단 목록을 외부 필터 리스트(EasyList 등)로 확장
- 탭 드래그 재정렬 · 세션 복원
- electron-builder로 패키징/배포
