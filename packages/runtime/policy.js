'use strict';
// Policy engine: decides whether an agent action runs, asks a human, or is denied.
// Combines Codex-style approval + sandbox policies. Returns { verdict, reason }.
//   verdict: 'allow' | 'ask' | 'deny'
const path = require('path');
const { ApprovalPolicy, SandboxPolicy } = require('../protocol');

// Read-only inspection commands (auto-allowed under every policy except when chained).
const SAFE_PREFIXES = [
  'ls', 'cat ', 'head ', 'tail ', 'wc ', 'pwd', 'echo ', 'find ', 'grep ', 'rg ', 'tree', 'file ', 'stat ', 'du ',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git ls-files', 'git rev-parse',
  'which ', 'sed -n', 'awk ', 'sort ', 'uniq ', 'node --version', 'npm --version', 'python --version', 'python3 --version'
];
// Commands that always warrant a human under on-request (destructive / egress / privilege).
const RISKY_PATTERNS = [
  /\brm\s+(-[a-z]*r|-[a-z]*f)/i, /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D)/, /\bsudo\b/, /\bchmod\b/, /\bchown\b/,
  /\bcurl\b/, /\bwget\b/, /\bssh\b/, /\bscp\b/, /\bnpm\s+publish/, /\bpip\s+install/, /\bnpm\s+i(nstall)?\b/, /\bdocker\b/, /\bkill\b/,
  /\bmkfs\b/, /\bdd\b/, /:\(\)\s*\{/, />\s*\/dev\//, /\bshutdown\b|\breboot\b/
];

function isSafeCommand(cmd) {
  const c = cmd.trim();
  if (/[;&|>]|\$\(|`/.test(c)) return false;
  return SAFE_PREFIXES.some((p) => c === p.trim() || c.startsWith(p));
}

function isRiskyCommand(cmd) {
  return RISKY_PATTERNS.some((re) => re.test(cmd));
}

function decideCommand(command, { approvalPolicy = ApprovalPolicy.ON_REQUEST, sandboxPolicy = SandboxPolicy.WORKSPACE_WRITE, sessionAllowed = new Set() } = {}) {
  if (isSafeCommand(command)) return { verdict: 'allow', reason: 'read-only inspection command' };
  if (sessionAllowed.has(command)) return { verdict: 'allow', reason: 'approved for this session' };
  if (sandboxPolicy === SandboxPolicy.READ_ONLY) return { verdict: 'deny', reason: 'sandbox is read-only' };
  if (sandboxPolicy === SandboxPolicy.DANGER_FULL_ACCESS && approvalPolicy === ApprovalPolicy.NEVER) return { verdict: 'allow', reason: 'full access, approvals off' };
  if (approvalPolicy === ApprovalPolicy.NEVER) return { verdict: 'allow', reason: 'approvals disabled' };
  if (approvalPolicy === ApprovalPolicy.UNTRUSTED) return { verdict: 'ask', reason: 'command is not on the trusted list' };
  // on-request: run ordinary commands in the workspace sandbox; escalate risky ones.
  if (isRiskyCommand(command)) return { verdict: 'ask', reason: 'command may be destructive or reach outside the workspace' };
  return { verdict: 'allow', reason: 'workspace-write sandbox' };
}

function decideFileWrite(absPath, { workspace, approvalPolicy = ApprovalPolicy.ON_REQUEST, sandboxPolicy = SandboxPolicy.WORKSPACE_WRITE } = {}) {
  if (sandboxPolicy === SandboxPolicy.READ_ONLY) return { verdict: 'deny', reason: 'sandbox is read-only' };
  const inside = workspace && (absPath === workspace || absPath.startsWith(workspace + path.sep));
  if (inside) return { verdict: 'allow', reason: 'write inside workspace' };
  if (sandboxPolicy === SandboxPolicy.DANGER_FULL_ACCESS || approvalPolicy === ApprovalPolicy.NEVER) return { verdict: 'allow', reason: 'full access' };
  return { verdict: 'ask', reason: 'write outside the workspace' };
}

// Codex desktop's three presets, expressed in policy terms.
const PRESETS = {
  'read-only': { approvalPolicy: ApprovalPolicy.ON_REQUEST, sandboxPolicy: SandboxPolicy.READ_ONLY },
  'agent': { approvalPolicy: ApprovalPolicy.ON_REQUEST, sandboxPolicy: SandboxPolicy.WORKSPACE_WRITE },
  'agent-untrusted': { approvalPolicy: ApprovalPolicy.UNTRUSTED, sandboxPolicy: SandboxPolicy.WORKSPACE_WRITE },
  'full-access': { approvalPolicy: ApprovalPolicy.NEVER, sandboxPolicy: SandboxPolicy.DANGER_FULL_ACCESS }
};

module.exports = { decideCommand, decideFileWrite, isSafeCommand, isRiskyCommand, PRESETS };
