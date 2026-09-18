# Multiplayer AI Harness

A shared environment where teammates supervise ongoing coding-agent work together and carry its context across participants.

## Language

**Multiplayer agent collaboration**:
Multiple teammates participating in the same ongoing coding-agent work, with shared context and the ability to steer it.

**Shared context**:
The history and current state of agent work that lets a joining teammate understand what has happened and participate without reconstructing it from another person's account.

**Shared control**:
Authorized teammates contributing ordered, attributed instructions to the same agent work, with explicit interruption and separately delegated approval rights.

**Delegated approver**:
A participant explicitly authorized to resolve an agent's pending action approval on the execution host. Participation alone does not grant this authority.

**Execution host**:
The machine on which a collaborative agent task runs. Changing the teammate responsible for the task does not change its execution host.

**Responsibility handoff**:
Reassigning responsibility for ongoing agent work to another teammate while preserving its shared context and existing execution host.
_Avoid_: Execution migration

**Bring your own provider**:
A customer supplying their own supported agent-provider authentication and paying that provider for usage, through an eligible subscription or API arrangement. This does not imply shared credentials or transferable subscription entitlements.

**Owner recovery kit**:
Customer-encrypted account recovery authority and selected authenticated history,
provisioned before trusted devices are lost. It creates a new owner endpoint;
each execution host still requires local activation. History-only backups do not
confer this authority. See [ADR 0006](docs/adr/0006-customer-held-owner-recovery-and-host-activation.md).

**Recovery epoch**:
The signed authorization generation created by owner recovery. Fresh endpoint and
project confirmations do not revive commands or approvals from an older epoch.

**Activated user**:
A person who participates in a real collaborative agent task involving at least two humans and a teammate intervention delivered to the agent. A signup alone does not qualify.

**Paid seat**:
An individual user's paid access to the collaboration product, separate from the customer's agent-provider usage charges.

## Hosted account identity

GitHub sign-in identifies a person by immutable provider ID. It does not verify an endpoint or grant host/project/approval authority. Browser cookies and installation-bound desktop sessions are separate from provider credentials and encryption keys. See [ADR 0008](docs/adr/0008-hosted-account-authentication.md).
