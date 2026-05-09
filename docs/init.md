workflow:
1. user input 
2. generate the implemented plan(구현 단위를 커밋 단위로 나눠서 명시해줘)
3. 기존에 다른 Branch에서 구현 중인 Plan이 있으면 찾아보고 종속된 부분이 많으면 만들었던 Plan제거하고 프롬프트를 그쪽 Branch에 QUEUE에 추가
3. 독립적인 부분이 많다면 커밋 단위를 순차적으로 구현 시작
4. 커밋단위 구현이 끝난다면 "지금까지 구현을 점검하고 문제가 없다면 커밋해줘" 라고 프롬프트를 추가
5. Plan의 커밋들이 모두 구현 완료되면 PR 올림. 
5. PR이 심사중이라면 모든 Plan 생성을 일시중단 Merge 이후에 다시 시작. 

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
PR 올림. 

# Agent 4: PR 심사, Merge
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

# Terminal 2
crack dashboard --watch
```

dashboard는 `.crack/` Markdown 파일과 git 상태를 읽기만 하며 plan, queue, log를 수정하지 않는다.
