export const initialTasks = [
  { id: 'checkout', title: 'Checkout recovery', owner: 'Alex', status: 'In progress', updated: 'Just now', description: 'Recover failed checkouts without charging a customer twice.' },
  { id: 'webhook', title: 'Webhook dedupe', owner: 'Maya', status: 'Planned', updated: '12m ago', description: 'Process each webhook once, even when the provider retries delivery.' },
  { id: 'refund', title: 'Refund safeguards', owner: 'Alex', status: 'Planned', updated: '28m ago', description: 'Keep partial refunds within the original captured amount.' },
];
export const initialRequests = [
  { id: 1, taskId: 'checkout', taskTitle: 'Checkout recovery', from: 'Alex', to: 'Maya', question: 'Can you review the timeout case?', status: 'open' },
  { id: 2, taskId: 'checkout', taskTitle: 'Checkout recovery', from: 'Alex', to: 'Maya', question: 'Does the retry preserve the key after a timeout?', status: 'open' },
];
export const retryDiff = [
  ['1', '', 'export async function retryCheckout(checkout: Checkout) {'],
  ['2', '', '  const existing = await payments.find(checkout.id);'],
  ['3', '', "  if (existing?.status === 'succeeded') return existing;"],
  ['4', '-', '  const key = createPaymentKey();'],
  ['4', '+', '  const key = checkout.paymentKey;'],
  ['5', '+', "  if (!key) throw new Error('Missing original payment key');"],
  ['6', '', '  return payments.create({'],
  ['7', '', '    amount: checkout.amount,'],
  ['8', '', '    idempotencyKey: key,'],
  ['9', '', '  });'],
  ['10', '', '}'],
];
export const testDiff = [
  ['1', '', "describe('checkout retry', () => {"],
  ['2', '+', "  it('reuses the payment key after a timeout', async () => {"],
  ['3', '+', '    await retryCheckout(checkout);'],
  ['4', '+', '    expect(payments.create).toHaveBeenCalledWith('],
  ['5', '+', '      expect.objectContaining({'],
  ['6', '+', '        idempotencyKey: checkout.paymentKey,'],
  ['7', '+', '      }),'],
  ['8', '+', '    );'],
  ['9', '+', '  });'],
  ['10', '', '});'],
];
export const sourceEvents = {
  objective: { title: 'Original task request', actor: 'Alex', time: '10:32', event: 12, text: 'Recover failed checkouts without charging a customer twice. Trace the failure path, add a safe retry, and verify payment safety.' },
  decision: { title: 'Recorded decision', actor: 'Maya', time: '10:35', event: 28, text: 'Keep retries idempotent. Reuse the original payment key.', detail: 'Delivered to Codex · turn 4. This decision was explicitly recorded by Maya.' },
  test: { title: 'Latest check', actor: 'Codex', time: '10:36', event: 35, text: 'Duplicate-charge test passed.', detail: 'Sample result: 3 tests passed. Covers timeout retry, reuse of the original key, and already-completed payments. This prototype did not execute these tests.' },
  summary: { title: 'Catch-up sources', actor: 'Task history', time: '10:36', event: 36, text: 'Codex replaced fresh payment keys with the original key. Retry tests now cover timeouts.', detail: 'Source events: 12 (objective), 28 (Maya’s recorded decision), 34 (retry.ts changes), 35 (test result). Summary reflects these sample events, not a new inference.' },
};
