# RainCloud

여러 프로젝트에서 재사용하는 독립형 AI 회사 운영 시스템입니다.

## AI 회사 앱

[`ai-company/`](ai-company/)에는 한국어 UI와 로컬 Codex App Server를 사용하는 첫 버전이 있습니다. 연결 프로젝트 없이도 채용과 면접이 가능하며, 프로젝트별 목표·기억·대화·업무·권한·예산·코드 작업 공간을 분리합니다.

Node.js 24 이상, Git, 로그인된 Codex CLI가 필요합니다.

```sh
cd ai-company
npm ci
npm run dev
```

브라우저에서 `http://127.0.0.1:4310`을 엽니다.

- [실행 및 운영 안내](ai-company/README.md)
- [실제 협업 검증 결과](ai-company/docs/VALIDATION.md)
- [외부 직원 호출 API](ai-company/docs/API.md)

```sh
cd ai-company
npm run verify
```

운영 DB·에이전트 실행 원본·Git 작업 공간·인증 정보는 저장소에 포함하지 않습니다. WorkAdventure 연동은 후속 구현 대상입니다.
