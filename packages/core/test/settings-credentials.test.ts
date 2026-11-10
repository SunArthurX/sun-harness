import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker, homePath, type CredentialVault } from '../src/index.js';
import { tempHome } from './helpers.js';

const password = `credential-fixture-${randomUUID()}`;
const input = { origin: 'https://example.test/login', label: 'Fixture account', password };
const target = { origin: 'https://example.test/account', document: 'fixture-document' };
const vaultFile = () => homePath('credentials', 'vault.json');

function fixtureVault(): CredentialVault {
  const values = new Map<string, string>();
  return {
    async available() { return true; },
    async seal(plaintext) {
      const id = randomUUID();
      values.set(id, plaintext);
      return Buffer.from(id);
    },
    async open(ciphertext) { return values.get(ciphertext.toString())!; },
  };
}

beforeEach(() => { tempHome(); });

describe('private credential broker', () => {
  it('exposes references and status, sends the password once to the bound sink, and sanitizes sink failures', async () => {
    const vault = fixtureVault();
    const broker = new CredentialBroker(vault);
    const saved = await broker.save(input);
    expect(saved.origin).toBe('https://example.test');
    expect(broker.list()).toEqual([saved]);
    const token = broker.grant(saved.id, saved.revision, target.origin, target.document);
    const dispatch = vi.fn(async () => 'filled' as const);
    await expect(broker.fill(token, { ...target, origin: 'https://example.test:444' }, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    await expect(broker.fill(token, { ...target, document: 'replaced' }, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    expect(dispatch).not.toHaveBeenCalled();
    await expect(broker.fill(token, target, dispatch)).resolves.toBe('filled');
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(password, expect.any(Number));
    await expect(broker.fill(token, target, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    const next = broker.grant(saved.id, saved.revision, target.origin, target.document);
    await expect(broker.fill(next, target, () => { throw new Error(password); })).resolves.toBe('field-unavailable');
    for (const bytes of [JSON.stringify(saved), JSON.stringify(broker.list()), readFileSync(vaultFile(), 'utf8'),
      readFileSync(homePath('settings', 'audit.jsonl'), 'utf8')]) expect(bytes).not.toContain(password);
  });

  it('rejects expired and revoked grants, including revocation while a vault read is pending', async () => {
    const vault = fixtureVault();
    let now = 0;
    const broker = new CredentialBroker(vault, () => now);
    const saved = await broker.save(input);
    const expired = broker.grant(saved.id, saved.revision, target.origin, target.document);
    now += 60_000;
    const dispatch = vi.fn(async () => 'filled' as const);
    await expect(broker.fill(expired, target, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    const token = broker.grant(saved.id, saved.revision, target.origin, target.document);
    const open = vault.open;
    const opening = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vault.open = async bytes => {
      opening.resolve();
      await resume.promise;
      return open(bytes);
    };
    const fill = broker.fill(token, target, dispatch);
    await opening.promise;
    broker.revoke(token);
    resume.resolve();
    await expect(fill).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not persist plaintext when the vault is unavailable and can remove an entry without decryption', async () => {
    const vault = fixtureVault();
    const broker = new CredentialBroker(vault);
    const available = vault.available;
    vault.available = async () => false;
    await expect(broker.save(input)).rejects.toThrow('CREDENTIAL_VAULT_UNAVAILABLE');
    expect(existsSync(vaultFile())).toBe(false);
    vault.available = available;
    const saved = await broker.save(input);
    const token = broker.grant(saved.id, saved.revision, target.origin, target.document);
    const dispatch = vi.fn(async () => 'filled' as const);
    vault.available = async () => { throw new Error(password); };
    await expect(broker.fill(token, target, dispatch)).rejects.toThrow(/^CREDENTIAL_VAULT_UNAVAILABLE$/);
    const deleted = broker.grant(saved.id, saved.revision, target.origin, target.document);
    new CredentialBroker(vault).remove(saved.id, saved.revision);
    expect(broker.list()).toEqual([]);
    await expect(broker.fill(deleted, target, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('invalidates old revisions and refuses ciphertext relabelled with a different origin', async () => {
    const vault = fixtureVault();
    const broker = new CredentialBroker(vault);
    const saved = await broker.save(input);
    const original = broker.grant(saved.id, saved.revision, target.origin, target.document);
    const changed = await broker.save({ ...input, password: 'different' }, saved);
    expect(changed.id).toBe(saved.id);
    expect(changed.revision).not.toBe(saved.revision);
    const dispatch = vi.fn(async () => 'filled' as const);
    await expect(broker.fill(original, target, dispatch)).rejects.toThrow('CREDENTIAL_GRANT_INVALID');
    expect(() => broker.remove(saved.id, saved.revision)).toThrow('CREDENTIAL_REFERENCE_CHANGED');
    const persisted = JSON.parse(readFileSync(vaultFile(), 'utf8'));
    const origin = 'https://other.test';
    persisted.entries[0].origin = origin;
    writeFileSync(vaultFile(), JSON.stringify(persisted));
    const altered = broker.grant(saved.id, changed.revision, origin, target.document);
    await expect(broker.fill(altered, { ...target, origin }, dispatch)).rejects.toThrow('CREDENTIAL_VAULT_UNAVAILABLE');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
