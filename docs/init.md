workflow:
1. user input 
2. generate the implemented plan(구현 단위를 커밋 단위로 나눠서 명시해줘)
3. 기존에 다른 Branch에서 구현 중인 Plan이 있으면 찾아보고 종속된 부분이 많으면 만들었던 Plan제거하고 프롬프트를 그쪽 Branch에 QUEUE에 추가
3. 독립적인 부분이 많다면 커밋 단위를 순차적으로 구현 시작
4. 커밋단위 구현이 끝난다면 "지금까지 구현을 점검하고 문제가 없다면 커밋해줘" 라고 프롬프트를 추가
5. Plan의 커밋들이 모두 구현 완료되면 기본적으로 로컬 Branch에 완료 상태로 둠.
6. 원격 Branch/PR이 필요하면 CLI에서 remote mode로 실행해 PR을 올림.
7. 명시적으로 merge를 요청하면 local 또는 remote merge workflow를 실행함.
8. PR이 심사중이라면 모든 Plan 생성을 일시중단 Merge 이후에 다시 시작.

# Agent 0: Router
user의 프롬프트와 지금 구현이 진행중인 Plan 문서에 기반하여, 기존 Plan Branch에 새로운 PR을 넣을지 새로운 Branch를 만들어야하는지를 결정
구현범위의 종속, 독립을 판단하여 Route함. Agent0가 구현 시작 환경을 구성하고 Agent 1부터 구현이 시작됨.

# Agent 1: Plan 
Plan 커밋 구현 단위로 생성

# Agent 2: 구현
커밋을 단위로 계획된 계획을 보고 
"계획 문서를 읽고 첫번째 커밋 단위까지만 구현해줘" 
"지금까지의 구현을 점검하고 문제가 없다면 커밋해줘" 

# Agent 3: PR
기본 workflow에서는 로컬 Branch 완료 상태로 멈추고, remote mode에서만 PR 올림.

# Agent 4: Merge
Plan의 모든 commit unit이 완료된 뒤에만 명시적으로 merge를 실행한다.
기본 target branch는 `main`이고, remote mode는 GitHub CLI가 설치되고 인증되어 있다는 전제로 동작한다.
conflict가 있으면 merge agent는 현재 conflict 해결에만 집중하고, 실제 git merge 완료 여부는 orchestrator가 확인한다.

```bash
crack merge --plan .crack/plans/<plan>/plan.md
crack merge --remote --plan .crack/plans/<plan>/plan.md
crack run-all --merge --plan .crack/plans/<plan>/plan.md
crack run-all --merge --remote --plan .crack/plans/<plan>/plan.md
```

# Agent 5: PR 심사
PR 심사 중이라면 모든 Plan 생성을 일시중단 Merge 이후에 다시 시작.
(새롭게 만들어지는 Plan이 생기지 않도록 막음)

# Dashboard
현재 workflow 상태는 Markdown state를 source of truth로 두고 터미널에서 확인한다.

```bash
crack dashboard
crack dashboard --root /path/to/repo
```

남은 commit unit을 모두 실행하는 동안 다른 터미널에서 진행률을 확인할 수 있다.

```bash
# Terminal 1
crack run-all --plan .crack/plans/<plan>/plan.md

# Remote PR까지 열 때
crack run-all --branch-mode remote --plan .crack/plans/<plan>/plan.md

# Terminal 2
crack dashboard --watch
```

dashboard는 `.crack/` Markdown 파일과 git 상태를 읽기만 하며 plan, queue, log를 수정하지 않는다.
