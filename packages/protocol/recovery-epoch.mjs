// The signed membership recovery epoch is bound inside every new command. Restoring
// a device or regranting a project cannot turn a pre-recovery envelope into new intent.
export function recoveryEpoch(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw Object.assign(new Error('invalid_recovery_epoch'), { code: 'invalid_recovery_epoch' });
  }
  return value;
}
export function requireRecoveryEpoch(actual, expected) {
  if (recoveryEpoch(actual) !== recoveryEpoch(expected)) {
    throw Object.assign(new Error('task_recovery_epoch_mismatch'), { code: 'task_recovery_epoch_mismatch' });
  }
}
