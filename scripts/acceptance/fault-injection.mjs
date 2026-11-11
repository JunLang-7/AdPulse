// 仅开发期隔离夹具与场景共享；正式 API 不提供这个标记或故障开关。
export const FAULT_HEADER = "x-adpulse-acceptance-fault";
export const FAULT_MARKER = "outbound-failure";
export const OUTBOUND_FAILURE_MESSAGE = "acceptance: injected outbound failure";
