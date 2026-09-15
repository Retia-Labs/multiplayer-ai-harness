// Build exports from an allowlist, never by redacting an arbitrary log or exception.
export const STAGES = ['account', 'endpoint', 'project', 'provider', 'solo', 'invite', 'recovery'];
export const HEALTH = ['ready', 'pending', 'failed', 'unavailable'];
export const DIAGNOSTIC_CODES = {
  account_required: 'Sign in to your Plexus account.',
  endpoint_pending: 'Ask a verified teammate to compare and confirm this device fingerprint.',
  enrollment_failed: 'Reconnect, then retry enrollment. Ask a verified teammate to confirm this device.',
  runtime_missing: 'Start the desktop app on the execution host, then pair its displayed code.',
  project_unshared: 'On the execution host, select and explicitly share a project folder.',
  provider_missing: 'Install the supported provider runtime on the execution host and retry setup.',
  account_unsupported: 'Complete local provider setup with a supported account and authentication mode.',
  provider_unavailable: 'Open provider setup on the execution host and resolve its readiness check.',
  solo_pending: 'Start a task and wait for a successful turn to complete.',
  invite_pending: 'Invite a named teammate using their Plexus account ID.',
  recovery_pending: 'Prepare customer-held recovery material and complete a clean-device recovery drill.',
  recovery_failed: 'Check the customer recovery key and selected kit. Keep any remaining trusted device.',
  connection_unavailable: 'Reconnect to the team service and retry.',
  setup_failed: 'Retry the indicated setup stage. Inspect this content-safe report if you need support.'
};
export const PRIVACY_NOTICE = 'Task content is encrypted between authorized endpoints. The service sees routing, identity/membership, size and timing metadata, seat records, and measurement only when enabled. Your selected provider receives the inputs needed to execute tasks. Browser access trusts the delivered app and its origin. Diagnostics contain only the fields you can inspect here and are never sent automatically.';
export const RECOVERY_NOTICE = 'The operator cannot decrypt your history. Losing every trusted endpoint and all customer-held recovery material makes it unrecoverable. Deletion and revocation cannot erase plaintext, keys, or copies already held by participants.';
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value : 'unknown';
export function safeCode(value) {
  if (typeof value !== 'string') return 'setup_failed';
  if (Object.hasOwn(DIAGNOSTIC_CODES, value)) return value;
  if (['codex_host_tools_auth_mode_unsupported', 'codex_host_tools_account_reauthorization_required', 'codex_account_changed'].includes(value)) return 'account_unsupported';
  if (['codex_missing', 'provider_not_installed'].includes(value)) return 'provider_missing';
  if (['endpoint_pending', 'confirming_endpoint_unverified'].includes(value)) return 'endpoint_pending';
  if (['relay_unavailable', 'mailbox_unavailable'].includes(value)) return 'connection_unavailable';
  return 'setup_failed';
}
export function diagnosticExport(input = {}) {
  return { schema: 'plexus.diagnostics.v1', client: input.client === 'desktop' ? 'desktop' : 'browser',
    versions: { app: version(input.versions?.app), electron: version(input.versions?.electron), protocol: 1 },
    stages: STAGES.map(stage => {
      const item = input.stages?.find(entry => entry.stage === stage);
      const status = HEALTH.includes(item?.status) ? item.status : 'pending';
      return { stage, status, code: status === 'ready' ? null : safeCode(item?.code) };
    }) };
}
export function onboarding(facts = {}) {
  const row = (stage, ready, code, failed = false) => ({ stage, status: ready ? 'ready' : failed ? 'failed' : 'pending', code: ready ? null : code });
  return [row('account', facts.account, 'account_required'),
    row('endpoint', facts.verified, facts.enrollmentError ? 'enrollment_failed' : 'endpoint_pending', facts.enrollmentError),
    row('project', facts.project, facts.host ? 'project_unshared' : 'runtime_missing'),
    row('provider', facts.provider, facts.providerCode || 'provider_unavailable', !!facts.providerCode),
    row('solo', facts.solo, 'solo_pending'), row('invite', facts.invited, 'invite_pending'),
    row('recovery', facts.recovery, facts.recoveryError ? 'recovery_failed' : 'recovery_pending', facts.recoveryError)];
}
