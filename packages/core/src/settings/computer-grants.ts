import { homePath } from '../paths.js';
import { validComputerIdentity } from './computer.js';
import { appendSettingsAudit } from './service.js';
import { readSettingsFile, transactSettingsFile } from './store.js';

const file = () => homePath('settings', 'computer-grants.json');

function grantsOf(document: Record<string, unknown>): string[] {
  if (!Object.keys(document).length) return [];
  if (document.version !== 1 || !Array.isArray(document.grants) || document.grants.length > 128
    || !document.grants.every(validComputerIdentity) || new Set(document.grants).size !== document.grants.length) {
    throw new Error('COMPUTER_GRANTS_INVALID');
  }
  return document.grants;
}

export function computerGrants() {
  const { revision, document } = readSettingsFile(file());
  return { revision, grants: grantsOf(document) };
}

export function updateComputerGrant(expectedRevision: string, appId: string, granted: boolean): void {
  if (typeof expectedRevision !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(expectedRevision)
    || !validComputerIdentity(appId) || typeof granted !== 'boolean') throw new Error('COMPUTER_GRANTS_INVALID');
  const result = transactSettingsFile(file(), expectedRevision, ({ document }) => {
    const grants = grantsOf(document).filter(id => id !== appId);
    if (granted) grants.push(appId);
    return grants.length > 128 ? { fields: { grants: 'LIMIT' } } : { document: { version: 1, grants: grants.sort() } };
  });
  if (!result.ok) throw new Error(result.code === 'CONFLICT' ? 'COMPUTER_GRANTS_CHANGED' : 'COMPUTER_GRANTS_UNAVAILABLE');
  if (result.durability !== 'confirmed') throw new Error('COMPUTER_GRANTS_UNAVAILABLE');
  try { appendSettingsAudit({ action: 'computer.grant', appId, granted }); }
  catch { /* The permission store remains authoritative if the audit append fails. */ }
}
