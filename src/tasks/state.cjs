// 任务状态机：只允许显式列出的转移，防止自由字符串状态绕过恢复和审批规则。
// 执行中断只能进入 outcome_unknown，之后只允许核对（reconcile），不能直接重写。
const TRANSITIONS={
  created:{start:'preparing'},
  preparing:{
    need_input:'awaiting_input',
    ready_for_approval:'awaiting_approval',
    no_changes:'completed',
    fail_retryable:'failed_retryable',
    pause_login:'paused_login_required'
  },
  awaiting_input:{answer:'preparing',cancel:'cancelled'},
  awaiting_approval:{plan_changed:'preparing',approve:'approved',cancel:'cancelled'},
  approved:{dispatch:'executing',cancel:'cancelled'},
  executing:{verify:'verifying',unknown:'outcome_unknown',fail_retryable:'failed_retryable'},
  verifying:{verified:'completed',unknown:'outcome_unknown',fail_retryable:'failed_retryable'},
  outcome_unknown:{reconcile:'verifying',fail_terminal:'failed_terminal'},
  paused_login_required:{resume_login:'preparing'},
  failed_retryable:{retry:'preparing'},
  completed:{},
  cancelled:{},
  failed_terminal:{}
};

function canTransition(state,event){
  return !!(TRANSITIONS[state]&&Object.prototype.hasOwnProperty.call(TRANSITIONS[state],event));
}
function transition(state,event){
  if(!canTransition(state,event))throw Error('invalid_transition_'+state+'_'+event);
  return TRANSITIONS[state][event];
}

module.exports={TRANSITIONS,canTransition,transition};
