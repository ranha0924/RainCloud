# 로컬 Jarvis 연동 API

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

모든 엔드포인트는 오류 시 `{error: string}`을 반환합니다. 401은 로컬 세션 또는 토큰 없음, 403은 Host/Origin 불일치, 400은 입력 오류, 409는 현재 상태/권한/예산/실행 충돌입니다. 동시에 하나의 실행만 허용합니다.

Run의 `status=completed`와 최종 응답을 확인해야 직원 대화가 완료된 것입니다. 개발 업무는 다섯 단계 완료, 실제 변경 파일, QA 종료 코드 0, QA의 passed=true가 모두 필요하며 그때 `task.status=review`가 됩니다. QA 통과는 정확성을 보증하는 인증이 아니므로 diff를 검토하세요.
