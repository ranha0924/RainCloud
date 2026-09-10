# 로컬 Jarvis 연동 API

현재 API는 SQLite 큐에 요청을 저장합니다. 실제 대화/작업에는 별도 `npm run runner` 실행기가 필요합니다. 브라우저나 웹 서버 종료와 관계없이 큐가 유지됩니다.

## 자율 운영 API

아래의 `:scope`에는 명시적인 프로젝트 ID를 사용합니다. 다른 프로젝트의 task/material/decision ID는 거부됩니다.

| 경로 | 요청/동작 |
|---|---|
| `GET /api/scopes/:scope/operation` | 정책·실행기 heartbeat·완료/실패/대기/다음 업무·결정 요약 |
| `PUT /api/scopes/:scope/operation` | `objectives:[{id,text,acceptance,priority}]`, `scope`, `allowedCategories`, `maxConcurrent`, `maxRetries`, `taskMinutes`, `turnMinutes`, `maxTaskCalls`, `sessionMinutes`, `checkMinutes`, `maxTasksPerPlan`, `maxMessageHops` 저장 |
| `POST /api/scopes/:scope/operation/start` | `{revision}`: 최신 설정 버전과 일치해야 시작/재개, 적용 범위 스냅샷 저장 |
| `POST /api/scopes/:scope/operation/pause` | 프로젝트 일시정지, 신규 실행 중지 및 진행 중 취소 |
| `POST /api/scopes/:scope/materials` | `{title,text,source}` 실제 자료 저장 |
| `POST /api/scopes/:scope/tasks` | `{title,description,kind?,category?,priority?,goalId?,acceptance?,dependsOn?,materials?,requiredRoles?}` |
| `POST /api/scopes/:scope/tasks/:id/respond` | `{response,materials?}` 정보 대기 해제 |
| `POST /api/scopes/:scope/tasks/:id/cancel` | 업무 취소 |
| `POST /api/scopes/:scope/tasks/:id/accept` | 검증·CTO 증거가 있는 검토 결과를 대표가 완료 처리 |
| `GET /api/scopes/:scope/tasks/:id/evidence` | 저장된 완료 증거 JSON 다운로드 |
| `POST /api/scopes/:scope/decisions/:id/resolve` | `{action:"approve" 또는 "reject",response}` 결정 이유 저장 |
| `POST /api/scopes/:scope/messages` | `{message,taskId?,recipientId?,channel?}` 업무·수신자 메시지. `channel=meeting-<id>`는 열린 회의의 해당 프로젝트 참여자에게 원자적으로 큐 생성 |

`kind`는 `code`/`research`이며 category와 정책 스키마는 `server/operations.mjs`에 정의됩니다. 입력값은 Zod로 검증합니다. 외부 발송·지출·배포·운영 삭제·권한 변경은 승인 기록 후에도 외부 커넥터가 없어 자동 실행되지 않습니다. 전체 중지의 해제만으로 프로젝트 한도를 초기화하지 않습니다.

## 로컬 인증

기본 주소: `http://127.0.0.1:4310`. 이 문서의 API는 로컬 호출 전용입니다.

Jarvis 프로세스와 회사 앱 프로세스에 동일한 `COMPANY_API_TOKEN`을 OS 비밀 저장소에서 주입하고 요청에 `Authorization: Bearer <token>` 헤더를 사용하세요. 토큰 값을 채팅·소스 파일·URL에 넣지 마세요. 환경 변수 이름만 코드에 기록합니다. 브라우저 UI는 이 토큰을 사용하지 않고 별도의 HttpOnly 세션을 사용합니다.

```js
const base = 'http://127.0.0.1:4310';
const response = await fetch(`${base}/api/scopes/${projectId}/employees/${employeeId}/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.COMPANY_API_TOKEN}`,
  },
  body: JSON.stringify({ message: '현재 업무 진행 상황을 설명해 주세요.', channel: 'jarvis' }),
});
if (!response.ok) throw new Error(await response.text());
const { conversationId } = await response.json();
```

`projectId`는 등록 API/목록에서 반환된 UUID입니다. 회사 운영 공통 대화에만 `company`를 사용하세요. 직원 ID는 회사 공통이지만, 프로젝트에 배정된 직원만 해당 범위에서 호출할 수 있습니다. 프로젝트 + 직원 + channel 조합마다 별도 Codex Thread를 저장합니다. 같은 조합으로 다시 호출하면 이전 대화를 이어갑니다. HTTP 202는 접수이며 완료가 아닙니다.

| 요청 | 결과 |
|---|---|
| `GET /api/bootstrap` | 회사 규칙, 직무, 직원, 지원자, 프로젝트 설정 목록 |
| `GET /api/scopes/:scope` | 해당 범위의 대화·Run·업무·기억·사용량 |
| `POST /api/scopes/:scope/employees/:employeeId/messages` | 직원 대화 실행. `{message, channel?}` → 202 `{conversationId}` |
| `POST /api/scopes/:scope/messages` | 대표의 일반 채널 메시지 저장. `{message}` |
| `GET /api/scopes/:scope/runs/:runId/events?after=0` | 해당 Run의 실제 이벤트. seq 이후 최대 1,000개 |
| `POST /api/scopes/:scope/tasks` | 업무 생성. `{title, description}` |
| `POST /api/scopes/:scope/tasks/:taskId/start` | 새 실행/저장 단계에서 재개 |
| `POST /api/stop` | 전체 중지 latch 설정, 활성 실행 취소 |
| `POST /api/resume` | 새 실행 허용. 업무 자동 재개는 하지 않음 |
| `GET /api/runtime/status` | Codex 연결·인증 유형·계정 한도·가능한 모델 |

모든 엔드포인트는 오류 시 `{error: string}`을 반환합니다. 401은 로컬 세션 또는 토큰 없음, 403은 Host/Origin 불일치, 400은 입력 오류, 409는 현재 상태/권한/예산/실행 충돌입니다. 프로젝트 동시성 설정과 실행기 전체 동시 상한 4개를 적용합니다.

Run의 `status=completed`와 최종 응답을 확인해야 직원 대화가 완료된 것입니다. 개발 업무는 다섯 단계 완료, 실제 변경 파일, QA 종료 코드 0, QA의 passed=true가 모두 필요하며 그때 `task.status=review`가 됩니다. QA 통과는 정확성을 보증하는 인증이 아니므로 diff를 검토하세요.
# 경험·피드백·QA 비교 API

모두 기존 로컬 세션 또는 `COMPANY_API_TOKEN`이 필요합니다. `:scope`는 등록된 프로젝트 ID입니다. 회사 공통 범위에서 프로젝트 경험에 접근하지 않습니다.

- `GET /api/scopes/:scope/experience`: 실행에서 경험을 동기화하고 피드백·지침·적용·충돌·공유 기록 조회.
- `POST /api/scopes/:scope/experience/:id/feedback`: `text`, `problem`, `correction`, `applyWhen`, `doNotApply`, 선택적 `correctionRunId`, `humanVerified`, `reviewMinutes` (미측정 null).
- `POST /api/scopes/:scope/experience/:id/suggest`: `{ feedbackId }`로 6단계 지침 후보 생성.
- `PUT /api/scopes/:scope/guidelines/:id`: 6단계 본문, `tags`, `checkCodes`를 새 버전으로 저장.
- `POST /api/scopes/:scope/guidelines/:id/review`: `{ version, status: candidate|verified|retired, active }`. 독립 검증/대표 확인 근거 필요.
- `POST /api/scopes/:scope/guidelines/:id/share`: `{ version, targetProjectIds, rightsConfirmed: true, checkCodes }`. 고정 일반 문구만 공유.
- `POST /api/scopes/:scope/releases/:id/revoke`: 공유 철회.
- `POST /api/scopes/:scope/experience/search`: `{ employeeId, query }`. 직원 배정과 공유 허가를 확인한 뒤 관련 지침/경험만 조회.
- `POST /api/scopes/:scope/memory-reviews/:id/resolve`: `{ resolution }`. 지침 재활성화는 별도 검토 API.
- `GET /api/scopes/:scope/employees/:id/career`: 실제 업무/연습/평가별 근거와 고정 평가 조건.
- `POST /api/scopes/:scope/employees/:id/public-summary`: `{ rightsConfirmed: true }`. 원문 없는 집계의 공개 허용 표시. 같은 주소 DELETE로 철회.
- `GET /api/qa-catalog`: 과제 ID/분야, 체크리스트, 버전과 판정 원칙. 정답 제외.
- `GET|POST /api/scopes/:scope/evaluations`: 조회 또는 조건 고정. 생성 입력은 `employeeId, caseIds, model, tokenLimit, turnSeconds, label`, 선택적 `checklist` 문자열 배열.
- `POST /api/scopes/:scope/evaluations/:id/start|pause|cancel`: 고정 조건으로 실행/일시정지/취소. 완료 평가 재실행 금지.
- `POST /api/scopes/:scope/evaluations/:id/human-review`: `trialId, reviewMinutes, correctionMinutes, confirmed, notes`. 측정하지 않은 숫자/판정은 null.
- `GET /api/scopes/:scope/evaluations/:id/trials/:trialId/artifact`: 실제 QA 보고와 자동 검증 결과 다운로드.

평가 실행은 실행기의 `evaluation` 큐에서 처리합니다. App Server 동적 도구 `qa_read`와 `qa_execute`는 해당 과제의 고정 자료만 다루며 HTTP 대표 API/다른 프로젝트/정답에 접근하지 않습니다. 일반 업무 QA에는 활성 지침 검색과 활용 기록이 자동 연결됩니다. 도구 증거 없이 완료 보고만 있는 평가는 점수를 산정하지 않습니다.

## 개인 대표 운영 API

기본 경로는 `/api/scopes/:scope/personal`이다. 기존 로컬 인증과 프로젝트 ID 검증을 사용한다. 회사 범위에서는 시간·타이머·집계를 사용할 수 있고, 목표·결정·회의는 프로젝트에서만 가능하다.

| 메서드·상대 경로 | 내용 |
| --- | --- |
| `GET /` | 대표 화면: 목표·결정·직원별 업무·미측정/분모·시간·사용량·규칙·회의 |
| `PUT /settings` | `coordinatorId, technicalCoordinatorId, urgentTypes, urgentKeywords, digestHour` |
| `POST /experiment` | `label, startDate, days:7 또는 14, targetMinutes, timezone` |
| `POST /goals` | `text, acceptance, priority, taskType, size` — 버전 저장 후 범위 재확인 대기 |
| `POST /time` | `category, target, date, minutes, cause?, note?, taskId?, goalId?` 명시적 시간 |
| `POST /timer/start` | 시간 입력과 같은 연결 필드, date/minutes 제외 |
| `POST /timer/stop` | `minutes?, note?` — 실제 시간 조정 가능, 종료 시 날짜별 저장 |
| `POST /time/:id/void` | `reason` — 삭제 대신 취소 근거 보존 |
| `POST /coverage` | `date, complete` — 모든 개입을 기록했는지 명시적 확인 |
| `POST /decisions/:groupId` | `action:approve 또는 reject, response` — 현 단계에 유효한 동일 결정들을 처리 |
| `POST /results/:taskId` | `outcome:accepted 또는 changes, cause, notes?, technicalIntervention:unknown 또는 none 또는 yes` |
| `POST /goals/:id/assess` | `version, notes` — 연결 결과의 검증·수용과 정확한 업무 목록 확인 |
| `POST /baseline` | 기존 Codex 방식 기록. `minutes,tokens,cost` 미측정은 null |
| `POST /signals` | `kind:question 또는 recovery 또는 feedback, text, taskId?, employeeId?` |
| `PUT /improvements/:id` | `rule, expectedEffect, employeeId?, active` — 프로젝트 내부 새 버전 |
| `POST /meetings` | `agenda, participantIds, taskId?` — 안건 초안 |
| `POST /meetings/:id/start` | 필요한 참여자에게 별도 실행 맥락으로 전달, 전체 중지/한도 적용 |
| `POST /meetings/:id/close` | `decisions, actions:[{employeeId,taskId,responsibility}]` — 응답 완료 후 담당 기록 |

`category`는 briefing/decision/review/editing/recovery/maintenance, `target`은 project/company_tool, `cause`는 normal/error/requirements_change다. 불명확한 기술 개입은 unknown이며 미기록을 자율 처리 성공으로 계산하지 않는다. 정보 답변은 scope 승인으로 바뀌지 않는다. scope 외의 보호 행동은 승인 기록 뒤에도 자동 실행되지 않는다.

회사·프로젝트 `tokenBudget:null`은 명시적인 토큰 무제한이다. 호출·시간·동시성·전체 중지는 유지하고 사용량도 계속 기록한다. 사람의 시간 목표는 실행 제한으로 사용하지 않는다.
