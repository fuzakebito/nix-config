import { describe, expect, test } from "bun:test";

const extensionPath = "./home/pi/files/plan-execute/index.ts";

describe("Plan Execute v2 extension", () => {
  test("registers the rationalized planning and staged-verification surface", async () => {
    const source = await Bun.file(extensionPath).text();
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
      "plan_load",
      "momus_import",
      "work_import",
      "work_decide",
      "work_verify",
    ]);
    expect(commands).toEqual(["plan", "cancel-plan", "start-work", "work-status", "stop-work"]);
    expect(events).toEqual(["before_agent_start", "tool_call", "tool_result", "session_compact", "session_start"]);
    expect(source).not.toContain('name: "work_complete"');
    expect(source).not.toContain('name: "plan_review"');
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

  test("injects and automatically imports async file-only Metis output", async () => {
    const script = `
      import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      import os from 'node:os';
      const { default: extension } = await import('${extensionPath}');
      const tools = new Map(), commands = new Map(), handlers = new Map();
      let active = ['read', 'bash', 'edit', 'write', 'subagent'];
      const branch = [];
      const pi = {
        registerTool(def) { tools.set(def.name, def); },
        registerCommand(name, def) { commands.set(name, def); },
        on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
        getActiveTools() { return active; }, setActiveTools(next) { active = next; },
        getAllTools() { return ['read','grep','find','ls','bash','edit','write','subagent'].map(name => ({ name })); },
        appendEntry() {}, sendUserMessage() {},
      };
      extension(pi);
      const root = await mkdtemp(path.join(os.tmpdir(), 'plan-v2-'));
      const ctx = { cwd: root, mode: 'rpc', hasUI: false, ui: { notify() {} }, waitForIdle: async () => {}, sessionManager: { getBranch: () => branch, getSessionId: () => 'test' } };
      await commands.get('plan').handler('rewrite it', ctx);
      const saved = await tools.get('planning_brief_save').execute('1', {
        request: 'rewrite it', requirements: ['Keep context valuable'], proposedApproach: 'Use deterministic gates'
      }, undefined, undefined, ctx);
      const { slug, briefHash } = saved.details;
      const managed = ['.pi','work'].join('/');
      const call = { toolName: 'subagent', input: { agent: 'metis', task: managed + '/briefs/' + slug + '.json ' + briefHash } };
      for (const handler of handlers.get('tool_call')) await handler(call);
      const outputPath = path.join(root, call.input.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify({ briefPath: managed + '/briefs/' + slug + '.json', briefHash, readiness: 'ready', blockingGaps: [], nonBlockingRisks: [], directives: [] }));
      const archivePath = path.join(root, 'archive.json');
      await writeFile(archivePath, JSON.stringify({ entries: [{ source: 'output-artifact', path: outputPath, agent: 'metis' }] }));
      const wait = { toolName: 'subagent_wait', input: {}, details: { completions: [{ runId: 'run-1', agent: 'metis', success: true, archivePath }] } };
      for (const handler of handlers.get('tool_result')) await handler(wait);
      const imported = await tools.get('planning_brief_load').execute('2', { slug }, undefined, undefined, ctx);
      console.log(JSON.stringify({ async: call.input.async, context: call.input.context, outputMode: call.input.outputMode, output: call.input.output, readiness: imported.details.readiness }));
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ async: true, context: "fresh", outputMode: "file-only", readiness: "ready" });
  });

  test("automatically imports Momus and worker completion artifacts", async () => {
    const script = `
      import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const {default:extension}=await import('${extensionPath}'); const core=await import('./home/pi/files/plan-execute/core.ts');
      const tools=new Map(),commands=new Map(),handlers=new Map(); let active=['read','subagent'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){},exec:async()=>({code:0,stdout:'',stderr:''})}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-auto-')); const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},isIdle:()=>true,abort(){},ui:{notify(){},confirm:async()=>true},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('plan').handler('auto import',ctx);
      const saved=await tools.get('planning_brief_save').execute('1',{request:'auto import',requirements:['Implement'],proposedApproach:'One task'},undefined,undefined,ctx);
      let brief=await core.readBrief(root,saved.details.slug); brief=core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]}); await core.writeBrief(root,brief);
      const savedPlan=await tools.get('plan_save').execute('2',{title:'Auto',goal:'Implement',tasks:[{title:'Task',outcome:'Done',satisfies:['R1'],expectedPaths:['src'],acceptance:['Done'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},undefined,undefined,ctx);
      let plan=await core.readPlan(root,savedPlan.details.slug); const managed=['.pi','work'].join('/');
      const momusCall={toolName:'subagent',input:{agent:'momus',task:managed+'/briefs/'+brief.slug+'.json '+managed+'/plans/'+plan.slug+'.md '+plan.specHash}}; for(const h of handlers.get('tool_call')) await h(momusCall);
      const momusOutput=path.join(root,momusCall.input.output); await mkdir(path.dirname(momusOutput),{recursive:true}); await writeFile(momusOutput,JSON.stringify({planPath:managed+'/plans/'+plan.slug+'.md',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]}));
      const momusArchive=path.join(root,'momus-archive.json'); await writeFile(momusArchive,JSON.stringify({entries:[{source:'output-artifact',path:momusOutput,agent:'momus'}]})); for(const h of handlers.get('tool_result')) await h({toolName:'subagent_wait',input:{},details:{completions:[{runId:'momus-run',agent:'momus',success:true,archivePath:momusArchive}]}});
      plan=await core.readPlan(root,plan.slug); await commands.get('start-work').handler(plan.slug,ctx); let runtime=await core.readRuntime(root); const lease=runtime.state.lease;
      const workerCall={toolName:'subagent',input:{agent:'worker',task:lease.id+' '+plan.specHash}}; for(const h of handlers.get('tool_call')) await h(workerCall); for(const h of handlers.get('tool_result')) await h({toolName:'subagent',input:workerCall.input,details:{runId:'worker-run'}});
      const workerOutput=path.join(root,workerCall.input.output); await mkdir(path.dirname(workerOutput),{recursive:true}); await writeFile(workerOutput,JSON.stringify({leaseId:lease.id,planHash:plan.specHash,taskIds:lease.taskIds,status:'implemented',summary:'done',changedPaths:[],semanticDelta:{accomplished:['done'],architectureChanges:[],decisions:[],invalidatedAssumptions:[],planDeviations:[],newRisks:[],userDecisionNeeded:[]}}));
      const workerArchive=path.join(root,'worker-archive.json'); await writeFile(workerArchive,JSON.stringify({entries:[{source:'output-artifact',path:workerOutput,agent:'worker'}]})); for(const h of handlers.get('tool_result')) await h({toolName:'subagent_wait',input:{},details:{completions:[{runId:'worker-run',agent:'worker',success:true,archivePath:workerArchive}]}});
      runtime=await core.readRuntime(root); console.log(JSON.stringify({verdict:plan.momus.verdict,stage:runtime.state.stage,workerRunId:runtime.state.workerRunId}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0); expect(JSON.parse(stdout)).toEqual({verdict:"approved",stage:"verify",workerRunId:"worker-run"});
  });

  test("records paused worker decisions by stable workflow ID", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const {default:extension}=await import('${extensionPath}'); const core=await import('./home/pi/files/plan-execute/core.ts');
      const tools=new Map(),commands=new Map(),handlers=new Map(); let active=['read'];
      const pi={registerTool(d){tools.set(d.name,d)},registerCommand(n,d){commands.set(n,d)},on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)},getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){}}; extension(pi);
      const root=await mkdtemp(path.join(os.tmpdir(),'plan-decision-'));
      let brief=core.createPlanningBrief({request:'decide',requirements:['Choose'],proposedApproach:'Implement'}); brief=core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]});
      let plan=core.createPlan({title:'Decision',goal:'Choose',tasks:[{title:'Task',outcome:'Done',satisfies:['R1'],expectedPaths:['src'],acceptance:['Done'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},brief); plan=core.applyMomusReview(plan,{planPath:'plan',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]});
      const lease=core.createLease(plan,{}); plan=core.recordSemanticDelta(plan,lease.id,{accomplished:[],architectureChanges:[],decisions:[],invalidatedAssumptions:[],planDeviations:[],newRisks:[],userDecisionNeeded:['Which format?']});
      await core.writeRuntime(root,plan,{version:2,planSlug:plan.slug,planHash:plan.specHash,status:'paused',stage:'dispatch',lease,receipts:[],updatedAt:new Date().toISOString()});
      const ctx={cwd:root,mode:'rpc',hasUI:false,ui:{notify(){}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      const before=(await tools.get('workflow_status').execute('1',{},undefined,undefined,ctx)).details; const id=before.pendingDecisions[0].id;
      await tools.get('work_decide').execute('2',{decisionId:id,decision:'JSON',rationale:'Machine-readable'},undefined,undefined,ctx);
      const after=(await tools.get('workflow_status').execute('3',{},undefined,undefined,ctx)).details;
      console.log(JSON.stringify({id,before:before.nextAction,pending:after.pendingDecisions.length}));
    `;
    const child=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0); expect(JSON.parse(stdout)).toMatchObject({before:expect.stringContaining("work_decide Q-"),pending:0});
  });

  test("refuses to overwrite an already-active lease for the same plan", async () => {
    const script = `
      import { mkdtemp } from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const { default: extension } = await import('${extensionPath}');
      const core = await import('./home/pi/files/plan-execute/core.ts');
      const tools = new Map(), commands = new Map(), handlers = new Map(); let active = ['read','bash','edit','write','subagent']; const notices = [];
      const pi = { registerTool(d){tools.set(d.name,d)}, registerCommand(n,d){commands.set(n,d)}, on(n,f){const a=handlers.get(n)??[];a.push(f);handlers.set(n,a)}, getActiveTools(){return active},setActiveTools(n){active=n},getAllTools(){return []},appendEntry(){},sendUserMessage(){},exec:async()=>({code:0,stdout:'',stderr:''}) };
      extension(pi);
      const root = await mkdtemp(path.join(os.tmpdir(),'plan-active-'));
      let brief = core.createPlanningBrief({ request:'active plan', requirements:['Do work'], proposedApproach:'Implement' });
      brief = core.applyMetisReview(brief,{briefPath:'brief',briefHash:brief.briefHash,readiness:'ready',blockingGaps:[],nonBlockingRisks:[],directives:[]});
      await core.writeBrief(root, brief);
      let plan = core.createPlan({ title:'Active',goal:'Work',tasks:[{title:'Task',outcome:'Done',satisfies:['R1'],expectedPaths:['src'],acceptance:['Done'],workerChecks:[{id:'test',program:'bun',args:['test']}]}],finalChecks:[{id:'final',program:'bun',args:['test']}]},brief);
      plan = core.applyMomusReview(plan,{planPath:'plan',planHash:plan.specHash,verdict:'approved',blockingFindings:[],nonBlockingNotes:[]});
      await core.writePlan(root,plan);
      const lease=core.createLease(plan,{});
      await core.writeWorkState(root,{version:2,planSlug:plan.slug,planHash:plan.specHash,status:'active',stage:'dispatch',lease,receipts:[],updatedAt:new Date().toISOString()});
      const ctx={cwd:root,mode:'rpc',hasUI:false,waitForIdle:async()=>{},ui:{notify:(m)=>notices.push(m)},sessionManager:{getBranch:()=>[],getSessionId:()=> 'test'}};
      await commands.get('start-work').handler(plan.slug,ctx);
      const after=await core.readWorkState(root);
      console.log(JSON.stringify({same:after.lease.id===lease.id,notice:notices.at(-1)}));
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ same: true });
    expect(JSON.parse(stdout).notice).toContain("already active");
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
