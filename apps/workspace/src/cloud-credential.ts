import { mirrorBase } from '../../../packages/sync/src/client.js';
const key = 'shiye:remembered-cloud-credential';
export interface RememberedCloudCredential { address: string; token: string; identity: string | null; }
export function readCloudCredential(): RememberedCloudCredential | null {
  try { const item = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (item && typeof item.address === 'string' && typeof item.token === 'string' && /^[A-Za-z0-9_-]{24,256}$/.test(item.token) && (item.identity === null || typeof item.identity === 'string')) return { address: mirrorBase(item.address).href, token: item.token, identity: item.identity };
  } catch { /* Missing or invalid saved configuration is not a connection. */ }
  return null;
}
export function saveCloudCredential(value: RememberedCloudCredential) { localStorage.setItem(key, JSON.stringify({ ...value, address: mirrorBase(value.address).href })); }
export function forgetCloudCredential() { localStorage.removeItem(key); }
