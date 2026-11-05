import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { mirrorBase } from '../../../packages/sync/src/client.js';
import type { MirrorInfo } from '../../../packages/sync/src/protocol.js';
import type { SharedInfo } from '../../../packages/sync/src/two-way.js';
import { extensionApi } from '../../../packages/adapters/browser/src/index.js';
const storageKey = 'shiye:mirror-address';
const remembered = () => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return ''; } };
interface CloudConnection {
  address: string; savedAddress: string; token: string; info: MirrorInfo | null; sharedInfo: SharedInfo | null; testedAt: string | null; modified: boolean; error: string;
  version: MutableRefObject<number>; changeAddress(value: string): void; changeToken(value: string): void; saveAddress(): void;
  connected(info: MirrorInfo, shared: SharedInfo, expectedVersion: number): boolean; setInfo(info: MirrorInfo): void; setSharedInfo(info: SharedInfo): void; failed(message: string): void; disconnect(): void;
}
const Context = createContext<CloudConnection | null>(null);
export function useCloudConnection() { const value = useContext(Context); if (!value) throw new Error('云端连接上下文缺失。'); return value; }
export function CloudConnectionProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState(remembered), [savedAddress, setSavedAddress] = useState(remembered), [token, setToken] = useState('');
  const [info, setInfo] = useState<MirrorInfo | null>(null), [sharedInfo, setSharedInfo] = useState<SharedInfo | null>(null), [testedAt, setTestedAt] = useState<string | null>(null);
  const [modified, setModified] = useState(false), [error, setError] = useState(''); const version = useRef(0);
  const [verifiedVersion, setVerifiedVersion] = useState(-1);
  const invalidate = () => { version.current++; setVerifiedVersion(-1); setInfo(null); setSharedInfo(null); setTestedAt(null); setError(''); };
  const saveAddress = () => { const value = mirrorBase(address).href; try { localStorage.setItem(storageKey, value); setSavedAddress(value); } catch { throw new Error('浏览器未能保存后端地址，当前页面仍可使用。'); } };
  useEffect(() => {
    const event = extensionApi()?.permissions?.onRemoved; if (!event) return;
    const removed = (permissions: chrome.permissions.Permissions) => { let origin: string; try { origin = new URL(address).origin; } catch { return; }
      if (!permissions.origins?.some((pattern) => ['<all_urls>', 'https://*/*', `${origin}/*`].includes(pattern))) return;
      invalidate(); setModified(true); setError('此后端的访问权限已撤销，请重新测试并授权。');
    }; event.addListener(removed); return () => event.removeListener(removed);
  }, [address]);
  return <Context.Provider value={{ address, savedAddress, token, get info() { return verifiedVersion === version.current ? info : null; }, get sharedInfo() { return verifiedVersion === version.current ? sharedInfo : null; }, testedAt, modified, error, version,
    changeAddress: (value) => { if (value === address) return; invalidate(); setAddress(value); setToken(''); setModified(true); },
    changeToken: (value) => { if (value === token) return; invalidate(); setToken(value); setModified(true); }, saveAddress,
    connected: (next, shared, expectedVersion) => { if (expectedVersion !== version.current) return false; setVerifiedVersion(expectedVersion); setInfo(next); setSharedInfo(shared); setTestedAt(new Date().toISOString()); setModified(false); setError(''); try { saveAddress(); } catch { setError('连接已验证，但后端地址未能保存；刷新后需重新填写。'); } return true; },
    setInfo, setSharedInfo, failed: (message) => { setVerifiedVersion(-1); setInfo(null); setSharedInfo(null); setTestedAt(null); setError(message); },
    disconnect: () => { invalidate(); setToken(''); setModified(false); },
  }}>{children}</Context.Provider>;
}
