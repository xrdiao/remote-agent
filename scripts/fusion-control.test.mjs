import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { applyFusionControl, fusionTaskPrompt, fusionTaskInput } from '../server/fusion/control.mjs';
import { fixture } from './fusion-fixture.mjs';
import { FusionControlError, FUSION_TOOLS, ACTION_FIELDS } from '../server/fusion/contract.mjs';
import { recordFusionReceipt } from '../server/fusion/state.mjs';

function readText(h, selector, length = 4096) {
  const query = JSON.parse(selector.input); let text = '', offset = 0;
  do { const page = h.apply({ ...selector, input: JSON.stringify({ ...query, offset, length }) }); text += page.text; offset = page.nextOffset; } while (offset !== null);
  return text;
}
function childContextFixture() {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const binding = { id: 'child-binding', app: 'codex', role: 'worker', threadId: 'native-child', project: h.project };
  h.run.bindings.push(binding); h.run.agents[0].bindingId = binding.id;
  const attempt = h.run.attempts[0]; attempt.bindingId = binding.id;
  const first = fusionTaskInput(h.run, h.run.tasks[0], attempt);
  Object.assign(attempt, { prompt: first.prompt, promptContext: first.context, submission: 'accepted', acceptedAt: 10,
    endedAt: 20, status: 'accepted', native: { threadId: binding.threadId, turnId: 'first-turn' } });
  h.run.tasks[0].status = 'accepted';
  return { ...h, workId, binding, first };
}

test('the eleven captured parameter failures identify their fields, preserve facts and lead to actual review and finish templates', () => {
  const h=fixture(),workId=h.create();h.plan(workId);const fields=[];
  const rejected=(action,field)=>{
    const before=structuredClone(h.run);
    assert.throws(()=>h.apply(action),error=>{
      assert(error instanceof FusionControlError);assert.equal(error.feedback.field,field);assert(error.feedback.expected);assert(error.feedback.read?.action);
      fields.push(field);return true;
    });
    assert.deepEqual(h.run,before);
  };
  for(const snapshot of h.run.capabilities)rejected({action:'list_models',app:'all',input:JSON.stringify({snapshotIds:[snapshot.id],limit:1000})},'input.limit');
  rejected({action:'read_workspace',input:'{"view":"workers"}'},'input.view');
  rejected({action:'read_workspace',input:'{"view":"worker"}'},'input.id');
  rejected({action:'read_workspace',input:'{"view":"agents"}'},'input.view');
  rejected({action:'plan',workId,summary:'Compute without writing',scope:[],criteria:[{id:'C1',text:'Evidence available'}],requiresConfirmation:false},'scope');
  h.apply({action:'dispatch',workId,tasks:[{...h.task('sum42'),acceptance:['返回42']}]});
  const attempt=h.run.attempts[0];Object.assign(attempt,{status:'awaiting_review',endedAt:20,result:{text:'17 + 25 = 42',completed:true}});
  const detail=h.apply({action:'read_task',taskId:'sum42',attemptId:attempt.id}),review=detail.review;
  assert.equal(review.verdict,'');assert.equal(review.evidence[0].detail,'');assert.equal(review.evidence[0].reference,'');
  rejected({...review,verdict:'accept',reason:'checked',summary:'42',evidence:[{criterion:'返回42',detail:'actual result is 42',reference:attempt.id}]},'evidence[].criterion');
  const accepted=h.apply({...review,verdict:'accept',reason:'Read the actual original result',summary:'42 verified',evidence:review.evidence.map(e=>({...e,detail:'17+25=42',reference:'result.text'}))});
  const work=h.apply(accepted.work.read),finish=work.finish;
  assert.equal(finish.evidence[0].criterion,'C1');assert.equal(finish.evidence[0].attemptId,'');assert.equal(work.sources.items[0].attemptId,attempt.id);
  for(let i=0;i<2;i++)rejected({...finish,summary:'done',evidence:[{criterion:'C1',detail:'actual 42 accepted',reference:attempt.id}]},'evidence[0].attemptId');
  rejected({...finish,summary:'done',evidence:[{criterion:'Evidence available',detail:'actual 42 accepted',reference:attempt.id}]},'evidence[].criterion');
  assert.equal(fields.length,11);
  h.apply({...finish,summary:'All conditions verified',evidence:finish.evidence.map(e=>({...e,attemptId:work.sources.items[0].attemptId,detail:'Actual native result is 42',reference:'result.text'}))});
  assert.equal(h.run.works[0].status,'closing');assert.equal(h.run.tasks[0].reviews.length,1);assert.equal(h.run.attempts.length,1);
});

test('multi-criterion finish templates keep sources explicit and reject evidence from a different work item', () => {
  const h=fixture(),workId=h.create();
  h.apply({action:'plan',workId,summary:'Two independent facts',scope:['.'],criteria:[{id:'first',text:'First fact'},{id:'second',text:'Second fact'}],requiresConfirmation:false});
  h.apply({action:'dispatch',workId,tasks:[h.task('A'),h.task('B')]});
  for(const id of ['A','B']){
    const attempt=h.run.attempts.find(a=>a.taskId===id);Object.assign(attempt,{status:'awaiting_review',endedAt:20,result:{text:id,completed:true}});
    const template=h.apply({action:'read_task',taskId:id,attemptId:attempt.id}).review;
    h.apply({...template,verdict:'accept',reason:'Checked '+id,summary:'Verified '+id,evidence:template.evidence.map(e=>({...e,detail:'Native result '+id,reference:'result.text'}))});
  }
  const other=h.create();h.plan(other);h.apply({action:'dispatch',workId:other,tasks:[h.task('foreign')]});
  const foreign=h.run.attempts.at(-1);Object.assign(foreign,{status:'accepted',endedAt:30,result:{completed:true,text:'foreign'}});
  const work=h.apply({action:'read_workspace',workId});
  assert.deepEqual(work.finish.evidence.map(e=>e.criterion),['first','second']);assert(work.finish.evidence.every(e=>e.attemptId===''&&e.detail===''&&e.reference===''));
  assert.equal(work.sources.total,2);assert(work.sources.items.every(s=>s.attemptId!==foreign.id));
  const evidence=work.finish.evidence.map((e,index)=>({...e,detail:'Verified '+index,reference:'result.text',attemptId:work.sources.items[index].attemptId}));
  const before=structuredClone(h.run);
  assert.throws(()=>h.apply({...work.finish,summary:'done',evidence:evidence.map(e=>({...e,attemptId:foreign.id}))}),e=>e instanceof FusionControlError&&e.feedback.field==='evidence[0].attemptId');
  assert.deepEqual(h.run,before);h.apply({...work.finish,summary:'Two facts verified',evidence});assert.equal(h.run.works[0].candidate.evidence[1].attemptId,evidence[1].attemptId);
});

test('work evidence sources page all ended attempts without adding full templates to default workspace memory', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:Array.from({length:7},(_,i)=>h.task('S'+i))});
  for(const attempt of h.run.attempts)Object.assign(attempt,{status:'accepted',endedAt:20,result:{text:'original',completed:true}});
  const overview=h.apply({action:'read_workspace'});assert.equal('finish' in overview,false);assert.equal('sources' in overview,false);
  const detail=h.apply(overview.works[0].read);assert.equal(detail.sources.total,7);assert.equal(detail.sources.items.length,4);
  const sources=JSON.parse(readText(h,detail.sources.read,83));assert.equal(sources.length,7);assert.deepEqual(sources.map(s=>s.attemptId),h.run.attempts.map(a=>a.id));
  assert(sources.every(s=>s.read.action==='read_task'));assert(FUSION_TOOLS[0].inputSchema.properties.input.type==='string');assert.deepEqual(FUSION_TOOLS[0].inputSchema.required,['action']);
  assert.deepEqual(overview.protocol.required,ACTION_FIELDS);
});

test('work reads use the existing top-level workId without nested selector JSON and reject the old selector explicitly', () => {
  const h=fixture(),created=h.apply({action:'create_work',title:'One work',goal:'Read its actual criteria'}),workId=created.workId;h.plan(workId);
  const selector={action:'read_workspace',workId};assert.deepEqual(created.read,selector);
  const overview=h.apply({action:'read_workspace'}),before=structuredClone(h.run);
  assert.deepEqual(overview.works[0].read,selector);assert.deepEqual(h.apply(selector).works[0].plan.criteria,[{id:'C1',text:'Evidence available'}]);
  for(const [action,field,read] of [
    [{action:'read_workspace',input:JSON.stringify({view:'work',id:workId})},'workId',selector],
    [{...selector,input:'not-json'},'input',selector],
    [{...selector,input:JSON.stringify({view:'worker',id:'other'})},'input',selector],
    [{action:'read_workspace',workId:''},'workId',{action:'read_workspace'}],
  ])assert.throws(()=>h.apply(action),error=>{
    assert(error instanceof FusionControlError);assert.equal(error.feedback.field,field);assert.deepEqual(error.feedback.read,read);return true;
  });
  assert.deepEqual(h.run,before);
  const plans=h.apply(selector).works[0].readPlans;assert.deepEqual(plans,{...selector,input:'{"section":"plans"}'});
  assert.deepEqual(JSON.parse(readText(h,plans,31)),h.run.works[0].plans);
});

test('new workers require a real same-project comparison and choices retain only actually delivered directory receipts', () => {
  const h=fixture(),workId=h.create();h.plan(workId);
  const worker=h.apply({action:'dispatch',workId,tasks:[h.task('original')]}).tasks[0].workerId;
  const action={action:'dispatch',workId,tasks:[h.task('related')],input:JSON.stringify({related:{workerId:null,label:'独立复核',reason:'Independent review',compared:[]}})};
  let before=structuredClone(h.run);
  assert.throws(()=>applyFusionControl(h.run,action,h.native()),e=>e instanceof FusionControlError&&e.feedback.field==='input.related.compared');
  assert.deepEqual(h.run,before);
  delete h.run.bindings[0].workerReads;
  action.input=JSON.stringify({related:{workerId:worker,label:'已有职责',reason:'Use existing project evidence',compared:[]}});
  before=structuredClone(h.run);
  assert.throws(()=>applyFusionControl(h.run,action,h.native()),e=>e instanceof FusionControlError&&e.feedback.read.input.includes(worker));
  const view=h.apply({action:'read_workspace',input:JSON.stringify({view:'worker',id:worker})}),native=h.native();
  recordFusionReceipt(h.run,{...native,threadId:'unrelated'},view);assert.deepEqual(h.run,before);
  recordFusionReceipt(h.run,native,view);
  const expected=structuredClone(h.run.bindings[0].workerReads[0]);
  applyFusionControl(h.run,action,h.native());const choice=h.run.assignments.at(-1).workerSelection;
  assert.deepEqual(choice.basis,[expected]);assert.equal(h.run.agents.length,1);
  assert.equal(choice.basis[0].requestId,native.requestId);assert.equal(h.run.tasks.at(-1).workerId,worker);
});

test('worker directory memory is a bounded preview of actual accepted evidence and preserves its full original summary', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});
  const attempt=h.run.attempts[0],summary='已核对原数据和计算，保留真实成果。'.repeat(200);
  Object.assign(attempt,{status:'awaiting_review',endedAt:20,result:{completed:true,text:'42'}});
  h.apply({action:'review',taskId:'A',attemptId:attempt.id,verdict:'accept',reason:'Checked original',summary,evidence:[{criterion:'A:1',detail:'42 verified',reference:'result.text'}]});
  const before=structuredClone(h.run),view=h.apply({action:'read_workspace'}),memory=view.agents[0].memory;
  assert.equal(memory.summary,summary.slice(0,120));assert.equal(memory.characters,summary.length);assert.equal(memory.read.attemptId,attempt.id);
  const detail=h.apply(memory.read);assert.equal(JSON.parse(readText(h,detail.read.reviews))[0].summary,summary);assert.deepEqual(h.run,before);
});

test('failed results wait for an explicit disposition and result-specific questions do not pretend the execution passed', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});
  const attempt=h.run.attempts[0];Object.assign(attempt,{status:'failed',endedAt:Date.now(),result:{completed:false,error:'Original native failure',text:''}});h.run.tasks[0].status='failed';
  let pending=h.apply({action:'read_workspace'}).pendingReviews;assert.equal(pending.items[0].outcome,'failed');
  assert.equal(h.apply(pending.items[0].read).review,undefined);assert.throws(()=>h.apply({action:'wait'}),/失败需明确/);
  const asked=h.apply({action:'ask_user',workId,attemptId:attempt.id,question:'Which missing input should be used?'});
  pending=h.apply({action:'read_workspace'}).pendingReviews;assert.deepEqual(pending.items[0].waitingFor.questions,[asked.questionId]);
  assert.equal(h.run.questions[0].taskId,'A');assert.equal(h.run.questions[0].attemptId,attempt.id);h.apply({action:'wait'});
  assert.equal(attempt.status,'failed');assert.equal(attempt.result.completed,false);
  h.run.questions[0].answeredAt=Date.now();h.apply({action:'continue_task',taskId:'A',input:'Use clarified input',cost:h.cost('codex')});
  assert.equal(h.apply({action:'read_workspace'}).pendingReviews.total,0);assert.equal(h.run.attempts[0].status,'failed');assert.equal(h.run.attempts.length,2);
});

test('delivered result notifications remain pending review even when a later task state would hide the attempt', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});
  const attempt=h.run.attempts[0];Object.assign(attempt,{status:'awaiting_review',endedAt:20,result:{text:'full output '.repeat(10000),completed:true}});
  h.run.tasks[0].status='accepted';h.run.events.push({id:'result:'+attempt.id,type:'task_result',data:{workId,taskId:'A',attemptId:attempt.id},deliveredTo:'previous-turn'});
  const view=h.apply({action:'read_workspace'});assert.equal(view.events.length,0);assert.equal(view.pendingReviews.total,1);
  assert.equal(view.pendingReviews.items[0].attemptId,attempt.id);assert(!JSON.stringify(view.pendingReviews).includes('full output'));
  const refs=JSON.parse(readText(h,view.pendingReviews.read));assert.equal(refs[0].attemptId,attempt.id);
  assert.throws(()=>h.apply({action:'wait'}),/已读不等于已验收/);
  assert.throws(()=>h.apply({action:'continue_task',taskId:'A',input:'more',cost:h.cost('codex')}),/尚未验收/);
  assert.throws(()=>h.apply({action:'finish',workId,summary:'done',evidence:[]}),/未验收/);
  h.apply({action:'review',taskId:'A',attemptId:attempt.id,verdict:'accept',reason:'Checked the original output',evidence:[{criterion:'A:1',detail:'Verified actual output',reference:'native'}]});
  assert.equal(h.apply({action:'read_workspace'}).pendingReviews.total,0);
});
test('reviewing an older attempt never accepts or overwrites a newer running execution', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});
  const first=h.run.attempts[0];Object.assign(first,{status:'awaiting_review',endedAt:20,result:{text:'old result',completed:true}});
  const newer={...structuredClone(first),id:'newer-attempt',status:'running',endedAt:null,result:null};h.run.attempts.push(newer);
  h.run.tasks[0].attemptIds.push(newer.id);h.run.tasks[0].status='running';
  h.apply({action:'review',taskId:'A',attemptId:first.id,verdict:'accept',reason:'Only the old result was checked',evidence:[{criterion:'A:1',detail:'Verified old result',reference:'old-native'}]});
  assert.equal(h.run.attempts[0].status,'accepted');assert.equal(h.run.attempts[1].status,'running');assert.equal(h.run.tasks[0].status,'running');
  assert.equal(h.run.tasks[0].reviews[0].attemptId,first.id);assert.equal(h.run.attempts.length,2);
  Object.assign(h.run.attempts[1],{status:'awaiting_review',endedAt:30,result:{completed:true,text:'new result'}});
  h.apply({action:'review',taskId:'A',attemptId:newer.id,verdict:'accept',reason:'Newest evidence checked',summary:'Current verified result',evidence:[{criterion:'A:1',detail:'New output',reference:'new-native'}]});
  const legacy={...structuredClone(h.run.attempts[0]),id:'legacy-result',status:'awaiting_review',endedAt:10};
  h.run.attempts.unshift(legacy);h.run.tasks[0].attemptIds.unshift(legacy.id);
  h.apply({action:'review',taskId:'A',attemptId:legacy.id,verdict:'accept',reason:'Older evidence checked later',summary:'Historical result',evidence:[{criterion:'A:1',detail:'Old output',reference:'old-native'}]});
  const detail=h.apply({action:'read_task',taskId:'A'});assert.equal(detail.task.memory.attemptId,newer.id);assert.equal(detail.task.memory.summary,'Current verified result');
});
test('large review queues keep a bounded summary and page every pending attempt without reading native content', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:Array.from({length:12},(_,i)=>h.task('A'+i))});
  for(const attempt of h.run.attempts)Object.assign(attempt,{status:'awaiting_review',endedAt:20});
  const view=h.apply({action:'read_workspace'});assert.equal(view.pendingReviews.total,12);assert.equal(view.pendingReviews.items.length,4);
  assert.equal(JSON.parse(readText(h,view.pendingReviews.read,73)).length,12);
});

test('work memory preserves current constraints and unresolved execution while accepted process stays behind evidence reads', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('verified'), h.task('unknown')] });
  const [task] = h.run.tasks, attempt = h.run.attempts[0], original = 'complete original result '.repeat(10000);
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: original, completed: true } });
  h.apply({ action: 'review', taskId: task.id, attemptId: attempt.id, verdict: 'accept', reason: 'Full verification detail '.repeat(1000),
    summary: 'Verified the file and calculation; no remaining issue in this task.',
    evidence: [{ criterion: task.acceptance[0].id, detail: 'Actual native output', reference: 'native-output' }] });
  h.run.attempts[1].status = 'unknown';
  const constraint = '用户明确暂停训练，不授权启动任何训练作业。';
  h.apply({ action: 'plan', workId, scope: ['.'], summary: constraint, criteria: [{ id: 'C1', text: 'Keep evidence without training' }], requiresConfirmation: true });
  h.apply({ action: 'ask_user', workId, question: '继续前需确认新的范围。', options: ['确认', '修改'] });
  h.run.stopRequested = true;
  const before = structuredClone(h.run), view = h.apply({ action: 'read_workspace' });
  assert.equal(view.stopRequested, true); assert.equal(view.works[0].plan.summary, constraint);
  assert.equal(view.works[0].plan.confirmed, false); assert.deepEqual(view.works[0].plan.scope, ['.']);
  assert.equal(view.questions[0].text, '继续前需确认新的范围。');
  assert.equal(view.tasks.some(row => row.id === 'verified'), false); assert.equal(view.tasks.find(row => row.id === 'unknown').status, 'queued');
  assert.equal(view.agents[1].status, 'unknown'); assert.equal(view.works[0].memory.summary, 'Verified the file and calculation; no remaining issue in this task.');
  assert(!JSON.stringify(view).includes(original)); assert.equal('workers' in view.protocol, false);
  const work = h.apply(view.works[0].read);
  assert.equal(work.memory[0].taskId, 'verified'); assert.equal(work.memory[0].attemptId, attempt.id);
  const detail = h.apply(work.memory[0].read);
  assert.equal(readText(h, detail.attempts[0].result.text.read), original);
  assert.deepEqual(JSON.parse(readText(h, detail.read.reviews)), h.run.tasks[0].reviews);
  assert.deepEqual(h.run, before);
});
test('completed work keeps its delivery memory and paged original plans without returning old process by default', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const work = h.run.works[0]; work.status = 'completed';
  work.plans.push({ id: 'old-plan', summary: 'long historical plan '.repeat(1000), scope: ['.'], criteria: [{ id: 'old', text: 'Original criteria' }] });
  work.deliveries.push({ summary: 'All requested checks passed; the preserved artifact is evidence.txt.', evidence: [{ reference: 'evidence.txt' }] });
  const before = structuredClone(h.run), overview = h.apply({ action: 'read_workspace' });
  assert.equal('plan' in overview.works[0], false); assert.equal('goal' in overview.works[0], false);
  assert.equal(overview.works[0].memory.summary, work.deliveries[0].summary);
  const selected = h.apply(overview.works[0].read);
  assert.deepEqual(selected.works[0].plan, work.plans[0]);
  assert.deepEqual(JSON.parse(readText(h, selected.works[0].readPlans, 251)), work.plans);
  assert.deepEqual(JSON.parse(readText(h, selected.works[0].readDeliveries, 31)), work.deliveries);
  const history = JSON.parse(readText(h, { action: 'read_workspace', input: JSON.stringify({ view: 'history' }) }, 37));
  assert.equal(history[0].id, workId); assert.equal(history[0].summary, work.deliveries[0].summary);
  const protocol = h.apply(overview.protocol.read); assert.equal(protocol.protocol.required.review.includes('summary'), true);
  assert.deepEqual(h.run, before);
});
test('semantic review memory is required without replacing detailed evidence or creating another execution', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'awaiting_review', endedAt: 20 });
  const action = { action: 'review', taskId: 'A', attemptId: attempt.id, verdict: 'rework', reason: 'Precise issue and original evidence retained' };
  assert.throws(() => applyFusionControl(h.run, action, h.native()), /summary/);
  h.apply({ ...action, summary: 'Validation found one issue; fix the specified condition.' });
  assert.equal(h.run.tasks[0].reviews[0].reason, action.reason);
  assert.equal(h.run.tasks[0].reviews[0].summary, 'Validation found one issue; fix the specified condition.');
  assert.equal(h.run.attempts.length, 1); assert.equal(h.run.effects.length, 1);
});
test('a received child task continues with only changes and links the actual accepted prior attempt', () => {
  const h = childContextFixture();
  assert.equal(h.first.context.mode, 'full');
  h.apply({ action: 'continue_task', taskId: 'A', input: 'Check the second number and report the sum.', cost: h.cost('codex') });
  const attempt = h.run.attempts.at(-1); attempt.bindingId = h.binding.id;
  const before = structuredClone(h.run), next = fusionTaskInput(h.run, h.run.tasks[0], attempt), data = JSON.parse(next.prompt.slice(next.prompt.indexOf('{')));
  assert.equal(next.context.mode, 'delta'); assert.equal(data.basedOn, h.run.attempts[0].id);
  assert.equal(data.input, 'Check the second number and report the sum.'); assert.equal(data.taskId, 'A');
  for (const key of ['goal', 'scope', 'acceptance', 'project', 'review', 'dependencies']) assert.equal(key in data, false);
  assert(next.prompt.length < h.first.prompt.length / 2); assert.deepEqual(h.run, before);
});
test('related new tasks retain the session rules while sending complete new scope and acceptance', () => {
  const h = childContextFixture(), spec = { ...h.task('B'), goal: 'Independently review the new file', access: 'write', scope: ['new-file'], acceptance: ['New output verified'] };
  h.apply({ action: 'dispatch', workId: h.workId, tasks: [spec], input: JSON.stringify({ B: { workerId: h.run.agents[0].id,
    label: '相关文件复核', reason: 'Reuse known project context', compared: [] } }) });
  const attempt = h.run.attempts.at(-1); attempt.bindingId = h.binding.id;
  const next = fusionTaskInput(h.run, h.run.tasks[1], attempt), data = JSON.parse(next.prompt.slice(next.prompt.indexOf('{')));
  assert.equal(next.context.mode, 'task'); assert.equal(data.goal, spec.goal); assert.equal(data.access, 'write');
  assert.deepEqual(data.scope, ['new-file']); assert.deepEqual(data.acceptance, h.run.tasks[1].acceptance);
  assert.equal(next.prompt.includes('不创建 worktree'), false); assert.equal(h.run.agents.length, 1);
});
test('legacy, rejected and different-thread child inputs establish a full context instead of assuming delivery', () => {
  for (const kind of ['legacy', 'rejected', 'different-thread', 'new-policy']) {
    const h = childContextFixture(), previous = h.run.attempts[0];
    if (kind === 'legacy') delete previous.promptContext;
    if (kind === 'rejected') { previous.submission = 'submitting'; previous.acceptedAt = null; }
    if (kind === 'different-thread') previous.native.threadId = 'foreign-thread';
    if (kind === 'new-policy') previous.promptContext.policy = 'old-policy';
    h.apply({ action: 'continue_task', taskId: 'A', input: 'Confirm the next value.', cost: h.cost('codex') });
    const attempt = h.run.attempts.at(-1); attempt.bindingId = h.binding.id;
    const next = fusionTaskInput(h.run, h.run.tasks[0], attempt), data = JSON.parse(next.prompt.slice(next.prompt.indexOf('{')));
    assert.equal(next.context.mode, 'full', kind); assert.equal('basedOn' in data, false);
    assert.equal(data.goal, h.run.tasks[0].goal); assert.deepEqual(data.scope, h.run.tasks[0].scope);
  }
});
test('scope, permissions and review changes are explicit in child continuations', () => {
  const h = childContextFixture();
  h.apply({ action: 'continue_task', taskId: 'A', input: 'Use the newly restricted scope.', cost: h.cost('codex') });
  const task = h.run.tasks[0], attempt = h.run.attempts.at(-1); attempt.bindingId = h.binding.id;
  task.scope = ['narrow-file']; task.access = 'write'; task.acceptance = [{ id: 'A:2', text: 'Verify only the new file' }];
  task.reviews.push({ verdict: 'rework', summary: 'Fix the exact validation failure.', reason: 'Original error details', evidence: [] });
  const next = fusionTaskInput(h.run, task, attempt), data = JSON.parse(next.prompt.slice(next.prompt.indexOf('{')));
  assert.equal(next.context.mode, 'delta'); assert.deepEqual(data.scope, ['narrow-file']); assert.equal(data.access, 'write');
  assert.deepEqual(data.acceptance, task.acceptance); assert.equal(data.review.reason, 'Original error details');
});

test('Fusion refreshes only its idle native thread instructions and keeps ordinary sends and actual model permissions intact', async () => {
  const source=fs.readFileSync(new URL('../server/page/session-actions.js',import.meta.url),'utf8');
  const calls=[],originalToolCalls=[],settings={model:'native-user-model',effort:'max',cwd:'/actual-project',serviceTier:null};
  const permissions={approvalPolicy:'on-request',approvalsReviewer:'auto_review',activePermissionProfile:{id:':workspace'},runtimeWorkspaceRoots:['/actual-project']};
  let busy=true;const conversation={latestThreadSettings:settings,currentPermissions:permissions};
  const manager={hostId:'local',getConversation:()=>conversation,isConversationStreaming:()=>busy,
    requestClient:{sendRequest(method,params){calls.push({method,params});return Promise.resolve({});}},
    threadExecution:{executeDynamicToolCall(request){originalToolCalls.push(request);}}};
  const context=vm.createContext({window:{},Map,WeakMap,Set,JSON,nativeValue:structuredClone,codexConversationManager:()=>manager,codexHistoryScopes:()=>[],remoteContext:{host:'local'}});
  const start=source.indexOf('  const nativeSessionAction ='),end=source.indexOf('  const nativeSessionRenameInput',start);
  vm.runInContext(fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8') + source.slice(start,end)+';this.act=nativeSessionAction;',context);
  const spec={names:['ra_fusion'],authorization:{kind:'application',value:'current policy'},instructions:'Current Fusion instructions'};
  let result=await context.act('codex','fusion-main','bindTools',spec);assert.equal(result.profileReady,false);assert.equal(calls.length,0);
  const ordinary={threadId:'ordinary',input:[{type:'text',text:'keep my input'}],model:'ordinary-model',effort:'low',additionalContext:{existing:{kind:'application',value:'keep'}}};
  await manager.requestClient.sendRequest('turn/start',ordinary);assert.equal(calls[0].params,ordinary);assert.equal(calls[0].method,'turn/start');
  busy=false;result=await context.act('codex','fusion-main','bindTools',spec);assert.equal(result.profileReady,true);
  const update=calls[1];assert.equal(update.method,'thread/resume');assert.equal(update.params.threadId,'fusion-main');assert.equal(update.params.developerInstructions,spec.instructions);
  assert.equal(update.params.model,settings.model);assert.equal(update.params.config.model_reasoning_effort,'max');assert.equal(update.params.permissions,':workspace');assert.equal(update.params.approvalsReviewer,'auto_review');
  assert.deepEqual(update.params.runtimeWorkspaceRoots,permissions.runtimeWorkspaceRoots);assert.equal('dynamicTools' in update.params,false);assert.equal('input' in update.params,false);
  await context.act('codex','fusion-main','bindTools',spec);assert.equal(calls.length,2);
  const main={...ordinary,threadId:'fusion-main'};await manager.requestClient.sendRequest('turn/start',main);
  assert.equal(calls[2].params.model,main.model);assert.equal(calls[2].params.effort,main.effort);assert.deepEqual(calls[2].params.input,main.input);
  assert.equal(calls[2].params.additionalContext.ra_fusion_user_authorization,spec.authorization);assert.equal(calls[2].params.additionalContext.existing,ordinary.additionalContext.existing);
  manager.threadExecution.executeDynamicToolCall({params:{threadId:'ordinary',tool:'ordinary-tool'}});assert.equal(originalToolCalls.length,1);
  await context.act('codex','fusion-main','unbindTools');await manager.requestClient.sendRequest('turn/start',ordinary);assert.equal(calls.at(-1).params,ordinary);
});

test('a related new task can select a retained Worker without changing earlier task or execution facts', () => {
  const h = fixture(), firstWork = h.create(); h.plan(firstWork);
  const first = h.apply({ action: 'dispatch', workId: firstWork, tasks: [h.task('first')] }).tasks[0];
  const worker = h.run.agents.find(row => row.id === first.workerId), attempt = h.run.attempts[0];
  worker.bindingId = 'retained-binding';
  h.run.bindings.push({ id: worker.bindingId, role: 'worker', app: 'codex', project: h.project, threadId: 'retained-native' });
  Object.assign(attempt, { bindingId: worker.bindingId, status: 'accepted', endedAt: 20, result: { completed: true, text: 'Original evidence' } });
  h.run.tasks[0].status = 'accepted';
  const old = structuredClone({ task: h.run.tasks[0], attempt, assignment: h.run.assignments[0] });
  const secondWork = h.create(); h.plan(secondWork);
  const result = h.apply({ action: 'dispatch', workId: secondWork, tasks: [h.task('related')],
    input: JSON.stringify({ related: { workerId: worker.id, reason: 'Retain the invoice analysis context' } }) }).tasks[0];
  assert.equal(h.run.agents.length, 1); assert.equal(result.workerId, worker.id);
  assert.notEqual(result.attemptId, first.attemptId); assert.equal(h.run.tasks[1].workId, secondWork);
  assert.deepEqual({ task: h.run.tasks[0], attempt: h.run.attempts[0], assignment: h.run.assignments[0] }, old);
  const board = h.apply({ action: 'read_workspace' });
  assert.equal(board.agents[0].taskCount, 2); assert.equal('lastResult' in board.agents[0], false);
  const detail = h.apply(board.agents[0].read).agents[0];
  assert.deepEqual(detail.taskIds, ['first', 'related']); assert.equal(detail.project.id, h.project.id);
  const savedBinding = h.run.agents[0].bindingId;
  h.run.agents[0].bindingId = 'a-later-binding';
  assert.equal(h.apply({ action: 'read_task', taskId: 'first' }).binding.id, savedBinding);
});
test('worker discovery exposes current ownership and bounded past evidence without reading or changing native history', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const first = h.apply({ action: 'dispatch', workId, tasks: [h.task('original')] }).tasks[0];
  const ended = h.run.attempts[0], task = h.run.tasks[0];
  Object.assign(ended, { status: 'accepted', acceptedAt: 10, endedAt: 20,
    result: { completed: true, text: 'Earlier evidence '.repeat(1000) },
    usage: { native: { modelContextWindow: 1000, totalTokenUsage: { totalTokens: 120 } }, observedAt: 20, actualCost: 'unknown' } });
  task.status = 'accepted'; task.reviews.push({ attemptId: ended.id, verdict: 'accept', reason: 'Verified evidence '.repeat(100), at: 30 });
  const input = id => JSON.stringify({ [id]: { workerId: first.workerId, label: '性能采集分析', reason: 'Keep established evidence',
    compared: [{ workerId: first.workerId, reason: 'Same project and responsibility' }] } });
  h.apply({ action: 'dispatch', workId, tasks: [h.task('active')], input: input('active') });
  Object.assign(h.run.attempts[1], { status: 'unknown', acceptedAt: 40 });
  h.apply({ action: 'dispatch', workId, tasks: [h.task('queued')], input: input('queued') });
  const before = structuredClone(h.run), index = h.apply({ action: 'read_workspace' }).agents[0];
  assert.equal('recentTask' in index, false); assert.equal(index.taskCount, 3);
  const worker = h.apply(index.read).agents[0];
  assert.equal(worker.id, first.workerId); assert.equal(worker.label, '性能采集分析');
  assert.equal(worker.status, 'unknown'); assert.equal(worker.currentTaskId, 'active');
  assert.deepEqual(worker.queuedTaskIds, ['queued']); assert.deepEqual(worker.taskIds, ['original', 'active', 'queued']);
  assert.equal(worker.recentTask.id, 'queued'); assert.deepEqual(worker.recentTask.scope, ['.']);
  assert.equal(worker.lastResult.taskId, 'original'); assert.equal(worker.lastResult.attemptId, ended.id);
  assert(worker.lastResult.result.text.preview.length < ended.result.text.length);
  assert.equal(worker.lastResult.result.text.characters, ended.result.text.length);
  assert.deepEqual(worker.lastResult.usage, ended.usage); assert.equal(worker.lastReview.taskId, 'original');
  assert(worker.lastReview.reason.length < task.reviews[0].reason.length);
  assert(worker.lastActiveAt >= 40); assert.deepEqual(h.run, before);
  const read = worker.lastResult.result.text.read;
  assert.equal(h.apply({ ...read, input: JSON.stringify({ section: 'result', offset: 600 }) }).offset, 600);
  assert.equal(JSON.parse(readText(h, h.apply(worker.lastReview.read).read.reviews))[0].reason, task.reviews[0].reason);
});
test('new related tasks reuse the chosen worker and independent tasks record why a new worker was selected', () => {
  const h = fixture(), firstWork = h.create(); h.plan(firstWork);
  const first = h.apply({ action: 'dispatch', workId: firstWork, tasks: [h.task('first')] }).tasks[0];
  const original = structuredClone({ task: h.run.tasks[0], assignment: h.run.assignments[0], attempt: h.run.attempts[0] });
  const workId = h.create(); h.plan(workId);
  const reuse = { workerId: first.workerId, label: '采集性能分析', reason: 'Reuse the existing collection analysis',
    compared: [{ workerId: first.workerId, reason: 'Owns the relevant project evidence and context' }] };
  h.apply({ action: 'dispatch', workId, tasks: [h.task('related')], input: JSON.stringify({ related: reuse }) });
  const create = { workerId: null, label: '文档独立复核', reason: 'A separate documentation review needs an independent context',
    compared: [{ workerId: first.workerId, reason: 'Collection analysis responsibility differs from document review' }] };
  h.apply({ action: 'dispatch', workId, tasks: [h.task('independent')], input: JSON.stringify({ independent: create }) });
  assert.equal(h.run.agents.length, 2); assert.equal(h.run.tasks[1].workerId, first.workerId);
  assert.notEqual(h.run.tasks[2].workerId, first.workerId);
  for (const [assignment, expected] of [[h.run.assignments[1], reuse], [h.run.assignments[2], create]]) {
    const { basis, ...choice } = assignment.workerSelection; assert.deepEqual(choice, expected);
    assert.equal(basis[0].id, first.workerId); assert.equal(basis[0].threadId, 'main-thread'); assert(basis[0].fingerprint);
  }
  assert.deepEqual({ task: h.run.tasks[0], assignment: h.run.assignments[0], attempt: h.run.attempts[0] }, original);
});
test('worker choices require attributable comparisons and a responsibility short name before creating any task', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const first = h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] }).tasks[0], before = structuredClone(h.run);
  const apply = choice => applyFusionControl(h.run, { action: 'dispatch', workId, tasks: [h.task('B')], input: JSON.stringify({ B: choice }) }, h.native());
  const choice = { workerId: null, label: 'Independent review', reason: 'Different responsibility' };
  assert.throws(() => apply(choice), /compared/);
  assert.throws(() => apply({ ...choice, compared: [{ workerId: 'missing', reason: 'Unrelated' }] }), /比较的 Worker 不存在/);
  assert.throws(() => apply({ ...choice, compared: [{ workerId: first.workerId, reason: '' }] }), /比较理由/);
  assert.throws(() => apply({ ...choice, label: 'A complete task description '.repeat(4), compared: [] }), /职责短名/);
  assert.throws(() => apply({ ...choice, label: 'Analysis\nReview', compared: [] }), /单行/);
  assert.deepEqual(h.run, before);
});
test('a legacy worker keeps its native identity and old facts while a normal follow-up updates its responsibility name', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const first = h.apply({ action: 'dispatch', workId, tasks: [h.task('legacy')] }).tasks[0];
  const worker = h.run.agents[0]; worker.label = 'An old complete task description that predates responsibility short names'; worker.bindingId = 'old-binding';
  h.run.bindings.push({ id: 'old-binding', role: 'worker', app: 'codex', threadId: 'old-native-thread', project: h.project });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'accepted', endedAt: 10, bindingId: worker.bindingId });
  h.run.tasks[0].status = 'accepted'; delete h.run.assignments[0].workerSelection;
  const before = structuredClone({ assignment: h.run.assignments[0], attempt, binding: h.run.bindings[1] });
  assert.equal(h.apply({ action: 'read_workspace' }).agents[0].label, worker.label);
  assert.equal(h.run.attempts.length, 1);
  h.apply({ action: 'continue_task', taskId: 'legacy', title: '采集性能复核', input: 'Verify the updated measurements', cost: h.cost('codex') });
  assert.equal(h.run.tasks.length, 1); assert.equal(h.run.agents.length, 1);
  assert.equal(h.run.agents[0].id, first.workerId); assert.equal(h.run.agents[0].label, '采集性能复核');
  assert.equal(h.run.agents[0].bindingId, 'old-binding'); assert.equal(h.run.attempts.length, 2);
  assert.deepEqual({ assignment: h.run.assignments[0], attempt: h.run.attempts[0], binding: h.run.bindings[1] }, before);
});
test('dispatch requires an explicit per-task resource choice and rejects unrelated workers atomically', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  assert.throws(() => applyFusionControl(h.run, { action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()), /input/);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const worker = h.run.agents[0], before = JSON.stringify(h.run);
  const select = workerId => JSON.stringify({ B: { workerId, reason: 'A deliberate resource decision' } });
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B')], input: select('missing') }), /不存在/);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B', 'cursor')], input: select(worker.id) }), /同一软件/);
  assert.equal(JSON.stringify(h.run), before);
  const other = h.create(); h.run.works.find(row => row.id === other).project = { ...h.project, id: 'other-host-project', host: 'other-host' }; h.plan(other);
  const beforeOther = JSON.stringify(h.run);
  assert.throws(() => h.apply({ action: 'dispatch', workId: other, tasks: [h.task('B')], input: select(worker.id) }), /实际项目/);
  assert.equal(JSON.stringify(h.run), beforeOther);
});
test('plan reports all missing fields and cannot silently consume a dispatch task list', () => {
  const h = fixture(), workId = h.create();
  assert.throws(() => h.apply({ action: 'plan', workId }), error => ['summary', 'scope', 'criteria', 'requiresConfirmation'].every(field => error.message.includes(field)));
  assert.throws(() => h.apply({ action: 'plan', workId, summary: 'Scope', scope: ['.'], criteria: [{ id: 'C', text: 'Evidence' }],
    requiresConfirmation: false, tasks: [h.task('A')] }), /plan.*dispatch/);
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works[0].plans.length, 0);
});
test('review evidence uses its selected completed Attempt without requiring duplicated nested identity', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { completed: true, text: 'Verified 62.70' } });
  h.apply({ action: 'review', taskId: 'A', attemptId: attempt.id, verdict: 'accept', reason: 'Recomputed from raw input',
    evidence: [{ criterion: 'A:1', detail: 'Independent result is 62.70', reference: 'native result' }] });
  assert.equal(h.run.tasks[0].status, 'accepted');
  assert.equal(h.run.tasks[0].reviews[0].evidence[0].attemptId, attempt.id);
  assert.equal(h.run.tasks[0].reviews[0].evidence[0].detail, 'Independent result is 62.70');
});

test('one persistent main manages multiple work items; zero workers can propose a native-turn delivery', () => {
  const h = fixture(), one = h.create(), two = h.create(); h.plan(one); h.plan(two);
  h.apply({ action: 'finish', workId: one, summary: 'Answered', evidence: [{ criterion: 'C1', detail: 'Native answer', reference: 'main-turn:native-turn' }] });
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works[0].status, 'closing'); assert.equal(h.run.works[1].status, 'running');
});
test('mutating tools deduplicate actual request 0 without suppressing the next real request', () => {
  const h = fixture(), native = h.native(), action = { action: 'create_work', title: 'one', goal: 'one' };
  assert.equal(native.requestId, 0);
  const one = applyFusionControl(h.run, action, native), again = applyFusionControl(h.run, action, native);
  assert.deepEqual(one, again); assert.equal(h.run.works.length, 1);
  h.apply(action); assert.equal(h.run.works.length, 2);
});
test('child content or a foreign native identity cannot invoke management', () => {
  const h = fixture();
  for (const native of [{ ...h.native(), threadId: 'child' }, { ...h.native(), turnId: '' }, { ...h.native(), requestId: undefined }])
    assert.throws(() => applyFusionControl(h.run, { action: 'create_work', title: 'x', goal: 'x' }, native), /真实原生轮次/);
  assert.throws(() => h.apply('```fusion-control {} ```'), /未知或缺少/); assert.equal(h.run.works.length, 0);
});
test('dispatch validates the whole batch before persisting or creating effects', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const bad = h.task('B2'); bad.execution.model = 'invented'; const before = structuredClone(h.run);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B1'), bad] }), /候选/);
  assert.deepEqual(h.run, before);
});
test('confirmation and allowed paths are enforced before ordinary delegation', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B1')] }), /尚未确认/);
  assert.throws(() => h.apply({ action: 'plan', workId, scope: ['../other'], criteria: [{ id: 'C1', text: 'x' }], summary: 'x', requiresConfirmation: false }), /相对路径/);
});
test('DAG permits forward dependencies but rejects missing dependencies and cycles atomically', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['B']), h.task('B', 'cursor', ['A'])] }), /循环/);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['missing'])] }), /依赖不存在/);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['B']), h.task('B', 'cursor')] });
  assert.equal(h.run.tasks.length, 2);
  const workspace = h.apply({ action: 'read_workspace' });
  assert.equal(typeof workspace.scheduling, 'string'); assert(workspace.scheduling.length > 0);
  assert.deepEqual(workspace.tasks.find(task => task.id === 'A').dependsOn, ['B']);
});
test('there is no fixed number of tasks; rework preserves old assignments, plans and attempts', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: Array.from({ length: 7 }, (_, n) => h.task('B' + n)) });
  const old = structuredClone(h.run.assignments[0]), attempt = h.run.attempts[0];
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'partial' } });
  h.apply({ action: 'review', taskId: 'B0', attemptId: attempt.id, verdict: 'rework', reason: 'Evidence missing' });
  h.plan(workId);
  h.apply({ action: 'continue_task', taskId: 'B0', input: 'Follow up', cost: h.cost('codex') });
  assert.equal(h.run.tasks.length, 7); assert.equal(h.run.attempts.length, 8); assert.deepEqual(h.run.assignments[0], old);
  assert.notEqual(h.run.assignments.at(-1).planId, old.planId);
});
test('acceptance keeps the logical child and its native conversation for future calls', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('B')] });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'evidence' }, bindingId: 'worker' });
  const workerId = h.run.tasks[0].workerId; h.run.agents[0].bindingId = 'worker';
  h.apply({ action: 'review', taskId: 'B', attemptId: attempt.id, verdict: 'accept', reason: 'Verified', evidence: [{ criterion: 'B:1', detail: 'output', reference: 'native reply', attemptId: attempt.id }] });
  assert.equal(h.run.effects.some(row => row.kind === 'archive'), false);
  h.apply({ action: 'continue_task', taskId: 'B', input: 'Same task again', cost: h.cost('codex') });
  assert.equal(h.run.tasks[0].workerId, workerId); assert.equal(h.run.agents[0].bindingId, 'worker');
});
test('unknown native results and unaccepted mandatory work prevent delivery or duplicate submission', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('B')] });
  h.run.attempts[0].status = 'unknown';
  assert.throws(() => h.apply({ action: 'continue_task', taskId: 'B', input: 'again', cost: h.cost('codex') }), /结果未知/);
  assert.throws(() => h.apply({ action: 'finish', workId, summary: 'done', evidence: [] }), /必需任务/);
  assert.equal(h.run.attempts.length, 1);
});

test('workspace and task evidence indexes exclude binary patches and long replies without changing stored facts', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('image')] });
  const attempt = h.run.attempts[0];
  const binary = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 500000\n' + 'binary-payload'.repeat(100000) + '\n';
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'reply-text'.repeat(200000), completed: true, error: '' },
    changes: { available: true, diff: binary, files: [{ path: 'image.png', sha256: 'after' }] },
    baseline: { available: true, diff: binary, files: [{ path: 'image.png', sha256: 'before' }] } });
  // Includes a pending event persisted by the previous producer, still backed by the same Attempt.
  h.run.events.push({ id: 'pending-image', type: 'task_result', data: { workId, taskId: 'image', attemptId: attempt.id,
    result: attempt.result, changes: attempt.changes }, deliveredTo: '' });
  const before = structuredClone(h.run);
  const workspace = h.apply({ action: 'read_workspace' }), task = h.apply({ action: 'read_task', taskId: 'image' });
  for (const view of [workspace, task]) {
    const json = JSON.stringify(view);
    assert(json.length < 15000); assert(!json.includes('binary-payload')); assert(!json.includes('GIT binary patch'));
  }
  const event = workspace.events[0];
  assert.equal(event.id, 'pending-image'); assert.equal(event.data.attemptId, attempt.id);
  assert.deepEqual(event.data.evidence.read, { action: 'read_task', taskId: 'image', attemptId: attempt.id });
  assert.equal('changes' in event.data.evidence, false);
  assert.equal(task.attempts[0].result.text.characters, attempt.result.text.length);
  assert.equal(task.attempts[0].changes.diff.files[0].binary, true);
  assert.equal(task.attempts[0].baseline.files[0].sha256, 'before');
  assert.deepEqual(h.run, before); // Reading and summarizing do not acknowledge, accept or replace evidence.
});

test('workspace summaries keep complete pending user input and retrieve full task and model details on demand', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const task = h.run.tasks[0], text = '完整用户补充，不截断。'.repeat(1000);
  task.inputs.push({ id: 'user-supplement', text, deliveredAt: null });
  h.run.events.push({ id: 'user-supplement', type: 'user_input', data: { workId, taskId: task.id, text }, deliveredTo: '' });
  const before = structuredClone(h.run), workspace = h.apply({ action: 'read_workspace' });
  assert.equal(workspace.events[0].data.text, text);
  assert.deepEqual(workspace.tasks[0].pendingInputIds, ['user-supplement']);
  assert.equal('inputs' in workspace.tasks[0], false); assert.equal('reviews' in workspace.tasks[0], false);
  assert.equal('models' in workspace.capabilities[0], false);
  assert.equal(workspace.capabilities[0].modelCount, h.run.capabilities[0].models.length);
  const models = h.apply({ action: 'list_models', app: 'codex' });
  assert.deepEqual(models.snapshotIds, [h.run.capabilities[0].id]);
  const selected = h.apply({ ...models.models[0].read });
  assert.deepEqual(selected.model, h.run.capabilities[0].models[0]);
  const detail = h.apply({ action: 'read_task', taskId: task.id });
  assert.deepEqual(detail.task.scope, task.scope); assert.deepEqual(detail.task.acceptance, task.acceptance);
  assert.equal('inputs' in detail.task, false); assert.equal('reviews' in detail.task, false);
  assert.deepEqual(JSON.parse(readText(h, detail.read.inputs)), task.inputs);
  assert.deepEqual(JSON.parse(readText(h, detail.read.reviews)), task.reviews);
  assert.deepEqual(h.run, before);
});
test('continuing a reviewed task requires an explicit current native model selection and preserves the original worker', () => {
  const h = childContextFixture(), task = h.run.tasks[0], worker = task.workerId, before = structuredClone(h.run);
  const action = { action: 'continue_task', taskId: task.id, input: 'Check only the changed line.', cost: h.cost('codex') };
  assert.throws(() => applyFusionControl(h.run, action, h.native()), /execution/);
  assert.deepEqual(h.run, before);
  h.apply({ ...action, execution: { app: 'codex', model: 'cheap', effort: 'low' } });
  assert.equal(h.run.tasks[0].workerId, worker); assert.equal(h.run.attempts.length, 2);
  assert.equal(h.run.agents[0].bindingId, h.binding.id); assert.equal(h.run.bindings[1].threadId, 'native-child');
  assert.equal(h.run.assignments.at(-1).model, 'cheap'); assert.equal(h.run.assignments.at(-1).input, action.input);
});
test('child requests keep authorized scope, acceptance, exact new input and rework without embedding unrelated plans or dependency replies', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'codex', ['A'])] });
  const [upstream, attempt] = h.run.attempts, task = h.run.tasks[1], assignment = h.run.assignments[1];
  upstream.result = { text: 'large-upstream-report'.repeat(10000), completed: true };
  h.run.tasks[0].status = 'accepted';
  task.inputs.push({ id: 'old', text: 'old unrelated supplement', deliveredAt: 1 }, { id: 'new', text: '完整的新补充\n保留换行', deliveredAt: null });
  attempt.inputIds = ['new'];
  task.reviews.push({ verdict: 'accept', reason: 'old review' }, { verdict: 'rework', reason: 'Recheck evidence', evidence: [] });
  assignment.input = '上游截图位于 _shots/phone.png；只修改 README 的相应图片。';
  h.run.works[0].plans[0].summary = 'unrelated-whole-plan'.repeat(1000);
  const before = structuredClone(h.run), prompt = fusionTaskPrompt(h.run, task, attempt), payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.deepEqual(payload.scope, task.scope); assert.deepEqual(payload.acceptance, task.acceptance); assert.equal(payload.access, task.access);
  assert.equal(payload.input, assignment.input); assert.equal(payload.planId, assignment.planId);
  assert.deepEqual(payload.inputs, [{ id: 'new', text: '完整的新补充\n保留换行' }]);
  assert.deepEqual(payload.review, task.reviews.at(-1));
  assert.deepEqual(payload.dependencies, [{ id: 'A', goal: h.run.tasks[0].goal, status: 'accepted' }]);
  assert(!prompt.includes('large-upstream-report')); assert(!prompt.includes('unrelated-whole-plan')); assert(!prompt.includes('old unrelated supplement'));
  assert.equal(payload.attemptId, attempt.id); assert.deepEqual(h.run, before);
});

test('read_task pages exact reply and text diffs by Attempt, while binary evidence stays a file reference', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('evidence')] });
  const attempt = h.run.attempts[0], text = 'diff --git a/read me.md b/read me.md\n--- a/read me.md\n+++ b/read me.md\n@@ -1 +1 @@\n-old\n+新内容\n';
  const binary = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 5\nbytes\n';
  attempt.result = { text: 'exact reply\n'.repeat(1500), completed: true };
  attempt.changes = { diff: text + binary }; attempt.baseline = { diff: text.replace('+新内容', '+before') };
  h.run.attempts.push({ ...attempt, id: 'newer-attempt', result: { text: 'new reply' } });
  const read = query => h.apply({ action: 'read_task', taskId: 'evidence', attemptId: attempt.id, ...(query ? { input: JSON.stringify(query) } : {}) });
  const index = read(); assert.equal(index.attempts[0].id, attempt.id);
  const reference = index.attempts[0].result.text.read;
  let reply = '', offset = 0;
  do {
    const page = h.apply({ ...reference, input: JSON.stringify({ ...JSON.parse(reference.input), offset }) });
    assert.equal(page.totalCharacters, attempt.result.text.length);
    reply += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reply, attempt.result.text);
  const file = index.attempts[0].changes.diff.files[0];
  const page = h.apply({ ...file.read, input: JSON.stringify({ ...JSON.parse(file.read.input), offset: 13, length: 23 }) });
  assert.equal(page.text, text.slice(13, 36)); assert.equal(page.nextOffset, 36);
  assert.equal(read({ section: 'diff', snapshot: 'baseline', fileIndex: 0 }).text, attempt.baseline.diff);
  const image = read({ section: 'diff', fileIndex: 1 });
  assert.equal(image.binary, true); assert.match(image.header, /image.png/); assert.equal(image.text, undefined);
  assert.throws(() => read({ section: 'diff', fileIndex: 9 }), /差异文件/);
  assert.throws(() => read({ section: 'result', offset: -1 }), /offset/);
  assert.throws(() => read({ section: 'result', length: 0 }), /length/);
  assert.throws(() => read({ section: 'invented' }), /证据类型/);
  assert.throws(() => h.apply({ ...reference, input: '{invalid' }), /JSON/);
  assert.throws(() => h.apply({ ...reference, input: 'null' }), /JSON 对象/);
  assert.throws(() => h.apply({ ...reference, attemptId: 'other-task' }), /不属于/);
});

const { FUSION_OWNER, fusionRunView, fusionControllerView } = await import('../server/fusion/owner.mjs');

test('a running main and historical stopped task project the current work without changing either execution fact', () => {
  const h = fixture(), oldWork = h.create(); h.plan(oldWork);
  h.apply({ action: 'dispatch', workId: oldWork, tasks: [h.task('historical-training')] });
  const oldAttempt = h.run.attempts[0]; Object.assign(oldAttempt, { status: 'stopped', endedAt: 20 });
  h.run.tasks[0].status = 'stopped';
  const workId = h.create(); h.plan(workId); h.run.works.at(-1).title = 'Current AB automation';
  h.run.status = 'waiting'; h.run.blockedReason = '';
  const main = { id: 'current-main', kind: 'main', status: 'running', endedAt: null,
    native: { turnId: 'current-turn' }, workExecutions: [{ workId }] };
  h.run.attempts.push(main); const before = structuredClone(h.run);
  const summary = fusionControllerView(h.run);
  assert.equal(summary.overview.state, 'run'); assert.equal(summary.overview.current.text, 'Current AB automation');
  assert.equal(summary.overview.current.status, 'running'); assert.equal(summary.overview.resultKey, '');
  assert.equal(summary.overview.counts.err, 1); assert.equal(summary.tasks.running, 0);
  assert.equal(fusionRunView(h.run, { kind: 'task', taskId: 'historical-training' }).overview.state, 'run');
  assert.deepEqual(h.run, before);
  Object.assign(main, { status: 'ended', endedAt: 40 });
  const ended = fusionControllerView(h.run);
  assert.equal(ended.overview.state, 'idle'); assert.equal(ended.overview.current, null);
  assert.equal(h.run.tasks[0].status, 'stopped'); assert.equal(h.run.attempts.find(row => row.id === oldAttempt.id).status, 'stopped');
});
test('main-only work follows actual native stages and retains real questions block recovery and unknown states', () => {
  const h = fixture(); h.run.status = 'waiting';
  const main = { id: 'only-main', kind: 'main', status: 'running', endedAt: null, native: { turnId: 'only-turn' } };
  h.run.attempts.push(main); h.run.events.push({ id: 'request', type: 'user_input', data: { text: 'Current direct request', native: { turnId: 'only-turn' } } });
  for (const status of ['queued', 'preparing', 'submitting', 'running', 'stopping']) {
    main.status = status; const summary = fusionControllerView(h.run);
    assert.equal(summary.overview.state, 'run', status); assert.equal(summary.overview.current.status, status);
    assert.equal(summary.overview.current.text, 'Current direct request'); assert.equal(summary.overview.resultKey, '');
  }
  main.status = 'unknown';
  assert.equal(fusionControllerView(h.run).overview.state, 'err'); assert.equal(fusionControllerView(h.run).overview.current.status, 'unknown');
  assert.equal(fusionControllerView(h.run).overview.resultKey, '');
  h.run.status = 'recovering'; assert.equal(fusionControllerView(h.run).overview.state, 'run');
  h.run.status = 'blocked'; h.run.blockedReason = 'Current native failure';
  main.status = 'running'; assert.equal(fusionControllerView(h.run).overview.state, 'err');
  h.run.questions.push({ id: 'current-question', text: 'Required decision' });
  assert.equal(fusionControllerView(h.run).overview.state, 'wait');
  h.run.questions[0].answeredAt = 50; h.run.status = 'waiting'; h.run.blockedReason = '';
  Object.assign(main, { status: 'ended', endedAt: 60 }); assert.equal(fusionControllerView(h.run).overview.state, 'idle');
});
test('only unresolved current failed results block while disposed and closed-work failures remain historical', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('failed-analysis')] });
  h.run.status = 'waiting'; const attempt = h.run.attempts[0];
  Object.assign(attempt, { status: 'failed', endedAt: 20, result: { completed: false, error: 'Native error' } });
  h.run.tasks[0].status = 'failed'; const failed = fusionControllerView(h.run);
  assert.equal(failed.overview.state, 'err'); assert.equal(failed.overview.current.text, 'Task failed-analysis');
  assert(failed.overview.resultKey);
  h.run.works[0].status = 'stopped';
  assert.equal(fusionControllerView(h.run).overview.state, 'idle'); assert.equal(fusionControllerView(h.run).overview.counts.err, 1);
  h.run.works[0].status = 'running';
  h.apply({ action: 'cancel_task', taskId: 'failed-analysis', reason: 'Handled, no further execution' });
  assert.equal(fusionControllerView(h.run).overview.state, 'idle');
  const historical = h.run.attempts.find(row => row.id === attempt.id);
  assert.equal(historical.status, 'failed'); assert.equal(historical.result.error, 'Native error');
});
test('pending successful results remain visible for review rather than looking like an idle or delivered workbench', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('pending-review')] });
  h.run.status = 'waiting'; const attempt = h.run.attempts[0];
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { completed: true, text: 'Actual result' } });
  h.run.tasks[0].status = 'awaiting_review';
  const before = structuredClone(h.run), summary = fusionControllerView(h.run);
  assert.equal(summary.overview.state, 'run'); assert.equal(summary.overview.current.status, 'awaiting_review');
  assert.equal(summary.overview.resultKey, ''); assert.deepEqual(h.run, before);
  h.apply({ action: 'review', taskId: 'pending-review', attemptId: attempt.id, verdict: 'accept', reason: 'Checked', summary: 'Verified',
    evidence: [{ criterion: 'pending-review:1', detail: 'Actual result', reference: 'result.text' }] });
  assert.equal(fusionControllerView(h.run).overview.state, 'idle');
  h.run.works[0].status = 'completed'; h.run.works[0].deliveries.push({ mainAttemptId: 'ended-main', nativeTurnId: 'ended-turn', endedAt: 40 });
  assert.equal(fusionControllerView(h.run).overview.state, 'done');
});

test('Fusion result identity follows ended execution and delivery facts while connection and read metadata stay irrelevant', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  Object.assign(h.run, { status: 'blocked', blockedReason: 'Original execution stopped' });
  h.run.attempts.push({ id: 'main-one', kind: 'main', status: 'ended', endedAt: 20 });
  const before = structuredClone(h.run), first = fusionControllerView(h.run).overview.resultKey;
  assert(first); assert.deepEqual(h.run, before);
  h.run.updated++; h.run.revision++; h.run.main.windowId = 'restored-window';
  h.run.bindings[0].workerReads = [{ id: 'directory-read', at: 30 }];
  assert.equal(fusionControllerView(h.run).overview.resultKey, first);
  assert.equal(fusionRunView(h.run, { kind: 'config' }).overview.resultKey, first);
  h.run.attempts.push({ id: 'main-two', kind: 'main', status: 'failed', endedAt: 40 });
  const second = fusionControllerView(h.run).overview.resultKey;
  assert.notEqual(second, first);
  h.run.blockedReason = 'A different execution failure';
  assert.notEqual(fusionControllerView(h.run).overview.resultKey, second);
  h.run.status = 'waiting'; h.run.works[0].status = 'completed'; h.run.blockedReason = '';
  h.run.works[0].deliveries.push({ mainAttemptId: 'main-two', nativeTurnId: 'turn-two', endedAt: 50 });
  const delivered = fusionControllerView(h.run).overview;
  assert.equal(delivered.state, 'done'); assert(delivered.resultKey);
  h.run.works[0].deliveries.push({ mainAttemptId: 'main-three', nativeTurnId: 'turn-three', endedAt: 60 });
  assert.notEqual(fusionControllerView(h.run).overview.resultKey, delivered.resultKey);
});
test('Fusion results cannot be acknowledged while native execution or a required user decision remains pending', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.run.status = 'blocked'; h.run.blockedReason = 'Must remain visible';
  assert(fusionControllerView(h.run).overview.resultKey);
  for (const status of ['queued', 'preparing', 'submitting', 'running', 'unknown', 'stopping']) {
    h.run.attempts = [{ id: 'native-one', kind: 'main', status, endedAt: null }];
    assert.equal(fusionControllerView(h.run).overview.resultKey, '', status);
  }
  h.run.attempts = [];
  for (const status of ['running', 'recovering', 'stopping', 'awaiting_user']) {
    h.run.status = status; assert.equal(fusionControllerView(h.run).overview.resultKey, '', status);
  }
  h.run.status = 'blocked'; h.run.main.preparing = true;
  assert.equal(fusionControllerView(h.run).overview.resultKey, ''); delete h.run.main.preparing;
  h.run.questions.push({ id: 'unanswered', workId, text: 'A real decision is required' });
  assert.equal(fusionControllerView(h.run).overview.state, 'wait');
  assert.equal(fusionControllerView(h.run).overview.resultKey, '');
  h.run.questions[0].answeredAt = 30;
  const plan = h.run.works[0].plans[0]; plan.requiresConfirmation = true; plan.confirmed = false;
  assert.equal(fusionControllerView(h.run).overview.resultKey, '');
  plan.confirmed = true; assert(fusionControllerView(h.run).overview.resultKey);
});

test('main interaction projection keeps one question text, its native origin and the actual answer without mutating history', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  const id = h.apply({ action: 'ask_user', workId, question: 'Canonical scope and criteria?', options: ['Approve', 'Change'] }).questionId;
  h.run.attempts.push({ kind: 'main', native: { threadId: 'main-thread', turnId: 'native-turn', messageId: 'proposal-message' } });
  const question = h.run.questions.find(row => row.id === id);
  Object.assign(question, { answeredAt: 20, answer: 'Approve with model Sol', inputId: 'native-answer' });
  h.run.events.push({ id: 'native-answer', type: 'user_input', data: { native: { threadId: 'main-thread', turnId: 'reply-turn', messageId: 'reply-message' } } });
  const before = JSON.stringify(h.run), board = fusionRunView(h.run, { kind: 'tasks' });
  assert.equal(board.questions.length, 1); assert.equal(board.questions[0].text, question.text);
  assert.equal(board.questions[0].native.messageId, 'proposal-message'); assert.equal(board.questions[0].answerNative.messageId, 'reply-message');
  assert.equal(board.works[0].plans[0].native.messageId, 'proposal-message');
  assert.deepEqual(fusionControllerView(h.run).overview.attention.map(row => row.kind), ['plan']);
  assert.equal(JSON.stringify(h.run), before);
});
const { fusionLive, fusionViewers, fusionRuns, fusionWorkers, savedFusion, findFusionRun, publishFusion } = await import('../server/fusion/state.mjs');
function largeViewFixture() {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('view-task')] });
  const attempt = h.run.attempts[0], bindingId = 'view-binding';
  Object.assign(attempt, { bindingId, result: { text: 'result'.repeat(100000) }, changes: { diff: '+exact diff\n'.repeat(100000) }, baseline: { head: 'native-head' } });
  h.run.agents[0].bindingId = bindingId;
  h.run.bindings.push({ id: bindingId, role: 'worker', app: 'codex', threadId: 'native-child', windowId: 'native-window', project: h.project });
  h.run.events.push({ id: 'result-event', type: 'task_result', data: { attemptId: attempt.id, changes: attempt.changes } });
  h.run.works[0].deliveries.push({ summary: 'verified', evidence: [{ detail: 'evidence\n'.repeat(100000) }], mainAttemptId: attempt.id });
  h.run.attempts.push({ ...attempt, id: 'latest-attempt', result: { text: 'new result' } });
  h.run.tasks[0].status = 'awaiting_user';
  fusionLive.set(bindingId, { state: { waiting: 'approval' }, chat: { items: [{ i: 'body', k: 'assistant', t: 'live'.repeat(100000) },
    { i: 'native-action', b: ['Allow'], actions: ['allow-once'], btnItem: 'native-button' }],
    questions: { codex: true, requests: [{ id: 'approval', text: 'Approval', fields: [], buttons: [{ label: 'Allow' }] }] } } });
  return { ...h, workId, attempt, bindingId };
}
test('Fusion summary and selected views omit full history, diffs and repeated native transcripts', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  for (const view of [{ kind: 'config' }, { kind: 'tasks' }, { kind: 'task', taskId: 'view-task' }, { kind: 'input' }]) {
    const result = fusionRunView(h.run, view), raw = JSON.stringify(result);
    assert(Buffer.byteLength(raw) < 20000, view.kind + ' must remain a small projection');
    assert(!raw.includes('+exact diff')); assert(!raw.includes('resultresult')); assert(!raw.includes('livelive'));
  }
  const task = fusionRunView(h.run, { kind: 'task', taskId: 'view-task' });
  assert.equal(task.attempts[0].live, undefined); assert.equal(task.attempts[1].live, undefined);
  assert.equal(task.board.nativeInteractions[0].items.length, 0);
  assert.equal(task.board.nativeInteractions[0].requests[0].id, 'approval');
  assert.equal(fusionControllerView(h.run).tasks.total, 1);
});
test('explicit audit reads preserve exact full diffs, native identity and delivery evidence', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const audit = fusionRunView(h.run, { kind: 'attempt', attemptId: h.attempt.id });
  assert.equal(audit.changes.diff, h.attempt.changes.diff); assert.deepEqual(audit.baseline, h.attempt.baseline);
  assert.deepEqual(audit.result, h.attempt.result); assert.equal(audit.events[0].data.changes.diff, h.attempt.changes.diff);
  assert.deepEqual(fusionRunView(h.run, { kind: 'delivery', workId: h.workId, index: 0 }), h.run.works[0].deliveries[0]);
  assert.deepEqual(fusionRunView(h.run, { kind: 'reviews', taskId: 'view-task' }).reviews, h.run.tasks[0].reviews);
});
test('UI summaries expose real agent assignments and dispatch identity without loading task inputs or evidence', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const task = h.run.tasks[0], command = h.run.commands.find(row => row.action === 'dispatch');
  task.inputs.push({ id: 'supplement', text: 'private-input-'.repeat(10000) });
  h.run.assignments[0].input = 'assignment-input-'.repeat(10000);
  h.run.attempts.push({ id: 'main-observation', kind: 'main', native: { ...command.native, messageId: 'real-human-message' } });
  const before = structuredClone(h.run), summary = fusionControllerView(h.run), board = fusionRunView(h.run, { kind: 'tasks' });
  const detail = fusionRunView(h.run, { kind: 'task', taskId: task.id });
  assert.equal(summary.overview.state, 'wait'); assert.equal(summary.overview.attention[0].taskId, task.id);
  assert.equal(board.tasks[0].workerId, task.workerId); assert.equal(board.tasks[0].model, h.run.assignments[0].model);
  assert.equal(board.tasks[0].access, task.access); assert.equal(board.dispatches[0].native.messageId, 'real-human-message');
  assert.equal(board.dispatches[0].tasks[0].attemptId, h.attempt.id);
  for (const value of [summary, board, detail]) {
    const raw = JSON.stringify(value);
    assert(!raw.includes('private-input-')); assert(!raw.includes('assignment-input-')); assert(!raw.includes('+exact diff'));
  }
  assert.equal(detail.tasks[0].inputs, undefined); assert.equal(detail.tasks[0].summary.text, 'new result');
  assert.equal(board.tasks[0].summary, undefined); assert.deepEqual(h.run, before);
});
test('explicit input reads return complete original data and leave the selected task subscription in place', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  h.run.tasks[0].inputs.push({ id: 'input', text: 'exact-input'.repeat(5000), deliveredAt: null });
  const viewer = { emit() {} }, read = view => FUSION_OWNER.fusionRead.call(viewer, {
    runId: h.run.id, view, taskId: 'view-task', requestId: view,
  });
  read('task'); const before = structuredClone(h.run); read('inputs');
  assert.equal(viewer.fusionDetail.view.subscriptionId, 'task');
  const value = fusionRunView(h.run, { kind: 'inputs', taskId: 'view-task' });
  assert.deepEqual(value.inputs, h.run.tasks[0].inputs); assert.equal(value.assignments[0].input, h.run.assignments[0].input);
  assert.deepEqual(h.run, before);
});
test('task progress separates receipt, generation and delivery and does not guess directory change counts', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const attempt = h.run.attempts.at(-1);
  Object.assign(attempt, { submission: 'accepted', acceptedAt: 10, endedAt: 20, durationMs: 10,
    result: { text: '', error: 'native failure', completed: false },
    baseline: { available: true, files: [{ path: 'a.md', exists: true, sha256: 'before' }] },
    changes: { available: true, files: [{ path: 'a.md', exists: true, sha256: 'after' }] } });
  const selected = () => fusionRunView(h.run, { kind: 'task', taskId: 'view-task' }).tasks[0].summary;
  assert.equal(selected().files, 1); assert.equal(selected().submission, 'accepted');
  assert.equal(selected().completed, false); assert.equal(selected().delivered, false); assert.equal(selected().durationMs, 10);
  attempt.changes.files.push({ path: '.', exists: true, directory: true });
  assert.equal(selected().files, null);
});
test('detail subscriptions follow the requested view; audit reads and obsolete closes cannot replace it', t => {
  const h = largeViewFixture(), messages = [], viewer = { deviceId: 'test', emit: message => messages.push(message) };
  fusionViewers.add(viewer); t.after(() => { fusionViewers.delete(viewer); fusionLive.delete(h.bindingId); });
  const read = (view, requestId, ids = {}) => FUSION_OWNER.fusionRead.call(viewer, { computer: h.run.computer, runId: h.run.id, view, requestId, ...ids });
  read('tasks', 'list'); read('task', 'selected', { taskId: 'view-task' });
  read('attempt', 'audit', { attemptId: h.attempt.id });
  assert.equal(viewer.fusionDetail.view.subscriptionId, 'selected');
  read('close', 'close-old', { subscriptionId: 'list' });
  messages.length = 0; publishFusion(h.run, false);
  assert.deepEqual(messages.map(m => m.t), ['fusionUpdate', 'fusionState']);
  assert.equal(messages[1].view.kind, 'task'); assert.equal(messages[1].view.subscriptionId, 'selected');
  read('close', 'close-selected', { subscriptionId: 'selected' });
  messages.length = 0; publishFusion(h.run, false);
  assert.deepEqual(messages.map(m => m.t), ['fusionUpdate']);
});
test('a configuration receipt cannot take back a newer task subscription', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('current-task')] });
  const viewer = { deviceId: 'test', emit() {} };
  FUSION_OWNER.fusionRead.call(viewer, { runId: h.run.id, view: 'task', taskId: 'current-task', requestId: 'current-view' });
  await FUSION_OWNER.fusionConfigure.call(viewer, { runId: h.run.id, view: 'config', subscriptionId: 'old-config', requestId: 'old-save' });
  assert.equal(viewer.fusionDetail.view.kind, 'task'); assert.equal(viewer.fusionDetail.view.subscriptionId, 'current-view');
});
test('every paired entry reads the same computer history without copying or changing its creator facts', async t => {
  const h = fixture(), messages = [], phone = 'paired-phone-' + h.run.id;
  const viewer = { deviceId: phone, emit: message => messages.push(message) };
  const before = structuredClone(h.run);
  t.after(() => { delete fusionRuns[phone]; });
  await FUSION_OWNER.fusionWorkspace.call(viewer);
  assert(messages.at(-1).runs.some(run => run.id === h.run.id));
  assert.equal(messages.at(-1).current, '');
  FUSION_OWNER.fusionRead.call(viewer, { computer: h.run.computer, runId: h.run.id, view: 'tasks', requestId: 'phone-history' });
  assert.equal(messages.at(-1).run.id, h.run.id);
  assert.equal(findFusionRun(h.run.id), h.run);
  assert.deepEqual(h.run, before);
  const { overviewSnapshot } = await import('../server/overview.mjs');
  const creator = overviewSnapshot(h.run.deviceId), visitor = overviewSnapshot(phone);
  assert(visitor.fusion.some(run => run.id === h.run.id));
  assert.deepEqual(visitor.fusion, creator.fusion);
  assert.deepEqual(visitor.sessions, creator.sessions);
});
test('a different paired entry opens the original main binding and retains only its own recent selection', async t => {
  const h = fixture(), phone = 'paired-phone-' + h.run.id, requests = [];
  const { adapter } = await import('../server/apps/fusion.mjs');
  const before = structuredClone(h.run);
  t.after(() => { delete fusionRuns[phone]; });
  await adapter.attach.call({ deviceId: phone, attach: request => requests.push(request) }, { threadId: h.run.id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, h.run.bindings[0].threadId);
  assert.equal(requests[0].windowId, h.run.bindings[0].windowId);
  assert.equal(savedFusion(phone).current, h.run.id);
  assert.deepEqual(savedFusion(phone).runs, []);
  assert.deepEqual(h.run, before);
});
test('paired entries share updates and inputs on one existing runner while closing only their own view', async t => {
  const h = fixture(), workId = h.create(), phone = 'paired-phone-' + h.run.id;
  const creatorMessages = [], phoneMessages = [];
  const creator = { deviceId: h.run.deviceId, emit: message => creatorMessages.push(message) };
  const viewer = { deviceId: phone, emit: message => phoneMessages.push(message) };
  fusionViewers.add(creator); fusionViewers.add(viewer);
  const { fusionRunner } = await import('../server/fusion/runner.mjs');
  const runner = fusionRunner(h.run); runner.wake = () => {};
  t.after(() => {
    fusionViewers.delete(creator); fusionViewers.delete(viewer); delete fusionRuns[phone];
    for (const [key, value] of fusionWorkers) if (value === runner) fusionWorkers.delete(key);
  });
  for (const entry of [creator, viewer]) FUSION_OWNER.fusionRead.call(entry, {
    computer: h.run.computer, runId: h.run.id, view: 'tasks', requestId: entry.deviceId,
  });
  creatorMessages.length = phoneMessages.length = 0;
  publishFusion(h.run, false);
  assert.deepEqual(creatorMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.deepEqual(phoneMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.equal(phoneMessages[1].view.subscriptionId, phone);
  FUSION_OWNER.fusionRead.call(viewer, { runId: h.run.id, view: 'close', subscriptionId: phone, requestId: 'close-phone' });
  creatorMessages.length = phoneMessages.length = 0;
  publishFusion(h.run, false);
  assert.deepEqual(creatorMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.deepEqual(phoneMessages.map(message => message.t), ['fusionUpdate']);
  FUSION_OWNER.fusionInput.call(viewer, { computer: h.run.computer, runId: h.run.id, workId, text: 'Continue the same work', requestId: 'phone-followup' });
  assert.equal(h.run.events.at(-1).data.workId, workId);
  assert.equal(h.run.events.at(-1).data.text, 'Continue the same work');
  assert.equal(fusionRunner(findFusionRun(h.run.id)), runner);
  assert.equal(h.run.deviceId, creator.deviceId);
  assert.equal(fusionRuns[creator.deviceId].runs[0], h.run);
  assert.equal(h.run.attempts.length, 0);
});

test('child plans do not require main scope or reserve main costs and preserve actual native identity', () => {
  const h=fixture(),workId=h.create(),native={...h.native(),callId:'native-plan-item'};
  const action={action:'plan',workId,summary:'Delegate review',scope:['src'],criteria:[{id:'C',text:'Real result'}],requiresConfirmation:false};
  applyFusionControl(h.run,action,native);const plan=h.run.works[0].plans[0];
  assert.equal('mainScope' in plan,false);assert.equal('cost' in plan,false);
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).works[0].plans[0].native.callId,'native-plan-item');
  assert.equal(h.run.tasks.length,0);assert.equal(h.run.assignments.length,0);
  assert.throws(()=>h.apply({action:'self_execute',workId}),/未知/);
});
test('explicit budgets still include previously confirmed main cost facts before a child is dispatched', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.run.capabilities.find(row=>row.app==='codex').models[0].pricing={unit:'credits'};h.run.budget={limit:10,unit:'credits'};
  Object.assign(h.run.works[0].plans[0],{mainScope:['historical-main-file'],cost:{...h.cost('codex'),estimate:{amount:6,unit:'credits'}}});
  const child={...h.task('child'),cost:{...h.cost('codex'),estimate:{amount:5,unit:'credits'}}};
  assert.throws(()=>h.apply({action:'dispatch',workId,tasks:[child]}),/超过用户预算/);assert.equal(h.run.assignments.length,0);assert.equal(h.run.tasks.length,0);
});

test('ordinary message buttons never become native interactions and native approval keeps its actual task and request', t => {
  const h=largeViewFixture();t.after(()=>fusionLive.delete(h.bindingId));
  let board=fusionRunView(h.run,{kind:'tasks'});
  assert.equal(board.nativeInteractions.length,1);assert.equal(board.nativeInteractions[0].taskId,'view-task');
  assert.equal(board.nativeInteractions[0].requests[0].id,'approval');assert.equal(board.nativeInteractions[0].items.length,0);
  fusionLive.set(h.bindingId,{state:{},chat:{items:[{i:'copy',b:['Copy message','Fork chat from here']}]}});
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).nativeInteractions.length,0);
  fusionLive.set(h.bindingId,{state:{waiting:'native-item:Allow'},chat:{items:[{i:'native-item',b:['Copy message','Allow'],actions:['copy','allow']} ]}});
  const item=fusionRunView(h.run,{kind:'tasks'}).nativeInteractions[0].items[0];
  assert.deepEqual(item.buttons,[{label:'Allow',n:1,actionId:'allow'}]);
  h.run.attempts.at(-1).endedAt=30;
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).nativeInteractions.length,0);
});
test('pending interaction stays after new output and completed cards use the actual native tool position', () => {
  const source=fs.readFileSync(new URL('../app/js/fusion.js',import.meta.url),'utf8');
  const run={id:'run',computer:'computer'},plan={id:'plan',created:1,confirmed:false,requiresConfirmation:true,native:{threadId:'thread',messageId:'old',callId:'call'}};
  const board={dispatches:[],questions:[],nativeInteractions:[],works:[{id:'work',plans:[plan]}]};
  const nodes=new Map(),context=vm.createContext({currentFusionRun:()=>run,fusionBoards:new Map([['computer|run',board]]),fusionStateKey:(c,r)=>c+'|'+r,
    fusionDispatchCards:new Map(),fusionInteractionCards:nodes,fusionFocusInteraction:'',fusionPendingGroup:null,deferredScrollRender:false,
    fusionInteractionNode(_r,_w,kind,item){const k='computer|run|'+kind+':'+item.id;if(!nodes.has(k))nodes.set(k,{id:item.id});return nodes.get(k);},
    document:{createElement:()=>({setAttribute(){},children:[]})},I18N:{tr:s=>s},syncChildren:(parent,children)=>{parent.children=children;},queueMicrotask(){}});
  const a=source.indexOf('function fusionChatAnchor('),b=source.indexOf('function fusionNativeNode(',a);
  const c=source.indexOf('function fusionChatRows('),d=source.indexOf('function fusionStateBadge(',c);
  vm.runInContext(source.slice(a,b)+source.slice(c,d)+';this.paint=fusionChatRows;',context);
  const items=[{i:'user',k:'human',nativeIds:['old']},{i:'thread:dynamic-tool-call:call',k:'tool'},{i:'reply',k:'assistant'}];
  const rows=items.map(i=>({id:i.i}));context.paint(items,rows,false,0);
  assert.equal(rows.at(-1).children[0].id,'plan');
  const updated=[...items,{i:'next-reply',k:'assistant'}],next=updated.map(i=>({id:i.i}));context.paint(updated,next,false,0);
  assert.equal(next.at(-2).id,'next-reply');assert.equal(next.at(-1).children[0].id,'plan');
  plan.confirmed=true;const completed=items.map(i=>({id:i.i}));context.paint(items,completed,false,0);
  assert.deepEqual(completed.map(n=>n.id),['user','thread:dynamic-tool-call:call','plan','reply']);
});
test('a native-only board update redraws the main conversation without another task or plan change', () => {
  const source=fs.readFileSync(new URL('../app/js/fusion.js',import.meta.url),'utf8');
  const run={id:'run',computer:'computer',tasks:[],works:[],questions:[],dispatches:[],nativeInteractions:[]};
  let paints=0;
  const context=vm.createContext({currentFusionRun:()=>run,fusionBoards:new Map(),fusionStateKey:(c,r)=>c+'|'+r,
    paintFusionTaskStrip(){},fusionDispatchCards:new Map(),fusionChatActive:()=>true,lastChat:{thread:'main'},
    currentComputer:()=>({threadId:'main'}),chatStale:false,renderChat(){paints++;}});
  const a=source.indexOf('function fusionRememberBoard('),b=source.indexOf('function paintFusionTaskStrip(',a);
  vm.runInContext(source.slice(a,b)+';this.remember=fusionRememberBoard;',context);
  context.remember(run);paints=0;
  const approval={...run,nativeInteractions:[{id:'attempt',requests:[{id:'approval'}]}]};
  context.remember(approval);assert.equal(paints,1);
  context.remember(approval);assert.equal(paints,1);
  context.remember(run);assert.equal(paints,2);
});
test('worker responsibility labels update when reused while retaining the native binding and earlier task facts', () => {
  const h=fixture(),workId=h.create();h.plan(workId);
  const first=h.apply({action:'dispatch',workId,tasks:[h.task('audit')],input:JSON.stringify({audit:{workerId:null,label:'训练协议审查',reason:'Independent audit'}})}).tasks[0];
  h.run.agents[0].bindingId='existing-native-binding';
  const before=structuredClone({task:h.run.tasks[0],attempt:h.run.attempts[0]});
  const reused=h.apply({action:'dispatch',workId,tasks:[h.task('related')],input:JSON.stringify({related:{workerId:first.workerId,label:'训练与证据复核',reason:'Reuse related evidence'}})}).tasks[0];
  assert.equal(reused.workerId,first.workerId);assert.equal(h.run.agents.length,1);assert.equal(h.run.agents[0].bindingId,'existing-native-binding');
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).agents[0].label,'训练与证据复核');
  assert.deepEqual({task:h.run.tasks[0],attempt:h.run.attempts[0]},before);
});

test('dispatch without an explicit responsibility label fails without creating a worker or task', () => {
  const h=fixture(),workId=h.create();h.plan(workId);
  assert.throws(()=>applyFusionControl(h.run,{action:'dispatch',workId,tasks:[h.task('new')],input:JSON.stringify({new:{workerId:null,reason:'New context'}})},h.native()),/职责短名/);
  assert.equal(h.run.tasks.length,0);assert.equal(h.run.agents.length,0);assert.equal(h.run.attempts.length,0);
});
