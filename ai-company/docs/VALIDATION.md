# 실제 협업 검증 결과

첫 버전의 5단계 실증 기록입니다. 최신 자율 운영 확장의 검증과 미완료 사항은 [AUTONOMY-VALIDATION.md](AUTONOMY-VALIDATION.md)를 확인하세요.

검증 시각: 2026-09-10T02:53:52.731Z

레슨퀘스트는 이 컴퓨터에 없어 검사하거나 변경하지 않았습니다. 독립된 검증용 인사 도구 저장소에서 동일한 파이프라인을 실제로 실행했습니다.

- 최종 상태: `review` (대표 검토 준비)
- 원본의 Git 상태·미완료 diff·미추적 메모 보존: `True`
- 검토 브랜치: `company/review-04bd17b2`
- 통합 커밋: `6de2044ba3977739d13d3e1d4be65f8bd8591588`
- 통합 저장소: `.local/live-validation/data/projects/<project-id>/tasks/<task-id>/repository` (로컬 검증 환경)
- Codex 인증: 기존 ChatGPT 로그인
- 실제 모델: `gpt-5.6-luna` (프로젝트 설정)
- 완료된 실제 에이전트 실행: 5회

| 직무 | 상태 | 기록된 토큰 |
|---|---|---|
| po | completed | 17194 |
| cto | completed | 17922 |
| backend | completed | 19913 |
| frontend | completed | 24220 |
| qa | completed | 20194 |

상세 Run·Thread·Turn ID와 원본 이벤트는 로컬 검증 기록에 보관하며 공개 저장소에는 포함하지 않습니다.

## 변경 파일

- `backend/greeting.mjs`
- `frontend/index.html`
- `tests/greeting.test.mjs`

한국어 인사 함수, 이름의 앞뒤 공백 정리와 빈 값 처리, 이름 입력 폼과 접근성 label/aria-live, 회귀 테스트를 추가했습니다.

## 실제 QA 실행

```text
node --test tests/*.test.mjs
exit code: 0
✔ 일반 이름으로 한국어 인사를 반환한다 (0.9098ms)
✔ 이름 앞뒤 공백을 제거한다 (0.2145ms)
✔ 빈 문자열과 공백만 입력하면 방문자로 처리한다 (0.1353ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 100.0914

```

## 중단 후 복구

최초 실행 도중 Windows Git CRLF 경고가 파일 목록에 섞이는 문제를 발견했습니다. stdout/stderr를 분리하고 프로세스를 다시 시작했습니다. PO·CTO·백엔드의 완료된 모델 응답을 다시 호출하지 않고 저장된 작업 공간부터 재개했습니다. 최종 완료 실행은 총 5회입니다.

## 검증 범위

- 자동 테스트 10개 통과: 초기 회사, 프로젝트 범위 분리, 재시작 복구, 실행 예산과 중지, 변경 경로 제한, API 인증·채용, 미완료 변경 보존, 대화 취소와 재개, 파이프라인 재개.
- TypeScript 검사 및 프로덕션 빌드 통과.
- 별도 UI 검증 DB에서 실제 브라우저로 채용, 저장소 없는 프로젝트 등록, 읽기 담당자 배정, 프로젝트 전환, 대표 메시지 저장과 공통 대화 분리를 확인했습니다.
- 브라우저의 결과 검토 화면에서 3개 변경 파일, QA 종료 코드 0, 실제 Run/Thread/Turn ID를 확인했습니다. 모바일 너비에서 본문 가로 넘침도 없었습니다.
- 운영 DB는 비워 두었습니다. 검증 직원과 프로젝트는 `.local/live-validation/data`와 `.local/ui-validation`에만 있습니다.

원본 결과: `.local/live-validation/report.json`. 실제 이벤트: `.local/live-validation/data/company.sqlite`.

레슨퀘스트의 실제 폴더 또는 접근 가능한 저장소가 준비되면 별도 프로젝트로 등록하고 작은 업무를 추가 검증해야 합니다.
