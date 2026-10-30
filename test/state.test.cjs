const {test}=require('node:test');
const assert=require('node:assert/strict');
const {transition,canTransition}=require('../src/tasks/state.cjs');

test('task state: happy path from created to completed',()=>{
  assert.equal(transition('created','start'),'preparing');
  assert.equal(transition('preparing','need_input'),'awaiting_input');
  assert.equal(transition('awaiting_input','answer'),'preparing');
  assert.equal(transition('preparing','ready_for_approval'),'awaiting_approval');
  assert.equal(transition('awaiting_approval','approve'),'approved');
  assert.equal(transition('approved','dispatch'),'executing');
  assert.equal(transition('executing','verify'),'verifying');
  assert.equal(transition('verifying','verified'),'completed');
  assert.equal(transition('preparing','no_changes'),'completed');
});
test('task state: recovery, login pause and cancellation boundaries',()=>{
  assert.equal(transition('preparing','pause_login'),'paused_login_required');
  assert.equal(transition('paused_login_required','resume_login'),'preparing');
  assert.equal(transition('preparing','fail_retryable'),'failed_retryable');
  assert.equal(transition('failed_retryable','retry'),'preparing');
  assert.equal(transition('executing','unknown'),'outcome_unknown');
  assert.equal(transition('outcome_unknown','reconcile'),'verifying');
  assert.equal(transition('outcome_unknown','fail_terminal'),'failed_terminal');
  assert.equal(transition('awaiting_input','cancel'),'cancelled');
  assert.equal(transition('awaiting_approval','cancel'),'cancelled');
  assert.equal(transition('approved','cancel'),'cancelled');
  assert.equal(transition('awaiting_approval','plan_changed'),'preparing');
  assert.throws(()=>transition('executing','cancel'),/invalid_transition/);
  assert.throws(()=>transition('created','approve'),/invalid_transition/);
  assert.throws(()=>transition('completed','start'),/invalid_transition/);
  assert.equal(canTransition('awaiting_approval','approve'),true);
  assert.equal(canTransition('completed','approve'),false);
});
