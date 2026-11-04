# Live2D Studio

웹 기반 2D 리깅·애니메이션 편집기 (PWA). 설계서 §19 "가장 먼저 구현할 작업"의 1~3단계와 Phase 1(Editor Foundation)을 구현한 상태입니다.

> 본 프로젝트는 Live2D Inc.와 제휴 관계가 없습니다. MOC3 출력은 공식적으로 허용된 경로가 확보된 뒤에만 구현합니다 (`docs/compatibility.md`).

## 데모

샘플 캐릭터가 미리 열린 호스팅 데모 빌드: `VITE_DEMO=1 VITE_APP_NAME="Rig Studio" pnpm --filter web build --base ./` (데모 빌드는 Live2D Inc.와 혼동되지 않도록 중립적 이름을 사용합니다). 로컬에서는 `/?sample` 또는 `#sample`로 샘플을 바로 열 수 있고, File → Open Sample Character 메뉴도 있습니다.

## 실행

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm sample:psd     # samples/sample-character.psd 생성 (테스트용 원본 캐릭터)
```

```bash
pnpm test           # 단위·통합 테스트 (Vitest)
pnpm e2e            # 브라우저 E2E (Playwright, dev 서버 자동 기동)
pnpm typecheck
pnpm build          # apps/web/dist (PWA)
```

## 현재 구현 범위

| 설계서 항목 | 상태 |
|---|---|
| §19-1 React + PixiJS 8(WebGL2) 편집기 프레임 | ✅ 메뉴/좌측 파츠 트리/중앙 Canvas/우측 Inspector/하단 패널, 패널 크기 조절 |
| §19-2 PSD 가져오기 및 레이어 표시 | ✅ Worker에서 파싱, 그룹·순서·표시·불투명도·블렌드·레이어 마스크·클리핑 보존 |
| §19-3 레이어 클릭 선택 | ✅ 알파 기반 픽셀 단위 선택, Alt+클릭으로 겹친 레이어 순환, 다중 선택 |
| §4.3 / §10.1 파츠 인식 | ✅ 레이어·폴더 이름 규칙 + 얼굴 기준 위치/크기/그리기 순서/좌우 쌍 기하 규칙, 신뢰도·근거 표시, 승인 후 적용(사용자 태그는 덮어쓰지 않음) |
| §10.4 AI Auto Rig | ✅ 규칙 엔진 초안: 메시 → 표준 파라미터 → Head Z(턱 피벗) → Face XY(AngleX×Y) → 눈 깜빡임 → 시선 → 입(열림/닫힘 교체·MouthForm) → 앞/뒷머리 시차. 단계별 on/off, 미리보기(데모 모션)·유지/폐기, 한 번에 Undo, 물리 후보·좌우 쌍 표시 |
| §10.5 Rigging Assistant | ✅ 로컬 의도 해석(한/영/일 키워드) → 계획 표시 → 승인/Undo. 선택형 Claude 연결(기본 꺼짐, 사용자 API 키, **텍스트만 전송**: 요청·레이어 이름/태그·파라미터 ID — 이미지·프로젝트 파일은 전송 안 함, 전송 내용 미리보기, 실패 시 로컬 해석으로 대체) |
| §10.6 Quality Analyzer | ✅ 메시 품질, 키 극값에서 접힘/과도한 늘어남, 파라미터 미사용·연결 누락, 디포머 구조, 좌우 대칭 불일치 → 오류/제안, 클릭 시 대상 선택+해당 파라미터 값으로 이동 |
| §10.2 파츠 분할 | ✅ AI Tools → Split Layer into Parts: 알파 섬 / 색상(k-means) 영역 분할 → 원본(숨김) + 파츠 레이어 그룹, 한 번에 Undo. 학습 모델이 아닌 고전적 분할 |
| 이미지 분류 모델(ONNX) | ⏳ 학습된 모델·라이선스 확인 필요 (인터페이스 `PartClassifier`만 정의) |
| Undo / Redo | ✅ 모든 문서 변경은 Command → Immer 패치로 기록 |
| 프로젝트 저장 | ✅ IndexedDB 자동 저장, 새로고침 시 복구, `.l2studio` 패키지 내보내기/열기, 무결성 검사, 버전 마이그레이션 골격 |
| §19-4 / §5 ArtMesh | ✅ 자동 메시 생성(외곽·내곽 여백, 점 간격, 눈·입·얇은 영역 고밀도), 메시 렌더링, 정점 선택·이동·추가·삭제, 박스 선택, 재삼각분할, 메시 복제·대칭 복사, 품질 검사(§5.4) |
| §5.1 마스크 참조(클리핑) | ✅ 런타임 ArtMesh 마스크(변형을 따라감, 반전 지원). PSD 클리핑은 픽셀에 굽지 않고 마스크 참조로 가져옴 |
| §5.2 엣지·삼각형 편집, UV 편집 | ✅ 정점 연결(사용자 엣지는 재삼각분할에도 유지), 엣지 제거/플립, 삼각형 생성·삭제(삭제 유지·복원), UV 모드(텍스처만 이동)·UV 초기화 |
| §6 Deformer | ✅ Warp(격자 분할 지정, 쌍선형 보간·외삽), Rotation(원점·각도·배율), 부모/자식 계층·순환 차단, 재부모화 시 현재 모습 유지, Deformers 트리(드래그로 부모 변경) |
| §7 Parameter / Keyform | ✅ §7.1 표준 파라미터 프리셋, 사용자 정의 파라미터(ID·범위·기본값·반복), 2/3키 추가·키 삽입/삭제, 다중 파라미터 다선형 보간, Deform 도구로 키폼 편집, 키폼 복사/붙여넣기, 대칭 키폼 복사, 기본 포즈 고스트 비교 |
| §7.3 Blend Shape | ✅ 파라미터 하나에 묶인 가산 변형(키폼 격자 위에 더해짐), Deform 도구로 편집, 재부모화·파라미터 이름변경/삭제·메시 토폴로지 변경에 동기화 |
| 베지어 워프 편집 | ✅ Deform 도구에서 B: 1×1/2×2 베지어 제어망, 표면 변화량만 격자에 더해 기존 변형 유지 |
| 드로우오더 키폼 | ✅ ArtMesh 키폼별 0–1000(기본 500), 보간·반올림, 형제 사이 재정렬(렌더·선택 일치) |
| 다중 뷰 | ✅ View → Split View: 별도 카메라, 기본 포즈/현재 포즈 비교 |
| ArtPath | ✅ 펜 도구(P): 클릭으로 제어점, Enter/더블클릭 완료. Catmull-Rom 리본 렌더, 두께·색·불투명도·테이퍼, 디포머·키폼·파라미터에 일반 ArtMesh와 동일하게 바인딩 |
| §8 Physics | ✅ Cubism physics3 모델(입력 X/Y/Angle·가중치·반전, 진자 입자 길이/이동성/지연/가속도, 출력, 정규화, 중력·바람, 고정 FPS + 보간) — Live2D 공개 Framework 알고리즘과 동일 동작으로 독자 구현, 실시간 미리보기·진자 시각화, 애니메이션에 베이크 |
| §9 Animation | ✅ 클립(장면) 생성/복제/삭제/길이 변경(키 스케일 옵션)/FPS/루프/작업 구간, 키프레임 설정·이동·삭제, 재생/정지/프레임 이동, 곡선 편집기(Linear·Bezier·Ease In/Out/In-Out·Step·사용자 핸들) |
| §9.3 출력 | ✅ PNG 시퀀스(zip), WebM(VP9/VP8, 투명 배경 지원), 해상도·배경색·물리 포함 여부·작업 구간 |
| Auto Rig 물리 | ✅ ParamHairFront/Back + Sway 워프 + 물리 그룹 자동 생성 |
| Onion Skin, 그리드·가이드 | ✅ 전/후 프레임 고스트(간격 조절), 32/64px 그리드, 중앙·3분할 가이드 |
| 접근성·단축키 | ✅ Settings → Preferences: 인터페이스 크기, 모션 줄이기, 단축키 재지정(충돌 해제)·초기화, 포커스 표시 |
| 안정성 | ✅ 시드 고정 무작위 편집 300단계 × 3: 매 단계 무결성·유한값 평가·단계별 Undo/Redo 정확 복원 |
| §7.3 파라미터 그룹·프리셋(표현식) | ✅ 그룹 생성/이름변경/삭제·배정·접기(cdi3 GroupId 출력), 표현식 = Cubism exp3 의미(Add/Multiply/Overwrite, 페이드), 현재 값에서 캡처·미리보기·편집, exp3.json 내보내기/가져오기, MOC3 미리보기에서도 적용 |
| §13 성능 | ✅ 4096² 240레이어 스트레스 PSD: 가져오기 14→7.6초, 최대 UI 정지 3초→0.1초, 자동 메시 워커 풀(11.2→6.4초) — `docs/performance.md` |
| 다중 클립 배치 타임라인 | ✅ 하단 Timeline → Scene: 장면에 여러 클립을 트랙에 배치·이동·제거, 나중 트랙 우선, 재생, 장면을 하나의 클립으로 평탄화해 내보내기 |
| 텍스처 품질 | ✅ Preferences → Texture quality(자동/원본/1/2/1/4): 기기 메모리 기준 자동 축소 업로드, UV 보정 |
| §11 Cubism 호환 | ✅ physics3/motion3 내보내기·가져오기, cdi3 내보내기, JSON 번들 · ⚠️ MOC3 미리보기(공식 Core 사용자 제공, 실제 Core로 미검증 — `docs/compatibility.md`) · ❌ .moc3 생성(허용된 경로 필요) |

## 조작

| 동작 | 입력 |
|---|---|
| 화면 이동 | 휠 버튼 / 우클릭 드래그 / Space+드래그 / Shift+휠 |
| 확대·축소 | 휠 (커서 기준), Ctrl+= / Ctrl+-, Ctrl+0 맞춤, Ctrl+1 100% |
| 선택 | 클릭, Shift(추가), Ctrl(토글), Alt(아래 레이어로 순환), 트리에서 Shift 범위 선택 |
| 편집 | Ctrl+G 그룹, Ctrl+Shift+G 해제, Del 삭제, Ctrl+]/[ 순서, Ctrl+, 표시, Ctrl+L 잠금, 더블클릭 이름 변경, 트리 드래그로 이동 |
| 메시 | Ctrl+Shift+M 자동 메시, M 메시 편집 진입/종료, 드래그 이동·박스 선택, Alt+클릭(또는 더블클릭) 정점 추가, Del 삭제, 방향키 1px(Shift 10px) 이동, Esc 종료 |
| 리깅 | B 베지어 워프 편집(Deform 중), D Deform 도구(현재 키에 있을 때만 편집), 회전 디포머: ○ 드래그=이동, Alt+○ 드래그=피벗만 이동, 핸들 드래그=회전 · Ctrl+Shift+C/V 키폼 복사/붙여넣기 · Ctrl+Shift+R 파라미터 값 초기화 · 슬라이더 더블클릭=기본값, ◆ 클릭=키로 이동 |
| 메시 편집 | E 연결, F 엣지 제거/플립, T 삼각형, Shift+Del 삼각형 삭제, U UV 모드 |
| 애니메이션 | K 변경된 파라미터 키 설정, `,` `.` 이전/다음 프레임, 타임라인 키 드래그=시간 이동, Del=키 삭제, 눈금자 드래그=스크럽 |
| 파일 | Ctrl+O 열기, Ctrl+S 저장, Ctrl+Shift+E 패키지 내보내기, Ctrl+Shift+O 최근 프로젝트 |

## 저장소 구조

```
apps/web                 React UI (Zustand), PWA
packages/editor-core     데이터 모델, Scene Graph 유틸, Command/Undo, Selection
packages/psd-importer    ag-psd → 내부 Scene Graph, 마스크/클리핑 베이크, PNG 인코더, 파츠 이름 규칙
packages/mesh-engine     자동 메시(거리장·윤곽 추적·제약 들로네), 편집 명령, 품질 검사
packages/parameter-engine 파라미터 정의·프리셋, 키폼 그리드 보간·편집 (렌더링과 분리)
packages/deformer-engine 디포머 평가(정·역변환), 계층, 재부모화, 키폼/파라미터 명령, 대칭 복사
packages/ai-engine       파츠 인식, Auto Rig 제안/적용, 리그 품질 분석, 어시스턴트 의도 해석
packages/physics-engine  진자 물리 시뮬레이터(physics3 호환 구조), 물리 편집 명령
packages/animation-engine 클립·키프레임·곡선 평가(motion3 호환 세그먼트), 편집 명령, 물리 베이크
packages/cubism-adapter  motion3/physics3/cdi3 변환, model3 번들, 공식 Core 어댑터(타입·로더·검증·프레임)
packages/rendering-engine PixiJS 렌더러, 카메라, 알파 히트테스트, 텍스처 캐시, 블렌드 매핑
packages/project-format  IndexedDB(Dexie) 저장소, .l2studio(ZIP), 무결성 검사, 마이그레이션
workers/psd.worker.ts    PSD 파싱·인코딩 Worker
tests/                   unit / integration / e2e
docs/                    architecture, project-format, compatibility, api
```
