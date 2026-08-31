import { describe, expect, test } from "bun:test";

const extensionPath = "./home/pi/files/plan-execute/index.ts";

describe("Plan Execute v2 extension", () => {
  test("registers the rationalized planning and staged-verification surface", async () => {
    const source = await Bun.file(extensionPath).text();
    const planWorker = await Bun.file("home/pi/files/agents/plan-worker.md").text();
    const metis = await Bun.file("home/pi/files/agents/metis.md").text();
    const momus = await Bun.file("home/pi/files/agents/momus.md").text();
    const tools = [...source.matchAll(/name: \"([a-z_]+)\", label:/g)].map((match) => match[1]);
    const commands = [...source.matchAll(/registerCommand\(\"([a-z-]+)\"/g)].map((match) => match[1]);
    const events = [...source.matchAll(/pi\.on\(\"([a-z_]+)\"/g)].map((match) => match[1]);

    expect(tools).toEqual([
      "workflow_status",
      "plan_inspect",
      "planning_brief_save",
      "planning_brief_load",
      "metis_import",
      "plan_save",
      "plan_patch",
      "plan_load",
      "momus_import",
      "work_import",
      "work_decide",
      "work_verify",
    ]);
    expect(commands).toEqual(["plan", "cancel-plan", "start-work", "work-status", "stop-work", "abandon-work"]);
    expect(events).toEqual(["before_agent_start", "tool_call", "tool_execution_end", "tool_result", "session_compact", "session_start"]);
    expect(source).not.toContain('name: "work_complete"');
    expect(source).not.toContain('name: "plan_review"');
    expect(planWorker).toContain("tools: read, grep, find, ls, bash, edit, write");
    expect(planWorker).not.toContain("contact_supervisor");
    expect(source).toContain("A fresh worker must not need to rediscover material control flow or architecture");
    expect(source).toContain("cite this ID from the acceptance criterion it proves");
    expect(metis).toContain("entry points, boundary symbols, callers or consumers, integration wiring");
    expect(momus).toContain("acceptance merely restates the outcome");
  });

  test("runs bounded read-only inspection commands during planning", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const { default: extension } = await import('${extensionPath}');
      const tools=new Map(),commands=new Map(),handlers=new Map(),calls=[]; let active=['bash'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return [...tools.keys()].map(name=>({name}))},appendEntry(){},sendUserMessage(){},exec:async(program,args,options)=>{calls.push({program,args,options});return {code:0,stdout:'result',stderr:''}}};
      extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-inspect-'));
      const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},ui:{notify(){}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('plan').handler('inspect first',ctx);
      const safe=await tools.get('plan_inspect').execute('1',{program:'git',args:['status','--short']},undefined,undefined,ctx);
      const rejected={};
      for(const [name,params] of Object.entries({find:{program:'find',args:['.','-delete']},rg:{program:'rg',args:['--pre=rm -rf .','x']},git:{program:'git',args:['diff','--ext-diff']}})){try{await tools.get('plan_inspect').execute(name,params,undefined,undefined,ctx)}catch(error){rejected[name]=error.message}}
      const status=(await tools.get('workflow_status').execute('status',{},undefined,undefined,ctx)).details;
      const planningActive=[...active]; await commands.get('cancel-plan').handler('',ctx);
      console.log(JSON.stringify({planningActive,restored:active,safe:safe.details,rejected,status,calls}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"});
    const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    const result=JSON.parse(stdout);
    expect(result.planningActive).toContain("plan_inspect"); expect(result.planningActive).not.toContain("bash");
    expect(result.restored).toContain("bash");
    expect(result.status.nextAction).toBe("planning_brief_save");
    expect(result.safe.exitCode).toBe(0);
    expect(result.calls[0].args).toEqual(["--no-optional-locks","status","--short"]);
    expect(result.rejected.find).toContain("mutating find");
    expect(result.rejected.rg).toContain("preprocessors");
    expect(result.rejected.git).toContain("external-command");
  });

  test("allows isolated planning scouts, researchers, and oracle", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const { default: extension } = await import('${extensionPath}');
      const commands = new Map(), handlers = new Map(); let active = ['read','subagent'];
      const pi = { registerTool(){}, registerCommand(n,d){commands.set(n,d)}, on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)}, getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){} };
      extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-agents-'));
      const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},ui:{notify(){}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('plan').handler('research first',ctx);
      const route=async(agent,extra={})=>{const event={toolName:'subagent',input:{agent,task:'inspect',...extra}};const result=await handlers.get('tool_call')[0](event);return {result,input:event.input}};
      console.log(JSON.stringify({scout:await route('scout'),researcher:await route('researcher'),oracle:await route('oracle'),delegate:await route('delegate')}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"});
    const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    const result=JSON.parse(stdout);
    expect(result.scout.input).toMatchObject({async:true,context:"fresh",worktree:true});
    expect(result.researcher.input).toMatchObject({async:true,context:"fresh",worktree:true});
    expect(result.oracle.input).toMatchObject({async:true,context:"fork",worktree:true});
    expect(result.delegate.result.block).toBe(true);
  });

  test("imports only foreground package-validated Metis output", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const { default: extension } = await import('${extensionPath}');
      const tools=new Map(),commands=new Map(),handlers=new Map(),messages=[]; let active=['read','subagent'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){},sendMessage(message){messages.push(message)}}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-metis-')); const ctx={cwd:root,mode:'rpc',hasUI:false,ui:{notify(){}},waitForIdle:async()=>{},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('plan').handler('rewrite it',ctx);
      const saved=await tools.get('planning_brief_save').execute('1',{request:'rewrite it',requirements:['Keep context valuable'],proposedApproach:'Use deterministic gates'},undefined,undefined,ctx);
      const {slug,briefHash}=saved.details; const managed=['.pi','work'].join('/');
      const call={toolName:'subagent',input:{agent:'metis',task:'review'}}; for(const h of handlers.get('tool_call')) await h(call);
      const value={briefPath:managed+'/briefs/'+slug+'.json',briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]};
      for(const h of handlers.get('tool_result')) await h({toolName:'subagent',input:call.input,details:{runId:'metis-root',results:[{agent:'metis',index:0,exitCode:0,structuredOutput:value}]}});
      const imported=await tools.get('planning_brief_load').execute('2',{slug},undefined,undefined,ctx);
      console.log(JSON.stringify({async:call.input.async,output:call.input.output,acceptance:call.input.acceptance,readiness:imported.details.readiness,reviewMessage:messages[0]?.content}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({async:false,output:false,acceptance:{level:"none"},readiness:"ready",reviewMessage:expect.stringContaining("Metis review imported")});
  });

  test("automatically imports Momus and worker completion artifacts", async () => {
    const script = `
      import {mkdtemp} from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const {default:extension}=await import('${extensionPath}'); const core=await import('./home/pi/files/plan-execute/core.ts');
      const tools=new Map(),commands=new Map(),handlers=new Map(),messages=[]; let active=['read','subagent'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){},sendMessage(message){messages.push(message)},exec:async(program,args)=>({code:0,stdout:program==='git'&&args[0]==='rev-parse'?'HEAD\\n':'',stderr:''})}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-auto-')); const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},isIdle:()=>true,abort(){},ui:{notify(){},confirm:async()=>true},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('plan').handler('auto import',ctx);
      const saved=await tools.get('planning_brief_save').execute('1',{request:'auto import',requirements:['Implement'],proposedApproach:'One task'},undefined,undefined,ctx);
      let brief=await core.readBrief(root,saved.details.slug); brief=core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]}); await core.writeBrief(root,brief);
      const savedPlan=await tools.get('plan_save').execute('2',{title:'Auto',goal:'Implement',tasks:[{title:'Task',outcome:'The src entry point implements R1',satisfies:['R1'],references:['src#index'],expectedPaths:['src'],acceptance:['test proves the R1 behavior'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},undefined,undefined,ctx);
      let plan=await core.readPlan(root,savedPlan.details.slug); const managed=['.pi','work'].join('/');
      const momusCall={toolName:'subagent',input:{agent:'momus',task:'review current plan'}}; for(const h of handlers.get('tool_call')) await h(momusCall);
      const momusValue={planPath:managed+'/plans/'+plan.slug+'.md',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]}; for(const h of handlers.get('tool_result')) await h({toolName:'subagent',input:momusCall.input,details:{runId:'momus-root',results:[{agent:'momus',index:0,exitCode:0,structuredOutput:momusValue}]}});
      plan=await core.readPlan(root,plan.slug); await commands.get('start-work').handler(plan.slug,ctx); let runtime=await core.readRuntime(root); const lease=runtime.state.lease;
      const workerCall={toolName:'subagent',input:{agent:'plan-worker',task:'implement current lease'}}; for(const h of handlers.get('tool_call')) await h(workerCall); const duplicateCall={toolName:'subagent',input:{agent:'plan-worker',task:'duplicate'}}; let duplicate; for(const h of handlers.get('tool_call')) duplicate=await h(duplicateCall); runtime=await core.readRuntime(root); const attempt=runtime.state.workerAttempt;
      const workerValue={leaseId:lease.id,attemptId:attempt.id,planHash:plan.specHash,taskIds:lease.taskIds,status:'implemented',summary:'done',changedPaths:[],semanticDelta:{accomplished:['done'],architectureChanges:[],decisions:[],invalidatedAssumptions:[],planDeviations:[],newRisks:[],userDecisionNeeded:[]}}; for(const h of handlers.get('tool_result')) await h({toolName:'subagent',input:workerCall.input,details:{runId:'worker-root',results:[{agent:'plan-worker',index:0,exitCode:0,structuredOutput:workerValue}]}});
      runtime=await core.readRuntime(root); console.log(JSON.stringify({verdict:plan.momus.verdict,stage:runtime.state.stage,workerRunId:runtime.state.workerRunId,momusTask:momusCall.input.task,workerTask:workerCall.input.task,reviewMessage:messages[0]?.content,acceptance:workerCall.input.acceptance,async:workerCall.input.async,output:workerCall.input.output,nestedFact:workerCall.input.outputSchema.properties.semanticDelta.properties.architectureChanges.items.properties.fact.type,duplicate}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0); expect(JSON.parse(stdout)).toMatchObject({verdict:"approved",stage:"verify",workerRunId:"worker-root",momusTask:expect.stringContaining("authoritative .pi/work/plans/auto.json"),workerTask:expect.stringContaining("R1: Implement"),reviewMessage:expect.stringContaining("Momus review imported"),acceptance:{level:"none"},async:false,output:false,nestedFact:"string",duplicate:{block:true}});
  });

  test("records paused worker decisions by stable workflow ID", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const {default:extension}=await import('${extensionPath}'); const core=await import('./home/pi/files/plan-execute/core.ts');
      const tools=new Map(),commands=new Map(),handlers=new Map(); let active=['read'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){}}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-decision-'));
      let brief=core.createPlanningBrief({request:'decide',requirements:['Choose'],proposedApproach:'Implement'}); brief=core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]});
      let plan=core.createPlan({title:'Decision',goal:'Choose',tasks:[{title:'Task',outcome:'The src entry point applies the chosen format',satisfies:['R1'],references:['src#index'],expectedPaths:['src'],acceptance:['test proves the selected format'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},brief); plan=core.applyMomusReview(plan,{planPath:'plan',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]});
      const lease=core.createLease(plan,{}); plan=core.recordSemanticDelta(plan,lease.id,{accomplished:[],architectureChanges:[],decisions:[],invalidatedAssumptions:[],planDeviations:[],newRisks:[],userDecisionNeeded:['Which format?']});
      await core.writeRuntime(root,plan,{version:2,generation:0,planSlug:plan.slug,planHash:plan.specHash,status:'paused',stage:'dispatch',lease,receipts:[],updatedAt:new Date().toISOString()});
      const ctx={cwd:root,mode:'rpc',hasUI:false,ui:{notify(){}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      const before=(await tools.get('workflow_status').execute('1',{},undefined,undefined,ctx)).details; const id=before.pendingDecisions[0].id;
      await tools.get('work_decide').execute('2',{decisionId:id,decision:'JSON',rationale:'Machine-readable'},undefined,undefined,ctx);
      const after=(await tools.get('workflow_status').execute('3',{},undefined,undefined,ctx)).details;
      console.log(JSON.stringify({id,before:before.nextAction,pending:after.pendingDecisions.length,momus:before.reviews.momus,latest:before.reviews.latest.reviewer}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0); expect(JSON.parse(stdout)).toMatchObject({before:expect.stringContaining("work_decide Q-"),pending:0,momus:{verdict:"approved",current:true},latest:"momus"});
  });

  test("recovers only a harness-owned terminal worker receipt", async () => {
    const script = `
      import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const { default: extension } = await import('${extensionPath}'); const core=await import('./home/pi/files/plan-execute/core.ts');
      const tools=new Map(),commands=new Map(),handlers=new Map(); let active=['read','subagent'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){},exec:async(program,args)=>({code:0,stdout:program==='git'&&args[0]==='rev-parse'?'HEAD\\n':'',stderr:''})}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-recovery-'));
      let brief=core.createPlanningBrief({request:'recover',requirements:['Do work'],proposedApproach:'Implement'}); brief=core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]}); await core.writeBrief(root,brief);
      let plan=core.createPlan({title:'Recover',goal:'Work',tasks:[{title:'Task',outcome:'The src entry point completes recoverable work',satisfies:['R1'],references:['src#index'],expectedPaths:['src'],acceptance:['test proves recoverable work'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},brief); plan=core.applyMomusReview(plan,{planPath:'plan',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]}); await core.writePlan(root,plan); await core.writeWorkState(root,{version:2,generation:0,planSlug:plan.slug,planHash:plan.specHash,status:'planned',stage:'dispatch',receipts:[],updatedAt:new Date().toISOString()});
      const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},ui:{notify(){}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}}; await commands.get('start-work').handler(plan.slug,ctx);
      let runtime=await core.readRuntime(root); const lease=runtime.state.lease; const failedCall={toolName:'subagent',toolCallId:'tc-failed',input:{agent:'plan-worker',task:'implement'}}; for(const h of handlers.get('tool_call')) await h(failedCall); for(const h of handlers.get('tool_execution_end')) await h({toolName:'subagent',toolCallId:'tc-failed',args:failedCall.input,isError:true}); const call={toolName:'subagent',toolCallId:'tc-retry',input:{agent:'plan-worker',task:'implement'}}; for(const h of handlers.get('tool_call')) await h(call); runtime=await core.readRuntime(root); const attempt=runtime.state.workerAttempt;
      const value={leaseId:lease.id,attemptId:attempt.id,planHash:plan.specHash,taskIds:lease.taskIds,status:'implemented',summary:'done',changedPaths:[],semanticDelta:{accomplished:['done'],architectureChanges:[],decisions:[],invalidatedAssumptions:[],planDeviations:[],newRisks:[],userDecisionNeeded:[]}}; const receiptPath=path.join(root,'.pi','work','evidence','provider','worker-'+attempt.id+'.json'); await mkdir(path.dirname(receiptPath),{recursive:true}); await writeFile(receiptPath,JSON.stringify({version:1,agent:'worker',identity:attempt.id,rootRunId:'worker-root',childRunId:'worker-child',recordedAt:new Date().toISOString(),value}));
      const status=await tools.get('workflow_status').execute('0',{},undefined,undefined,ctx); await tools.get('work_import').execute('1',{},undefined,undefined,ctx); const recovered=await core.readRuntime(root);
      console.log(JSON.stringify({stage:recovered.state.stage,workerRunId:recovered.state.workerRunId,nextAction:status.details.nextAction,attemptId:attempt.id}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({stage:"verify",workerRunId:"worker-root",nextAction:"work_import"});
  });

  test("matches pi-subagents public single-child and wait projection contracts", async () => {
    const { normalizePublicSubagentExecution } = await import("/home/fuzakebito/.pi/agent/npm/node_modules/pi-subagents/src/extension/public-execution.ts");
    const { toWaitCompletion } = await import("/home/fuzakebito/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/wait-completions.ts");
    const normalized = normalizePublicSubagentExecution({ agent: "plan-worker", task: "implement", async: false, foregroundOnly: true, output: false, outputSchema: { type: "object" } });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.params.async).toBe(false);
    expect(normalized.params.foregroundOnly).toBe(true);
    expect(normalized.params.workflowScript).toContain('"output":false');
    const completion = toWaitCompletion({ agent: "workflow", success: true, results: [{ agent: "plan-worker", runId: "child", success: true, structuredOutput: { ok: true } }] }, "root");
    expect(completion.results?.[0]).not.toHaveProperty("structuredOutput");
  });

  test("loads in the configured Pi runtime environment", async () => {
    const child = Bun.spawn(["bun", "-e", `import('${extensionPath}').then(()=>console.log('ok'))`], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("ok");
  });
});
